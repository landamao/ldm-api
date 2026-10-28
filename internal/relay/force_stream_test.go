package relay

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"ldmapi/internal/store"
)

// seedForceStreamModel 建一个开启「强制流式」的渠道模型。
func seedForceStreamModel(t *testing.T, st *store.Store, channelID, baseURL string, timeout int) {
	t.Helper()
	now := time.Now().UnixMilli()
	if err := st.SaveChannel(store.Channel{
		ID: channelID, Name: channelID, Type: store.ChannelOpenAI,
		BaseURL: baseURL, Models: []string{"m"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "m", Type: store.ModelTypeCustom, Timeout: timeout, ForceStream: boolp(true),
		Routes:  []store.Route{{ChannelID: channelID, Upstream: "m"}},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
}

// 非流式调用 + 强制流式：上游收到 stream=true，网关把整条流收完再按非流式返回。
func TestForceStreamCollectsNonStreamResponse(t *testing.T) {
	st := newTestStore(t)

	var mu sync.Mutex
	var sawStream any
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var in map[string]any
		_ = json.Unmarshal(raw, &in)
		mu.Lock()
		sawStream = in["stream"]
		mu.Unlock()

		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		send := func(s string) {
			io.WriteString(w, "data: "+s+"\n\n")
		}
		send(`{"id":"chatcmpl-up","model":"upstream-m","created":1700000000,"choices":[{"index":0,"delta":{"role":"assistant"}}]}`)
		send(`{"choices":[{"index":0,"delta":{"reasoning_content":"想一想"}}]}`)
		send(`{"choices":[{"index":0,"delta":{"content":"你"}}]}`)
		send(`{"choices":[{"index":0,"delta":{"content":"好"}}]}`)
		send(`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}`)
		send(`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\""}}]}}]}`)
		send(`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\"北京\"}"}}]}}]}`)
		send(`{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":7,"completion_tokens":9,"total_tokens":16}}`)
		io.WriteString(w, "data: [DONE]\n\n")
		w.(http.Flusher).Flush()
	}))
	defer up.Close()

	seedForceStreamModel(t, st, "fs", up.URL, 5)

	req := &Request{
		Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{}, Body: []byte(`{"model":"m","messages":[{"role":"user","content":"hi"}]}`),
		JSON: map[string]any{"model": "m", "messages": []any{map[string]any{"role": "user", "content": "hi"}}},
	}
	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, req)

	mu.Lock()
	gotStream := sawStream
	mu.Unlock()
	if gotStream != true {
		t.Fatalf("强制流式时上游请求体的 stream 应为 true，实际 %v", gotStream)
	}
	if res.Err != "" {
		t.Fatalf("不应失败: %+v", res)
	}
	if res.Stream {
		t.Fatalf("调用方要非流式，日志不应记成流式: %+v", res)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Fatalf("非流式响应应为 JSON，实际 %q", ct)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码应为 200，实际 %d: %s", rec.Code, rec.Body.String())
	}

	var out struct {
		Object string `json:"object"`
		Model  string `json:"model"`
		Choice []struct {
			Message struct {
				Content          *string `json:"content"`
				ReasoningContent string  `json:"reasoning_content"`
				ToolCalls        []struct {
					ID       string `json:"id"`
					Type     string `json:"type"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
			TotalTokens      int `json:"total_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("响应不是合法 JSON: %v\n%s", err, rec.Body.String())
	}
	if out.Object != "chat.completion" {
		t.Fatalf("响应结构应为 chat.completion，实际 %q", out.Object)
	}
	if len(out.Choice) != 1 {
		t.Fatalf("choices 数量错误: %s", rec.Body.String())
	}
	msg := out.Choice[0].Message
	// 正文与工具调用同时存在时都要保留。
	if msg.Content == nil || *msg.Content != "你好" {
		t.Fatalf("正文未聚合: %v", msg.Content)
	}
	if msg.ReasoningContent != "想一想" {
		t.Fatalf("思考内容未聚合: %q", msg.ReasoningContent)
	}
	if len(msg.ToolCalls) != 1 || msg.ToolCalls[0].Function.Name != "get_weather" {
		t.Fatalf("工具调用未聚合: %+v", msg.ToolCalls)
	}
	if got := msg.ToolCalls[0].Function.Arguments; got != `{"city":"北京"}` {
		t.Fatalf("工具参数应按增量拼接，实际 %q", got)
	}
	if out.Choice[0].FinishReason != "tool_calls" {
		t.Fatalf("finish_reason 应透传上游，实际 %q", out.Choice[0].FinishReason)
	}
	if out.Usage.TotalTokens != 16 || out.Usage.PromptTokens != 7 {
		t.Fatalf("用量应取上游上报值，实际 %+v", out.Usage)
	}
	if res.Usage.TotalTokens != 16 {
		t.Fatalf("日志用量应取上游上报值: %+v", res.Usage)
	}
	if res.FirstByteMs <= 0 {
		t.Fatalf("强制流式应记录首字耗时: %+v", res)
	}
}

// 只有正文时按普通 chat.completion 返回，正文完整拼接。
func TestForceStreamCollectsPlainText(t *testing.T) {
	st := newTestStore(t)

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你\"}}]}\n\n")
		io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"好\"},\"finish_reason\":\"stop\"}]}\n\n")
		io.WriteString(w, "data: [DONE]\n\n")
		w.(http.Flusher).Flush()
	}))
	defer up.Close()

	seedForceStreamModel(t, st, "fs-text", up.URL, 5)

	req := &Request{
		Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{}, Body: []byte(`{"model":"m","messages":[]}`),
		JSON: map[string]any{"model": "m"},
	}
	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, req)
	if res.Err != "" {
		t.Fatalf("不应失败: %+v", res)
	}
	if !strings.Contains(rec.Body.String(), `"content":"你好"`) {
		t.Fatalf("正文未正确聚合: %s", rec.Body.String())
	}
	// 上游没给用量，网关按输出长度估算，并标记为估算值。
	if !res.UsageEstimate {
		t.Fatalf("上游未给用量时应标记估算: %+v", res)
	}
	if res.Usage.CompletionTokens <= 0 {
		t.Fatalf("应按输出内容估算补全 token: %+v", res.Usage)
	}
}

