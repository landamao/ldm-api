package relay

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ldmapi/internal/store"
)

func newTestStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("打开测试库失败: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func seedChannels(t *testing.T, st *store.Store) {
	t.Helper()
	now := time.Now().UnixMilli()
	for _, c := range []store.Channel{
		{ID: "A", Name: "主线路", Type: store.ChannelOpenAI, BaseURL: "http://a", Models: []string{"a", "b", "c"}, Enabled: true, CreatedAt: now, UpdatedAt: now},
		{ID: "B", Name: "备用线路", Type: store.ChannelOpenAI, BaseURL: "http://b", Models: []string{"a", "b", "d"}, Enabled: true, CreatedAt: now, UpdatedAt: now},
	} {
		if err := st.SaveChannel(c); err != nil {
			t.Fatal(err)
		}
	}
}

func TestChannelModelIDGeneration(t *testing.T) {
	st := newTestStore(t)
	seedChannels(t, st)

	ids, err := st.ChannelModelIDs()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"A/a", "A/b", "A/c", "B/a", "B/b", "B/d"}
	if len(ids) != len(want) {
		t.Fatalf("渠道模型数量错误: 得到 %d 个 %v", len(ids), ids)
	}
	for _, w := range want {
		cm, ok := ids[w]
		if !ok {
			t.Errorf("缺少渠道模型 %s", w)
			continue
		}
		chID, up, _ := splitRef(w)
		if cm.ChannelID != chID || cm.Upstream != up {
			t.Errorf("%s 解析错误: %+v", w, cm)
		}
	}
}

func splitRef(id string) (string, string, bool) {
	for i := 0; i < len(id); i++ {
		if id[i] == '/' {
			return id[:i], id[i+1:], true
		}
	}
	return id, "", false
}

func TestResolveChannelModel(t *testing.T) {
	st := newTestStore(t)
	seedChannels(t, st)
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "A/a", Type: store.ModelTypeChannel, ChannelID: "A", Upstream: "a",
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	r := New(st)
	res, err := r.Resolve("A/a")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Routes) != 1 {
		t.Fatalf("渠道模型应只有一条路由，得到 %d", len(res.Routes))
	}
	if res.Routes[0].Channel.ID != "A" || res.Routes[0].Upstream != "a" {
		t.Errorf("路由解析错误: %+v", res.Routes[0])
	}
}

func TestResolveUnaddedModelFails(t *testing.T) {
	st := newTestStore(t)
	seedChannels(t, st)
	r := New(st)
	// 渠道里配了 A/b，但没有加入模型设置，就不应该能被调用
	if _, err := r.Resolve("A/b"); err != ErrModelNotFound {
		t.Errorf("未添加的模型应返回 ErrModelNotFound，得到 %v", err)
	}
}

func TestResolveCustomModelPriorityOrder(t *testing.T) {
	st := newTestStore(t)
	seedChannels(t, st)
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "LDM", Type: store.ModelTypeCustom,
		Routes: []store.Route{
			{ChannelID: "A", Upstream: "c"},
			{ChannelID: "B", Upstream: "d"},
		},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	r := New(st)
	res, err := r.Resolve("LDM")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Routes) != 2 {
		t.Fatalf("路由数量错误: %d", len(res.Routes))
	}
	if res.Routes[0].Channel.ID != "A" || res.Routes[1].Channel.ID != "B" {
		t.Errorf("未分组时应保持配置顺序，得到 %s → %s", res.Routes[0].Channel.ID, res.Routes[1].Channel.ID)
	}
}

func TestResolveSkipsDisabledChannels(t *testing.T) {
	st := newTestStore(t)
	seedChannels(t, st)
	// 禁用渠道 A
	ch, _ := st.GetChannel("A")
	ch.Enabled = false
	if err := st.SaveChannel(ch); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "LDM", Type: store.ModelTypeCustom,
		Routes:  []store.Route{{ChannelID: "A", Upstream: "c"}, {ChannelID: "B", Upstream: "d"}},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	r := New(st)
	res, err := r.Resolve("LDM")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Routes) != 1 {
		t.Fatalf("应跳过被禁用的渠道，剩余 %d 条路由", len(res.Routes))
	}
	if res.Routes[0].Channel.ID != "B" {
		t.Errorf("应路由到 B，得到 %s", res.Routes[0].Channel.ID)
	}
}

