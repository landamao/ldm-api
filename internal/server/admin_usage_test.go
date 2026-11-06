package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"ldmapi/internal/store"
)

// seedUsageLogs 造一组覆盖「单次成功 / 大小写不一致 / 跨渠道重试 / 400」的日志。
func seedUsageLogs(t *testing.T, st *store.Store, now int64) {
	t.Helper()
	logs := []store.Log{
		{
			ID: "l1", Time: now, TokenID: "tk1", TokenName: "主令牌",
			ModelID: "my-gpt4", ChannelID: "A", ChannelName: "主力",
			UpstreamModel: "gpt-4o", StatusCode: 200,
			PromptTokens: 60, CompletionTokens: 40, TotalTokens: 100, LatencyMs: 1000,
		},
		{
			ID: "l2", Time: now - 1000, TokenID: "tk2", TokenName: "备用令牌",
			ModelID: "my-gpt4", ChannelID: "A", ChannelName: "主力",
			// 同一家上游在渠道里写成全大写，统计要合并到 gpt-4o 这一行
			UpstreamModel: "GPT-4O", StatusCode: 200,
			PromptTokens: 120, CompletionTokens: 80, TotalTokens: 200, LatencyMs: 2000,
		},
		{
			ID: "l3", Time: now - 2000, TokenID: "tk1", TokenName: "主令牌",
			ModelID: "my-gpt4", ChannelID: "B", ChannelName: "备用",
			UpstreamModel: "gpt-4o", StatusCode: 200,
			PromptTokens: 30, CompletionTokens: 20, TotalTokens: 50, LatencyMs: 800,
		},
		{
			// 先打 A 失败、切到 B 成功：最终落地在 B，但 A 也「被调用」过
			ID: "l4", Time: now - 3000, TokenID: "tk1", TokenName: "主令牌",
			ModelID: "my-gpt4", ChannelID: "B", ChannelName: "备用",
			UpstreamModel: "gpt-4o", StatusCode: 200, Retries: 1,
			PromptTokens: 200, CompletionTokens: 100, TotalTokens: 300, LatencyMs: 500,
			Attempts: []store.LogAttempt{
				{ChannelID: "A", ChannelName: "主力", UpstreamModel: "gpt-4o", StatusCode: 500, Error: "boom"},
				{ChannelID: "B", ChannelName: "备用", UpstreamModel: "gpt-4o", StatusCode: 200},
			},
		},
		{
			// 400 是调用方请求问题，不进统计
			ID: "l5", Time: now - 4000, TokenID: "tk1", TokenName: "主令牌",
			ModelID: "my-gpt4", ChannelID: "A", ChannelName: "主力",
			UpstreamModel: "gpt-4o", StatusCode: 400,
		},
	}
	for _, l := range logs {
		if err := st.AppendLog(l); err != nil {
			t.Fatal(err)
		}
	}
}

