package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ldmapi/internal/store"
)

func TestSaveChannelKeyCooldownStatus(t *testing.T) {
	s, st := newTestServer(t, "channel-status-codes")

	put := func(payload string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPut, "/api/channels/c", strings.NewReader(payload))
		req.SetPathValue("id", "c")
		rec := httptest.NewRecorder()
		s.saveChannel(rec, req)
		return rec
	}

	rec := put(`{"name":"渠道","type":"openai","base_url":"https://example.com","key_rows":[{"key":"sk-1234567890"}],
		"key_cooldown_status":" 401 , 429-430 "}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("保存失败 %d: %s", rec.Code, rec.Body.String())
	}
	ch, err := st.GetChannel("c")
	if err != nil {
		t.Fatal(err)
	}
	if ch.KeyCooldownStatus == nil || *ch.KeyCooldownStatus != "401,429-430" {
		t.Fatalf("状态码规则未规范化保存: %+v", ch.KeyCooldownStatus)
	}
	if !strings.Contains(rec.Body.String(), `"key_cooldown_status":"401,429-430"`) {
		t.Errorf("响应应返回状态码规则: %s", rec.Body.String())
	}

	// 显式空字符串表示不冷却 Key，必须与「未设置」区分开
	rec = put(`{"key_cooldown_status":""}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("保存空规则失败 %d: %s", rec.Code, rec.Body.String())
	}
	ch, _ = st.GetChannel("c")
	if ch.KeyCooldownStatus == nil || *ch.KeyCooldownStatus != "" {
		t.Fatalf("显式空规则应保存为空字符串: %+v", ch.KeyCooldownStatus)
	}

	// 只提交其它字段时不能覆盖已有规则
	rec = put(`{"name":"改名"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("部分更新失败 %d: %s", rec.Code, rec.Body.String())
	}
	ch, _ = st.GetChannel("c")
	if ch.KeyCooldownStatus == nil || *ch.KeyCooldownStatus != "" {
		t.Fatalf("未提交状态码规则时不应被覆盖: %+v", ch.KeyCooldownStatus)
	}

	// 非法规则直接拒绝
	rec = put(`{"key_cooldown_status":"400-399"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("非法区间应返回 400，得到 %d: %s", rec.Code, rec.Body.String())
	}
}

