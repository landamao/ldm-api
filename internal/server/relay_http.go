package server

import (
	"encoding/json"
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
	if len(body) > 0 {
		var m map[string]any
		dec := json.NewDecoder(strings.NewReader(string(body)))
		dec.UseNumber()
		if err := dec.Decode(&m); err == nil {
			req.JSON = m
			if sv, ok := m["stream"].(bool); ok {
				req.Stream = sv
			}
			if mv, ok := m["model"].(string); ok && !tokenAllowsModel(token, mv) {
				writeJSON(w, http.StatusForbidden, map[string]any{
					"error": map[string]any{
						"message": "该 API 密钥无权调用模型「" + mv + "」", "type": "permission_error", "code": "model_not_allowed",
					},
				})
				return
			}
		}
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
		if m.Type == store.ModelTypeCustom && len(m.Routes) == 0 {
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
	entry := store.Log{
		ID:               randomHex(8),
		Time:             time.Now().UnixMilli(),
		TokenID:          token.ID,
		TokenName:        token.Name,
		ModelID:          res.ModelID,
		ChannelID:        res.ChannelID,
		ChannelName:      res.ChannelName,
		UpstreamModel:    res.UpstreamModel,
		Endpoint:         req.Path,
		PromptTokens:     res.Usage.PromptTokens,
		CompletionTokens: res.Usage.CompletionTokens,
		TotalTokens:      res.Usage.TotalTokens,
		LatencyMs:        res.LatencyMs,
		FirstByteMs:      res.FirstByteMs,
		StatusCode:       res.StatusCode,
		Error:            truncateErr(res.Err),
		ClientError:      truncateErr(res.ClientErr),
		Stream:           req.Stream,
		Retries:          res.Retries,
		Attempts:         res.Attempts,
		IP:               req.IP,
		ReasoningChars:   res.ReasoningChars,
		ReasoningTokens:  res.ReasoningTokens,
		CachedTokens:     res.CachedTokens,
		Canceled:         res.Canceled,
	}
	entry.TokensPerSec = tokensPerSecond(entry)
	_ = s.store.AppendLog(entry)
	_ = s.store.RecordStat(entry)
	if res.Usage.TotalTokens > 0 {
		s.store.AddTokenUsage(token.ID, int64(res.Usage.TotalTokens))
	}
}

// tokensPerSecond 计算流式请求的输出速度。分母用「生成耗时」而不是总耗时：
// 首字之前的排队、建连时间不应该算进生成速度里。
// 非流式是一次性返回的，没有有意义的生成窗口，直接返回 0。
func tokensPerSecond(l store.Log) float64 {
	if !l.Stream || l.CompletionTokens <= 0 {
		return 0
	}
	genMs := l.LatencyMs
	if l.FirstByteMs > 0 && l.FirstByteMs < l.LatencyMs {
		genMs = l.LatencyMs - l.FirstByteMs
	}
	if genMs <= 0 {
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
