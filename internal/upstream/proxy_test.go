package upstream

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestNormalizeProxyURL(t *testing.T) {
	valid := []string{
		"", " \t\r\n ", "http://proxy.example", "https://proxy.example/",
		" http://proxy.example:8080/ ", "http://127.0.0.1:1", "https://proxy.example:65535",
		"socks5://127.0.0.1:1080", "socks5h://proxy.example:1080/",
		"http://[::1]:8080", "https://[2001:db8::1]:443/",
		"http://proxy-user:proxy-password@proxy.example:8080",
		"socks5://user%40name:p%3Ass%2Fword@proxy.example:1080",
	}
	for i, raw := range valid {
		t.Run(fmt.Sprintf("valid-%d", i), func(t *testing.T) {
			got, err := NormalizeProxyURL(raw)
			if err != nil {
				t.Fatalf("合法代理地址不应报错: %v", err)
			}
			if strings.TrimSpace(raw) == "" {
				if got != "" {
					t.Fatalf("空白地址应沿用环境代理，得到 %q", got)
				}
				return
			}
			if got != strings.TrimSpace(got) {
				t.Fatal("规范化后仍有首尾空白")
			}
			wantURL, _ := url.Parse(strings.TrimSpace(raw))
			gotURL, err := url.Parse(got)
			if err != nil {
				t.Fatal("规范化后不是合法 URL")
			}
			if gotURL.Scheme != wantURL.Scheme || gotURL.Host != wantURL.Host || gotURL.User.String() != wantURL.User.String() {
				t.Fatal("规范化改变了代理协议、地址或认证信息")
			}
			if again, err := NormalizeProxyURL(got); err != nil || again != got {
				t.Fatal("重复规范化结果不一致")
			}
		})
	}

	invalid := []string{
		"proxy.example:8080", "//proxy.example:8080", "ftp://proxy.example:21", "socks4://proxy.example:1080",
		"http://", "http://:8080", "http:///proxy.example", "http://proxy.example:",
		"http://proxy.example:0", "http://proxy.example:65536", "http://proxy.example:999999999999999999999",
		"http://proxy.example:-1", "http://proxy.example:abc", "http://proxy.example:8.5",
		"http://[::1", "http://::1:8080", "http://proxy example:8080", "http://proxy.example\\secret",
		"http://proxy.example/path", "http://proxy.example//", "http://proxy.example/%2Fsecret",
		"http://proxy.example/?secret=value", "http://proxy.example/#secret",
		"http://private-user:private-password@proxy.example:bad",
		"http://private-user:private-password@proxy.example:65536",
		"http://private-user:private-password@proxy.example/private-path",
		"http://private-user:private-password%zz@proxy.example:8080",
		"http://private-user:private-password@proxy.example\n:8080",
	}
	for i, raw := range invalid {
		t.Run(fmt.Sprintf("invalid-%d", i), func(t *testing.T) {
			_, err := NormalizeProxyURL(raw)
			if err == nil {
				t.Fatal("非法代理地址应被拒绝")
			}
			for _, secret := range []string{raw, "private-user", "private-password"} {
				if strings.Contains(err.Error(), secret) {
					t.Fatal("校验错误泄露了原地址或认证信息")
				}
			}
		})
	}
}

func TestMaskProxyURL(t *testing.T) {
	for _, raw := range []string{"", "http://proxy.example:8080", "https://[::1]:443/", "socks5h://proxy.example:1080"} {
		if got := MaskProxyURL(raw); got != raw {
			t.Errorf("没有认证信息的地址应原样展示: %q", got)
		}
	}
	for _, raw := range []string{
		"http://private-user:private-password@proxy.example:8080",
		"https://private-user@proxy.example:443/",
		"socks5://:private-password@proxy.example:1080",
		"socks5h://private%2Duser:private%2Dpassword@proxy.example:1080",
	} {
		got := MaskProxyURL(raw)
		u, err := url.Parse(got)
		if err != nil || u.User == nil {
			t.Fatalf("脱敏后应保留可识别的代理 URL: %q", got)
		}
		password, ok := u.User.Password()
		if u.User.Username() != "****" || !ok || password != "****" {
			t.Fatal("非空认证信息必须同时隐藏用户名和密码")
		}
		want, _ := url.Parse(raw)
		if u.Scheme != want.Scheme || u.Host != want.Host {
			t.Fatal("脱敏不应改变代理协议和主机")
		}
	}
	for _, raw := range []string{
		"http://private-user:private-password%zz@proxy.example:8080",
		"http://private-user:private-password@proxy.example:bad",
		"private-user:private-password@proxy.example",
		"http://private-user:private-password@proxy.example/path",
	} {
		got := MaskProxyURL(raw)
		if got == "" {
			t.Error("非法的非空地址应有安全的展示值")
		}
		for _, secret := range []string{"private-user", "private-password"} {
			if strings.Contains(got, secret) {
				t.Fatal("非法地址的展示值泄露了认证信息")
			}
		}
	}
}

