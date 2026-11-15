package server

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"ldmapi/internal/store"
	"ldmapi/internal/upstream"
)

func TestChannelProxySaveAndMask(t *testing.T) {
	s, st := newTestServer(t, "channel-proxy-save")
	const proxy = "http://proxy-user:secret-password@127.0.0.1:7897"
	call := func(method string, payload map[string]any) *httptest.ResponseRecorder {
		t.Helper()
		raw, _ := json.Marshal(payload)
		req := httptest.NewRequest(method, "/api/channels/A", strings.NewReader(string(raw)))
		req.SetPathValue("id", "A")
		rec := httptest.NewRecorder()
		if method == http.MethodPost {
			s.createChannel(rec, req)
		} else {
			s.saveChannel(rec, req)
		}
		return rec
	}
	check := func(rec *httptest.ResponseRecorder, want string) {
		t.Helper()
		if rec.Code != http.StatusOK {
			t.Fatalf("保存失败 %d: %s", rec.Code, rec.Body.String())
		}
		for _, secret := range []string{"proxy-user", "secret-password"} {
			if strings.Contains(rec.Body.String(), secret) {
				t.Errorf("管理响应泄露代理认证信息: %s", rec.Body.String())
			}
		}
		ch, err := st.GetChannel("A")
		if err != nil || ch.ProxyURL != want {
			t.Fatalf("保存代理不符: %q, %v", ch.ProxyURL, err)
		}
	}
	check(call(http.MethodPost, map[string]any{
		"id": "A", "base_url": "https://api.example.com", "api_key": "sk-test",
		"proxy_url": "  " + proxy + "/  ",
	}), proxy)

	rec := httptest.NewRecorder()
	s.listChannels(rec, httptest.NewRequest(http.MethodGet, "/api/channels", nil))
	var views []channelView
	if err := json.Unmarshal(rec.Body.Bytes(), &views); err != nil || len(views) != 1 {
		t.Fatalf("列表响应错误: %s, %v", rec.Body.String(), err)
	}
	masked := views[0].ProxyURL
	if masked != "http://****:****@127.0.0.1:7897" {
		t.Fatalf("代理认证应全部隐藏: %q", masked)
	}
	check(call(http.MethodPut, map[string]any{"enabled": false}), proxy)
	check(call(http.MethodPut, map[string]any{"name": "改名", "proxy_url": masked}), proxy)

	bad := call(http.MethodPut, map[string]any{"proxy_url": "http://****:****@other-proxy:7897"})
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("更换地址不能沿用认证掩码: %d %s", bad.Code, bad.Body.String())
	}
	if ch, _ := st.GetChannel("A"); ch.ProxyURL != proxy {
		t.Fatal("非法配置不应覆盖原代理")
	}
	check(call(http.MethodPut, map[string]any{"proxy_url": "socks5://localhost:1080"}), "socks5://localhost:1080")
	check(call(http.MethodPut, map[string]any{"proxy_url": "  "}), "")
}

func TestChannelProxyRejectsInvalidConfiguration(t *testing.T) {
	s, st := newTestServer(t, "channel-proxy-invalid")
	for _, value := range []string{
		"127.0.0.1:7897", "ftp://proxy-user:secret-password@localhost:21",
		"http://proxy-user:secret-password@localhost:70000", "http://localhost:7897/api",
		"http://proxy-user:secret-password@localhost:bad", "http://localhost:7897?",
		"http://localhost:7897#", "http://localhost:", "http://:7897",
	} {
		t.Run(value, func(t *testing.T) {
			payload := map[string]any{"id": "A", "base_url": "http://upstream.invalid", "proxy_url": value}
			raw, _ := json.Marshal(payload)
			req := httptest.NewRequest(http.MethodPost, "/api/channels", strings.NewReader(string(raw)))
			rec := httptest.NewRecorder()
			s.createChannel(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("非法代理应拒绝保存: %d %s", rec.Code, rec.Body.String())
			}
			if strings.Contains(rec.Body.String(), "secret-password") || strings.Contains(rec.Body.String(), "proxy-user") {
				t.Errorf("校验错误泄露代理认证信息: %s", rec.Body.String())
			}
			code, out := callDiscover(t, s, payload)
			if code != http.StatusBadRequest {
				t.Errorf("获取模型同样应拒绝非法代理: %d %v", code, out)
			}
		})
	}
	if _, err := st.GetChannel("A"); err != store.ErrNotFound {
		t.Error("非法配置不应落库")
	}
}

