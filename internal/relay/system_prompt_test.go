package relay

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"ldmapi/internal/store"
)

func TestApplySystemPromptReplacesMessages(t *testing.T) {
	req := &Request{
		Path: "/v1/chat/completions",
		JSON: map[string]any{
			"model":  "m",
			"system": "顶层旧提示词",
			"messages": []any{
				map[string]any{"role": "system", "content": "旧人格"},
				map[string]any{"role": "developer", "content": "旧开发者指令"},
				map[string]any{"role": "user", "content": "你好"},
				map[string]any{"role": "assistant", "content": "你好呀"},
			},
		},
	}

	applySystemPrompt(req, "  你是懒大猫  ")

	if _, ok := req.JSON["system"]; ok {
		t.Error("顶层 system 字段应被移除")
	}
	msgs, _ := req.JSON["messages"].([]any)
	if len(msgs) != 3 {
		t.Fatalf("应剩 3 条消息（新系统 + user + assistant），得到 %d: %v", len(msgs), msgs)
	}
	first, _ := msgs[0].(map[string]any)
	if first["role"] != "system" || first["content"] != "你是懒大猫" {
		t.Errorf("第一条应为配置的系统提示词，得到 %v", first)
	}
	for i, mv := range msgs[1:] {
		m, _ := mv.(map[string]any)
		if m["role"] == "system" || m["role"] == "developer" {
			t.Errorf("第 %d 条消息仍是系统消息: %v", i+1, m)
		}
	}
	// 请求体同步重建，保证直接透传请求体的渠道也能用上注入结果。
	if len(req.Body) == 0 {
		t.Error("请求体应同步重建")
	}
}

func TestApplySystemPromptResponses(t *testing.T) {
	req := &Request{
		Path: "/v1/responses",
		JSON: map[string]any{
			"model":        "m",
			"instructions": "旧指令",
			"input": []any{
				map[string]any{"role": "system", "content": "旧系统"},
				map[string]any{"role": "user", "content": "你好"},
			},
		},
	}

	applySystemPrompt(req, "新人格")

	if req.JSON["instructions"] != "新人格" {
		t.Errorf("instructions 应被替换，得到 %v", req.JSON["instructions"])
	}
	items, _ := req.JSON["input"].([]any)
	if len(items) != 1 {
		t.Fatalf("input 里的系统条目应被移除，剩下 %d 条", len(items))
	}
	if m, _ := items[0].(map[string]any); m["role"] != "user" {
		t.Errorf("剩余条目应为 user，得到 %v", m)
	}
}

func TestApplySystemPromptAnthropicNative(t *testing.T) {
	req := &Request{
		Path: "/v1/messages",
		JSON: map[string]any{
			"model":  "claude",
			"system": "旧系统提示词",
			"messages": []any{
				map[string]any{"role": "user", "content": "你好"},
			},
		},
	}

	applySystemPrompt(req, "新人格")

	if _, ok := req.JSON["system"]; ok {
		t.Error("Anthropic 顶层 system 应被移除")
	}
	msgs, _ := req.JSON["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("应保留注入的系统消息和原 user 消息，得到 %d", len(msgs))
	}
	if m, _ := msgs[0].(map[string]any); m["role"] != "system" || m["content"] != "新人格" {
		t.Errorf("系统提示词应放在最前面，得到 %v", m)
	}
}

func TestApplySystemPromptSkipsNonConversationBody(t *testing.T) {
	req := &Request{
		Path: "/v1/embeddings",
		JSON: map[string]any{"model": "m", "input": "hello"},
	}
	applySystemPrompt(req, "人格")
	if _, ok := req.JSON["messages"]; ok {
		t.Error("非对话请求不应被塞入 messages")
	}
	if _, ok := req.JSON["instructions"]; ok {
		t.Error("非对话请求不应被塞入 instructions")
	}
}

