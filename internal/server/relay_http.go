package server

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"ldmapi/internal/relay"
	"ldmapi/internal/store"
)

// handleAPI 是对外的 OpenAI 兼容入口。任何 /v1/* 请求都会在这里做鉴权、
// 路由解析，然后交给 relay 转发。
func (s *Server) handleAPI(w http.ResponseWriter, r *http.Request) {
	// 鉴权失败、额度不足、IP 不在名单这些「提前返回」的分支都不会读请求体。
	// 客户端常带 Connection: close（Python 的 urllib、requests 都默认带），
	// 服务端关闭连接时接收缓冲区里还留着没读完的 body，Windows 会直接发 RST，
	// 客户端读错误响应时收到的是「连接被重置」，而不是这里本该写出的 401 / 403。
	// 统一在 handler 结束时把 body 读干净，任何分支都能让调用方收到完整响应。
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, 64<<20))
	}()
	started := time.Now()
	token, err := s.findToken(r.Header.Get("Authorization"), r.Header.Get("x-api-key"))
	if err != nil {
		// 存储层异常不把原始错误回给调用方，避免暴露内部细节。
		writeInvalidKey(w)
		return
	}
	if err := tokenValid(token); err != nil {
		if errors.Is(err, errTokenQuota) {
			writeJSON(w, http.StatusForbidden, map[string]any{
				"error": map[string]any{"message": err.Error(), "type": "permission_error", "code": "insufficient_quota"},
			})
			return
		}
		// 其余情况一律按「密钥无效」返回，不区分禁用、过期。
		writeInvalidKey(w)
		return
	}
	if !tokenAllowsIP(token, requestIP(r)) {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"error": map[string]any{
				"message": "你的IP不在令牌允许访问名单",
				"type":    "permission_error",
				"code":    "ip_not_allowed",
			},
		})
		return
	}

	p := "/v1" + strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v1"), "/")

	// API 密钥只能调用模型。显式白名单之外的路径（文件、微调、批处理等）
	// 在网关层直接拒绝，避免调用方拿管理员的渠道密钥操作上游账号。
	if !relay.IsAllowedEndpoint(r.Method, p) {
		writeJSON(w, http.StatusNotFound, map[string]any{
			"error": map[string]any{
				"message": "不支持的接口，API 密钥只能调用模型相关端点",
				"type":    "invalid_request_error",
				"code":    "unsupported_endpoint",
			},
		})
		return
	}

	// 模型列表不需要请求体
	if (r.Method == http.MethodGet || r.Method == http.MethodHead) && p == "/v1/models" {
		s.serveModelList(w, token)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "读取请求体失败")
		return
	}
	r.Body.Close()

	req := &relay.Request{
		Token:  token,
		Path:   p,
		Method: r.Method,
		Header: r.Header,
		Body:   body,
		IP:     clientIP(r),
	}
	// JSON 用 JSON 解析，图片编辑 / 语音转写用表单解析：
	// 两种形式的 model 都要拿到，才能做密钥模型白名单校验与路由。
	req.Prepare()
	if req.Model != "" && !tokenAllowsModel(token, req.Model) {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"error": map[string]any{
				"message": "该 API 密钥无权调用模型「" + req.Model + "」", "type": "permission_error", "code": "model_not_allowed",
			},
		})
		return
	}

	res := s.relay.Do(r.Context(), w, req)
	res.LatencyMs = time.Since(started).Milliseconds()
	s.record(token, req, res)
}

// writeInvalidKey 统一返回密钥无效。禁用、过期在对外响应上不做区分。
func writeInvalidKey(w http.ResponseWriter) {
	writeJSON(w, http.StatusUnauthorized, map[string]any{
		"error": map[string]any{"message": "无效的 API 密钥", "type": "invalid_api_key", "code": "invalid_api_key"},
	})
}

// serveModelList 返回当前可调用的模型列表。
func (s *Server) serveModelList(w http.ResponseWriter, token store.Token) {
	models, err := s.store.ListModels()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "读取模型列表失败")
		return
	}
	created := time.Now().Unix()
	data := []map[string]any{}
	for _, m := range models {
		if !m.Enabled {
			continue
		}
		if !tokenAllowsModel(token, m.ID) {
			continue
		}
		// 自定义内容返回不需要路由，也应当出现在可调用模型列表里。
		if m.Type == store.ModelTypeCustom && len(m.Routes) == 0 && !m.CustomContentEnabled() {
			continue
		}
		entry := map[string]any{
			"id":       m.ID,
			"object":   "model",
			"created":  created,
			"owned_by": "ldmapi",
		}
		if m.DisplayName != "" {
			entry["display_name"] = m.DisplayName
		}
		if m.Type == store.ModelTypeCustom {
			entry["routed_from"] = len(m.Routes)
		}
		data = append(data, entry)
	}
	writeJSON(w, http.StatusOK, map[string]any{"object": "list", "data": data})
}

