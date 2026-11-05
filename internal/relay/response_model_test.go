package relay

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"ldmapi/internal/store"
)

// responseModelCase 建一条指向指定上游响应的单路由，跑一次请求拿结果。
func responseModelCase(t *testing.T, upstream http.HandlerFunc, stream bool) *Result {
	t.Helper()
	srv := httptest.NewServer(upstream)
	t.Cleanup(srv.Close)

	st := newTestStore(t)
	now := time.Now().UnixMilli()
	if err := st.SaveChannel(store.Channel{
		ID: "rm", Name: "别名线路", Type: store.ChannelOpenAI, BaseURL: srv.URL,
		Models: []string{"asked"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "resp/model", Type: store.ModelTypeCustom,
		Routes:  []store.Route{{ChannelID: "rm", Upstream: "asked"}},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	payload := `{"model":"resp/model","messages":[{"role":"user","content":"hi"}]`
	if stream {
		payload += `,"stream":true`
	}
	payload += "}"
	body := []byte(payload)
	req := &Request{
		Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{}, Body: body,
		JSON: map[string]any{"model": "resp/model"}, Stream: stream,
	}
	rec := httptest.NewRecorder()
	return New(st).Do(context.Background(), rec, req)
}

// 上游把请求的模型解析成带日期的版本并回显时，日志要能记住响应模型。
func TestResultRecordsResponseModel(t *testing.T) {
	res := responseModelCase(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"x","model":"asked-2025-01-01","choices":[],`+
			`"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}, false)

	if res.UpstreamModel != "asked" {
		t.Fatalf("请求的上游模型应为 asked，得到 %q", res.UpstreamModel)
	}
	if res.ResponseModel != "asked-2025-01-01" {
		t.Fatalf("响应模型应为 asked-2025-01-01，得到 %q", res.ResponseModel)
	}
}

// 流式响应的模型名在第一个数据块里，同样要记下来。
func TestStreamRecordsResponseModel(t *testing.T) {
	res := responseModelCase(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, `data: {"id":"c1","model":"asked-stream-2025","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}`+"\n\n")
		io.WriteString(w, `data: {"id":"c1","model":"asked-stream-2025","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}],`+
			`"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`+"\n\n")
		io.WriteString(w, "data: [DONE]\n\n")
	}, true)

	if res.ResponseModel != "asked-stream-2025" {
		t.Fatalf("流式响应模型应为 asked-stream-2025，得到 %q", res.ResponseModel)
	}
}

// 上游原样回显（或不回显）时，响应模型要么和请求的一致，要么为空。
func TestResponseModelEchoAndMissing(t *testing.T) {
	echo := responseModelCase(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"x","model":"asked","choices":[],`+
			`"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}, false)
	if echo.ResponseModel != "asked" {
		t.Fatalf("回显同名时应记下 asked，得到 %q", echo.ResponseModel)
	}

	missing := responseModelCase(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"x","choices":[],`+
			`"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}, false)
	if missing.ResponseModel != "" {
		t.Fatalf("上游没回显模型时应为空，得到 %q", missing.ResponseModel)
	}
}