// 首字超时：慢路由在超时时间内没吐字就失败，请求自动落到下一条路由。
func TestForceStreamFirstByteTimeoutSwitchesRoute(t *testing.T) {
	st := newTestStore(t)
	now := time.Now().UnixMilli()

	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		select {
		case <-time.After(3 * time.Second):
		case <-r.Context().Done():
			return
		}
		io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"too late\"},\"finish_reason\":\"stop\"}]}\n\n")
		w.(http.Flusher).Flush()
	}))
	defer slow.Close()

	fast := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n")
		io.WriteString(w, "data: [DONE]\n\n")
		w.(http.Flusher).Flush()
	}))
	defer fast.Close()

	for _, c := range []struct {
		id  string
		url string
	}{{"slow", slow.URL}, {"fast", fast.URL}} {
		if err := st.SaveChannel(store.Channel{
			ID: c.id, Name: c.id, Type: store.ChannelOpenAI, BaseURL: c.url,
			Models: []string{"m"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.SaveModel(store.Model{
		ID: "m", Type: store.ModelTypeCustom, Timeout: 1, ForceStream: boolp(true),
		Routes: []store.Route{
			{ChannelID: "slow", Upstream: "m"},
			{ChannelID: "fast", Upstream: "m"},
		},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ClearCooldownsForModel(store.Model{ID: "m"}) })

	req := &Request{
		Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{}, Body: []byte(`{"model":"m","messages":[]}`),
		JSON: map[string]any{"model": "m"},
	}
	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, req)

	if res.Err != "" {
		t.Fatalf("第二条路由应成功: %+v", res)
	}
	if res.ChannelID != "fast" {
		t.Fatalf("应落到 fast 渠道，实际 %q", res.ChannelID)
	}
	if !strings.Contains(rec.Body.String(), `"content":"ok"`) {
		t.Fatalf("应返回第二条路由的内容: %s", rec.Body.String())
	}
	if len(res.Attempts) != 2 {
		t.Fatalf("应记录两次尝试: %+v", res.Attempts)
	}
	if !strings.Contains(res.Attempts[0].Error, "超时") {
		t.Fatalf("首次尝试应记为首字超时: %+v", res.Attempts[0])
	}
}

// 上游忽略 stream、直接回完整 JSON 时按普通非流式透传，不做聚合。
func TestForceStreamFallsBackToJSONUpstream(t *testing.T) {
	st := newTestStore(t)

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"raw","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"直出"}}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}`)
	}))
	defer up.Close()

	seedForceStreamModel(t, st, "fs-json", up.URL, 5)

	req := &Request{
		Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{}, Body: []byte(`{"model":"m","messages":[]}`),
		JSON: map[string]any{"model": "m"},
	}
	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, req)
	if res.Err != "" {
		t.Fatalf("不应失败: %+v", res)
	}
	if !strings.Contains(rec.Body.String(), `"id":"raw"`) {
		t.Fatalf("上游 JSON 应原样透传: %s", rec.Body.String())
	}
}

