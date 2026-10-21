package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSaveModelSystemPrompt(t *testing.T) {
	s, st := newTestServer(t, "model-system-prompt")

	put := func(id, payload string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPut, "/api/models/"+id, strings.NewReader(payload))
		req.SetPathValue("id", id)
		rec := httptest.NewRecorder()
		s.saveModel(rec, req)
		return rec
	}

	// 开启时必须填写提示词内容。
	rec := put("smart", `{"id":"smart","type":"custom","routes":[],"system_prompt_enabled":true}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("开启但未填写提示词应返回 400，得到 %d: %s", rec.Code, rec.Body.String())
	}

	// 保存时去掉首尾空白。
	rec = put("smart", `{"id":"smart","type":"custom","routes":[],"system_prompt_enabled":true,"system_prompt":"  你是懒大猫  "}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("保存失败 %d: %s", rec.Code, rec.Body.String())
	}
	m, err := st.GetModel("smart")
	if err != nil {
		t.Fatal(err)
	}
	if !m.SystemPromptEnabled() || m.SystemPrompt != "你是懒大猫" {
		t.Fatalf("系统提示词未正确保存: enabled=%v prompt=%q", m.SystemPromptEnabled(), m.SystemPrompt)
	}

	// 只提交其它字段时不能清空已有配置。
	rec = put("smart", `{"enabled":false}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("部分更新失败 %d: %s", rec.Code, rec.Body.String())
	}
	m, _ = st.GetModel("smart")
	if !m.SystemPromptEnabled() || m.SystemPrompt != "你是懒大猫" {
		t.Fatalf("未提交系统提示词时不应被覆盖: enabled=%v prompt=%q", m.SystemPromptEnabled(), m.SystemPrompt)
	}

	// 关闭开关后保留已填写的提示词，方便再次开启。
	rec = put("smart", `{"system_prompt_enabled":false}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("关闭失败 %d: %s", rec.Code, rec.Body.String())
	}
	m, _ = st.GetModel("smart")
	if m.SystemPromptEnabled() || m.SystemPrompt != "你是懒大猫" {
		t.Fatalf("关闭后应保留提示词内容: enabled=%v prompt=%q", m.SystemPromptEnabled(), m.SystemPrompt)
	}

	// 渠道模型同样支持该配置。
	rec = put("A/a", `{"id":"A/a","type":"channel","channel_id":"A","upstream":"a","system_prompt_enabled":true,"system_prompt":"渠道模型人格"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("渠道模型保存失败 %d: %s", rec.Code, rec.Body.String())
	}
	m, _ = st.GetModel("A/a")
	if !m.SystemPromptEnabled() || m.SystemPrompt != "渠道模型人格" {
		t.Fatalf("渠道模型的系统提示词未保存: %+v", m)
	}
}
