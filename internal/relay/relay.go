package relay

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"ldmapi/internal/store"
	"ldmapi/internal/upstream"
)

const maxBodyBytes = 64 << 20 // 64MB，覆盖带图请求

// Relay 负责把一次客户端请求翻译并转发到上游渠道。
type Relay struct {
	Store *store.Store
	http  *http.Client
	tr    *http.Transport
}

func New(st *store.Store) *Relay {
	tr := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   20 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:          400,
		MaxIdleConnsPerHost:   64,
		IdleConnTimeout:       120 * time.Second,
		TLSHandshakeTimeout:   20 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		ForceAttemptHTTP2:     true,
		ResponseHeaderTimeout: 300 * time.Second,
	}
	return &Relay{
		Store: st,
		tr:    tr,
		// 不设置 Client.Timeout：流式响应可能持续很久，超时交给每次请求的 context。
		http: &http.Client{Transport: tr},
	}
}

// Route 是一条已经解析好的上游目标。
type Route struct {
	Channel  store.Channel
	Upstream string
	Group    int // 所属优先级组（0 = 未分组）
	CfgIndex int // 在模型配置里的下标，用于定位亲和记录
}

// Resolved 是一次路由解析的完整结果。
type Resolved struct {
	Model   store.Model
	Routes  []Route
	NoRoute string // 有模型但没有任何可用路由时的原因
}

// 常见错误
var (
	ErrModelNotFound = errors.New("model not found")
	ErrModelDisabled = errors.New("model is disabled")
	ErrNoAvailable   = errors.New("no available channel")
)

// Resolve 根据模型 ID 解析出可用的上游路由链。
func (r *Relay) Resolve(modelID string) (*Resolved, error) {
	m, err := r.Store.GetModel(modelID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrModelNotFound
		}
		return nil, err
	}
	if !m.Enabled {
		return nil, ErrModelDisabled
	}
	res := &Resolved{Model: m}

	switch m.Type {
	case store.ModelTypeChannel:
		ch, err := r.Store.GetChannel(m.ChannelID)
		if err != nil {
			res.NoRoute = fmt.Sprintf("渠道「%s」不存在", m.ChannelID)
			return res, nil
		}
		if !ch.Enabled {
			res.NoRoute = fmt.Sprintf("渠道「%s」已禁用", ch.ID)
			return res, nil
		}
		res.Routes = []Route{{Channel: ch, Upstream: m.Upstream}}
	case store.ModelTypeCustom:
		chans, err := r.Store.ListChannels()
		if err != nil {
			return nil, err
		}
		byID := make(map[string]store.Channel, len(chans))
		for _, c := range chans {
			byID[c.ID] = c
		}
		plan := PlanRoute(m, byID, func(id string) bool { return byID[id].Enabled })
		if plan == nil {
			// 区分「渠道全挂」和「全在冷却中」两种不可用
			var unavailable []string
			cooling := false
			for _, rt := range m.Routes {
				ch, ok := byID[rt.ChannelID]
				if !ok || !ch.Enabled {
					unavailable = append(unavailable, rt.ChannelID+"/"+rt.Upstream)
					continue
				}
				cooling = true
			}
			if cooling && len(unavailable) == 0 {
				res.NoRoute = "所有路由都在失败冷却中"
			} else if len(unavailable) > 0 {
				res.NoRoute = "路由目标均不可用：" + strings.Join(unavailable, ", ")
			} else {
				res.NoRoute = "该自定义模型尚未配置路由目标"
			}
			return res, nil
		}
		for _, c := range plan {
			res.Routes = append(res.Routes, Route{Channel: c.ch, Upstream: c.rt.Upstream, Group: c.rt.Group, CfgIndex: c.cfgIdx})
		}
	default:
		res.NoRoute = "未知模型类型"
	}
	return res, nil
}

// ---------- 请求处理 ----------

// Request 描述一次待转发的客户端请求。
type Request struct {
	Token  store.Token
	Path   string
	Method string
	Header http.Header
	Body   []byte
	Stream bool
	JSON   map[string]any
	IP     string
}