func TestResolveNoAvailableRoutes(t *testing.T) {
	st := newTestStore(t)
	seedChannels(t, st)
	for _, id := range []string{"A", "B"} {
		ch, _ := st.GetChannel(id)
		ch.Enabled = false
		_ = st.SaveChannel(ch)
	}
	now := time.Now().UnixMilli()
	_ = st.SaveModel(store.Model{
		ID: "LDM", Type: store.ModelTypeCustom,
		Routes:  []store.Route{{ChannelID: "A", Upstream: "c"}},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	})
	r := New(st)
	res, err := r.Resolve("LDM")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Routes) != 0 {
		t.Fatalf("不应有可用路由")
	}
	if res.NoRoute == "" {
		t.Error("应给出不可用原因")
	}
}

func TestWeightedGroupPicksInside(t *testing.T) {
	st := newTestStore(t)
	seedChannels(t, st)
	now := time.Now().UnixMilli()
	// 组1：A/a + B/a；组2（前面隔一条未分组）：B/d
	_ = st.SaveModel(store.Model{
		ID: "G", Type: store.ModelTypeCustom,
		Routes: []store.Route{
			{ChannelID: "A", Upstream: "a", Group: 1},
			{ChannelID: "B", Upstream: "a", Group: 1},
			{ChannelID: "B", Upstream: "d", Group: 2},
		},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	})
	r := New(st)
	hits := map[string]int{}
	for i := 0; i < 200; i++ {
		res, err := r.Resolve("G")
		if err != nil {
			t.Fatal(err)
		}
		if len(res.Routes) != 3 {
			t.Fatalf("路由数量错误: %d", len(res.Routes))
		}
		// 第 1、2 条必须同组且是 A/a、B/a；第 3 条固定是 B/d
		if res.Routes[2].Channel.ID != "B" || res.Routes[2].Upstream != "d" {
			t.Fatalf("组间应按顺序，第 3 条应是 B/d")
		}
		pair := res.Routes[0].Channel.ID + res.Routes[0].Upstream
		hits[pair]++
		if pair != "Aa" && pair != "Ba" {
			t.Fatalf("组内首选应只在组1里产生")
		}
	}
	if hits["Aa"] == 0 || hits["Ba"] == 0 {
		t.Errorf("等权重下组内两个条目都应能被抽中，实际 %v", hits)
	}
}

func TestGroupOrderKeepsConfigSequence(t *testing.T) {
	st := newTestStore(t)
	seedChannels(t, st)
	now := time.Now().UnixMilli()
	_ = st.SaveModel(store.Model{
		ID: "G2", Type: store.ModelTypeCustom,
		Routes: []store.Route{
			{ChannelID: "A", Upstream: "a", Group: 1},
			{ChannelID: "B", Upstream: "d", Group: 2},
			{ChannelID: "B", Upstream: "a", Group: 2},
		},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	})
	r := New(st)
	for i := 0; i < 30; i++ {
		res, err := r.Resolve("G2")
		if err != nil {
			t.Fatal(err)
		}
		ids := []string{res.Routes[0].Channel.ID + "/" + res.Routes[0].Upstream}
		// 组1 必须在最前；组2 两条以任意顺序跟在后面
		if ids[0] != "A/a" {
			t.Fatalf("组1 应排在最前，得到 %v", ids)
		}
		rest := map[string]bool{}
		for _, rt := range res.Routes[1:] {
			rest[rt.Channel.ID+"/"+rt.Upstream] = true
		}
		if !rest["B/d"] || !rest["B/a"] {
			t.Fatalf("组2 应完整保留两条路由: %v", rest)
		}
	}
}

func TestAffinityMovesLastSuccessToFront(t *testing.T) {
	st := newTestStore(t)
	seedChannels(t, st)
	now := time.Now().UnixMilli()
	_ = st.SaveModel(store.Model{
		ID: "AF", Type: store.ModelTypeCustom,
		Routes: []store.Route{
			{ChannelID: "A", Upstream: "a"},
			{ChannelID: "B", Upstream: "d"},
		},
		Affinity: true, Enabled: true, CreatedAt: now, UpdatedAt: now,
	})
	r := New(st)
	// 模拟上次成功走 B/d
	MarkSuccess("AF", "B", "d")
	for i := 0; i < 5; i++ {
		res, err := r.Resolve("AF")
		if err != nil {
			t.Fatal(err)
		}
		if res.Routes[0].Channel.ID != "B" {
			t.Fatalf("开启亲和后应从上次成功的 B/d 开始，得到 %s", res.Routes[0].Channel.ID)
		}
	}
	// 未开启亲和的模型不受影响
	_ = st.SaveModel(store.Model{
		ID: "NO", Type: store.ModelTypeCustom,
		Routes: []store.Route{
			{ChannelID: "A", Upstream: "a"},
			{ChannelID: "B", Upstream: "d"},
		},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	})
	res, _ := r.Resolve("NO")
	if res.Routes[0].Channel.ID != "A" {
		t.Errorf("未开启亲和应保持配置顺序，得到 %s", res.Routes[0].Channel.ID)
	}
}