func TestDiscoverUsesDraftSavedAndClearedProxy(t *testing.T) {
	s, st := newTestServer(t, "channel-proxy-discover")
	var directHits, proxyHits atomic.Int32
	direct := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		directHits.Add(1)
		fmt.Fprint(w, `{"data":[{"id":"direct-model"}]}`)
	}))
	defer direct.Close()
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("proxy-user:secret-password"))
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxyHits.Add(1)
		if !r.URL.IsAbs() || r.URL.String() != direct.URL+"/v1/models" {
			t.Errorf("没有收到正确的代理目标: %s", r.URL)
		}
		if got := r.Header.Get("Proxy-Authorization"); got != wantAuth {
			t.Error("未收到代理认证")
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sk-draft" {
			t.Errorf("API Key 应独立于代理继承: %q", got)
		}
		fmt.Fprint(w, `{"data":[{"id":"proxied-model"}]}`)
	}))
	defer proxy.Close()
	proxyURL, _ := url.Parse(proxy.URL)
	proxyURL.User = url.UserPassword("proxy-user", "secret-password")
	payload := map[string]any{"id": "A", "type": "openai", "base_url": direct.URL, "api_key": "sk-draft", "proxy_url": proxyURL.String()}
	check := func(want string) {
		t.Helper()
		code, out := callDiscover(t, s, payload)
		models, _ := out["models"].([]any)
		if code != http.StatusOK || len(models) != 1 || models[0] != want {
			t.Fatalf("获取模型结果不符: %d %v", code, out)
		}
	}
	check("proxied-model")
	if _, err := st.GetChannel("A"); err != store.ErrNotFound {
		t.Fatal("草稿获取模型不能保存渠道")
	}
	if err := st.SaveChannel(store.Channel{ID: "A", Type: store.ChannelOpenAI, BaseURL: direct.URL,
		ProxyURL: proxyURL.String(), APIKey: "sk-saved", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	delete(payload, "proxy_url")
	check("proxied-model") // 修改 API Key 后，仍继承未提交的代理。
	payload["proxy_url"] = upstream.MaskProxyURL(proxyURL.String())
	check("proxied-model")
	payload["proxy_url"] = ""
	check("direct-model")
	if proxyHits.Load() != 3 || directHits.Load() != 1 {
		t.Fatalf("代理/直连调用次数不符: %d/%d", proxyHits.Load(), directHits.Load())
	}
	if ch, _ := st.GetChannel("A"); ch.ProxyURL != proxyURL.String() || ch.APIKey != "sk-saved" {
		t.Fatal("获取模型不应保存草稿修改")
	}
}

func TestChannelProbesUseProxy(t *testing.T) {
	for _, typ := range []string{store.ChannelOpenAI, store.ChannelAnthropic, store.ChannelGemini} {
		t.Run(typ, func(t *testing.T) {
			s, st := newTestServer(t, "channel-proxy-probe-"+typ)
			var lists, chats atomic.Int32
			var listFails atomic.Bool
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !r.URL.IsAbs() || r.URL.Host != "upstream.invalid" {
					t.Errorf("应使用代理请求上游: %s", r.URL)
				}
				w.Header().Set("Content-Type", "application/json")
				if r.Method == http.MethodGet {
					lists.Add(1)
					if listFails.Load() {
						http.Error(w, "list unavailable", http.StatusNotFound)
						return
					}
					fmt.Fprint(w, `{"data":[{"id":"m1"}]}`)
					return
				}
				chats.Add(1)
				fmt.Fprint(w, `{"choices":[{"message":{"content":"hi"}}],"content":[{"type":"text","text":"hi"}],"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}`)
			}))
			defer proxy.Close()
			if err := st.SaveChannel(store.Channel{ID: "A", Type: typ, BaseURL: "http://upstream.invalid",
				ProxyURL: proxy.URL, APIKey: "sk-test", Models: []string{"m1"}, Enabled: true}); err != nil {
				t.Fatal(err)
			}
			for _, body := range []string{`{"mode":"list"}`, `{"model":"m1"}`, `{}`} {
				code, out := callChannelTest(s, "A", body)
				if code != http.StatusOK || out["ok"] != true {
					t.Fatalf("探测应走代理: %d %v", code, out)
				}
			}
			listFails.Store(true)
			if _, out := callChannelTest(s, "A", `{}`); out["ok"] != true {
				t.Fatalf("列表失败后的对话回退也应走代理: %v", out)
			}
			if lists.Load() != 3 || chats.Load() != 2 {
				t.Errorf("探测请求次数不符: lists=%d chats=%d", lists.Load(), chats.Load())
			}
		})
	}
}

func TestChannelProbeProxyAuthFailureIsSafe(t *testing.T) {
	s, st := newTestServer(t, "channel-proxy-auth-failure")
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusProxyAuthRequired)
		fmt.Fprint(w, "proxy-user secret-password")
	}))
	defer proxy.Close()
	proxyURL, _ := url.Parse(proxy.URL)
	proxyURL.User = url.UserPassword("proxy-user", "secret-password")
	if err := st.SaveChannel(store.Channel{ID: "A", Type: store.ChannelOpenAI, BaseURL: "http://upstream.invalid",
		ProxyURL: proxyURL.String(), Models: []string{"m1"}, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{`{"mode":"list"}`, `{"model":"m1"}`} {
		_, out := callChannelTest(s, "A", body)
		message, _ := out["message"].(string)
		if out["ok"] != false || !strings.Contains(message, "代理认证失败") {
			t.Fatalf("应说明代理认证失败: %v", out)
		}
		if strings.Contains(message, "secret-password") || strings.Contains(message, "proxy-user") {
			t.Errorf("不能透传代理认证页: %s", message)
		}
	}
}
