package server

import (
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"ldmapi/internal/store"
)

// ---------- 用量分析 ----------
//
// 用量页不复用小时统计桶：桶里只有「模型 → 数字」和「渠道 → 次数」，
// 令牌维度与「渠道模型」维度都没有交叉，凑不出渠道 / 模型 / 令牌三者的
// 任意组合。日志本身记了每次尝试的渠道与上游模型，按区间流式扫一遍就能
// 还原全部维度，口径也只有一份（Log.Failed），不用维护两套统计。
//
// 代价是扫描成本随区间线性增长。区间由页面预设（今日 / 近 7 天 / 近 30 天 /
// 全部）限定，扫描条数超过上限时截断并在响应里标出来。

// usageScanLimit 是一次查询最多扫描的日志条数。个人网关一天通常几百到几千条，
// 30 天也就十万级；这个上限只在「全部时间」且日志没清理时兜底。
const usageScanLimit = 300000

// usageQuery 是用量页的筛选条件。
type usageQuery struct {
	Tab     string // channel | model
	Channel string // 渠道 ID：渠道视图必填，模型视图可选（空 = 全部渠道）
	Model   string // 上游模型名（小写）：模型视图必填，渠道视图可选（空 = 全部模型）
	Token   string // 令牌 ID，空 = 全部令牌
	Start   int64  // 毫秒时间戳
	End     int64
}

// usageSummary 是一段时间内的总览。
// Requests 是命中的请求数（按最终结果计），Attempts 是其中涉及的尝试次数：
// 发生过重试时 Attempts 会大于 Requests。
type usageSummary struct {
	Requests         int64   `json:"requests"`
	Errors           int64   `json:"errors"`
	SuccessRate      float64 `json:"success_rate"` // 0-100，没有请求时为 -1
	Attempts         int64   `json:"attempts"`
	FailedTries      int64   `json:"failed_tries"`
	TrySuccessRate   float64 `json:"try_success_rate"` // 尝试级成功率：落地次数 / 尝试次数
	PromptTokens     int64   `json:"prompt_tokens"`
	CompletionTokens int64   `json:"completion_tokens"`
	TotalTokens      int64   `json:"total_tokens"`
	AvgLatencyMs     int64   `json:"avg_latency_ms"` // 只算成功请求
	AvgSpeed         float64 `json:"avg_speed"`      // 输出速度（t/s），只算流式
}

// usageRow 是明细里的一行：渠道视图按上游模型分组，模型视图按渠道分组。
type usageRow struct {
	Key              string  `json:"key"`  // 模型名（小写）或渠道 ID
	Name             string  `json:"name"` // 渠道名（模型行留空，前端直接显示模型名）
	Requests         int64   `json:"requests"`
	Errors           int64   `json:"errors"`
	Attempts         int64   `json:"attempts"`
	FailedTries      int64   `json:"failed_tries"`
	PromptTokens     int64   `json:"prompt_tokens"`
	CompletionTokens int64   `json:"completion_tokens"`
	TotalTokens      int64   `json:"total_tokens"`
	AvgLatencyMs     int64   `json:"avg_latency_ms"`
	SuccessRate      float64 `json:"success_rate"`
}

// usagePoint 是趋势图上的一个点。
type usagePoint struct {
	Time     int64 `json:"time"`
	Requests int64 `json:"requests"`
	Errors   int64 `json:"errors"`
	Tokens   int64 `json:"tokens"`
}

// usageTokenRow 是按令牌拆的用量，用来回答「这轮消耗是谁打的」。
type usageTokenRow struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Requests int64  `json:"requests"`
	Tokens   int64  `json:"tokens"`
}

// usageCaller 是按「请求模型」拆的用量：同一个上游模型可能同时被渠道模型
// 直接调用、被一个或多个自定义模型当成路由目标，这里把两者分开。
// Type 来自模型管理（channel / custom），模型已删除时为空。
type usageCaller struct {
	ModelID     string  `json:"model_id"`
	Type        string  `json:"type"`
	Requests    int64   `json:"requests"`
	Errors      int64   `json:"errors"`
	Tokens      int64   `json:"tokens"`
	SuccessRate float64 `json:"success_rate"`
}

