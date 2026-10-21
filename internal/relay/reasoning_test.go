package relay

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ldmapi/internal/store"
)

// setupReasoningTestModel 建一个指向测试上游的渠道模型，按需开启思考覆写。
func setupReasoningTestModel(t *testing.T, baseURL, override string, on bool) *store.Store {
	t.Helper()
	ClearAllCooldowns()
	t.Cleanup(func() { ClearAllCooldowns() })
	st := newTestStore(t)
	statusTestChannel(t, st, "ov", baseURL, []string{"key-000001"}, []string{"m"})
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "ov-m", Type: store.ModelTypeChannel, ChannelID: "ov", Upstream: "m",
		ThinkingOverrideOn: boolp(on), ThinkingOverrideText: override,
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	return st
}

func streamServer(t *testing.T, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

const reasoningSSE = `data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"秘密思考"},"finish_reason":null}]}

data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"第二段思考"},"finish_reason":null}]}

data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}

data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]

`

// 覆写开启且填写文本时，客户端只会看到一份配置的思考内容。
func TestThinkingOverrideStreaming(t *testing.T) {
	srv := streamServer(t, reasoningSSE)
	st := setupReasoningTestModel(t, srv.URL, "正在思考···", true)

	req := statusTestRequest("ov-m")
	req.Stream = true
	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, req)

	body := rec.Body.String()
	if strings.Contains(body, "秘密思考") || strings.Contains(body, "第二段思考") {
		t.Fatalf("上游思考内容不应透传: %s", body)
	}
	if got := strings.Count(body, `"reasoning_content":"正在思考···"`); got != 1 {
		t.Errorf("覆写文本应只输出一次，得到 %d 次: %s", got, body)
	}
	if !strings.Contains(body, `"content":"你好"`) {
		t.Errorf("正文应正常输出: %s", body)
	}
	if res.ReasoningChars != len([]rune("正在思考···")) {
		t.Errorf("日志应记录覆写后的思考字符数，得到 %d", res.ReasoningChars)
	}
}

// 覆写开启但文本留空时，思考内容被完全隐藏。
func TestThinkingOverrideStreamingHide(t *testing.T) {
	srv := streamServer(t, reasoningSSE)
	st := setupReasoningTestModel(t, srv.URL, "", true)

	req := statusTestRequest("ov-m")
	req.Stream = true
	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, req)

	body := rec.Body.String()
	if strings.Contains(body, "秘密思考") || strings.Contains(body, "第二段思考") || strings.Contains(body, "reasoning_content") {
		t.Fatalf("思考内容应被隐藏: %s", body)
	}
	if !strings.Contains(body, `"content":"你好"`) {
		t.Errorf("正文应正常输出: %s", body)
	}
	if res.ReasoningChars != 0 {
		t.Errorf("隐藏后思考字符数应为 0，得到 %d", res.ReasoningChars)
	}
}

// 模型没有输出思考时，不额外注入覆写文本。
func TestThinkingOverrideNoReasoningNoInjection(t *testing.T) {
	const plainSSE = `data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}

data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]

`
	srv := streamServer(t, plainSSE)
	st := setupReasoningTestModel(t, srv.URL, "正在思考···", true)

	req := statusTestRequest("ov-m")
	req.Stream = true
	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, req)

	body := rec.Body.String()
	if strings.Contains(body, "正在思考") || strings.Contains(body, "reasoning_content") {
		t.Fatalf("没有思考输出时不应注入覆写文本: %s", body)
	}
	if res.ReasoningChars != 0 {
		t.Errorf("没有思考输出时字符数应为 0，得到 %d", res.ReasoningChars)
	}
}

// 非流式响应同样支持替换与隐藏。
func TestThinkingOverrideNonStreaming(t *testing.T) {
	const upstreamJSON = `{"id":"x","object":"chat.completion","model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"你好","reasoning_content":"秘密思考"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, upstreamJSON)
	}))
	defer srv.Close()

	for _, tc := range []struct {
		name      string
		override  string
		wantThing string
		hidden    bool
	}{
		{name: "替换", override: "正在思考···", wantThing: "正在思考···"},
		{name: "隐藏", override: "", hidden: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st := setupReasoningTestModel(t, srv.URL, tc.override, true)
			rec := httptest.NewRecorder()
			res := New(st).Do(context.Background(), rec, statusTestRequest("ov-m"))

			var body struct {
				Choices []struct {
					Message struct {
						Content          string `json:"content"`
						ReasoningContent string `json:"reasoning_content"`
					} `json:"message"`
				} `json:"choices"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("响应不是合法 JSON: %v: %s", err, rec.Body.String())
			}
			if len(body.Choices) != 1 || body.Choices[0].Message.Content != "你好" {
				t.Fatalf("正文应正常返回: %+v", body.Choices)
			}
			got := body.Choices[0].Message.ReasoningContent
			if tc.hidden {
				if got != "" || strings.Contains(rec.Body.String(), "reasoning_content") {
					t.Errorf("思考内容应被隐藏: %s", rec.Body.String())
				}
				if res.ReasoningChars != 0 {
					t.Errorf("隐藏后思考字符数应为 0，得到 %d", res.ReasoningChars)
				}
			} else {
				if got != tc.wantThing {
					t.Errorf("思考内容应被替换为 %q，得到 %q", tc.wantThing, got)
				}
				if strings.Contains(rec.Body.String(), "秘密思考") {
					t.Errorf("上游思考内容不应透传: %s", rec.Body.String())
				}
				if res.ReasoningChars != len([]rune(tc.wantThing)) {
					t.Errorf("日志应记录覆写后的思考字符数，得到 %d", res.ReasoningChars)
				}
			}
		})
	}
}

