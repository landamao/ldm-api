package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ldmapi/internal/store"
)

// 客户端带 Connection: close（Python 的 urllib、requests 都默认带）时，
// 服务端如果不把请求体读干净就关闭连接，Windows 上会发 RST，
// 调用方收到的是「连接被重置」而不是本该返回的 401 / 403。
// 这类提前返回的分支很多，逐个加测试不现实，这里从入口统一兜住。
func TestHandleAPIRejectsInvalidTokenWithoutReset(t *testing.T) {
	s, _ := newTestServer(t, "invalid-token")
	srv := httptest.NewServer(http.HandlerFunc(s.handleAPI))
	defer srv.Close()

	for _, tc := range []struct {
		name   string
		token  string
		status int
	}{
		{"不存在的令牌", "Bearer sk-not-a-real-key", http.StatusUnauthorized},
		{"空令牌", "", http.StatusUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := `{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`
			req, err := http.NewRequest(http.MethodPost, srv.URL+"/v1/chat/completions", strings.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			req.Close = true // 等价于 Connection: close
			req.Header.Set("Content-Type", "application/json")
			if tc.token != "" {
				req.Header.Set("Authorization", tc.token)
			}

			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatalf("无效令牌应正常收到 %d，而不是连接错误: %v", tc.status, err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != tc.status {
				t.Fatalf("应返回 %d，得到 %d", tc.status, resp.StatusCode)
			}
			got, err := io.ReadAll(resp.Body)
			if err != nil {
				t.Fatalf("读取错误响应体失败: %v", err)
			}
			if !strings.Contains(string(got), "invalid_api_key") {
				t.Errorf("错误响应体不完整: %s", got)
			}
		})
	}
}

// 提前返回的分支不止鉴权失败，额度不足、IP 不在名单、端点不支持同样要能
// 把完整响应交到客户端手上。
func TestHandleAPIRejectsWithoutReset(t *testing.T) {
	s, st := newTestServer(t, "reject-paths")
	now := time.Now().UnixMilli()
	if err := st.SaveToken(store.Token{
		ID: "tok-1", Name: "额度用尽", Key: "sk-quota-exhausted",
		QuotaLimit: 100, UsedQuota: 100, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer(http.HandlerFunc(s.handleAPI))
	defer srv.Close()

	body := `{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/v1/chat/completions", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Close = true
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer sk-quota-exhausted")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("额度不足应正常收到错误响应，而不是连接错误: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("额度不足应返回 403，得到 %d", resp.StatusCode)
	}
	got, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("读取错误响应体失败: %v", err)
	}
	if !strings.Contains(string(got), "insufficient_quota") {
		t.Errorf("错误响应体不完整: %s", got)
	}
}
