package relay

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ldmapi/internal/store"
)

const relayProxyReply = `{"id":"proxy-ok","model":"m","choices":[{"message":{"role":"assistant","content":"proxy reply"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}`

// 两条路由的目标地址相同，仅代理配置不同，确保重试绑定当前渠道而不是复用旧代理。
func TestRelayProxyRetrySwitchesChannelProxy(t *testing.T) {
	for _, sameAddress := range []bool{false, true} {
		t.Run(fmt.Sprintf("same-address-%v", sameAddress), func(t *testing.T) {
			var directHits atomic.Int32
			origin := newRelayProxyServer(t, func(w http.ResponseWriter, r *http.Request) {
				directHits.Add(1)
				http.Error(w, "unexpected direct request", http.StatusBadGateway)
			})
			originURL, _ := url.Parse(origin.URL)
			const username = "channel-proxy-user"
			var mu sync.Mutex
			var attempts []string
			connections := map[string]string{}
			handler := func(w http.ResponseWriter, req *http.Request) {
				auth := req.Header.Get("Proxy-Authorization")
				which := ""
				switch auth {
				case relayProxyBasic(username, "password-a"):
					which = "a"
				case relayProxyBasic(username, "password-b"):
					which = "b"
				default:
					t.Error("代理认证没有使用当前渠道配置")
					w.WriteHeader(http.StatusProxyAuthRequired)
					return
				}
				mu.Lock()
				attempts = append(attempts, which)
				if previous, ok := connections[req.RemoteAddr]; ok && previous != auth {
					t.Error("同地址不同认证的渠道复用了同一代理连接")
				}
				connections[req.RemoteAddr] = auth
				mu.Unlock()
				if !req.URL.IsAbs() || req.URL.Host != originURL.Host || req.URL.Path != "/v1/chat/completions" {
					t.Errorf("代理请求目标错误: %s", req.URL)
				}
				if req.Header.Get("Authorization") != "Bearer api-"+which {
					t.Error("上游 API Key 与代理认证发生混淆")
				}
				io.Copy(io.Discard, req.Body)
				w.Header().Set("Content-Type", "application/json")
				if which == "a" {
					w.WriteHeader(http.StatusBadGateway)
					io.WriteString(w, `{"error":{"message":"first proxy unavailable"}}`)
					return
				}
				io.WriteString(w, relayProxyReply)
			}
			a := newRelayProxyServer(t, handler)
			b := a
			if !sameAddress {
				b = newRelayProxyServer(t, handler)
			}
			r, model := newRelayProxyModel(t, origin.URL, []string{
				relayProxyURL(a.URL, username, "password-a"),
				relayProxyURL(b.URL, username, "password-b"),
			})
			req := relayProxyRequest(model.ID, false)
			req.Header.Set("Proxy-Authorization", relayProxyBasic("client-user", "client-password"))
			recorder := httptest.NewRecorder()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			result := r.Do(ctx, recorder, req)
			if result.Err != "" || result.StatusCode != http.StatusOK || recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), "proxy reply") {
				t.Fatalf("第二条代理路由应成功: result=%+v body=%s", result, recorder.Body.String())
			}
			if result.Retries != 1 || result.ChannelID != model.Routes[1].ChannelID || len(result.Attempts) != 2 {
				t.Fatalf("换代理的重试记录不正确: %+v", result)
			}
			if result.Attempts[0].StatusCode != http.StatusBadGateway || result.Attempts[1].StatusCode != http.StatusOK {
				t.Fatalf("重试状态码错误: %+v", result.Attempts)
			}
			mu.Lock()
			got := strings.Join(attempts, ",")
			mu.Unlock()
			if got != "a,b" || directHits.Load() != 0 {
				t.Fatalf("代理切换错误: attempts=%q direct=%d", got, directHits.Load())
			}
		})
	}
}

