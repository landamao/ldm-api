package server

import (
	"bufio"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ldmapi/internal/relay"
	"ldmapi/internal/store"
	"ldmapi/internal/upstream"
)

func TestPasswordHashAndVerify(t *testing.T) {
	salt := randomHex(16)
	h1 := hashPassword("hunter2", salt)
	h2 := hashPassword("hunter2", salt)
	if h1 != h2 {
		t.Error("相同密码与盐应得到相同摘要")
	}
	if h1 == hashPassword("hunter3", salt) {
		t.Error("不同密码不应得到相同摘要")
	}
	if len(h1) != 64 {
		t.Errorf("SHA-256 摘要应为 64 个十六进制字符，得到 %d", len(h1))
	}
	if h1 == hashPassword("hunter2", randomHex(16)) {
		t.Error("不同盐应得到不同摘要")
	}
}

func TestTokenValidRules(t *testing.T) {
	now := time.Now().UnixMilli()
	cases := []struct {
		name string
		tok  store.Token
		ok   bool
	}{
		{"正常", store.Token{Enabled: true}, true},
		{"已禁用", store.Token{Enabled: false}, false},
		{"已过期", store.Token{Enabled: true, ExpiresAt: now - 1000}, false},
		{"未过期", store.Token{Enabled: true, ExpiresAt: now + 100000}, true},
		{"额度未满", store.Token{Enabled: true, QuotaLimit: 100, UsedQuota: 99}, true},
		{"额度用尽", store.Token{Enabled: true, QuotaLimit: 100, UsedQuota: 100}, false},
		{"额度超出", store.Token{Enabled: true, QuotaLimit: 100, UsedQuota: 150}, false},
		{"无额度限制", store.Token{Enabled: true, UsedQuota: 999999}, true},
	}
	for _, c := range cases {
		err := tokenValid(c.tok)
		if c.ok && err != nil {
			t.Errorf("%s: 应通过校验，却报错 %v", c.name, err)
		}
		if !c.ok && err == nil {
			t.Errorf("%s: 应被拒绝，却通过了校验", c.name)
		}
	}
}

// 禁用、过期与未知密钥对外表现一致；额度不足单独提示。
func TestTokenErrorResponses(t *testing.T) {
	s, st := newTestServer(t, "token-uniform")
	key, err := s.EnsureDefaultToken()
	if err != nil {
		t.Fatal(err)
	}
	if key == "" {
		t.Fatal("首次启动应生成默认密钥")
	}
	gw := httptest.NewServer(s.Handler())
	defer gw.Close()

	call := func(k string) (int, string) {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, gw.URL+"/v1/models", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+k)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body)
	}
	checkInvalid := func(name, k, wantBody string) {
		t.Helper()
		code, body := call(k)
		if code != http.StatusUnauthorized {
			t.Errorf("%s: 应返回 401，得到 %d（%s）", name, code, body)
		}
		if !strings.Contains(body, `"code":"invalid_api_key"`) {
			t.Errorf("%s: 应返回 invalid_api_key，得到 %s", name, body)
		}
		for _, leaked := range []string{"禁用", "过期"} {
			if strings.Contains(body, leaked) {
				t.Errorf("%s: 响应泄露了密钥状态「%s」: %s", name, leaked, body)
			}
		}
		if wantBody != "" && body != wantBody {
			t.Errorf("%s: 响应应与未知密钥完全一致，得到 %s", name, body)
		}
	}

	_, unknownBody := call("sk-ldm-does-not-exist")
	checkInvalid("未知密钥", "sk-ldm-does-not-exist", "")

	tok, err := st.FindTokenByKey(key)
	if err != nil {
		t.Fatal(err)
	}
	restore := func() {
		tok.Enabled = true
		tok.ExpiresAt = 0
		tok.QuotaLimit = 0
		tok.UsedQuota = 0
		if err := st.SaveToken(tok); err != nil {
			t.Fatal(err)
		}
	}

	tok.Enabled = false
	if err := st.SaveToken(tok); err != nil {
		t.Fatal(err)
	}
	checkInvalid("已禁用", key, unknownBody)

	restore()
	tok.ExpiresAt = time.Now().Add(-time.Hour).UnixMilli()
	if err := st.SaveToken(tok); err != nil {
		t.Fatal(err)
	}
	checkInvalid("已过期", key, unknownBody)

	restore()
	tok.QuotaLimit = 100
	tok.UsedQuota = 100
	if err := st.SaveToken(tok); err != nil {
		t.Fatal(err)
	}
	code, body := call(key)
	if code != http.StatusForbidden {
		t.Errorf("额度不足: 应返回 403，得到 %d（%s）", code, body)
	}
	if !strings.Contains(body, "额度不足") || !strings.Contains(body, `"code":"insufficient_quota"`) {
		t.Errorf("额度不足: 应返回额度提示，得到 %s", body)
	}
}

func TestTokenAllowsModel(t *testing.T) {
	all := store.Token{}
	if !tokenAllowsModel(all, "任意模型") {
		t.Error("未设置限制时应允许所有模型")
	}
	limited := store.Token{AllowedModels: []string{"LDM", "A/c"}}
	if !tokenAllowsModel(limited, "LDM") {
		t.Error("白名单内的模型应被允许")
	}
	if !tokenAllowsModel(limited, "A/c") {
		t.Error("白名单内的模型应被允许")
	}
	if tokenAllowsModel(limited, "B/d") {
		t.Error("白名单外的模型应被拒绝")
	}
	wildcard := store.Token{AllowedModels: []string{"*"}}
	if !tokenAllowsModel(wildcard, "任意") {
		t.Error("通配符应允许所有模型")
	}
}

// 管理接口只能由登录会话访问。API 密钥是调用方调模型用的，
// 即使密钥有效（甚至被禁用）也不能获得任何管理权限。
func TestAdminEndpointsRequireSessionCookie(t *testing.T) {
	s, st := newTestServer(t, "auth-admin")
	key, err := s.EnsureDefaultToken()
	if err != nil {
		t.Fatal(err)
	}
	gw := httptest.NewServer(s.Handler())
	defer gw.Close()

	do := func(path, apiKey string, cookie *http.Cookie) int {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, gw.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		if apiKey != "" {
			req.Header.Set("Authorization", "Bearer "+apiKey)
		}
		if cookie != nil {
			req.AddCookie(cookie)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, resp.Body)
		return resp.StatusCode
	}

	// API 密钥仍然可以正常获取模型列表
	if code := do("/v1/models", key, nil); code != http.StatusOK {
		t.Fatalf("API 密钥调用 /v1/models 应成功，得到 %d", code)
	}
	// 但所有管理接口都必须拒绝 API 密钥
	for _, path := range []string{"/api/channels", "/api/tokens", "/api/auth/me"} {
		if code := do(path, key, nil); code != http.StatusUnauthorized {
			t.Errorf("API 密钥访问 %s 应返回 401，得到 %d", path, code)
		}
	}

	// 密钥被禁用后同样不能访问管理接口
	tok, err := st.FindTokenByKey(key)
	if err != nil {
		t.Fatal(err)
	}
	tok.Enabled = false
	if err := st.SaveToken(tok); err != nil {
		t.Fatal(err)
	}
	if code := do("/api/channels", key, nil); code != http.StatusUnauthorized {
		t.Errorf("已禁用密钥访问管理接口应返回 401，得到 %d", code)
	}

	// 登录会话仍然可以正常访问
	sess, err := s.issueSession()
	if err != nil {
		t.Fatal(err)
	}
	if code := do("/api/channels", "", &http.Cookie{Name: sessionCookie, Value: sess}); code != http.StatusOK {
		t.Errorf("登录会话访问管理接口应成功，得到 %d", code)
	}
}

// 改密后所有旧会话必须立即失效。
func TestPasswordChangeInvalidatesSessions(t *testing.T) {
	s, _ := newTestServer(t, "pwd-sessions")
	old, err := s.issueSession()
	if err != nil {
		t.Fatal(err)
	}
	if !s.verifySession(old) {
		t.Fatal("改密前的会话应有效")
	}
	if err := s.SetPassword("newpass123"); err != nil {
		t.Fatal(err)
	}
	if s.verifySession(old) {
		t.Error("改密后旧会话应立即失效")
	}
	fresh, err := s.issueSession()
	if err != nil {
		t.Fatal(err)
	}
	if !s.verifySession(fresh) {
		t.Error("改密后新签发的会话应有效")
	}
	if !s.CheckPassword("newpass123") {
		t.Error("新密码应能通过校验")
	}
}

// 保存渠道的响应不能回传明文上游密钥。
func TestSaveChannelResponseMasksAPIKey(t *testing.T) {
	s, st := newTestServer(t, "channel-mask")
	now := time.Now().UnixMilli()
	const rawKey = "sk-upstream-secret-123456"
	if err := st.SaveChannel(store.Channel{
		ID: "c", Name: "渠道", Type: store.ChannelOpenAI, BaseURL: "https://example.com",
		APIKey: rawKey, Models: []string{"m"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPut, "/api/channels/c", strings.NewReader("{}"))
	req.SetPathValue("id", "c")
	rec := httptest.NewRecorder()
	s.saveChannel(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 %d: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), rawKey) {
		t.Error("响应不应包含明文上游密钥")
	}
	var resp struct {
		Channel store.Channel `json:"channel"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Channel.APIKey != maskKey(rawKey) {
		t.Errorf("密钥应脱敏为 %q，得到 %q", maskKey(rawKey), resp.Channel.APIKey)
	}
}

// 密码错误时应按配置的延迟返回。
func TestLoginWrongPasswordDelays(t *testing.T) {
	s, _ := newTestServer(t, "login-delay")
	oldDelay := loginFailureDelay
	loginFailureDelay = 20 * time.Millisecond
	defer func() { loginFailureDelay = oldDelay }()

	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"password":"wrong"}`))
	rec := httptest.NewRecorder()
	start := time.Now()
	s.handleLogin(rec, req)
	elapsed := time.Since(start)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("错误密码应返回 401，得到 %d", rec.Code)
	}
	if elapsed < loginFailureDelay {
		t.Errorf("错误密码应至少延迟 %v，实际 %v", loginFailureDelay, elapsed)
	}
}

