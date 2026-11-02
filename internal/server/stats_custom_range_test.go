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

// 自定义区间按毫秒起止取，上一周期取紧邻的等长区间。
func TestCustomStatRange(t *testing.T) {
	now := time.Date(2026, 11, 3, 12, 0, 0, 0, dashboardLocation)
	start := time.Date(2026, 11, 1, 0, 0, 0, 0, dashboardLocation)
	end := time.Date(2026, 11, 3, 0, 0, 0, 0, dashboardLocation) // 两天，按天聚合

	rng := customStatRange(start.UnixMilli(), end.UnixMilli(), now)
	if !rng.Start.Equal(start) || !rng.End.Equal(end) {
		t.Fatalf("区间应为 %s ~ %s，得到 %s ~ %s", start, end, rng.Start, rng.End)
	}
	if want := start.Add(-48 * time.Hour); !rng.PrevStart.Equal(want) {
		t.Errorf("上一周期应从 %s 开始，得到 %s", want, rng.PrevStart)
	}
	if !rng.PrevEnd.Equal(start) {
		t.Errorf("上一周期应到 %s 结束，得到 %s", start, rng.PrevEnd)
	}
	if rng.Step != 24*time.Hour {
		t.Errorf("超过一天的区间按天聚合，得到 %s", rng.Step)
	}

	// 两端留空 = 最近 24 小时
	open := customStatRange(0, 0, now)
	if !open.End.Equal(now) || !open.Start.Equal(now.Add(-24*time.Hour)) {
		t.Errorf("两端留空应取最近 24 小时，得到 %s ~ %s", open.Start, open.End)
	}
	if open.Step != time.Hour {
		t.Errorf("一天以内按小时聚合，得到 %s", open.Step)
	}

	// 结束时间给到未来时截到此刻，不会把没发生的时间算进区间
	future := customStatRange(start.UnixMilli(), now.Add(48*time.Hour).UnixMilli(), now)
	if !future.End.Equal(now) {
		t.Errorf("未来结束时间应截到此刻，得到 %s", future.End)
	}

	// 只带开始时间时，终点默认此刻
	half := customStatRange(start.UnixMilli(), 0, now)
	if !half.Start.Equal(start) || !half.End.Equal(now) {
		t.Errorf("只给开始时间应到此刻结束，得到 %s ~ %s", half.Start, half.End)
	}
}

// 带 start / end 的请求按自定义区间统计，预设参数不再生效。
func TestStatsOverviewCustomRange(t *testing.T) {
	s, _ := newTestServer(t, "stats-custom-range")
	now := time.Now().In(dashboardLocation)
	if err := s.store.RecordStat(store.Log{Time: now.Add(-2 * time.Hour).UnixMilli(), StatusCode: 200, TotalTokens: 10}); err != nil {
		t.Fatal(err)
	}
	if err := s.store.RecordStat(store.Log{Time: now.Add(-30 * time.Hour).UnixMilli(), StatusCode: 200, TotalTokens: 7}); err != nil {
		t.Fatal(err)
	}

	qs := fmt.Sprintf("start=%d&end=%d", now.Add(-3*time.Hour).UnixMilli(), now.UnixMilli())
	rec := httptest.NewRecorder()
	s.statsOverview(rec, httptest.NewRequest(http.MethodGet, "/api/stats/overview?range=today&"+qs, nil))
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
	if out.Range != "custom" {
		t.Errorf("带 start / end 时应返回 custom 区间，得到 %s", out.Range)
	}
	// 最近 3 小时只有 2 小时前那一条
	if got := out.Current["requests"].(float64); got != 1 {
		t.Errorf("自定义区间内应有 1 次请求，得到 %v", got)
	}
	// 上一周期是再往前的 3 小时，只有 30 小时前那条落在更早，这里应为 0
	if got := out.Previous["requests"].(float64); got != 0 {
		t.Errorf("上一周期应没有请求，得到 %v", got)
	}

	// 时间序列按小时铺点：3 小时区间应有 4 个点（含两端）
	recSeries := httptest.NewRecorder()
	s.statsSeries(recSeries, httptest.NewRequest(http.MethodGet, "/api/stats/series?"+qs, nil))
	if recSeries.Code != http.StatusOK {
		t.Fatalf("状态码 %d: %s", recSeries.Code, recSeries.Body.String())
	}
	var ser struct {
		StepMs int64 `json:"step_ms"`
		Points []struct {
			Requests int64 `json:"requests"`
		} `json:"points"`
	}
	if err := json.Unmarshal(recSeries.Body.Bytes(), &ser); err != nil {
		t.Fatal(err)
	}
	if ser.StepMs != int64(time.Hour/time.Millisecond) {
		t.Errorf("3 小时区间应按小时聚合，得到 %d", ser.StepMs)
	}
	if len(ser.Points) != 4 {
		t.Errorf("3 小时区间应有 4 个时间点，得到 %d", len(ser.Points))
	}
	// 曲线上的请求数要能对上总览：起点没对齐到整点时曾经整条曲线都是 0
	var sum int64
	for _, p := range ser.Points {
		sum += p.Requests
	}
	if sum != 1 {
		t.Errorf("曲线求和应为 1 次请求，得到 %d", sum)
	}

	// 按天聚合时同样要对上：起点是任意时刻，桶要归到自然日
	dayStart := now.Add(-72 * time.Hour)
	dayQS := fmt.Sprintf("start=%d&end=%d", dayStart.UnixMilli(), now.UnixMilli())
	recDay := httptest.NewRecorder()
	s.statsSeries(recDay, httptest.NewRequest(http.MethodGet, "/api/stats/series?"+dayQS, nil))
	if recDay.Code != http.StatusOK {
		t.Fatalf("状态码 %d: %s", recDay.Code, recDay.Body.String())
	}
	var daySer struct {
		StepMs int64 `json:"step_ms"`
		Points []struct {
			Requests int64 `json:"requests"`
		} `json:"points"`
	}
	if err := json.Unmarshal(recDay.Body.Bytes(), &daySer); err != nil {
		t.Fatal(err)
	}
	if daySer.StepMs != int64(24*time.Hour/time.Millisecond) {
		t.Errorf("三天区间应按天聚合，得到 %d", daySer.StepMs)
	}
	var daySum int64
	for _, p := range daySer.Points {
		daySum += p.Requests
	}
	if daySum != 2 {
		t.Errorf("按天聚合的曲线求和应为 2 次请求，得到 %d", daySum)
	}

	// 分布接口同样只统计区间内的记录
	recBreak := httptest.NewRecorder()
	s.statsBreakdown(recBreak, httptest.NewRequest(http.MethodGet, "/api/stats/breakdown?"+qs, nil))
	if recBreak.Code != http.StatusOK {
		t.Fatalf("状态码 %d: %s", recBreak.Code, recBreak.Body.String())
	}
	var br struct {
		Total int64 `json:"total"`
	}
	if err := json.Unmarshal(recBreak.Body.Bytes(), &br); err != nil {
		t.Fatal(err)
	}
	if br.Total != 1 {
		t.Errorf("分布接口应只算自定义区间内的 1 次请求，得到 %d", br.Total)
	}
}
