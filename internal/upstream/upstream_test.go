package upstream

import (
	"encoding/json"
	"strings"
	"testing"

	"ldmapi/internal/store"
)

func ptrInt(v int) *int    { return &v }
func ptrBool(v bool) *bool { return &v }

func decode(t *testing.T, b []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("结果不是合法 JSON: %v\n%s", err, b)
	}
	return m
}

// num 把 JSON 里的数字统一成 float64，兼容 map[string]any 中可能出现的 int。
func num(t *testing.T, v any) float64 {
	t.Helper()
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	}
	t.Fatalf("期望数字，实际是 %T", v)
	return 0
}

func mustJSON(t *testing.T, s string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		t.Fatalf("测试输入不是合法 JSON: %v", err)
	}
	return m
}

// ---------- URL 拼接 ----------

// 各 Provider 必须把客户端请求映射到上游的原生端点，否则真实上游会 404。
func TestProviderUpstreamPaths(t *testing.T) {
	cases := []struct {
		kind       string
		clientPath string
		model      string
		stream     bool
		want       string
	}{
		{store.ChannelOpenAI, "/v1/chat/completions", "gpt-4o", false, "/v1/chat/completions"},
		{store.ChannelOpenAI, "/v1/chat/completions", "gpt-4o", true, "/v1/chat/completions"},
		{store.ChannelOpenAI, "/v1/embeddings", "x", false, "/v1/embeddings"},

		// 关键：OpenAI 风格的入口必须被翻译成 Anthropic 的 /v1/messages
		{store.ChannelAnthropic, "/v1/chat/completions", "claude-sonnet", false, "/v1/messages"},
		{store.ChannelAnthropic, "/v1/chat/completions", "claude-sonnet", true, "/v1/messages"},
		{store.ChannelAnthropic, "/v1/messages", "claude-sonnet", false, "/v1/messages"},
		// 非对话端点原样转发，让上游给出明确错误
		{store.ChannelAnthropic, "/v1/embeddings", "x", false, "/v1/embeddings"},

		{store.ChannelGemini, "/v1/chat/completions", "gemini-2.0-flash", false, "/v1beta/models/gemini-2.0-flash:generateContent"},
		{store.ChannelGemini, "/v1/chat/completions", "gemini-2.0-flash", true, "/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse"},
	}
	for _, c := range cases {
		got := Get(c.kind).UpstreamPath(c.clientPath, c.model, c.stream)
		if got != c.want {
			t.Errorf("%s.UpstreamPath(%q, stream=%v) = %q，期望 %q", c.kind, c.clientPath, c.stream, got, c.want)
		}
	}
}

func TestIsConversationPath(t *testing.T) {
	yes := []string{"/v1/chat/completions", "/v1/completions", "/v1/messages", "/v1/chat/completions/"}
	no := []string{"/v1/embeddings", "/v1/models", "/v1/messages/count_tokens", "/v1/images/generations"}
	for _, p := range yes {
		if !IsConversationPath(p) {
			t.Errorf("%q 应被判定为对话请求", p)
		}
	}
	for _, p := range no {
		if IsConversationPath(p) {
			t.Errorf("%q 不应被判定为对话请求", p)
		}
	}
}

func TestJoinURL(t *testing.T) {
	cases := []struct{ base, path, want string }{
		{"https://api.openai.com", "/v1/chat/completions", "https://api.openai.com/v1/chat/completions"},
		{"https://api.openai.com/", "/v1/chat/completions", "https://api.openai.com/v1/chat/completions"},
		{"https://api.openai.com/v1", "/v1/chat/completions", "https://api.openai.com/v1/chat/completions"},
		{"https://api.openai.com/v1/", "v1/chat/completions", "https://api.openai.com/v1/chat/completions"},
		{"https://api.anthropic.com", "/v1/messages", "https://api.anthropic.com/v1/messages"},
		{"https://generativelanguage.googleapis.com", "/v1beta/models/x:generateContent",
			"https://generativelanguage.googleapis.com/v1beta/models/x:generateContent"},
		{"https://generativelanguage.googleapis.com/v1beta", "/v1beta/models/x:generateContent",
			"https://generativelanguage.googleapis.com/v1beta/models/x:generateContent"},
	}
	for _, c := range cases {
		if got := JoinURL(c.base, c.path); got != c.want {
			t.Errorf("JoinURL(%q,%q) = %q, want %q", c.base, c.path, got, c.want)
		}
	}
}