func TestCooldownSkipsFailedRoute(t *testing.T) {
	st := newTestStore(t)
	seedChannels(t, st)
	now := time.Now().UnixMilli()
	_ = st.SaveModel(store.Model{
		ID: "CD", Type: store.ModelTypeCustom,
		Routes: []store.Route{
			{ChannelID: "A", Upstream: "a"},
			{ChannelID: "B", Upstream: "d"},
		},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	})
	MarkFailure("A", "a", time.Minute)
	r := New(st)
	res, err := r.Resolve("CD")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Routes) != 1 || res.Routes[0].Channel.ID != "B" {
		t.Fatalf("冷却中的 A/a 应被跳过，得到 %+v", res.Routes)
	}
}

func TestClearAllCooldowns(t *testing.T) {
	MarkFailure("CLR-A", "a", time.Minute)
	MarkFailure("CLR-B", "b", time.Minute)
	if n := ClearAllCooldowns(); n < 2 {
		t.Fatalf("应至少清除 2 条冷却，得到 %d", n)
	}
	if n := ClearAllCooldowns(); n != 0 {
		t.Fatalf("冷却应已清空，仍剩 %d 条", n)
	}
}

func TestCooldownResetWhenAllCooling(t *testing.T) {
	st := newTestStore(t)
	seedChannels(t, st)
	now := time.Now().UnixMilli()
	m := store.Model{
		ID: "CR", Type: store.ModelTypeCustom,
		Routes: []store.Route{
			{ChannelID: "A", Upstream: "a"},
			{ChannelID: "B", Upstream: "d"},
		},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}
	_ = st.SaveModel(m)
	MarkFailure("A", "a", time.Minute)
	MarkFailure("B", "d", time.Minute)

	// 未开重置：直接不可用
	r := New(st)
	res, err := r.Resolve("CR")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Routes) != 0 || res.NoRoute == "" {
		t.Fatalf("全部冷却且未开重置应不可用，得到 %+v %q", res.Routes, res.NoRoute)
	}

	// 开启重置：清掉冷却重新路由
	m.CooldownReset = true
	if err := st.SaveModel(m); err != nil {
		t.Fatal(err)
	}
	res, err = r.Resolve("CR")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Routes) != 2 {
		t.Fatalf("开启重置后应恢复全部路由，得到 %d", len(res.Routes))
	}
}

func TestCooldownExpiredRecovers(t *testing.T) {
	st := newTestStore(t)
	seedChannels(t, st)
	now := time.Now().UnixMilli()
	_ = st.SaveModel(store.Model{
		ID: "CE", Type: store.ModelTypeCustom,
		Routes:  []store.Route{{ChannelID: "A", Upstream: "a"}, {ChannelID: "B", Upstream: "d"}},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	})
	// 冷却 30ms，等它过期
	MarkFailure("A", "a", 30*time.Millisecond)
	time.Sleep(60 * time.Millisecond)
	r := New(st)
	res, err := r.Resolve("CE")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Routes) != 2 {
		t.Fatalf("冷却过期后应恢复，得到 %d 条", len(res.Routes))
	}
}