func TestWithProxyPreservesRequestContext(t *testing.T) {
	type contextKey struct{}
	ctx, cancel := context.WithTimeout(context.WithValue(context.Background(), contextKey{}, "kept"), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://127.0.0.1/test", strings.NewReader("body"))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Test", "kept")
	a := WithProxy(req, "http://first.example:8080")
	b := WithProxy(req, "socks5h://second.example:1080")
	for i, bound := range []*http.Request{a, b} {
		want := []string{"http://first.example:8080", "socks5h://second.example:1080"}[i]
		got, err := ProxyForRequest(bound)
		if err != nil || got == nil || got.String() != want {
			t.Fatalf("同一个原请求派生的代理配置发生串用: %v", err)
		}
		if bound.Context().Value(contextKey{}) != "kept" || bound.Header.Get("X-Test") != "kept" || bound.Body != req.Body || bound.URL != req.URL {
			t.Fatal("绑定代理丢失了请求内容或上下文")
		}
		deadline, ok := bound.Context().Deadline()
		wantDeadline, _ := ctx.Deadline()
		if !ok || !deadline.Equal(wantDeadline) {
			t.Fatal("绑定代理丢失了截止时间")
		}
	}
	for _, unchanged := range []*http.Request{req, WithProxy(a, ""), WithProxy(a, " \t ")} {
		got, err := ProxyForRequest(unchanged)
		if err != nil || got != nil {
			t.Fatal("原请求或清空配置后应遵循环境对 loopback 的直连规则")
		}
	}
	cancel()
	if !errors.Is(a.Context().Err(), context.Canceled) || !errors.Is(b.Context().Err(), context.Canceled) {
		t.Fatal("绑定代理后没有传递父上下文取消")
	}
}

// 使用真实转发代理，既验证认证请求头，也验证同一个 Transport 的连接池隔离。
func TestProxyForRequestConcurrentIsolation(t *testing.T) {
	for _, targetTLS := range []bool{false, true} {
		t.Run(fmt.Sprintf("target-tls-%v", targetTLS), func(t *testing.T) {
			origin := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Proxy-Authorization") != "" {
					t.Error("代理凭据不应到达目标服务器")
				}
				io.WriteString(w, r.Header.Get("X-Test-Request"))
			}))
			if targetTLS {
				origin.StartTLS()
			} else {
				origin.Start()
			}
			t.Cleanup(func() { origin.CloseClientConnections(); origin.Close() })
			users := map[string]bool{
				proxyTestBasic("same-user", "password-a"):  true,
				proxyTestBasic("same-user", "password-b"):  true,
				proxyTestBasic("other-user", "password-c"): true,
			}
			a := newProxyTestServer(t, origin.URL, false, users)
			b := newProxyTestServer(t, origin.URL, false, users)
			proxies := []string{
				proxyTestURL(a.server.URL, "same-user", "password-a"),
				proxyTestURL(a.server.URL, "same-user", "password-b"),
				proxyTestURL(b.server.URL, "other-user", "password-c"),
			}
			client := newProxyTestClient(t, origin)
			do := func(index int) error {
				want := strconv.Itoa(index)
				req, err := http.NewRequest(http.MethodGet, origin.URL+"/pool", nil)
				if err != nil {
					return err
				}
				req.Header.Set("X-Test-Request", want)
				resp, err := client.Do(WithProxy(req, proxies[index%len(proxies)]))
				if err != nil {
					return err
				}
				defer resp.Body.Close()
				body, err := io.ReadAll(resp.Body)
				if err != nil {
					return err
				}
				if resp.StatusCode != http.StatusOK || string(body) != want {
					return fmt.Errorf("代理请求结果错误: status=%d body=%q", resp.StatusCode, body)
				}
				return nil
			}
			// 先顺序复用空闲连接；只在并发时测，可能碰巧各建一条连接而漏掉串池。
			for i := 0; i < 6; i++ {
				if err := do(i); err != nil {
					t.Fatal(err)
				}
			}
			if targetTLS && (len(a.snapshot()) != 2 || len(b.snapshot()) != 1) {
				t.Fatal("同一认证应复用 CONNECT 隧道，不同认证必须独立建隧道")
			}
			const parallel = 18
			results := make(chan error, parallel)
			start := make(chan struct{})
			for i := 0; i < parallel; i++ {
				go func(index int) { <-start; results <- do(index) }(i)
			}
			close(start)
			for i := 0; i < parallel; i++ {
				select {
				case err := <-results:
					if err != nil {
						t.Error(err)
					}
				case <-time.After(7 * time.Second):
					t.Fatal("并发代理请求未按时结束")
				}
			}
			for _, proxy := range []*proxyTestServer{a, b} {
				byConn := map[string]string{}
				for _, hit := range proxy.snapshot() {
					if previous, ok := byConn[hit.remote]; ok && previous != hit.auth {
						t.Fatal("同一代理地址的不同认证复用了同一条连接")
					}
					byConn[hit.remote] = hit.auth
					if !users[hit.auth] {
						t.Error("代理没有收到预期认证")
					}
					if targetTLS && hit.method != http.MethodConnect {
						t.Error("HTTPS 目标必须使用 CONNECT")
					}
				}
			}
			if !targetTLS && (len(a.snapshot()) != 16 || len(b.snapshot()) != 8) {
				t.Fatal("请求没有按配置分发到两台代理")
			}
		})
	}
}