func TestNormalizeBase(t *testing.T) {
	// 空地址必须原样返回空串：网关不能替用户猜一个默认上游
	if got := NormalizeBase(""); got != "" {
		t.Errorf("空地址应返回空串，得到 %q", got)
	}
	if got := NormalizeBase("   "); got != "" {
		t.Errorf("纯空白应返回空串，得到 %q", got)
	}
	if got := NormalizeBase("api.deepseek.com"); got != "https://api.deepseek.com" {
		t.Errorf("缺少协议头应自动补全，得到 %q", got)
	}
	if got := NormalizeBase("http://127.0.0.1:8080/"); got != "http://127.0.0.1:8080" {
		t.Errorf("应去掉尾部斜杠，得到 %q", got)
	}
}

// ---------- OpenAI 能力裁剪 ----------

func TestOpenAIBodyStripsUnsupportedCapabilities(t *testing.T) {
	in := mustJSON(t, `{
		"model":"x",
		"messages":[{"role":"user","content":[
			{"type":"text","text":"看图"},
			{"type":"image_url","image_url":{"url":"data:image/png;base64,AAA"}}
		]}],
		"tools":[{"type":"function","function":{"name":"f"}}],
		"tool_choice":"auto",
		"reasoning_effort":"high",
		"max_tokens":8000
	}`)
	caps := store.Caps{
		ToolCalling: ptrBool(false),
		Vision:      ptrBool(false),
		Thinking:    ptrBool(false),
		MaxOutput:   ptrInt(1000),
	}
	out := openAIBody(in, "upstream-model", caps)

	if out["model"] != "upstream-model" {
		t.Errorf("模型名应被改写，得到 %v", out["model"])
	}
	for _, k := range []string{"tools", "tool_choice", "reasoning_effort"} {
		if _, ok := out[k]; ok {
			t.Errorf("不支持的 %s 应被剥离", k)
		}
	}
	if got := num(t, out["max_tokens"]); got != 1000 {
		t.Errorf("max_tokens 应被压到 1000，得到 %v", got)
	}
	content := out["messages"].([]any)[0].(map[string]any)["content"].([]any)
	for _, part := range content {
		if part.(map[string]any)["type"] == "image_url" {
			t.Error("图片内容应被剥离")
		}
	}
}

func TestOpenAIBodyKeepsSupportedCapabilities(t *testing.T) {
	in := mustJSON(t, `{"model":"x","messages":[],"tools":[{"type":"function"}],"stream":true}`)
	out := openAIBody(in, "y", store.Caps{ToolCalling: ptrBool(true)})
	if _, ok := out["tools"]; !ok {
		t.Error("支持工具调用时不应剥离 tools")
	}
	so, ok := out["stream_options"].(map[string]any)
	if !ok || so["include_usage"] != true {
		t.Error("流式请求应注入 stream_options.include_usage")
	}
}

// ---------- Anthropic 请求转换 ----------

func TestAnthropicBodyBasicConversion(t *testing.T) {
	in := mustJSON(t, `{
		"model":"claude",
		"messages":[
			{"role":"system","content":"你是助手"},
			{"role":"user","content":"你好"}
		],
		"max_tokens":512,
		"temperature":0.3
	}`)
	out := anthropicBody(in, "claude-3", store.Caps{})

	if out["model"] != "claude-3" {
		t.Errorf("模型名错误: %v", out["model"])
	}
	if out["system"] != "你是助手" {
		t.Errorf("system 消息应被提取，得到 %v", out["system"])
	}
	if num(t, out["max_tokens"]) != 512 {
		t.Errorf("max_tokens 应保留 512，得到 %v", out["max_tokens"])
	}
	msgs := out["messages"].([]any)
	if len(msgs) != 1 {
		t.Fatalf("system 应被移出 messages，剩下 %d 条", len(msgs))
	}
	first := msgs[0].(map[string]any)
	if first["role"] != "user" {
		t.Errorf("角色错误: %v", first["role"])
	}
}