// usageTry 是还原出来的一次路由尝试。
type usageTry struct {
	ChannelID   string
	ChannelName string
	Upstream    string
	OK          bool
}

// usageTries 还原一条日志的路由尝试链。
// 日志里的 Attempts 只在发生重试时记录，单次成功的请求没有这个数组，
// 这时用最终落地的渠道 / 上游模型补一条。
// 重试链里最后一条是否成功，看整条日志的最终结果：前面每条都是失败才会重试，
// 所以只有最后一条可能成功（客户端取消、错误覆写为正文时 Failed 为 false）。
func usageTries(l store.Log) []usageTry {
	if len(l.Attempts) > 0 {
		out := make([]usageTry, 0, len(l.Attempts))
		for i, a := range l.Attempts {
			ok := i == len(l.Attempts)-1 && !l.Failed()
			out = append(out, usageTry{
				ChannelID:   a.ChannelID,
				ChannelName: a.ChannelName,
				Upstream:    a.UpstreamModel,
				OK:          ok,
			})
		}
		return out
	}
	if l.ChannelID == "" {
		return nil
	}
	return []usageTry{{
		ChannelID:   l.ChannelID,
		ChannelName: l.ChannelName,
		Upstream:    l.UpstreamModel,
		OK:          !l.Failed(),
	}}
}

// usageModelKey 是「上游模型名」的归一化写法。
// 同一家上游在不同渠道里会写成 gpt-4o / GPT-4o / Gpt-4O，统一按小写聚合，
// 页面上也只显示小写名，不拼「渠道/模型」这种带前缀的 ID。
func usageModelKey(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

// usageStep 决定趋势图的聚合粒度：两天以内按小时，更长按自然日。
func usageStep(span time.Duration) time.Duration {
	if span <= 48*time.Hour {
		return time.Hour
	}
	return 24 * time.Hour
}

// usageAlign 把毫秒时间戳对齐到聚合粒度的起点。小时桶直接按 UTC 取整
// （时区都是整小时偏移），天桶按北京时间 0 点对齐。
func usageAlign(ms int64, step time.Duration, loc *time.Location) int64 {
	if step >= 24*time.Hour {
		return localDayStart(ms, loc)
	}
	size := step.Milliseconds()
	return ms / size * size
}

// parseUsageQuery 解析筛选条件。tab 缺省按渠道视图；
// 区间支持 today / 7d / 30d / all，也接受日志页那套 start / end 毫秒时间戳。
func (s *Server) parseUsageQuery(r *http.Request) usageQuery {
	now := time.Now().In(dashboardLocation)
	q := r.URL.Query()
	out := usageQuery{
		Tab:     strings.ToLower(strings.TrimSpace(q.Get("tab"))),
		Channel: strings.TrimSpace(q.Get("channel")),
		Model:   usageModelKey(q.Get("model")),
		Token:   strings.TrimSpace(q.Get("token")),
	}
	if out.Tab != "model" {
		out.Tab = "channel"
	}
	out.Start, out.End = s.usageBounds(q, now)
	return out
}

// usageBounds 换算查询区间。预设区间按北京时间自然日切分，
// 「全部时间」从最早一条日志所在自然日起算。
func (s *Server) usageBounds(q url.Values, now time.Time) (int64, int64) {
	now = now.In(dashboardLocation)
	loc := now.Location()
	dayStart := func(t time.Time) int64 {
		return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, loc).UnixMilli()
	}
	end := now.UnixMilli()
	var start int64
	switch strings.ToLower(strings.TrimSpace(q.Get("range"))) {
	case "7d":
		start = dayStart(now.AddDate(0, 0, -6))
	case "30d":
		start = dayStart(now.AddDate(0, 0, -29))
	case "all":
		start = s.earliestLogStart(now)
	default: // today
		start = dayStart(now)
	}
	// 日志页的自定义起止可以直接复用：带了就用，不再看预设。
	if v := int64(atoiDefault(q.Get("start"), 0)); v > 0 {
		start = v
	}
	if v := int64(atoiDefault(q.Get("end"), 0)); v > 0 && v < end {
		end = v
	}
	if start > end {
		start = end
	}
	return start, end
}