func TestEffectiveCapsInheritance(t *testing.T) {
	st := newTestStore(t)
	seedChannels(t, st)
	now := time.Now().UnixMilli()
	tool := true
	ctxLen := 200000
	_ = st.SaveModel(store.Model{
		ID: "A/a", Type: store.ModelTypeChannel, ChannelID: "A", Upstream: "a",
		Caps:    store.Caps{ContextLength: &ctxLen, ToolCalling: &tool},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	})
	_ = st.SaveModel(store.Model{
		ID: "LDM", Type: store.ModelTypeCustom,
		Routes:      []store.Route{{ChannelID: "A", Upstream: "a"}},
		ParamSource: "A/a",
		Caps:        store.Caps{Vision: &tool},
		Enabled:     true, CreatedAt: now, UpdatedAt: now,
	})

	r := New(st)
	res, err := r.Resolve("LDM")
	if err != nil {
		t.Fatal(err)
	}
	if res.Caps.ContextLength == nil || *res.Caps.ContextLength != 200000 {
		t.Errorf("应继承 A/a 的上下文长度，得到 %v", res.Caps.ContextLength)
	}
	if res.Caps.ToolCalling == nil || !*res.Caps.ToolCalling {
		t.Error("应继承 A/a 的工具调用能力")
	}
	if res.Caps.Vision != nil {
		t.Error("继承时应完全使用来源模型的参数，而不是混合自身配置")
	}
}

func TestDeleteChannelCascade(t *testing.T) {
	st := newTestStore(t)
	seedChannels(t, st)
	now := time.Now().UnixMilli()
	for _, id := range []string{"A/a", "A/c", "B/a"} {
		chID, up, _ := splitRef(id)
		_ = st.SaveModel(store.Model{
			ID: id, Type: store.ModelTypeChannel, ChannelID: chID, Upstream: up,
			Enabled: true, CreatedAt: now, UpdatedAt: now,
		})
	}
	_ = st.SaveModel(store.Model{
		ID: "LDM", Type: store.ModelTypeCustom,
		Routes:  []store.Route{{ChannelID: "A", Upstream: "c"}, {ChannelID: "B", Upstream: "a"}},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	})

	removed, err := st.DeleteChannelCascade("A")
	if err != nil {
		t.Fatal(err)
	}
	if len(removed) != 2 {
		t.Errorf("应移除 A/a 与 A/c 两个模型，实际 %v", removed)
	}
	if _, err := st.GetChannel("A"); err != store.ErrNotFound {
		t.Error("渠道 A 应被删除")
	}
	m, err := st.GetModel("LDM")
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Routes) != 1 || m.Routes[0].ChannelID != "B" {
		t.Errorf("自定义模型的 A 路由应被清理，得到 %+v", m.Routes)
	}
}

func TestUpdateChannelModelsRemovesStaleEntries(t *testing.T) {
	st := newTestStore(t)
	seedChannels(t, st)
	now := time.Now().UnixMilli()
	_ = st.SaveModel(store.Model{
		ID: "A/b", Type: store.ModelTypeChannel, ChannelID: "A", Upstream: "b",
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	})
	// 渠道 A 不再提供 b
	ch, _ := st.GetChannel("A")
	ch.Models = []string{"a", "c"}
	_ = st.SaveChannel(ch)

	ids, _ := st.ChannelModelIDs()
	if _, ok := ids["A/b"]; ok {
		t.Error("渠道已移除的模型不应再派生渠道模型")
	}
}

func TestStoreTokenLookupAndQuota(t *testing.T) {
	st := newTestStore(t)
	now := time.Now().UnixMilli()
	tok := store.Token{
		ID: "t1", Name: "测试", Key: "sk-ldm-testkey", Enabled: true,
		QuotaLimit: 100, CreatedAt: now, UpdatedAt: now,
	}
	if err := st.SaveToken(tok); err != nil {
		t.Fatal(err)
	}
	got, err := st.FindTokenByKey("sk-ldm-testkey")
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "t1" {
		t.Errorf("按密钥查找失败: %+v", got)
	}
	st.AddTokenUsage("t1", 40)
	got, _ = st.GetToken("t1")
	if got.UsedQuota != 40 {
		t.Errorf("用量累加错误: %d", got.UsedQuota)
	}
	if got.LastUsedAt == 0 {
		t.Error("累加用量时应记录最后使用时间")
	}
	st.AddTokenUsage("t1", 80)
	got, _ = st.GetToken("t1")
	if got.UsedQuota != 120 {
		t.Errorf("用量应继续累加，得到 %d", got.UsedQuota)
	}
	if got.UsedQuota <= got.QuotaLimit {
		t.Error("此时应已超出额度上限")
	}
	if _, err := st.FindTokenByKey("sk-ldm-nope"); err != store.ErrNotFound {
		t.Errorf("不存在的密钥应返回 ErrNotFound，得到 %v", err)
	}
}