// record 把一次调用写进日志与统计。
func (s *Server) record(token store.Token, req *relay.Request, res *relay.Result) {
	// 模型已禁用是配置侧的拒绝，不记错误日志、不计统计，也不消耗额度。
	if res.SkipRecord {
		return
	}
	entry := store.Log{
		ID:               randomHex(8),
		Time:             time.Now().UnixMilli(),
		TokenID:          token.ID,
		TokenName:        token.Name,
		ModelID:          res.ModelID,
		ChannelID:        res.ChannelID,
		ChannelName:      res.ChannelName,
		UpstreamModel:    res.UpstreamModel,
		KeyIndex:         res.KeyIndex,
		KeyMasked:        res.KeyMasked,
		KeyNote:          res.KeyNote,
		KeyAffinity:      res.KeyAffinity,
		Endpoint:         req.Path,
		PromptTokens:     res.Usage.PromptTokens,
		CompletionTokens: res.Usage.CompletionTokens,
		TotalTokens:      res.Usage.TotalTokens,
		UsageEstimate:    res.UsageEstimate,
		OutputEstimate:   res.OutputEstimate,
		LatencyMs:        res.LatencyMs,
		FirstByteMs:      res.FirstByteMs,
		StatusCode:       res.StatusCode,
		Error:            truncateErr(res.Err),
		ClientError:      truncateErr(res.ClientErr),
		// 「流式」徽章只看客户端请求的形态：请求体里写了 stream: true 就标，
		// 上游最后回的是 SSE 还是完整 JSON 都不影响这个标记。
		Stream:           req.Stream,
		Retries:          res.Retries,
		Attempts:         res.Attempts,
		Affinity:         res.Affinity,
		IP:               req.IP,
		ReasoningChars:   res.ReasoningChars,
		ReasoningTokens:  res.ReasoningTokens,
		CachedTokens:     res.CachedTokens,
		Canceled:         res.Canceled,
		AsContent:        res.AsContent,
	}
	entry.TokensPerSec = tokensPerSecond(entry, res.GenMs, res.StreamGen)
	_ = s.store.AppendLog(entry)
	// 上游返回的 400 是调用方请求本身的问题，写日志便于排查，
	// 但不计入统计：否则垃圾请求能把成功率刷低、把调用量刷高。
	if entry.StatusCode != http.StatusBadRequest {
		_ = s.store.RecordStat(entry)
	}
	if res.Usage.TotalTokens > 0 {
		s.store.AddTokenUsage(token.ID, int64(res.Usage.TotalTokens))
	}
}

// minSpeedWindowMs 是计算输出速度所需的最小生成窗口。
// 上游把整段响应一次性吐完（缓存命中、上游侧缓冲、假模型）时，首块到末块
// 只差几毫秒，拿它当分母会算出几万 t/s 这种没有意义的速度，这类记录不给速度。
const minSpeedWindowMs = 50

// tokensPerSecond 计算流式请求的输出速度。分母用「生成耗时」而不是总耗时：
// 首字之前的排队、建连时间不应该算进生成速度里。
// genMs 是转发层量到的真实输出窗口（首块内容到末块内容）；0 表示没测到窗口
// （上游一个字节都没写，或整段内容在同一毫秒内写完），这类记录同样不给速度。
// 不能拿「总耗时 - 首字耗时」当替代品：那段时间里混着首字之后的收尾
// （usage 块、[DONE]、连接关闭），会把一次性吐完的记录算成几千 t/s。
// streamGen 表示这次输出是一块块流式生成出来的（上游按流式请求并回了 SSE，
// 或自定义内容按模拟速度分块写出）：只看它，不看写给客户端的形态——
// 调用方要非流式、网关收完再返回时，生成过程一样有速度，这类记录同样要算。
func tokensPerSecond(l store.Log, genMs int64, streamGen bool) float64 {
	if !streamGen || l.CompletionTokens <= 0 {
		return 0
	}
	if genMs < minSpeedWindowMs {
		return 0
	}
	return float64(l.CompletionTokens) * 1000 / float64(genMs)
}

func truncateErr(s string) string {
	s = strings.TrimSpace(s)
	if len(s) <= 500 {
		return s
	}
	return s[:500] + "..."
}