func TestProxyForRequestHTTPAndHTTPSAuthentication(t *testing.T) {
	for _, proxyTLS := range []bool{false, true} {
		for _, targetTLS := range []bool{false, true} {
			t.Run(fmt.Sprintf("proxy-tls-%v/target-tls-%v", proxyTLS, targetTLS), func(t *testing.T) {
				var originHits atomic.Int32
				origin := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					originHits.Add(1)
					if r.Header.Get("Proxy-Authorization") != "" {
						t.Error("目标服务器收到了代理认证头")
					}
					io.WriteString(w, "proxied")
				}))
				if targetTLS {
					origin.StartTLS()
				} else {
					origin.Start()
				}
				t.Cleanup(func() { origin.CloseClientConnections(); origin.Close() })
				const user, password = "user@name", "pass:/word"
				proxy := newProxyTestServer(t, origin.URL, proxyTLS, map[string]bool{proxyTestBasic(user, password): true})
				client := newProxyTestClient(t, origin, proxy.server)
				for _, authenticated := range []bool{false, true} {
					proxyURL := proxy.server.URL
					if authenticated {
						proxyURL = proxyTestURL(proxyURL, user, password)
					}
					req, _ := http.NewRequest(http.MethodGet, origin.URL+"/auth", nil)
					resp, err := client.Do(WithProxy(req, proxyURL))
					if !authenticated && targetTLS {
						if resp != nil {
							resp.Body.Close()
						}
						if err == nil {
							t.Fatal("未认证的 CONNECT 不应成功")
						}
						continue
					}
					if err != nil {
						t.Fatal(err)
					}
					body, readErr := io.ReadAll(resp.Body)
					resp.Body.Close()
					if readErr != nil {
						t.Fatal(readErr)
					}
					if authenticated {
						if resp.StatusCode != http.StatusOK || string(body) != "proxied" {
							t.Fatalf("认证后的实际转发失败: status=%d body=%q", resp.StatusCode, body)
						}
					} else if resp.StatusCode != http.StatusProxyAuthRequired {
						t.Fatalf("未认证的 HTTP 代理应返回 407，得到 %d", resp.StatusCode)
					}
				}
				if originHits.Load() != 1 {
					t.Fatalf("仅通过认证的请求应到达目标，实际 %d 次", originHits.Load())
				}
				hits := proxy.snapshot()
				if len(hits) != 2 || hits[1].auth != proxyTestBasic(user, password) {
					t.Fatal("代理应收到 URL 解码后的用户名及密码")
				}
			})
		}
	}
}