func TestAnthropicBodyDefaultMaxTokens(t *testing.T) {
	in := mustJSON(t, `{"model":"c","messages":[{"role":"user","content":"hi"}]}`)
	out := anthropicBody(in, "c", store.Caps{})
	if num(t, out["max_tokens"]) != anthropicDefaultMaxTokens {
		t.Errorf("缺少 max_tokens 时应补默认值，得到 %v", out["max_tokens"])
	}
}

func TestAnthropicBodyToolConversion(t *testing.T) {
	in := mustJSON(t, `{
		"model":"c","messages":[{"role":"user","content":"hi"}],
		"tools":[{"type":"function","function":{"name":"get_weather","description":"查天气",
			"parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}],
		"tool_choice":"required"
	}`)
	out := anthropicBody(in, "c", store.Caps{})
	tools := out["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("工具数量错误: %d", len(tools))
	}
	tool := tools[0].(map[string]any)
	if tool["name"] != "get_weather" {
		t.Errorf("工具名错误: %v", tool["name"])
	}
	if _, ok := tool["input_schema"]; !ok {
		t.Error("应把 parameters 映射成 input_schema")
	}
	tc := out["tool_choice"].(map[string]any)
	if tc["type"] != "any" {
		t.Errorf("required 应映射成 any，得到 %v", tc["type"])
	}
}

func TestAnthropicBodyStripsToolsWhenUnsupported(t *testing.T) {
	in := mustJSON(t, `{"model":"c","messages":[],"tools":[{"type":"function","function":{"name":"f"}}]}`)
	out := anthropicBody(in, "c", store.Caps{ToolCalling: ptrBool(false)})
	if _, ok := out["tools"]; ok {
		t.Error("不支持工具调用时应剥离 tools")
	}
}

func TestAnthropicBodyImageConversion(t *testing.T) {
	in := mustJSON(t, `{"model":"c","messages":[{"role":"user","content":[
		{"type":"text","text":"描述"},
		{"type":"image_url","image_url":{"url":"data:image/png;base64,QUJD"}}
	]}]}`)
	out := anthropicBody(in, "c", store.Caps{Vision: ptrBool(true)})
	content := out["messages"].([]any)[0].(map[string]any)["content"].([]any)
	if len(content) != 2 {
		t.Fatalf("内容块数量错误: %d", len(content))
	}
	img := content[1].(map[string]any)
	if img["type"] != "image" {
		t.Errorf("应为 image 类型，得到 %v", img["type"])
	}
	src := img["source"].(map[string]any)
	if src["media_type"] != "image/png" || src["data"] != "QUJD" {
		t.Errorf("base64 解析错误: %v", src)
	}
}

func TestAnthropicBodyDropsImageWhenVisionUnsupported(t *testing.T) {
	in := mustJSON(t, `{"model":"c","messages":[{"role":"user","content":[
		{"type":"text","text":"描述"},
		{"type":"image_url","image_url":{"url":"data:image/png;base64,QUJD"}}
	]}]}`)
	out := anthropicBody(in, "c", store.Caps{Vision: ptrBool(false)})
	content := out["messages"].([]any)[0].(map[string]any)["content"].([]any)
	if len(content) != 1 {
		t.Errorf("图片应被丢弃，剩下 %d 个内容块", len(content))
	}
}

