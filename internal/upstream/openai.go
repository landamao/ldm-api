package upstream

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"

	"ldmapi/internal/store"
)

func init() {
	registry[store.ChannelOpenAI] = &Provider{
		Type:         store.ChannelOpenAI,
		UpstreamPath: func(clientPath, _ string, _ bool) string { return clientPath },
		BuildBody:    openAIBody,
		Auth: func(req *http.Request, ch store.Channel) {
			SetJSONHeaders(req)
			if ch.APIKey != "" {
				req.Header.Set("Authorization", "Bearer "+ch.APIKey)
			}
		},
		Decode:    openAIDecode,
		NewStream: func(model string) Stream { return &openAIStream{} },
	}
}

// openAIBody 对 OpenAI 兼容上游基本是透传，只做模型名改写和能力裁剪。
func openAIBody(in map[string]any, upstreamModel string, caps store.Caps) map[string]any {
	if in == nil {
		return nil
	}
	out := in
	out["model"] = upstreamModel

	if caps.ToolCalling != nil && !*caps.ToolCalling {
		delete(out, "tools")
		delete(out, "tool_choice")
		delete(out, "functions")
		delete(out, "function_call")
	}
	if caps.Vision != nil && !*caps.Vision {
		stripImagesOpenAI(out)
	}
	if caps.Thinking != nil && !*caps.Thinking {
		for _, k := range []string{"reasoning_effort", "thinking", "enable_thinking", "reasoning", "include_reasoning", "thinking_budget"} {
			delete(out, k)
		}
	}
	if caps.MaxOutput != nil {
		if v, ok := intOf(out["max_tokens"]); ok && v > *caps.MaxOutput {
			out["max_tokens"] = *caps.MaxOutput
		}
		if v, ok := intOf(out["max_completion_tokens"]); ok && v > *caps.MaxOutput {
			out["max_completion_tokens"] = *caps.MaxOutput
		}
	}

	// 流式请求时注入 usage 统计，便于网关记账；上游不支持时也只是忽略该字段。
	if stream, _ := boolOf(out["stream"]); stream {
		so := asMap(out["stream_options"])
		if so == nil {
			so = map[string]any{}
		}
		if _, exists := so["include_usage"]; !exists {
			so["include_usage"] = true
			out["stream_options"] = so
		}
	}
	return out
}

func stripImagesOpenAI(body map[string]any) {
	msgs := asSlice(body["messages"])
	for _, mv := range msgs {
		m := asMap(mv)
		if m == nil {
			continue
		}
		parts := asSlice(m["content"])
		if parts == nil {
			continue
		}
		kept := make([]any, 0, len(parts))
		for _, pv := range parts {
			p := asMap(pv)
			if p == nil {
				kept = append(kept, pv)
				continue
			}
			switch str(p["type"]) {
			case "image_url", "input_image", "image":
				continue
			default:
				kept = append(kept, pv)
			}
		}
		if len(kept) == 0 {
			kept = append(kept, map[string]any{"type": "text", "text": "[图片已因模型不支持而被移除]"})
		}
		m["content"] = kept
	}
}

