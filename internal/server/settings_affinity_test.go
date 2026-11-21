package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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

// 系统设置能保存亲和空闲清理的阈值与范围，并把当前亲和条数带回来。
func TestSettingsAffinityCleanupFields(t *testing.T) {
	s, st := newTestServer(t, "affinity-settings")
	clearAffinityState()
	t.Cleanup(clearAffinityState)

	relay.MarkSuccess("m1", "ch1", "up1")
	relay.MarkKeySuccess("ch1", "sk-a")

	code, out := settingsCall(t, s, http.MethodPut, "/api/settings",
		`{"affinity_cleanup_minutes":90,"affinity_clean_channel":true,"affinity_clean_model":true}`)
	if code != http.StatusOK {
		t.Fatalf("保存设置失败：%d", code)
	}
	if out["affinity_cleanup_minutes"] != float64(90) {
		t.Errorf("空闲阈值应为 90 分钟，实际 %v", out["affinity_cleanup_minutes"])
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
	if saved.AffinityCleanupMinutes != 90 || !saved.AffinityCleanChannel || !saved.AffinityCleanModel {
		t.Errorf("设置没有落盘：%+v", saved)
	}

	// 阈值上限一年，超出的值会被截断。
	_, out = settingsCall(t, s, http.MethodPut, "/api/settings", `{"affinity_cleanup_minutes":9999999}`)
	if out["affinity_cleanup_minutes"] != float64(365*24*60) {
		t.Errorf("超过一年应被截断到 %d，实际 %v", 365*24*60, out["affinity_cleanup_minutes"])
	}

	// 阈值为 0 表示关闭，允许清掉之前的配置。
	_, out = settingsCall(t, s, http.MethodPut, "/api/settings", `{"affinity_cleanup_minutes":0}`)
	if out["affinity_cleanup_minutes"] != float64(0) {
		t.Errorf("阈值应被清零，实际 %v", out["affinity_cleanup_minutes"])
	}
}

func TestSettingsAllowUnlistedChannelModels(t *testing.T) {
	s, st := newTestServer(t, "allow-unlisted-channel-models")

	code, out := settingsCall(t, s, http.MethodPut, "/api/settings", `{"allow_unlisted_channel_models":true}`)
	if code != http.StatusOK {
		t.Fatalf("保存直连渠道模型开关失败：%d", code)
	}
	if out["allow_unlisted_channel_models"] != true {
		t.Fatalf("响应中的开关应为 true，实际 %v", out["allow_unlisted_channel_models"])
	}
	saved, err := st.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if !saved.AllowUnlistedChannelModels {
		t.Fatal("直连渠道模型开关没有落盘")
	}

	code, out = settingsCall(t, s, http.MethodPut, "/api/settings", `{"allow_unlisted_channel_models":false}`)
	if code != http.StatusOK || out["allow_unlisted_channel_models"] != false {
		t.Fatalf("关闭直连渠道模型开关失败：状态 %d，响应 %v", code, out)
	}
	saved, err = st.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if saved.AllowUnlistedChannelModels {
		t.Fatal("直连渠道模型开关关闭后仍为 true")
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

// 空闲清理按「每条亲和的最后一次成功使用」判断，不再到点整批清空：
// 刚用过的免清，只有闲置超过阈值才被删；关闭后完全不动。
func TestCleanupAffinityIdle(t *testing.T) {
	s, st := newTestServer(t, "affinity-idle")
	clearAffinityState()
	t.Cleanup(clearAffinityState)

	st0, err := st.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	st0.AffinityCleanupMinutes = 5
	st0.AffinityCleanChannel = true
	st0.AffinityCleanModel = true
	if err := st.SaveSettings(st0); err != nil {
		t.Fatal(err)
	}
	relay.MarkSuccess("m1", "ch1", "up1")
	relay.MarkKeySuccess("ch1", "sk-a")

	// 刚写入的亲和空闲不到 5 分钟，反复调用都不该清，也不需要记清理时间。
	for i := 0; i < 3; i++ {
		if n := s.CleanupAffinity(); n != 0 {
			t.Fatalf("第 %d 次调用清掉了正在用的亲和 %d 条", i+1, n)
		}
	}
	if m, c := relay.AffinityCount(); m != 1 || c != 1 {
		t.Fatalf("正在用的亲和应保留，实际 %d / %d", m, c)
	}
	if last := s.affinityCleanupAt(); !last.IsZero() {
		t.Errorf("没清到记录时不该更新清理时间，实际 %v", last)
	}

	// 用完一次再调用：时刻刷新，仍然不清。
	relay.MarkSuccess("m1", "ch1", "up1")
	if n := s.CleanupAffinity(); n != 0 {
		t.Fatalf("刚命中过的亲和不该被清，实际 %d 条", n)
	}

	// 关闭后不再清理，亲和原样保留。
	relay.MarkSuccess("m2", "ch2", "up2")
	st0.AffinityCleanupMinutes = 0
	if err := st.SaveSettings(st0); err != nil {
		t.Fatal(err)
	}
	if n := s.CleanupAffinity(); n != 0 {
		t.Fatalf("关闭后不应清理，实际 %d", n)
	}
	if m, _ := relay.AffinityCount(); m != 2 {
		t.Errorf("关闭后亲和应原样保留，实际模型 %d 条", m)
	}
}
