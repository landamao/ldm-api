package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ldmapi/internal/store"
)

// 模型测试的提示条里正文只展示 600 字，但复制键要能拿到上游原文：
// 接口除了 error / content（截断版）之外还得给出 error_full / content_full。
func TestModelTestReturnsFullTextForCopy(t *testing.T) {
	longMsg := strings.Repeat("上游报错", 400) // 1600 字，超过展示用的 600 字
	longBody := strings.Repeat("回复正文", 400)

	cases := []struct {
		name  string
		reply func(w http.ResponseWriter)
		field string // 展示字段 / 完整字段
		full  string
	}{
		{
			name: "失败",
			reply: func(w http.ResponseWriter) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadRequest)
				io.WriteString(w, `{"error":{"message":"`+longMsg+`"}}`)
			},
			field: "error",
			full:  longMsg,
		},
		{
			name: "成功",
			reply: func(w http.ResponseWriter) {
				w.Header().Set("Content-Type", "application/json")
				io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"`+longBody+`"}}],`+
					`"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
			},
			field: "content",
			full:  longBody,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				tc.reply(w)
			}))
			defer up.Close()

			s, st := newTestServer(t, "model-test-copy")
			if err := st.SaveChannel(store.Channel{
				ID: "c1", Name: "线路", Type: store.ChannelOpenAI, BaseURL: up.URL, APIKey: "k",
				Models: []string{"m"}, Enabled: true,
			}); err != nil {
				t.Fatal(err)
			}
			if err := st.SaveModel(store.Model{
				ID: "c1/m", Type: store.ModelTypeChannel, ChannelID: "c1", Upstream: "m", Enabled: true,
			}); err != nil {
				t.Fatal(err)
			}

			req := httptest.NewRequest(http.MethodPost, "/api/models/test", strings.NewReader(`{"id":"c1/m"}`))
			rec := httptest.NewRecorder()
			s.testModel(rec, req)

			var out map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
				t.Fatalf("响应解析失败: %v: %s", err, rec.Body.String())
			}
			shown, _ := out[tc.field].(string)
			fullText, _ := out[tc.field+"_full"].(string)
			if !strings.HasSuffix(shown, "…") {
				t.Errorf("%s 应保留展示用的截断（带省略号），得到 %q", tc.field, tail(shown))
			}
			if fullText != tc.full {
				t.Errorf("%s_full 应是上游原文，长度 %d / %d", tc.field, len([]rune(fullText)), len([]rune(tc.full)))
			}
			if strings.HasSuffix(fullText, "…") {
				t.Errorf("%s_full 不应带省略号", tc.field)
			}
		})
	}
}

func tail(s string) string {
	r := []rune(s)
	if len(r) <= 20 {
		return s
	}
	return string(r[:10]) + "..." + string(r[len(r)-10:])
}
