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

// 首字按「第一段真实内容」计：上游先发响应头 + 只带 role 的空块，
// 400 毫秒后才吐正文，首字应接近 400ms 而不是 0。
func TestFirstByteMeasuresFirstContentChunk(t *testing.T) {
	st := newTestStore(t)

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		// 空块：只有 role，调用方此时还看不到任何内容。
		io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-time.After(400 * time.Millisecond):
		case <-r.Context().Done():
			return
		}
		io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你\"},\"finish_reason\":\"stop\"}]}\n\n")
		io.WriteString(w, "data: [DONE]\n\n")
		w.(http.Flusher).Flush()
	}))
	defer up.Close()

	seedSingleRoute(t, st, "fb-stream", up.URL, 5)

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
	if res.FirstByteMs < 300 {
		t.Fatalf("首字应按第一段内容计（约 400ms），得到 %dms", res.FirstByteMs)
	}
	if res.FirstByteMs > 3000 {
		t.Fatalf("首字耗时异常: %dms", res.FirstByteMs)
	}
}

// 强制流式 + 非流式客户端：首字同样按第一段内容计，而不是第一块字节。
func TestFirstByteCollectPathUsesFirstContent(t *testing.T) {
	st := newTestStore(t)

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-time.After(400 * time.Millisecond):
		case <-r.Context().Done():
			return
		}
		io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"答\"},\"finish_reason\":\"stop\"}]}\n\n")
		io.WriteString(w, "data: [DONE]\n\n")
		w.(http.Flusher).Flush()
	}))
	defer up.Close()

	if err := st.SaveChannel(store.Channel{
		ID: "fb-collect", Name: "fb-collect", Type: store.ChannelOpenAI, BaseURL: up.URL,
		Models: []string{"m"}, Enabled: true, CreatedAt: nowMs(), UpdatedAt: nowMs(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "m", Type: store.ModelTypeCustom, Timeout: 5, ForceStream: boolp(true),
		Routes:  []store.Route{{ChannelID: "fb-collect", Upstream: "m"}},
		Enabled: true, CreatedAt: nowMs(), UpdatedAt: nowMs(),
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
	if res.FirstByteMs < 300 {
		t.Fatalf("首字应按第一段内容计（约 400ms），得到 %dms", res.FirstByteMs)
	}
	if res.FirstByteMs > 3000 {
		t.Fatalf("首字耗时异常: %dms", res.FirstByteMs)
	}
}

func nowMs() int64 { return time.Now().UnixMilli() }