func TestLoginLimiterSlidingWindow(t *testing.T) {
	l := newLoginLimiter()
	now := time.Now()
	for i := 0; i < loginMaxAttempts; i++ {
		if ok, _ := l.allow("1.2.3.4", now); !ok {
			t.Fatalf("第 %d 次尝试应被允许", i+1)
		}
	}
	if ok, retry := l.allow("1.2.3.4", now); ok || retry <= 0 {
		t.Errorf("第 %d 次尝试应被拒绝并给出等待时间，得到 ok=%v retry=%v", loginMaxAttempts+1, ok, retry)
	}
	// 其他 IP 不受影响
	if ok, _ := l.allow("5.6.7.8", now); !ok {
		t.Error("不同 IP 应各自计数")
	}
	// 窗口过去后恢复
	if ok, _ := l.allow("1.2.3.4", now.Add(loginWindow+time.Second)); !ok {
		t.Error("窗口过后应恢复")
	}
}

func TestLoginHandlerRateLimit(t *testing.T) {
	s, _ := newTestServer(t, "login-rate")
	oldDelay := loginFailureDelay
	loginFailureDelay = time.Millisecond
	defer func() { loginFailureDelay = oldDelay }()

	do := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"password":"wrong"}`))
		rec := httptest.NewRecorder()
		s.handleLogin(rec, req)
		return rec
	}
	for i := 0; i < loginMaxAttempts; i++ {
		if rec := do(); rec.Code != http.StatusUnauthorized {
			t.Fatalf("第 %d 次应返回 401，得到 %d", i+1, rec.Code)
		}
	}
	rec := do()
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("第 %d 次应返回 429，得到 %d", loginMaxAttempts+1, rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Error("限流响应应带 Retry-After")
	}
}

func TestValidateChannelID(t *testing.T) {
	ok := []string{"A", "openai-main", "渠道1", "a_b.c"}
	for _, id := range ok {
		if err := validateChannelID(id); err != nil {
			t.Errorf("%q 应合法，却报错 %v", id, err)
		}
	}
	bad := []string{"", "A/B", "a b", "x\ty"}
	for _, id := range bad {
		if err := validateChannelID(id); err == nil {
			t.Errorf("%q 应被拒绝", id)
		}
	}
	if err := validateChannelID(string(make([]byte, 65))); err == nil {
		t.Error("超长 ID 应被拒绝")
	}
}

func TestNormalizeModelNames(t *testing.T) {
	got, err := normalizeModelNames([]string{"a,b,c"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Errorf("逗号分隔应解析出 3 个模型，得到 %v", got)
	}

	got, _ = normalizeModelNames([]string{"a\nb\r\nc;d", "a"})
	want := []string{"a", "b", "c", "d"}
	if len(got) != len(want) {
		t.Fatalf("换行/分号/去重后应有 %d 个，得到 %v", len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("第 %d 个应为 %s，得到 %s", i, want[i], got[i])
		}
	}

	got, _ = normalizeModelNames([]string{"  ", "", "  x  "})
	if len(got) != 1 || got[0] != "x" {
		t.Errorf("应忽略空白项并 trim，得到 %v", got)
	}
}

func TestSplitChannelModel(t *testing.T) {
	cases := []struct {
		in string
		ch string
		up string
		ok bool
	}{
		{"A/a", "A", "a", true},
		{"A/deepseek/chat", "A", "deepseek/chat", true},
		{"A", "", "", false},
		{"/a", "", "", false},
		{"A/", "", "", false},
		{"", "", "", false},
	}
	for _, c := range cases {
		ch, up, ok := splitChannelModel(c.in)
		if ok != c.ok || ch != c.ch || up != c.up {
			t.Errorf("splitChannelModel(%q) = (%q,%q,%v)，期望 (%q,%q,%v)", c.in, ch, up, ok, c.ch, c.up, c.ok)
		}
	}
}

func TestSessionRoundTrip(t *testing.T) {
	st, err := store.Open(t.TempDir() + "/s.db")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	s := New(st)

	token, err := s.issueSession()
	if err != nil {
		t.Fatal(err)
	}
	if !s.verifySession(token) {
		t.Error("刚签发的会话应校验通过")
	}
	if s.verifySession(token + "x") {
		t.Error("被篡改的会话不应通过校验")
	}
	if s.verifySession("garbage") {
		t.Error("格式错误的会话不应通过校验")
	}
	if s.verifySession("") {
		t.Error("空会话不应通过校验")
	}
}

func TestDefaultPasswordBootstrap(t *testing.T) {
	st, err := store.Open(t.TempDir() + "/p.db")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	s := New(st)

	isDefault, err := s.EnsureDefaultPassword()
	if err != nil {
		t.Fatal(err)
	}
	if !isDefault {
		t.Error("首次启动应写入默认密码")
	}
	if !s.CheckPassword(DefaultPassword) {
		t.Error("默认密码应为 " + DefaultPassword)
	}
	if s.CheckPassword("wrong") {
		t.Error("错误密码不应通过")
	}
	if err := s.SetPassword("newpass123"); err != nil {
		t.Fatal(err)
	}
	if s.CheckPassword(DefaultPassword) {
		t.Error("改密后旧密码不应再有效")
	}
	if !s.CheckPassword("newpass123") {
		t.Error("新密码应生效")
	}
	if err := s.SetPassword("abc"); err == nil {
		t.Error("过短的密码应被拒绝")
	}
}

func TestEnsureDefaultTokenOnlyOnce(t *testing.T) {
	st, err := store.Open(t.TempDir() + "/t.db")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	s := New(st)

	key, err := s.EnsureDefaultToken()
	if err != nil {
		t.Fatal(err)
	}
	if key == "" {
		t.Fatal("首次调用应生成密钥")
	}
	if len(key) < 12 {
		t.Errorf("密钥过短: %q", key)
	}
	again, err := s.EnsureDefaultToken()
	if err != nil {
		t.Fatal(err)
	}
	if again != "" {
		t.Error("已有密钥时不应重复生成")
	}
	tokens, _ := st.ListTokens()
	if len(tokens) != 1 {
		t.Errorf("应只有一个密钥，实际 %d", len(tokens))
	}
}

func TestAtoiDefault(t *testing.T) {
	cases := []struct {
		in   string
		def  int
		want int
	}{
		{"", 5, 5},
		{"abc", 5, 5},
		{"12", 5, 12},
		{"-3", 5, -3},
		{"1x", 5, 5},
	}
	for _, c := range cases {
		if got := atoiDefault(c.in, c.def); got != c.want {
			t.Errorf("atoiDefault(%q,%d) = %d，期望 %d", c.in, c.def, got, c.want)
		}
	}
}

func TestParseModelIDs(t *testing.T) {
	openai := []byte(`{"object":"list","data":[{"id":"gpt-4o"},{"id":"o3-mini"}]}`)
	got := parseModelIDs(openai)
	if len(got) != 2 || got[0] != "gpt-4o" {
		t.Errorf("OpenAI 格式解析失败: %v", got)
	}
	gemini := []byte(`{"models":[{"name":"models/gemini-2.0-flash"},{"name":"models/gemini-1.5-pro"}]}`)
	got = parseModelIDs(gemini)
	if len(got) != 2 || got[0] != "gemini-2.0-flash" {
		t.Errorf("Gemini 格式解析失败: %v", got)
	}
	// 火山方舟会返回已下线模型，status=Shutdown 的不应出现在列表里
	ark := []byte(`{"data":[{"id":"doubao-live"},{"id":"doubao-old","status":"Shutdown"}]}`)
	got = parseModelIDs(ark)
	if len(got) != 1 || got[0] != "doubao-live" {
		t.Errorf("方舟模型列表应过滤已下线模型: %v", got)
	}
	if got := parseModelIDs([]byte(`{}`)); got != nil {
		t.Errorf("空响应应返回 nil，得到 %v", got)
	}
}

func TestMaskKey(t *testing.T) {
	if got := maskKey(""); got != "" {
		t.Errorf("空密钥应返回空串，得到 %q", got)
	}
	if got := maskKey("short"); got != "****" {
		t.Errorf("短密钥应完全掩码，得到 %q", got)
	}
	got := maskKey("sk-1234567890abcdef")
	if got == "sk-1234567890abcdef" {
		t.Error("密钥不应被原样返回")
	}
	if got[:3] != "sk-" || got[len(got)-4:] != "cdef" {
		t.Errorf("掩码应保留首尾，得到 %q", got)
	}
}

// ---------- 渠道模型探测 ----------

// fakeModelsServer 返回一个假的模型列表上游，并记录收到的 Authorization 头。
func fakeModelsServer(seenAuth *string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/models") {
			http.NotFound(w, r)
			return
		}
		if seenAuth != nil {
			*seenAuth = r.Header.Get("Authorization")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"object":"list","data":[{"id":"a"},{"id":"b"}]}`))
	}))
}

