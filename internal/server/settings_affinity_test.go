package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"ldmapi/internal/relay"
)

// clearAffinityState 清掉 relay 包里的全局亲和与冷却，避免用例互相影响。
func clearAffinityState() {
	relay.ClearAffinity(true, true)
}

func settingsCall(t *testing.T, s *Server, method, path, payload string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(payload))
	rec := httptest.NewRecorder()
	switch path {
	case "/api/settings":
		if method == http.MethodPost {
			t.Fatalf("设置接口只支持 GET / PUT")
		}
		if method == http.MethodGet {
			s.handleGetSettings(rec, req)
		} else {
			s.saveSettings(rec, req)
		}
	case "/api/settings/clear-affinity":
		s.clearAffinity(rec, req)
	default:
		t.Fatalf("未知路径 %s", path)
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// 系统设置能保存亲和自动清理的间隔与范围，并把当前亲和条数带回来。
func TestSettingsAffinityCleanupFields(t *testing.T) {
	s, st := newTestServer(t, "affinity-settings")
	clearAffinityState()
	t.Cleanup(clearAffinityState)

	relay.MarkSuccess("m1", "ch1", "up1")
	relay.MarkKeySuccess("ch1", "sk-a")

	code, out := settingsCall(t, s, http.MethodPut, "/api/settings",
		`{"affinity_cleanup_hours":6,"affinity_clean_channel":true,"affinity_clean_model":true}`)
	if code != http.StatusOK {
		t.Fatalf("保存设置失败：%d", code)
	}
	if out["affinity_cleanup_hours"] != float64(6) {
		t.Errorf("间隔应为 6，实际 %v", out["affinity_cleanup_hours"])
	}
	if out["affinity_clean_channel"] != true || out["affinity_clean_model"] != true {
		t.Errorf("清理范围应为渠道 + 模型，实际 %v / %v", out["affinity_clean_channel"], out["affinity_clean_model"])
	}
	if out["affinity_model_count"] != float64(1) || out["affinity_channel_count"] != float64(1) {
		t.Errorf("当前亲和应为模型 1 / 渠道 1，实际 %v / %v", out["affinity_model_count"], out["affinity_channel_count"])
	}

	saved, err := st.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if saved.AffinityCleanupHours != 6 || !saved.AffinityCleanChannel || !saved.AffinityCleanModel {
		t.Errorf("设置没有落盘：%+v", saved)
	}

	// 间隔为 0 表示关闭，允许清掉之前的配置。
	_, out = settingsCall(t, s, http.MethodPut, "/api/settings", `{"affinity_cleanup_hours":0}`)
	if out["affinity_cleanup_hours"] != float64(0) {
		t.Errorf("间隔应被清零，实际 %v", out["affinity_cleanup_hours"])
	}
}

// 「立即清理」按传入范围清，返回清掉的条数，且不动失败冷却。
func TestClearAffinityEndpoint(t *testing.T) {
	s, _ := newTestServer(t, "affinity-clear")
	clearAffinityState()
	t.Cleanup(clearAffinityState)

	relay.MarkSuccess("m1", "ch1", "up1")
	relay.MarkKeySuccess("ch1", "sk-a")

	code, out := settingsCall(t, s, http.MethodPost, "/api/settings/clear-affinity", `{"channel":false,"model":true}`)
	if code != http.StatusOK {
		t.Fatalf("清理接口失败：%d", code)
	}
	if out["affinity"] != float64(1) {
		t.Errorf("应清理 1 条模型亲和，实际 %v", out["affinity"])
	}
	if m, c := relay.AffinityCount(); m != 0 || c != 1 {
		t.Errorf("清理后应剩渠道 1 条，实际模型 %d / 渠道 %d", m, c)
	}

	// 两种都不选是无效请求。
	code, _ = settingsCall(t, s, http.MethodPost, "/api/settings/clear-affinity", `{"channel":false,"model":false}`)
	if code != http.StatusBadRequest {
		t.Errorf("两种范围都不选应返回 400，实际 %d", code)
	}

	// 不带 body 时全部清。
	code, out = settingsCall(t, s, http.MethodPost, "/api/settings/clear-affinity", "")
	if code != http.StatusOK || out["affinity"] != float64(1) {
		t.Errorf("默认应清掉剩下的 1 条渠道亲和，实际 %d / %v", code, out["affinity"])
	}
}

// 定时清理按间隔执行：首次只记基线，没到点不动，到点清空并更新基准。
func TestCleanupAffinitySchedule(t *testing.T) {
	s, st := newTestServer(t, "affinity-schedule")
	clearAffinityState()
	t.Cleanup(clearAffinityState)

	st0, err := st.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	st0.AffinityCleanupHours = 1
	st0.AffinityCleanChannel = true
	st0.AffinityCleanModel = true
	if err := st.SaveSettings(st0); err != nil {
		t.Fatal(err)
	}
	relay.MarkSuccess("m1", "ch1", "up1")
	relay.MarkKeySuccess("ch1", "sk-a")

	// 第一次调用只记录基线，不清理。
	if n := s.CleanupAffinity(); n != 0 {
		t.Fatalf("首次调用应只记基线，实际清了 %d 条", n)
	}
	if m, c := relay.AffinityCount(); m != 1 || c != 1 {
		t.Fatalf("基线阶段不应清亲和，实际 %d / %d", m, c)
	}
	if n := s.CleanupAffinity(); n != 0 {
		t.Fatalf("未到间隔不应清理，实际清了 %d 条", n)
	}

	// 把上次清理时间往前拨两小时，下一次调用就该清。
	past := time.Now().Add(-2 * time.Hour).UnixMilli()
	if err := st.SetMeta(affinityCleanupMetaKey, strconv.FormatInt(past, 10)); err != nil {
		t.Fatal(err)
	}
	if n := s.CleanupAffinity(); n != 2 {
		t.Fatalf("到点应清掉 2 条亲和，实际 %d", n)
	}
	if m, c := relay.AffinityCount(); m != 0 || c != 0 {
		t.Fatalf("清理后不应残留亲和，实际 %d / %d", m, c)
	}
	if last := s.affinityCleanupAt(); time.Since(last) > time.Minute {
		t.Errorf("清理后应更新基准时间，实际 %v", last)
	}

	// 关闭后不再清理。
	relay.MarkSuccess("m1", "ch1", "up1")
	st0.AffinityCleanupHours = 0
	if err := st.SaveSettings(st0); err != nil {
		t.Fatal(err)
	}
	if n := s.CleanupAffinity(); n != 0 {
		t.Fatalf("关闭后不应清理，实际 %d", n)
	}
	if m, _ := relay.AffinityCount(); m != 1 {
		t.Errorf("关闭后亲和应原样保留，实际模型 %d 条", m)
	}
}