func getUsage(t *testing.T, s *Server, qs string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/usage?"+qs, nil)
	rec := httptest.NewRecorder()
	s.usageReport(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func num(t *testing.T, v any) int64 {
	t.Helper()
	f, ok := v.(float64)
	if !ok {
		t.Fatalf("期望数字，得到 %T %v", v, v)
	}
	return int64(f)
}

func TestUsageTriesSingleSuccess(t *testing.T) {
	l := store.Log{ChannelID: "A", UpstreamModel: "gpt-4o", StatusCode: 200}
	got := usageTries(l)
	if len(got) != 1 || !got[0].OK || got[0].ChannelID != "A" {
		t.Fatalf("单次成功应还原成一条成功尝试，得到 %+v", got)
	}
}

func TestUsageTriesRetryChain(t *testing.T) {
	l := store.Log{
		StatusCode: 200,
		Attempts: []store.LogAttempt{
			{ChannelID: "A", UpstreamModel: "gpt-4o", StatusCode: 500},
			{ChannelID: "B", UpstreamModel: "gpt-4o", StatusCode: 200},
		},
	}
	got := usageTries(l)
	if len(got) != 2 {
		t.Fatalf("应还原 2 次尝试，得到 %+v", got)
	}
	if got[0].OK || !got[1].OK {
		t.Fatalf("只有最后一条能算成功，得到 %+v", got)
	}
}

// 渠道视图只统计所选渠道，模型名大小写合并，400 不进统计。
func TestUsageReportChannelView(t *testing.T) {
	s, st := newTestServer(t, "usage-channel")
	seedUsageLogs(t, st, time.Now().UnixMilli())

	code, out := getUsage(t, s, "tab=channel&channel=A&range=today")
	if code != http.StatusOK {
		t.Fatalf("状态码 %d: %v", code, out)
	}
	sum, _ := out["summary"].(map[string]any)
	if got := num(t, sum["requests"]); got != 3 {
		t.Errorf("请求数应为 3（l1/l2/l4），得到 %d", got)
	}
	if got := num(t, sum["errors"]); got != 0 {
		t.Errorf("l4 最终成功，错误数应为 0，得到 %d", got)
	}
	if got := num(t, sum["attempts"]); got != 3 {
		t.Errorf("尝试数应为 3（只算渠道 A 自己的尝试），得到 %d", got)
	}
	if got := num(t, sum["failed_tries"]); got != 1 {
		t.Errorf("失败尝试应为 1，得到 %d", got)
	}
	// l4 的 Token 落在 B，不属于渠道 A 的承载量，不能计入
	if got := num(t, sum["total_tokens"]); got != 300 {
		t.Errorf("渠道 A 承载的 Token 应为 300，得到 %d", got)
	}

	rows, _ := out["rows"].([]any)
	if len(rows) != 1 {
		t.Fatalf("大小写不同的 gpt-4o 应合并成一行，得到 %d 行", len(rows))
	}
	row := rows[0].(map[string]any)
	if row["key"] != "gpt-4o" {
		t.Errorf("模型名应统一小写，得到 %v", row["key"])
	}
	if got := num(t, row["attempts"]); got != 3 {
		t.Errorf("行尝试数应为 3，得到 %d", got)
	}
	if got := num(t, row["requests"]); got != 2 {
		t.Errorf("行落地数应为 2，得到 %d", got)
	}
}

// 模型视图按上游模型名跨渠道聚合，并支持按渠道再筛一层。
func TestUsageReportModelView(t *testing.T) {
	s, st := newTestServer(t, "usage-model")
	seedUsageLogs(t, st, time.Now().UnixMilli())

	code, out := getUsage(t, s, "tab=model&model=GPT-4o&range=today")
	if code != http.StatusOK {
		t.Fatalf("状态码 %d: %v", code, out)
	}
	sum, _ := out["summary"].(map[string]any)
	if got := num(t, sum["requests"]); got != 4 {
		t.Fatalf("请求数应为 4，得到 %d", got)
	}
	if got := num(t, sum["attempts"]); got != 5 {
		t.Errorf("尝试数应为 5（l4 跨了两条路由），得到 %d", got)
	}
	if got := num(t, sum["total_tokens"]); got != 650 {
		t.Errorf("Token 应为 650，得到 %d", got)
	}
	rows, _ := out["rows"].([]any)
	if len(rows) != 2 {
		t.Fatalf("应拆成 A / B 两行，得到 %d 行", len(rows))
	}
	// 请求数多的排前面：B 承载 2 次、A 承载 2 次，按尝试数 B 少，A 应在前面
	seen := map[string]bool{}
	for _, r := range rows {
		row := r.(map[string]any)
		seen[row["key"].(string)] = true
		if row["name"] == "" {
			t.Errorf("模型视图的行应带渠道名，得到 %+v", row)
		}
	}
	if !seen["A"] || !seen["B"] {
		t.Errorf("应同时包含渠道 A 和 B，得到 %v", seen)
	}

	// 再按渠道筛一层
	_, out = getUsage(t, s, "tab=model&model=gpt-4o&channel=B&range=today")
	sum, _ = out["summary"].(map[string]any)
	if got := num(t, sum["requests"]); got != 2 {
		t.Errorf("渠道 B 的请求数应为 2，得到 %d", got)
	}
	if got := num(t, sum["total_tokens"]); got != 350 {
		t.Errorf("渠道 B 的 Token 应为 350，得到 %d", got)
	}
}

// 令牌筛选把两个视图都收窄到指定令牌。
func TestUsageReportTokenFilter(t *testing.T) {
	s, st := newTestServer(t, "usage-token")
	seedUsageLogs(t, st, time.Now().UnixMilli())

	_, out := getUsage(t, s, "tab=model&model=gpt-4o&token=tk1&range=today")
	sum, _ := out["summary"].(map[string]any)
	if got := num(t, sum["requests"]); got != 3 {
		t.Errorf("tk1 的请求数应为 3，得到 %d", got)
	}
	if got := num(t, sum["total_tokens"]); got != 450 {
		t.Errorf("tk1 的 Token 应为 450，得到 %d", got)
	}
	tokens, _ := out["tokens"].([]any)
	if len(tokens) != 1 || tokens[0].(map[string]any)["id"] != "tk1" {
		t.Errorf("令牌分布应只剩 tk1，得到 %v", tokens)
	}
}

// 渠道视图不选渠道、模型视图不选模型都要直接拒绝，不能悄悄返回全量。
func TestUsageReportRequiresScope(t *testing.T) {
	s, _ := newTestServer(t, "usage-required")
	if code, _ := getUsage(t, s, "tab=channel&range=today"); code != http.StatusBadRequest {
		t.Errorf("渠道视图缺少渠道应返回 400，得到 %d", code)
	}
	if code, _ := getUsage(t, s, "tab=model&range=today"); code != http.StatusBadRequest {
		t.Errorf("模型视图缺少模型应返回 400，得到 %d", code)
	}
}

// facets 里的模型名一律小写去重，渠道各自带自己的模型列表。
func TestUsageFacetsLowercasesModels(t *testing.T) {
	s, st := newTestServer(t, "usage-facets")
	if err := st.SaveChannel(store.Channel{
		ID: "A", Name: "主力", Enabled: true,
		Models: []string{"gpt-4o", "GPT-4O-Mini", "gpt-4o"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveChannel(store.Channel{
		ID: "B", Name: "备用", Enabled: true,
		Models: []string{"Gpt-4O"},
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/usage/facets", nil)
	rec := httptest.NewRecorder()
	s.usageFacets(rec, req)
	var out usageFacetsView
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Models) != 2 || out.Models[0] != "gpt-4o" || out.Models[1] != "gpt-4o-mini" {
		t.Fatalf("全局模型应小写去重排序，得到 %v", out.Models)
	}
	for _, c := range out.Channels {
		if c.ID == "A" && len(c.Models) != 2 {
			t.Errorf("渠道 A 的模型应去重成 2 个，得到 %v", c.Models)
		}
	}
}

// 同一个上游模型可能同时被渠道模型直接调用、被自定义模型路由过来，
// callers 要把请求模型拆开并标出类型。
func TestUsageReportCallers(t *testing.T) {
	s, st := newTestServer(t, "usage-callers")
	if err := st.SaveModel(store.Model{ID: "my-gpt4", Type: store.ModelTypeCustom}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "A/gpt-4o", Type: store.ModelTypeChannel, ChannelID: "A", Upstream: "gpt-4o",
	}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	logs := []store.Log{
		{
			ID: "c1", Time: now, TokenID: "tk1", ModelID: "my-gpt4",
			ChannelID: "A", UpstreamModel: "gpt-4o", StatusCode: 200, TotalTokens: 100,
		},
		{
			ID: "c2", Time: now - 1000, TokenID: "tk1", ModelID: "my-gpt4",
			ChannelID: "A", UpstreamModel: "gpt-4o", StatusCode: 200, TotalTokens: 200,
		},
		{
			ID: "c3", Time: now - 2000, TokenID: "tk1", ModelID: "A/gpt-4o",
			ChannelID: "A", UpstreamModel: "gpt-4o", StatusCode: 200, TotalTokens: 300,
		},
	}
	for _, l := range logs {
		if err := st.AppendLog(l); err != nil {
			t.Fatal(err)
		}
	}

	_, out := getUsage(t, s, "tab=model&model=gpt-4o&range=today")
	callers, _ := out["callers"].([]any)
	if len(callers) != 2 {
		t.Fatalf("应拆成自定义模型和渠道模型两行，得到 %v", callers)
	}
	byID := map[string]map[string]any{}
	for _, c := range callers {
		row := c.(map[string]any)
		byID[row["model_id"].(string)] = row
	}
	custom, ok := byID["my-gpt4"]
	if !ok {
		t.Fatalf("缺少自定义模型 my-gpt4，得到 %v", byID)
	}
	if custom["type"] != store.ModelTypeCustom {
		t.Errorf("my-gpt4 的类型应为 custom，得到 %v", custom["type"])
	}
	if got := num(t, custom["requests"]); got != 2 {
		t.Errorf("my-gpt4 的请求数应为 2，得到 %d", got)
	}
	if got := num(t, custom["tokens"]); got != 300 {
		t.Errorf("my-gpt4 的 Token 应为 300，得到 %d", got)
	}
	direct, ok := byID["A/gpt-4o"]
	if !ok {
		t.Fatalf("缺少渠道模型 A/gpt-4o，得到 %v", byID)
	}
	if direct["type"] != store.ModelTypeChannel {
		t.Errorf("A/gpt-4o 的类型应为 channel，得到 %v", direct["type"])
	}
	if got := num(t, direct["requests"]); got != 1 {
		t.Errorf("A/gpt-4o 的请求数应为 1，得到 %d", got)
	}
}