func TestSaveModelNoRetryStatus(t *testing.T) {
	s, st := newTestServer(t, "model-status-codes")

	put := func(id, payload string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPut, "/api/models/"+id, strings.NewReader(payload))
		req.SetPathValue("id", id)
		rec := httptest.NewRecorder()
		s.saveModel(rec, req)
		return rec
	}

	rec := put("smart", `{"id":"smart","type":"custom","routes":[],"no_retry_status":" 400-430 , 500 "}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("保存失败 %d: %s", rec.Code, rec.Body.String())
	}
	m, err := st.GetModel("smart")
	if err != nil {
		t.Fatal(err)
	}
	if m.NoRetryStatus == nil || *m.NoRetryStatus != "400-430,500" {
		t.Fatalf("不可重试状态码未规范化保存: %+v", m.NoRetryStatus)
	}

	// 渠道模型同样支持该配置
	rec = put("A/a", `{"id":"A/a","type":"channel","channel_id":"A","upstream":"a","no_retry_status":"400"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("渠道模型保存失败 %d: %s", rec.Code, rec.Body.String())
	}
	m, _ = st.GetModel("A/a")
	if m.NoRetryStatus == nil || *m.NoRetryStatus != "400" {
		t.Fatalf("渠道模型的不可重试状态码未保存: %+v", m.NoRetryStatus)
	}

	// 只提交 enabled 不能清空已有规则
	rec = put("smart", `{"enabled":false}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("部分更新失败 %d: %s", rec.Code, rec.Body.String())
	}
	m, _ = st.GetModel("smart")
	if m.NoRetryStatus == nil || *m.NoRetryStatus != "400-430,500" {
		t.Fatalf("未提交状态码规则时不应被覆盖: %+v", m.NoRetryStatus)
	}

	// 非法规则直接拒绝
	rec = put("smart", `{"no_retry_status":"abc"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("非法规则应返回 400，得到 %d: %s", rec.Code, rec.Body.String())
	}
}

func TestSaveModelCustomError(t *testing.T) {
	s, st := newTestServer(t, "model-custom-error")

	put := func(id, payload string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPut, "/api/models/"+id, strings.NewReader(payload))
		req.SetPathValue("id", id)
		rec := httptest.NewRecorder()
		s.saveModel(rec, req)
		return rec
	}

	// 两个开关都开：始终返回配置的错误
	rec := put("smart", `{"id":"smart","type":"custom","routes":[],"error_enabled":true,"error_always":true,"error_status":503,"error_message":" 维护中，请稍后再试 "}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("保存失败 %d: %s", rec.Code, rec.Body.String())
	}
	m, err := st.GetModel("smart")
	if err != nil {
		t.Fatal(err)
	}
	if !m.CustomErrorEnabled() || !m.CustomErrorAlways() {
		t.Fatalf("两个开关都应开启: %+v", m)
	}
	if m.ErrorStatus != http.StatusServiceUnavailable || m.ErrorMessage != "维护中，请稍后再试" {
		t.Fatalf("自定义错误未正确保存: %+v", m)
	}

	// 只开总开关：失败时重写
	rec = put("smart", `{"error_always":false,"error_status":429,"error_message":"限流"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("保存失败 %d: %s", rec.Code, rec.Body.String())
	}
	m, _ = st.GetModel("smart")
	if !m.CustomErrorEnabled() || m.CustomErrorAlways() {
		t.Fatalf("应只开启总开关: %+v", m)
	}
	if m.ErrorStatus != http.StatusTooManyRequests || m.ErrorMessage != "限流" {
		t.Fatalf("错误状态码或详情未保存: %+v", m)
	}

	// 渠道模型同样支持
	rec = put("A/a", `{"id":"A/a","type":"channel","channel_id":"A","upstream":"a","error_enabled":true,"error_always":true,"error_status":403,"error_message":"已下线"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("渠道模型保存失败 %d: %s", rec.Code, rec.Body.String())
	}
	m, _ = st.GetModel("A/a")
	if !m.CustomErrorEnabled() || !m.CustomErrorAlways() ||
		m.ErrorStatus != http.StatusForbidden || m.ErrorMessage != "已下线" {
		t.Fatalf("渠道模型的自定义错误未保存: %+v", m)
	}

	// 只提交 enabled 不能清空已有配置
	rec = put("smart", `{"enabled":false}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("部分更新失败 %d: %s", rec.Code, rec.Body.String())
	}
	m, _ = st.GetModel("smart")
	if !m.CustomErrorEnabled() || m.CustomErrorAlways() || m.ErrorStatus != http.StatusTooManyRequests {
		t.Fatalf("未提交自定义错误时不应被覆盖: %+v", m)
	}

	// 关闭总开关时子开关一起关闭，状态码保留
	rec = put("smart", `{"error_enabled":false}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("关闭总开关失败 %d: %s", rec.Code, rec.Body.String())
	}
	m, _ = st.GetModel("smart")
	if m.CustomErrorEnabled() || m.CustomErrorAlways() {
		t.Fatalf("总开关关闭后子开关不应生效: %+v", m)
	}
	if m.ErrorStatus != http.StatusTooManyRequests {
		t.Fatalf("关闭总开关不应清空状态码: %+v", m)
	}

	// 只打开「始终返回错误」会一并打开总开关
	rec = put("smart", `{"error_always":true}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("保存失败 %d: %s", rec.Code, rec.Body.String())
	}
	m, _ = st.GetModel("smart")
	if !m.CustomErrorEnabled() || !m.CustomErrorAlways() {
		t.Fatalf("打开始终返回错误时应一并打开总开关: %+v", m)
	}

	// 关闭状态下可以清空状态码与详情
	rec = put("smart", `{"error_enabled":false,"error_status":0,"error_message":""}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("关闭并清空失败 %d: %s", rec.Code, rec.Body.String())
	}
	m, _ = st.GetModel("smart")
	if m.CustomErrorEnabled() || m.ErrorStatus != 0 || m.ErrorMessage != "" {
		t.Fatalf("自定义错误应已关闭并清空: %+v", m)
	}

	// 开启总开关但没有状态码直接拒绝
	rec = put("fresh", `{"id":"fresh","type":"custom","routes":[],"error_enabled":true}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("缺少状态码应返回 400，得到 %d: %s", rec.Code, rec.Body.String())
	}

	// 状态码超出错误范围直接拒绝
	for _, payload := range []string{`{"error_status":200}`, `{"error_status":600}`} {
		rec = put("smart", payload)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("非法状态码应返回 400，得到 %d: %s", rec.Code, rec.Body.String())
		}
	}
}

