package upstream

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"ldmapi/internal/store"
)

func init() {
	registry[store.ChannelGemini] = &Provider{
		Type: store.ChannelGemini,
		UpstreamPath: func(clientPath, upstreamModel string, stream bool) string {
			action := "generateContent"
			if stream || strings.Contains(clientPath, "/streamGenerateContent") {
				action = "streamGenerateContent?alt=sse"
			}
			if upstreamModel == "" {
				upstreamModel = "gemini-1.5-flash"
			}
			return "/v1beta/models/" + url.PathEscape(upstreamModel) + ":" + action
		},
		BuildBody: geminiBody,
		Auth: func(req *http.Request, ch store.Channel) {
			SetJSONHeaders(req)
			if ch.APIKey != "" {
				req.Header.Set("x-goog-api-key", ch.APIKey)
			}
		},
		Decode:    geminiDecode,
		NewStream: func(model string) Stream { return &geminiStream{model: model} },
	}
}

// ---------- 请求转换 ----------

func geminiBody(in map[string]any, upstreamModel string, caps store.Caps) map[string]any {
	if in == nil {
		return nil
	}
	vision := caps.Vision == nil || *caps.Vision
	toolEnabled := caps.ToolCalling == nil || *caps.ToolCalling

	out := map[string]any{}
	var sysParts []string
	contents := []any{}

	appendContent := func(role string, parts []any) {
		if len(parts) == 0 {
			return
		}
		if n := len(contents); n > 0 {
			prev := asMap(contents[n-1])
			if str(prev["role"]) == role {
				prev["parts"] = append(asSlice(prev["parts"]), parts...)
				return
			}
		}
		contents = append(contents, map[string]any{"role": role, "parts": parts})
	}

	for _, mv := range asSlice(in["messages"]) {
		m := asMap(mv)
		if m == nil {
			continue
		}
		switch str(m["role"]) {
		case "system", "developer":
			if s := textOfContent(m["content"]); s != "" {
				sysParts = append(sysParts, s)
			}
		case "user":
			appendContent("user", geminiParts(m["content"], vision))
		case "assistant":
			var parts []any
			if s := textOfContent(m["content"]); s != "" {
				parts = append(parts, map[string]any{"text": s})
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
				var args any = map[string]any{}
				if a := str(fn["arguments"]); a != "" {
					var parsed any
					if err := json.Unmarshal([]byte(a), &parsed); err == nil {
						args = parsed
					}
				}
				parts = append(parts, map[string]any{
					"functionCall": map[string]any{"name": str(fn["name"]), "args": args},
				})
			}
			appendContent("model", parts)
		case "tool", "function":
			appendContent("user", []any{map[string]any{
				"functionResponse": map[string]any{
					"name":     str(m["name"]),
					"response": map[string]any{"result": textOfContent(m["content"])},
				},
			}})
		}
	}
	if len(contents) == 0 {
		contents = append(contents, map[string]any{"role": "user", "parts": []any{map[string]any{"text": ""}}})
	}
	out["contents"] = contents
	if len(sysParts) > 0 {
		out["systemInstruction"] = map[string]any{"parts": []any{map[string]any{"text": strings.Join(sysParts, "\n\n")}}}
	}

	gen := map[string]any{}
	for _, k := range []string{"temperature", "topP", "topK"} {
		if v, ok := in[k]; ok {
			gen[k] = v
		}
	}
	if v, ok := in["temperature"]; ok {
		gen["temperature"] = v
	}
	if v, ok := in["top_p"]; ok {
		gen["topP"] = v
	}
	if v, ok := in["top_k"]; ok {
		gen["topK"] = v
	}
	maxOut := 0
	if v, ok := intOf(in["max_tokens"]); ok && v > 0 {
		maxOut = v
	} else if v, ok := intOf(in["max_completion_tokens"]); ok && v > 0 {
		maxOut = v
	}
	if caps.MaxOutput != nil && (maxOut == 0 || maxOut > *caps.MaxOutput) {
		maxOut = *caps.MaxOutput
	}
	if maxOut > 0 {
		gen["maxOutputTokens"] = maxOut
	}
	if v, ok := in["stop"]; ok {
		switch s := v.(type) {
		case string:
			gen["stopSequences"] = []any{s}
		case []any:
			gen["stopSequences"] = s
		}
	}
	thinking := caps.Thinking == nil || *caps.Thinking
	if thinking {
		if th := asMap(in["thinking"]); th != nil {
			if b, ok := intOf(th["budget_tokens"]); ok && b > 0 {
				gen["thinkingConfig"] = map[string]any{"thinkingBudget": b, "includeThoughts": true}
			}
		}
	}
	if len(gen) > 0 {
		out["generationConfig"] = gen
	}

	tools := asSlice(in["tools"])
	if len(tools) > 0 && toolEnabled {
		decls := []any{}
		for _, tv := range tools {
			t := asMap(tv)
			if t == nil {
				continue
			}
			fn := asMap(t["function"])
			if fn == nil {
				continue
			}
			d := map[string]any{"name": str(fn["name"])}
			if desc := str(fn["description"]); desc != "" {
				d["description"] = desc
			}
			if p := asMap(fn["parameters"]); p != nil {
				d["parameters"] = sanitizeGeminiSchema(p)
			}
			decls = append(decls, d)
		}
		if len(decls) > 0 {
			out["tools"] = []any{map[string]any{"functionDeclarations": decls}}
		}
	}
	return out
}