// 调用方本来就要流式时行为不变：仍按 SSE 逐块转发。
func TestForceStreamKeepsClientStream(t *testing.T) {
	st := newTestStore(t)

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你\"}}]}\n\n")
		io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"好\"},\"finish_reason\":\"stop\"}]}\n\n")
		io.WriteString(w, "data: [DONE]\n\n")
		w.(http.Flusher).Flush()
	}))
	defer up.Close()

	seedForceStreamModel(t, st, "fs-stream", up.URL, 5)

	req := &Request{
		Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{}, Body: []byte(`{"model":"m","stream":true,"messages":[]}`),
		Stream: true, JSON: map[string]any{"model": "m", "stream": true},
	}
	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, req)
	if res.Err != "" {
		t.Fatalf("不应失败: %+v", res)
	}
	if !res.Stream {
		t.Fatalf("调用方要流式时应按流式记账: %+v", res)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Fatalf("流式响应应为 SSE，实际 %q", ct)
	}
	if !strings.Contains(rec.Body.String(), "data: [DONE]") {
		t.Fatalf("应逐块转发并带上结束标记: %s", rec.Body.String())
	}
}

// Anthropic 渠道同样支持：请求体打开 stream，按 Anthropic 事件流收完后
// 再翻译成 OpenAI 结构的非流式响应。
func TestForceStreamAnthropicChannel(t *testing.T) {
	st := newTestStore(t)
	now := time.Now().UnixMilli()

	var sawStream any
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var in map[string]any
		_ = json.Unmarshal(raw, &in)
		sawStream = in["stream"]
		if r.URL.Path != "/v1/messages" {
			t.Errorf("Anthropic 渠道应转发到 /v1/messages，实际 %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		send := func(ev, s string) {
			io.WriteString(w, "event: "+ev+"\ndata: "+s+"\n\n")
		}
		send("message_start", `{"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":5}}}`)
		send("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`)
		send("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}`)
		send("message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}`)
		send("message_stop", `{"type":"message_stop"}`)
		w.(http.Flusher).Flush()
	}))
	defer up.Close()

	if err := st.SaveChannel(store.Channel{
		ID: "ant", Name: "ant", Type: store.ChannelAnthropic, BaseURL: up.URL,
		Models: []string{"claude"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "cm", Type: store.ModelTypeCustom, Timeout: 5, ForceStream: boolp(true),
		Routes:  []store.Route{{ChannelID: "ant", Upstream: "claude"}},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	req := &Request{
		Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{}, Body: []byte(`{"model":"cm","messages":[{"role":"user","content":"hi"}]}`),
		JSON: map[string]any{"model": "cm", "messages": []any{map[string]any{"role": "user", "content": "hi"}}},
	}
	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, req)
	if res.Err != "" {
		t.Fatalf("不应失败: %+v", res)
	}
	if sawStream != true {
		t.Fatalf("上游请求体的 stream 应为 true，实际 %v", sawStream)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"content":"你好"`) || !strings.Contains(body, `"object":"chat.completion"`) {
		t.Fatalf("应按 OpenAI 结构返回聚合内容: %s", body)
	}
	if res.Usage.PromptTokens != 5 || res.Usage.CompletionTokens != 3 {
		t.Fatalf("用量应来自 Anthropic 上报: %+v", res.Usage)
	}
}

// 思考覆写与强制流式叠加时，聚合出的思考内容也应是覆写后的文本。
func TestForceStreamWithThinkingOverride(t *testing.T) {
	st := newTestStore(t)
	now := time.Now().UnixMilli()

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"真实思考\"}}]}\n\n")
		io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"继续想\"}}]}\n\n")
		io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"答\"},\"finish_reason\":\"stop\"}]}\n\n")
		io.WriteString(w, "data: [DONE]\n\n")
		w.(http.Flusher).Flush()
	}))
	defer up.Close()

	if err := st.SaveChannel(store.Channel{
		ID: "ov", Name: "ov", Type: store.ChannelOpenAI, BaseURL: up.URL,
		Models: []string{"m"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "m", Type: store.ModelTypeCustom, Timeout: 5, ForceStream: boolp(true),
		ThinkingOverrideOn: boolp(true), ThinkingOverrideText: "正在思考",
		Routes:  []store.Route{{ChannelID: "ov", Upstream: "m"}},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	req := &Request{
		Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{}, Body: []byte(`{"model":"m","messages":[]}`),
		JSON: map[string]any{"model": "m"},
	}
	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, req)
	if res.Err != "" {
		t.Fatalf("不应失败: %+v", res)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"reasoning_content":"正在思考"`) {
		t.Fatalf("思考内容应被覆写: %s", body)
	}
	if strings.Contains(body, "真实思考") || strings.Contains(body, "继续想") {
		t.Fatalf("上游真实思考不应透出: %s", body)
	}
	if res.ReasoningChars != len([]rune("正在思考")) {
		t.Fatalf("日志里的思考字符数应按覆写后统计: %+v", res)
	}
}
