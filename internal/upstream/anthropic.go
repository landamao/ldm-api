package upstream

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"ldmapi/internal/store"
)

func init() {
	registry[store.ChannelAnthropic] = &Provider{
		Type: store.ChannelAnthropic,
		UpstreamPath: func(clientPath, _ string, _ bool) string {
			// Anthropic 的对话端点是 /v1/messages。客户端无论是用 OpenAI 风格的
			// /v1/chat/completions，还是直接用 Anthropic 原生的 /v1/messages 调进来，
			// 都要归一到 /v1/messages，否则真实上游会返回 404。
			if IsConversationPath(clientPath) {
				return "/v1/messages"
			}
			// 其它端点（embeddings 等）Anthropic 没有对应实现，原样转发让上游给出明确错误
			return clientPath
		},
		BuildBody: anthropicBody,
		Auth: func(req *http.Request, ch store.Channel) {
			SetJSONHeaders(req)
			if ch.APIKey != "" {
				req.Header.Set("x-api-key", ch.APIKey)
			}
			req.Header.Set("anthropic-version", "2023-06-01")
		},
		Decode:    anthropicDecode,
		NewStream: func(model string) Stream { return newAnthropicStream(model) },
	}
}

const anthropicDefaultMaxTokens = 4096

// ---------- 请求转换 ----------

func anthropicBody(in map[string]any, upstreamModel string, caps store.Caps) map[string]any {
	if in == nil {
		return nil
	}
	out := map[string]any{"model": upstreamModel}

	maxTokens := anthropicDefaultMaxTokens
	if v, ok := intOf(in["max_tokens"]); ok && v > 0 {
		maxTokens = v
	} else if v, ok := intOf(in["max_completion_tokens"]); ok && v > 0 {
		maxTokens = v
	} else if caps.MaxOutput != nil && *caps.MaxOutput > 0 {
		maxTokens = *caps.MaxOutput
	}
	if caps.MaxOutput != nil && maxTokens > *caps.MaxOutput {
		maxTokens = *caps.MaxOutput
	}
	out["max_tokens"] = maxTokens

	if stream, _ := boolOf(in["stream"]); stream {
		out["stream"] = true
	}
	for _, k := range []string{"temperature", "top_p", "top_k", "metadata", "service_tier"} {
		if v, ok := in[k]; ok && k != "service_tier" {
			out[k] = v
		}
	}
	if v, ok := in["stop"]; ok {
		switch s := v.(type) {
		case string:
			out["stop_sequences"] = []any{s}
		case []any:
			out["stop_sequences"] = s
		}
	}

	system, msgs := convertMessagesAnthropic(asSlice(in["messages"]), caps)
	if system != "" {
		out["system"] = system
	}
	out["messages"] = msgs

	tools := asSlice(in["tools"])
	toolEnabled := caps.ToolCalling == nil || *caps.ToolCalling
	if len(tools) > 0 && toolEnabled {
		conv := make([]any, 0, len(tools))
		for _, tv := range tools {
			t := asMap(tv)
			if t == nil {
				continue
			}
			fn := asMap(t["function"])
			if fn == nil {
				// 已经是 Anthropic 风格的工具定义
				if str(t["name"]) != "" {
					conv = append(conv, t)
				}
				continue
			}
			item := map[string]any{"name": str(fn["name"])}
			if d := str(fn["description"]); d != "" {
				item["description"] = d
			}
			if p := asMap(fn["parameters"]); p != nil {
				item["input_schema"] = p
			} else {
				item["input_schema"] = map[string]any{"type": "object", "properties": map[string]any{}}
			}
			conv = append(conv, item)
		}
		if len(conv) > 0 {
			out["tools"] = conv
			if tc := convertToolChoiceAnthropic(in["tool_choice"]); tc != nil {
				out["tool_choice"] = tc
			}
		}
	}

	thinking := caps.Thinking == nil || *caps.Thinking
	if thinking {
		// 透传调用方显式要求的思考预算
		if th := asMap(in["thinking"]); th != nil {
			out["thinking"] = th
		} else if budget, ok := intOf(in["thinking_budget"]); ok && budget > 0 {
			out["thinking"] = map[string]any{"type": "enabled", "budget_tokens": budget}
		} else if effort := str(in["reasoning_effort"]); effort != "" {
			// OpenAI 的 reasoning_effort 映射成 Anthropic 的思考预算
			budget := map[string]int{"minimal": 1024, "low": 2048, "medium": 8192, "high": 16384}[effort]
			if budget == 0 {
				budget = 8192
			}
			out["thinking"] = map[string]any{"type": "enabled", "budget_tokens": budget}
		}
		if th := asMap(out["thinking"]); th != nil {
			if b, ok := intOf(th["budget_tokens"]); ok && b >= maxTokens {
				// Anthropic 要求 budget_tokens < max_tokens
				newMax := b + 1024
				out["max_tokens"] = newMax
				maxTokens = newMax
			}
		}
	}
	return out
}