// 端到端：OpenAI 渠道收到的请求里，旧系统提示词被删掉，只保留配置内容。
func TestSystemPromptInjectionOpenAIUpstream(t *testing.T) {
	var received map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &received)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"ok"}}],`+
			`"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	defer srv.Close()

	st := newTestStore(t)
	now := time.Now().UnixMilli()
	if err := st.SaveChannel(store.Channel{
		ID: "A", Type: store.ChannelOpenAI, BaseURL: srv.URL, APIKey: "k",
		Models: []string{"a"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "A/a", Type: store.ModelTypeChannel, ChannelID: "A", Upstream: "a",
		Enabled: true, CreatedAt: now, UpdatedAt: now,
		SystemPromptOn: boolp(true), SystemPrompt: "你是懒大猫",
	}); err != nil {
		t.Fatal(err)
	}

	payload := `{"model":"A/a","messages":[` +
		`{"role":"system","content":"旧人格"},` +
		`{"role":"developer","content":"旧开发者指令"},` +
		`{"role":"user","content":"你好"}]}`
	req := &Request{Path: "/v1/chat/completions", Method: http.MethodPost, Header: http.Header{}, Body: []byte(payload)}
	if err := json.Unmarshal([]byte(payload), &req.JSON); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, req)
	if rec.Code != http.StatusOK || res.Err != "" {
		t.Fatalf("请求失败 %d: %s / %s", rec.Code, rec.Body.String(), res.Err)
	}
	msgs, _ := received["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("上游应收到 2 条消息（系统 + user），得到 %d: %v", len(msgs), msgs)
	}
	first, _ := msgs[0].(map[string]any)
	if first["role"] != "system" || first["content"] != "你是懒大猫" {
		t.Errorf("上游收到的系统提示词错误: %v", first)
	}
	last, _ := msgs[1].(map[string]any)
	if last["role"] != "user" || last["content"] != "你好" {
		t.Errorf("用户消息应原样保留: %v", last)
	}
}

// 端到端：Anthropic 渠道把注入内容转换成顶层 system，旧系统消息不再出现。
func TestSystemPromptInjectionAnthropicUpstream(t *testing.T) {
	var received map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &received)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"content":[{"type":"text","text":"ok"}],`+
			`"usage":{"input_tokens":1,"output_tokens":1}}`)
	}))
	defer srv.Close()

	st := newTestStore(t)
	now := time.Now().UnixMilli()
	if err := st.SaveChannel(store.Channel{
		ID: "C", Type: store.ChannelAnthropic, BaseURL: srv.URL, APIKey: "k",
		Models: []string{"c"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "C/c", Type: store.ModelTypeChannel, ChannelID: "C", Upstream: "c",
		Enabled: true, CreatedAt: now, UpdatedAt: now,
		SystemPromptOn: boolp(true), SystemPrompt: "你是懒大猫",
	}); err != nil {
		t.Fatal(err)
	}

	payload := `{"model":"C/c","messages":[` +
		`{"role":"system","content":"旧人格"},` +
		`{"role":"user","content":"你好"}]}`
	req := &Request{Path: "/v1/chat/completions", Method: http.MethodPost, Header: http.Header{}, Body: []byte(payload)}
	if err := json.Unmarshal([]byte(payload), &req.JSON); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, req)
	if rec.Code != http.StatusOK || res.Err != "" {
		t.Fatalf("请求失败 %d: %s / %s", rec.Code, rec.Body.String(), res.Err)
	}
	if received["system"] != "你是懒大猫" {
		t.Errorf("Anthropic 顶层 system 应为配置内容，得到 %v", received["system"])
	}
	msgs, _ := received["messages"].([]any)
	if len(msgs) != 1 {
		t.Fatalf("上游 messages 应只剩用户消息，得到 %d: %v", len(msgs), msgs)
	}
	if m, _ := msgs[0].(map[string]any); m["role"] != "user" {
		t.Errorf("剩余消息应为 user，得到 %v", m)
	}
}

// 关闭开关时保持调用方原始的系统提示词。
func TestSystemPromptInjectionDisabled(t *testing.T) {
	var received map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &received)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`)
	}))
	defer srv.Close()

	st := newTestStore(t)
	now := time.Now().UnixMilli()
	if err := st.SaveChannel(store.Channel{
		ID: "A", Type: store.ChannelOpenAI, BaseURL: srv.URL, APIKey: "k",
		Models: []string{"a"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "A/a", Type: store.ModelTypeChannel, ChannelID: "A", Upstream: "a",
		Enabled: true, CreatedAt: now, UpdatedAt: now,
		SystemPromptOn: boolp(false), SystemPrompt: "不生效",
	}); err != nil {
		t.Fatal(err)
	}

	payload := `{"model":"A/a","messages":[{"role":"system","content":"调用方人格"},{"role":"user","content":"你好"}]}`
	req := &Request{Path: "/v1/chat/completions", Method: http.MethodPost, Header: http.Header{}, Body: []byte(payload)}
	if err := json.Unmarshal([]byte(payload), &req.JSON); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	New(st).Do(context.Background(), rec, req)

	msgs, _ := received["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("关闭注入后应保留 2 条消息，得到 %d", len(msgs))
	}
	if m, _ := msgs[0].(map[string]any); m["content"] != "调用方人格" {
		t.Errorf("调用方系统提示词不应被改写: %v", m)
	}
}
