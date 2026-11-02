package server

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"ldmapi/internal/store"
)

// ---------- 令牌 ----------

type tokenView struct {
	store.Token
	Expired bool `json:"expired"`
	UsedPct int  `json:"used_pct"`
}

func (s *Server) listTokens(w http.ResponseWriter, r *http.Request) {
	tokens, err := s.store.ListTokens()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	out := make([]tokenView, 0, len(tokens))
	for _, t := range tokens {
		v := tokenView{Token: t}
		if t.ExpiresAt > 0 && time.Now().UnixMilli() > t.ExpiresAt {
			v.Expired = true
		}
		if t.QuotaLimit > 0 {
			v.UsedPct = int(t.UsedQuota * 100 / t.QuotaLimit)
			if v.UsedPct > 100 {
				v.UsedPct = 100
			}
		}
		out = append(out, v)
	}
	writeOK(w, out)
}

func (s *Server) saveToken(w http.ResponseWriter, r *http.Request) {
	// 所有可编辑字段都用指针：PUT 只更新请求里出现的字段，
	// 切换启用状态时不会把额度、过期时间、模型权限和备注清空。
	var req struct {
		ID            string    `json:"id"`
		Name          *string   `json:"name"`
		Enabled       *bool     `json:"enabled"`
		ExpiresAt     *int64    `json:"expires_at"`
		QuotaLimit    *int64    `json:"quota_limit"`
		AllowedModels *[]string `json:"allowed_models"`
		AllowedIPs    *[]string `json:"allowed_ips"`
		Remark        *string   `json:"remark"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if req.ID == "" {
		req.ID = r.PathValue("id")
	}

	var t store.Token
	isNew := true
	if req.ID != "" {
		existing, err := s.store.GetToken(req.ID)
		if err == nil {
			t = existing
			isNew = false
		} else if !errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
	}

	if isNew {
		t.ID = randomHex(8)
		t.Key = newAPIKey()
		t.CreatedAt = time.Now().UnixMilli()
		t.Enabled = true
	}
	if req.Name != nil {
		if name := strings.TrimSpace(*req.Name); name != "" {
			t.Name = name
		}
	}
	if t.Name == "" {
		t.Name = "默认密钥"
	}
	if req.Enabled != nil {
		t.Enabled = *req.Enabled
	}
	if req.ExpiresAt != nil {
		v := *req.ExpiresAt
		if v < 0 {
			v = 0
		}
		t.ExpiresAt = v
	}
	if req.QuotaLimit != nil {
		v := *req.QuotaLimit
		if v < 0 {
			v = 0
		}
		t.QuotaLimit = v
	}
	if req.AllowedModels != nil {
		t.AllowedModels = append([]string{}, (*req.AllowedModels)...)
	}
	if t.AllowedModels == nil {
		t.AllowedModels = []string{}
	}
	if req.AllowedIPs != nil {
		rules, err := normalizeIPRules(*req.AllowedIPs)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		t.AllowedIPs = rules
	}
	if t.AllowedIPs == nil {
		t.AllowedIPs = []string{}
	}
	if req.Remark != nil {
		t.Remark = strings.TrimSpace(*req.Remark)
	}
	t.UpdatedAt = time.Now().UnixMilli()

	if err := s.store.SaveToken(t); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeOK(w, t)
}

func (s *Server) deleteToken(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteToken(r.PathValue("id")); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeOK(w, nil)
}

// ---------- 日志 ----------

func (s *Server) listLogs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.LogFilter{
		TokenID:   q.Get("token_id"),
		ModelID:   q.Get("model_id"),
		ChannelID: q.Get("channel_id"),
		Status:    q.Get("status"),
		OnlyError: q.Get("only_error") == "true",
		Limit:     atoiDefault(q.Get("limit"), 50),
		Offset:    atoiDefault(q.Get("offset"), 0),
	}
	if f.Status == "" && f.OnlyError {
		f.Status = "error"
	}
	if v := q.Get("start"); v != "" {
		f.Start = int64(atoiDefault(v, 0))
	}
	if v := q.Get("end"); v != "" {
		f.End = int64(atoiDefault(v, 0))
	}
	logs, total, err := s.store.QueryLogs(f)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeOK(w, map[string]any{"items": logs, "total": total})
}

// logFacets 返回时间区间内日志实际出现过的模型 / 渠道 / 密钥，供筛选下拉使用。
// 区间内没有记录的配置项不会出现在下拉里；配置里已删除的历史模型只要还有
// 日志就仍然可选。
func (s *Server) logFacets(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	facets, err := s.store.QueryLogFacets(
		int64(atoiDefault(q.Get("start"), 0)),
		int64(atoiDefault(q.Get("end"), 0)),
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeOK(w, facets)
}

func (s *Server) clearLogs(w http.ResponseWriter, r *http.Request) {
	before := time.Now().UnixMilli()
	if v := r.URL.Query().Get("before"); v != "" {
		before = int64(atoiDefault(v, 0))
	}
	n, err := s.store.PurgeLogsBefore(before)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeOK(w, map[string]any{"removed": n})
}

// ---------- 统计 ----------

// dashboardLocation 让看板的自然日 / 周 / 月固定按北京时间划分，不受服务器时区影响。
var dashboardLocation = time.FixedZone("Asia/Shanghai", 8*60*60)

// statRange 是看板选中的自然时间区间及其上一周期的同期区间。
type statRange struct {
	Key       string
	Start     time.Time
	End       time.Time // 区间终点（含）；固定区间取当前时刻
	PrevStart time.Time
	PrevEnd   time.Time
	Step      time.Duration // 时间序列的聚合粒度
}

func parseStatRange(key string, now time.Time) statRange {
	now = now.In(dashboardLocation)
	switch key {
	case "week":
		start := startOfWeek(now)
		prevStart := start.AddDate(0, 0, -7)
		return statRange{Key: "week", Start: start, End: now, PrevStart: prevStart, PrevEnd: prevStart.Add(now.Sub(start)), Step: 24 * time.Hour}
	case "month":
		start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
		prevStart := time.Date(now.Year(), now.Month()-1, 1, 0, 0, 0, 0, now.Location())
		prevEnd := prevStart.Add(now.Sub(start))
		// 上月天数比本月少时，同期区间最多到本月 1 号。
		if prevEnd.After(start) {
			prevEnd = start
		}
		return statRange{Key: "month", Start: start, End: now, PrevStart: prevStart, PrevEnd: prevEnd, Step: 24 * time.Hour}
	default:
		start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
		prevStart := start.AddDate(0, 0, -1)
		return statRange{Key: "today", Start: start, End: now, PrevStart: prevStart, PrevEnd: prevStart.Add(now.Sub(start)), Step: time.Hour}
	}
}

// statRangeFor 解析看板区间。除今日 / 本周 / 本月外还支持 all：
// 从最早一条统计记录所在自然日开始累计，没有上一周期可对比。
func (s *Server) statRangeFor(key string, now time.Time) statRange {
	if !strings.EqualFold(strings.TrimSpace(key), "all") {
		return parseStatRange(key, now)
	}
	now = now.In(dashboardLocation)
	start := s.earliestRangeStart(now)
	// 一天以内按小时看曲线更细；再长就按自然日聚合，时间刻度也不会跨天混淆。
	return statRange{Key: "all", Start: start, End: now, PrevStart: start, PrevEnd: start, Step: statStep(now.Sub(start))}
}

// earliestRangeStart 最早一条统计记录所在自然日的 0 点；一条记录都没有时取 end 当天 0 点。
func (s *Server) earliestRangeStart(end time.Time) time.Time {
	loc := end.Location()
	start := time.Date(end.Year(), end.Month(), end.Day(), 0, 0, 0, 0, loc)
	if ms, ok, err := s.store.EarliestStat(); err == nil && ok {
		if t := time.UnixMilli(ms).In(loc); t.Before(start) {
			start = time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
		}
	}
	return start
}

// statRangeFromQuery 在看板预设区间的基础上支持自定义起止：
// 请求里带 start / end（毫秒时间戳，和调用日志接口同一套参数）时按自定义区间算，
// 否则退回 range 预设。两端的 0 / 空都表示这一端不限。
func (s *Server) statRangeFromQuery(q url.Values, now time.Time) statRange {
	startMS := int64(atoiDefault(q.Get("start"), 0))
	endMS := int64(atoiDefault(q.Get("end"), 0))
	key := strings.TrimSpace(q.Get("range"))
	// range=custom 且两端都没给：开始和结束都不限，等于「全部时间」。
	// 不这么兜底会落到 parseStatRange 的默认分支，变成「今日」。
	if strings.EqualFold(key, "custom") && startMS <= 0 && endMS <= 0 {
		return s.statRangeFor("all", now)
	}
	if startMS > 0 || endMS > 0 {
		return s.customStatRange(startMS, endMS, now)
	}
	return s.statRangeFor(key, now)
}

// customStatRange 把自定义起止换算成看板区间。结束时间不填（或用未来时间）
// 就是此刻；开始时间不填就从最早一条统计记录算起，和「全部时间」同一个起点。
// 上一周期取紧邻的等长区间用于环比。
func (s *Server) customStatRange(startMS, endMS int64, now time.Time) statRange {
	now = now.In(dashboardLocation)
	loc := now.Location()
	end := now
	if endMS > 0 {
		if t := time.UnixMilli(endMS).In(loc); t.Before(end) {
			end = t
		}
	}
	start := s.earliestRangeStart(end)
	if startMS > 0 {
		if t := time.UnixMilli(startMS).In(loc); t.Before(end) {
			start = t
		}
	}
	span := end.Sub(start)
	return statRange{
		Key:       "custom",
		Start:     start,
		End:       end,
		PrevStart: start.Add(-span),
		PrevEnd:   start,
		Step:      statStep(span),
	}
}

// statStep 决定时间序列的聚合粒度：一天以内按小时，更长按自然日。
func statStep(span time.Duration) time.Duration {
	if span <= 24*time.Hour {
		return time.Hour
	}
	return 24 * time.Hour
}

// startOfWeek 返回本周一 0 点。
func startOfWeek(t time.Time) time.Time {
	day := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
	wd := int(day.Weekday())
	if wd == 0 {
		wd = 7
	}
	return day.AddDate(0, 0, -(wd - 1))
}

// localDayStart 把毫秒时间戳对齐到本地自然日 0 点。
func localDayStart(ms int64, loc *time.Location) int64 {
	t := time.UnixMilli(ms).In(loc)
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, loc).UnixMilli()
}

func (s *Server) statsOverview(w http.ResponseWriter, r *http.Request) {
	now := time.Now().In(dashboardLocation)
	rng := s.statRangeFromQuery(r.URL.Query(), now)
	model := strings.TrimSpace(r.URL.Query().Get("model"))
	current, _ := s.store.RangeStats(rng.Start.UnixMilli(), rng.End.UnixMilli())
	previous, _ := s.store.RangeStats(rng.PrevStart.UnixMilli(), rng.PrevEnd.UnixMilli()-1)
	// 带 model 时把统计收窄到单个模型，指标口径和全部模型时完全一致。
	if model != "" {
		current = scopeBucketsByModel(current, model)
		previous = scopeBucketsByModel(previous, model)
	}

	chans, _ := s.store.ListChannels()
	models, _ := s.store.ListModels()
	tokens, _ := s.store.ListTokens()
	enabledModels := 0
	for _, m := range models {
		if m.Enabled {
			enabledModels++
		}
	}
	enabledChans := 0
	for _, c := range chans {
		if c.Enabled {
			enabledChans++
		}
	}

	writeOK(w, map[string]any{
		"range":       rng.Key,
		"model":       model,
		"start":       rng.Start.UnixMilli(),
		"end":         rng.End.UnixMilli(),
		"current":     sumBuckets(current),
		"previous":    sumBuckets(previous),
		"channels":    map[string]int{"total": len(chans), "enabled": enabledChans},
		"models":      map[string]int{"total": len(models), "enabled": enabledModels},
		"tokens":      map[string]int{"total": len(tokens)},
		"server_time": now.UnixMilli(),
		"uptime":      int64(time.Since(s.StartedAt).Seconds()),
	})
}

// scopeBucketsByModel 把桶里的统计收窄到单个模型。
// 返回的桶结构不变，可以继续走 sumBuckets，指标口径和全部模型时一致。
func scopeBucketsByModel(buckets []store.Bucket, model string) []store.Bucket {
	out := make([]store.Bucket, 0, len(buckets))
	for _, b := range buckets {
		ms := b.ModelStatOf(model)
		out = append(out, store.Bucket{
			Hour:              b.Hour,
			Requests:          ms.Requests,
			Errors:            ms.Errors,
			PromptTokens:      ms.PromptTokens,
			CompletionTokens:  ms.CompletionTokens,
			TotalTokens:       ms.TotalTokens,
			LatencySum:        ms.LatencySum,
			SpeedCount:        ms.SpeedCount,
			SpeedSum:          ms.SpeedSum,
			SpeedLatencySum:   ms.SpeedLatencySum,
			SpeedFirstByteSum: ms.SpeedFirstByteSum,
		})
	}
	return out
}

type bucketSummary struct {
	Requests         int64   `json:"requests"`
	Errors           int64   `json:"errors"`
	PromptTokens     int64   `json:"prompt_tokens"`
	CompletionTokens int64   `json:"completion_tokens"`
	TotalTokens      int64   `json:"total_tokens"`
	AvgLatency       float64 `json:"avg_latency"`
	SuccessRate      float64 `json:"success_rate"`
	// 平均速度只统计首字、总耗时、速度三项都有的记录
	SpeedSamples    int64   `json:"speed_samples"`
	AvgSpeed        float64 `json:"avg_speed"`
	AvgFirstByte    float64 `json:"avg_first_byte"`
	AvgSpeedLatency float64 `json:"avg_speed_latency"`
}

func sumBuckets(bs []store.Bucket) bucketSummary {
	var out bucketSummary
	var latencySum, speedLatencySum, firstByteSum int64
	var speedSum float64
	for _, b := range bs {
		out.Requests += b.Requests
		out.Errors += b.Errors
		out.PromptTokens += b.PromptTokens
		out.CompletionTokens += b.CompletionTokens
		out.TotalTokens += b.TotalTokens
		latencySum += b.LatencySum
		out.SpeedSamples += b.SpeedCount
		speedSum += b.SpeedSum
		speedLatencySum += b.SpeedLatencySum
		firstByteSum += b.SpeedFirstByteSum
	}
	if out.Requests > 0 {
		out.AvgLatency = float64(latencySum) / float64(out.Requests)
		out.SuccessRate = float64(out.Requests-out.Errors) * 100 / float64(out.Requests)
	} else {
		out.SuccessRate = 100
	}
	if out.SpeedSamples > 0 {
		out.AvgSpeed = speedSum / float64(out.SpeedSamples)
		out.AvgFirstByte = float64(firstByteSum) / float64(out.SpeedSamples)
		out.AvgSpeedLatency = float64(speedLatencySum) / float64(out.SpeedSamples)
	}
	return out
}

// statsSeries 返回按小时（今天、跨度不足一天的全部）或按自然日（本周 / 本月 / 全部）
// 聚合的时间序列。
// 带 model 参数时只返回该模型的分项；不带时额外返回每个模型的分项序列
// （model_series），看板据此在总览里按模型画曲线。
func (s *Server) statsSeries(w http.ResponseWriter, r *http.Request) {
	now := time.Now().In(dashboardLocation)
	rng := s.statRangeFromQuery(r.URL.Query(), now)
	model := strings.TrimSpace(r.URL.Query().Get("model"))
	buckets, _ := s.store.RangeStats(rng.Start.UnixMilli(), rng.End.UnixMilli())

	// 先把时间点按区间粒度铺好，所有序列都按这个下标对齐。
	// 起点要先对齐到粒度边界（整点 / 自然日 0 点）：自定义区间的起止是任意时刻，
	// 不对齐的话铺出来的下标和按小时 / 自然日归并出来的桶 key 对不上，曲线会全是 0。
	base := rng.Start.Truncate(time.Hour)
	if rng.Step >= 24*time.Hour {
		base = time.UnixMilli(localDayStart(rng.Start.UnixMilli(), now.Location())).In(now.Location())
	}
	keys := []int64{}
	for t := base; !t.After(rng.End); {
		key := t.UnixMilli()
		if rng.Step < 24*time.Hour {
			key = t.Truncate(time.Hour).UnixMilli()
		}
		keys = append(keys, key)
		if rng.Step >= 24*time.Hour {
			t = t.AddDate(0, 0, 1)
		} else {
			t = t.Add(rng.Step)
		}
	}

	byKey := map[int64]store.Bucket{}
	byModel := map[string]map[int64]modelPoint{}
	for _, b := range buckets {
		key := b.Hour
		if rng.Step >= 24*time.Hour {
			key = localDayStart(b.Hour, now.Location())
		}
		acc := byKey[key]
		acc.Hour = key
		acc.Requests += b.Requests
		acc.Errors += b.Errors
		acc.PromptTokens += b.PromptTokens
		acc.CompletionTokens += b.CompletionTokens
		acc.TotalTokens += b.TotalTokens
		acc.LatencySum += b.LatencySum
		byKey[key] = acc

		for name, ms := range b.ModelStatsMerged() {
			mm := byModel[name]
			if mm == nil {
				mm = map[int64]modelPoint{}
				byModel[name] = mm
			}
			mp := mm[key]
			mp.Requests += ms.Requests
			mp.Errors += ms.Errors
			mp.PromptTokens += ms.PromptTokens
			mp.CompletionTokens += ms.CompletionTokens
			mp.TotalTokens += ms.TotalTokens
			mp.LatencySum += ms.LatencySum
			mm[key] = mp
		}
	}

	type point struct {
		Time         int64   `json:"time"`
		Requests     int64   `json:"requests"`
		Errors       int64   `json:"errors"`
		TotalTokens  int64   `json:"total_tokens"`
		PromptTokens int64   `json:"prompt_tokens"`
		CompTokens   int64   `json:"completion_tokens"`
		AvgLatency   float64 `json:"avg_latency"`
	}
	points := []point{}
	for _, key := range keys {
		b := byKey[key]
		p := point{Time: key, Requests: b.Requests, Errors: b.Errors,
			TotalTokens: b.TotalTokens, PromptTokens: b.PromptTokens, CompTokens: b.CompletionTokens}
		if b.Requests > 0 {
			p.AvgLatency = float64(b.LatencySum) / float64(b.Requests)
		}
		points = append(points, p)
	}

	out := map[string]any{"step_ms": int64(rng.Step / time.Millisecond), "points": points}

	// 单模型视图：只画这个模型的分项。
	if model != "" {
		mm := byModel[model]
		mpts := []point{}
		for _, key := range keys {
			mp := mm[key]
			p := point{Time: key, Requests: mp.Requests, Errors: mp.Errors,
				TotalTokens: mp.TotalTokens, PromptTokens: mp.PromptTokens, CompTokens: mp.CompletionTokens}
			if mp.Requests > 0 {
				p.AvgLatency = float64(mp.LatencySum) / float64(mp.Requests)
			}
			mpts = append(mpts, p)
		}
		out["points"] = mpts
		writeOK(w, out)
		return
	}

	// 总览视图：附带每个模型的分项序列，前端按模型画曲线。
	// 只保留调用量前 dashModelSeriesLimit 个模型，避免模型很多时响应过大。
	totals := map[string]int64{}
	for name, mm := range byModel {
		var total int64
		for _, mp := range mm {
			total += mp.Requests
		}
		if total > 0 {
			totals[name] = total
		}
	}
	// 分模型序列同时带上「按 Token 消耗排」的模型：调用不多但特别耗 Token 的模型
	// 在调用量前 dashModelSeriesLimit 个里排不进来，前端切到 Token 口径时
	// 得能画它的曲线，不然图例里有这个模型、图上却没有线。
	tokenTotals := map[string]int64{}
	for name, mm := range byModel {
		var total int64
		for _, mp := range mm {
			total += mp.TotalTokens
		}
		if total > 0 {
			tokenTotals[name] = total
		}
	}
	picked := map[string]bool{}
	for _, kv := range topN(totals, dashModelSeriesLimit) {
		picked[kv.Name] = true
	}
	for _, kv := range topN(tokenTotals, dashModelSeriesLimit) {
		picked[kv.Name] = true
	}
	series := map[string]modelSeries{}
	for name := range picked {
		mm := byModel[name]
		ms := modelSeries{
			Requests:         make([]int64, 0, len(keys)),
			Errors:           make([]int64, 0, len(keys)),
			PromptTokens:     make([]int64, 0, len(keys)),
			CompletionTokens: make([]int64, 0, len(keys)),
			TotalTokens:      make([]int64, 0, len(keys)),
		}
		for _, key := range keys {
			mp := mm[key]
			ms.Requests = append(ms.Requests, mp.Requests)
			ms.Errors = append(ms.Errors, mp.Errors)
			ms.PromptTokens = append(ms.PromptTokens, mp.PromptTokens)
			ms.CompletionTokens = append(ms.CompletionTokens, mp.CompletionTokens)
			ms.TotalTokens = append(ms.TotalTokens, mp.TotalTokens)
		}
		series[name] = ms
	}
	out["model_series"] = series
	writeOK(w, out)
}

// dashModelSeriesLimit 是总览里附带分模型序列的模型数量上限。
const dashModelSeriesLimit = 12

// modelPoint 是单个模型在一个时间点上的分项统计。
type modelPoint struct {
	Requests         int64
	Errors           int64
	PromptTokens     int64
	CompletionTokens int64
	TotalTokens      int64
	LatencySum       int64
}

// modelSeries 是单个模型在各时间点上的分项序列，下标与 points 一一对应。
type modelSeries struct {
	Requests         []int64 `json:"requests"`
	Errors           []int64 `json:"errors"`
	PromptTokens     []int64 `json:"prompt_tokens"`
	CompletionTokens []int64 `json:"completion_tokens"`
	TotalTokens      []int64 `json:"total_tokens"`
}

// statsBreakdown 返回按模型 / 渠道 / 令牌的调用分布。
func (s *Server) statsBreakdown(w http.ResponseWriter, r *http.Request) {
	now := time.Now().In(dashboardLocation)
	rng := s.statRangeFromQuery(r.URL.Query(), now)
	buckets, _ := s.store.RangeStats(rng.Start.UnixMilli(), rng.End.UnixMilli())

	models := map[string]int64{}
	modelErrs := map[string]int64{}
	modelToks := map[string]int64{}
	channels := map[string]int64{}
	tokenUsage := map[string]int64{}
	var totalReq, totalErr, totalTok int64
	for _, b := range buckets {
		totalReq += b.Requests
		totalErr += b.Errors
		totalTok += b.TotalTokens
		for k, v := range b.ModelStatsMerged() {
			models[k] += v.Requests
			modelErrs[k] += v.Errors
			modelToks[k] += v.TotalTokens
		}
		for k, v := range b.ChannelCounts {
			channels[k] += v
		}
		for k, v := range b.TokenCounts {
			tokenUsage[k] += v
		}
	}

	// 模型维度额外带上失败数和 Token 消耗，看板图例要按模型显示成功 / 失败，
	// 切到 Token 维度时图例数字也要跟着换成 Token 数。
	modelList := []modelBreakdown{}
	for _, kv := range topN(models, 12) {
		modelList = append(modelList, modelBreakdown{
			Name:   kv.Name,
			Value:  kv.Value,
			Errors: modelErrs[kv.Name],
			Tokens: modelToks[kv.Name],
		})
	}
	// 另给一份按 Token 消耗排的模型列表：调用次数不多、单次却特别长的模型
	// 在「调用次数前 12」里排不进来，看板环形图切到 Token 口径时得能看见它们。
	tokenList := []modelBreakdown{}
	for _, kv := range topN(modelToks, 12) {
		tokenList = append(tokenList, modelBreakdown{
			Name:   kv.Name,
			Value:  models[kv.Name],
			Errors: modelErrs[kv.Name],
			Tokens: kv.Value,
		})
	}

	writeOK(w, map[string]any{
		"models":           modelList,
		"models_by_tokens": tokenList,
		"channels":         topN(channels, 12),
		"tokens":           topN(tokenUsage, 12),
		"total":            totalReq,
		"errors":           totalErr,
		"tokens_used":      totalTok,
	})
}

// modelBreakdown 是单个模型在区间内的调用量、失败量与 Token 消耗。
type modelBreakdown struct {
	Name   string `json:"name"`
	Value  int64  `json:"value"`
	Errors int64  `json:"errors"`
	Tokens int64  `json:"tokens"`
}

type kv struct {
	Name  string `json:"name"`
	Value int64  `json:"value"`
}

func topN(m map[string]int64, n int) []kv {
	out := make([]kv, 0, len(m))
	for k, v := range m {
		out = append(out, kv{Name: k, Value: v})
	}
	for i := 0; i < len(out); i++ {
		for j := i + 1; j < len(out); j++ {
			if out[j].Value > out[i].Value {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	if len(out) > n {
		out = out[:n]
	}
	return out
}

func atoiDefault(s string, def int) int {
	s = strings.TrimSpace(s)
	if s == "" {
		return def
	}
	n := 0
	neg := false
	for i, c := range s {
		if i == 0 && c == '-' {
			neg = true
			continue
		}
		if c < '0' || c > '9' {
			return def
		}
		n = n*10 + int(c-'0')
	}
	if neg {
		n = -n
	}
	return n
}