// Result 是一次转发的最终结果，用于记日志。
type Result struct {
	ModelID       string
	ChannelID     string
	ChannelName   string
	UpstreamModel string
	StatusCode    int
	Usage         upstream.Usage
	LatencyMs     int64
	FirstByteMs   int64
	Retries       int
	// Err 是内部失败原因（可能包含渠道、上游地址等细节），只写日志。
	Err string
	// ClientErr 是实际返回给调用方的错误文案。网关自身原因对外会收敛成笼统提示，
	// 与 Err 不同；记录它才能在日志里还原调用方真正看到的内容。
	ClientErr     string
	Stream        bool
	UsageEstimate bool
	// ReasoningChars 是思考内容的字符数，模型没输出思考时为 0。
	ReasoningChars int
	// ReasoningTokens 是上游上报的思考 token 数，未上报时为 0。
	ReasoningTokens int
	// CachedTokens 是输入里命中提示词缓存的部分，未上报时为 0。
	CachedTokens int
	// Attempts 是每次路由尝试的明细，仅在重试过（尝试次数 > 1）时保留。
	Attempts []store.LogAttempt
	// Canceled 表示客户端主动断开（例如在线对话里点了「停止」），
	// 这种请求不计入渠道失败与成功率统计。
	Canceled bool
}

// ErrUpstream 表示上游返回了错误，并且已经把错误体透传给了客户端。
type ErrUpstream struct {
	Status int
	Body   []byte
}

func (e *ErrUpstream) Error() string { return fmt.Sprintf("upstream status %d", e.Status) }