func TestAnthropicBodyMergesConsecutiveToolResults(t *testing.T) {
	in := mustJSON(t, `{"model":"c","messages":[
		{"role":"assistant","content":null,"tool_calls":[
			{"id":"t1","type":"function","function":{"name":"f","arguments":"{\"a\":1}"}},
			{"id":"t2","type":"function","function":{"name":"g","arguments":"{}"}}
		]},
		{"role":"tool","tool_call_id":"t1","content":"r1"},
		{"role":"tool","tool_call_id":"t2","content":"r2"}
	]}`)
	out := anthropicBody(in, "c", store.Caps{})
	msgs := out["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("两条 tool 结果应合并成一条 user 消息，实际 %d 条", len(msgs))
	}
	assistant := msgs[0].(map[string]any)
	blocks := assistant["content"].([]any)
	if len(blocks) != 2 {
		t.Fatalf("assistant 应有 2 个 tool_use 块，实际 %d", len(blocks))
	}
	use := blocks[0].(map[string]any)
	if use["type"] != "tool_use" || use["name"] != "f" {
		t.Errorf("tool_use 转换错误: %v", use)
	}
	if _, ok := use["input"].(map[string]any); !ok {
		t.Errorf("arguments 应被解析成对象，得到 %T", use["input"])
	}
	last := msgs[1].(map[string]any)
	if last["role"] != "user" {
		t.Errorf("tool 结果应变成 user 消息，得到 %v", last["role"])
	}
	if got := len(last["content"].([]any)); got != 2 {
		t.Errorf("应合并 2 个 tool_result，实际 %d", got)
	}
}

func TestAnthropicThinkingBudgetBelowMaxTokens(t *testing.T) {
	in := mustJSON(t, `{"model":"c","messages":[],"max_tokens":2000,"reasoning_effort":"high"}`)
	out := anthropicBody(in, "c", store.Caps{Thinking: ptrBool(true)})
	th, ok := out["thinking"].(map[string]any)
	if !ok {
		t.Fatal("reasoning_effort 应映射出 thinking 配置")
	}
	budget := num(t, th["budget_tokens"])
	maxTok := num(t, out["max_tokens"])
	if budget >= maxTok {
		t.Errorf("budget_tokens(%v) 必须小于 max_tokens(%v)", budget, maxTok)
	}
}

// ---------- Anthropic 响应转换 ----------

func TestAnthropicDecode(t *testing.T) {
	raw := []byte(`{
		"id":"msg_1","model":"claude-3","stop_reason":"end_turn",
		"content":[{"type":"text","text":"你好"}],
		"usage":{"input_tokens":10,"output_tokens":5}
	}`)
	out, usage, err := anthropicDecode(raw, "LDM")
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	if m["object"] != "chat.completion" {
		t.Errorf("object 错误: %v", m["object"])
	}
	if m["model"] != "LDM" {
		t.Errorf("应使用网关侧的模型名，得到 %v", m["model"])
	}
	choice := m["choices"].([]any)[0].(map[string]any)
	if choice["finish_reason"] != "stop" {
		t.Errorf("finish_reason 应映射成 stop，得到 %v", choice["finish_reason"])
	}
	msg := choice["message"].(map[string]any)
	if msg["content"] != "你好" {
		t.Errorf("内容错误: %v", msg["content"])
	}
	if usage.PromptTokens != 10 || usage.CompletionTokens != 5 || usage.TotalTokens != 15 {
		t.Errorf("用量解析错误: %+v", usage)
	}
}

func TestAnthropicDecodeToolUse(t *testing.T) {
	raw := []byte(`{
		"id":"msg_2","stop_reason":"tool_use",
		"content":[{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{"city":"上海"}}],
		"usage":{"input_tokens":8,"output_tokens":12}
	}`)
	out, _, err := anthropicDecode(raw, "m")
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	choice := m["choices"].([]any)[0].(map[string]any)
	if choice["finish_reason"] != "tool_calls" {
		t.Errorf("tool_use 应映射成 tool_calls，得到 %v", choice["finish_reason"])
	}
	msg := choice["message"].(map[string]any)
	calls := msg["tool_calls"].([]any)
	if len(calls) != 1 {
		t.Fatalf("tool_calls 数量错误: %d", len(calls))
	}
	fn := calls[0].(map[string]any)["function"].(map[string]any)
	if fn["name"] != "get_weather" {
		t.Errorf("工具名错误: %v", fn["name"])
	}
	var args map[string]any
	if err := json.Unmarshal([]byte(fn["arguments"].(string)), &args); err != nil {
		t.Fatalf("arguments 应为合法 JSON: %v", err)
	}
	if args["city"] != "上海" {
		t.Errorf("参数错误: %v", args)
	}
}

// ---------- Anthropic 流式转换 ----------

