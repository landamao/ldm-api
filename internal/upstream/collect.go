package upstream

import (
	"bytes"
	"encoding/json"
	"strings"
)

// CollectedToolCall 是聚合后的一次工具调用。
// 流式响应把参数按片段下发，聚合时按顺序拼回去。
type CollectedToolCall struct {
	ID        string
	Name      string
	Arguments string
}

// Collector 把翻译后的 OpenAI SSE 重新聚合成一次完整的响应内容。
//
// 各上游协议最终都会被 Stream 翻译成 OpenAI 风格的 chat.completion.chunk，
// 因此这里只认这一种格式：强制流式时网关按流式请求上游，客户端要的却是
// 非流式结果，由它把分块还原成正文、思考内容和工具调用。
type Collector struct {
	// ID / Model / Created 是上游给出的响应标识，缺失时由调用方补默认值。
	ID      string
	Model   string
	Created int64
	// Content / Reasoning 是累计的正文与思考内容。
	Content   strings.Builder
	Reasoning strings.Builder
	// Finish 是最后一个非空 finish_reason。
	Finish string
	// ToolCalls 按首次出现的顺序保存聚合后的工具调用。
	ToolCalls []CollectedToolCall

	// toolSlot 记录流式下标到 ToolCalls 下标的映射：
	// 同一个工具调用的参数会分散在多块里，必须按 index 归位。
	toolSlot map[int]int
	// partial 保存上一段里没有换行符结尾的残行，等下一段补全后再解析。
	partial []byte
	// chunks 是收到的数据块数量，用于判断上游是否真的返回了内容。
	chunks int
}

// NewCollector 创建一个空的聚合器。
func NewCollector() *Collector {
	return &Collector{toolSlot: map[int]int{}}
}

// Chunks 返回聚合到的数据块数量（不含 [DONE] 与空行）。
func (c *Collector) Chunks() int { return c.chunks }

// HasContent 表示是否已经收到过真正的内容：正文、思考内容或工具调用。
// 只带 role 的空块、心跳块都不算，用于测量「第一段内容」的到达时间。
func (c *Collector) HasContent() bool {
	return c.Content.Len() > 0 || c.Reasoning.Len() > 0 || len(c.ToolCalls) > 0
}

// Feed 消费一段翻译后的输出。一段输出里可能有多条事件，
// 也可能只有半行，这里统一按行切分后逐条解析，残行留到下一段再处理。
func (c *Collector) Feed(out []byte) {
	rest := out
	if len(c.partial) > 0 {
		rest = append(c.partial, out...)
		c.partial = nil
	}
	for len(rest) > 0 {
		idx := bytes.IndexByte(rest, '\n')
		if idx < 0 {
			c.partial = append([]byte(nil), rest...)
			return
		}
		c.feedLine(rest[:idx])
		rest = rest[idx+1:]
	}
}