func TestProxyForRequestSOCKS(t *testing.T) {
	for _, scheme := range []string{"socks5", "socks5h"} {
		for _, authenticated := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/auth-%v", scheme, authenticated), func(t *testing.T) {
				origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					io.WriteString(w, "socks:"+r.URL.Path)
				}))
				t.Cleanup(func() { origin.CloseClientConnections(); origin.Close() })
				originURL, _ := url.Parse(origin.URL)
				target := *originURL
				user, password := "", ""
				if authenticated {
					user, password = "socks-user", "socks:password"
					// 该域名只能由测试代理映射，客户端本地 DNS 解析必然失败。
					target.Host = net.JoinHostPort("socks-only.invalid", originURL.Port())
				}
				address, requests := newProxyTestSOCKS(t, originURL.Host, user, password)
				proxyURL := scheme + "://" + address
				if authenticated {
					proxyURL = proxyTestURL(proxyURL, user, password)
				}
				client := newProxyTestClient(t)
				req, _ := http.NewRequest(http.MethodGet, target.String()+"/socks", nil)
				resp, err := client.Do(WithProxy(req, proxyURL))
				if err != nil {
					t.Fatal(err)
				}
				body, readErr := io.ReadAll(resp.Body)
				resp.Body.Close()
				if readErr != nil || resp.StatusCode != http.StatusOK || string(body) != "socks:/socks" {
					t.Fatalf("SOCKS 实际转发失败: status=%d body=%q err=%v", resp.StatusCode, body, readErr)
				}
				select {
				case got := <-requests:
					if got != target.Host {
						t.Fatalf("SOCKS 目标地址错误: %q，期望 %q", got, target.Host)
					}
				case <-time.After(2 * time.Second):
					t.Fatal("SOCKS 代理没有收到请求")
				}
			})
		}
	}
}

func TestProxyForRequestInvalidNeverDials(t *testing.T) {
	var hits atomic.Int32
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		io.WriteString(w, "direct")
	}))
	t.Cleanup(func() { origin.CloseClientConnections(); origin.Close() })
	client := newProxyTestClient(t)
	transport := client.Transport.(*http.Transport)
	var dials atomic.Int32
	dial := transport.DialContext
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		dials.Add(1)
		return dial(ctx, network, address)
	}
	for _, raw := range []string{
		"ftp://private-user:private-password@127.0.0.1:1234",
		"http://private-user:private-password@127.0.0.1:65536",
		"http://private-user:private-password@127.0.0.1:1234/path",
		"http://private-user:private-password%zz@127.0.0.1:1234",
	} {
		req, _ := http.NewRequest(http.MethodGet, origin.URL, nil)
		req = WithProxy(req, raw)
		if proxy, err := ProxyForRequest(req); err == nil || proxy != nil {
			t.Fatal("非法 context 代理必须返回错误且不能返回可用代理")
		}
		resp, err := client.Do(req)
		if resp != nil {
			resp.Body.Close()
		}
		if err == nil {
			t.Fatal("非法代理不应回退直连")
		}
		if strings.Contains(err.Error(), "private-user") || strings.Contains(err.Error(), "private-password") {
			t.Fatal("HTTP 请求错误泄露了代理认证信息")
		}
	}
	if hits.Load() != 0 || dials.Load() != 0 {
		t.Fatalf("非法代理不得发起连接: origin=%d dials=%d", hits.Load(), dials.Load())
	}
}

func TestProxyForRequestCancellation(t *testing.T) {
	for _, streaming := range []bool{false, true} {
		t.Run(fmt.Sprintf("streaming-%v", streaming), func(t *testing.T) {
			started := make(chan struct{}, 1)
			stopped := make(chan struct{}, 1)
			release := make(chan struct{})
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				started <- struct{}{}
				if streaming {
					w.Header().Set("Content-Type", "text/event-stream")
					io.WriteString(w, "data: first\n\n")
					w.(http.Flusher).Flush()
				}
				select {
				case <-r.Context().Done():
					stopped <- struct{}{}
				case <-release:
				case <-time.After(5 * time.Second):
				}
			}))
			t.Cleanup(func() { close(release); proxy.CloseClientConnections(); proxy.Close() })
			client := newProxyTestClient(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://cancel-target.invalid/", nil)
			done := make(chan error, 1)
			first := make(chan struct{}, 1)
			go func() {
				resp, err := client.Do(WithProxy(req, proxy.URL))
				if err == nil {
					defer resp.Body.Close()
					if streaming {
						buf := make([]byte, len("data: first\n\n"))
						_, err = io.ReadFull(resp.Body, buf)
						if err == nil {
							first <- struct{}{}
						}
					}
					if err == nil {
						_, err = io.ReadAll(resp.Body)
					}
				}
				done <- err
			}()
			select {
			case <-started:
			case <-time.After(3 * time.Second):
				t.Fatal("请求没有到达代理")
			}
			if streaming {
				select {
				case <-first:
				case <-time.After(3 * time.Second):
					t.Fatal("流式首块被缓冲，未及时送达客户端")
				}
			}
			cancel()
			select {
			case err := <-done:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("代理请求应响应 context 取消，得到 %v", err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("取消后请求仍未退出")
			}
			select {
			case <-stopped:
			case <-time.After(3 * time.Second):
				t.Fatal("取消后没有关闭到代理的连接")
			}
		})
	}
}