func newTestServer(t *testing.T, name string) (*Server, *store.Store) {
	t.Helper()
	st, err := store.Open(t.TempDir() + "/" + name + ".db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return New(st), st
}

func callDiscover(t *testing.T, s *Server, payload map[string]any) (int, map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/api/channels/discover", strings.NewReader(string(raw)))
	rec := httptest.NewRecorder()
	s.discoverChannelModels(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// 渠道还没保存时就应该能拉取模型列表，这是解开「要获取模型必须先保存」死循环的关键。
func TestDiscoverWorksBeforeChannelIsSaved(t *testing.T) {
	srv := fakeModelsServer(nil)
	defer srv.Close()
	s, st := newTestServer(t, "d1")

	code, out := callDiscover(t, s, map[string]any{
		"id": "A", "type": "openai", "base_url": srv.URL, "api_key": "sk-live",
	})
	if code != http.StatusOK {
		t.Fatalf("状态码 %d: %v", code, out)
	}
	models, _ := out["models"].([]any)
	if len(models) != 2 {
		t.Fatalf("应返回 2 个模型，得到 %v", out["models"])
	}
	// 探测不应该产生副作用
	if _, err := st.GetChannel("A"); err != store.ErrNotFound {
		t.Error("探测不应该把渠道写进数据库")
	}
}

// 编辑已保存渠道时表单里显示的是掩码密钥，此时应回退到保存的真实密钥。
func TestDiscoverFallsBackToSavedKey(t *testing.T) {
	var seenAuth string
	srv := fakeModelsServer(&seenAuth)
	defer srv.Close()
	s, st := newTestServer(t, "d2")

	if err := st.SaveChannel(store.Channel{
		ID: "A", Type: store.ChannelOpenAI, BaseURL: srv.URL, APIKey: "sk-real-secret", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}

	code, out := callDiscover(t, s, map[string]any{
		"id": "A", "type": "openai", "base_url": srv.URL, "api_key": "sk-r****cret",
	})
	if code != http.StatusOK {
		t.Fatalf("状态码 %d: %v", code, out)
	}
	if seenAuth != "Bearer sk-real-secret" {
		t.Errorf("应使用已保存的真实密钥，上游实际收到 %q", seenAuth)
	}
}

func TestDiscoverRejectsIncompleteInput(t *testing.T) {
	s, _ := newTestServer(t, "d3")

	if code, _ := callDiscover(t, s, map[string]any{"id": "A", "type": "openai"}); code != http.StatusBadRequest {
		t.Errorf("地址与密钥都为空时应返回 400，得到 %d", code)
	}
	code, _ := callDiscover(t, s, map[string]any{
		"id": "A", "type": "not-a-real-type", "base_url": "http://x", "api_key": "k",
	})
	if code != http.StatusBadRequest {
		t.Errorf("未知渠道类型应返回 400，得到 %d", code)
	}
}

// 空模型列表的渠道必须能保存，否则「先建渠道后补模型」的流程走不通。
func TestSaveChannelWithNoModels(t *testing.T) {
	s, st := newTestServer(t, "d4")

	raw, _ := json.Marshal(map[string]any{
		"id": "B", "name": "备用", "type": "openai",
		"base_url": "http://127.0.0.1:1/v1", "api_key": "k", "models": []string{},
	})
	req := httptest.NewRequest(http.MethodPut, "/api/channels/B", strings.NewReader(string(raw)))
	req.SetPathValue("id", "B")
	rec := httptest.NewRecorder()
	s.saveChannel(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("空模型渠道应能保存，状态码 %d: %s", rec.Code, rec.Body.String())
	}
	ch, err := st.GetChannel("B")
	if err != nil {
		t.Fatal(err)
	}
	if len(ch.Models) != 0 {
		t.Errorf("模型列表应为空，得到 %v", ch.Models)
	}
}

// 渠道列表要同时给出原始模型名和派生 ID：前端展示前者，模型管理使用后者。
func TestChannelListExposesRawModelNames(t *testing.T) {
	s, st := newTestServer(t, "d5")
	if err := st.SaveChannel(store.Channel{
		ID: "A", Type: store.ChannelOpenAI, BaseURL: "http://x", APIKey: "k",
		Models: []string{"a", "b"}, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/channels", nil)
	rec := httptest.NewRecorder()
	s.listChannels(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 %d", rec.Code)
	}
	var items []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &items); err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("应返回 1 个渠道，得到 %d", len(items))
	}
	models, _ := items[0]["models"].([]any)
	if len(models) != 2 || models[0] != "a" {
		t.Errorf("原始模型名应为 [a b]，得到 %v", items[0]["models"])
	}
	ids, _ := items[0]["channel_models"].([]any)
	if len(ids) != 2 || ids[0] != "A/a" {
		t.Errorf("派生 ID 应为 [A/a A/b]，得到 %v", items[0]["channel_models"])
	}
}

// 自定义模型的可用性按「至少一条路由可用」判断：
// 调度会跳过渠道禁用的条目，不能因为部分条目不可用就把整个模型标成不可用。
func TestCustomModelReadyIfAnyRouteChannelEnabled(t *testing.T) {
	s, st := newTestServer(t, "ready1")
	if err := st.SaveChannel(store.Channel{
		ID: "on", Type: store.ChannelOpenAI, BaseURL: "http://x", APIKey: "k",
		Models: []string{"a"}, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveChannel(store.Channel{
		ID: "off", Type: store.ChannelOpenAI, BaseURL: "http://x", APIKey: "k",
		Models: []string{"b"}, Enabled: false,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "all", Type: store.ModelTypeCustom, Enabled: true,
		Routes: []store.Route{
			{ChannelID: "off", Upstream: "b"},
			{ChannelID: "on", Upstream: "a"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "down", Type: store.ModelTypeCustom, Enabled: true,
		Routes: []store.Route{{ChannelID: "off", Upstream: "b"}},
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	s.listModels(rec, httptest.NewRequest(http.MethodGet, "/api/models", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 %d", rec.Code)
	}
	type routeOut struct {
		ChannelID    string `json:"channel_id"`
		ChannelReady bool   `json:"channel_ready"`
	}
	type modelOut struct {
		ID           string     `json:"id"`
		ChannelReady bool       `json:"channel_ready"`
		Routes       []routeOut `json:"routes"`
	}
	var items []modelOut
	if err := json.Unmarshal(rec.Body.Bytes(), &items); err != nil {
		t.Fatal(err)
	}
	byID := map[string]modelOut{}
	for _, it := range items {
		byID[it.ID] = it
	}
	if !byID["all"].ChannelReady {
		t.Error("有一条渠道可用时，自定义模型应标记为可用")
	}
	if byID["down"].ChannelReady {
		t.Error("所有路由渠道都禁用时，自定义模型应标记为不可用")
	}
	for _, rt := range byID["all"].Routes {
		if rt.ChannelID == "off" && rt.ChannelReady {
			t.Error("禁用渠道的路由应单独标记为不可用")
		}
	}
}

// 接口地址必须显式填写，网关不会回退到官方地址。
func TestSaveChannelRequiresBaseURL(t *testing.T) {
	s, st := newTestServer(t, "u1")

	for _, tc := range []struct {
		name    string
		payload map[string]any
	}{
		{"地址为空", map[string]any{"id": "A", "type": "openai", "api_key": "k", "models": []string{}}},
		{"地址只有空白", map[string]any{"id": "A", "type": "openai", "base_url": "   ", "api_key": "k"}},
		{"地址缺少协议头", map[string]any{"id": "A", "type": "openai", "base_url": "api.openai.com", "api_key": "k"}},
	} {
		raw, _ := json.Marshal(tc.payload)
		req := httptest.NewRequest(http.MethodPut, "/api/channels/A", strings.NewReader(string(raw)))
		req.SetPathValue("id", "A")
		rec := httptest.NewRecorder()
		s.saveChannel(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s：应被拒绝，得到状态码 %d", tc.name, rec.Code)
		}
	}
	if _, err := st.GetChannel("A"); err != store.ErrNotFound {
		t.Error("被拒绝的渠道不应落库")
	}
}

// 渠道列表页的启停开关只提交 enabled：未提交的字段必须保持原值，
// 不能被空值覆盖（否则禁用渠道会误报「接口地址不能为空」）。
func TestSaveChannelPartialUpdate(t *testing.T) {
	s, st := newTestServer(t, "u4")

	if err := st.SaveChannel(store.Channel{
		ID: "A", Name: "主线路", Type: store.ChannelOpenAI,
		BaseURL: "https://api.example.com/v1", APIKey: "sk-live",
		Models: []string{"a", "b"}, Enabled: true,
		Headers: map[string]string{"X-Test": "1"}, Remark: "备注",
	}); err != nil {
		t.Fatal(err)
	}

	raw, _ := json.Marshal(map[string]any{"id": "A", "enabled": false})
	req := httptest.NewRequest(http.MethodPut, "/api/channels/A", strings.NewReader(string(raw)))
	req.SetPathValue("id", "A")
	rec := httptest.NewRecorder()
	s.saveChannel(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("仅提交 enabled 应能成功，状态码 %d: %s", rec.Code, rec.Body.String())
	}

	ch, err := st.GetChannel("A")
	if err != nil {
		t.Fatal(err)
	}
	if ch.Enabled {
		t.Error("enabled=false 应已生效")
	}
	if ch.BaseURL != "https://api.example.com/v1" || ch.Name != "主线路" || ch.Remark != "备注" {
		t.Errorf("未提交的字符串字段不应被覆盖，得到 %+v", ch)
	}
	if len(ch.Models) != 2 || ch.Models[0] != "a" {
		t.Errorf("未提交的模型列表不应被清空，得到 %v", ch.Models)
	}
	if ch.Headers["X-Test"] != "1" {
		t.Errorf("未提交的请求头不应被清空，得到 %v", ch.Headers)
	}
	if ch.APIKey != "sk-live" {
		t.Errorf("未提交的密钥不应被覆盖，得到 %q", ch.APIKey)
	}
}

// 显式提交空字符串才允许清空可选字段；接口地址例外，永远不能为空。
func TestSaveChannelExplicitClear(t *testing.T) {
	s, st := newTestServer(t, "u5")

	if err := st.SaveChannel(store.Channel{
		ID: "A", Name: "旧名", Type: store.ChannelOpenAI,
		BaseURL: "https://api.example.com/v1", APIKey: "sk-live",
		Models: []string{"a"}, Remark: "旧备注",
	}); err != nil {
		t.Fatal(err)
	}

	raw, _ := json.Marshal(map[string]any{
		"id": "A", "name": "", "remark": "", "models": []string{}, "base_url": "https://new.example.com",
	})
	req := httptest.NewRequest(http.MethodPut, "/api/channels/A", strings.NewReader(string(raw)))
	req.SetPathValue("id", "A")
	rec := httptest.NewRecorder()
	s.saveChannel(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("显式清空可选字段应能保存，状态码 %d: %s", rec.Code, rec.Body.String())
	}
	ch, err := st.GetChannel("A")
	if err != nil {
		t.Fatal(err)
	}
	if ch.Name != "" || ch.Remark != "" || len(ch.Models) != 0 {
		t.Errorf("显式空值应清空可选字段，得到 %+v", ch)
	}
	if ch.BaseURL != "https://new.example.com" {
		t.Errorf("接口地址应更新为新值，得到 %q", ch.BaseURL)
	}

	// 接口地址显式提交空值依旧拒绝
	raw, _ = json.Marshal(map[string]any{"id": "A", "base_url": "   "})
	req = httptest.NewRequest(http.MethodPut, "/api/channels/A", strings.NewReader(string(raw)))
	req.SetPathValue("id", "A")
	rec = httptest.NewRecorder()
	s.saveChannel(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("显式提交空接口地址应被拒绝，得到 %d", rec.Code)
	}
}

// 渠道里删掉模型名时，不应直接改动模型管理：
// 先把仍被引用的条目录出来，等用户确认后再清理。
func TestChannelUpdateKeepsModelRefsUntilConfirmed(t *testing.T) {
	s, st := newTestServer(t, "refs1")

	if err := st.SaveChannel(store.Channel{
		ID: "A", Name: "主线路", Type: store.ChannelOpenAI,
		BaseURL: "https://api.example.com", APIKey: "sk-live",
		Models: []string{"a", "b"}, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	for _, up := range []string{"a", "b"} {
		if err := st.SaveModel(store.Model{
			ID: "A/" + up, Type: store.ModelTypeChannel, ChannelID: "A", Upstream: up, Enabled: true,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.SaveModel(store.Model{
		ID: "router", Type: store.ModelTypeCustom, Enabled: true,
		Routes: []store.Route{
			{ChannelID: "A", Upstream: "a"},
			{ChannelID: "A", Upstream: "b"},
		},
	}); err != nil {
		t.Fatal(err)
	}

	saveChannel := func(models []string) map[string]any {
		t.Helper()
		raw, _ := json.Marshal(map[string]any{"id": "A", "models": models})
		req := httptest.NewRequest(http.MethodPut, "/api/channels/A", strings.NewReader(string(raw)))
		req.SetPathValue("id", "A")
		rec := httptest.NewRecorder()
		s.saveChannel(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("保存渠道失败，状态码 %d: %s", rec.Code, rec.Body.String())
		}
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return out
	}

	out := saveChannel([]string{"b"})
	gone, _ := out["removed_upstreams"].([]any)
	if len(gone) != 1 || gone[0] != "a" {
		t.Fatalf("应报告移除 a，得到 %v", out["removed_upstreams"])
	}
	refs, _ := out["refs"].([]any)
	if len(refs) != 2 {
		t.Fatalf("应报告 2 条引用（渠道模型 + 自定义路由），得到 %v", refs)
	}

	// 未确认前，模型和路由都必须原样保留。
	if _, err := st.GetModel("A/a"); err != nil {
		t.Fatalf("A/a 不应被自动删除: %v", err)
	}
	router, err := st.GetModel("router")
	if err != nil {
		t.Fatal(err)
	}
	if len(router.Routes) != 2 {
		t.Fatalf("自定义模型路由不应被自动清理，得到 %v", router.Routes)
	}

	// 孤立模型仍能正常启停和编辑，不能因为渠道列表变了就锁死。
	raw, _ := json.Marshal(map[string]any{"enabled": false})
	req := httptest.NewRequest(http.MethodPut, "/api/models/A/a", strings.NewReader(string(raw)))
	req.SetPathValue("id", "A/a")
	rec := httptest.NewRecorder()
	s.saveModel(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("孤立渠道模型应仍可编辑，状态码 %d: %s", rec.Code, rec.Body.String())
	}
	orphan, _ := st.GetModel("A/a")
	if orphan.Enabled {
		t.Error("孤立模型的启停修改应生效")
	}

	// 自定义模型原样保存旧路由也应通过。
	raw, _ = json.Marshal(map[string]any{
		"id": "router", "type": "custom",
		"routes": []map[string]any{
			{"channel_id": "A", "upstream": "a"},
			{"channel_id": "A", "upstream": "b"},
		},
	})
	req = httptest.NewRequest(http.MethodPut, "/api/models/router", strings.NewReader(string(raw)))
	req.SetPathValue("id", "router")
	rec = httptest.NewRecorder()
	s.saveModel(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("保留旧路由的自定义模型应可保存，状态码 %d: %s", rec.Code, rec.Body.String())
	}

	// 用户确认后清理引用；当前渠道仍声明的 b 不能被误删。
	raw, _ = json.Marshal(map[string]any{"upstreams": []string{"a", "b"}})
	req = httptest.NewRequest(http.MethodPost, "/api/channels/A/prune-refs", strings.NewReader(string(raw)))
	req.SetPathValue("id", "A")
	rec = httptest.NewRecorder()
	s.pruneChannelRefs(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("清理引用失败，状态码 %d: %s", rec.Code, rec.Body.String())
	}
	if _, err := st.GetModel("A/a"); err != store.ErrNotFound {
		t.Errorf("确认后 A/a 应被删除，得到 err=%v", err)
	}
	if _, err := st.GetModel("A/b"); err != nil {
		t.Errorf("当前渠道仍声明的 A/b 不应被删除: %v", err)
	}
	router, err = st.GetModel("router")
	if err != nil {
		t.Fatal(err)
	}
	if len(router.Routes) != 1 || router.Routes[0].Upstream != "b" {
		t.Errorf("确认后只应保留 b 路由，得到 %v", router.Routes)
	}
}

// 删除渠道只删渠道本身：模型管理里的渠道模型和自定义路由都必须保留，
// 引用该渠道的模型自然变成不可用，由用户自己决定是否清理。
func TestDeleteChannelKeepsModelRefs(t *testing.T) {
	s, st := newTestServer(t, "del1")

	for _, ch := range []store.Channel{
		{ID: "A", Name: "A", Type: store.ChannelOpenAI, BaseURL: "https://a.example.com", APIKey: "k", Models: []string{"a", "b"}, Enabled: true},
		{ID: "B", Name: "B", Type: store.ChannelOpenAI, BaseURL: "https://b.example.com", APIKey: "k", Models: []string{"b"}, Enabled: true},
	} {
		if err := st.SaveChannel(ch); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{"A/a", "A/b", "B/b"} {
		chID, up, _ := strings.Cut(id, "/")
		if err := st.SaveModel(store.Model{
			ID: id, Type: store.ModelTypeChannel, ChannelID: chID, Upstream: up, Enabled: true,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.SaveModel(store.Model{
		ID: "router", Type: store.ModelTypeCustom, Enabled: true,
		Routes: []store.Route{
			{ChannelID: "A", Upstream: "a"},
			{ChannelID: "B", Upstream: "b"},
		},
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/channels/A", nil)
	req.SetPathValue("id", "A")
	rec := httptest.NewRecorder()
	s.deleteChannel(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("删除渠道失败，状态码 %d: %s", rec.Code, rec.Body.String())
	}
	if _, err := st.GetChannel("A"); err != store.ErrNotFound {
		t.Error("渠道 A 应被删除")
	}
	for _, id := range []string{"A/a", "A/b", "B/b"} {
		if _, err := st.GetModel(id); err != nil {
			t.Errorf("模型 %s 不应随渠道删除: %v", id, err)
		}
	}
	router, err := st.GetModel("router")
	if err != nil {
		t.Fatal(err)
	}
	if len(router.Routes) != 2 {
		t.Errorf("自定义模型路由不应随渠道删除，得到 %v", router.Routes)
	}

	// 保留的模型仍能启停；自定义模型带着失效旧路由也能继续编辑。
	raw, _ := json.Marshal(map[string]any{"enabled": false})
	req = httptest.NewRequest(http.MethodPut, "/api/models/A/b", strings.NewReader(string(raw)))
	req.SetPathValue("id", "A/b")
	rec = httptest.NewRecorder()
	s.saveModel(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("渠道删除后孤立模型应仍可编辑，状态码 %d: %s", rec.Code, rec.Body.String())
	}

	raw, _ = json.Marshal(map[string]any{
		"id": "router", "type": "custom", "enabled": true,
		"routes": []map[string]any{
			{"channel_id": "A", "upstream": "a"},
			{"channel_id": "B", "upstream": "b"},
		},
	})
	req = httptest.NewRequest(http.MethodPut, "/api/models/router", strings.NewReader(string(raw)))
	req.SetPathValue("id", "router")
	rec = httptest.NewRecorder()
	s.saveModel(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("带失效旧路由的自定义模型应仍可保存，状态码 %d: %s", rec.Code, rec.Body.String())
	}

	// 指向已删除渠道的新路由也不再阻止保存，只会在状态里标出来。
	raw, _ = json.Marshal(map[string]any{
		"id": "router", "type": "custom", "enabled": true,
		"routes": []map[string]any{
			{"channel_id": "A", "upstream": "a"},
			{"channel_id": "B", "upstream": "b"},
			{"channel_id": "A", "upstream": "c"},
		},
	})
	req = httptest.NewRequest(http.MethodPut, "/api/models/router", strings.NewReader(string(raw)))
	req.SetPathValue("id", "router")
	rec = httptest.NewRecorder()
	s.saveModel(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("指向已删除渠道的路由应允许保存，状态码 %d: %s", rec.Code, rec.Body.String())
	}
	router, err = st.GetModel("router")
	if err != nil {
		t.Fatal(err)
	}
	if len(router.Routes) != 3 {
		t.Errorf("新路由应被保存，得到 %v", router.Routes)
	}

	// 渠道 A 的模型变为不可用；还有 B 路由的自定义模型仍然可用。
	req = httptest.NewRequest(http.MethodGet, "/api/models", nil)
	rec = httptest.NewRecorder()
	s.listModels(rec, req)
	var views []modelView
	if err := json.Unmarshal(rec.Body.Bytes(), &views); err != nil {
		t.Fatal(err)
	}
	for _, v := range views {
		switch v.ID {
		case "A/a":
			if v.ChannelReady {
				t.Error("渠道删除后 A/a 应显示为不可用")
			}
			if v.Status != statusChannelMissing {
				t.Errorf("A/a 状态应为 %s，得到 %s", statusChannelMissing, v.Status)
			}
		case "router":
			if !v.ChannelReady {
				t.Error("router 还有可用路由，不应整体不可用")
			}
			if v.Status != statusOK {
				t.Errorf("router 状态应为 %s，得到 %s", statusOK, v.Status)
			}
			for _, r := range v.Routes {
				switch r.ModelID {
				case "A/a", "A/c":
					if r.Status != statusChannelMissing {
						t.Errorf("%s 路由状态应为 %s，得到 %s", r.ModelID, statusChannelMissing, r.Status)
					}
				case "B/b":
					if r.Status != statusOK {
						t.Errorf("%s 路由状态应为 %s，得到 %s", r.ModelID, statusOK, r.Status)
					}
				}
			}
		}
	}
}

// 删除渠道时确认「同时移除模型」后，才清理渠道模型与自定义路由。
func TestDeleteChannelWithRefs(t *testing.T) {
	s, st := newTestServer(t, "del2")

	if err := st.SaveChannel(store.Channel{
		ID: "A", Name: "A", Type: store.ChannelOpenAI,
		BaseURL: "https://a.example.com", APIKey: "k",
		Models: []string{"a", "b"}, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	for _, up := range []string{"a", "b"} {
		if err := st.SaveModel(store.Model{
			ID: "A/" + up, Type: store.ModelTypeChannel, ChannelID: "A", Upstream: up, Enabled: true,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.SaveModel(store.Model{
		ID: "router", Type: store.ModelTypeCustom, Enabled: true,
		Routes: []store.Route{{ChannelID: "A", Upstream: "a"}},
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/channels/A/refs", nil)
	req.SetPathValue("id", "A")
	rec := httptest.NewRecorder()
	s.listChannelRefs(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("读取引用失败，状态码 %d: %s", rec.Code, rec.Body.String())
	}
	var refsOut struct {
		Refs []channelRefView `json:"refs"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &refsOut); err != nil {
		t.Fatal(err)
	}
	if len(refsOut.Refs) != 3 {
		t.Fatalf("应有 3 条引用（2 个渠道模型 + 1 条路由），得到 %+v", refsOut.Refs)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/channels/A?remove_refs=1", nil)
	req.SetPathValue("id", "A")
	rec = httptest.NewRecorder()
	s.deleteChannel(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("删除渠道失败，状态码 %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Removed []string `json:"removed_models"`
		Updated []string `json:"updated_models"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Removed) != 2 {
		t.Errorf("应移除 2 个渠道模型，得到 %v", out.Removed)
	}
	if len(out.Updated) != 1 || out.Updated[0] != "router" {
		t.Errorf("应清理 router 的路由，得到 %v", out.Updated)
	}
	if _, err := st.GetChannel("A"); err != store.ErrNotFound {
		t.Error("渠道 A 应被删除")
	}
	if _, err := st.GetModel("A/a"); err != store.ErrNotFound {
		t.Error("确认后 A/a 应被删除")
	}
	router, err := st.GetModel("router")
	if err != nil {
		t.Fatal(err)
	}
	if len(router.Routes) != 0 {
		t.Errorf("router 的 A 路由应被清理，得到 %v", router.Routes)
	}
}

// 启停等部分更新只能改 enabled，不能把路由、参数、描述等已有配置清空。
func TestModelPartialUpdateKeepsConfig(t *testing.T) {
	s, st := newTestServer(t, "partial1")
	if err := st.SaveChannel(store.Channel{
		ID: "A", Name: "A", Type: store.ChannelOpenAI,
		BaseURL: "https://a.example.com", APIKey: "k", Models: []string{"a"}, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	ctx := 128000
	tool := true
	if err := st.SaveModel(store.Model{
		ID: "A/a", Type: store.ModelTypeChannel, ChannelID: "A", Upstream: "a", Enabled: true,
		DisplayName: "A 模型", Description: "渠道模型描述", Tags: []string{"tag-a"},
		Caps: store.Caps{ContextLength: &ctx, ToolCalling: &tool}, Timeout: 45,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "router", Type: store.ModelTypeCustom, Enabled: true,
		Routes:      []store.Route{{ChannelID: "A", Upstream: "a"}},
		DisplayName: "路由模型", Description: "自定义描述", Tags: []string{"tag-b"},
		Caps:     store.Caps{MaxOutput: &ctx},
		Affinity: true, CooldownSec: 120, CooldownReset: true, Timeout: 60,
	}); err != nil {
		t.Fatal(err)
	}

	put := func(id string, body map[string]any) {
		t.Helper()
		raw, _ := json.Marshal(body)
		req := httptest.NewRequest(http.MethodPut, "/api/models/"+id, strings.NewReader(string(raw)))
		req.SetPathValue("id", id)
		rec := httptest.NewRecorder()
		s.saveModel(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s 部分更新失败，状态码 %d: %s", id, rec.Code, rec.Body.String())
		}
	}

	// 只提交 enabled：渠道模型的描述、标签、能力参数都要保留。
	put("A/a", map[string]any{"enabled": false})
	chModel, err := st.GetModel("A/a")
	if err != nil {
		t.Fatal(err)
	}
	if chModel.Enabled {
		t.Error("渠道模型应已禁用")
	}
	if chModel.DisplayName != "A 模型" || chModel.Description != "渠道模型描述" || len(chModel.Tags) != 1 {
		t.Errorf("渠道模型的展示信息被清空: %+v", chModel)
	}
	if chModel.Caps.ContextLength == nil || *chModel.Caps.ContextLength != ctx {
		t.Errorf("渠道模型的能力参数被清空: %+v", chModel.Caps)
	}
	if chModel.Timeout != 45 {
		t.Errorf("渠道模型的超时时间被清空: %+v", chModel)
	}

	// 只提交 enabled：自定义模型的路由、调度、描述都要保留。
	put("router", map[string]any{"enabled": false})
	m, err := st.GetModel("router")
	if err != nil {
		t.Fatal(err)
	}
	if m.Enabled {
		t.Error("自定义模型应已禁用")
	}
	if len(m.Routes) != 1 || m.Routes[0].ChannelID != "A" || m.Routes[0].Upstream != "a" {
		t.Errorf("自定义模型路由被清空: %+v", m.Routes)
	}
	if m.DisplayName != "路由模型" || m.Description != "自定义描述" || len(m.Tags) != 1 {
		t.Errorf("自定义模型的配置被清空: %+v", m)
	}
	if !m.Affinity || m.CooldownSec != 120 || !m.CooldownReset {
		t.Errorf("自定义模型的调度配置被清空: %+v", m)
	}
	if m.Caps.MaxOutput == nil || *m.Caps.MaxOutput != ctx {
		t.Errorf("自定义模型的能力参数被清空: %+v", m.Caps)
	}
	if m.Timeout != 60 {
		t.Errorf("自定义模型的超时时间被清空: %+v", m)
	}

	// 显式提交空值仍然可以清空，保证编辑表单能正常保存。
	put("router", map[string]any{
		"description": "", "tags": []string{}, "caps": map[string]any{}, "routes": []map[string]any{},
		"affinity": false, "cooldown_sec": 0, "cooldown_reset": false, "timeout": 0,
	})
	m, err = st.GetModel("router")
	if err != nil {
		t.Fatal(err)
	}
	if m.Description != "" || len(m.Tags) != 0 || len(m.Routes) != 0 {
		t.Errorf("显式空值应清空配置: %+v", m)
	}
	if m.Caps.ContextLength != nil || m.Caps.MaxOutput != nil {
		t.Errorf("显式空 caps 应清空能力参数: %+v", m.Caps)
	}
	if m.Affinity || m.CooldownSec != 0 || m.CooldownReset {
		t.Errorf("显式空值应清空调度配置: %+v", m)
	}
	if m.Timeout != 0 {
		t.Errorf("显式 timeout=0 应恢复默认: %+v", m)
	}
}

// 清除冷却支持按模型、按渠道缩小范围；不传参数时保持原来的全局清空。
func TestClearCooldownsScoped(t *testing.T) {
	s, st := newTestServer(t, "clear-cooldowns")
	relay.ClearAllCooldowns()
	defer relay.ClearAllCooldowns()
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "CM", Type: store.ModelTypeCustom,
		Routes:  []store.Route{{ChannelID: "CH-A", Upstream: "x"}, {ChannelID: "CH-B", Upstream: "y"}},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	call := func(query string, body string) (int, int) {
		t.Helper()
		var rd io.Reader
		if body != "" {
			rd = strings.NewReader(body)
		}
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/models/clear-cooldowns"+query, rd)
		s.clearModelCooldowns(rec, req)
		var out struct {
			Cleared int `json:"cleared"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out.Cleared
	}

	relay.MarkFailure("CH-A", "x")
	relay.MarkFailure("CH-B", "y")
	if code, n := call("?model_id=CM", ""); code != http.StatusOK || n != 2 {
		t.Fatalf("按模型清冷却应清 2 条，得到 %d %d", code, n)
	}
	// 多选：body 里不存在的模型直接忽略
	relay.MarkFailure("CH-A", "x")
	relay.MarkFailure("CH-B", "y")
	if code, n := call("", `{"model_ids":["CM","missing"]}`); code != http.StatusOK || n != 2 {
		t.Fatalf("按模型批量清冷却应清 2 条，得到 %d %d", code, n)
	}
	relay.MarkFailure("CH-A", "x")
	if code, n := call("?channel_id=CH-A", ""); code != http.StatusOK || n != 1 {
		t.Fatalf("按渠道清冷却应清 1 条，得到 %d %d", code, n)
	}
	if code, _ := call("?model_id=missing", ""); code != http.StatusNotFound {
		t.Fatalf("模型不存在应返回 404，得到 %d", code)
	}
	relay.MarkFailure("CH-A", "x")
	if code, n := call("", ""); code != http.StatusOK || n != 1 {
		t.Fatalf("不传参数应清空全部冷却，得到 %d %d", code, n)
	}
}

// 模型状态要能区分：可用 / 渠道已禁用 / 渠道模型不存在 / 不可用 / 已禁用。
func TestModelStatusDetails(t *testing.T) {
	s, st := newTestServer(t, "status1")

	for _, ch := range []store.Channel{
		{ID: "A", Name: "A", Type: store.ChannelOpenAI, BaseURL: "https://a.example.com", APIKey: "k", Models: []string{"a"}, Enabled: true},
		{ID: "C", Name: "C", Type: store.ChannelOpenAI, BaseURL: "https://c.example.com", APIKey: "k", Models: []string{"c"}, Enabled: false},
		{ID: "D", Name: "D", Type: store.ChannelOpenAI, BaseURL: "https://d.example.com", APIKey: "k", Models: []string{}, Enabled: true},
	} {
		if err := st.SaveChannel(ch); err != nil {
			t.Fatal(err)
		}
	}
	for _, m := range []store.Model{
		{ID: "A/a", Type: store.ModelTypeChannel, ChannelID: "A", Upstream: "a", Enabled: true},
		{ID: "C/c", Type: store.ModelTypeChannel, ChannelID: "C", Upstream: "c", Enabled: true},
		{ID: "D/x", Type: store.ModelTypeChannel, ChannelID: "D", Upstream: "x", Enabled: true},
		{ID: "missing/z", Type: store.ModelTypeChannel, ChannelID: "missing", Upstream: "z", Enabled: true},
		{
			ID: "mixed", Type: store.ModelTypeCustom, Enabled: true,
			Routes: []store.Route{
				{ChannelID: "A", Upstream: "a"},
				{ChannelID: "C", Upstream: "c"},
				{ChannelID: "D", Upstream: "x"},
				{ChannelID: "missing", Upstream: "z"},
			},
		},
		{
			ID: "bad", Type: store.ModelTypeCustom, Enabled: true,
			Routes: []store.Route{
				{ChannelID: "C", Upstream: "c"},
				{ChannelID: "D", Upstream: "x"},
				{ChannelID: "missing", Upstream: "z"},
			},
		},
		{ID: "empty", Type: store.ModelTypeCustom, Enabled: true},
		{ID: "off", Type: store.ModelTypeCustom, Enabled: false, Routes: []store.Route{{ChannelID: "A", Upstream: "a"}}},
	} {
		if err := st.SaveModel(m); err != nil {
			t.Fatal(err)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/api/models", nil)
	rec := httptest.NewRecorder()
	s.listModels(rec, req)
	var views []modelView
	if err := json.Unmarshal(rec.Body.Bytes(), &views); err != nil {
		t.Fatal(err)
	}
	byID := map[string]modelView{}
	for _, v := range views {
		byID[v.ID] = v
	}

	want := map[string]string{
		"A/a":       statusOK,
		"C/c":       statusChannelDisabled,
		"D/x":       statusModelMissing,
		"missing/z": statusChannelMissing,
		"mixed":     statusOK,
		"bad":       statusUnavailable,
		"empty":     statusNoRoutes,
		"off":       statusDisabled,
	}
	for id, status := range want {
		if got := byID[id].Status; got != status {
			t.Errorf("%s 状态应为 %s，得到 %s", id, status, got)
		}
	}
	routeWant := map[string]string{
		"A/a":       statusOK,
		"C/c":       statusChannelDisabled,
		"D/x":       statusModelMissing,
		"missing/z": statusChannelMissing,
	}
	for _, r := range byID["mixed"].Routes {
		if got, ok := routeWant[r.ModelID]; ok && r.Status != got {
			t.Errorf("mixed 的路由 %s 状态应为 %s，得到 %s", r.ModelID, got, r.Status)
		}
	}
}

func TestDiscoverRequiresBaseURL(t *testing.T) {
	s, _ := newTestServer(t, "u2")

	// 只填了密钥、没填地址：必须报错，而不是拿默认地址去试
	code, out := callDiscover(t, s, map[string]any{"id": "A", "type": "openai", "api_key": "sk-x"})
	if code != http.StatusBadRequest {
		t.Errorf("缺少接口地址时应返回 400，得到 %d (%v)", code, out)
	}
	// 地址没有协议头同样拒绝
	code, _ = callDiscover(t, s, map[string]any{
		"id": "A", "type": "openai", "base_url": "api.openai.com", "api_key": "sk-x",
	})
	if code != http.StatusBadRequest {
		t.Errorf("地址缺少协议头时应返回 400，得到 %d", code)
	}
}

// 渠道没有接口地址时，转发必须明确报错，不能偷偷打到官方 API。
func TestRelayRefusesChannelWithoutBaseURL(t *testing.T) {
	s, st := newTestServer(t, "u3")
	if err := st.SaveChannel(store.Channel{
		ID: "A", Type: store.ChannelOpenAI, APIKey: "k", Models: []string{"a"}, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "A/a", Type: store.ModelTypeChannel, ChannelID: "A", Upstream: "a", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}

	body := `{"model":"A/a","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	rec := httptest.NewRecorder()
	res := s.relay.Do(req.Context(), rec, &relay.Request{
		Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{}, Body: []byte(body),
		JSON: map[string]any{"model": "A/a"},
	})

	if rec.Code == http.StatusOK {
		t.Fatal("没有接口地址的渠道不应转发成功")
	}
	// 内部配置错误只进日志，对外只给笼统的不可用提示。
	if !strings.Contains(rec.Body.String(), "暂不可用") {
		t.Errorf("应给出笼统错误，实际响应：%s", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "没有配置接口地址") {
		t.Errorf("不应把内部配置错误回给调用方：%s", rec.Body.String())
	}
	if !strings.Contains(res.Err, "没有配置接口地址") {
		t.Errorf("日志应保留内部原因，实际：%q", res.Err)
	}
	if !strings.Contains(res.ClientErr, "暂不可用") {
		t.Errorf("日志应记录对外返回，实际：%q", res.ClientErr)
	}
}

// 自定义请求体必须原样透传到上游：网关只改写模型名，不能丢掉用户额外加的字段。
func TestChatRawBodyPassesThrough(t *testing.T) {
	s, st := newTestServer(t, "chat-raw")
	var got map[string]any
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	defer up.Close()

	now := time.Now().UnixMilli()
	if err := st.SaveChannel(store.Channel{
		ID: "A", Type: store.ChannelOpenAI, BaseURL: up.URL,
		Models: []string{"a"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "A/a", Type: store.ModelTypeChannel, ChannelID: "A", Upstream: "a",
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	raw, _ := json.Marshal(map[string]any{"raw": map[string]any{
		"model":           "A/a",
		"messages":        []any{map[string]any{"role": "user", "content": "hi"}},
		"stream":          false,
		"response_format": map[string]any{"type": "json_object"},
		"custom_flag":     "x",
	}})
	req := httptest.NewRequest(http.MethodPost, "/api/chat", strings.NewReader(string(raw)))
	rec := httptest.NewRecorder()
	s.chat(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 %d: %s", rec.Code, rec.Body.String())
	}
	if got["model"] != "a" {
		t.Errorf("模型名应被改写成上游模型，得到 %v", got["model"])
	}
	if got["custom_flag"] != "x" {
		t.Errorf("自定义字段应透传，得到 %v", got["custom_flag"])
	}
	if rf, ok := got["response_format"].(map[string]any); !ok || rf["type"] != "json_object" {
		t.Errorf("response_format 应透传，得到 %v", got["response_format"])
	}
}

// 在线对话的采样参数要按开关原样转发：包括 0 值，也不能给没传的参数补默认值。
func TestChatPassesSamplingParameters(t *testing.T) {
	s, st := newTestServer(t, "chat-params")
	var got map[string]any
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = nil
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	defer up.Close()

	now := time.Now().UnixMilli()
	if err := st.SaveChannel(store.Channel{
		ID: "A", Type: store.ChannelOpenAI, BaseURL: up.URL,
		Models: []string{"a"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "A/a", Type: store.ModelTypeChannel, ChannelID: "A", Upstream: "a",
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	body := `{"model":"A/a","messages":[{"role":"user","content":"hi"}],"stream":false,` +
		`"temperature":0,"top_p":0.5,"frequency_penalty":-1.5,"presence_penalty":0.3,"max_tokens":128,"seed":42}`
	req := httptest.NewRequest(http.MethodPost, "/api/chat", strings.NewReader(body))
	rec := httptest.NewRecorder()
	s.chat(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 %d: %s", rec.Code, rec.Body.String())
	}
	want := map[string]float64{
		"temperature": 0, "top_p": 0.5, "frequency_penalty": -1.5,
		"presence_penalty": 0.3, "max_tokens": 128, "seed": 42,
	}
	for key, value := range want {
		if got[key] != value {
			t.Errorf("%s 应为 %v，得到 %v", key, value, got[key])
		}
	}

	// 只传部分参数时，其余参数不能凭空出现
	body = `{"model":"A/a","messages":[{"role":"user","content":"hi"}],"stream":false,"top_p":0.5}`
	req = httptest.NewRequest(http.MethodPost, "/api/chat", strings.NewReader(body))
	rec = httptest.NewRecorder()
	s.chat(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 %d: %s", rec.Code, rec.Body.String())
	}
	for _, key := range []string{"temperature", "frequency_penalty", "presence_penalty", "max_tokens", "seed"} {
		if _, ok := got[key]; ok {
			t.Errorf("未传的 %s 不应出现在请求体里，得到 %v", key, got[key])
		}
	}
}

func TestChatRawBodyRequiresModel(t *testing.T) {
	s, _ := newTestServer(t, "chat-raw-model")
	raw := `{"raw":{"messages":[{"role":"user","content":"hi"}]}}`
	req := httptest.NewRequest(http.MethodPost, "/api/chat", strings.NewReader(raw))
	rec := httptest.NewRecorder()
	s.chat(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("缺少 model 的自定义请求体应返回 400，得到 %d", rec.Code)
	}
}

// ---------- 输出速度 ----------

func TestTokensPerSecond(t *testing.T) {
	cases := []struct {
		name string
		log  store.Log
		want float64
	}{
		{"没有输出 token", store.Log{Stream: true, LatencyMs: 1000, FirstByteMs: 100}, 0},
		{"按生成耗时计算", store.Log{Stream: true, CompletionTokens: 100, LatencyMs: 5000, FirstByteMs: 1000}, 25},
		{"没有首字时间就用总耗时", store.Log{Stream: true, CompletionTokens: 100, LatencyMs: 4000}, 25},
		{"首字晚于总耗时则退回总耗时", store.Log{Stream: true, CompletionTokens: 50, LatencyMs: 1000, FirstByteMs: 2000}, 50},
		{"耗时为 0 不除零", store.Log{Stream: true, CompletionTokens: 10, LatencyMs: 0}, 0},
		// 非流式一次性返回，没有有意义的生成窗口，不展示速度
		{"非流式不算速度", store.Log{Stream: false, CompletionTokens: 100, LatencyMs: 5000, FirstByteMs: 1000}, 0},
	}
	for _, c := range cases {
		got := tokensPerSecond(c.log)
		if got != c.want {
			t.Errorf("%s: tokensPerSecond = %v，期望 %v", c.name, got, c.want)
		}
	}
}

// 平均速度只统计有首字、总耗时和速度的记录，并分别求平均。
func TestSumBucketsSpeed(t *testing.T) {
	got := sumBuckets([]store.Bucket{
		{Requests: 10, Errors: 1, SpeedCount: 2, SpeedSum: 30, SpeedLatencySum: 300, SpeedFirstByteSum: 100},
		{Requests: 5, SpeedCount: 2, SpeedSum: 10, SpeedLatencySum: 500, SpeedFirstByteSum: 300},
	})
	if got.SpeedSamples != 4 {
		t.Errorf("样本数应为 4，得到 %d", got.SpeedSamples)
	}
	if got.AvgSpeed != 10 {
		t.Errorf("平均速度应为 10，得到 %v", got.AvgSpeed)
	}
	if got.AvgSpeedLatency != 200 {
		t.Errorf("平均总耗时应为 200，得到 %v", got.AvgSpeedLatency)
	}
	if got.AvgFirstByte != 100 {
		t.Errorf("平均首字应为 100，得到 %v", got.AvgFirstByte)
	}

	empty := sumBuckets(nil)
	if empty.SpeedSamples != 0 || empty.AvgSpeed != 0 || empty.AvgFirstByte != 0 || empty.AvgSpeedLatency != 0 {
		t.Errorf("没有样本时平均速度应为 0，得到 %+v", empty)
	}
}

// 数据看板的平均速度只统计有首字、总耗时和速度的流式记录。
func TestStatsOverviewAverageSpeed(t *testing.T) {
	s, _ := newTestServer(t, "stats-speed")
	tok := store.Token{ID: "tk", Name: "测试"}

	// 流式且有首字：计入平均速度
	s.record(tok, &relay.Request{Path: "/v1/chat/completions", Stream: true}, &relay.Result{
		ModelID: "m", StatusCode: http.StatusOK, Stream: true,
		Usage:     upstream.Usage{CompletionTokens: 100, TotalTokens: 100},
		LatencyMs: 2000, FirstByteMs: 500,
	})
	// 非流式没有输出速度：不计入
	s.record(tok, &relay.Request{Path: "/v1/chat/completions"}, &relay.Result{
		ModelID: "m", StatusCode: http.StatusOK,
		Usage:     upstream.Usage{CompletionTokens: 100, TotalTokens: 100},
		LatencyMs: 1000, FirstByteMs: 100,
	})

	rec := httptest.NewRecorder()
	s.statsOverview(rec, httptest.NewRequest(http.MethodGet, "/api/stats/overview", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	var current map[string]any
	if err := json.Unmarshal(out["current"], &current); err != nil {
		t.Fatal(err)
	}
	if got := current["speed_samples"].(float64); got != 1 {
		t.Errorf("速度样本数应为 1，得到 %v", got)
	}
	if got := current["avg_speed"].(float64); math.Abs(got-1000.0/15) > 0.001 {
		t.Errorf("平均速度应为 %.4f，得到 %v", 1000.0/15, got)
	}
	if got := current["avg_first_byte"].(float64); got != 500 {
		t.Errorf("平均首字应为 500，得到 %v", got)
	}
	if got := current["avg_speed_latency"].(float64); got != 2000 {
		t.Errorf("平均总耗时应为 2000，得到 %v", got)
	}
}

// 顶部统计按自然日 / 周 / 月划分，并对比上一周期的同期区间。
func TestStatsOverviewRangeComparison(t *testing.T) {
	now := time.Now().In(dashboardLocation)
	todayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	weekStart := startOfWeek(now)

	cases := []struct {
		key        string
		previousAt time.Time
	}{
		{"today", todayStart.AddDate(0, 0, -1)},
		{"week", weekStart.AddDate(0, 0, -7)},
		{"month", time.Date(now.Year(), now.Month()-1, 1, 0, 0, 0, 0, now.Location())},
	}
	for _, tc := range cases {
		t.Run(tc.key, func(t *testing.T) {
			s, _ := newTestServer(t, "stats-range-"+tc.key)
			_ = s.store.RecordStat(store.Log{Time: now.UnixMilli(), StatusCode: 200, TotalTokens: 10})
			_ = s.store.RecordStat(store.Log{Time: tc.previousAt.UnixMilli(), StatusCode: 200, TotalTokens: 5})

			rec := httptest.NewRecorder()
			s.statsOverview(rec, httptest.NewRequest(http.MethodGet, "/api/stats/overview?range="+tc.key, nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("状态码 %d: %s", rec.Code, rec.Body.String())
			}
			var out struct {
				Range    string         `json:"range"`
				Current  map[string]any `json:"current"`
				Previous map[string]any `json:"previous"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
				t.Fatal(err)
			}
			if out.Range != tc.key {
				t.Errorf("区间应为 %s，得到 %s", tc.key, out.Range)
			}
			if got := out.Current["requests"].(float64); got != 1 {
				t.Errorf("当前区间应有 1 次请求，得到 %v", got)
			}
			if got := out.Previous["requests"].(float64); got != 1 {
				t.Errorf("上一周期同期应有 1 次请求，得到 %v", got)
			}
		})
	}
}

// 看板区间固定按北京时间，即使调用方传入其他时区。
func TestParseStatRangeUsesBeijingTime(t *testing.T) {
	now := time.Date(2026, 10, 19, 17, 0, 0, 0, time.UTC) // 北京时间 10-20 01:00
	rng := parseStatRange("today", now)
	wantStart := time.Date(2026, 10, 20, 0, 0, 0, 0, dashboardLocation).UnixMilli()
	if rng.Start.UnixMilli() != wantStart {
		t.Errorf("今天应从北京时间 0 点开始，得到 %s", rng.Start)
	}
	if want := time.Date(2026, 10, 19, 0, 0, 0, 0, dashboardLocation).UnixMilli(); rng.PrevStart.UnixMilli() != want {
		t.Errorf("昨天应从北京时间 0 点开始，得到 %s", rng.PrevStart)
	}
}

// 时间序列按今天的小时、本周/本月的自然日聚合。
func TestStatsSeriesRangeBuckets(t *testing.T) {
	s, _ := newTestServer(t, "stats-series-range")
	now := time.Now().In(dashboardLocation)
	_ = s.store.RecordStat(store.Log{Time: now.UnixMilli(), StatusCode: 200, TotalTokens: 10})

	call := func(key string) (int64, []struct {
		Time     int64 `json:"time"`
		Requests int64 `json:"requests"`
	}) {
		rec := httptest.NewRecorder()
		s.statsSeries(rec, httptest.NewRequest(http.MethodGet, "/api/stats/series?range="+key, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("状态码 %d: %s", rec.Code, rec.Body.String())
		}
		var out struct {
			StepMs int64 `json:"step_ms"`
			Points []struct {
				Time     int64 `json:"time"`
				Requests int64 `json:"requests"`
			} `json:"points"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out.StepMs, out.Points
	}

	if step, points := call("today"); step != 3600000 {
		t.Errorf("今天应按小时聚合，得到 step_ms=%d", step)
	} else if len(points) != now.Hour()+1 {
		t.Errorf("今天应有 %d 个小时点，得到 %d", now.Hour()+1, len(points))
	} else if points[len(points)-1].Requests != 1 {
		t.Errorf("最后一个小时点应包含当前请求，得到 %d", points[len(points)-1].Requests)
	}

	if step, points := call("week"); step != 86400000 {
		t.Errorf("本周应按天聚合，得到 step_ms=%d", step)
	} else if want := (int(now.Weekday())+6)%7 + 1; len(points) != want {
		t.Errorf("本周应有 %d 个天点，得到 %d", want, len(points))
	}

	if step, points := call("month"); step != 86400000 {
		t.Errorf("本月应按天聚合，得到 step_ms=%d", step)
	} else if len(points) != now.Day() {
		t.Errorf("本月应有 %d 个天点，得到 %d", now.Day(), len(points))
	}
}

// ---------- 静态资源缓存 ----------

func TestContentHashStableAndDistinct(t *testing.T) {
	a := []byte("console.log('a')")
	b := []byte("console.log('b')")
	if contentHash(a) != contentHash([]byte("console.log('a')")) {
		t.Error("相同内容应得到相同哈希")
	}
	if contentHash(a) == contentHash(b) {
		t.Error("不同内容不应得到相同哈希")
	}
	if contentHash(a) == "" {
		t.Error("哈希不应为空")
	}
}

func TestEtagMatches(t *testing.T) {
	tag := `"abc123"`
	cases := []struct {
		header string
		want   bool
	}{
		{"", false},
		{`"abc123"`, true},
		{`"other"`, false},
		{`"other", "abc123"`, true},
		{`W/"abc123"`, true},
		{"*", true},
		{` "abc123" `, true},
	}
	for _, c := range cases {
		if got := etagMatches(c.header, tag); got != c.want {
			t.Errorf("etagMatches(%q) = %v，期望 %v", c.header, got, c.want)
		}
	}
}

// 静态资源必须带 ETag 且要求浏览器每次验证：
// 否则升级二进制后，浏览器会继续用缓存里的旧前端。
func TestStaticAssetsAreRevalidated(t *testing.T) {
	st, err := store.Open(t.TempDir() + "/s.db")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	s := New(st)

	req := httptest.NewRequest(http.MethodGet, "/assets/app.js", nil)
	rec := httptest.NewRecorder()
	s.serveStatic(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 %d", rec.Code)
	}
	etag := rec.Header().Get("ETag")
	if etag == "" {
		t.Fatal("静态资源必须带 ETag")
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("Cache-Control 应为 no-cache（每次验证），得到 %q", cc)
	}

	// 带上相同 ETag 再请求，应返回 304 且没有响应体
	req2 := httptest.NewRequest(http.MethodGet, "/assets/app.js", nil)
	req2.Header.Set("If-None-Match", etag)
	rec2 := httptest.NewRecorder()
	s.serveStatic(rec2, req2)
	if rec2.Code != http.StatusNotModified {
		t.Errorf("ETag 命中时应返回 304，得到 %d", rec2.Code)
	}
	if rec2.Body.Len() != 0 {
		t.Errorf("304 不应有响应体，得到 %d 字节", rec2.Body.Len())
	}
}

// 重试明细必须原样落进日志，前端才能点开重试徽章看历史。
func TestRecordPersistsAttempts(t *testing.T) {
	s, st := newTestServer(t, "attempts")

	req := &relay.Request{Path: "/v1/chat/completions", Method: http.MethodPost}
	res := &relay.Result{
		ModelID: "hist/model", ChannelID: "B", UpstreamModel: "m",
		StatusCode: http.StatusOK, Retries: 1, Affinity: true,
		Attempts: []store.LogAttempt{
			{ChannelID: "A", ChannelName: "主线路", UpstreamModel: "m",
				StatusCode: http.StatusInternalServerError, LatencyMs: 12, Error: "渠道「A」返回 500: boom"},
			{ChannelID: "B", ChannelName: "备用线路", UpstreamModel: "m",
				StatusCode: http.StatusOK, LatencyMs: 8},
		},
	}
	s.record(store.Token{ID: "tk", Name: "测试密钥"}, req, res)

	logs, total, err := st.QueryLogs(store.LogFilter{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || len(logs) != 1 {
		t.Fatalf("应写入 1 条日志，得到 total=%d len=%d", total, len(logs))
	}
	got := logs[0]
	if got.Retries != 1 || len(got.Attempts) != 2 {
		t.Fatalf("重试信息未持久化: %+v", got)
	}
	if got.Attempts[0].ChannelName != "主线路" || got.Attempts[0].StatusCode != 500 ||
		!strings.Contains(got.Attempts[0].Error, "boom") {
		t.Errorf("第一次尝试明细错误: %+v", got.Attempts[0])
	}
	if got.Attempts[1].ChannelID != "B" || got.Attempts[1].StatusCode != 200 ||
		got.Attempts[1].Error != "" {
		t.Errorf("第二次尝试明细错误: %+v", got.Attempts[1])
	}
	if !got.Affinity {
		t.Error("亲和标记未持久化")
	}
}

// 日志要把「调用方实际看到的错误」和「内部原因」分开存：
// 渠道全在冷却时对外只有笼统提示，排查时还得能看到冷却这个真实原因。
func TestRecordLogsClientErrorAndInternalReason(t *testing.T) {
	s, st := newTestServer(t, "log-error")
	res := &relay.Result{
		ModelID:     "x",
		ChannelID:   "A",
		ChannelName: "主线路",
		StatusCode:  http.StatusServiceUnavailable,
		ClientErr:   "模型「x」当前没有可用渠道",
		Err:         "所有路由都在失败冷却中",
	}
	s.record(store.Token{ID: "tk", Name: "测试密钥"}, &relay.Request{Path: "/v1/chat/completions"}, res)

	logs, _, err := st.QueryLogs(store.LogFilter{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(logs) != 1 {
		t.Fatalf("应写入 1 条日志，得到 %d", len(logs))
	}
	got := logs[0]
	if got.ClientError != "模型「x」当前没有可用渠道" {
		t.Errorf("对外返回内容不正确：%q", got.ClientError)
	}
	if got.Error != "所有路由都在失败冷却中" {
		t.Errorf("内部原因不正确：%q", got.Error)
	}
	if got.ChannelName != "主线路" {
		t.Errorf("渠道名称不正确：%q", got.ChannelName)
	}
}

// 端到端复现线上现象：客户端读到 [DONE] 后立刻关闭连接，而上游还保持连接。
// 这条请求已经完整收完，日志不能记成「客户端已断开」。
func TestClientDisconnectAfterDoneIsNotLoggedCanceled(t *testing.T) {
	s, st := newTestServer(t, "disconnect-done")
	now := time.Now().UnixMilli()

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\n")
		io.WriteString(w, "data: [DONE]\n\n")
		if fl, ok := w.(http.Flusher); ok {
			fl.Flush()
		}
		// 上游不主动收尾，模拟「客户端先挂断、网关还在等上游 EOF」的竞态。
		<-r.Context().Done()
	}))
	defer up.Close()

	if err := st.SaveChannel(store.Channel{
		ID: "e2e-ch", Name: "端到端线路", Type: store.ChannelOpenAI, BaseURL: up.URL,
		Models: []string{"m"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "e2e/model", Type: store.ModelTypeCustom,
		Routes:  []store.Route{{ChannelID: "e2e-ch", Upstream: "m"}},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	key, err := s.EnsureDefaultToken()
	if err != nil {
		t.Fatal(err)
	}

	gw := httptest.NewServer(s.Handler())
	defer gw.Close()

	req, err := http.NewRequest(http.MethodPost, gw.URL+"/v1/chat/completions",
		strings.NewReader(`{"model":"e2e/model","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(resp.Body)
	for {
		line, rerr := br.ReadString('\n')
		if rerr != nil {
			resp.Body.Close()
			t.Fatalf("读取流失败: %v", rerr)
		}
		if strings.Contains(line, "[DONE]") {
			break
		}
	}
	// 收到 [DONE] 立即断开，与线上客户端行为一致。
	resp.Body.Close()

	var logs []store.Log
	for i := 0; i < 100; i++ {
		logs, _, err = st.QueryLogs(store.LogFilter{Limit: 10})
		if err != nil {
			t.Fatal(err)
		}
		if len(logs) > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(logs) != 1 {
		t.Fatalf("应写入 1 条日志，得到 %d 条", len(logs))
	}
	got := logs[0]
	if got.Canceled {
		t.Fatalf("收到 [DONE] 后断开不应记为取消: %+v", got)
	}
	if got.Error != "" || got.StatusCode != http.StatusOK {
		t.Fatalf("应记为成功的 200，得到 status=%d err=%q", got.StatusCode, got.Error)
	}
	if got.CompletionTokens != 2 || got.TotalTokens != 5 {
		t.Fatalf("应保留上游上报的用量，得到 %+v", got)
	}
}

// API 密钥只能调用模型端点：文件、微调等账号级接口必须在网关层拒绝，
// 不能带着管理员的渠道密钥打到上游。
func TestAPIKeyOnlyReachesModelEndpoints(t *testing.T) {
	s, st := newTestServer(t, "api-scope")
	key, err := s.EnsureDefaultToken()
	if err != nil {
		t.Fatal(err)
	}

	var upstreamHits int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&upstreamHits, 1)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	defer up.Close()

	now := time.Now().UnixMilli()
	if err := st.SaveChannel(store.Channel{
		ID: "A", Type: store.ChannelOpenAI, BaseURL: up.URL,
		Models: []string{"a"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "A/a", Type: store.ModelTypeChannel, ChannelID: "A", Upstream: "a",
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	gw := httptest.NewServer(s.Handler())
	defer gw.Close()

	do := func(method, path, body string) int {
		t.Helper()
		req, err := http.NewRequest(method, gw.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, resp.Body)
		return resp.StatusCode
	}

	denied := []struct{ method, path string }{
		{http.MethodDelete, "/v1/files/file-abc"},
		{http.MethodGet, "/v1/files"},
		{http.MethodPost, "/v1/fine_tuning/jobs"},
		{http.MethodPost, "/v1/batches"},
		{http.MethodPut, "/v1/chat/completions"},
		{http.MethodGet, "/v1/chat/completions"},
	}
	for _, c := range denied {
		body := `{"model":"A/a"}`
		if code := do(c.method, c.path, body); code != http.StatusNotFound {
			t.Errorf("%s %s 应返回 404，得到 %d", c.method, c.path, code)
		}
	}
	if got := atomic.LoadInt32(&upstreamHits); got != 0 {
		t.Fatalf("被拒绝的请求不应打到上游，实际上游收到 %d 次", got)
	}

	body := `{"model":"A/a","messages":[{"role":"user","content":"hi"}]}`
	if code := do(http.MethodPost, "/v1/chat/completions", body); code != http.StatusOK {
		t.Fatalf("正常模型调用应成功，得到 %d", code)
	}
	if got := atomic.LoadInt32(&upstreamHits); got != 1 {
		t.Fatalf("正常调用应转发 1 次，实际上游收到 %d 次", got)
	}
}