func TestStoreLogsAndStats(t *testing.T) {
	st := newTestStore(t)
	now := time.Now().UnixMilli()
	for i, l := range []store.Log{
		{ID: "l1", Time: now, ModelID: "LDM", ChannelID: "A", StatusCode: 200, TotalTokens: 10, LatencyMs: 100},
		{ID: "l2", Time: now + 1, ModelID: "A/a", ChannelID: "A", StatusCode: 500, Error: "boom", TotalTokens: 0, LatencyMs: 50},
		{ID: "l3", Time: now + 2, ModelID: "LDM", ChannelID: "B", StatusCode: 200, TotalTokens: 20, LatencyMs: 200},
	} {
		_ = st.AppendLog(l)
		_ = st.RecordStat(l)
		_ = i
	}

	// 最新的排在最前面
	logs, total, err := st.QueryLogs(store.LogFilter{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if total != 3 {
		t.Errorf("日志总数应为 3，得到 %d", total)
	}
	if logs[0].ID != "l3" {
		t.Errorf("日志应按时间倒序，第一条是 %s", logs[0].ID)
	}

	errs, totalErr, _ := st.QueryLogs(store.LogFilter{Limit: 10, OnlyError: true})
	if totalErr != 1 || len(errs) != 1 || errs[0].ID != "l2" {
		t.Errorf("错误过滤失败: total=%d items=%d", totalErr, len(errs))
	}

	// 下拉筛选：成功 / 失败
	successes, totalOK, _ := st.QueryLogs(store.LogFilter{Limit: 10, Status: "success"})
	if totalOK != 2 || len(successes) != 2 {
		t.Errorf("成功过滤应得到 2 条，得到 total=%d items=%d", totalOK, len(successes))
	}
	for _, l := range successes {
		if l.StatusCode >= 400 {
			t.Errorf("成功过滤混入了失败日志: %+v", l)
		}
	}
	fails, totalFail, _ := st.QueryLogs(store.LogFilter{Limit: 10, Status: "error"})
	if totalFail != 1 || len(fails) != 1 || fails[0].ID != "l2" {
		t.Errorf("失败过滤应得到 1 条，得到 total=%d items=%d", totalFail, len(fails))
	}

	byModel, totalM, _ := st.QueryLogs(store.LogFilter{Limit: 10, ModelID: "LDM"})
	if totalM != 2 {
		t.Errorf("按模型过滤应得到 2 条，得到 %d", totalM)
	}
	if len(byModel) != 2 {
		t.Errorf("返回条数错误: %d", len(byModel))
	}

	// 分页
	page, _, _ := st.QueryLogs(store.LogFilter{Limit: 1, Offset: 1})
	if len(page) != 1 || page[0].ID != "l2" {
		t.Errorf("分页错误: %+v", page)
	}

	buckets, err := st.RangeStats(now-3600000, now+3600000)
	if err != nil {
		t.Fatal(err)
	}
	var reqs, errs2, toks int64
	for _, b := range buckets {
		reqs += b.Requests
		errs2 += b.Errors
		toks += b.TotalTokens
	}
	if reqs != 3 || errs2 != 1 || toks != 30 {
		t.Errorf("统计聚合错误: reqs=%d errors=%d tokens=%d", reqs, errs2, toks)
	}

	removed, err := st.PurgeLogsBefore(now + 2)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 2 {
		t.Errorf("应清理 2 条日志，实际 %d", removed)
	}
}

// 常见的 Go 网络错误要翻成中文，避免日志里出现 context canceled / unexpected EOF。
func TestCleanNetErrTranslatesCommonErrors(t *testing.T) {
	cases := []struct{ in, want string }{
		{"context canceled", "客户端已断开连接"},
		{"context deadline exceeded", "上游响应超时"},
		{"read tcp 1.2.3.4: unexpected EOF", "上游连接意外中断"},
		{"read tcp 1.2.3.4: connection reset by peer", "上游连接被重置"},
		{"write tcp: broken pipe", "上游连接已断开"},
		{"read tcp: i/o timeout", "上游读写超时"},
		{"some other error", "some other error"},
	}
	for _, c := range cases {
		if got := cleanNetErr(errors.New(c.in)); got != c.want {
			t.Errorf("cleanNetErr(%q) = %q，期望 %q", c.in, got, c.want)
		}
	}
}

// 状态码 200 但中途出错（例如流式响应断开）必须算失败，和统计口径保持一致。
func TestLogStatusFilterTreatsErrorWith200AsFailure(t *testing.T) {
	st := newTestStore(t)
	now := time.Now().UnixMilli()
	for _, l := range []store.Log{
		{ID: "ok", Time: now, StatusCode: 200},
		{ID: "soft", Time: now + 1, StatusCode: 200, Error: "读取上游响应失败: unexpected EOF"},
		{ID: "hard", Time: now + 2, StatusCode: 500, Error: "boom"},
	} {
		if err := st.AppendLog(l); err != nil {
			t.Fatal(err)
		}
	}

	okLogs, okTotal, err := st.QueryLogs(store.LogFilter{Limit: 10, Status: "success"})
	if err != nil {
		t.Fatal(err)
	}
	if okTotal != 1 || len(okLogs) != 1 || okLogs[0].ID != "ok" {
		t.Errorf("成功过滤应只剩 ok，得到 total=%d %+v", okTotal, okLogs)
	}

	failLogs, failTotal, err := st.QueryLogs(store.LogFilter{Limit: 10, Status: "error"})
	if err != nil {
		t.Fatal(err)
	}
	if failTotal != 2 || len(failLogs) != 2 {
		t.Fatalf("失败过滤应得到 2 条，得到 total=%d items=%d", failTotal, len(failLogs))
	}
	if failLogs[0].ID != "hard" || failLogs[1].ID != "soft" {
		t.Errorf("失败过滤结果错误: %+v", failLogs)
	}
}

func TestPickByWeightDistribution(t *testing.T) {
	// 权重 3:1，200 次抽样两边都应命中，且比例大致正确
	counts := map[int]int{}
	for i := 0; i < 200; i++ {
		counts[pickByWeight(2, func(i int) int { return []int{3, 1}[i] })]++
	}
	if counts[0] == 0 || counts[1] == 0 {
		t.Fatalf("两个条目都应被抽中: %v", counts)
	}
	if counts[0] < 100 || counts[0] > 185 {
		t.Errorf("权重 3:1 时第一个应约占 75%%，得到 %d/200", counts[0])
	}
	// 权重全 0 时等概率且不 panic
	for i := 0; i < 50; i++ {
		if idx := pickByWeight(3, func(int) int { return 0 }); idx < 0 || idx > 2 {
			t.Fatalf("等概率抽样越界: %d", idx)
		}
	}
}

func TestEstimateTokens(t *testing.T) {
	if got := estimateTokens(""); got != 0 {
		t.Errorf("空串应为 0，得到 %d", got)
	}
	if got := estimateTokens("hello world"); got != 2 {
		t.Errorf("11 个 ASCII 字符约 2 token，得到 %d", got)
	}
	if got := estimateTokens("你好世界"); got != 4 {
		t.Errorf("4 个汉字应为 4 token，得到 %d", got)
	}
}

func TestReasoningCharsOf(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want int
	}{
		{"无思考字段", `{"choices":[{"message":{"content":"你好"}}]}`, 0},
		{"reasoning_content", `{"choices":[{"message":{"reasoning_content":"一二三","content":"x"}}]}`, 3},
		{"reasoning", `{"choices":[{"message":{"reasoning":"abcd"}}]}`, 4},
		{"多 choice 累加", `{"choices":[{"message":{"reasoning_content":"ab"}},{"message":{"reasoning_content":"cd"}}]}`, 4},
		{"非法 JSON", `not json`, 0},
		{"空响应", `{}`, 0},
	}
	for _, c := range cases {
		if got := reasoningCharsOf([]byte(c.raw)); got != c.want {
			t.Errorf("%s: reasoningCharsOf = %d，期望 %d", c.name, got, c.want)
		}
	}
}

// 能力参数（工具调用 / 思考 / 图片是否支持）只用于界面展示，
// 即使模型标记为「不支持」，转发时也不能改动请求内容。
func TestCapabilitiesDoNotRewriteRequest(t *testing.T) {
	var received map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &received)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}],` +
			`"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer srv.Close()

	st := newTestStore(t)
	now := time.Now().UnixMilli()
	no := false
	if err := st.SaveChannel(store.Channel{
		ID: "A", Type: store.ChannelOpenAI, BaseURL: srv.URL, APIKey: "k",
		Models: []string{"a"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "A/a", Type: store.ModelTypeChannel, ChannelID: "A", Upstream: "a",
		Caps:    store.Caps{ToolCalling: &no, Vision: &no, Thinking: &no},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	payload := `{"model":"A/a","messages":[{"role":"user","content":[` +
		`{"type":"text","text":"看图"},` +
		`{"type":"image_url","image_url":{"url":"data:image/png;base64,AAA"}}]}],` +
		`"tools":[{"type":"function","function":{"name":"f"}}],"reasoning_effort":"high"}`
	req := &Request{
		Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{}, Body: []byte(payload),
	}
	if err := json.Unmarshal([]byte(payload), &req.JSON); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	New(st).Do(context.Background(), rec, req)

	if received == nil {
		t.Fatal("上游没有收到请求")
	}
	if _, ok := received["tools"]; !ok {
		t.Error("tools 不应被剥离")
	}
	if received["reasoning_effort"] != "high" {
		t.Error("reasoning_effort 不应被移除")
	}
	msgs, _ := received["messages"].([]any)
	if len(msgs) != 1 {
		t.Fatalf("消息数量错误: %d", len(msgs))
	}
	parts, _ := msgs[0].(map[string]any)["content"].([]any)
	if len(parts) != 2 {
		t.Errorf("图片内容不应被过滤，期望 2 个内容块，得到 %d", len(parts))
	}
}

// 重试过之后，Result.Attempts 必须保留每次尝试的渠道、状态码和错误，
// 否则日志里只剩一个「重试 N」徽章，排障时看不到中间失败的路由。
func TestRetryHistoryRecordsFailedAttempts(t *testing.T) {
	st := newTestStore(t)
	now := time.Now().UnixMilli()

	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		io.WriteString(w, `{"error":{"message":"upstream boom"}}`)
	}))
	defer bad.Close()
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"ok","usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}}`)
	}))
	defer good.Close()

	for _, c := range []store.Channel{
		{ID: "hist-bad", Name: "故障线路", Type: store.ChannelOpenAI, BaseURL: bad.URL, Enabled: true, CreatedAt: now, UpdatedAt: now},
		{ID: "hist-good", Name: "正常线路", Type: store.ChannelOpenAI, BaseURL: good.URL, Enabled: true, CreatedAt: now, UpdatedAt: now},
	} {
		if err := st.SaveChannel(c); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.SaveModel(store.Model{
		ID: "hist/model", Type: store.ModelTypeCustom,
		Routes: []store.Route{
			{ChannelID: "hist-bad", Upstream: "m"},
			{ChannelID: "hist-good", Upstream: "m"},
		},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	body := []byte(`{"model":"hist/model","messages":[{"role":"user","content":"hi"}]}`)
	req := &Request{
		Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{}, Body: body,
		JSON: map[string]any{"model": "hist/model"},
	}
	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("第二条路由应成功，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if res.Retries != 1 {
		t.Errorf("重试次数应为 1，得到 %d", res.Retries)
	}
	if len(res.Attempts) != 2 {
		t.Fatalf("应记录 2 次尝试，得到 %d", len(res.Attempts))
	}
	first := res.Attempts[0]
	if first.ChannelID != "hist-bad" || first.ChannelName != "故障线路" ||
		first.UpstreamModel != "m" || first.StatusCode != http.StatusInternalServerError {
		t.Errorf("第一次尝试记录错误: %+v", first)
	}
	if !strings.Contains(first.Error, "upstream boom") {
		t.Errorf("第一次尝试应保留上游错误，得到 %q", first.Error)
	}
	second := res.Attempts[1]
	if second.ChannelID != "hist-good" || second.ChannelName != "正常线路" ||
		second.StatusCode != http.StatusOK || second.Error != "" {
		t.Errorf("第二次尝试记录错误: %+v", second)
	}
}

// 没有重试的请求不写尝试明细，避免日志体积翻倍。
func TestNoRetryKeepsAttemptsEmpty(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"ok","usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	defer srv.Close()

	st := newTestStore(t)
	now := time.Now().UnixMilli()
	if err := st.SaveChannel(store.Channel{
		ID: "single", Name: "单线路", Type: store.ChannelOpenAI, BaseURL: srv.URL,
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "single/model", Type: store.ModelTypeCustom,
		Routes:  []store.Route{{ChannelID: "single", Upstream: "m"}},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	body := []byte(`{"model":"single/model","messages":[{"role":"user","content":"hi"}]}`)
	req := &Request{
		Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{}, Body: body,
		JSON: map[string]any{"model": "single/model"},
	}
	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("请求应成功，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if len(res.Attempts) != 0 {
		t.Errorf("没有重试时不应记录尝试明细，得到 %+v", res.Attempts)
	}
}

// 客户端主动断开（点「停止」）也按成功记账：应记录模型亲和，
// 下次请求优先复用断开时正在使用的那条路由。
func TestCanceledRequestRecordsAffinity(t *testing.T) {
	st := newTestStore(t)
	now := time.Now().UnixMilli()
	for _, c := range []store.Channel{
		{ID: "cancel-a", Name: "主线路", Type: store.ChannelOpenAI, BaseURL: "http://127.0.0.1:1", Enabled: false, CreatedAt: now, UpdatedAt: now},
		{ID: "cancel-b", Name: "备用线路", Type: store.ChannelOpenAI, BaseURL: "http://127.0.0.1:1", Enabled: true, CreatedAt: now, UpdatedAt: now},
	} {
		if err := st.SaveChannel(c); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.SaveModel(store.Model{
		ID: "cancel/model", Type: store.ModelTypeCustom,
		Routes: []store.Route{
			{ChannelID: "cancel-a", Upstream: "a"},
			{ChannelID: "cancel-b", Upstream: "b"},
		},
		Affinity: true, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	// 主线路先禁用，让请求落到备用线路；再模拟客户端在建连前断开。
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	body := []byte(`{"model":"cancel/model","messages":[{"role":"user","content":"hi"}]}`)
	req := &Request{
		Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{}, Body: body,
		JSON: map[string]any{"model": "cancel/model"},
	}
	res := New(st).Do(ctx, httptest.NewRecorder(), req)
	if !res.Canceled {
		t.Fatalf("应识别为客户端断开，得到 %+v", res)
	}

	// 恢复主线路：若断开被记为成功，亲和应把备用线路提到最前。
	chA, err := st.GetChannel("cancel-a")
	if err != nil {
		t.Fatal(err)
	}
	chA.Enabled = true
	if err := st.SaveChannel(chA); err != nil {
		t.Fatal(err)
	}
	got, err := New(st).Resolve("cancel/model")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Routes) < 2 || got.Routes[0].Channel.ID != "cancel-b" {
		t.Fatalf("客户端断开也应记录亲和，期望 cancel-b 在最前，得到 %+v", got.Routes)
	}
}

// 上游在流式响应中途断开属于普通失败：即使已经写出部分响应，
// 也要让该路由进入冷却，下一次请求应换渠道。
func TestUpstreamStreamDisconnectMarksFailure(t *testing.T) {
	st := newTestStore(t)
	now := time.Now().UnixMilli()

	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n")
		if fl, ok := w.(http.Flusher); ok {
			fl.Flush()
		}
		if hj, ok := w.(http.Hijacker); ok {
			if conn, _, err := hj.Hijack(); err == nil {
				conn.Close()
			}
		}
	}))
	defer broken.Close()

	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"ok","usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	defer good.Close()

	for _, c := range []store.Channel{
		{ID: "stream-bad", Name: "断流线路", Type: store.ChannelOpenAI, BaseURL: broken.URL, Enabled: true, CreatedAt: now, UpdatedAt: now},
		{ID: "stream-good", Name: "正常线路", Type: store.ChannelOpenAI, BaseURL: good.URL, Enabled: true, CreatedAt: now, UpdatedAt: now},
	} {
		if err := st.SaveChannel(c); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.SaveModel(store.Model{
		ID: "stream/model", Type: store.ModelTypeCustom,
		Routes: []store.Route{
			{ChannelID: "stream-bad", Upstream: "m"},
			{ChannelID: "stream-good", Upstream: "m"},
		},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	body := []byte(`{"model":"stream/model","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	req := &Request{
		Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{}, Body: body, Stream: true,
		JSON: map[string]any{"model": "stream/model", "stream": true},
	}
	res := New(st).Do(context.Background(), httptest.NewRecorder(), req)
	if res.Canceled {
		t.Fatalf("上游断开不应记为客户端断开: %+v", res)
	}
	if res.Err == "" {
		t.Fatalf("上游断流应记为失败: %+v", res)
	}

	got, err := New(st).Resolve("stream/model")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Routes) != 1 || got.Routes[0].Channel.ID != "stream-good" {
		t.Fatalf("断流的上游应进入冷却，期望只剩 stream-good，得到 %+v", got.Routes)
	}
}