// sanitizeGeminiSchema 去掉 Gemini 不认识的 JSON Schema 关键字，避免 400。
func sanitizeGeminiSchema(in map[string]any) map[string]any {
	allowed := map[string]bool{
		"type": true, "format": true, "description": true, "nullable": true,
		"enum": true, "items": true, "properties": true, "required": true,
		"minimum": true, "maximum": true, "propertyOrdering": true, "default": true,
	}
	out := map[string]any{}
	for k, v := range in {
		if !allowed[k] {
			continue
		}
		switch k {
		case "properties":
			if props := asMap(v); props != nil {
				np := map[string]any{}
				for pk, pv := range props {
					if pm := asMap(pv); pm != nil {
						np[pk] = sanitizeGeminiSchema(pm)
					} else {
						np[pk] = pv
					}
				}
				out[k] = np
			}
		case "items":
			if im := asMap(v); im != nil {
				out[k] = sanitizeGeminiSchema(im)
			}
		default:
			out[k] = v
		}
	}
	return out
}

func geminiParts(content any, vision bool) []any {
	parts := []any{}
	switch c := content.(type) {
	case string:
		parts = append(parts, map[string]any{"text": c})
	case []any:
		for _, pv := range c {
			p := asMap(pv)
			if p == nil {
				if s, ok := pv.(string); ok {
					parts = append(parts, map[string]any{"text": s})
				}
				continue
			}
			switch str(p["type"]) {
			case "text", "input_text":
				t := str(p["text"])
				if t == "" {
					t = str(p["content"])
				}
				parts = append(parts, map[string]any{"text": t})
			case "image_url", "input_image", "image":
				if !vision {
					continue
				}
				if img := geminiImage(p); img != nil {
					parts = append(parts, img)
				}
			case "file", "input_file":
				if f := geminiFile(p); f != nil {
					parts = append(parts, f)
				}
			case "document":
				if d := geminiDocument(p); d != nil {
					parts = append(parts, d)
				}
			}
		}
	}
	if len(parts) == 0 {
		parts = append(parts, map[string]any{"text": ""})
	}
	return parts
}

func geminiImage(p map[string]any) map[string]any {
	raw := ""
	if u := asMap(p["image_url"]); u != nil {
		raw = str(u["url"])
	} else {
		// OpenAI Responses 风格的 input_image 直接把地址放在 image_url 上
		raw = str(p["image_url"])
	}
	if raw == "" {
		raw = str(p["url"])
	}
	if raw == "" {
		return nil
	}
	if strings.HasPrefix(raw, "data:") {
		rest := strings.TrimPrefix(raw, "data:")
		semi := strings.Index(rest, ";base64,")
		if semi < 0 {
			return nil
		}
		return map[string]any{"inlineData": map[string]any{
			"mimeType": rest[:semi], "data": rest[semi+len(";base64,"):],
		}}
	}
	return map[string]any{"fileData": map[string]any{"mimeType": "image/png", "fileUri": raw}}
}

// geminiFile 把 OpenAI 风格的 file / input_file 内容块翻译成 Gemini 的
// inlineData（base64）或 fileData（远程地址）。纯文本附件直接作为 text part。
func geminiFile(p map[string]any) map[string]any {
	file := asMap(p["file"])
	if file == nil {
		file = p
	}
	name := str(file["filename"])
	if name == "" {
		name = str(p["filename"])
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
		return nil
	}
	if strings.HasPrefix(data, "data:") {
		rest := strings.TrimPrefix(data, "data:")
		semi := strings.Index(rest, ";base64,")
		if semi < 0 {
			return nil
		}
		return map[string]any{"inlineData": map[string]any{
			"mimeType": rest[:semi], "data": rest[semi+len(";base64,"):],
		}}
	}
	if strings.HasPrefix(data, "http://") || strings.HasPrefix(data, "https://") {
		return map[string]any{"fileData": map[string]any{
			"mimeType": guessMime(name, data), "fileUri": data,
		}}
	}
	return map[string]any{"text": data}
}

