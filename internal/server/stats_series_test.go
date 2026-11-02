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

// 看板环形图切到 Token 口径时，要能按 Token 消耗排模型：
// 调用次数不多、单次却特别长的模型在「调用次数前 12」里排不进来，
// 所以 breakdown 还得给一份按 Token 消耗排的模型列表。
func TestStatsBreakdownOrdersModelsByTokens(t *testing.T) {
	s, st := newTestServer(t, "stats-breakdown-tokens")

	now := time.Now()
	// model-a 调用次数多但每次很省 Token，model-b 调用只有一次但吃掉的 Token 最多。
	for _, m := range []struct {
		id    string
		calls int
		tokens int
	}{
		{"model-a", 10, 100},
		{"model-b", 1, 9000},
	} {
		for i := 0; i < m.calls; i++ {
			err := st.RecordStat(store.Log{
				Time:             now.UnixMilli(),
				ModelID:          m.id,
				ChannelID:        "ch-1",
				PromptTokens:     m.tokens * 4 / 5,
				CompletionTokens: m.tokens / 5,
				TotalTokens:      m.tokens,
				StatusCode:       200,
			})
			if err != nil {
				t.Fatal(err)
			}
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/api/stats/breakdown?range=all", nil)
	rec := httptest.NewRecorder()
	s.statsBreakdown(rec, req)

	var out struct {
		Models []struct {
			Name   string `json:"name"`
			Value  int64  `json:"value"`
			Tokens int64  `json:"tokens"`
		} `json:"models"`
		ModelsByTokens []struct {
			Name   string `json:"name"`
			Value  int64  `json:"value"`
			Tokens int64  `json:"tokens"`
		} `json:"models_by_tokens"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}

	if len(out.ModelsByTokens) != 2 {
		t.Fatalf("models_by_tokens 应有 2 项，实际 %d 项", len(out.ModelsByTokens))
	}
	// 按 Token 消耗排：model-b（9000）在前，model-a（1000）在后。
	if out.ModelsByTokens[0].Name != "model-b" {
		t.Errorf("models_by_tokens 第一项应是 model-b，实际 %s", out.ModelsByTokens[0].Name)
	}
	if out.ModelsByTokens[0].Tokens != 9000 {
		t.Errorf("model-b 的 tokens = %d，期望 9000", out.ModelsByTokens[0].Tokens)
	}
	// 两份列表都带上另一个口径的数字，前端切口径时不用再发一次请求。
	for _, m := range out.ModelsByTokens {
		wantCalls := map[string]int64{"model-a": 10, "model-b": 1}[m.Name]
		if m.Value != wantCalls {
			t.Errorf("%s 的调用次数 = %d，期望 %d", m.Name, m.Value, wantCalls)
		}
	}
	// 调用次数维度仍然按调用次数排：model-a 调用多，在前。
	if len(out.Models) != 2 || out.Models[0].Name != "model-a" {
		t.Errorf("models 应按调用次数排，model-a 在前，实际 %+v", out.Models)
	}
}

// 分模型序列要同时带上「按 Token 消耗排」的模型：
// 调用次数不多、单次却特别长的模型在调用量前 12 里排不进来，
// 前端切到 Token 口径时得能画它的曲线，不然图例里有这个模型、图上却没有线。
func TestStatsSeriesIncludesTokenHeavyModels(t *testing.T) {
	s, st := newTestServer(t, "stats-series-token-heavy")

	now := time.Now()
	for _, m := range []struct {
		id     string
		calls  int
		tokens int
	}{
		{"model-a", 10, 100},
		{"model-b", 1, 9000},
	} {
		for i := 0; i < m.calls; i++ {
			err := st.RecordStat(store.Log{
				Time:             now.UnixMilli(),
				ModelID:          m.id,
				ChannelID:        "ch-1",
				PromptTokens:     m.tokens * 4 / 5,
				CompletionTokens: m.tokens / 5,
				TotalTokens:      m.tokens,
				StatusCode:       200,
			})
			if err != nil {
				t.Fatal(err)
			}
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/api/stats/series?range=all", nil)
	rec := httptest.NewRecorder()
	s.statsSeries(rec, req)

	var out struct {
		ModelSeries map[string]struct {
			Requests    []int64 `json:"requests"`
			TotalTokens []int64 `json:"total_tokens"`
		} `json:"model_series"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}

	// model-b 只调了 1 次，调用量排不进前 12，但 Token 消耗最高，得有它的序列。
	one, ok := out.ModelSeries["model-b"]
	if !ok {
		t.Fatalf("model_series 缺少 model-b（Token 消耗最高），实际 %v", out.ModelSeries)
	}
	var tokSum int64
	for _, v := range one.TotalTokens {
		tokSum += v
	}
	if tokSum != 9000 {
		t.Errorf("model-b 的总 Token = %d，期望 9000", tokSum)
	}
}
