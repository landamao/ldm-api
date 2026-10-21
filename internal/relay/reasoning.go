package relay

import (
	"bytes"
	"encoding/json"
	"strings"

	"ldmapi/internal/store"
	"ldmapi/internal/upstream"
)

// reasoningOverride 描述模型配置的思考覆写。
type reasoningOverride struct {
	text string // 为空表示隐藏上游思考内容
}

// reasoningOverrideOf 返回模型生效的思考覆写。
// 自定义内容返回优先级最高：开启后请求不经过上游，思考覆写自然不生效。
func reasoningOverrideOf(m store.Model) (reasoningOverride, bool) {
	if m.CustomContentEnabled() || !m.ThinkingOverrideEnabled() {
		return reasoningOverride{}, false
	}
	return reasoningOverride{text: m.ThinkingOverrideText}, true
}

// reasoningOverrideStream 包装上游流式翻译器，改写客户端可见的思考内容。
// 各上游的流式输出最终都会翻译成 OpenAI SSE，因此这里不区分上游协议。
type reasoningOverrideStream struct {
	inner upstream.Stream
	text  string
	// injected 按 choice 下标记录是否已经输出过覆写文本。
	injected map[int]bool
	// respInjected 记录 Responses API 的思考增量是否已经输出过覆写文本。
	respInjected bool
	// outChars 是实际发给客户端的思考内容字符数，用于日志。
	outChars int
}

// newReasoningOverrideStream 创建思考覆写包装器。
func newReasoningOverrideStream(inner upstream.Stream, text string) upstream.Stream {
	return &reasoningOverrideStream{inner: inner, text: text, injected: map[int]bool{}}
}

func (s *reasoningOverrideStream) Translate(line []byte) []byte {
	return s.rewriteSSE(s.inner.Translate(line))
}

func (s *reasoningOverrideStream) Finish() []byte {
	return s.rewriteSSE(s.inner.Finish())
}

func (s *reasoningOverrideStream) Usage() upstream.Usage { return s.inner.Usage() }
func (s *reasoningOverrideStream) OutputChars() int      { return s.inner.OutputChars() }
func (s *reasoningOverrideStream) ReasoningChars() int   { return s.outChars }
func (s *reasoningOverrideStream) Err() error            { return s.inner.Err() }
func (s *reasoningOverrideStream) Done() bool            { return s.inner.Done() }

// rewriteSSE 按事件切分上游翻译结果，逐条改写带思考内容的事件。
func (s *reasoningOverrideStream) rewriteSSE(out []byte) []byte {
	if len(out) == 0 {
		return out
	}
	var buf bytes.Buffer
	rest := out
	for len(rest) > 0 {
		idx := bytes.Index(rest, []byte("\n\n"))
		if idx < 0 {
			buf.Write(s.rewriteEvent(rest))
			break
		}
		buf.Write(s.rewriteEvent(rest[:idx+2]))
		rest = rest[idx+2:]
	}
	return buf.Bytes()
}

// rewriteEvent 改写一条 data 事件。没有思考内容时原样返回，避免无谓的重编码。
func (s *reasoningOverrideStream) rewriteEvent(block []byte) []byte {
	trimmed := bytes.TrimSpace(block)
	if !bytes.HasPrefix(trimmed, []byte("data:")) {
		return block
	}
	payload := bytes.TrimSpace(trimmed[5:])
	if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
		return block
	}
	var obj map[string]any
	if err := json.Unmarshal(payload, &obj); err != nil {
		return block
	}
	changed := false
	if choices, ok := obj["choices"].([]any); ok {
		for i, cv := range choices {
			choice, ok := cv.(map[string]any)
			if !ok {
				continue
			}
			// n > 1 时每个 chunk 的 choices 通常只有一项，必须按 choice.index
			// 区分不同候选，不能直接用循环下标。
			idx := i
			if n, ok := choice["index"].(float64); ok {
				idx = int(n)
			}
			for _, key := range []string{"delta", "message"} {
				m, ok := choice[key].(map[string]any)
				if !ok {
					continue
				}
				if !stripReasoningFields(m) {
					continue
				}
				changed = true
				// 每个候选的思考只输出一次覆写文本，后续思考增量直接丢弃。
				if s.text != "" && !s.injected[idx] {
					m["reasoning_content"] = s.text
					s.injected[idx] = true
					s.outChars += len([]rune(s.text))
				}
			}
		}
	}
	if s.rewriteResponsesEvent(obj) {
		changed = true
	}
	if !changed {
		return block
	}
	b, err := json.Marshal(obj)
	if err != nil {
		return block
	}
	return append(append([]byte("data: "), b...), '\n', '\n')
}

