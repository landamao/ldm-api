package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"ldmapi/internal/store"
)

// 在线聊天「工具调用」开关附带的工具定义，必须原样出现在上游请求体里：
// 直连临时上游和走渠道路由两条路径都要透传。
func TestChatForwardsTools(t *testing.T) {
	tools := []any{map[string]any{
		"type": "function",
		"function": map[string]any{
			"name":       "get_current_time",
			"parameters": map[string]any{"type": "object", "properties": map[string]any{}},
		},
	}}
	messages := []any{map[string]any{"role": "user", "content": "现在几点"}}

	upstream := func(t *testing.T, gotTools *[]any, gotMessages *[]any) *httptest.Server {
		t.Helper()
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			*gotTools, _ = body["tools"].([]any)
			*gotMessages, _ = body["messages"].([]any)
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`)
		}))
	}

	t.Run("direct", func(t *testing.T) {
		var gotTools, gotMessages []any
		srv := upstream(t, &gotTools, &gotMessages)
		defer srv.Close()

		s, _ := newTestServer(t, "chat-tools-direct")
		rec := callDirectChat(t, s, map[string]any{
			"base_url": srv.URL,
			"model":    "m",
			"messages": messages,
			"tools":    tools,
		})
		if rec.Code != http.StatusOK {
			t.Fatalf("状态码 %d: %s", rec.Code, rec.Body.String())
		}
		if len(gotTools) != 1 {
			t.Fatalf("上游没有收到工具定义: %v", gotTools)
		}
		fn, _ := gotTools[0].(map[string]any)["function"].(map[string]any)
		if fn["name"] != "get_current_time" {
			t.Errorf("工具名 = %v", fn["name"])
		}
	})

	t.Run("relay", func(t *testing.T) {
		var gotTools, gotMessages []any
		srv := upstream(t, &gotTools, &gotMessages)
		defer srv.Close()

		s, st := newTestServer(t, "chat-tools-relay")
		if err := st.SaveChannel(store.Channel{
			ID: "C", Name: "C", Type: store.ChannelOpenAI, BaseURL: srv.URL,
			APIKey: "sk-upstream", Models: []string{"m"}, Enabled: true,
		}); err != nil {
			t.Fatal(err)
		}
		now := time.Now().UnixMilli()
		if err := st.SaveModel(store.Model{
			ID: "C/m", Type: store.ModelTypeChannel, ChannelID: "C", Upstream: "m",
			Enabled: true, CreatedAt: now, UpdatedAt: now,
		}); err != nil {
			t.Fatal(err)
		}

		rec := callDirectChat(t, s, map[string]any{
			"model":    "C/m",
			"messages": messages,
			"tools":    tools,
		})
		if rec.Code != http.StatusOK {
			t.Fatalf("状态码 %d: %s", rec.Code, rec.Body.String())
		}
		if len(gotTools) != 1 {
			t.Fatalf("上游没有收到工具定义: %v", gotTools)
		}
	})
}

// 没开工具调用时，请求体里不应该出现 tools 字段。
func TestChatWithoutToolsOmitsField(t *testing.T) {
	var hadTools bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, hadTools = body["tools"]
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"ok"}}]}`)
	}))
	defer srv.Close()

	s, _ := newTestServer(t, "chat-no-tools")
	rec := callDirectChat(t, s, map[string]any{
		"base_url": srv.URL,
		"model":    "m",
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 %d: %s", rec.Code, rec.Body.String())
	}
	if hadTools {
		t.Error("没有开启工具调用时不应发送 tools 字段")
	}
}
