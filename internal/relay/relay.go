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
	"sync/atomic"
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
		// 等待响应头的上限由每次请求的 context 定时器控制（渠道超时时间），
		// 这里不设固定值，避免它盖过渠道配置。
		ResponseHeaderTimeout: 0,
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

// withKey 返回使用指定上游 Key 的路由副本。
func (rt Route) withKey(key string) Route {
	rt.Channel = rt.Channel.WithKey(key)
	return rt
}

// Resolved 是一次路由解析的完整结果。
type Resolved struct {
	Model   store.Model
	Routes  []Route
	NoRoute string // 有模型但没有任何可用路由时的原因
	// Affinity 表示本次命中了模型亲和：上次成功的路由被提到了链首。
	Affinity bool
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
		if !channelHasModel(ch, m.Upstream) {
			// 渠道里已没有这个模型：解析阶段直接跳过，不单独给错误原因。
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
		plan, affinity := PlanRoute(m, byID, func(id string) bool { return byID[id].Enabled })
		if plan == nil {
			// 区分「渠道全挂」和「全在冷却中」两种不可用。
			// 渠道里已删除的模型在解析阶段就被跳过，不计入不可用原因。
			var unavailable []string
			cooling := false
			for _, rt := range m.Routes {
				ch, ok := byID[rt.ChannelID]
				if !ok || !ch.Enabled {
					unavailable = append(unavailable, rt.ChannelID+"/"+rt.Upstream)
					continue
				}
				if !channelHasModel(ch, rt.Upstream) {
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
		res.Affinity = affinity
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
	// KeyIndex/KeyMasked/KeyNote 是最终尝试使用的上游 Key；单 Key 渠道为空。
	KeyIndex    int
	KeyMasked   string
	KeyNote     string
	StatusCode  int
	Usage       upstream.Usage
	LatencyMs   int64
	FirstByteMs int64
	Retries     int
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
	// Affinity 表示本次请求命中了模型亲和（上次成功的路由被优先尝试），用于日志标记。
	Affinity bool
	// KeyAffinity 表示最终尝试使用的 Key 命中了 Key 亲和（上次成功的 Key 被优先尝试）。
	KeyAffinity bool
	// Canceled 表示客户端主动断开（例如在线聊天里点了「停止」），
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
	res.Affinity = resolved.Affinity

	var lastErr string
	var lastStatus int
	var lastRaw []byte // 上游最后一次失败响应体，用于原样透传
	var lastRawHdr http.Header
	var skipReason string // 路由因 Key 全部冷却被跳过时的原因
	wrote := false
	var attempts []store.LogAttempt
	attemptsMade := 0

outer:
	for ri, route := range resolved.Routes {
		keys, reason := PlanKeys(route.Channel)
		if len(keys) == 0 {
			skipReason = reason
			// 路由已经命中，只是所有 Key 都在冷却：日志仍要保留渠道信息，
			// 否则后台会把这类请求显示成「未命中渠道」。
			if res.ChannelID == "" {
				res.ChannelID = route.Channel.ID
				res.ChannelName = route.Channel.Name
				res.UpstreamModel = route.Upstream
			}
			continue
		}
		multiKey := route.Channel.MultiKeyEnabled() && len(route.Channel.Keys()) > 1
		for ki, kc := range keys {
			hasMoreKeys := ki < len(keys)-1
			// isLast 表示整条重试链（包括后续路由）的最后一次尝试，
			// 只有它需要把上游原始错误留给 Do 原样返回。
			isLast := ri == len(resolved.Routes)-1 && !hasMoreKeys

			res.Retries = attemptsMade
			attemptsMade++
			res.ChannelID = route.Channel.ID
			res.ChannelName = route.Channel.Name
			res.UpstreamModel = route.Upstream
			if multiKey {
				res.KeyIndex = kc.index
				res.KeyMasked = kc.masked
				res.KeyNote = kc.note
				res.KeyAffinity = kc.affinity
			} else {
				res.KeyIndex = 0
				res.KeyMasked = ""
				res.KeyNote = ""
				res.KeyAffinity = false
			}

			attemptStarted := time.Now()
			outcome := r.attempt(ctx, w, req, resolved, route.withKey(kc.key), isLast, hasMoreKeys)
			lastRaw, lastRawHdr = outcome.upstreamRaw, outcome.upstreamHdr
			entry := store.LogAttempt{
				ChannelID:     route.Channel.ID,
				ChannelName:   route.Channel.Name,
				UpstreamModel: route.Upstream,
				StatusCode:    outcome.status,
				LatencyMs:     time.Since(attemptStarted).Milliseconds(),
				Error:         attemptErrText(outcome.err),
			}
			if multiKey {
				entry.KeyIndex = kc.index
				entry.KeyMasked = kc.masked
				entry.KeyNote = kc.note
				entry.KeyAffinity = kc.affinity
			}
			attempts = append(attempts, entry)
			// 客户端主动断开（例如在线聊天里点了「停止」）：按「黄色 200、记成功」记账，
			// 同样记录亲和并清掉冷却（点停止不代表上游有问题），
			// 不再重试、不标记渠道失败，也不往已经关闭的连接里写错误响应。
			if outcome.canceled {
				MarkSuccess(modelID, route.Channel.ID, route.Upstream)
				MarkKeySuccess(route.Channel.ID, kc.key)
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
				MarkKeySuccess(route.Channel.ID, kc.key)
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
			// 失败的 Key 进入冷却（按渠道 + Key 隔离）；路由本身要等这条路由的
			// 所有 Key 都失败后才冷却，避免一个坏 Key 把整条渠道拖下水。
			if outcome.keyFailed {
				MarkKeyFailure(route.Channel.ID, kc.key)
			}
			if !hasMoreKeys && (!outcome.wrote || outcome.upstreamBroken) {
				MarkFailure(route.Channel.ID, route.Upstream)
			}
			if !outcome.retryable {
				break outer
			}
			// 已经写出去的响应无法撤回，只能终止
			if outcome.wrote {
				break outer
			}
		}
	}

	res.LatencyMs = time.Since(start).Milliseconds()
	if lastErr == "" {
		lastErr = skipReason
	}
	res.Err = lastErr
	res.Attempts = retryHistory(attempts)
	if lastStatus == 0 {
		if skipReason != "" {
			lastStatus = http.StatusServiceUnavailable
		} else {
			lastStatus = http.StatusBadGateway
		}
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
	// keyFailed 表示这次失败应该记到当前上游 Key 头上（认证、限流、超时、网络等），
	// 请求本身有问题的 4xx 不会冷却 Key。
	keyFailed bool
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
	resolved *Resolved, route Route, isLast, hasMoreKeys bool) attemptOutcome {

	prov := upstream.Get(route.Channel.Type)
	timeout := resolved.Model.Timeout
	if timeout <= 0 {
		timeout = 300
	}
	// 非流式：timeout 是整次请求（含读完响应体）的截止时间。
	// 流式：timeout 只限制到收到首块数据为止，首块到达后不再限时。
	// deadline 无法延长，所以用定时器 + cancel 实现，流式拿到首块后停表。
	reqCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	var timedOut atomic.Bool
	timer := time.AfterFunc(time.Duration(timeout)*time.Second, func() {
		timedOut.Store(true)
		cancel()
	})
	defer timer.Stop()

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
		// 定时器到点由本端取消，不能按「客户端断开」处理
		if timedOut.Load() {
			return attemptOutcome{err: errors.New("上游响应超时"), retryable: true, status: http.StatusBadGateway, keyFailed: true}
		}
		msg := "上游请求失败: " + cleanNetErr(err)
		return attemptOutcome{err: errors.New(msg), retryable: true, status: http.StatusBadGateway, keyFailed: true}
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		status := resp.StatusCode
		msg := fmt.Sprintf("渠道「%s」返回 %d: %s", route.Channel.ID, status, truncate(string(raw), 600))
		// 是否把这次失败归因到当前 Key 由渠道配置决定。
		keyFailed := route.Channel.KeyCooldownStatusSet().Match(status)
		// 401/403 往往是当前 Key 失效、无权限或额度问题：只要渠道把它算作 Key 故障，
		// 还有其它 Key 时就先换 Key 重试。这属于 Key 级故障转移，不算跨模型路由，
		// 因此不受模型「不可重试状态码」影响。
		if keyFailed && (status == http.StatusUnauthorized || status == http.StatusForbidden) && hasMoreKeys {
			return attemptOutcome{status: status, err: errors.New(msg), retryable: true, keyFailed: true}
		}
		// 不可重试状态码：上游错误原样返回，不记录 Key / 路由冷却，
		// 也不再尝试后面的路由。是否命中由模型配置决定。
		if resolved.Model.NoRetryStatusSet().Match(status) {
			writeUpstreamRaw(w, resp, raw)
			return attemptOutcome{status: status, err: errors.New(msg), retryable: false, wrote: true,
				upstreamRaw: raw, upstreamHdr: resp.Header}
		}
		// 没有更多 Key 可换的 401/403 直接返回，不再把同一个认证错误
		// 转发给其它模型。
		if (status == http.StatusUnauthorized || status == http.StatusForbidden) && !hasMoreKeys {
			writeUpstreamRaw(w, resp, raw)
			return attemptOutcome{status: status, err: errors.New(msg), retryable: false, wrote: true,
				upstreamRaw: raw, upstreamHdr: resp.Header, keyFailed: keyFailed}
		}
		out := attemptOutcome{status: status, err: errors.New(msg), retryable: !isLast, keyFailed: keyFailed}
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
			if timedOut.Load() {
				return attemptOutcome{err: errors.New("上游响应超时"), retryable: true, status: http.StatusBadGateway, firstByte: firstByte, keyFailed: true}
			}
			return attemptOutcome{err: fmt.Errorf("读取上游响应失败: %w", err), retryable: true, status: http.StatusBadGateway, firstByte: firstByte, keyFailed: true}
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
	firstChunk := false
	for {
		n, rerr := reader.Read(tmp)
		if n > 0 {
			// 首块数据已到达，流式超时只约束到首字，之后不再限时。
			if !firstChunk {
				firstChunk = true
				timer.Stop()
			}
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
				if timedOut.Load() {
					return attemptOutcome{status: resp.StatusCode, usage: usage, firstByte: firstByte,
						err: errors.New("上游响应超时"), retryable: false, wrote: true, estimated: est,
						reasoning: st.ReasoningChars(), upstreamBroken: true, keyFailed: true}
				}
				return attemptOutcome{status: resp.StatusCode, usage: usage, firstByte: firstByte,
					err: errors.New(cleanNetErr(rerr)), retryable: false, wrote: true, estimated: est,
					reasoning: st.ReasoningChars(), upstreamBroken: true, keyFailed: true}
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
