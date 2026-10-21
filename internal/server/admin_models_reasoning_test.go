package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 思考覆写开关与文本可以保存、部分更新不会丢失，留空文本表示隐藏。
func TestSaveModelThinkingOverride(t *testing.T) {
	s, st := newTestServer(t, "model-thinking-override")
	put := func(id, payload string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPut, "/api/models/"+id, strings.NewReader(payload))
		req.SetPathValue("id", id)
		rec := httptest.NewRecorder()
		s.saveModel(rec, req)
		return rec
	}

	rec := put("smart", `{"id":"smart","type":"custom","thinking_override_enabled":true,
		"thinking_override_text":"正在思考···"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("保存失败 %d: %s", rec.Code, rec.Body.String())
	}
	m, err := st.GetModel("smart")
	if err != nil {
		t.Fatal(err)
	}
	if !m.ThinkingOverrideEnabled() || m.ThinkingOverrideText != "正在思考···" {
		t.Fatalf("思考覆写未正确保存: %+v", m)
	}

	// 部分更新（例如只改启停）不能清空已有配置
	rec = put("smart", `{"enabled":false}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("部分更新失败 %d: %s", rec.Code, rec.Body.String())
	}
	m, _ = st.GetModel("smart")
	if !m.ThinkingOverrideEnabled() || m.ThinkingOverrideText != "正在思考···" {
		t.Fatalf("未提交思考覆写配置时不应被覆盖: %+v", m)
	}

	// 文本留空是合法配置：只隐藏思考内容，不阻止保存
	rec = put("smart", `{"thinking_override_text":""}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("保存空文本失败 %d: %s", rec.Code, rec.Body.String())
	}
	m, _ = st.GetModel("smart")
	if !m.ThinkingOverrideEnabled() || m.ThinkingOverrideText != "" {
		t.Fatalf("空文本应表示隐藏并保留开关: %+v", m)
	}

	// 列表接口回填生效的开关值，前端按布尔值渲染
	rec = httptest.NewRecorder()
	s.listModels(rec, httptest.NewRequest(http.MethodGet, "/api/models", nil))
	if !strings.Contains(rec.Body.String(), `"thinking_override_enabled":true`) {
		t.Errorf("模型列表应返回思考覆写开关: %s", rec.Body.String())
	}
}
