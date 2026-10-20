package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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
