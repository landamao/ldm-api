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

func (s *Server) statsOverview(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	todayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).UnixMilli()
	yStart := todayStart - 24*3600*1000

	today, _ := s.store.RangeStats(todayStart, now.UnixMilli())
	yesterday, _ := s.store.RangeStats(yStart, todayStart-1)
	last7, _ := s.store.RangeStats(todayStart-6*24*3600*1000, now.UnixMilli())
	all, _ := s.store.RangeStats(0, now.UnixMilli())

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
		"today":       sumBuckets(today),
		"yesterday":   sumBuckets(yesterday),
		"last7days":   sumBuckets(last7),
		"all_time":    sumBuckets(all),
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
}

func sumBuckets(bs []store.Bucket) bucketSummary {
	var out bucketSummary
	var latencySum int64
	for _, b := range bs {
		out.Requests += b.Requests
		out.Errors += b.Errors
		out.PromptTokens += b.PromptTokens
		out.CompletionTokens += b.CompletionTokens
		out.TotalTokens += b.TotalTokens
		latencySum += b.LatencySum
	}
	if out.Requests > 0 {
		out.AvgLatency = float64(latencySum) / float64(out.Requests)
		out.SuccessRate = float64(out.Requests-out.Errors) * 100 / float64(out.Requests)
	} else {
		out.SuccessRate = 100
	}
	return out
}

// statsSeries 返回按小时（或按天）聚合的时间序列。
func (s *Server) statsSeries(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	hours := atoiDefault(r.URL.Query().Get("hours"), 24)
	if hours <= 0 || hours > 24*90 {
		hours = 24
	}
	from := now.Add(-time.Duration(hours) * time.Hour)
	// 起点对齐到整点，保证序列完整
	from = from.Truncate(time.Hour)
	buckets, _ := s.store.RangeStats(from.UnixMilli(), now.UnixMilli())
	byHour := map[int64]store.Bucket{}
	for _, b := range buckets {
		byHour[b.Hour] = b
	}
	step := int64(3600 * 1000)
	if hours > 24*3 {
		// 长区间按天聚合，避免点数过多
		step = 24 * 3600 * 1000
		byHour = map[int64]store.Bucket{}
		for _, b := range buckets {
			day := b.Hour / step * step
			acc := byHour[day]
			acc.Hour = day
			acc.Requests += b.Requests
			acc.Errors += b.Errors
			acc.PromptTokens += b.PromptTokens
			acc.CompletionTokens += b.CompletionTokens
			acc.TotalTokens += b.TotalTokens
			acc.LatencySum += b.LatencySum
			if acc.ModelCounts == nil {
				acc.ModelCounts = map[string]int64{}
			}
			for k, v := range b.ModelCounts {
				acc.ModelCounts[k] += v
			}
			if acc.ModelErrors == nil {
				acc.ModelErrors = map[string]int64{}
			}
			for k, v := range b.ModelErrors {
				acc.ModelErrors[k] += v
			}
			if acc.ChannelCounts == nil {
				acc.ChannelCounts = map[string]int64{}
			}
			for k, v := range b.ChannelCounts {
				acc.ChannelCounts[k] += v
			}
			byHour[day] = acc
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
	start := from.UnixMilli() / step * step
	points := []point{}
	for t := start; t <= now.UnixMilli(); t += step {
		b := byHour[t]
		p := point{Time: t, Requests: b.Requests, Errors: b.Errors,
			TotalTokens: b.TotalTokens, PromptTokens: b.PromptTokens, CompTokens: b.CompletionTokens}
		if b.Requests > 0 {
			p.AvgLatency = float64(b.LatencySum) / float64(b.Requests)
		}
		points = append(points, p)
	}
	writeOK(w, map[string]any{"step_ms": step, "points": points})
}

// statsBreakdown 返回按模型 / 渠道 / 令牌的调用分布。
func (s *Server) statsBreakdown(w http.ResponseWriter, r *http.Request) {
	hours := atoiDefault(r.URL.Query().Get("hours"), 24)
	if hours <= 0 || hours > 24*90 {
		hours = 24
	}
	from := time.Now().Add(-time.Duration(hours) * time.Hour).UnixMilli()
	buckets, _ := s.store.RangeStats(from, time.Now().UnixMilli())

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