func TestRelayProxyInvalidOrFailedFallsBackToDefault(t *testing.T) {
	for _, invalid := range []bool{false, true} {
		t.Run(fmt.Sprintf("invalid-%v", invalid), func(t *testing.T) {
			var directHits, proxyHits atomic.Int32
			origin := newRelayProxyServer(t, func(w http.ResponseWriter, r *http.Request) {
				directHits.Add(1)
				if r.Header.Get("Proxy-Authorization") != "" || r.Header.Get("Authorization") != "Bearer api-b" {
					t.Error("第一条路由或其代理凭据泄漏到了直连目标")
				}
				w.Header().Set("Content-Type", "application/json")
				io.WriteString(w, relayProxyReply)
			})
			proxy := newRelayProxyServer(t, func(w http.ResponseWriter, r *http.Request) {
				proxyHits.Add(1)
				io.Copy(io.Discard, r.Body)
				w.WriteHeader(http.StatusBadGateway)
				io.WriteString(w, `{"error":{"message":"proxy unavailable"}}`)
			})
			proxyURL := proxy.URL
			if invalid {
				proxyURL = "http://private-user:private-password@127.0.0.1:65536"
			}
			r, model := newRelayProxyModel(t, origin.URL, []string{proxyURL, ""})
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			recorder := httptest.NewRecorder()
			result := r.Do(ctx, recorder, relayProxyRequest(model.ID, false))
			if result.Err != "" || result.Canceled || result.StatusCode != http.StatusOK || result.Retries != 1 || result.ChannelID != model.Routes[1].ChannelID {
				t.Fatalf("第一条失败后应按第二条空代理配置重试: %+v", result)
			}
			if directHits.Load() != 1 || (!invalid && proxyHits.Load() != 1) || (invalid && proxyHits.Load() != 0) {
				t.Fatalf("第一条不应退回直连，第二条应沿用默认: direct=%d proxy=%d", directHits.Load(), proxyHits.Load())
			}
			for _, attempt := range result.Attempts {
				if strings.Contains(attempt.Error, "private-user") || strings.Contains(attempt.Error, "private-password") {
					t.Fatal("路由重试日志泄露了代理凭据")
				}
			}
		})
	}
}

func TestRelayProxy407DoesNotCoolAPIKeys(t *testing.T) {
	var directHits, proxyHits atomic.Int32
	origin := newRelayProxyServer(t, func(w http.ResponseWriter, r *http.Request) {
		directHits.Add(1)
	})
	proxy := newRelayProxyServer(t, func(w http.ResponseWriter, r *http.Request) {
		proxyHits.Add(1)
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Proxy-Authenticate", `Basic realm="test"`)
		w.WriteHeader(http.StatusProxyAuthRequired)
		io.WriteString(w, "private-user:private-password proxy authentication page")
	})
	r, model := newRelayProxyModel(t, origin.URL, []string{relayProxyURL(proxy.URL, "private-user", "private-password")})
	channel, err := r.Store.GetChannel(model.Routes[0].ChannelID)
	if err != nil {
		t.Fatal(err)
	}
	channel.APIKeys = []store.ChannelKey{{Key: "api-key-first"}, {Key: "api-key-second"}}
	channel.MultiKey = boolp(true)
	channel.KeyMode = store.KeyModeSequential
	channel.KeyCooldownStatus = strp("400-599")
	if err := r.Store.SaveChannel(channel); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	recorder := httptest.NewRecorder()
	result := r.Do(ctx, recorder, relayProxyRequest(model.ID, false))
	if result.StatusCode != http.StatusBadGateway || recorder.Code != http.StatusBadGateway || result.Err == "" || result.Canceled {
		t.Fatalf("407 应被识别为代理认证失败: %+v", result)
	}
	if proxyHits.Load() == 0 || directHits.Load() != 0 {
		t.Fatal("代理认证失败后不应直连")
	}
	keys, reason := PlanKeys(channel)
	if reason != "" || len(keys) != 2 {
		t.Fatalf("407 即使命中渠道冷却状态码也不能冷却 API Key: count=%d reason=%q", len(keys), reason)
	}
	display := result.Err + result.ClientErr + recorder.Body.String() + fmt.Sprint(result.Attempts)
	for _, secret := range []string{"private-user", "private-password", "proxy authentication page"} {
		if strings.Contains(display, secret) {
			t.Fatal("代理认证错误或响应泄露了凭据/代理认证页")
		}
	}
}

