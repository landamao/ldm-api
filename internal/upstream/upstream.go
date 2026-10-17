package upstream

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"ldmapi/internal/store"
)

// timeNow 便于测试替换。
var timeNow = time.Now

func nowUnix() int64 { return timeNow().Unix() }

// randomID 生成 n 个十六进制字符的随机标识。
func randomID(n int) string {
	b := make([]byte, (n+1)/2)
	if _, err := rand.Read(b); err != nil {
		return strings.Repeat("0", n)
	}
	return hex.EncodeToString(b)[:n]
}

// Usage 一次上游调用的 token 用量。
type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
	// ReasoningTokens 是思考消耗的 token。只有上游在用量里单独上报时才有值
	// （OpenAI 的 completion_tokens_details.reasoning_tokens、Gemini 的 thoughtsTokenCount），
	// Anthropic 把思考算在 output_tokens 里，因此这里为 0。
	ReasoningTokens int `json:"reasoning_tokens,omitempty"`
	// CachedTokens 是输入里命中提示词缓存的部分，上游没开启缓存或未上报时为 0。
	CachedTokens int `json:"cached_tokens,omitempty"`
}

func (u Usage) Empty() bool { return u.PromptTokens == 0 && u.CompletionTokens == 0 }

// Stream 把一个上游的流式响应逐块翻译成 OpenAI SSE。
type Stream interface {
	// Translate 处理上游的一行（不含换行符），返回需要写给客户端的内容。
	Translate(line []byte) []byte
	// Finish 在上游流结束时调用，返回收尾内容（例如 [DONE]）。
	Finish() []byte
	// Usage 返回累计用量。
	Usage() Usage
	// OutputChars 返回已产出的正文字符数，用于上游不给用量时做估算。
	OutputChars() int
	// ReasoningChars 返回已产出的思考内容字符数（模型不支持思考时为 0）。
	ReasoningChars() int
	// Err 返回翻译过程中遇到的致命错误。
	Err() error
}

// Provider 描述一种上游协议。
type Provider struct {
	Type string
	// UpstreamPath 由客户端请求路径与流式标志推导出上游路径。
	// model 用于 Gemini 这类把模型写进 URL 的协议。
	UpstreamPath func(clientPath, upstreamModel string, stream bool) string
	// BuildBody 把 OpenAI 格式请求体转换成上游请求体。in 可能为 nil（非 JSON 请求）。
	BuildBody func(in map[string]any, upstreamModel string, caps store.Caps) map[string]any
	// Auth 写入认证信息。
	Auth func(req *http.Request, ch store.Channel)
	// Decode 把上游非流式响应体翻译回 OpenAI 格式，并抽取用量。
	Decode func(raw []byte, model string) ([]byte, Usage, error)
	// NewStream 创建流式翻译器。
	NewStream func(model string) Stream
	// RawBody 为 true 时表示请求体不需要转换（直接透传）。
	RawBody bool
}

var registry = map[string]*Provider{}

// TypeNames 是支持的渠道类型及其中文显示名。
var TypeNames = map[string]string{
	store.ChannelOpenAI:    "OpenAI 兼容",
	store.ChannelAnthropic: "Anthropic",
	store.ChannelGemini:    "Google Gemini",
}

func Get(t string) *Provider {
	if p, ok := registry[t]; ok {
		return p
	}
	return registry[store.ChannelOpenAI]
}

// IsConversationPath 判断客户端路径是否属于对话类请求。
// 各家的对话端点不同（OpenAI 是 /v1/chat/completions，Anthropic 是 /v1/messages），
// 这里只做「是不是一次对话调用」的归类，具体映射交给各 Provider 的 UpstreamPath。
func IsConversationPath(p string) bool {
	p = strings.TrimSuffix(p, "/")
	return strings.HasSuffix(p, "/chat/completions") ||
		strings.HasSuffix(p, "/completions") ||
		strings.HasSuffix(p, "/messages")
}

// JoinURL 智能拼接渠道 base_url 与请求路径，避免出现 /v1/v1 或缺少 /v1。
func JoinURL(base, path string) string {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base == "" {
		base = "https://api.openai.com"
	}
	p := "/" + strings.TrimLeft(path, "/")
	for _, ver := range []string{"/v1beta", "/v1", "/v2"} {
		if strings.HasSuffix(base, ver) && strings.HasPrefix(p, ver+"/") {
			p = strings.TrimPrefix(p, ver)
			break
		}
	}
	return base + p
}

// SetJSONHeaders 是各 Provider 的公共默认头。
func SetJSONHeaders(req *http.Request) {
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
}

func asMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return nil
}

func asSlice(v any) []any {
	if s, ok := v.([]any); ok {
		return s
	}
	return nil
}

func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func intOf(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		return int(n), true
	case int:
		return n, true
	case int64:
		return int(n), true
	case json.Number:
		i, err := n.Int64()
		return int(i), err == nil
	}
	return 0, false
}

func boolOf(v any) (bool, bool) {
	b, ok := v.(bool)
	return b, ok
}

// encode 序列化，失败时返回一个最小可用对象，避免整条链路 panic。
func encode(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte(`{}`)
	}
	return b
}

func wrapErr(proto string, err error) error {
	return fmt.Errorf("%s: %w", proto, err)
}

// openAIUsageJSON 把内部用量渲染成 OpenAI 兼容的 usage 对象。
// 缓存命中放在 prompt_tokens_details.cached_tokens，与 OpenAI 的字段位置保持一致，
// 这样前端不用为不同上游写分支。
func openAIUsageJSON(us Usage) map[string]any {
	out := map[string]any{
		"prompt_tokens":     us.PromptTokens,
		"completion_tokens": us.CompletionTokens,
		"total_tokens":      us.TotalTokens,
	}
	if us.CachedTokens > 0 {
		out["prompt_tokens_details"] = map[string]any{"cached_tokens": us.CachedTokens}
	}
	if us.ReasoningTokens > 0 {
		out["completion_tokens_details"] = map[string]any{"reasoning_tokens": us.ReasoningTokens}
	}
	return out
}
