package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ldmapi/internal/store"
)

func TestDefaultProvidersSeeded(t *testing.T) {
	_, st := newTestServer(t, "providers")
	providers, err := st.ListProviders()
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 12 {
		t.Fatalf("默认应有 12 个提供商，实际 %d 个", len(providers))
	}
	want := map[string]string{
		"zhipu": "智谱", "deepseek": "DeepSeek", "xai": "xAI", "openai": "OpenAI",
		"stepfun": "阶跃星辰", "bytedance": "字节跳动", "xiaomi": "小米",
		"minimax": "MiniMax", "google": "Google", "anthropic": "Anthropic",
		"moonshot": "月之暗面", "alibaba": "阿里巴巴",
	}
	for _, p := range providers {
		if want[p.ID] != p.Name {
			t.Errorf("提供商 %s 名称应为 %s，实际 %s", p.ID, want[p.ID], p.Name)
		}
		if p.Icon == "" {
			t.Errorf("提供商 %s 应有默认图标", p.ID)
		}
		if len(p.Match) != 1 {
			t.Errorf("提供商 %s 应只有一个默认匹配关键词，实际 %v", p.ID, p.Match)
		}
	}
}

func TestAutoProviderAssignment(t *testing.T) {
	s, st := newTestServer(t, "providers")
	models := []string{
		"gpt-4o", "deepseek-chat", "glm-4", "grok-2", "step-2",
		"doubao-pro", "mimo-7b", "minimax-abab", "gemini-2.5-pro",
		"claude-3-7-sonnet", "kimi-k2", "qwen-max", "unknown-model",
	}
	ch := store.Channel{
		ID: "c1", Name: "测试渠道", Type: store.ChannelOpenAI,
		Models: models, Enabled: true, CreatedAt: 1,
	}
	if err := st.SaveChannel(ch); err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, len(models))
	for _, m := range models {
		ids = append(ids, "c1/"+m)
	}
	body, _ := json.Marshal(map[string]any{"ids": ids})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/models/batch", strings.NewReader(string(body)))
	s.batchAddModels(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("批量添加失败: %d %s", rec.Code, rec.Body.String())
	}

	want := map[string]string{
		"gpt-4o": "openai", "deepseek-chat": "deepseek", "glm-4": "zhipu",
		"grok-2": "xai", "step-2": "stepfun", "doubao-pro": "bytedance",
		"mimo-7b": "xiaomi", "minimax-abab": "minimax", "gemini-2.5-pro": "google",
		"claude-3-7-sonnet": "anthropic", "kimi-k2": "moonshot", "qwen-max": "alibaba",
		"unknown-model": "",
	}
	for _, m := range models {
		got, err := st.GetModel("c1/" + m)
		if err != nil {
			t.Fatalf("模型 %s 未添加: %v", m, err)
		}
		if got.ProviderID != want[m] {
			t.Errorf("模型 %s 的提供商应为 %q，实际 %q", m, want[m], got.ProviderID)
		}
		if got.NoRetryStatus == nil || *got.NoRetryStatus != "" {
			t.Errorf("批量添加的模型 %s 应默认留空不可重试状态码，实际 %+v", m, got.NoRetryStatus)
		}
	}
}

func TestBatchSetModelProvider(t *testing.T) {
	s, st := newTestServer(t, "providers")
	if err := st.SaveChannel(store.Channel{
		ID: "c1", Name: "渠道", Type: store.ChannelOpenAI,
		Models: []string{"gpt-4o", "unknown-model"}, Enabled: true, CreatedAt: 1,
	}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"c1/gpt-4o", "c1/unknown-model"} {
		if err := st.SaveModel(store.Model{ID: id, Type: store.ModelTypeChannel, ChannelID: "c1", Upstream: strings.TrimPrefix(id, "c1/"), Enabled: true}); err != nil {
			t.Fatal(err)
		}
	}

	post := func(payload map[string]any) *httptest.ResponseRecorder {
		body, _ := json.Marshal(payload)
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/models/batch-provider", strings.NewReader(string(body)))
		s.batchSetModelProvider(rec, req)
		return rec
	}

	if rec := post(map[string]any{"ids": []string{"c1/gpt-4o", "c1/unknown-model"}, "provider_id": "deepseek"}); rec.Code != http.StatusOK {
		t.Fatalf("批量设置失败: %d %s", rec.Code, rec.Body.String())
	}
	for _, id := range []string{"c1/gpt-4o", "c1/unknown-model"} {
		m, _ := st.GetModel(id)
		if m.ProviderID != "deepseek" {
			t.Errorf("%s 应设为 deepseek，实际 %q", id, m.ProviderID)
		}
	}

	if rec := post(map[string]any{"ids": []string{"c1/gpt-4o"}, "auto": true}); rec.Code != http.StatusOK {
		t.Fatalf("自动识别失败: %d %s", rec.Code, rec.Body.String())
	}
	if m, _ := st.GetModel("c1/gpt-4o"); m.ProviderID != "openai" {
		t.Errorf("自动识别后 c1/gpt-4o 应为 openai，实际 %q", m.ProviderID)
	}

	if rec := post(map[string]any{"ids": []string{"c1/unknown-model"}, "auto": true}); rec.Code != http.StatusOK {
		t.Fatalf("自动识别失败: %d %s", rec.Code, rec.Body.String())
	}
	if m, _ := st.GetModel("c1/unknown-model"); m.ProviderID != "" {
		t.Errorf("无法匹配的模型提供商应为空，实际 %q", m.ProviderID)
	}
}