func convertMessagesAnthropic(msgs []any, caps store.Caps) (string, []any) {
	var systemParts []string
	out := []any{}
	vision := caps.Vision == nil || *caps.Vision

	appendMsg := func(role string, content []any) {
		if len(content) == 0 {
			return
		}
		if n := len(out); n > 0 {
			prev := asMap(out[n-1])
			if str(prev["role"]) == role {
				prev["content"] = append(asSlice(prev["content"]), content...)
				return
			}
		}
		out = append(out, map[string]any{"role": role, "content": content})
	}

	for _, mv := range msgs {
		m := asMap(mv)
		if m == nil {
			continue
		}
		role := str(m["role"])
		switch role {
		case "system", "developer":
			if s := textOfContent(m["content"]); s != "" {
				systemParts = append(systemParts, s)
			}
		case "user":
			appendMsg("user", convertUserContent(m["content"], vision))
		case "assistant":
			var content []any
			if s := textOfContent(m["content"]); s != "" {
				content = append(content, map[string]any{"type": "text", "text": s})
			}
			for _, tcv := range asSlice(m["tool_calls"]) {
				tc := asMap(tcv)
				if tc == nil {
					continue
				}
				fn := asMap(tc["function"])
				if fn == nil {
					continue
				}
				var input any = map[string]any{}
				args := str(fn["arguments"])
				if args != "" {
					var parsed any
					if err := json.Unmarshal([]byte(args), &parsed); err == nil {
						input = parsed
					}
				}
				content = append(content, map[string]any{
					"type": "tool_use", "id": str(tc["id"]), "name": str(fn["name"]), "input": input,
				})
			}
			appendMsg("assistant", content)
		case "tool", "function":
			appendMsg("user", []any{map[string]any{
				"type":        "tool_result",
				"tool_use_id": str(m["tool_call_id"]),
				"content":     textOfContent(m["content"]),
			}})
		}
	}
	if len(out) == 0 {
		out = append(out, map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": ""}}})
	}
	return strings.Join(systemParts, "\n\n"), out
}

func convertUserContent(content any, vision bool) []any {
	out := []any{}
	switch c := content.(type) {
	case string:
		if c != "" {
			out = append(out, map[string]any{"type": "text", "text": c})
		}
	case []any:
		for _, pv := range c {
			p := asMap(pv)
			if p == nil {
				if s, ok := pv.(string); ok && s != "" {
					out = append(out, map[string]any{"type": "text", "text": s})
				}
				continue
			}
			switch str(p["type"]) {
			case "text", "input_text":
				t := str(p["text"])
				if t == "" {
					t = str(p["content"])
				}
				if t != "" {
					out = append(out, map[string]any{"type": "text", "text": t})
				}
			case "image_url", "input_image", "image":
				if !vision {
					continue
				}
				if img := convertImageAnthropic(p); img != nil {
					out = append(out, img)
				}
			case "file", "input_file":
				if f := convertFileAnthropic(p); f != nil {
					out = append(out, f)
				}
			case "document":
				// 已经是 Anthropic 原生 document 块时原样透传
				if asMap(p["source"]) != nil {
					out = append(out, p)
				} else if f := convertFileAnthropic(p); f != nil {
					out = append(out, f)
				}
			}
		}
	}
	if len(out) == 0 {
		out = append(out, map[string]any{"type": "text", "text": ""})
	}
	return out
}

func convertImageAnthropic(p map[string]any) map[string]any {
	url := ""
	if u := asMap(p["image_url"]); u != nil {
		url = str(u["url"])
	} else {
		// OpenAI Responses 风格的 input_image 直接把地址放在 image_url 上
		url = str(p["image_url"])
	}
	if url == "" {
		url = str(p["url"])
	}
	if url == "" {
		return nil
	}
	if strings.HasPrefix(url, "data:") {
		rest := strings.TrimPrefix(url, "data:")
		semi := strings.Index(rest, ";base64,")
		if semi < 0 {
			return nil
		}
		media := rest[:semi]
		data := rest[semi+len(";base64,"):]
		return map[string]any{
			"type":   "image",
			"source": map[string]any{"type": "base64", "media_type": media, "data": data},
		}
	}
	return map[string]any{"type": "image", "source": map[string]any{"type": "url", "url": url}}
}

// convertFileAnthropic 把 OpenAI 风格的 file / input_file 内容块翻译成
// Anthropic 的 document 块。图片类附件仍走 image 块，文本附件解码后走 text source。
func convertFileAnthropic(p map[string]any) map[string]any {
	file := asMap(p["file"])
	if file == nil {
		file = p
	}
	filename := str(file["filename"])
	if filename == "" {
		filename = str(p["filename"])
	}
	data := str(file["file_data"])
	if data == "" {
		data = str(file["data"])
	}
	if data == "" {
		data = str(file["file_url"])
	}
	if data == "" {
		data = str(file["url"])
	}
	if data == "" {
		if id := str(file["file_id"]); id != "" {
			return map[string]any{
				"type":   "document",
				"source": map[string]any{"type": "file", "file_id": id},
			}
		}
		return nil
	}

	if strings.HasPrefix(data, "data:") {
		rest := strings.TrimPrefix(data, "data:")
		semi := strings.Index(rest, ";base64,")
		if semi < 0 {
			return nil
		}
		media := rest[:semi]
		raw := rest[semi+len(";base64,"):]
		if strings.HasPrefix(media, "image/") {
			return map[string]any{
				"type":   "image",
				"source": map[string]any{"type": "base64", "media_type": media, "data": raw},
			}
		}
		if strings.HasPrefix(media, "text/") {
			if decoded, err := base64.StdEncoding.DecodeString(raw); err == nil {
				return map[string]any{
					"type":   "document",
					"source": map[string]any{"type": "text", "media_type": "text/plain", "data": string(decoded)},
				}
			}
		}
		doc := map[string]any{
			"type":   "document",
			"source": map[string]any{"type": "base64", "media_type": media, "data": raw},
		}
		if filename != "" {
			doc["title"] = filename
		}
		return doc
	}

	if strings.HasPrefix(data, "http://") || strings.HasPrefix(data, "https://") {
		if looksLikeImage(filename, data) {
			return map[string]any{
				"type":   "image",
				"source": map[string]any{"type": "url", "url": data},
			}
		}
		doc := map[string]any{
			"type":   "document",
			"source": map[string]any{"type": "url", "url": data},
		}
		if filename != "" {
			doc["title"] = filename
		}
		return doc
	}

	// 不是 data URL 也不是远程地址，按纯文本附件处理
	return map[string]any{
		"type":   "document",
		"source": map[string]any{"type": "text", "media_type": "text/plain", "data": data},
	}
}

func looksLikeImage(name, url string) bool {
	s := strings.ToLower(name)
	if s == "" {
		s = strings.ToLower(url)
	}
	for _, ext := range []string{".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"} {
		if strings.Contains(s, ext) {
			return true
		}
	}
	return false
}

func convertToolChoiceAnthropic(v any) map[string]any {
	switch t := v.(type) {
	case string:
		switch t {
		case "auto":
			return map[string]any{"type": "auto"}
		case "required", "any":
			return map[string]any{"type": "any"}
		case "none":
			return nil
		}
	case map[string]any:
		if str(t["type"]) == "function" {
			if fn := asMap(t["function"]); fn != nil {
				return map[string]any{"type": "tool", "name": str(fn["name"])}
			}
		}
		if s := str(t["type"]); s == "auto" || s == "any" {
			return map[string]any{"type": s}
		}
		if n := str(t["name"]); n != "" {
			return map[string]any{"type": "tool", "name": n}
		}
	}
	return nil
}

// textOfContent 从字符串或内容数组中抽取纯文本。
func textOfContent(v any) string {
	switch c := v.(type) {
	case string:
		return c
	case []any:
		var sb strings.Builder
		for _, pv := range c {
			if p := asMap(pv); p != nil {
				if t := str(p["text"]); t != "" {
					sb.WriteString(t)
				}
			} else if s, ok := pv.(string); ok {
				sb.WriteString(s)
			}
		}
		return sb.String()
	}
	return ""
}

// ---------- 响应转换 ----------

func anthropicDecode(raw []byte, model string) ([]byte, Usage, error) {
	var resp struct {
		ID         string `json:"id"`
		Model      string `json:"model"`
		StopReason string `json:"stop_reason"`
		Content    []struct {
			Type  string          `json:"type"`
			Text  string          `json:"text"`
			ID    string          `json:"id"`
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		} `json:"content"`
		Usage struct {
			InputTokens              int `json:"input_tokens"`
			OutputTokens             int `json:"output_tokens"`
			CacheReadInputTokens     int `json:"cache_read_input_tokens"`
			CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
		} `json:"usage"`
		Error *struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return raw, Usage{}, wrapErr("anthropic", err)
	}
	if resp.Error != nil {
		// 上游错误保持 Anthropic 结构会让 OpenAI 客户端困惑，转成统一错误体
		out := map[string]any{"error": map[string]any{
			"message": resp.Error.Message, "type": resp.Error.Type, "code": resp.Error.Type,
		}}
		return encode(out), Usage{}, nil
	}

	var text strings.Builder
	var reasoning strings.Builder
	var toolCalls []any
	for _, c := range resp.Content {
		switch c.Type {
		case "text":
			text.WriteString(c.Text)
		case "thinking":
			reasoning.WriteString(c.Text)
		case "tool_use":
			args := "{}"
			if len(c.Input) > 0 {
				args = string(c.Input)
			}
			toolCalls = append(toolCalls, map[string]any{
				"id": c.ID, "type": "function",
				"function": map[string]any{"name": c.Name, "arguments": args},
			})
		}
	}

	msg := map[string]any{"role": "assistant", "content": text.String()}
	if reasoning.Len() > 0 {
		msg["reasoning_content"] = reasoning.String()
	}
	if len(toolCalls) > 0 {
		msg["tool_calls"] = toolCalls
		if text.Len() == 0 {
			msg["content"] = nil
		}
	}

	// Anthropic 的 input_tokens 只统计未命中缓存的部分，缓存读写要单独相加，
	// 这样映射到 OpenAI 语义的 prompt_tokens 才是完整输入量。
	promptTotal := resp.Usage.InputTokens + resp.Usage.CacheReadInputTokens + resp.Usage.CacheCreationInputTokens
	us := Usage{
		PromptTokens:     promptTotal,
		CompletionTokens: resp.Usage.OutputTokens,
		TotalTokens:      promptTotal + resp.Usage.OutputTokens,
		CachedTokens:     resp.Usage.CacheReadInputTokens,
	}
	out := map[string]any{
		"id":      nonEmpty(resp.ID, "chatcmpl-anthropic"),
		"object":  "chat.completion",
		"created": nowUnix(),
		"model":   nonEmpty(model, resp.Model),
		"choices": []any{map[string]any{
			"index":         0,
			"message":       msg,
			"finish_reason": mapStopReason(resp.StopReason),
		}},
		"usage": openAIUsageJSON(us),
	}
	return encode(out), us, nil
}

func mapStopReason(r string) string {
	switch r {
	case "end_turn", "stop_sequence", "pause_turn":
		return "stop"
	case "max_tokens":
		return "length"
	case "tool_use":
		return "tool_calls"
	case "refusal":
		return "content_filter"
	}
	return "stop"
}

// ---------- 流式转换 ----------

type anthropicStream struct {
	model       string
	id          string
	usage       Usage
	chars       int
	reasonCh    int
	roleSent    bool
	finished    bool
	toolIndex   int
	blockKind   map[int]string // content block index -> kind
	blockToolIX map[int]int    // content block index -> OpenAI tool_calls 下标
	err         error
}

func newAnthropicStream(model string) *anthropicStream {
	return &anthropicStream{
		model:       model,
		blockKind:   map[int]string{},
		blockToolIX: map[int]int{},
	}
}

func (s *anthropicStream) chunk(delta map[string]any, finish any) []byte {
	choice := map[string]any{"index": 0, "delta": delta, "finish_reason": finish}
	payload := map[string]any{
		"id":      s.id,
		"object":  "chat.completion.chunk",
		"created": nowUnix(),
		"model":   s.model,
		"choices": []any{choice},
	}
	if finish != nil {
		payload["usage"] = openAIUsageJSON(s.usage)
	}
	return append([]byte("data: "), append(encode(payload), '\n', '\n')...)
}

func (s *anthropicStream) Translate(line []byte) []byte {
	trimmed := bytes.TrimSpace(line)
	if len(trimmed) == 0 || !bytes.HasPrefix(trimmed, []byte("data:")) {
		return nil
	}
	payload := bytes.TrimSpace(trimmed[5:])
	if len(payload) == 0 {
		return nil
	}
	var ev struct {
		Type    string `json:"type"`
		Index   int    `json:"index"`
		Message *struct {
			ID    string `json:"id"`
			Usage struct {
				InputTokens              int `json:"input_tokens"`
				OutputTokens             int `json:"output_tokens"`
				CacheReadInputTokens     int `json:"cache_read_input_tokens"`
				CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
			} `json:"usage"`
		} `json:"message"`
		ContentBlock *struct {
			Type string `json:"type"`
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"content_block"`
		Delta *struct {
			Type        string `json:"type"`
			Text        string `json:"text"`
			Thinking    string `json:"thinking"`
			PartialJSON string `json:"partial_json"`
			StopReason  string `json:"stop_reason"`
		} `json:"delta"`
		Usage *struct {
			OutputTokens int `json:"output_tokens"`
		} `json:"usage"`
		Error *struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(payload, &ev); err != nil {
		return nil
	}

	var out []byte
	switch ev.Type {
	case "message_start":
		if ev.Message != nil {
			s.id = nonEmpty(ev.Message.ID, "chatcmpl-anthropic")
			s.usage.PromptTokens = ev.Message.Usage.InputTokens +
				ev.Message.Usage.CacheReadInputTokens + ev.Message.Usage.CacheCreationInputTokens
			s.usage.CachedTokens = ev.Message.Usage.CacheReadInputTokens
		}
		if !s.roleSent {
			s.roleSent = true
			out = append(out, s.chunk(map[string]any{"role": "assistant", "content": ""}, nil)...)
		}
	case "content_block_start":
		if ev.ContentBlock != nil {
			s.blockKind[ev.Index] = ev.ContentBlock.Type
			if ev.ContentBlock.Type == "tool_use" {
				ix := s.toolIndex
				s.toolIndex++
				s.blockToolIX[ev.Index] = ix
				out = append(out, s.chunk(map[string]any{"tool_calls": []any{map[string]any{
					"index": ix, "id": ev.ContentBlock.ID, "type": "function",
					"function": map[string]any{"name": ev.ContentBlock.Name, "arguments": ""},
				}}}, nil)...)
			}
		}
	case "content_block_delta":
		if ev.Delta != nil {
			switch ev.Delta.Type {
			case "text_delta":
				if ev.Delta.Text != "" {
					s.chars += len([]rune(ev.Delta.Text))
					out = append(out, s.chunk(map[string]any{"content": ev.Delta.Text}, nil)...)
				}
			case "thinking_delta":
				if ev.Delta.Thinking != "" {
					s.reasonCh += len([]rune(ev.Delta.Thinking))
					out = append(out, s.chunk(map[string]any{"reasoning_content": ev.Delta.Thinking}, nil)...)
				}
			case "input_json_delta":
				if ix, ok := s.blockToolIX[ev.Index]; ok {
					s.chars += len(ev.Delta.PartialJSON)
					out = append(out, s.chunk(map[string]any{"tool_calls": []any{map[string]any{
						"index": ix, "function": map[string]any{"arguments": ev.Delta.PartialJSON},
					}}}, nil)...)
				}
			}
		}
	case "message_delta":
		if ev.Usage != nil {
			s.usage.CompletionTokens = ev.Usage.OutputTokens
		}
		if ev.Delta != nil && ev.Delta.StopReason != "" && !s.finished {
			s.finished = true
			s.usage.TotalTokens = s.usage.PromptTokens + s.usage.CompletionTokens
			out = append(out, s.chunk(map[string]any{}, mapStopReason(ev.Delta.StopReason))...)
		}
	case "message_stop":
		out = append(out, s.Finish()...)
	case "error":
		if ev.Error != nil {
			s.err = fmt.Errorf("%s: %s", ev.Error.Type, ev.Error.Message)
		}
	}
	return out
}

func (s *anthropicStream) Finish() []byte {
	var out []byte
	if !s.finished {
		s.finished = true
		s.usage.TotalTokens = s.usage.PromptTokens + s.usage.CompletionTokens
		out = append(out, s.chunk(map[string]any{}, "stop")...)
	}
	out = append(out, []byte("data: [DONE]\n\n")...)
	return out
}

func (s *anthropicStream) Usage() Usage        { return s.usage }
func (s *anthropicStream) OutputChars() int    { return s.chars }
func (s *anthropicStream) ReasoningChars() int { return s.reasonCh }
func (s *anthropicStream) Err() error          { return s.err }
func (s *anthropicStream) Done() bool          { return s.finished }

func nonEmpty(v, def string) string {
	if strings.TrimSpace(v) == "" {
		return def
	}
	return v
}