func TestAnthropicStreamTranslation(t *testing.T) {
	st := newAnthropicStream("LDM")
	lines := []string{
		`data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":7,"output_tokens":0}}}`,
		`data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}`,
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"世界"}}`,
		`data: {"type":"content_block_stop","index":0}`,
		`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}`,
		`data: {"type":"message_stop"}`,
	}
	var out strings.Builder
	for _, l := range lines {
		out.Write(st.Translate([]byte(l)))
	}
	text := out.String()

	if !strings.Contains(text, `"content":"你好"`) {
		t.Errorf("缺少文本增量:\n%s", text)
	}
	if !strings.Contains(text, `"finish_reason":"stop"`) {
		t.Errorf("缺少 finish_reason:\n%s", text)
	}
	if !strings.Contains(text, "data: [DONE]") {
		t.Errorf("缺少结束标记:\n%s", text)
	}
	// 每一行都应是合法的 data: JSON
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line == "data: [DONE]" {
			continue
		}
		if !strings.HasPrefix(line, "data: ") {
			t.Errorf("非 SSE 行: %q", line)
			continue
		}
		var probe map[string]any
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &probe); err != nil {
			t.Errorf("非法 JSON: %v (%q)", err, line)
		}
	}
	u := st.Usage()
	if u.PromptTokens != 7 || u.CompletionTokens != 3 || u.TotalTokens != 10 {
		t.Errorf("流式用量错误: %+v", u)
	}
	if st.OutputChars() != 4 {
		t.Errorf("输出字符数应为 4，得到 %d", st.OutputChars())
	}
}

func TestAnthropicStreamToolUse(t *testing.T) {
	st := newAnthropicStream("m")
	lines := []string{
		`data: {"type":"message_start","message":{"id":"msg_2","usage":{"input_tokens":5}}}`,
		`data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_9","name":"search"}}`,
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"q\":"}}`,
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"猫\"}"}}`,
		`data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}`,
		`data: {"type":"message_stop"}`,
	}
	var out strings.Builder
	for _, l := range lines {
		out.Write(st.Translate([]byte(l)))
	}
	text := out.String()
	if !strings.Contains(text, `"name":"search"`) {
		t.Errorf("缺少工具名:\n%s", text)
	}
	if !strings.Contains(text, `"finish_reason":"tool_calls"`) {
		t.Errorf("缺少 tool_calls 结束原因:\n%s", text)
	}
}

// ---------- Gemini ----------

func TestGeminiUpstreamPath(t *testing.T) {
	p := Get(store.ChannelGemini)
	got := p.UpstreamPath("/v1/chat/completions", "gemini-2.0-flash", false)
	want := "/v1beta/models/gemini-2.0-flash:generateContent"
	if got != want {
		t.Errorf("非流式路径错误: %q", got)
	}
	got = p.UpstreamPath("/v1/chat/completions", "gemini-2.0-flash", true)
	want = "/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse"
	if got != want {
		t.Errorf("流式路径错误: %q", got)
	}
}

func TestGeminiBodyConversion(t *testing.T) {
	in := mustJSON(t, `{
		"model":"g","messages":[
			{"role":"system","content":"系统提示"},
			{"role":"user","content":"你好"},
			{"role":"assistant","content":"在","tool_calls":[{"id":"c1","function":{"name":"f","arguments":"{\"x\":1}"}}]}
		],
		"max_tokens":100,"temperature":0.5
	}`)
	out := geminiBody(in, "g", store.Caps{})

	sys := out["systemInstruction"].(map[string]any)["parts"].([]any)[0].(map[string]any)
	if sys["text"] != "系统提示" {
		t.Errorf("systemInstruction 错误: %v", sys)
	}
	contents := out["contents"].([]any)
	if len(contents) != 2 {
		t.Fatalf("contents 数量错误: %d", len(contents))
	}
	if contents[0].(map[string]any)["role"] != "user" {
		t.Errorf("第一条应是 user，得到 %v", contents[0].(map[string]any)["role"])
	}
	if contents[1].(map[string]any)["role"] != "model" {
		t.Errorf("assistant 应映射成 model，得到 %v", contents[1].(map[string]any)["role"])
	}
	gen := out["generationConfig"].(map[string]any)
	if num(t, gen["maxOutputTokens"]) != 100 {
		t.Errorf("maxOutputTokens 错误: %v", gen["maxOutputTokens"])
	}
	parts := contents[1].(map[string]any)["parts"].([]any)
	found := false
	for _, pv := range parts {
		if fc, ok := pv.(map[string]any)["functionCall"]; ok {
			found = true
			if fc.(map[string]any)["name"] != "f" {
				t.Errorf("functionCall 名称错误: %v", fc)
			}
		}
	}
	if !found {
		t.Error("assistant 的 tool_calls 应转换成 functionCall")
	}
}

