package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"ldmapi/internal/store"
)

func getChannelUsage(t *testing.T, s *Server, query string) (bucketSummary, []channelUsageOption, []upstreamChannelUsageView) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/stats/channel-usage?"+query, nil)
	rec := httptest.NewRecorder()
	s.statsChannelUsage(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("statsChannelUsage 返回 %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Summary  bucketSummary              `json:"summary"`
		Channels []channelUsageOption       `json:"channels"`
		Models   []upstreamChannelUsageView `json:"models"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out.Summary, out.Channels, out.Models
}

func TestStatsChannelUsageMergesAcrossChannelsAndFilters(t *testing.T) {
	s, st := newTestServer(t, "channel-usage")
	for _, c := range []store.Channel{
		{ID: "ch-a", Name: "主渠道", Enabled: true},
		{ID: "ch-b", Name: "备用渠道", Enabled: true},
		{ID: "ch-empty", Name: "空闲渠道", Enabled: true},
	} {
		if err := st.SaveChannel(c); err != nil {
			t.Fatal(err)
		}
	}

	now := time.Now()
	logs := []store.Log{
		{Time: now.UnixMilli(), ModelID: "public-alias", ChannelID: "ch-a", ChannelName: "主渠道", UpstreamModel: "GPT-4o", ResponseModel: "gpt-4o-2026-01", PromptTokens: 10, CompletionTokens: 2, TotalTokens: 12, StatusCode: 200},
		{Time: now.UnixMilli(), ModelID: "another-alias", ChannelID: "ch-b", ChannelName: "备用渠道", UpstreamModel: "gpt-4O", ResponseModel: "GPT-4O-other", PromptTokens: 20, CompletionTokens: 3, TotalTokens: 23, StatusCode: 500, Error: "failed"},
		{Time: now.UnixMilli(), ModelID: "ch-a/glm-4", ChannelID: "ch-a", ChannelName: "主渠道", UpstreamModel: "glm-4", PromptTokens: 5, CompletionTokens: 5, TotalTokens: 10, StatusCode: 200},
		{Time: now.UnixMilli(), ModelID: "custom-glm", ChannelID: "ch-b", ChannelName: "备用渠道", UpstreamModel: "GLM-4", PromptTokens: 1, CompletionTokens: 1, TotalTokens: 2, StatusCode: 200},
		{Time: now.UnixMilli(), ModelID: "no-route", ChannelID: "ch-a", ChannelName: "主渠道", UpstreamModel: "", PromptTokens: 1, TotalTokens: 1, StatusCode: 200},
	}
	for _, l := range logs {
		if err := st.RecordStat(l); err != nil {
			t.Fatal(err)
		}
	}

	summary, channels, models := getChannelUsage(t, s, "range=all")
	if summary.Requests != 5 || summary.Errors != 1 || summary.TotalTokens != 48 {
		t.Errorf("全部渠道汇总错误：%+v", summary)
	}
	if summary.PromptTokens != 37 || summary.CompletionTokens != 11 {
		t.Errorf("全部渠道输入 / 输出 Token 错误：%+v", summary)
	}
	if len(channels) != 3 {
		t.Fatalf("渠道选项应包含暂无调用的当前渠道，得到 %+v", channels)
	}
	byChannel := map[string]channelUsageOption{}
	for _, c := range channels {
		byChannel[c.ID] = c
	}
	if byChannel["ch-a"].Requests != 3 || byChannel["ch-a"].TotalTokens != 23 {
		t.Errorf("ch-a 选项统计错误：%+v", byChannel["ch-a"])
	}
	if byChannel["ch-b"].Requests != 2 || byChannel["ch-b"].TotalTokens != 25 {
		t.Errorf("ch-b 选项统计错误：%+v", byChannel["ch-b"])
	}
	if byChannel["ch-empty"].Requests != 0 || byChannel["ch-empty"].Name != "空闲渠道" {
		t.Errorf("空渠道选项错误：%+v", byChannel["ch-empty"])
	}

	if len(models) != 3 {
		t.Fatalf("上游模型应归并成 3 项，得到 %+v", models)
	}
	byModel := map[string]upstreamChannelUsageView{}
	for _, m := range models {
		byModel[m.Key] = m
	}
	gpt := byModel["gpt-4o"]
	if gpt.Name != "GPT-4o" || gpt.Requests != 2 || gpt.Errors != 1 || gpt.TotalTokens != 35 || gpt.ChannelCount != 2 {
		t.Errorf("跨渠道大小写归并错误：%+v", gpt)
	}
	if gpt.PromptTokens != 30 || gpt.CompletionTokens != 5 || gpt.SuccessRate != 50 {
		t.Errorf("归并模型 Token / 成功率错误：%+v", gpt)
	}
	glm := byModel["glm-4"]
	if glm.Requests != 2 || glm.TotalTokens != 12 || glm.ChannelCount != 2 {
		t.Errorf("glm-4 跨渠道归并错误：%+v", glm)
	}
	empty := byModel[""]
	if empty.Name != "未记录上游" || empty.Requests != 1 || empty.TotalTokens != 1 {
		t.Errorf("空上游模型应单列：%+v", empty)
	}

	summary, _, models = getChannelUsage(t, s, "range=all&channel_id=ch-a")
	if summary.Requests != 3 || summary.Errors != 0 || summary.TotalTokens != 23 {
		t.Errorf("单渠道汇总错误：%+v", summary)
	}
	byModel = map[string]upstreamChannelUsageView{}
	for _, m := range models {
		byModel[m.Key] = m
	}
	if byModel["gpt-4o"].Requests != 1 || byModel["gpt-4o"].TotalTokens != 12 || byModel["gpt-4o"].ChannelCount != 1 {
		t.Errorf("单渠道不得混入其他渠道模型：%+v", byModel["gpt-4o"])
	}
	if byModel["glm-4"].TotalTokens != 10 {
		t.Errorf("单渠道 glm-4 Token 错误：%+v", byModel["glm-4"])
	}

	summary, channels, models = getChannelUsage(t, s, "range=all&channel_id=ch-empty")
	if summary.Requests != 0 || summary.SuccessRate != 100 || len(models) != 0 {
		t.Errorf("空渠道应返回零汇总和空数组：summary=%+v models=%+v", summary, models)
	}
	if channels == nil || models == nil {
		t.Error("空结果仍应返回 []，不能返回 null")
	}
}

func TestStatsChannelUsageCustomRange(t *testing.T) {
	s, st := newTestServer(t, "channel-usage-range")
	now := time.Now()
	for _, l := range []store.Log{
		{Time: now.Add(-48 * time.Hour).UnixMilli(), ChannelID: "ch-a", UpstreamModel: "GPT-4o", TotalTokens: 100, StatusCode: 200},
		{Time: now.UnixMilli(), ChannelID: "ch-a", UpstreamModel: "gpt-4o", TotalTokens: 12, StatusCode: 200},
	} {
		if err := st.RecordStat(l); err != nil {
			t.Fatal(err)
		}
	}

	query := fmt.Sprintf("range=custom&start=%d&end=%d", now.Add(-time.Hour).UnixMilli(), now.Add(time.Hour).UnixMilli())
	summary, _, models := getChannelUsage(t, s, query)
	if summary.Requests != 1 || summary.TotalTokens != 12 || len(models) != 1 {
		t.Errorf("自定义区间应排除旧记录：summary=%+v models=%+v", summary, models)
	}
	summary, _, _ = getChannelUsage(t, s, "range=all")
	if summary.Requests != 2 || summary.TotalTokens != 112 {
		t.Errorf("全部时间应包含旧记录：%+v", summary)
	}
}
