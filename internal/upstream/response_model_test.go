package upstream

import (
	"testing"

	"ldmapi/internal/store"
)

// 非流式响应里各家回显模型名的字段不同，取不到时不能影响其它字段。
func TestResponseModelFromBody(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"openai", `{"model":"gpt-4o-2024-08-06","choices":[]}`, "gpt-4o-2024-08-06"},
		{"openai responses", `{"object":"response","model":"o3-mini-2025-01-31"}`, "o3-mini-2025-01-31"},
		{"responses wrapped", `{"response":{"model":"o4-mini"}}`, "o4-mini"},
		{"anthropic", `{"id":"msg_1","model":"claude-3-5-sonnet-20241022"}`, "claude-3-5-sonnet-20241022"},
		{"gemini", `{"modelVersion":"gemini-2.5-flash-001","candidates":[]}`, "gemini-2.5-flash-001"},
		{"no model", `{"choices":[]}`, ""},
		{"null model", `{"model":null}`, ""},
		{"invalid json", `not json`, ""},
		{"empty", ``, ""},
	}
	for _, c := range cases {
		if got := ResponseModel([]byte(c.body)); got != c.want {
			t.Errorf("%s: 响应模型应为 %q，得到 %q", c.name, c.want, got)
		}
	}
}

// 流式翻译器要能从各家的事件里抓到上游回显的模型名。
func TestStreamReportsUpstreamModel(t *testing.T) {
	openai := Get(store.ChannelOpenAI).NewStream("asked")
	openai.Translate([]byte(`data: {"model":"asked-2025","choices":[{"delta":{"content":"hi"}}]}`))
	if got := openai.Model(); got != "asked-2025" {
		t.Errorf("OpenAI 流式响应模型应为 asked-2025，得到 %q", got)
	}

	anthropic := Get(store.ChannelAnthropic).NewStream("asked")
	anthropic.Translate([]byte(`data: {"type":"message_start","message":{"id":"m","model":"claude-x-20250101","usage":{"input_tokens":1}}}`))
	if got := anthropic.Model(); got != "claude-x-20250101" {
		t.Errorf("Anthropic 流式响应模型应为 claude-x-20250101，得到 %q", got)
	}

	gemini := Get(store.ChannelGemini).NewStream("asked")
	gemini.Translate([]byte(`data: {"modelVersion":"gemini-x-001","candidates":[{"content":{"parts":[{"text":"hi"}]}}]}`))
	if got := gemini.Model(); got != "gemini-x-001" {
		t.Errorf("Gemini 流式响应模型应为 gemini-x-001，得到 %q", got)
	}
}

// 上游没回显模型时返回空字符串，日志按「一致」处理，不额外标标记。
func TestStreamWithoutModelReportsEmpty(t *testing.T) {
	s := Get(store.ChannelOpenAI).NewStream("asked")
	s.Translate([]byte(`data: {"choices":[{"delta":{"content":"hi"}}]}`))
	if got := s.Model(); got != "" {
		t.Errorf("上游没回显模型时应为空，得到 %q", got)
	}
}