// 自定义内容返回优先级最高：同时开启思考覆写时仍按内容配置返回。
func TestThinkingOverrideIgnoredByCustomContent(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"choices":[{"message":{"content":"上游"}}]}`)
	}))
	defer srv.Close()

	st := newTestStore(t)
	now := time.Now().UnixMilli()
	on := true
	if err := st.SaveModel(store.Model{
		ID: "fixed", Type: store.ModelTypeCustom,
		ContentEnabled: &on, ContentText: "固定正文", ContentReasoning: "固定思考",
		ThinkingOverrideOn: &on, ThinkingOverrideText: "覆写思考",
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	// 即使配了路由，内容返回也不会请求上游。
	if err := st.SaveChannel(store.Channel{
		ID: "c", Name: "c", Type: store.ChannelOpenAI, BaseURL: srv.URL,
		Models: []string{"m"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	m, _ := st.GetModel("fixed")
	m.Routes = []store.Route{{ChannelID: "c", Upstream: "m"}}
	if err := st.SaveModel(m); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	New(st).Do(context.Background(), rec, statusTestRequest("fixed"))
	body := rec.Body.String()
	if !strings.Contains(body, "固定正文") || !strings.Contains(body, "固定思考") {
		t.Errorf("应按自定义内容返回: %s", body)
	}
	if strings.Contains(body, "覆写思考") {
		t.Errorf("自定义内容返回开启时思考覆写不应生效: %s", body)
	}
	if hits.Load() != 0 {
		t.Errorf("不应请求上游，实际 %d 次", hits.Load())
	}
}

// n > 1 时每个候选都应只得到一次覆写文本。
func TestReasoningOverrideStreamMultiChoice(t *testing.T) {
	s := &reasoningOverrideStream{text: "正在思考···", injected: map[int]bool{}}
	in := `data: {"choices":[{"index":0,"delta":{"reasoning_content":"甲"}}]}` + "\n\n" +
		`data: {"choices":[{"index":1,"delta":{"reasoning_content":"乙"}}]}` + "\n\n" +
		`data: {"choices":[{"index":0,"delta":{"reasoning_content":"丙"}}]}` + "\n\n"
	out := string(s.rewriteSSE([]byte(in)))
	if strings.Contains(out, "甲") || strings.Contains(out, "乙") || strings.Contains(out, "丙") {
		t.Fatalf("上游思考内容不应透传: %s", out)
	}
	if got := strings.Count(out, "正在思考···"); got != 2 {
		t.Errorf("每个候选应各输出一次覆写文本，得到 %d 次: %s", got, out)
	}
}

// Responses API 的思考条目与流式增量同样会被改写。
func TestRewriteReasoningResponses(t *testing.T) {
	s := &reasoningOverrideStream{text: "正在思考···", injected: map[int]bool{}}
	var in strings.Builder
	in.WriteString(`data: {"type":"response.output_item.added","item":{"type":"reasoning","summary":[{"type":"summary_text","text":"秘密开头"}]}}` + "\n\n")
	in.WriteString(`data: {"type":"response.reasoning_summary_text.delta","delta":"秘密"}` + "\n\n")
	in.WriteString(`data: {"type":"response.reasoning_summary_text.delta","delta":"更多"}` + "\n\n")
	in.WriteString(`data: {"type":"response.reasoning_summary_text.done","text":"完整秘密"}` + "\n\n")
	in.WriteString(`data: {"type":"response.completed","response":{"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"完整秘密"}]},{"type":"message","content":[]}]}}` + "\n\n")

	out := string(s.rewriteSSE([]byte(in.String())))
	if strings.Contains(out, "秘密") || strings.Contains(out, "更多") {
		t.Fatalf("Responses 思考内容不应透传: %s", out)
	}
	if got := strings.Count(out, "正在思考···"); got != 3 {
		// 思考增量、增量结束和最终条目各一次
		t.Errorf("覆写文本应出现在思考增量与最终响应中，得到 %d 次: %s", got, out)
	}
	if s.outChars != len([]rune("正在思考···")) {
		t.Errorf("字符数只统计发给客户端的思考增量，得到 %d", s.outChars)
	}

	raw := []byte(`{"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"秘密"}],"content":[{"type":"reasoning_text","text":"秘密2"}]},{"type":"message","content":[]}]}`)
	hidden := rewriteReasoningJSON(raw, "")
	if strings.Contains(string(hidden), "秘密") {
		t.Errorf("非流式 Responses 思考内容应被隐藏: %s", hidden)
	}
	replaced := rewriteReasoningJSON(raw, "正在思考···")
	if !strings.Contains(string(replaced), `"text":"正在思考···"`) {
		t.Errorf("非流式 Responses 思考内容应被替换: %s", replaced)
	}
}