// geminiDocument 兼容 Anthropic 原生的 document 块，便于自定义请求体直接粘贴。
func geminiDocument(p map[string]any) map[string]any {
	src := asMap(p["source"])
	if src == nil {
		return geminiFile(p)
	}
	switch str(src["type"]) {
	case "base64":
		return map[string]any{"inlineData": map[string]any{
			"mimeType": str(src["media_type"]), "data": str(src["data"]),
		}}
	case "text":
		text := str(src["data"])
		if title := str(p["title"]); title != "" {
			text = "【" + title + "】\n" + text
		}
		return map[string]any{"text": text}
	case "url":
		return map[string]any{"fileData": map[string]any{
			"mimeType": guessMime(str(p["title"]), str(src["url"])), "fileUri": str(src["url"]),
		}}
	}
	return nil
}

// ---------- 响应转换 ----------

type geminiResponse struct {
	Candidates []struct {
		Content struct {
			Role  string `json:"role"`
			Parts []struct {
				Text         string `json:"text"`
				Thought      bool   `json:"thought"`
				FunctionCall *struct {
					Name string          `json:"name"`
					Args json.RawMessage `json:"args"`
				} `json:"functionCall"`
			} `json:"parts"`
		} `json:"content"`
		FinishReason string `json:"finishReason"`
	} `json:"candidates"`
	UsageMetadata struct {
		PromptTokenCount        int `json:"promptTokenCount"`
		CandidatesTokenCount    int `json:"candidatesTokenCount"`
		TotalTokenCount         int `json:"totalTokenCount"`
		ThoughtsTokenCount      int `json:"thoughtsTokenCount"`
		CachedContentTokenCount int `json:"cachedContentTokenCount"`
	} `json:"usageMetadata"`
	Error *struct {
		Message string `json:"message"`
		Status  string `json:"status"`
		Code    int    `json:"code"`
	} `json:"error"`
}

func geminiDecode(raw []byte, model string) ([]byte, Usage, error) {
	var r geminiResponse
	if err := json.Unmarshal(raw, &r); err != nil {
		return raw, Usage{}, wrapErr("gemini", err)
	}
	if r.Error != nil {
		out := map[string]any{"error": map[string]any{
			"message": r.Error.Message, "type": r.Error.Status, "code": r.Error.Code,
		}}
		return encode(out), Usage{}, nil
	}
	text, reasoning, toolCalls := geminiExtract(&r)

	us := Usage{
		PromptTokens:     r.UsageMetadata.PromptTokenCount,
		CompletionTokens: r.UsageMetadata.CandidatesTokenCount,
		TotalTokens:      r.UsageMetadata.TotalTokenCount,
		ReasoningTokens:  r.UsageMetadata.ThoughtsTokenCount,
		CachedTokens:     r.UsageMetadata.CachedContentTokenCount,
	}
	if us.TotalTokens == 0 {
		us.TotalTokens = us.PromptTokens + us.CompletionTokens
	}

	finish := "stop"
	if len(r.Candidates) > 0 {
		finish = mapGeminiFinish(r.Candidates[0].FinishReason)
	}
	msg := map[string]any{"role": "assistant", "content": text}
	if reasoning != "" {
		msg["reasoning_content"] = reasoning
	}
	if len(toolCalls) > 0 {
		msg["tool_calls"] = toolCalls
		if text == "" {
			msg["content"] = nil
		}
		finish = "tool_calls"
	}
	out := map[string]any{
		"id":      "chatcmpl-gemini-" + randomID(12),
		"object":  "chat.completion",
		"created": nowUnix(),
		"model":   model,
		"choices": []any{map[string]any{"index": 0, "message": msg, "finish_reason": finish}},
		"usage": map[string]any{
			"prompt_tokens": us.PromptTokens, "completion_tokens": us.CompletionTokens, "total_tokens": us.TotalTokens,
		},
	}
	return encode(out), us, nil
}

func geminiExtract(r *geminiResponse) (string, string, []any) {
	var text, reasoning strings.Builder
	var toolCalls []any
	if len(r.Candidates) == 0 {
		return "", "", nil
	}
	for _, p := range r.Candidates[0].Content.Parts {
		if p.FunctionCall != nil {
			args := "{}"
			if len(p.FunctionCall.Args) > 0 {
				args = string(p.FunctionCall.Args)
			}
			toolCalls = append(toolCalls, map[string]any{
				"id": "call_" + randomID(16), "type": "function",
				"function": map[string]any{"name": p.FunctionCall.Name, "arguments": args},
			})
			continue
		}
		if p.Thought {
			reasoning.WriteString(p.Text)
		} else {
			text.WriteString(p.Text)
		}
	}
	return text.String(), reasoning.String(), toolCalls
}