// Do 执行转发。它会把响应写进 w，并返回用于记账的结果。
func (r *Relay) Do(ctx context.Context, w http.ResponseWriter, req *Request) *Result {
	start := time.Now()
	res := &Result{ModelID: modelOf(req), Stream: req.Stream}

	// 防御性校验：即使调用方绕过 handleAPI，也不允许把非模型端点转发到上游。
	if !IsAllowedEndpoint(req.Method, req.Path) {
		const msg = "不支持的接口，API 密钥只能调用模型相关端点"
		writeAPIError(w, http.StatusNotFound, "invalid_request_error", msg)
		res.StatusCode = http.StatusNotFound
		res.ClientErr = msg
		res.Err = "unsupported endpoint: " + req.Method + " " + req.Path
		res.LatencyMs = time.Since(start).Milliseconds()
		return res
	}

	modelID := modelOf(req)
	if modelID == "" {
		const msg = "请求体中缺少 model 字段"
		writeAPIError(w, http.StatusBadRequest, "invalid_request_error", msg)
		res.StatusCode = http.StatusBadRequest
		res.ClientErr = msg
		res.Err = "missing model"
		res.LatencyMs = time.Since(start).Milliseconds()
		return res
	}

	resolved, err := r.Resolve(modelID)
	if err != nil {
		code := http.StatusNotFound
		msg := "模型「" + modelID + "」不存在"
		typ := "invalid_request_error"
		if errors.Is(err, ErrModelDisabled) {
			code = http.StatusForbidden
			msg = "模型「" + modelID + "」不可用"
		}
		writeAPIError(w, code, typ, msg)
		res.StatusCode = code
		res.ClientErr = msg
		res.Err = err.Error()
		res.LatencyMs = time.Since(start).Milliseconds()
		return res
	}
	if len(resolved.Routes) == 0 {
		// 客户端只看到笼统结论，具体原因（渠道已禁用等）只写进日志，避免泄露内部信息。
		msg := "模型「" + modelID + "」当前没有可用渠道"
		writeAPIError(w, http.StatusServiceUnavailable, "server_error", msg)
		res.StatusCode = http.StatusServiceUnavailable
		res.ClientErr = msg
		res.Err = resolved.NoRoute
		res.LatencyMs = time.Since(start).Milliseconds()
		return res
	}

	var lastErr string
	var lastStatus int
	var lastRaw []byte // 上游最后一次失败响应体，用于原样透传
	var lastRawHdr http.Header
	wrote := false
	var attempts []store.LogAttempt
	for i, route := range resolved.Routes {
		res.Retries = i
		res.ChannelID = route.Channel.ID
		res.ChannelName = route.Channel.Name
		res.UpstreamModel = route.Upstream

		attemptStarted := time.Now()
		outcome := r.attempt(ctx, w, req, resolved, route, i == len(resolved.Routes)-1)
		lastRaw, lastRawHdr = outcome.upstreamRaw, outcome.upstreamHdr
		attempts = append(attempts, store.LogAttempt{
			ChannelID:     route.Channel.ID,
			ChannelName:   route.Channel.Name,
			UpstreamModel: route.Upstream,
			StatusCode:    outcome.status,
			LatencyMs:     time.Since(attemptStarted).Milliseconds(),
			Error:         attemptErrText(outcome.err),
		})
		// 客户端主动断开（例如在线对话里点了「停止」）：按「黄色 200、记成功」记账，
		// 同样记录亲和并清掉冷却（点停止不代表上游有问题），
		// 不再重试、不标记渠道失败，也不往已经关闭的连接里写错误响应。
		if outcome.canceled {
			MarkSuccess(modelID, route.Channel.ID, route.Upstream)
			res.Canceled = true
			res.StatusCode = http.StatusOK
			res.Err = "客户端已断开连接"
			res.Usage = outcome.usage
			res.UsageEstimate = outcome.estimated
			res.FirstByteMs = outcome.firstByte
			res.ReasoningChars = outcome.reasoning
			res.ReasoningTokens = outcome.usage.ReasoningTokens
			res.CachedTokens = outcome.usage.CachedTokens
			res.LatencyMs = time.Since(start).Milliseconds()
			res.Attempts = retryHistory(attempts)
			return res
		}
		wrote = wrote || outcome.wrote
		if outcome.err == nil {
			// 成功：记录亲和（下次优先从它开始），并清掉该条目的冷却
			MarkSuccess(modelID, route.Channel.ID, route.Upstream)
			res.StatusCode = outcome.status
			res.Usage = outcome.usage
			res.UsageEstimate = outcome.estimated
			res.FirstByteMs = outcome.firstByte
			res.ReasoningChars = outcome.reasoning
			res.ReasoningTokens = outcome.usage.ReasoningTokens
			res.CachedTokens = outcome.usage.CachedTokens
			res.LatencyMs = time.Since(start).Milliseconds()
			res.Attempts = retryHistory(attempts)
			return res
		}

		lastErr = outcome.err.Error()
		lastStatus = outcome.status
		// 失败：进入冷却期（同渠道模型的所有引用共享）。重试与否取决于重试链。
		// 上游在响应中途断开时，即使已经写出部分响应也按普通失败标记；
		// 其余已写出响应的失败（如 4xx 透传）是请求本身的问题，不冷却渠道。
		if !outcome.wrote || outcome.upstreamBroken {
			m := resolved.Model
			cd := time.Duration(m.CooldownSec) * time.Second
			if cd <= 0 {
				cd = defaultCooldownSec * time.Second
			}
			MarkFailure(route.Channel.ID, route.Upstream, cd)
		}
		if !outcome.retryable {
			break
		}
		// 已经写出去的响应无法撤回，只能终止
		if outcome.wrote {
			break
		}
	}

	res.LatencyMs = time.Since(start).Milliseconds()
	res.Err = lastErr
	res.Attempts = retryHistory(attempts)
	if lastStatus == 0 {
		lastStatus = http.StatusBadGateway
	}
	res.StatusCode = lastStatus
	if !res.UsageEstimate {
		res.Usage = estimateUsage(req)
		res.UsageEstimate = true
	}
	// 上游的原始响应已经透传过了，就不要再追加一层错误体
	if lastErr != "" && !wrote {
		if lastRaw != nil {
			// 上游自己的错误响应原样返回，但不会带上网关的渠道信息。
			writeUpstreamRawParts(w, lastRawHdr, lastStatus, lastRaw)
		} else {
			// 网关自身原因（配置缺失、网络错误等）只写进日志，对外给笼统结论。
			msg := clientErrorMessage(modelID)
			writeAPIError(w, lastStatus, "server_error", msg)
			res.ClientErr = msg
		}
	}
	// 上游错误体无论是否已经写出，都是调用方实际收到的内容。
	// 透传上游原始错误时，内部原因不再重复同一段内容，留空让日志显示 —；
	// 渠道、状态码等信息已经记在日志摘要和重试明细里。
	if lastRaw != nil {
		res.ClientErr = string(lastRaw)
		res.Err = ""
	}
	return res
}