// rewriteResponsesEvent 处理 Responses API 的流式事件。
// reasoning_summary_text.delta / reasoning_text.delta 是思考正文增量，
// output_item.done 和 response.completed 里则带着完整的思考条目。
func (s *reasoningOverrideStream) rewriteResponsesEvent(obj map[string]any) bool {
	switch stringOf(obj["type"]) {
	case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
		if stringOf(obj["delta"]) == "" {
			return false
		}
		if s.text != "" && !s.respInjected {
			obj["delta"] = s.text
			s.respInjected = true
			s.outChars += len([]rune(s.text))
		} else {
			obj["delta"] = ""
		}
		return true
	case "response.reasoning_summary_text.done", "response.reasoning_text.done":
		// 增量结束后上游会再发一次完整文本，这里同样替换或清空。
		if stringOf(obj["text"]) == "" {
			return false
		}
		if s.text != "" {
			obj["text"] = s.text
		} else {
			obj["text"] = ""
		}
		return true
	case "response.output_item.added", "response.output_item.done":
		item, ok := obj["item"].(map[string]any)
		if !ok || stringOf(item["type"]) != "reasoning" {
			return false
		}
		// added 里的思考文本直接清掉，思考增量会统一输出一次覆写文本。
		text := s.text
		if stringOf(obj["type"]) == "response.output_item.added" {
			text = ""
		}
		return rewriteResponsesReasoningItem(item, text)
	case "response.completed":
		resp, ok := obj["response"].(map[string]any)
		if !ok {
			return false
		}
		return rewriteResponsesOutput(resp, s.text)
	}
	return false
}

// rewriteReasoningJSON 改写非流式响应里的思考内容。
// 对话 / 补全响应改 message 或 choice 顶层的思考字段，
// Responses 响应则改 output 里的 reasoning 条目。
func rewriteReasoningJSON(raw []byte, text string) []byte {
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return raw
	}
	changed := false
	if choices, ok := obj["choices"].([]any); ok {
		for _, cv := range choices {
			choice, ok := cv.(map[string]any)
			if !ok {
				continue
			}
			for _, key := range []string{"message", "delta"} {
				m, ok := choice[key].(map[string]any)
				if !ok {
					continue
				}
				if stripReasoningFields(m) {
					changed = true
					if text != "" {
						m["reasoning_content"] = text
					}
				}
			}
			// 旧版补全端点可能把思考字段放在 choice 顶层。
			if stripReasoningFields(choice) {
				changed = true
				if text != "" {
					choice["reasoning_content"] = text
				}
			}
		}
	}
	if rewriteResponsesOutput(obj, text) {
		changed = true
	}
	if !changed {
		return raw
	}
	b, err := json.Marshal(obj)
	if err != nil {
		return raw
	}
	return b
}

// stripReasoningFields 删除常见字段名里的思考内容，返回其中是否真的有思考内容。
// 字段存在但为空也会被删掉，避免客户端看到空的思考字段。
func stripReasoningFields(m map[string]any) bool {
	found := false
	for _, k := range []string{"reasoning_content", "reasoning"} {
		v, ok := m[k]
		if !ok {
			continue
		}
		if s, isStr := v.(string); isStr {
			if s != "" {
				found = true
			}
		} else if valueTruthy(v) {
			found = true
		}
		delete(m, k)
	}
	if v, ok := m["reasoning_details"]; ok {
		if valueTruthy(v) {
			found = true
		}
		delete(m, "reasoning_details")
	}
	return found
}

// rewriteResponsesOutput 改写 Responses 响应 output 里的思考条目。
func rewriteResponsesOutput(resp map[string]any, text string) bool {
	output, ok := resp["output"].([]any)
	if !ok {
		return false
	}
	changed := false
	for _, ov := range output {
		item, ok := ov.(map[string]any)
		if !ok || stringOf(item["type"]) != "reasoning" {
			continue
		}
		if rewriteResponsesReasoningItem(item, text) {
			changed = true
		}
	}
	return changed
}

// rewriteResponsesReasoningItem 改写一个 reasoning 条目。
// 只有条目里本来就有可见思考文本时才改写；纯加密思考没有可替换的内容。
func rewriteResponsesReasoningItem(item map[string]any, text string) bool {
	changed := false
	if rewriteResponsesReasoningParts(item, "summary", "summary_text", text) {
		changed = true
	}
	if rewriteResponsesReasoningParts(item, "content", "reasoning_text", text) {
		changed = true
	}
	return changed
}

func rewriteResponsesReasoningParts(item map[string]any, field, typ, text string) bool {
	parts, ok := item[field].([]any)
	if !ok || len(parts) == 0 {
		return false
	}
	hasText := false
	for _, pv := range parts {
		if p, ok := pv.(map[string]any); ok && strings.TrimSpace(stringOf(p["text"])) != "" {
			hasText = true
			break
		}
	}
	if !hasText {
		return false
	}
	if text == "" {
		item[field] = []any{}
		return true
	}
	item[field] = []any{map[string]any{"type": typ, "text": text}}
	return true
}