// ProxyFromEnvironment 首次调用后缓存环境。独立进程可验证真实 HTTP_PROXY /
// HTTPS_PROXY / NO_PROXY 行为，而不依赖本机代理设置或其它测试执行顺序。
func TestProxyForRequestEnvironment(t *testing.T) {
	const childFlag = "LDM_PROXY_TEST_CHILD"
	if os.Getenv(childFlag) != "1" {
		executable, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, executable, "-test.run=^TestProxyForRequestEnvironment$", "-test.timeout=12s")
		for _, entry := range os.Environ() {
			name, _, _ := strings.Cut(entry, "=")
			switch strings.ToUpper(name) {
			case "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "REQUEST_METHOD", childFlag:
				continue
			}
			cmd.Env = append(cmd.Env, entry)
		}
		cmd.Env = append(cmd.Env, childFlag+"=1")
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("环境代理子进程失败: %v\n%s", err, output)
		}
		return
	}
	var environmentHits, explicitHits, directHits atomic.Int32
	environment := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		environmentHits.Add(1)
		io.WriteString(w, "environment")
	}))
	t.Cleanup(func() { environment.CloseClientConnections(); environment.Close() })
	explicit := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		explicitHits.Add(1)
		io.WriteString(w, "explicit")
	}))
	t.Cleanup(func() { explicit.CloseClientConnections(); explicit.Close() })
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		directHits.Add(1)
		io.WriteString(w, "direct")
	}))
	t.Cleanup(func() { origin.CloseClientConnections(); origin.Close() })
	t.Setenv("HTTP_PROXY", environment.URL)
	t.Setenv("HTTPS_PROXY", environment.URL)
	t.Setenv("NO_PROXY", "bypass.invalid")
	client := newProxyTestClient(t)
	for _, tc := range []struct {
		name, target, proxy, want string
		bind                      bool
	}{
		{"absent", "http://environment.invalid/", "", "environment", false},
		{"empty", "http://environment.invalid/", "", "environment", true},
		{"whitespace", "http://environment.invalid/", " \t ", "environment", true},
		{"override", "http://environment.invalid/", explicit.URL, "explicit", true},
		{"explicit-ignores-no-proxy", "http://bypass.invalid/", explicit.URL, "explicit", true},
		{"loopback-default", origin.URL, "", "direct", false},
		{"loopback-explicit", origin.URL, explicit.URL, "explicit", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req, _ := http.NewRequest(http.MethodGet, tc.target, nil)
			if tc.bind {
				req = WithProxy(req, tc.proxy)
			}
			resp, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			body, readErr := io.ReadAll(resp.Body)
			resp.Body.Close()
			if readErr != nil || string(body) != tc.want {
				t.Fatalf("代理选择错误: body=%q err=%v", body, readErr)
			}
		})
	}
	for _, target := range []string{"https://environment.invalid/", "http://bypass.invalid/", "https://bypass.invalid/"} {
		req, _ := http.NewRequest(http.MethodGet, target, nil)
		want, wantErr := http.ProxyFromEnvironment(req)
		got, err := ProxyForRequest(WithProxy(req, ""))
		if (err != nil) != (wantErr != nil) || fmt.Sprint(got) != fmt.Sprint(want) {
			t.Fatal("未配置代理时必须兼容 ProxyFromEnvironment")
		}
	}
	if environmentHits.Load() != 3 || explicitHits.Load() != 3 || directHits.Load() != 1 {
		t.Fatalf("环境与显式代理流量不符: environment=%d explicit=%d direct=%d", environmentHits.Load(), explicitHits.Load(), directHits.Load())
	}
}