type attemptOutcome struct {
	status    int
	usage     upstream.Usage
	firstByte int64
	err       error
	retryable bool
	wrote     bool
	estimated bool
	reasoning int
	// canceled 表示这次失败是客户端主动断开造成的，不是上游的问题。
	canceled bool
	// upstreamRaw/upstreamHdr 是上游错误响应，在最后一次尝试或 4xx 直接透传时保留，
	// 用于把上游原始错误原样返回给调用方，并记录调用方实际收到的内容。
	upstreamRaw []byte
	upstreamHdr http.Header
	// upstreamBroken 表示上游在响应中途断开，即使已经写出响应也要标记失败。
	upstreamBroken bool
}

// retryHistory 只在真的发生过重试时保留尝试明细，单次请求不增加日志体积。
func retryHistory(attempts []store.LogAttempt) []store.LogAttempt {
	if len(attempts) <= 1 {
		return nil
	}
	return attempts
}

func attemptErrText(err error) string {
	if err == nil {
		return ""
	}
	return truncate(err.Error(), 500)
}

func (r *Relay) attempt(ctx context.Context, w http.ResponseWriter, req *Request,
	resolved *Resolved, route Route, isLast bool) attemptOutcome {

	prov := upstream.Get(route.Channel.Type)
	timeout := route.Channel.Timeout
	if timeout <= 0 {
		timeout = 300
	}
	reqCtx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()

	body := req.Body
	convertBody := !prov.RawBody && req.JSON != nil && isChatPath(req.Path)
	if convertBody {
		// 能力参数只用于界面展示，不参与请求校验或改写；
		// 传空的 Caps 让协议转换只做格式映射。
		converted := prov.BuildBody(req.JSON, route.Upstream, store.Caps{})
		body = mustJSON(converted)
	} else if req.JSON != nil && prov.Type == store.ChannelOpenAI {
		// 非 chat 端点：只改写模型名
		patched := make(map[string]any, len(req.JSON)+1)
		for k, v := range req.JSON {
			patched[k] = v
		}
		patched["model"] = route.Upstream
		body = mustJSON(patched)
	}

	base := upstream.NormalizeBase(route.Channel.BaseURL)
	if base == "" {
		return attemptOutcome{
			err:       fmt.Errorf("渠道「%s」没有配置接口地址", route.Channel.ID),
			retryable: true, status: http.StatusBadGateway,
		}
	}
	upPath := req.Path
	if convertBody || isChatPath(req.Path) {
		upPath = prov.UpstreamPath(req.Path, route.Upstream, req.Stream)
	}
	target := upstream.JoinURL(base, upPath, route.Channel.ShouldAppendV1())

	upReq, err := http.NewRequestWithContext(reqCtx, req.Method, target, bytes.NewReader(body))
	if err != nil {
		return attemptOutcome{err: fmt.Errorf("构造上游请求失败: %w", err), retryable: true, status: http.StatusBadGateway}
	}
	copyRequestHeaders(upReq.Header, req.Header)
	prov.Auth(upReq, route.Channel)
	for k, v := range route.Channel.Headers {
		upReq.Header.Set(k, v)
	}

	started := time.Now()
	resp, err := r.http.Do(upReq)
	if err != nil {
		// 父上下文已取消说明是客户端断开，不是上游不可用
		if ctx.Err() != nil {
			return attemptOutcome{err: errors.New("客户端已断开连接"), canceled: true}
		}
		msg := "上游请求失败: " + cleanNetErr(err)
		return attemptOutcome{err: errors.New(msg), retryable: true, status: http.StatusBadGateway}
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		msg := fmt.Sprintf("渠道「%s」返回 %d: %s", route.Channel.ID, resp.StatusCode, truncate(string(raw), 600))
		// 4xx 里只有限流和超时值得换渠道重试
		retryable := resp.StatusCode == 429 || resp.StatusCode >= 500
		if !retryable {
			// 客户端错误：把上游原始响应透传，方便调用方定位
			writeUpstreamRaw(w, resp, raw)
			return attemptOutcome{status: resp.StatusCode, err: errors.New(msg), retryable: false, wrote: true,
				upstreamRaw: raw, upstreamHdr: resp.Header}
		}
		out := attemptOutcome{status: resp.StatusCode, err: errors.New(msg), retryable: !isLast}
		if isLast {
			// 已经是最后一条路由：上游原始错误留给 Do 原样返回给调用方
			out.upstreamRaw, out.upstreamHdr = raw, resp.Header
		}
		return out
	}

	firstByte := time.Since(started).Milliseconds()
	isStream := strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream")
	if !isStream {
		raw, err := io.ReadAll(resp.Body)
		if err != nil {
			if ctx.Err() != nil {
				return attemptOutcome{err: errors.New("客户端已断开连接"), canceled: true, firstByte: firstByte}
			}
			return attemptOutcome{err: fmt.Errorf("读取上游响应失败: %w", err), retryable: true, status: http.StatusBadGateway, firstByte: firstByte}
		}
		decoded, usage, derr := prov.Decode(raw, modelOf(req))
		if derr != nil && decoded == nil {
			decoded = raw
		}
		writeUpstreamRaw(w, resp, decoded)
		reasoning := reasoningCharsOf(decoded)
		// 非流式是一次性返回的，「首字耗时」没有意义，留 0 让前端显示成 —
		if usage.Empty() {
			usage = estimateUsage(req)
			return attemptOutcome{status: resp.StatusCode, usage: usage,
				estimated: true, wrote: true, reasoning: reasoning}
		}
		return attemptOutcome{status: resp.StatusCode, usage: usage,
			wrote: true, reasoning: reasoning}
	}

	// 流式：一旦开始写响应就不能再重试了
	flusher, _ := w.(http.Flusher)
	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(resp.StatusCode)
	if flusher != nil {
		flusher.Flush()
	}

	st := prov.NewStream(modelOf(req))
	buf := make([]byte, 0, 64*1024)
	tmp := make([]byte, 32*1024)
	var pending []byte
	reader := resp.Body
	for {
		n, rerr := reader.Read(tmp)
		if n > 0 {
			pending = append(pending, tmp[:n]...)
			for {
				idx := indexByte(pending, '\n')
				if idx < 0 {
					break
				}
				line := pending[:idx]
				pending = pending[idx+1:]
				if out := st.Translate(line); len(out) > 0 {
					buf = append(buf, out...)
					if len(buf) > 4096 {
						w.Write(buf)
						buf = buf[:0]
						if flusher != nil {
							flusher.Flush()
						}
					}
				}
			}
			if len(buf) > 0 {
				w.Write(buf)
				buf = buf[:0]
				if flusher != nil {
					flusher.Flush()
				}
			}
		}
		if rerr != nil {
			if rerr != io.EOF {
				// 上游是否已发出结束标记必须在 Finish 之前判断：
				// Anthropic/Gemini 的 Finish 本身会把 finished 置位。
				done := st.Done()
				// 客户端可能已经断开，尽力把收尾事件发出去
				w.Write(st.Finish())
				if flusher != nil {
					flusher.Flush()
				}
				usage, est := streamUsage(st, req)
				// 结束标记已经发出去，说明响应内容已经完整；此时客户端关连接
				// （收到 [DONE] 就挂断很常见）或上游断开都不算这次调用失败。
				if done && st.Err() == nil {
					return attemptOutcome{status: resp.StatusCode, usage: usage, firstByte: firstByte,
						wrote: true, estimated: est, reasoning: st.ReasoningChars()}
				}
				// 客户端断开和上游断开要分开记账：前者黄色 200 记成功，后者红色 200 记错误
				if ctx.Err() != nil {
					return attemptOutcome{status: resp.StatusCode, usage: usage, firstByte: firstByte,
						err: errors.New("客户端已断开连接"), canceled: true, wrote: true, estimated: est,
						reasoning: st.ReasoningChars()}
				}
				return attemptOutcome{status: resp.StatusCode, usage: usage, firstByte: firstByte,
					err: errors.New(cleanNetErr(rerr)), retryable: false, wrote: true, estimated: est,
					reasoning: st.ReasoningChars(), upstreamBroken: true}
			}
			break
		}
	}
	if len(pending) > 0 {
		if out := st.Translate(pending); len(out) > 0 {
			w.Write(out)
		}
	}
	if out := st.Finish(); len(out) > 0 {
		w.Write(out)
	}
	if flusher != nil {
		flusher.Flush()
	}

	usage, estimated := streamUsage(st, req)
	outcome := attemptOutcome{status: resp.StatusCode, usage: usage, firstByte: firstByte,
		wrote: true, estimated: estimated, reasoning: st.ReasoningChars()}
	if err := st.Err(); err != nil {
		outcome.err = err
	}
	return outcome
}

