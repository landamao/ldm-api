package relay

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"strings"
	"time"

	"ldmapi/internal/upstream"
)

// elapsedMs 返回从 start 到现在的毫秒数，亚毫秒按 1 记。
// 0 在日志里表示「没有首字」，本地极快返回的上游不能被记成没出字。
func elapsedMs(start time.Time) int64 {
	if ms := time.Since(start).Milliseconds(); ms > 0 {
		return ms
	}
	return 1
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte("{}")
	}
	return b
}

func jsonStr(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		return `""`
	}
	return string(b)
}

func randUint64() uint64 {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return 0
	}
	return binary.BigEndian.Uint64(b[:])
}

// estimateTokens 在没有上游用量时做粗略估算：
// ASCII 大约 4 字符 1 token，CJK 大约 1 字符 1 token。
func estimateTokens(s string) int {
	ascii, cjk := 0, 0
	for _, r := range s {
		if r < 128 {
			ascii++
		} else {
			cjk++
		}
	}
	n := ascii/4 + cjk
	if n == 0 && ascii > 0 {
		n = 1
	}
	return n
}

// estimateUsage 在没有上游用量时估算一次请求的 token。
func estimateUsage(req *Request) upstream.Usage {
	prompt := 0
	if req.JSON != nil {
		var sb strings.Builder
		for _, mv := range asAnySlice(req.JSON["messages"]) {
			if m, ok := mv.(map[string]any); ok {
				sb.WriteString(flattenText(m["content"]))
				sb.WriteString(flattenText(m["name"]))
			}
		}
		sb.WriteString(flattenText(req.JSON["system"]))
		sb.WriteString(flattenText(req.JSON["prompt"]))
		sb.WriteString(flattenText(req.JSON["input"]))
		sb.WriteString(flattenText(req.JSON["tools"]))
		prompt = estimateTokens(sb.String())
	} else {
		// 图片编辑、语音转写等表单请求没有 token 概念，
		// 只把 prompt / input 这类文本字段计入输入估算。
		prompt = estimateTokens(formTextOf(req, "prompt", "input", "text", "instructions"))
	}
	return upstream.Usage{PromptTokens: prompt, CompletionTokens: 0, TotalTokens: prompt}
}

func asAnySlice(v any) []any {
	if s, ok := v.([]any); ok {
		return s
	}
	return nil
}

func flattenText(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case []any:
		var sb strings.Builder
		for _, item := range t {
			sb.WriteString(flattenText(item))
		}
		return sb.String()
	case map[string]any:
		var sb strings.Builder
		for k, item := range t {
			if k == "data" || k == "base64" { // 跳过图片数据
				continue
			}
			sb.WriteString(flattenText(item))
		}
		return sb.String()
	}
	return ""
}

// responseOutputText 取出非流式响应里的正文与思考文本，用于上游没上报用量时
// 估算输出 token。只认对话响应里的文本字段：图片 base64、embedding 向量这类
// 没有 token 概念的内容不会被算成正文。工具调用的参数也是模型产出的内容，一并算进去。
func responseOutputText(raw []byte) string {
	var probe struct {
		Choices []struct {
			Text    string `json:"text"`
			Message struct {
				Content          any    `json:"content"`
				ReasoningContent string `json:"reasoning_content"`
				Reasoning        string `json:"reasoning"`
				ToolCalls        []struct {
					Function struct {
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
		// Responses API 的正文在 output[].content[].text，另有一个 output_text 便捷字段
		OutputText string `json:"output_text"`
		Output     []struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"output"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return ""
	}
	var sb strings.Builder
	for _, c := range probe.Choices {
		sb.WriteString(c.Text)
		sb.WriteString(c.Message.ReasoningContent)
		sb.WriteString(c.Message.Reasoning)
		sb.WriteString(contentText(c.Message.Content))
		for _, tc := range c.Message.ToolCalls {
			sb.WriteString(tc.Function.Arguments)
		}
	}
	sb.WriteString(probe.OutputText)
	for _, o := range probe.Output {
		for _, p := range o.Content {
			sb.WriteString(p.Text)
		}
	}
	return sb.String()
}

// contentText 只取多模态内容里的文本片段：图片的 data URL / b64 不算正文，
// 否则一张图就能把字符数撑到几十万，估算出来的 token 毫无意义。
func contentText(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case []any:
		var sb strings.Builder
		for _, item := range t {
			if m, ok := item.(map[string]any); ok {
				if s, ok := m["text"].(string); ok {
					sb.WriteString(s)
					continue
				}
				// 图片、音频这类片段没有 text 字段，整段跳过。
				if typ, _ := m["type"].(string); typ != "" && typ != "text" {
					continue
				}
			}
			sb.WriteString(contentText(item))
		}
		return sb.String()
	}
	return ""
}

// reasoningCharsOf 从非流式响应体里读出思考内容的字符数。
// 不同上游用的字段名不完全一样，这里把常见的几种都认一遍。
func reasoningCharsOf(raw []byte) int {
	var probe struct {
		Choices []struct {
			Message struct {
				ReasoningContent string `json:"reasoning_content"`
				Reasoning        string `json:"reasoning"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return 0
	}
	total := 0
	for _, c := range probe.Choices {
		total += len([]rune(c.Message.ReasoningContent)) + len([]rune(c.Message.Reasoning))
	}
	return total
}