func newProxyTestClient(t *testing.T, trusted ...*httptest.Server) *http.Client {
	t.Helper()
	roots := x509.NewCertPool()
	for _, server := range trusted {
		if server.TLS != nil {
			roots.AddCert(server.Certificate())
		}
	}
	transport := &http.Transport{
		Proxy:                 ProxyForRequest,
		DialContext:           (&net.Dialer{Timeout: 2 * time.Second}).DialContext,
		TLSClientConfig:       &tls.Config{RootCAs: roots},
		TLSHandshakeTimeout:   2 * time.Second,
		ResponseHeaderTimeout: 3 * time.Second,
		MaxIdleConnsPerHost:   16,
	}
	t.Cleanup(transport.CloseIdleConnections)
	return &http.Client{Transport: transport, Timeout: 5 * time.Second}
}

func proxyTestBasic(user, password string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+password))
}

func proxyTestURL(raw, user, password string) string {
	u, _ := url.Parse(raw)
	u.User = url.UserPassword(user, password)
	return u.String()
}

type proxyTestHit struct {
	method, auth, remote string
}

type proxyTestServer struct {
	server  *httptest.Server
	mu      sync.Mutex
	hits    []proxyTestHit
	tunnels map[net.Conn]bool
	closing bool
}

func (p *proxyTestServer) snapshot() []proxyTestHit {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]proxyTestHit(nil), p.hits...)
}

func newProxyTestServer(t *testing.T, target string, useTLS bool, allowed map[string]bool) *proxyTestServer {
	t.Helper()
	origin, _ := url.Parse(target)
	p := &proxyTestServer{tunnels: map[net.Conn]bool{}}
	forward := &http.Transport{
		DialContext:           (&net.Dialer{Timeout: 2 * time.Second}).DialContext,
		ResponseHeaderTimeout: 3 * time.Second,
	}
	p.server = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.mu.Lock()
		p.hits = append(p.hits, proxyTestHit{r.Method, r.Header.Get("Proxy-Authorization"), r.RemoteAddr})
		p.mu.Unlock()
		if !allowed[r.Header.Get("Proxy-Authorization")] {
			w.Header().Set("Proxy-Authenticate", `Basic realm="test"`)
			w.WriteHeader(http.StatusProxyAuthRequired)
			return
		}
		if r.Host != origin.Host {
			http.Error(w, "unexpected proxy target", http.StatusBadGateway)
			return
		}
		if r.Method == http.MethodConnect {
			up, err := net.DialTimeout("tcp", origin.Host, 2*time.Second)
			if err != nil {
				http.Error(w, "target unavailable", http.StatusBadGateway)
				return
			}
			defer up.Close()
			conn, buffer, err := w.(http.Hijacker).Hijack()
			if err != nil {
				return
			}
			defer conn.Close()
			p.mu.Lock()
			if p.closing {
				p.mu.Unlock()
				return
			}
			p.tunnels[conn] = true
			p.mu.Unlock()
			defer func() { p.mu.Lock(); delete(p.tunnels, conn); p.mu.Unlock() }()
			if _, err := buffer.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
				return
			}
			if err := buffer.Flush(); err != nil {
				return
			}
			proxyTestTunnel(conn, up, buffer)
			return
		}
		if !r.URL.IsAbs() || r.URL.Scheme != "http" {
			http.Error(w, "expected absolute HTTP request target", http.StatusBadGateway)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		out := r.Clone(ctx)
		out.RequestURI = ""
		out.Header.Del("Proxy-Authorization")
		out.Header.Del("Proxy-Connection")
		resp, err := forward.RoundTrip(out)
		if err != nil {
			http.Error(w, "forward failed", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		for name, values := range resp.Header {
			w.Header()[name] = values
		}
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
	}))
	if useTLS {
		p.server.StartTLS()
	} else {
		p.server.Start()
	}
	t.Cleanup(func() {
		p.mu.Lock()
		p.closing = true
		for conn := range p.tunnels {
			conn.Close()
		}
		p.mu.Unlock()
		p.server.CloseClientConnections()
		p.server.Close()
		forward.CloseIdleConnections()
	})
	return p
}