func mapGeminiFinish(r string) string {
	switch r {
	case "STOP":
		return "stop"
	case "MAX_TOKENS":
		return "length"
	case "SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST":
		return "content_filter"
	}
	if r == "" {
		return "stop"
	}
	return "stop"
}

// ---------- 流式转换 ----------

type geminiStream struct {
	model     string
	id        string
	usage     Usage
	chars     int
	reasonCh  int
	roleSent  bool
	finished  bool
	toolIndex int
	err       error
}

func (s *geminiStream) chunk(delta map[string]any, finish any) []byte {
	payload := map[string]any{
		"id":      s.id,
		"object":  "chat.completion.chunk",
		"created": nowUnix(),
		"model":   s.model,
		"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}},
	}
	if finish != nil {
		payload["usage"] = openAIUsageJSON(s.usage)
	}
	return append([]byte("data: "), append(encode(payload), '\n', '\n')...)
}

func (s *geminiStream) Translate(line []byte) []byte {
	trimmed := bytes.TrimSpace(line)
	if len(trimmed) == 0 {
		return nil
	}
	if bytes.HasPrefix(trimmed, []byte("data:")) {
		trimmed = bytes.TrimSpace(trimmed[5:])
	}
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil
	}
	if s.id == "" {
		s.id = "chatcmpl-gemini-" + randomID(12)
	}
	var r geminiResponse
	if err := json.Unmarshal(trimmed, &r); err != nil {
		return nil
	}
	if r.Error != nil {
		s.err = fmt.Errorf("%s: %s", r.Error.Status, r.Error.Message)
		return nil
	}
	if r.UsageMetadata.TotalTokenCount > 0 {
		s.usage.PromptTokens = r.UsageMetadata.PromptTokenCount
		s.usage.CompletionTokens = r.UsageMetadata.CandidatesTokenCount
		s.usage.TotalTokens = r.UsageMetadata.TotalTokenCount
		s.usage.ReasoningTokens = r.UsageMetadata.ThoughtsTokenCount
		s.usage.CachedTokens = r.UsageMetadata.CachedContentTokenCount
	}

	var out []byte
	if !s.roleSent {
		s.roleSent = true
		out = append(out, s.chunk(map[string]any{"role": "assistant", "content": ""}, nil)...)
	}

	if len(r.Candidates) > 0 {
		for _, p := range r.Candidates[0].Content.Parts {
			if p.FunctionCall != nil {
				args := "{}"
				if len(p.FunctionCall.Args) > 0 {
					args = string(p.FunctionCall.Args)
				}
				ix := s.toolIndex
				s.toolIndex++
				out = append(out, s.chunk(map[string]any{"tool_calls": []any{map[string]any{
					"index": ix, "id": "call_" + randomID(16), "type": "function",
					"function": map[string]any{"name": p.FunctionCall.Name, "arguments": args},
				}}}, nil)...)
				continue
			}
			if p.Text == "" {
				continue
			}
			if p.Thought {
				s.reasonCh += len([]rune(p.Text))
			} else {
				s.chars += len([]rune(p.Text))
			}
			if p.Thought {
				out = append(out, s.chunk(map[string]any{"reasoning_content": p.Text}, nil)...)
			} else {
				out = append(out, s.chunk(map[string]any{"content": p.Text}, nil)...)
			}
		}
		if fr := r.Candidates[0].FinishReason; fr != "" && !s.finished {
			s.finished = true
			if s.usage.TotalTokens == 0 {
				s.usage.TotalTokens = s.usage.PromptTokens + s.usage.CompletionTokens
			}
			out = append(out, s.chunk(map[string]any{}, mapGeminiFinish(fr))...)
		}
	}
	return out
}

func (s *geminiStream) Finish() []byte {
	var out []byte
	if !s.finished {
		s.finished = true
		s.usage.TotalTokens = s.usage.PromptTokens + s.usage.CompletionTokens
		out = append(out, s.chunk(map[string]any{}, "stop")...)
	}
	out = append(out, []byte("data: [DONE]\n\n")...)
	return out
}

func (s *geminiStream) Usage() Usage        { return s.usage }
func (s *geminiStream) OutputChars() int    { return s.chars }
func (s *geminiStream) ReasoningChars() int { return s.reasonCh }
func (s *geminiStream) Err() error          { return s.err }
func (s *geminiStream) Done() bool          { return s.finished }