// collectedToolCall 是流式分块里的一个工具调用增量。
type collectedToolCall struct {
	Index    *int   `json:"index"`
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

// collectedChunk 是翻译后的一个 OpenAI 流式分块。
// content / reasoning 用 any 接收：个别上游会把它们发成内容数组。
// Type / Delta 是 Responses API 事件用的字段（正文、思考都在顶层 delta 里），
// 聚合时用不到，只用于判断「第一段内容」什么时候到。
type collectedChunk struct {
	ID      string          `json:"id"`
	Model   string          `json:"model"`
	Created int64           `json:"created"`
	Type    string          `json:"type"`
	Delta   json.RawMessage `json:"delta"`
	Choices []struct {
		// Index 是候选下标。n > 1 时各候选的增量混在同一个流里，
		// 聚合只保留第 0 个候选，避免把多个候选的正文拼在一起。
		Index *int `json:"index"`
		Delta struct {
			Content          any                 `json:"content"`
			ReasoningContent any                 `json:"reasoning_content"`
			Reasoning        any                 `json:"reasoning"`
			ToolCalls        []collectedToolCall `json:"tool_calls"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
}

// feedLine 解析一行 SSE。非 data 行（event:、注释、空行）直接忽略。
func (c *Collector) feedLine(line []byte) {
	trimmed := bytes.TrimSpace(line)
	if !bytes.HasPrefix(trimmed, []byte("data:")) {
		return
	}
	payload := bytes.TrimSpace(trimmed[5:])
	if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
		return
	}
	var ch collectedChunk
	if err := json.Unmarshal(payload, &ch); err != nil {
		return
	}
	c.chunks++
	if ch.ID != "" {
		c.ID = ch.ID
	}
	if ch.Model != "" {
		c.Model = ch.Model
	}
	if ch.Created > 0 {
		c.Created = ch.Created
	}
	for _, choice := range ch.Choices {
		// 只聚合第一个候选：对外返回的是单条 choices。
		if choice.Index != nil && *choice.Index != 0 {
			continue
		}
		c.Content.WriteString(textOfAny(choice.Delta.Content))
		// reasoning_content 是 OpenAI 兼容协议里的常见写法，
		// reasoning 是 OpenRouter 等网关的写法，两者都认。
		if s := textOfAny(choice.Delta.ReasoningContent); s != "" {
			c.Reasoning.WriteString(s)
		} else {
			c.Reasoning.WriteString(textOfAny(choice.Delta.Reasoning))
		}
		c.appendToolCalls(choice.Delta.ToolCalls)
		if fr := choice.FinishReason; fr != nil && *fr != "" {
			c.Finish = *fr
		}
	}
}

// appendToolCalls 把一块里的工具调用增量归位到对应的调用上。
func (c *Collector) appendToolCalls(calls []collectedToolCall) {
	for _, tc := range calls {
		idx := 0
		if tc.Index != nil {
			idx = *tc.Index
		}
		slot, ok := c.toolSlot[idx]
		if !ok {
			c.ToolCalls = append(c.ToolCalls, CollectedToolCall{})
			slot = len(c.ToolCalls) - 1
			c.toolSlot[idx] = slot
		}
		call := &c.ToolCalls[slot]
		if tc.ID != "" {
			call.ID = tc.ID
		}
		if tc.Function.Name != "" {
			call.Name = tc.Function.Name
		}
		// 参数是增量下发的，必须按顺序拼接；有的上游（如 Gemini）
		// 一次性发完整参数，拼一次即得到完整结果。
		call.Arguments += tc.Function.Arguments
	}
}

// textOfAny 把内容字段还原成字符串，兼容字符串与内容数组两种写法。
func textOfAny(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case []any:
		var sb strings.Builder
		for _, item := range t {
			if p := asMap(item); p != nil {
				sb.WriteString(str(p["text"]))
				continue
			}
			if s, ok := item.(string); ok {
				sb.WriteString(s)
			}
		}
		return sb.String()
	}
	return ""
}

// HasVisibleDelta 判断一段翻译后的输出里是否带有调用方能看到的内容：
// 正文、思考内容或工具调用。
//
// 上游在正文之前常会先发只带 role 的空块、心跳或 usage 分块，这些都不算「首字」；
// 只有真正产出内容的块才算，日志里的首字耗时因此更贴近调用方看到第一个字的时间。
func HasVisibleDelta(out []byte) bool {
	rest := out
	for len(rest) > 0 {
		idx := bytes.IndexByte(rest, '\n')
		var line []byte
		if idx < 0 {
			line, rest = rest, nil
		} else {
			line, rest = rest[:idx], rest[idx+1:]
		}
		if lineHasVisibleDelta(line) {
			return true
		}
	}
	return false
}

// lineHasVisibleDelta 解析一行 SSE 并判断它是否带内容。
func lineHasVisibleDelta(line []byte) bool {
	trimmed := bytes.TrimSpace(line)
	if !bytes.HasPrefix(trimmed, []byte("data:")) {
		return false
	}
	payload := bytes.TrimSpace(trimmed[5:])
	if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
		return false
	}
	var ch collectedChunk
	if err := json.Unmarshal(payload, &ch); err != nil {
		return false
	}
	for _, choice := range ch.Choices {
		if choice.Index != nil && *choice.Index != 0 {
			continue
		}
		if textOfAny(choice.Delta.Content) != "" {
			return true
		}
		// 思考内容也算内容：调用方这时已经能看到东西了。
		if textOfAny(choice.Delta.ReasoningContent) != "" || textOfAny(choice.Delta.Reasoning) != "" {
			return true
		}
		if len(choice.Delta.ToolCalls) > 0 {
			return true
		}
	}
	// Responses API 的正文 / 思考 / 工具参数都放在 type + delta 里，
	// 例如 response.output_text.delta、response.function_call_arguments.delta。
	if strings.HasSuffix(ch.Type, ".delta") {
		var s string
		if json.Unmarshal(ch.Delta, &s) == nil && s != "" {
			return true
		}
	}
	return false
}