// openAIUsage 同时兼容 Chat Completions 和 Responses API 的用量字段。
// Responses API 用 input_tokens/output_tokens，思考与缓存命中分别放在
// output_tokens_details/input_tokens_details 里。
type openAIUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
	PromptDetails    struct {
		CachedTokens int `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
	CompletionDetails struct {
		ReasoningTokens int `json:"reasoning_tokens"`
	} `json:"completion_tokens_details"`
	// DeepSeek 等用这个字段名表示缓存命中
	PromptCacheHitTokens int `json:"prompt_cache_hit_tokens"`

	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
	InputDetails struct {
		CachedTokens int `json:"cached_tokens"`
	} `json:"input_tokens_details"`
	OutputDetails struct {
		ReasoningTokens int `json:"reasoning_tokens"`
	} `json:"output_tokens_details"`
}

func (u openAIUsage) usage() Usage {
	prompt, completion := u.PromptTokens, u.CompletionTokens
	if prompt == 0 {
		prompt = u.InputTokens
	}
	if completion == 0 {
		completion = u.OutputTokens
	}
	total := u.TotalTokens
	if total == 0 {
		total = prompt + completion
	}
	cached := pickCached(u.PromptDetails.CachedTokens, u.PromptCacheHitTokens)
	if cached == 0 {
		cached = u.InputDetails.CachedTokens
	}
	reasoning := u.CompletionDetails.ReasoningTokens
	if reasoning == 0 {
		reasoning = u.OutputDetails.ReasoningTokens
	}
	return Usage{
		PromptTokens:     prompt,
		CompletionTokens: completion,
		TotalTokens:      total,
		ReasoningTokens:  reasoning,
		CachedTokens:     cached,
	}
}

func openAIDecode(raw []byte, _ string) ([]byte, Usage, error) {
	var u struct {
		Usage    openAIUsage `json:"usage"`
		Response struct {
			Usage openAIUsage `json:"usage"`
		} `json:"response"`
	}
	_ = json.Unmarshal(raw, &u)
	us := u.Usage.usage()
	if us.Empty() {
		// 少数网关会把 Responses 响应再包一层 response 字段。
		us = u.Response.Usage.usage()
	}
	return raw, us, nil
}

// openAIStream 对 OpenAI 兼容上游直接透传，同时顺手抓取 usage 与输出长度。
type openAIStream struct {
	usage    Usage
	chars    int
	reasonCh int
	done     bool
}

func (s *openAIStream) Translate(line []byte) []byte {
	trimmed := bytes.TrimSpace(line)
	if len(trimmed) == 0 {
		return nil
	}
	if bytes.HasPrefix(trimmed, []byte("data:")) {
		payload := bytes.TrimSpace(trimmed[5:])
		if bytes.Equal(payload, []byte("[DONE]")) {
			s.done = true
		} else {
			var probe struct {
				Usage    *openAIUsage `json:"usage"`
				Response *struct {
					Usage *openAIUsage `json:"usage"`
				} `json:"response"`
				// Responses API 的事件类型，例如 response.output_text.delta。
				Type    string          `json:"type"`
				Delta   json.RawMessage `json:"delta"`
				Choices []struct {
					Delta struct {
						Content          string `json:"content"`
						ReasoningContent string `json:"reasoning_content"`
					} `json:"delta"`
					FinishReason *string `json:"finish_reason"`
				} `json:"choices"`
			}
			if err := json.Unmarshal(payload, &probe); err == nil {
				usage := probe.Usage
				if usage == nil && probe.Response != nil {
					usage = probe.Response.Usage
				}
				if usage != nil {
					if us := usage.usage(); !us.Empty() {
						s.usage = us
					}
				}
				for _, c := range probe.Choices {
					if c.FinishReason != nil && *c.FinishReason != "" {
						s.done = true
					}
					s.chars += len([]rune(c.Delta.Content))
					s.reasonCh += len([]rune(c.Delta.ReasoningContent))
				}
				// Responses API 的流没有 finish_reason，以 response.completed 收尾；
				// 正文和思考都放在顶层 delta 里，用于上游没给用量时估算。
				switch {
				case probe.Type == "response.completed" || probe.Type == "response.incomplete":
					s.done = true
				case strings.HasSuffix(probe.Type, ".delta"):
					var delta string
					if json.Unmarshal(probe.Delta, &delta) == nil {
						if strings.HasPrefix(probe.Type, "response.reasoning") {
							s.reasonCh += len([]rune(delta))
						} else {
							s.chars += len([]rune(delta))
						}
					}
				}
			}
		}
	}
	return append(append([]byte{}, trimmed...), '\n', '\n')
}

func (s *openAIStream) Finish() []byte      { return nil }
func (s *openAIStream) Usage() Usage        { return s.usage }
func (s *openAIStream) OutputChars() int    { return s.chars }
func (s *openAIStream) ReasoningChars() int { return s.reasonCh }
func (s *openAIStream) Err() error          { return nil }
func (s *openAIStream) Done() bool          { return s.done }

// NormalizeBase 清理渠道地址：去掉尾部斜杠，缺少协议头时补上 https://。
// 地址为空时返回空字符串——网关不会替用户猜一个默认上游，由调用方报错。
func NormalizeBase(base string) string {
	base = strings.TrimSpace(base)
	if base == "" {
		return ""
	}
	if !strings.Contains(base, "://") {
		base = "https://" + base
	}
	return strings.TrimRight(base, "/")
}

// pickCached 兼容两种缓存命中字段：OpenAI 的 prompt_tokens_details.cached_tokens
// 和 DeepSeek 系的 prompt_cache_hit_tokens。
func pickCached(details, deepseek int) int {
	if details > 0 {
		return details
	}
	return deepseek
}