func TestProviderCRUDAndModelCleanup(t *testing.T) {
	s, st := newTestServer(t, "providers")
	// 创建一个自定义提供商
	body, _ := json.Marshal(map[string]any{
		"name": "测试厂商", "id": "test-vendor", "icon": "🐱", "match": []string{"testmodel"},
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/providers", strings.NewReader(string(body)))
	s.saveProvider(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("创建提供商失败: %d %s", rec.Code, rec.Body.String())
	}

	// 新建模型时按自定义关键词自动归属
	if err := st.SaveChannel(store.Channel{
		ID: "c1", Name: "渠道", Type: store.ChannelOpenAI,
		Models: []string{"testmodel-v1"}, Enabled: true, CreatedAt: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "c1/testmodel-v1", Type: store.ModelTypeChannel, ChannelID: "c1",
		Upstream: "testmodel-v1", ProviderID: matchProvider(mustProviders(t, st), "c1/testmodel-v1"), Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	m, _ := st.GetModel("c1/testmodel-v1")
	if m.ProviderID != "test-vendor" {
		t.Fatalf("自定义关键词应命中 test-vendor，实际 %q", m.ProviderID)
	}

	// 删除提供商后，模型回到未设置
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodDelete, "/api/providers/test-vendor", nil)
	req.SetPathValue("id", "test-vendor")
	s.deleteProvider(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("删除提供商失败: %d %s", rec.Code, rec.Body.String())
	}
	m, _ = st.GetModel("c1/testmodel-v1")
	if m.ProviderID != "" {
		t.Errorf("删除提供商后模型应回到未设置，实际 %q", m.ProviderID)
	}
}

func TestRestoreDefaultProviders(t *testing.T) {
	s, st := newTestServer(t, "restore")
	if err := st.SaveChannel(store.Channel{
		ID: "c1", Name: "渠道", Type: store.ChannelOpenAI,
		Models: []string{"claude-3-7-sonnet"}, Enabled: true, CreatedAt: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "c1/claude-3-7-sonnet", Type: store.ModelTypeChannel, ChannelID: "c1",
		Upstream: "claude-3-7-sonnet", ProviderID: "anthropic", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}

	// 删除两个内置提供商，只找回 claude
	for _, id := range []string{"anthropic", "moonshot"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodDelete, "/api/providers/"+id, nil)
		req.SetPathValue("id", id)
		s.deleteProvider(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("删除 %s 失败: %d %s", id, rec.Code, rec.Body.String())
		}
	}
	if m, _ := st.GetModel("c1/claude-3-7-sonnet"); m.ProviderID != "" {
		t.Fatalf("删除后模型应未设置提供商，实际 %q", m.ProviderID)
	}

	// 用户改过的内置提供商名称，恢复时不能被覆盖
	openai, _ := st.GetProvider("openai")
	openai.Name = "OpenAI 自定义"
	if err := st.SaveProvider(openai); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/providers/restore-defaults", strings.NewReader(`{"ids":["anthropic"]}`))
	s.restoreDefaultProviders(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("恢复失败: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := st.GetProvider("anthropic"); err != nil {
		t.Errorf("恢复后 claude 应存在: %v", err)
	}
	if _, err := st.GetProvider("moonshot"); err == nil {
		t.Errorf("未勾选的 moonshot 不应被恢复")
	}
	if got, _ := st.GetProvider("openai"); got.Name != "OpenAI 自定义" {
		t.Errorf("已有提供商不应被覆盖，名称实际为 %q", got.Name)
	}
	if m, _ := st.GetModel("c1/claude-3-7-sonnet"); m.ProviderID != "anthropic" {
		t.Errorf("恢复后模型应重新归属 claude，实际 %q", m.ProviderID)
	}

	// 不勾选任何项时应拒绝
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/providers/restore-defaults", strings.NewReader(`{"ids":[]}`))
	s.restoreDefaultProviders(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("空选择应返回 400，实际 %d", rec.Code)
	}
}

func mustProviders(t *testing.T, st *store.Store) []store.Provider {
	t.Helper()
	providers, err := st.ListProviders()
	if err != nil {
		t.Fatal(err)
	}
	return providers
}