// 两个方向都设置截止时间；任一方向结束后关闭两端，保证 hijack 连接不会阻塞清理。
func proxyTestTunnel(client, target net.Conn, fromClient io.Reader) {
	deadline := time.Now().Add(6 * time.Second)
	client.SetDeadline(deadline)
	target.SetDeadline(deadline)
	done := make(chan struct{}, 2)
	go func() { io.Copy(target, fromClient); done <- struct{}{} }()
	go func() { io.Copy(client, target); done <- struct{}{} }()
	<-done
	client.Close()
	target.Close()
	<-done
}

// 只实现测试需要的 SOCKS5 CONNECT 和 RFC 1929 用户名密码认证，不访问外部网络。
func newProxyTestSOCKS(t *testing.T, target, username, password string) (string, <-chan string) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	requests := make(chan string, 8)
	var mu sync.Mutex
	connections := map[net.Conn]bool{}
	var workers sync.WaitGroup
	acceptDone := make(chan struct{})
	go func() {
		defer close(acceptDone)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			connections[conn] = true
			mu.Unlock()
			workers.Add(1)
			go func() {
				defer workers.Done()
				defer conn.Close()
				defer func() { mu.Lock(); delete(connections, conn); mu.Unlock() }()
				conn.SetDeadline(time.Now().Add(5 * time.Second))
				proxyTestSOCKSConnect(conn, target, username, password, requests)
			}()
		}
	}()
	t.Cleanup(func() {
		listener.Close()
		select {
		case <-acceptDone:
		case <-time.After(2 * time.Second):
			t.Error("SOCKS listener 未及时退出")
			return
		}
		mu.Lock()
		for conn := range connections {
			conn.Close()
		}
		mu.Unlock()
		done := make(chan struct{})
		go func() { workers.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("SOCKS 连接未及时退出")
		}
	})
	return listener.Addr().String(), requests
}

func proxyTestSOCKSConnect(conn net.Conn, target, username, password string, requests chan<- string) {
	var header [2]byte
	if _, err := io.ReadFull(conn, header[:]); err != nil || header[0] != 5 {
		return
	}
	methods := make([]byte, int(header[1]))
	if _, err := io.ReadFull(conn, methods); err != nil {
		return
	}
	method := byte(0)
	if username != "" || password != "" {
		method = 2
	}
	found := false
	for _, offered := range methods {
		found = found || offered == method
	}
	if !found {
		conn.Write([]byte{5, 255})
		return
	}
	if _, err := conn.Write([]byte{5, method}); err != nil {
		return
	}
	readString := func() (string, error) {
		var size [1]byte
		if _, err := io.ReadFull(conn, size[:]); err != nil {
			return "", err
		}
		data := make([]byte, int(size[0]))
		_, err := io.ReadFull(conn, data)
		return string(data), err
	}
	if method == 2 {
		var version [1]byte
		if _, err := io.ReadFull(conn, version[:]); err != nil || version[0] != 1 {
			return
		}
		user, userErr := readString()
		pass, passErr := readString()
		if userErr != nil || passErr != nil || user != username || pass != password {
			conn.Write([]byte{1, 1})
			return
		}
		if _, err := conn.Write([]byte{1, 0}); err != nil {
			return
		}
	}
	var connect [4]byte
	if _, err := io.ReadFull(conn, connect[:]); err != nil || connect[0] != 5 || connect[1] != 1 || connect[2] != 0 {
		return
	}
	var host string
	switch connect[3] {
	case 1, 4:
		size := net.IPv4len
		if connect[3] == 4 {
			size = net.IPv6len
		}
		ip := make(net.IP, size)
		if _, err := io.ReadFull(conn, ip); err != nil {
			return
		}
		host = ip.String()
	case 3:
		var err error
		host, err = readString()
		if err != nil {
			return
		}
	default:
		return
	}
	var port [2]byte
	if _, err := io.ReadFull(conn, port[:]); err != nil {
		return
	}
	address := net.JoinHostPort(host, strconv.Itoa(int(binary.BigEndian.Uint16(port[:]))))
	requests <- address
	up, err := net.DialTimeout("tcp", target, 2*time.Second)
	if err != nil {
		return
	}
	defer up.Close()
	if _, err := conn.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0}); err != nil {
		return
	}
	proxyTestTunnel(conn, up, conn)
}
