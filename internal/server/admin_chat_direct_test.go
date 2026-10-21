package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestChatDirectURL(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"https://api.openai.com", "https://api.openai.com/v1/chat/completions"},
		{"https://api.openai.com/", "https://api.openai.com/v1/chat/completions"},
		{"https://api.openai.com/v1", "https://api.openai.com/v1/chat/completions"},
		{"https://api.openai.com/v1/", "https://api.openai.com/v1/chat/completions"},
		{"https://ark.example.com/api/v3", "https://ark.example.com/api/v3/chat/completions"},
		{"https://example.com/api/paas/v4", "https://example.com/api/paas/v4/chat/completions"},
		{"https://example.com/v1beta", "https://example.com/v1beta/chat/completions"},
		{"https://example.com/v1/chat/completions", "https://example.com/v1/chat/completions"},
		{"https://example.com/proxy/v1/chat/completions?api-version=1", "https://example.com/proxy/v1/chat/completions?api-version=1"},
		{"api.openai.com", "https://api.openai.com/v1/chat/completions"},
	}
	for _, c := range cases {
		got, err := chatDirectURL(c.in)
		if err != nil {
			t.Fatalf("chatDirectURL(%q) 返回错误: %v", c.in, err)
		}
		if got != c.want {
			t.Errorf("chatDirectURL(%q) = %q, 期望 %q", c.in, got, c.want)
		}
	}

	for _, bad := range []string{"", "ftp://api.example.com", "https://", "::"} {
		if _, err := chatDirectURL(bad); err == nil {
			t.Errorf("chatDirectURL(%q) 应该报错", bad)
		}
	}
}

func callDirectChat(t *testing.T, s *Server, payload map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	raw, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/api/chat", strings.NewReader(string(raw)))
	rec := httptest.NewRecorder()
	s.chat(rec, req)
	return rec
}

// 临时测试不应该依赖已配置的渠道/模型，也不应该写任何调用日志。
func TestChatDirectSkipsRoutingAndLogs(t *testing.T) {
	var gotAuth, gotModel string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("上游路径 = %q", r.URL.Path)
		}
		gotAuth = r.Header.Get("Authorization")
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotModel, _ = body["model"].(string)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"pong"}}],"usage":{"total_tokens":3}}`)
	}))
	defer srv.Close()

	s, st := newTestServer(t, "chat-direct")
	rec := callDirectChat(t, s, map[string]any{
		"base_url": srv.URL,
		"api_key":  "sk-temp",
		"model":    "any-model",
		"messages": []any{map[string]any{"role": "user", "content": "ping"}},
	})

	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 %d: %s", rec.Code, rec.Body.String())
	}
	if gotAuth != "Bearer sk-temp" {
		t.Errorf("Authorization = %q", gotAuth)
	}
	if gotModel != "any-model" {
		t.Errorf("上游收到的模型 = %q", gotModel)
	}
	if !strings.Contains(rec.Body.String(), `"content":"pong"`) {
		t.Errorf("响应体没有透传上游内容: %s", rec.Body.String())
	}
	if n, _ := st.CountLogs(); n != 0 {
		t.Errorf("临时测试不应写日志，实际写了 %d 条", n)
	}
}

func TestChatDirectForwardsStream(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fl, _ := w.(http.Flusher)
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n\n")
		if fl != nil {
			fl.Flush()
		}
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
		if fl != nil {
			fl.Flush()
		}
	}))
	defer srv.Close()

	s, st := newTestServer(t, "chat-direct-stream")
	rec := callDirectChat(t, s, map[string]any{
		"base_url": srv.URL,
		"model":    "m",
		"stream":   true,
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	})

	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 %d: %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Errorf("Content-Type = %q", ct)
	}
	if !strings.Contains(rec.Body.String(), "data: [DONE]") {
		t.Errorf("流式内容没有透传: %s", rec.Body.String())
	}
	if n, _ := st.CountLogs(); n != 0 {
		t.Errorf("临时测试不应写日志，实际写了 %d 条", n)
	}
}

// 上游报错时保持状态码和原始错误体，方便在在线聊天里直接看到上游原因。
func TestChatDirectForwardsUpstreamError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":{"message":"invalid api key"}}`)
	}))
	defer srv.Close()

	s, st := newTestServer(t, "chat-direct-err")
	rec := callDirectChat(t, s, map[string]any{
		"base_url": srv.URL,
		"api_key":  "bad",
		"model":    "m",
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	})

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("状态码 = %d，期望 401", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "invalid api key") {
		t.Errorf("错误体没有透传: %s", rec.Body.String())
	}
	if n, _ := st.CountLogs(); n != 0 {
		t.Errorf("临时测试不应写日志，实际写了 %d 条", n)
	}
}

// 本地模型可以不带 Key，此时不应该发送 Authorization 头。
func TestChatDirectWithoutKey(t *testing.T) {
	var hadAuth bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, hadAuth = r.Header["Authorization"]
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"ok"}}]}`)
	}))
	defer srv.Close()

	s, _ := newTestServer(t, "chat-direct-nokey")
	rec := callDirectChat(t, s, map[string]any{
		"base_url": srv.URL,
		"model":    "m",
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 %d: %s", rec.Code, rec.Body.String())
	}
	if hadAuth {
		t.Error("没有填写 Key 时不应该发送 Authorization 头")
	}
}
