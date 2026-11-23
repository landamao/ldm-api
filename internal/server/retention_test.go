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

// 日志与统计的保留天数是两个独立配置：未单独设置统计天数时沿用日志的天数，
// 保存其中一个不会覆盖另一个。
func TestSettingsRetentionSeparated(t *testing.T) {
	s, st := newTestServer(t, "retention-settings")
	if err := st.SaveSettings(store.Settings{LogRetentionDays: 30}); err != nil {
		t.Fatal(err)
	}

	code, out := settingsCall(t, s, http.MethodGet, "/api/settings", "")
	if code != http.StatusOK {
		t.Fatalf("读取设置失败：%d", code)
	}
	if out["log_retention_days"] != float64(30) {
		t.Errorf("日志保留天数应为 30，实际 %v", out["log_retention_days"])
	}
	if out["stats_retention_days"] != float64(30) {
		t.Errorf("未单独设置时统计应沿用日志的 30 天，实际 %v", out["stats_retention_days"])
	}

	code, out = settingsCall(t, s, http.MethodPut, "/api/settings",
		`{"log_retention_days":7,"stats_retention_days":0}`)
	if code != http.StatusOK {
		t.Fatalf("保存设置失败：%d", code)
	}
	if out["log_retention_days"] != float64(7) || out["stats_retention_days"] != float64(0) {
		t.Errorf("应分别保存为 7 天 / 0 天，实际 %v / %v",
			out["log_retention_days"], out["stats_retention_days"])
	}

	// 只改日志保留天数时，已显式设置的统计天数不能被带回日志值。
	_, out = settingsCall(t, s, http.MethodPut, "/api/settings", `{"log_retention_days":3}`)
	if out["log_retention_days"] != float64(3) {
		t.Errorf("日志保留天数应为 3，实际 %v", out["log_retention_days"])
	}
	if out["stats_retention_days"] != float64(0) {
		t.Errorf("统计保留天数应保持为 0，实际 %v", out["stats_retention_days"])
	}
}

// 自动清理按各自的保留天数计算截止时间：改日志天数不会误删统计，反之亦然。
func TestCleanupUsesSeparateRetention(t *testing.T) {
	cases := []struct {
		name      string
		logDays   int
		statsDays *int
		wantLogs  int
		wantStats int
	}{
		// 40 天前、20 天前、现在各一条；日志保留 30 天 => 留下后两条，
		// 统计保留 10 天 => 只留下现在这一条。
		{"日志保留更久", 30, intp(10), 2, 1},
		// 反过来：日志只留现在，统计留下 20 天前和现在。
		{"统计保留更久", 10, intp(30), 1, 2},
		// 老配置没有统计天数：沿用日志的天数，两份数据清到同一时间点。
		{"统计沿用日志天数", 10, nil, 1, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, st := newTestServer(t, "retention-cleanup")
			now := time.Now()
			for _, days := range []int{40, 20, 0} {
				ms := now.AddDate(0, 0, -days).UnixMilli()
				if err := st.AppendLog(store.Log{ID: fmt.Sprintf("old-%d", days), Time: ms, StatusCode: 200}); err != nil {
					t.Fatal(err)
				}
				if err := st.RecordStat(store.Log{Time: ms, StatusCode: 200}); err != nil {
					t.Fatal(err)
				}
			}
			if err := st.SaveSettings(store.Settings{
				LogRetentionDays:   tc.logDays,
				StatsRetentionDays: tc.statsDays,
			}); err != nil {
				t.Fatal(err)
			}

			s.Cleanup()

			logs, err := st.CountLogs()
			if err != nil {
				t.Fatal(err)
			}
			if logs != tc.wantLogs {
				t.Errorf("日志应剩 %d 条，实际 %d 条", tc.wantLogs, logs)
			}
			buckets, err := st.RangeStats(0, now.Add(24*time.Hour).UnixMilli())
			if err != nil {
				t.Fatal(err)
			}
			if len(buckets) != tc.wantStats {
				t.Errorf("统计应剩 %d 个时段，实际 %d 个", tc.wantStats, len(buckets))
			}
		})
	}
}

// 手动删除接口按各自的数据源删除，互不影响；统计接口必须显式指定截止时间。
func TestPurgeBeforeSeparatesLogsAndStats(t *testing.T) {
	s, st := newTestServer(t, "retention-manual")
	now := time.Now()
	cutoff := now.AddDate(0, 0, -15).UnixMilli()
	for _, days := range []int{20, 0} {
		ms := now.AddDate(0, 0, -days).UnixMilli()
		if err := st.AppendLog(store.Log{ID: fmt.Sprintf("l-%d", days), Time: ms, StatusCode: 200}); err != nil {
			t.Fatal(err)
		}
		if err := st.RecordStat(store.Log{Time: ms, StatusCode: 200}); err != nil {
			t.Fatal(err)
		}
	}

	// 删日志：统计保持 2 个时段。
	rec := httptest.NewRecorder()
	s.clearLogs(rec, httptest.NewRequest(http.MethodDelete, fmt.Sprintf("/api/logs?before=%d", cutoff), nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("删除日志失败：%d %s", rec.Code, rec.Body.String())
	}
	if n := countLogsRemoved(t, rec.Body.Bytes()); n != 1 {
		t.Errorf("应删除 1 条日志，实际 %d", n)
	}
	if logs, _ := st.CountLogs(); logs != 1 {
		t.Errorf("日志应剩 1 条，实际 %d 条", logs)
	}
	buckets, _ := st.RangeStats(0, now.Add(24*time.Hour).UnixMilli())
	if len(buckets) != 2 {
		t.Errorf("删除日志不应影响统计，实际剩 %d 个时段", len(buckets))
	}

	// 删统计：日志保持 1 条。
	rec = httptest.NewRecorder()
	s.clearStats(rec, httptest.NewRequest(http.MethodDelete, fmt.Sprintf("/api/stats?before=%d", cutoff), nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("删除统计失败：%d %s", rec.Code, rec.Body.String())
	}
	if n := countLogsRemoved(t, rec.Body.Bytes()); n != 1 {
		t.Errorf("应删除 1 个统计时段，实际 %d", n)
	}
	if logs, _ := st.CountLogs(); logs != 1 {
		t.Errorf("删除统计不应影响日志，实际剩 %d 条", logs)
	}
	buckets, _ = st.RangeStats(0, now.Add(24*time.Hour).UnixMilli())
	if len(buckets) != 1 {
		t.Errorf("统计应剩 1 个时段，实际 %d 个", len(buckets))
	}

	// 不传截止时间时拒绝执行，避免误删全部统计。
	rec = httptest.NewRecorder()
	s.clearStats(rec, httptest.NewRequest(http.MethodDelete, "/api/stats", nil))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("缺少截止时间应返回 400，实际 %d", rec.Code)
	}
}

// countLogsRemoved 读取清理接口响应里的 removed 字段。
func countLogsRemoved(t *testing.T, body []byte) int {
	t.Helper()
	var out struct {
		Removed int `json:"removed"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("解析响应失败：%v", err)
	}
	return out.Removed
}