// earliestLogStart 返回最早一条日志所在自然日的 0 点，没有日志时返回今天 0 点。
func (s *Server) earliestLogStart(now time.Time) int64 {
	loc := now.Location()
	if ms, ok, err := s.store.EarliestLog(); err == nil && ok {
		if t := time.UnixMilli(ms).In(loc); t.Before(now) {
			return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, loc).UnixMilli()
		}
	}
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc).UnixMilli()
}

// usageReport 返回用量分析数据：总览 + 趋势 + 明细行 + 令牌分布。
func (s *Server) usageReport(w http.ResponseWriter, r *http.Request) {
	q := s.parseUsageQuery(r)
	if q.Tab == "channel" && q.Channel == "" {
		writeErr(w, http.StatusBadRequest, "请先选择一个渠道")
		return
	}
	if q.Tab == "model" && q.Model == "" {
		writeErr(w, http.StatusBadRequest, "请先选择一个模型")
		return
	}

	channels, _ := s.store.ListChannels()
	channelName := make(map[string]string, len(channels))
	for _, c := range channels {
		channelName[c.ID] = c.Name
	}
	// 请求模型的类型（渠道模型 / 自定义模型）从模型管理里查，
	// 已删除的模型查不到，前端会标成「已删除」。
	modelType := map[string]string{}
	if models, err := s.store.ListModels(); err == nil {
		for _, m := range models {
			modelType[m.ID] = m.Type
		}
	}

	var sum usageSummary
	var okRequests int64
	var speedSum float64
	var speedCount int64
	rows := map[string]*usageRow{}
	tokenUse := map[string]*usageTokenRow{}
	callers := map[string]*usageCaller{}
	points := map[int64]*usagePoint{}
	step := usageStep(time.Duration(q.End-q.Start) * time.Millisecond)
	loc := dashboardLocation
	scanned := 0
	truncated := false

	match := func(t usageTry) bool {
		// 渠道筛选对两个视图都生效：模型视图不选渠道时表示全部渠道。
		if q.Channel != "" && t.ChannelID != q.Channel {
			return false
		}
		up := usageModelKey(t.Upstream)
		if q.Tab == "model" {
			return up == q.Model
		}
		// 渠道视图的模型筛选是可选的（全部模型 / 渠道里的某一个）。
		return q.Model == "" || up == q.Model
	}

	err := s.store.ForEachLogRange(q.Start, q.End, func(l store.Log) bool {
		scanned++
		if scanned > usageScanLimit {
			truncated = true
			return false
		}
		// 调用方请求本身有问题的 400 不计统计，和看板、模型成功率同一口径。
		if l.StatusCode == http.StatusBadRequest {
			return true
		}
		if q.Token != "" && l.TokenID != q.Token {
			return true
		}
		tries := usageTries(l)
		if len(tries) == 0 {
			return true
		}
		hit := false
		for _, t := range tries {
			if match(t) {
				hit = true
				break
			}
		}
		if !hit {
			return true
		}

		failed := l.Failed()
		sum.Requests++
		if failed {
			sum.Errors++
		}

		// 最终落地的那一行（成功时只有一条）才计 token 和耗时：
		// 请求只是「尝试过」这个渠道、最后落到别处时，它并没有在这里产生消耗，
		// 否则总览的 Token 会和下面明细各行相加对不上。
		finalKey := ""
		for i := len(tries) - 1; i >= 0; i-- {
			if tries[i].OK && match(tries[i]) {
				finalKey = usageRowKey(q.Tab, tries[i])
				break
			}
		}

		// 按请求模型拆：渠道模型直接调用和自定义模型路由过来的量分开记。
		if l.ModelID != "" {
			c := callers[l.ModelID]
			if c == nil {
				c = &usageCaller{ModelID: l.ModelID, Type: modelType[l.ModelID]}
				callers[l.ModelID] = c
			}
			c.Requests++
			if failed {
				c.Errors++
			}
			if finalKey != "" {
				c.Tokens += int64(l.TotalTokens)
			}
		}
		if finalKey != "" {
			if !failed {
				okRequests++
				sum.AvgLatencyMs += l.LatencyMs
			}
			sum.PromptTokens += int64(l.PromptTokens)
			sum.CompletionTokens += int64(l.CompletionTokens)
			sum.TotalTokens += int64(l.TotalTokens)
			if l.TokensPerSec > 0 && l.FirstByteMs > 0 && l.LatencyMs > 0 {
				speedCount++
				speedSum += l.TokensPerSec
			}
		}

		for _, t := range tries {
			if !match(t) {
				continue
			}
			sum.Attempts++
			if !t.OK {
				sum.FailedTries++
			}
			key := usageRowKey(q.Tab, t)
			if key == "" {
				continue
			}
			row := rows[key]
			if row == nil {
				row = &usageRow{Key: key}
				if q.Tab == "model" {
					// 渠道被删掉时配置里查不到名字，退回日志里记的那份
					row.Name = channelName[key]
					if row.Name == "" {
						row.Name = t.ChannelName
					}
				}
				rows[key] = row
			}
			row.Attempts++
			if !t.OK {
				row.FailedTries++
			}
			if t.OK && key == finalKey {
				row.Requests++
			}
		}

		if finalKey != "" {
			if row := rows[finalKey]; row != nil {
				row.PromptTokens += int64(l.PromptTokens)
				row.CompletionTokens += int64(l.CompletionTokens)
				row.TotalTokens += int64(l.TotalTokens)
				if !failed {
					row.AvgLatencyMs += l.LatencyMs
				}
			}
		}

		bucket := usageAlign(l.Time, step, loc)
		p := points[bucket]
		if p == nil {
			p = &usagePoint{Time: bucket}
			points[bucket] = p
		}
		p.Requests++
		if failed {
			p.Errors++
		}
		p.Tokens += int64(l.TotalTokens)

		if l.TokenID != "" {
			t := tokenUse[l.TokenID]
			if t == nil {
				t = &usageTokenRow{ID: l.TokenID, Name: l.TokenName}
				tokenUse[l.TokenID] = t
			}
			t.Requests++
			t.Tokens += int64(l.TotalTokens)
		}
		return true
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	if sum.Requests > 0 {
		sum.SuccessRate = float64(sum.Requests-sum.Errors) * 100 / float64(sum.Requests)
	} else {
		sum.SuccessRate = -1
	}
	if sum.Attempts > 0 {
		sum.TrySuccessRate = float64(sum.Attempts-sum.FailedTries) * 100 / float64(sum.Attempts)
	} else {
		sum.TrySuccessRate = -1
	}
	if okRequests > 0 {
		sum.AvgLatencyMs /= okRequests
	}
	if speedCount > 0 {
		sum.AvgSpeed = speedSum / float64(speedCount)
	}

	rowList := make([]usageRow, 0, len(rows))
	for _, row := range rows {
		if row.Attempts > 0 {
			row.SuccessRate = float64(row.Requests) * 100 / float64(row.Attempts)
		} else {
			row.SuccessRate = -1
		}
		if row.Requests > 0 {
			row.AvgLatencyMs /= row.Requests
		}
		rowList = append(rowList, *row)
	}
	sort.Slice(rowList, func(i, j int) bool {
		if rowList[i].Requests != rowList[j].Requests {
			return rowList[i].Requests > rowList[j].Requests
		}
		if rowList[i].Attempts != rowList[j].Attempts {
			return rowList[i].Attempts > rowList[j].Attempts
		}
		return rowList[i].Key < rowList[j].Key
	})

	series := fillUsagePoints(points, q.Start, q.End, step, loc)

	tokenList := make([]usageTokenRow, 0, len(tokenUse))
	for _, t := range tokenUse {
		tokenList = append(tokenList, *t)
	}
	sort.Slice(tokenList, func(i, j int) bool {
		if tokenList[i].Requests != tokenList[j].Requests {
			return tokenList[i].Requests > tokenList[j].Requests
		}
		return tokenList[i].ID < tokenList[j].ID
	})
	if len(tokenList) > 20 {
		tokenList = tokenList[:20]
	}

	callerList := make([]usageCaller, 0, len(callers))
	for _, c := range callers {
		if c.Requests > 0 {
			c.SuccessRate = float64(c.Requests-c.Errors) * 100 / float64(c.Requests)
		} else {
			c.SuccessRate = -1
		}
		callerList = append(callerList, *c)
	}
	sort.Slice(callerList, func(i, j int) bool {
		if callerList[i].Requests != callerList[j].Requests {
			return callerList[i].Requests > callerList[j].Requests
		}
		return callerList[i].ModelID < callerList[j].ModelID
	})
	if len(callerList) > 30 {
		callerList = callerList[:30]
	}

	writeOK(w, map[string]any{
		"tab":     q.Tab,
		"channel": q.Channel,
		"model":   q.Model,
		"token":   q.Token,
		"range": map[string]any{
			"start":  q.Start,
			"end":    q.End,
			"step":   step.Milliseconds(),
			"preset": strings.ToLower(strings.TrimSpace(r.URL.Query().Get("range"))),
		},
		"summary":   sum,
		"series":    series,
		"rows":      rowList,
		"callers":   callerList,
		"tokens":    tokenList,
		"scanned":   scanned,
		"truncated": truncated,
	})
}

// usageRowKey 返回一条尝试落在哪一行：渠道视图按上游模型（小写），
// 模型视图按渠道 ID。
func usageRowKey(tab string, t usageTry) string {
	if tab == "model" {
		return t.ChannelID
	}
	return usageModelKey(t.Upstream)
}

// fillUsagePoints 把稀疏的桶补齐成连续序列，图表不用自己补空点。
func fillUsagePoints(points map[int64]*usagePoint, start, end int64, step time.Duration, loc *time.Location) []usagePoint {
	if step <= 0 {
		step = time.Hour
	}
	out := []usagePoint{}
	first := usageAlign(start, step, loc)
	last := usageAlign(end, step, loc)
	for t := first; t <= last; t += step.Milliseconds() {
		p := points[t]
		if p == nil {
			p = &usagePoint{Time: t}
		}
		out = append(out, *p)
	}
	return out
}

// usageFacetChannel 是渠道筛选里的一个选项，带上它配置的上游模型，
// 前端切渠道时不用再请求一次就能联动模型下拉。
type usageFacetChannel struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Enabled bool     `json:"enabled"`
	Models  []string `json:"models"`
}

type usageFacetToken struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
}