// streamUsage 优先使用上游上报的用量，缺失时按输出字符数估算。
func streamUsage(st upstream.Stream, req *Request) (upstream.Usage, bool) {
	usage := st.Usage()
	if !usage.Empty() {
		return usage, false
	}
	usage = estimateUsage(req)
	out := st.OutputChars()
	usage.CompletionTokens = estimateTokens(strings.Repeat("x", 0) + repeatRune(out))
	usage.TotalTokens = usage.PromptTokens + usage.CompletionTokens
	return usage, true
}

func repeatRune(n int) string {
	if n <= 0 {
		return ""
	}
	// 用非 ASCII 占位，估算时按 1 字符 1 token 计算，贴近中文场景
	b := make([]rune, n)
	for i := range b {
		b[i] = '汉'
	}
	return string(b)
}

func isChatPath(p string) bool { return upstream.IsConversationPath(p) }

var hopHeaders = map[string]bool{
	"connection": true, "keep-alive": true, "proxy-authenticate": true,
	"proxy-authorization": true, "te": true, "trailer": true,
	"transfer-encoding": true, "upgrade": true, "host": true,
	"content-length": true, "accept-encoding": true,
	"authorization": true, "x-api-key": true, "x-goog-api-key": true,
	"api-key": true, "openai-organization": true, "openai-project": true,
	"x-forwarded-for": true, "x-forwarded-host": true, "x-forwarded-proto": true,
	"x-real-ip": true, "forwarded": true,
	"cookie": true, "origin": true, "referer": true, "user-agent": true,
}