func TestGeminiSchemaSanitization(t *testing.T) {
	in := mustJSON(t, `{
		"model":"g","messages":[{"role":"user","content":"hi"}],
		"tools":[{"type":"function","function":{"name":"f","parameters":{
			"type":"object","additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#",
			"properties":{"a":{"type":"string","description":"x"}}
		}}}]
	}`)
	out := geminiBody(in, "g", store.Caps{})
	decls := out["tools"].([]any)[0].(map[string]any)["functionDeclarations"].([]any)
	params := decls[0].(map[string]any)["parameters"].(map[string]any)
	if _, ok := params["additionalProperties"]; ok {
		t.Error("additionalProperties 应被剔除")
	}
	if _, ok := params["$schema"]; ok {
		t.Error("$schema 应被剔除")
	}
	if _, ok := params["properties"]; !ok {
		t.Error("properties 应保留")
	}
}

func TestGeminiDecode(t *testing.T) {
	raw := []byte(`{
		"candidates":[{"content":{"role":"model","parts":[{"text":"你好"}]},"finishReason":"STOP"}],
		"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":4,"totalTokenCount":13}
	}`)
	out, usage, err := geminiDecode(raw, "LDM")
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	msg := m["choices"].([]any)[0].(map[string]any)["message"].(map[string]any)
	if msg["content"] != "你好" {
		t.Errorf("内容错误: %v", msg["content"])
	}
	if usage.TotalTokens != 13 {
		t.Errorf("用量错误: %+v", usage)
	}
}

func TestGeminiStreamTranslation(t *testing.T) {
	st := &geminiStream{model: "LDM"}
	lines := []string{
		`data: {"candidates":[{"content":{"role":"model","parts":[{"text":"你"}]}}]}`,
		`data: {"candidates":[{"content":{"role":"model","parts":[{"text":"好"}]}}]}`,
		`data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}`,
	}
	var out strings.Builder
	for _, l := range lines {
		out.Write(st.Translate([]byte(l)))
	}
	out.Write(st.Finish())
	text := out.String()
	if !strings.Contains(text, `"content":"你"`) || !strings.Contains(text, `"content":"好"`) {
		t.Errorf("缺少文本增量:\n%s", text)
	}
	if !strings.Contains(text, "data: [DONE]") {
		t.Errorf("缺少结束标记:\n%s", text)
	}
	u := st.Usage()
	if u.TotalTokens != 5 {
		t.Errorf("流式用量错误: %+v", u)
	}
}

func TestOpenAIStreamPassthroughAndUsage(t *testing.T) {
	st := &openAIStream{}
	chunk := `data: {"id":"c","choices":[{"delta":{"content":"你好"},"finish_reason":null}]}`
	st.Translate([]byte(chunk))
	st.Translate([]byte(`data: {"id":"c","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}`))
	st.Translate([]byte(`data: [DONE]`))
	if st.Usage().TotalTokens != 6 {
		t.Errorf("用量解析错误: %+v", st.Usage())
	}
	if st.OutputChars() != 2 {
		t.Errorf("输出字符数应为 2，得到 %d", st.OutputChars())
	}
	if got := string(st.Translate([]byte(`data: [DONE]`))); got != "data: [DONE]\n\n" {
		t.Errorf("应原样透传结束标记，得到 %q", got)
	}
}

func TestErrorResponseNormalization(t *testing.T) {
	raw := []byte(`{"error":{"type":"invalid_request_error","message":"bad model"}}`)
	out, _, err := anthropicDecode(raw, "m")
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	e := m["error"].(map[string]any)
	if e["message"] != "bad model" {
		t.Errorf("错误信息应保留，得到 %v", e["message"])
	}
}