type usageFacetsView struct {
	Channels []usageFacetChannel `json:"channels"`
	Models   []string            `json:"models"`
	Tokens   []usageFacetToken   `json:"tokens"`
}

// usageFacets 返回用量页三个筛选下拉的选项。
// 模型一律取渠道里配置的上游模型名并转成小写去重，不生成「渠道/模型」这种 ID。
func (s *Server) usageFacets(w http.ResponseWriter, r *http.Request) {
	channels, err := s.store.ListChannels()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	out := usageFacetsView{Channels: []usageFacetChannel{}, Models: []string{}, Tokens: []usageFacetToken{}}
	// 顺序沿用渠道和渠道里模型名的配置顺序：第一个渠道的第一个模型通常就是
	// 主力，进页面默认选它有数据；按字母排会把 claude-* 顶到最前面。
	seenAll := map[string]bool{}
	for _, c := range channels {
		seen := map[string]bool{}
		models := []string{}
		for _, name := range c.Models {
			key := usageModelKey(name)
			if key == "" || seen[key] {
				continue
			}
			seen[key] = true
			models = append(models, key)
			if !seenAll[key] {
				seenAll[key] = true
				out.Models = append(out.Models, key)
			}
		}
		out.Channels = append(out.Channels, usageFacetChannel{
			ID: c.ID, Name: c.Name, Enabled: c.Enabled, Models: models,
		})
	}

	tokens, _ := s.store.ListTokens()
	for _, t := range tokens {
		out.Tokens = append(out.Tokens, usageFacetToken{ID: t.ID, Name: t.Name, Enabled: t.Enabled})
	}
	sort.Slice(out.Tokens, func(i, j int) bool {
		if out.Tokens[i].Name != out.Tokens[j].Name {
			return out.Tokens[i].Name < out.Tokens[j].Name
		}
		return out.Tokens[i].ID < out.Tokens[j].ID
	})
	writeOK(w, out)
}