func copyRequestHeaders(dst, src http.Header) {
	for k, vs := range src {
		lk := strings.ToLower(k)
		if hopHeaders[lk] {
			continue
		}
		for _, v := range vs {
			dst.Add(k, v)
		}
	}
}

var respPassthrough = map[string]bool{
	"content-type": true, "x-request-id": true, "request-id": true,
	"openai-processing-ms": true, "anthropic-ratelimit-requests-remaining": true,
}

func writeUpstreamRaw(w http.ResponseWriter, resp *http.Response, raw []byte) {
	writeUpstreamRawParts(w, resp.Header, resp.StatusCode, raw)
}

// writeUpstreamRawParts 按上游的响应头和状态码原样写出响应体。
func writeUpstreamRawParts(w http.ResponseWriter, hdr http.Header, status int, raw []byte) {
	h := w.Header()
	for k, vs := range hdr {
		lk := strings.ToLower(k)
		if strings.HasPrefix(lk, "x-") || respPassthrough[lk] {
			for _, v := range vs {
				h.Set(k, v)
			}
		}
	}
	if h.Get("Content-Type") == "" {
		h.Set("Content-Type", "application/json; charset=utf-8")
	}
	w.WriteHeader(status)
	w.Write(raw)
}

func writeAPIError(w http.ResponseWriter, code int, typ, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	w.Write([]byte(fmt.Sprintf(`{"error":{"message":%s,"type":%s,"code":%s}}`, jsonStr(msg), jsonStr(typ), jsonStr(typ))))
}

// clientErrorMessage 把网关自身的失败原因收敛成不含渠道、上游地址等细节的对外文案。
func clientErrorMessage(modelID string) string {
	return "模型「" + modelID + "」暂不可用，请稍后重试"
}

func cleanNetErr(err error) string {
	s := err.Error()
	switch {
	case strings.Contains(s, "context canceled"):
		// 客户端主动断开（关页面、断网）时 Go 返回的原始错误
		return "客户端已断开连接"
	case strings.Contains(s, "context deadline exceeded"), strings.Contains(s, "Client.Timeout"):
		return "上游响应超时"
	case strings.Contains(s, "unexpected EOF"):
		return "上游连接意外中断"
	case strings.Contains(s, "connection reset by peer"):
		return "上游连接被重置"
	case strings.Contains(s, "broken pipe"):
		return "上游连接已断开"
	case strings.Contains(s, "i/o timeout"):
		return "上游读写超时"
	}
	return s
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func indexByte(b []byte, c byte) int {
	for i := range b {
		if b[i] == c {
			return i
		}
	}
	return -1
}

func modelOf(req *Request) string {
	if req.JSON == nil {
		return ""
	}
	if s, ok := req.JSON["model"].(string); ok {
		return s
	}
	return ""
}
