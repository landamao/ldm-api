package relay

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"strings"

	"ldmapi/internal/upstream"
)

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