// 首块到达客户端才允许代理发送后续块：可确定验证流式没有被改成整段缓冲。
func TestRelayProxyStreamFlushAndCancel(t *testing.T) {
	for _, cancelStream := range []bool{false, true} {
		t.Run(fmt.Sprintf("cancel-%v", cancelStream), func(t *testing.T) {
			var directHits, proxyHits atomic.Int32
			origin := newRelayProxyServer(t, func(w http.ResponseWriter, r *http.Request) {
				directHits.Add(1)
				http.Error(w, "unexpected direct request", http.StatusBadGateway)
			})
			firstFlushed := make(chan struct{})
			stopped := make(chan struct{}, 1)
			proxy := newRelayProxyServer(t, func(w http.ResponseWriter, r *http.Request) {
				proxyHits.Add(1)
				body, err := io.ReadAll(r.Body)
				if err != nil || !bytes.Contains(body, []byte(`"stream":true`)) {
					t.Error("代理未收到流式请求")
				}
				if r.Header.Get("Proxy-Authorization") != relayProxyBasic("stream-user", "stream-password") {
					t.Error("流式请求没有使用渠道代理认证")
				}
				w.Header().Set("Content-Type", "text/event-stream")
				io.WriteString(w, "data: {\"model\":\"m\",\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n")
				w.(http.Flusher).Flush()
				if cancelStream {
					select {
					case <-r.Context().Done():
						stopped <- struct{}{}
					case <-time.After(4 * time.Second):
					}
					return
				}
				select {
				case <-firstFlushed:
				case <-r.Context().Done():
					return
				case <-time.After(4 * time.Second):
					return
				}
				io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"second\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\n")
				io.WriteString(w, "data: [DONE]\n\n")
				w.(http.Flusher).Flush()
			})
			r, model := newRelayProxyModel(t, origin.URL, []string{relayProxyURL(proxy.URL, "stream-user", "stream-password"), ""})
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			writer := &relayProxyStreamWriter{ResponseRecorder: httptest.NewRecorder(), firstFlushed: firstFlushed}
			if cancelStream {
				writer.cancel = cancel
			}
			result := r.Do(ctx, writer, relayProxyRequest(model.ID, true))
			select {
			case <-firstFlushed:
			default:
				t.Fatal("首块内容没有及时 Flush 到客户端")
			}
			if result.StatusCode != http.StatusOK || result.Retries != 0 || !result.Stream || !result.StreamGen || directHits.Load() != 0 || proxyHits.Load() != 1 {
				t.Fatalf("流式转发改变了状态或重试语义: %+v direct=%d proxy=%d", result, directHits.Load(), proxyHits.Load())
			}
			if cancelStream {
				if !result.Canceled || strings.Contains(writer.Body.String(), "second") {
					t.Fatalf("中途取消应停止流式且不切到备用渠道: %+v", result)
				}
				select {
				case <-stopped:
				case <-time.After(2 * time.Second):
					t.Fatal("客户端取消没有关闭代理请求")
				}
			} else if result.Err != "" || result.Canceled || result.Usage.TotalTokens != 5 || !strings.Contains(writer.Body.String(), "second") || !strings.Contains(writer.Body.String(), "[DONE]") {
				t.Fatalf("代理流式内容或用量不完整: result=%+v body=%s", result, writer.Body.String())
			}
		})
	}
}

type relayProxyStreamWriter struct {
	*httptest.ResponseRecorder
	firstFlushed chan struct{}
	cancel       context.CancelFunc
	once         sync.Once
}

func (w *relayProxyStreamWriter) Flush() {
	w.ResponseRecorder.Flush()
	if strings.Contains(w.Body.String(), "first") {
		w.once.Do(func() {
			close(w.firstFlushed)
			if w.cancel != nil {
				w.cancel()
			}
		})
	}
}

func newRelayProxyServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(func() { server.CloseClientConnections(); server.Close() })
	return server
}

func newRelayProxyModel(t *testing.T, baseURL string, proxies []string) (*Relay, store.Model) {
	t.Helper()
	st := newTestStore(t)
	now := time.Now().UnixMilli()
	model := store.Model{
		ID: t.Name(), Type: store.ModelTypeCustom, Enabled: true,
		Timeout: 3, ForceStream: boolp(false), NoRetryStatus: strp(""),
		CreatedAt: now, UpdatedAt: now,
	}
	for i, proxy := range proxies {
		id := fmt.Sprintf("%s-channel-%d", t.Name(), i)
		channel := store.Channel{
			ID: id, Name: id, Type: store.ChannelOpenAI, BaseURL: baseURL, ProxyURL: proxy,
			APIKeys: []store.ChannelKey{{Key: fmt.Sprintf("api-%c", 'a'+i)}},
			Models:  []string{"m"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
		}
		if err := st.SaveChannel(channel); err != nil {
			t.Fatal(err)
		}
		model.Routes = append(model.Routes, store.Route{ChannelID: id, Upstream: "m"})
	}
	if err := st.SaveModel(model); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ClearCooldownsForModel(model) })
	r := New(st)
	t.Cleanup(r.tr.CloseIdleConnections)
	return r, model
}

func relayProxyRequest(model string, stream bool) *Request {
	payload := map[string]any{
		"model": model, "stream": stream,
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	}
	return &Request{
		Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{}, Body: mustJSON(payload), JSON: payload, Stream: stream,
	}
}

func relayProxyBasic(username, password string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(username+":"+password))
}

func relayProxyURL(raw, username, password string) string {
	u, _ := url.Parse(raw)
	u.User = url.UserPassword(username, password)
	return u.String()
}
