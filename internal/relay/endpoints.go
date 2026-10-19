package relay

import (
	"net/http"
	"strings"
)

// allowedPostPaths 是网关对外开放的模型调用端点。
//
// 这里采用显式白名单，而不是把 /v1/* 全部透传：API 密钥只能用于调用模型，
// 不能借管理员配置的上游密钥去操作文件、微调、批处理等账号级资源。
// 新增端点时必须确认它属于模型调用语义。
var allowedPostPaths = map[string]struct{}{
	"/v1/chat/completions":     {},
	"/v1/completions":          {},
	"/v1/messages":             {},
	"/v1/responses":            {},
	"/v1/responses/compact":    {},
	"/v1/embeddings":           {},
	"/v1/images/generations":   {},
	"/v1/images/edits":         {},
	"/v1/edits":                {},
	"/v1/audio/transcriptions": {},
	"/v1/audio/translations":   {},
	"/v1/audio/speech":         {},
	"/v1/rerank":               {},
	"/v1/moderations":          {},
}

// IsAllowedEndpoint 判断一个客户端请求是否属于网关允许转发的模型调用端点。
// 只有 GET/HEAD /v1/models 和白名单内的 POST 推理端点会返回 true；
// 其余路径（文件、微调、批处理等）一律在网关层拒绝，不会打到上游。
func IsAllowedEndpoint(method, path string) bool {
	path = strings.TrimSuffix(path, "/")
	switch method {
	case http.MethodGet, http.MethodHead:
		return path == "/v1/models"
	case http.MethodPost:
		if _, ok := allowedPostPaths[path]; ok {
			return true
		}
		// 兼容旧版 OpenAI engines 嵌入端点：/v1/engines/{model}/embeddings
		return strings.HasPrefix(path, "/v1/engines/") && strings.HasSuffix(path, "/embeddings")
	}
	return false
}