// 通过完整 HTTP 入口验证：模型配置自定义错误后，调用方收到配置的状态码和文案，
// 且不会向上游发起请求。
func TestModelCustomErrorOverHTTP(t *testing.T) {
	s, st := newTestServer(t, "model-custom-error-http")

	var hits atomic.Int32
	upstreamSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"ok"}`)
	}))
	defer upstreamSrv.Close()

	if err := st.SaveChannel(store.Channel{
		ID: "C", Name: "C", Type: store.ChannelOpenAI, BaseURL: upstreamSrv.URL,
		APIKey: "sk-upstream", Models: []string{"m"}, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	on := true
	if err := st.SaveModel(store.Model{
		ID: "C/m", Type: store.ModelTypeChannel, ChannelID: "C", Upstream: "m",
		ErrorEnabled: &on, ErrorAlways: &on,
		ErrorStatus: http.StatusForbidden, ErrorMessage: "该模型已下线",
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveToken(store.Token{
		ID: "t1", Name: "测试", Key: "sk-test-custom-error", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer(s.Handler())
	defer srv.Close()

	body := `{"model":"C/m","messages":[{"role":"user","content":"hi"}]}`
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/v1/chat/completions", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer sk-test-custom-error")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("应返回配置的 403，得到 %d: %s", resp.StatusCode, raw)
	}
	if !strings.Contains(string(raw), "该模型已下线") {
		t.Errorf("响应应包含配置的错误详情: %s", raw)
	}
	if got := hits.Load(); got != 0 {
		t.Errorf("配置自定义错误后不应请求上游，实际 %d 次", got)
	}
}

func TestNewEntitiesDefaultToEmptyStatusRules(t *testing.T) {
	s, st := newTestServer(t, "status-defaults-empty")

	// 新建渠道没有提交规则时，显式保存为空字符串（不冷却 Key），
	// 而不是把旧版默认模板写进去。
	req := httptest.NewRequest(http.MethodPut, "/api/channels/c", strings.NewReader(
		`{"name":"渠道","type":"openai","base_url":"https://example.com","key_rows":[{"key":"sk-1234567890"}]}`))
	req.SetPathValue("id", "c")
	rec := httptest.NewRecorder()
	s.saveChannel(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("新建渠道失败 %d: %s", rec.Code, rec.Body.String())
	}
	ch, err := st.GetChannel("c")
	if err != nil {
		t.Fatal(err)
	}
	if ch.KeyCooldownStatus == nil || *ch.KeyCooldownStatus != "" {
		t.Fatalf("新建渠道的状态码规则应默认留空: %+v", ch.KeyCooldownStatus)
	}

	// 新建模型同理：不提交规则时默认留空，所有状态码都可重试。
	req = httptest.NewRequest(http.MethodPut, "/api/models/smart", strings.NewReader(
		`{"id":"smart","type":"custom","routes":[]}`))
	req.SetPathValue("id", "smart")
	rec = httptest.NewRecorder()
	s.saveModel(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("新建模型失败 %d: %s", rec.Code, rec.Body.String())
	}
	m, err := st.GetModel("smart")
	if err != nil {
		t.Fatal(err)
	}
	if m.NoRetryStatus == nil || *m.NoRetryStatus != "" {
		t.Fatalf("新建模型的不可重试状态码应默认留空: %+v", m.NoRetryStatus)
	}
}

func TestStatusSetJSONRoundTrip(t *testing.T) {
	// 指针字段为空时不出现在 JSON 里，前端据此显示为空（未配置）。
	ch := store.Channel{ID: "c"}
	raw, _ := json.Marshal(ch)
	if strings.Contains(string(raw), "key_cooldown_status") {
		t.Errorf("未设置时不应输出字段: %s", raw)
	}
	empty := ""
	ch.KeyCooldownStatus = &empty
	raw, _ = json.Marshal(ch)
	if !strings.Contains(string(raw), `"key_cooldown_status":""`) {
		t.Errorf("显式空字符串应输出字段: %s", raw)
	}
}
