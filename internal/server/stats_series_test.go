package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"ldmapi/internal/store"
)

// 看板「调用趋势」在 Token 维度的「各模型」视图，曲线值直接来自
// statsSeries 返回的 model_series[模型].total_tokens。
// 字段名或口径一变，前端就画不出曲线（或者画成全 0），这里锁住它。
func TestStatsSeriesModelSeriesCarriesTotalTokens(t *testing.T) {
	s, st := newTestServer(t, "stats-series")

	now := time.Now()
	for _, m := range []struct {
		id     string
		prompt int
		comp   int
	}{
		{"model-a", 100, 40},
		{"model-b", 200, 80},
	} {
		err := st.RecordStat(store.Log{
			Time:             now.UnixMilli(),
			ModelID:          m.id,
			ChannelID:        "ch-1",
			PromptTokens:     m.prompt,
			CompletionTokens: m.comp,
			TotalTokens:      m.prompt + m.comp,
			StatusCode:       200,
		})
		if err != nil {
			t.Fatal(err)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/api/stats/series?range=all", nil)
	rec := httptest.NewRecorder()
	s.statsSeries(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("statsSeries 返回 %d: %s", rec.Code, rec.Body.String())
	}

	var out struct {
		ModelSeries map[string]struct {
			Requests      []int64 `json:"requests"`
			PromptTokens  []int64 `json:"prompt_tokens"`
			TotalTokens   []int64 `json:"total_tokens"`
			CompTokens    []int64 `json:"completion_tokens"`
			TotalRequests int64   `json:"-"`
		} `json:"model_series"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.ModelSeries) != 2 {
		t.Fatalf("model_series 应有 2 个模型，实际 %d 个: %v", len(out.ModelSeries), out.ModelSeries)
	}
	for _, want := range []struct {
		model  string
		total  int64
		prompt int64
	}{
		{"model-a", 140, 100},
		{"model-b", 280, 200},
	} {
		one, ok := out.ModelSeries[want.model]
		if !ok {
			t.Fatalf("model_series 缺少 %s", want.model)
		}
		if len(one.TotalTokens) == 0 {
			t.Fatalf("%s 的 total_tokens 是空数组，前端会画不出曲线", want.model)
		}
		var sum int64
		for _, v := range one.TotalTokens {
			sum += v
		}
		if sum != want.total {
			t.Errorf("%s 的 total_tokens 合计 = %d，期望 %d", want.model, sum, want.total)
		}
		var psum int64
		for _, v := range one.PromptTokens {
			psum += v
		}
		if psum != want.prompt {
			t.Errorf("%s 的 prompt_tokens 合计 = %d，期望 %d", want.model, psum, want.prompt)
		}
	}
}

// 单模型视图走 model 参数，后端要把该模型的 Token 一起返回，
// 否则「输入 / 输出 / 总 Token」三条线全是 0。
func TestStatsSeriesScopedModelKeepsTokens(t *testing.T) {
	s, st := newTestServer(t, "stats-series-scope")

	now := time.Now()
	for _, m := range []struct {
		id    string
		total int
	}{
		{"model-a", 140},
		{"model-b", 280},
	} {
		err := st.RecordStat(store.Log{
			Time:             now.UnixMilli(),
			ModelID:          m.id,
			ChannelID:        "ch-1",
			PromptTokens:     m.total * 5 / 7,
			CompletionTokens: m.total * 2 / 7,
			TotalTokens:      m.total,
			StatusCode:       200,
		})
		if err != nil {
			t.Fatal(err)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/api/stats/series?range=all&model=model-a", nil)
	rec := httptest.NewRecorder()
	s.statsSeries(rec, req)

	var out struct {
		Points []struct {
			Requests     int64 `json:"requests"`
			TotalTokens  int64 `json:"total_tokens"`
			PromptTokens int64 `json:"prompt_tokens"`
			CompTokens   int64 `json:"completion_tokens"`
		} `json:"points"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	var reqs, total, prompt, comp int64
	for _, p := range out.Points {
		reqs += p.Requests
		total += p.TotalTokens
		prompt += p.PromptTokens
		comp += p.CompTokens
	}
	if reqs != 1 {
		t.Errorf("model-a 的请求数 = %d，期望 1", reqs)
	}
	if total != 140 {
		t.Errorf("model-a 的 total_tokens = %d，期望 140", total)
	}
	if prompt != 100 {
		t.Errorf("model-a 的 prompt_tokens = %d，期望 100", prompt)
	}
	if comp != 40 {
		t.Errorf("model-a 的 completion_tokens = %d，期望 40", comp)
	}
}

// 图例在 Token 维度下要显示每个模型的 Token 消耗，
// 所以 breakdown 的模型项必须带上 tokens 字段。
func TestStatsBreakdownCarriesPerModelTokens(t *testing.T) {
	s, st := newTestServer(t, "stats-breakdown")

	now := time.Now()
	for _, m := range []struct {
		id    string
		total int
	}{
		{"model-a", 140},
		{"model-b", 280},
	} {
		err := st.RecordStat(store.Log{
			Time:             now.UnixMilli(),
			ModelID:          m.id,
			ChannelID:        "ch-1",
			PromptTokens:     m.total * 5 / 7,
			CompletionTokens: m.total * 2 / 7,
			TotalTokens:      m.total,
			StatusCode:       200,
		})
		if err != nil {
			t.Fatal(err)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/api/stats/breakdown?range=all", nil)
	rec := httptest.NewRecorder()
	s.statsBreakdown(rec, req)

	var out struct {
		Models []struct {
			Name   string `json:"name"`
			Value  int64  `json:"value"`
			Errors int64  `json:"errors"`
			Tokens int64  `json:"tokens"`
		} `json:"models"`
		Total      int64 `json:"total"`
		TokensUsed int64 `json:"tokens_used"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Models) != 2 {
		t.Fatalf("models 应有 2 项，实际 %d 项", len(out.Models))
	}
	for _, m := range out.Models {
		want := map[string]int64{"model-a": 140, "model-b": 280}[m.Name]
		if m.Tokens != want {
			t.Errorf("%s 的 tokens = %d，期望 %d", m.Name, m.Tokens, want)
		}
		if m.Value != 1 {
			t.Errorf("%s 的调用次数 = %d，期望 1", m.Name, m.Value)
		}
	}
	if out.TokensUsed != 420 {
		t.Errorf("tokens_used = %d，期望 420", out.TokensUsed)
	}
}
