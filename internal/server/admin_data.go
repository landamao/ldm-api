package server

import (
	"errors"
	"net/http"
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
	var req struct {
		ID            string   `json:"id"`
		Name          string   `json:"name"`
		Enabled       *bool    `json:"enabled"`
		ExpiresAt     int64    `json:"expires_at"`
		QuotaLimit    int64    `json:"quota_limit"`
		AllowedModels []string `json:"allowed_models"`
		Remark        string   `json:"remark"`
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

	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = "默认密钥"
	}
	t.Name = name
	if isNew {
		t.ID = randomHex(8)
		t.Key = newAPIKey()
		t.CreatedAt = time.Now().UnixMilli()
		t.Enabled = true
	}
	if req.Enabled != nil {
		t.Enabled = *req.Enabled
	}
	t.ExpiresAt = req.ExpiresAt
	t.QuotaLimit = req.QuotaLimit
	t.AllowedModels = req.AllowedModels
	if t.AllowedModels == nil {
		t.AllowedModels = []string{}
	}
	t.Remark = strings.TrimSpace(req.Remark)
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
		return statRange{Key: "week", Start: start, PrevStart: prevStart, PrevEnd: prevStart.Add(now.Sub(start)), Step: 24 * time.Hour}
	case "month":
		start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
		prevStart := time.Date(now.Year(), now.Month()-1, 1, 0, 0, 0, 0, now.Location())
		prevEnd := prevStart.Add(now.Sub(start))
		// 上月天数比本月少时，同期区间最多到本月 1 号。
		if prevEnd.After(start) {
			prevEnd = start
		}
		return statRange{Key: "month", Start: start, PrevStart: prevStart, PrevEnd: prevEnd, Step: 24 * time.Hour}
	default:
		start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
		prevStart := start.AddDate(0, 0, -1)
		return statRange{Key: "today", Start: start, PrevStart: prevStart, PrevEnd: prevStart.Add(now.Sub(start)), Step: time.Hour}
	}
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
	rng := parseStatRange(r.URL.Query().Get("range"), now)
	current, _ := s.store.RangeStats(rng.Start.UnixMilli(), now.UnixMilli())
	previous, _ := s.store.RangeStats(rng.PrevStart.UnixMilli(), rng.PrevEnd.UnixMilli()-1)

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
		"current":     sumBuckets(current),
		"previous":    sumBuckets(previous),
		"channels":    map[string]int{"total": len(chans), "enabled": enabledChans},
		"models":      map[string]int{"total": len(models), "enabled": enabledModels},
		"tokens":      map[string]int{"total": len(tokens)},
		"server_time": now.UnixMilli(),
		"uptime":      int64(time.Since(s.StartedAt).Seconds()),
	})
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

// statsSeries 返回按小时（今天）或按自然日（本周 / 本月）聚合的时间序列。
func (s *Server) statsSeries(w http.ResponseWriter, r *http.Request) {
	now := time.Now().In(dashboardLocation)
	rng := parseStatRange(r.URL.Query().Get("range"), now)
	buckets, _ := s.store.RangeStats(rng.Start.UnixMilli(), now.UnixMilli())

	byKey := map[int64]store.Bucket{}
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
	for t := rng.Start; !t.After(now); {
		key := t.UnixMilli()
		if rng.Step < 24*time.Hour {
			key = t.Truncate(time.Hour).UnixMilli()
		}
		b := byKey[key]
		p := point{Time: key, Requests: b.Requests, Errors: b.Errors,
			TotalTokens: b.TotalTokens, PromptTokens: b.PromptTokens, CompTokens: b.CompletionTokens}
		if b.Requests > 0 {
			p.AvgLatency = float64(b.LatencySum) / float64(b.Requests)
		}
		points = append(points, p)
		if rng.Step >= 24*time.Hour {
			t = t.AddDate(0, 0, 1)
		} else {
			t = t.Add(rng.Step)
		}
	}
	writeOK(w, map[string]any{"step_ms": int64(rng.Step / time.Millisecond), "points": points})
}

// statsBreakdown 返回按模型 / 渠道 / 令牌的调用分布。
func (s *Server) statsBreakdown(w http.ResponseWriter, r *http.Request) {
	now := time.Now().In(dashboardLocation)
	rng := parseStatRange(r.URL.Query().Get("range"), now)
	buckets, _ := s.store.RangeStats(rng.Start.UnixMilli(), now.UnixMilli())

	models := map[string]int64{}
	channels := map[string]int64{}
	tokenUsage := map[string]int64{}
	var totalReq, totalErr, totalTok int64
	for _, b := range buckets {
		totalReq += b.Requests
		totalErr += b.Errors
		totalTok += b.TotalTokens
		for k, v := range b.ModelCounts {
			models[k] += v
		}
		for k, v := range b.ChannelCounts {
			channels[k] += v
		}
		for k, v := range b.TokenCounts {
			tokenUsage[k] += v
		}
	}

	writeOK(w, map[string]any{
		"models":      topN(models, 12),
		"channels":    topN(channels, 12),
		"tokens":      topN(tokenUsage, 12),
		"total":       totalReq,
		"errors":      totalErr,
		"tokens_used": totalTok,
	})
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
