package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
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

// 渠道里已经删掉的模型，即使模型设置里还保留着配置，也不能再转发。
func TestResolveChannelModelRemovedFromChannel(t *testing.T) {
	st := newTestStore(t)
	seedChannels(t, st)
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "A/x", Type: store.ModelTypeChannel, ChannelID: "A", Upstream: "x",
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	r := New(st)
	res, err := r.Resolve("A/x")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Routes) != 0 {
		t.Fatalf("渠道未添加的模型不应有可用路由，得到 %+v", res.Routes)
	}
	if res.NoRoute != "" {
		t.Errorf("被跳过的模型不应单独报原因，得到 %q", res.NoRoute)
	}

	rec := httptest.NewRecorder()
	out := New(st).Do(context.Background(), rec, &Request{
		Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{}, Body: []byte(`{"model":"A/x"}`),
		JSON: map[string]any{"model": "A/x"},
	})
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("状态码应为 503，得到 %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "模型「A/x」当前没有可用渠道") {
		t.Errorf("对外文案应与无可用渠道一致，得到 %s", rec.Body.String())
	}
	if out.Err != "" {
		t.Errorf("被跳过的模型不应记录专门错误，得到 %q", out.Err)
	}
}

// 自定义模型的路由里混有渠道已删除的模型时，只跳过失效的那几条。
func TestResolveCustomSkipsRemovedChannelModels(t *testing.T) {
	st := newTestStore(t)
	seedChannels(t, st)
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "LDM", Type: store.ModelTypeCustom,
		Routes: []store.Route{
			{ChannelID: "A", Upstream: "c"},
			{ChannelID: "A", Upstream: "x"},
			{ChannelID: "B", Upstream: "d"},
		},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "GONE", Type: store.ModelTypeCustom,
		Routes:  []store.Route{{ChannelID: "A", Upstream: "x"}},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	r := New(st)
	res, err := r.Resolve("LDM")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Routes) != 2 || res.Routes[0].Channel.ID != "A" || res.Routes[1].Channel.ID != "B" {
		t.Fatalf("应跳过渠道已移除的模型，得到 %+v", res.Routes)
	}

	gone, err := r.Resolve("GONE")
	if err != nil {
		t.Fatal(err)
	}
	if len(gone.Routes) != 0 {
		t.Fatalf("所有路由都被移除时不应有可用路由，得到 %+v", gone.Routes)
	}
	// 被移除的路由在解析阶段就跳过，与「没有配置路由」同等对待，不再单独报原因
	if gone.NoRoute != "该自定义模型尚未配置路由目标" {
		t.Errorf("被移除的路由不应单独报原因，得到 %q", gone.NoRoute)
	}

	// 剩下的有效路由全部冷却时，原因应如实报冷却，而不是已跳过的路由
	ClearAllCooldowns()
	defer ClearAllCooldowns()
	MarkFailure("A", "c")
	MarkFailure("B", "d")
	cooling, err := r.Resolve("LDM")
	if err != nil {
		t.Fatal(err)
	}
	if len(cooling.Routes) != 0 {
		t.Fatalf("有效路由都在冷却时不应有可用路由，得到 %+v", cooling.Routes)
	}
	if cooling.NoRoute != "所有路由都在失败冷却中" {
		t.Errorf("应报冷却原因，得到 %q", cooling.NoRoute)
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
		if !res.Affinity {
			t.Fatal("命中亲和时 Resolve 应标记 Affinity")
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
	if res.Affinity {
		t.Error("未开启亲和的模型不应标记 Affinity")
	}
}

// 组内按权重完整洗牌：3 个等权重条目应出现全部 6 种顺序，
// 而不是只在配置顺序上循环挪动起点（那样只有 3 种）。
func TestWeightedGroupShufflesWholeOrder(t *testing.T) {
	st := newTestStore(t)
	seedChannels(t, st)
	now := time.Now().UnixMilli()
	_ = st.SaveModel(store.Model{
		ID: "SHUF", Type: store.ModelTypeCustom,
		Routes: []store.Route{
			{ChannelID: "A", Upstream: "a", Group: 1},
			{ChannelID: "A", Upstream: "b", Group: 1},
			{ChannelID: "A", Upstream: "c", Group: 1},
		},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	})
	r := New(st)
	seen := map[string]bool{}
	for i := 0; i < 600; i++ {
		res, err := r.Resolve("SHUF")
		if err != nil {
			t.Fatal(err)
		}
		if len(res.Routes) != 3 {
			t.Fatalf("路由数量错误: %d", len(res.Routes))
		}
		var b strings.Builder
		for _, rt := range res.Routes {
			b.WriteString(rt.Upstream)
		}
		seen[b.String()] = true
	}
	if len(seen) != 6 {
		t.Fatalf("完整洗牌应出现 6 种顺序，实际 %d 种: %v", len(seen), seen)
	}
}

// 完整洗牌仍要尊重权重：权重 9:1 时重条目应约占 90% 排在最前。
func TestWeightedGroupShufflePrefersHeavier(t *testing.T) {
	st := newTestStore(t)
	seedChannels(t, st)
	now := time.Now().UnixMilli()
	_ = st.SaveModel(store.Model{
		ID: "WS", Type: store.ModelTypeCustom,
		Routes: []store.Route{
			{ChannelID: "A", Upstream: "a", Group: 1, Weight: 9},
			{ChannelID: "A", Upstream: "b", Group: 1, Weight: 1},
		},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	})
	r := New(st)
	const rounds = 400
	heavy := 0
	for i := 0; i < rounds; i++ {
		res, err := r.Resolve("WS")
		if err != nil {
			t.Fatal(err)
		}
		if res.Routes[0].Upstream == "a" {
			heavy++
		}
	}
	if heavy < 320 || heavy > 388 {
		t.Fatalf("权重 9:1 时重条目应约占 90%%，实际 %d/%d", heavy, rounds)
	}
}

// 亲和从上次成功条目的位置开始环形顺延，而不是把它单独搬到链首。
func TestAffinityStartsAtPosition(t *testing.T) {
	st := newTestStore(t)
	seedChannels(t, st)
	now := time.Now().UnixMilli()
	_ = st.SaveModel(store.Model{
		ID: "AF2", Type: store.ModelTypeCustom,
		Routes: []store.Route{
			{ChannelID: "A", Upstream: "a"},
			{ChannelID: "B", Upstream: "d"},
			{ChannelID: "B", Upstream: "a"},
		},
		Affinity: true, Enabled: true, CreatedAt: now, UpdatedAt: now,
	})
	defer ClearModelRoutes("AF2")
	r := New(st)
	// 上次成功走 B/d（配置里的第 2 条）
	MarkSuccess("AF2", "B", "d")
	want := []string{"B/d", "B/a", "A/a"}
	for i := 0; i < 5; i++ {
		res, err := r.Resolve("AF2")
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for _, rt := range res.Routes {
			got = append(got, rt.Channel.ID+"/"+rt.Upstream)
		}
		if !slices.Equal(got, want) {
			t.Fatalf("亲和应从第 2 条开始环形顺延，期望 %v，得到 %v", want, got)
		}
		if !res.Affinity {
			t.Fatal("命中亲和时 Resolve 应标记 Affinity")
		}
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
	MarkFailure("A", "a")
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
	MarkFailure("CLR-A", "a")
	MarkFailure("CLR-B", "b")
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
	MarkFailure("A", "a")
	MarkFailure("B", "d")

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
	// 失败发生在一小时前：默认冷却 300 秒，已过期
	markFailureAt("A", "a", time.Now().Add(-time.Hour))
	r := New(st)
	res, err := r.Resolve("CE")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Routes) != 2 {
		t.Fatalf("冷却过期后应恢复，得到 %d 条", len(res.Routes))
	}
}

// 冷却时长取当前配置：调小后已冷却的条目应提前恢复，调大后应立即生效。
func TestCooldownUsesCurrentConfigDuration(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()
	st := newTestStore(t)
	seedChannels(t, st)
	now := time.Now().UnixMilli()
	m := store.Model{
		ID: "CDYN", Type: store.ModelTypeCustom,
		Routes:      []store.Route{{ChannelID: "A", Upstream: "a"}, {ChannelID: "B", Upstream: "d"}},
		CooldownSec: 1,
		Enabled:     true, CreatedAt: now, UpdatedAt: now,
	}
	_ = st.SaveModel(m)
	// 2 秒前失败：1 秒冷却已过期
	markFailureAt("A", "a", time.Now().Add(-2*time.Second))
	res, err := New(st).Resolve("CDYN")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Routes) != 2 {
		t.Fatalf("冷却 1 秒，2 秒前失败应已恢复，得到 %d 条", len(res.Routes))
	}
	// 调大到 10 秒后，同一条失败记录应立即重新生效
	m.CooldownSec = 10
	if err := st.SaveModel(m); err != nil {
		t.Fatal(err)
	}
	res, err = New(st).Resolve("CDYN")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Routes) != 1 || res.Routes[0].Channel.ID != "B" {
		t.Fatalf("调大冷却时长后应立即进入冷却，得到 %+v", res.Routes)
	}
}

// 共享同一条渠道模型的多个自定义模型，各自按自己的 CooldownSec 判断，互不覆盖。
func TestCooldownSharedAcrossModelsUsesOwnDuration(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()
	st := newTestStore(t)
	seedChannels(t, st)
	now := time.Now().UnixMilli()
	routes := []store.Route{{ChannelID: "A", Upstream: "a"}, {ChannelID: "B", Upstream: "d"}}
	_ = st.SaveModel(store.Model{
		ID: "CD-LONG", Type: store.ModelTypeCustom, Routes: routes,
		CooldownSec: 600, Enabled: true, CreatedAt: now, UpdatedAt: now,
	})
	_ = st.SaveModel(store.Model{
		ID: "CD-SHORT", Type: store.ModelTypeCustom, Routes: routes,
		CooldownSec: 1, Enabled: true, CreatedAt: now, UpdatedAt: now,
	})
	markFailureAt("A", "a", time.Now().Add(-2*time.Second))
	// 长冷却模型：仍应跳过 A/a
	res, err := New(st).Resolve("CD-LONG")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Routes) != 1 || res.Routes[0].Channel.ID != "B" {
		t.Fatalf("600 秒冷却的模型应继续跳过 A/a，得到 %+v", res.Routes)
	}
	// 短冷却模型：已过期，两条都可用
	res, err = New(st).Resolve("CD-SHORT")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Routes) != 2 {
		t.Fatalf("1 秒冷却的模型应已恢复，得到 %d 条", len(res.Routes))
	}
}

func TestPruneModelRoutes(t *testing.T) {
	ClearModelRoutes("PRUNE")
	defer ClearModelRoutes("PRUNE")
	MarkSuccess("PRUNE", "PCH", "p")
	PruneModelRoutes("PRUNE", []store.Route{{ChannelID: "PCH", Upstream: "p"}})
	routeStates.Lock()
	last := routeStates.lastRoute["PRUNE"]
	routeStates.Unlock()
	if last == "" {
		t.Fatal("路由仍在配置里时不应清理亲和记录")
	}
	PruneModelRoutes("PRUNE", []store.Route{{ChannelID: "OTHER", Upstream: "x"}})
	routeStates.Lock()
	_, ok := routeStates.lastRoute["PRUNE"]
	routeStates.Unlock()
	if ok {
		t.Fatal("路由已从配置删除时亲和记录应清理")
	}
}

func TestClearCooldownsScoped(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()
	MarkFailure("SC-A", "x")
	MarkFailure("SC-A", "y")
	MarkFailure("SC-B", "z")
	m := store.Model{Type: store.ModelTypeCustom, Routes: []store.Route{
		{ChannelID: "SC-A", Upstream: "x"},
		{ChannelID: "SC-B", Upstream: "z"},
	}}
	if n := ClearCooldownsForModel(m); n != 2 {
		t.Fatalf("应按模型清掉 2 条冷却，得到 %d", n)
	}
	if n := ClearCooldownsForChannel("SC-A"); n != 1 {
		t.Fatalf("应按渠道清掉剩余的 1 条冷却，得到 %d", n)
	}
	// 渠道模型：按自身渠道/上游清
	MarkFailure("SC-B", "z")
	cm := store.Model{Type: store.ModelTypeChannel, ChannelID: "SC-B", Upstream: "z"}
	if n := ClearCooldownsForModel(cm); n != 1 {
		t.Fatalf("渠道模型应清掉自身路由的冷却，得到 %d", n)
	}
	if n := ClearAllCooldowns(); n != 0 {
		t.Fatalf("冷却应已清空，仍剩 %d", n)
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
		{ID: "l1", Time: now, ModelID: "LDM", ChannelID: "A", StatusCode: 200, TotalTokens: 10, LatencyMs: 100, Stream: true, FirstByteMs: 40, TokensPerSec: 10},
		{ID: "l2", Time: now + 1, ModelID: "A/a", ChannelID: "A", StatusCode: 500, Error: "boom", TotalTokens: 0, LatencyMs: 50},
		{ID: "l3", Time: now + 2, ModelID: "LDM", ChannelID: "B", StatusCode: 200, TotalTokens: 20, LatencyMs: 200, Stream: true, FirstByteMs: 60, TokensPerSec: 20},
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
	var speedCount int64
	var speedSum float64
	var speedLatency, speedFirstByte int64
	for _, b := range buckets {
		reqs += b.Requests
		errs2 += b.Errors
		toks += b.TotalTokens
		speedCount += b.SpeedCount
		speedSum += b.SpeedSum
		speedLatency += b.SpeedLatencySum
		speedFirstByte += b.SpeedFirstByteSum
	}
	if reqs != 3 || errs2 != 1 || toks != 30 {
		t.Errorf("统计聚合错误: reqs=%d errors=%d tokens=%d", reqs, errs2, toks)
	}
	// 只有同时具备首字、总耗时、速度的记录才计入平均速度
	if speedCount != 2 || speedSum != 30 || speedLatency != 300 || speedFirstByte != 100 {
		t.Errorf("速度聚合错误: count=%d sum=%v latency=%d firstByte=%d",
			speedCount, speedSum, speedLatency, speedFirstByte)
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
		{ID: "hist-bad", Name: "故障线路", Type: store.ChannelOpenAI, BaseURL: bad.URL, Models: []string{"m"}, Enabled: true, CreatedAt: now, UpdatedAt: now},
		{ID: "hist-good", Name: "正常线路", Type: store.ChannelOpenAI, BaseURL: good.URL, Models: []string{"m"}, Enabled: true, CreatedAt: now, UpdatedAt: now},
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
		Models: []string{"m"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
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
		{ID: "cancel-a", Name: "主线路", Type: store.ChannelOpenAI, BaseURL: "http://127.0.0.1:1", Models: []string{"a"}, Enabled: false, CreatedAt: now, UpdatedAt: now},
		{ID: "cancel-b", Name: "备用线路", Type: store.ChannelOpenAI, BaseURL: "http://127.0.0.1:1", Models: []string{"b"}, Enabled: true, CreatedAt: now, UpdatedAt: now},
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
		{ID: "stream-bad", Name: "断流线路", Type: store.ChannelOpenAI, BaseURL: broken.URL, Models: []string{"m"}, Enabled: true, CreatedAt: now, UpdatedAt: now},
		{ID: "stream-good", Name: "正常线路", Type: store.ChannelOpenAI, BaseURL: good.URL, Models: []string{"m"}, Enabled: true, CreatedAt: now, UpdatedAt: now},
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

// 上游已经发出 [DONE]（响应内容完整）后客户端立刻关闭连接，是很多客户端的
// 正常行为，不能记成「客户端中途断开」。
func TestClientDisconnectAfterDoneCountsAsSuccess(t *testing.T) {
	st := newTestStore(t)
	now := time.Now().UnixMilli()

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\n")
		io.WriteString(w, "data: [DONE]\n\n")
		if fl, ok := w.(http.Flusher); ok {
			fl.Flush()
		}
		// 保持连接不主动关闭，直到客户端（relay）取消请求。
		<-r.Context().Done()
	}))
	defer up.Close()

	if err := st.SaveChannel(store.Channel{
		ID: "done-ch", Name: "正常线路", Type: store.ChannelOpenAI, BaseURL: up.URL,
		Models: []string{"m"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "done/model", Type: store.ModelTypeCustom,
		Routes:  []store.Route{{ChannelID: "done-ch", Upstream: "m"}},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	body := []byte(`{"model":"done/model","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	req := &Request{
		Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{}, Body: body, Stream: true,
		JSON: map[string]any{"model": "done/model", "stream": true},
	}
	// 网关把 [DONE] 写给客户端时立刻取消，等价于客户端收到 [DONE] 后挂断。
	w := &cancelOnWrite{ResponseWriter: httptest.NewRecorder(), needle: []byte("[DONE]"), cancel: cancel}
	res := New(st).Do(ctx, w, req)
	if res.Canceled {
		t.Fatalf("上游已发 [DONE]，客户端随后断开不应记为取消: %+v", res)
	}
	if res.Err != "" {
		t.Fatalf("上游已发 [DONE]，不应记为失败: %+v", res)
	}
	if res.Usage.CompletionTokens != 2 || res.Usage.TotalTokens != 5 {
		t.Fatalf("应保留上游上报的用量，得到 %+v", res.Usage)
	}
}

// 还没收到结束标记就断开，才是真正的中途取消，仍按黄色 200 记账。
func TestClientDisconnectMidStreamMarksCanceled(t *testing.T) {
	st := newTestStore(t)
	now := time.Now().UnixMilli()

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n")
		if fl, ok := w.(http.Flusher); ok {
			fl.Flush()
		}
		<-r.Context().Done()
	}))
	defer up.Close()

	if err := st.SaveChannel(store.Channel{
		ID: "mid-ch", Name: "正常线路", Type: store.ChannelOpenAI, BaseURL: up.URL,
		Models: []string{"m"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "mid/model", Type: store.ModelTypeCustom,
		Routes:  []store.Route{{ChannelID: "mid-ch", Upstream: "m"}},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	body := []byte(`{"model":"mid/model","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	req := &Request{
		Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{}, Body: body, Stream: true,
		JSON: map[string]any{"model": "mid/model", "stream": true},
	}
	// 正文块刚写出去就断开，此时还没有任何结束标记。
	w := &cancelOnWrite{ResponseWriter: httptest.NewRecorder(), needle: []byte("hi"), cancel: cancel}
	res := New(st).Do(ctx, w, req)
	if !res.Canceled {
		t.Fatalf("收到结束标记前断开应记为取消: %+v", res)
	}
	if res.StatusCode != http.StatusOK {
		t.Fatalf("取消应记为 200，得到 %d", res.StatusCode)
	}
}

// cancelOnWrite 在响应体出现 needle 时取消请求，用来模拟客户端读到某个
// 事件后立刻断开连接。取消发生在 Write 内部，因此一定晚于网关解析该事件。
type cancelOnWrite struct {
	http.ResponseWriter
	needle []byte
	cancel context.CancelFunc
	once   sync.Once
}

func (w *cancelOnWrite) Write(p []byte) (int, error) {
	n, err := w.ResponseWriter.Write(p)
	if bytes.Contains(p, w.needle) {
		w.once.Do(w.cancel)
	}
	return n, err
}

func (w *cancelOnWrite) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// 对外错误不能带渠道 ID、渠道状态或上游原始报错，这些只留在日志里。
func TestClientErrorsHideInternals(t *testing.T) {
	now := time.Now().UnixMilli()
	reqFor := func(model string) *Request {
		body := []byte(`{"model":"` + model + `","messages":[{"role":"user","content":"hi"}]}`)
		return &Request{
			Path: "/v1/chat/completions", Method: http.MethodPost,
			Header: http.Header{}, Body: body,
			JSON: map[string]any{"model": model},
		}
	}
	seedCustom := func(t *testing.T, st *store.Store, enabled bool, baseURL string) {
		t.Helper()
		if err := st.SaveChannel(store.Channel{
			ID: "secret-chan", Name: "内部线路", Type: store.ChannelOpenAI,
			BaseURL: baseURL, Models: []string{"m"}, Enabled: enabled, CreatedAt: now, UpdatedAt: now,
		}); err != nil {
			t.Fatal(err)
		}
		if err := st.SaveModel(store.Model{
			ID: "smart", Type: store.ModelTypeCustom,
			Routes:  []store.Route{{ChannelID: "secret-chan", Upstream: "m"}},
			Enabled: true, CreatedAt: now, UpdatedAt: now,
		}); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("渠道已禁用", func(t *testing.T) {
		st := newTestStore(t)
		seedCustom(t, st, false, "http://127.0.0.1:1")

		rec := httptest.NewRecorder()
		res := New(st).Do(context.Background(), rec, reqFor("smart"))
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("状态码应为 503，得到 %d", rec.Code)
		}
		body := rec.Body.String()
		if !strings.Contains(body, "模型「smart」当前没有可用渠道") {
			t.Errorf("对外文案不正确: %s", body)
		}
		if strings.Contains(body, "secret-chan") || strings.Contains(body, "禁用") {
			t.Errorf("对外文案泄露了渠道信息: %s", body)
		}
		if !strings.Contains(res.Err, "secret-chan") {
			t.Errorf("日志应保留内部原因，得到 %q", res.Err)
		}
		if !strings.Contains(res.ClientErr, "当前没有可用渠道") {
			t.Errorf("日志应记录对外返回，得到 %q", res.ClientErr)
		}
		if strings.Contains(res.ClientErr, "secret-chan") || strings.Contains(res.ClientErr, "禁用") {
			t.Errorf("对外返回文案不应包含内部原因，得到 %q", res.ClientErr)
		}
	})

	t.Run("上游报错", func(t *testing.T) {
		st := newTestStore(t)
		bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
			io.WriteString(w, `{"error":{"message":"secret-upstream-detail"}}`)
		}))
		defer bad.Close()
		seedCustom(t, st, true, bad.URL)

		rec := httptest.NewRecorder()
		res := New(st).Do(context.Background(), rec, reqFor("smart"))
		body := rec.Body.String()
		// 上游自己的错误原样返回，但不能带网关的渠道信息。
		if !strings.Contains(body, "secret-upstream-detail") {
			t.Errorf("应透传上游原始错误: %s", body)
		}
		if strings.Contains(body, "secret-chan") {
			t.Errorf("对外文案泄露了渠道信息: %s", body)
		}
		if res.Err != "" {
			t.Errorf("上游原始错误已透传，内部原因不应重复，得到 %q", res.Err)
		}
		if !strings.Contains(res.ClientErr, "secret-upstream-detail") {
			t.Errorf("日志应记录调用方实际收到的内容，得到 %q", res.ClientErr)
		}
		if res.ChannelName != "内部线路" {
			t.Errorf("日志应记录渠道名称，得到 %q", res.ChannelName)
		}
	})

	t.Run("上游限流", func(t *testing.T) {
		ClearAllCooldowns()
		st := newTestStore(t)
		limited := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusTooManyRequests)
			io.WriteString(w, `{"error":{"message":"rate limited","code":429}}`)
		}))
		defer limited.Close()
		seedCustom(t, st, true, limited.URL)

		rec := httptest.NewRecorder()
		res := New(st).Do(context.Background(), rec, reqFor("smart"))
		body := rec.Body.String()
		if !strings.Contains(body, "rate limited") {
			t.Errorf("应透传上游 429 响应: %s", body)
		}
		if !strings.Contains(res.ClientErr, "rate limited") {
			t.Errorf("日志应记录上游 429 的实际返回，得到 %q", res.ClientErr)
		}
		if res.Err != "" {
			t.Errorf("上游原始错误已透传，内部原因不应重复，得到 %q", res.Err)
		}
	})

	t.Run("模型已禁用", func(t *testing.T) {
		st := newTestStore(t)
		if err := st.SaveModel(store.Model{
			ID: "smart", Type: store.ModelTypeCustom,
			Enabled: false, CreatedAt: now, UpdatedAt: now,
		}); err != nil {
			t.Fatal(err)
		}

		rec := httptest.NewRecorder()
		New(st).Do(context.Background(), rec, reqFor("smart"))
		if !strings.Contains(rec.Body.String(), "模型「smart」不可用") {
			t.Errorf("对外文案不正确: %s", rec.Body.String())
		}
	})

	t.Run("模型不存在", func(t *testing.T) {
		st := newTestStore(t)
		rec := httptest.NewRecorder()
		New(st).Do(context.Background(), rec, reqFor("nope"))
		if !strings.Contains(rec.Body.String(), "模型「nope」不存在") {
			t.Errorf("对外文案不正确: %s", rec.Body.String())
		}
	})
}

// API 密钥只能调用模型相关端点，文件/微调/批处理等账号级接口必须被拒绝。
func TestIsAllowedEndpoint(t *testing.T) {
	allowed := []struct{ method, path string }{
		{http.MethodGet, "/v1/models"},
		{http.MethodGet, "/v1/models/"},
		{http.MethodHead, "/v1/models"},
		{http.MethodPost, "/v1/chat/completions"},
		{http.MethodPost, "/v1/chat/completions/"},
		{http.MethodPost, "/v1/completions"},
		{http.MethodPost, "/v1/messages"},
		{http.MethodPost, "/v1/responses"},
		{http.MethodPost, "/v1/responses/compact"},
		{http.MethodPost, "/v1/embeddings"},
		{http.MethodPost, "/v1/images/generations"},
		{http.MethodPost, "/v1/images/edits"},
		{http.MethodPost, "/v1/audio/transcriptions"},
		{http.MethodPost, "/v1/audio/translations"},
		{http.MethodPost, "/v1/audio/speech"},
		{http.MethodPost, "/v1/rerank"},
		{http.MethodPost, "/v1/moderations"},
		{http.MethodPost, "/v1/engines/gemini-pro/embeddings"},
	}
	for _, c := range allowed {
		if !IsAllowedEndpoint(c.method, c.path) {
			t.Errorf("%s %s 应被允许", c.method, c.path)
		}
	}

	denied := []struct{ method, path string }{
		{http.MethodDelete, "/v1/files/file-1"},
		{http.MethodGet, "/v1/files"},
		{http.MethodPost, "/v1/files"},
		{http.MethodGet, "/v1/files/file-1"},
		{http.MethodGet, "/v1/files/file-1/content"},
		{http.MethodPost, "/v1/fine_tuning/jobs"},
		{http.MethodGet, "/v1/fine_tuning/jobs"},
		{http.MethodPost, "/v1/fine-tunes"},
		{http.MethodPost, "/v1/batches"},
		{http.MethodPost, "/v1/vector_stores"},
		{http.MethodPost, "/v1/assistants"},
		{http.MethodPut, "/v1/chat/completions"},
		{http.MethodDelete, "/v1/chat/completions"},
		{http.MethodGet, "/v1/chat/completions"},
		{http.MethodPost, "/v1/models"},
		{http.MethodDelete, "/v1/models/gpt-4"},
		{http.MethodGet, "/v1/unknown"},
	}
	for _, c := range denied {
		if IsAllowedEndpoint(c.method, c.path) {
			t.Errorf("%s %s 应被拒绝", c.method, c.path)
		}
	}
}

func seedSingleRoute(t *testing.T, st *store.Store, channelID, baseURL string, timeout int) {
	t.Helper()
	now := time.Now().UnixMilli()
	if err := st.SaveChannel(store.Channel{
		ID: channelID, Name: channelID, Type: store.ChannelOpenAI,
		BaseURL: baseURL, Models: []string{"m"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "m", Type: store.ModelTypeCustom, Timeout: timeout,
		Routes:  []store.Route{{ChannelID: channelID, Upstream: "m"}},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
}

// 流式只约束首字：首块数据到达后，总时长可以超过超时时间。
func TestStreamTimeoutStopsAfterFirstChunk(t *testing.T) {
	st := newTestStore(t)

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, `data: {"choices":[{"delta":{"content":"a"}}]}`+"\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-time.After(1500 * time.Millisecond):
		case <-r.Context().Done():
			return
		}
		io.WriteString(w, `data: {"choices":[{"delta":{"content":"b"},"finish_reason":"stop"}]}`+"\n\n")
		io.WriteString(w, "data: [DONE]\n\n")
		w.(http.Flusher).Flush()
	}))
	defer up.Close()

	seedSingleRoute(t, st, "stream-slow", up.URL, 1)

	req := &Request{
		Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{}, Body: []byte(`{"model":"m","stream":true,"messages":[]}`), Stream: true,
		JSON: map[string]any{"model": "m", "stream": true},
	}
	res := New(st).Do(context.Background(), httptest.NewRecorder(), req)
	if res.Err != "" {
		t.Fatalf("首字到达后不应再受超时限制: %+v", res)
	}
	if res.Canceled {
		t.Fatalf("不应记为客户端断开: %+v", res)
	}
}

// 流式在首块数据到达前超时，照常记为上游超时。
func TestStreamTimeoutBeforeFirstChunk(t *testing.T) {
	st := newTestStore(t)

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		select {
		case <-time.After(1500 * time.Millisecond):
		case <-r.Context().Done():
			return
		}
		io.WriteString(w, `data: {"choices":[{"delta":{"content":"late"}}]}`+"\n\n")
		w.(http.Flusher).Flush()
	}))
	defer up.Close()

	seedSingleRoute(t, st, "stream-silent", up.URL, 1)

	req := &Request{
		Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{}, Body: []byte(`{"model":"m","stream":true,"messages":[]}`), Stream: true,
		JSON: map[string]any{"model": "m", "stream": true},
	}
	res := New(st).Do(context.Background(), httptest.NewRecorder(), req)
	if res.Err != "上游响应超时" {
		t.Fatalf("首字超时应记为上游超时: %+v", res)
	}
	if res.Canceled {
		t.Fatalf("不应记为客户端断开: %+v", res)
	}
}

// 非流式的超时覆盖整次请求，包括等响应头和读完响应体。
func TestNonStreamTimeoutCoversWholeRequest(t *testing.T) {
	st := newTestStore(t)

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(1500 * time.Millisecond):
		case <-r.Context().Done():
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"ok","usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	defer up.Close()

	seedSingleRoute(t, st, "plain-slow", up.URL, 1)

	req := &Request{
		Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{}, Body: []byte(`{"model":"m","messages":[]}`),
		JSON: map[string]any{"model": "m"},
	}
	res := New(st).Do(context.Background(), httptest.NewRecorder(), req)
	if res.Err != "上游响应超时" {
		t.Fatalf("非流式整次请求超时应记为上游超时: %+v", res)
	}
	if res.StatusCode != http.StatusBadGateway {
		t.Fatalf("状态码应为 502，得到 %d", res.StatusCode)
	}
}

// 多渠道 Key：前两个 Key 返回 401 时应继续换 Key，直到第三个成功。
func TestMultiKeyRetriesWithinChannel(t *testing.T) {
	ClearChannelKeyState("mk")
	defer ClearChannelKeyState("mk")

	var mu sync.Mutex
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		mu.Lock()
		seen = append(seen, key)
		mu.Unlock()
		if key != "good-key-00003" {
			w.WriteHeader(http.StatusUnauthorized)
			io.WriteString(w, `{"error":{"message":"invalid key"}}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"ok","usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	defer srv.Close()

	st := newTestStore(t)
	now := time.Now().UnixMilli()
	ch := store.Channel{
		ID: "mk", Type: store.ChannelOpenAI, BaseURL: srv.URL,
		APIKeys: []store.ChannelKey{
			{Key: "bad-key-000001", Note: "失效账号"},
			{Key: "bad-key-000002"},
			{Key: "good-key-00003", Note: "可用账号"},
		},
		KeyMode: store.KeyModeSequential, KeyAffinity: true, KeyCooldownSec: 300,
		Models: []string{"m"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}
	if err := st.SaveChannel(ch); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "mk/m", Type: store.ModelTypeChannel, ChannelID: "mk", Upstream: "m",
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	body := []byte(`{"model":"mk/m","messages":[{"role":"user","content":"hi"}]}`)
	req := &Request{
		Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{}, Body: body,
		JSON: map[string]any{"model": "mk/m"},
	}
	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("第三个 Key 应成功，实际 %d: %s", rec.Code, rec.Body.String())
	}
	want := []string{"bad-key-000001", "bad-key-000002", "good-key-00003"}
	if len(seen) != len(want) {
		t.Fatalf("上游收到的 Key 次数错误: %v", seen)
	}
	for i := range want {
		if seen[i] != want[i] {
			t.Errorf("第 %d 次应使用 %q，得到 %q", i+1, want[i], seen[i])
		}
	}
	if len(res.Attempts) != 3 {
		t.Fatalf("应记录 3 次 Key 尝试，得到 %d", len(res.Attempts))
	}
	for i, a := range res.Attempts {
		if a.KeyIndex != i+1 || a.KeyMasked == "" {
			t.Errorf("第 %d 次尝试的 Key 信息错误: %+v", i+1, a)
		}
	}
	if res.Attempts[0].KeyNote != "失效账号" {
		t.Errorf("第一次尝试应记录 Key 备注，得到 %q", res.Attempts[0].KeyNote)
	}
	if res.Attempts[1].KeyNote != "" {
		t.Errorf("无备注的 Key 不应凭空产生备注，得到 %q", res.Attempts[1].KeyNote)
	}
	if res.KeyIndex != 3 || res.KeyMasked != "good****0003" || res.KeyNote != "可用账号" {
		t.Errorf("最终 Key 信息错误: #%d %q %q", res.KeyIndex, res.KeyMasked, res.KeyNote)
	}

	// 失败的两个 Key 进入冷却，下次只调度可用的那个。
	keys, reason := PlanKeys(ch)
	if reason != "" || len(keys) != 1 || keys[0].key != "good-key-00003" {
		t.Fatalf("失败 Key 应被冷却跳过，得到 %+v（%s）", keys, reason)
	}
}

// Key 全部冷却时开启自动重置：清空冷却后按原调度规则返回全部 Key。
func TestPlanKeysCooldownReset(t *testing.T) {
	const chID = "plan-reset"
	ClearChannelKeyState(chID)
	defer ClearChannelKeyState(chID)

	ch := store.Channel{
		ID: chID,
		APIKeys: []store.ChannelKey{
			{Key: "k1-12345678", Note: "一号"},
			{Key: "k2-12345678", Note: "二号"},
		},
		KeyMode: store.KeyModeSequential,
	}
	MarkKeyFailure(chID, "k1-12345678")
	MarkKeyFailure(chID, "k2-12345678")
	if keys, reason := PlanKeys(ch); len(keys) != 0 || reason == "" {
		t.Fatalf("未开启自动重置时全部冷却应不可用，得到 %+v（%q）", keys, reason)
	}

	ch.KeyCooldownReset = true
	keys, reason := PlanKeys(ch)
	if reason != "" || len(keys) != 2 || keys[0].index != 1 || keys[1].index != 2 {
		t.Fatalf("开启自动重置后应清空冷却并返回全部 Key，得到 %v（%q）", candidateIndexes(keys), reason)
	}
	if keys[0].note != "一号" || keys[1].note != "二号" {
		t.Fatalf("Key 备注未带入调度，得到 %+v", keys)
	}

	// 冷却已被清空：即使关掉开关，下一次调度也应正常可用。
	ch.KeyCooldownReset = false
	if keys, reason := PlanKeys(ch); reason != "" || len(keys) != 2 {
		t.Fatalf("自动重置应真正清掉冷却状态，得到 %v（%q）", candidateIndexes(keys), reason)
	}
}

// 全部 Key 冷却时请求不会打到上游，但日志仍要保留已经命中的渠道。
func TestAllKeysCoolingKeepsChannelInfo(t *testing.T) {
	const chID = "cool-all"
	ClearChannelKeyState(chID)
	defer ClearChannelKeyState(chID)

	st := newTestStore(t)
	now := time.Now().UnixMilli()
	if err := st.SaveChannel(store.Channel{
		ID: chID, Name: "冷却线路", Type: store.ChannelOpenAI,
		BaseURL:        "http://127.0.0.1:1",
		APIKeys:        []store.ChannelKey{{Key: "k1-12345678"}, {Key: "k2-12345678"}},
		KeyCooldownSec: 300, Models: []string{"m"},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: chID + "/m", Type: store.ModelTypeChannel, ChannelID: chID, Upstream: "m",
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	MarkKeyFailure(chID, "k1-12345678")
	MarkKeyFailure(chID, "k2-12345678")

	req := &Request{
		Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{}, Body: []byte(`{"model":"` + chID + `/m","messages":[]}`),
		JSON: map[string]any{"model": chID + "/m"},
	}
	res := New(st).Do(context.Background(), httptest.NewRecorder(), req)
	if res.Err != "所有 Key 都在失败冷却中" {
		t.Fatalf("错误原因不正确: %+v", res)
	}
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("状态码应为 503，得到 %d", res.StatusCode)
	}
	if res.ChannelID != chID || res.ChannelName != "冷却线路" || res.UpstreamModel != "m" {
		t.Fatalf("全部 Key 冷却时仍应记录命中的渠道: %+v", res)
	}
	if res.KeyMasked != "" || res.Retries != 0 {
		t.Fatalf("没有实际尝试时不应记录 Key 或重试次数: %+v", res)
	}
}

// Key 调度：冷却跳过、亲和从成功位置顺延、全部冷却时返回不可用原因。
func TestPlanKeysCooldownAffinityAndRandom(t *testing.T) {
	const chID = "plan-keys"
	ClearChannelKeyState(chID)
	defer ClearChannelKeyState(chID)

	ch := store.Channel{
		ID: chID,
		APIKeys: []store.ChannelKey{
			{Key: "key-one-12345678"}, {Key: "key-two-12345678"}, {Key: "key-three-12345678"},
		},
		KeyMode:     store.KeyModeSequential,
		KeyAffinity: true,
	}
	MarkKeyFailure(chID, "key-one-12345678")
	keys, reason := PlanKeys(ch)
	if reason != "" || len(keys) != 2 || keys[0].key != "key-two-12345678" {
		t.Fatalf("顺序模式应跳过冷却中的 Key，得到 %+v（%s）", keys, reason)
	}

	MarkKeySuccess(chID, "key-three-12345678")
	keys, _ = PlanKeys(ch)
	if len(keys) != 2 || keys[0].key != "key-three-12345678" {
		t.Fatalf("亲和应从上次成功的 Key 位置开始，得到 %+v", keys)
	}

	ch.KeyAffinity = false
	ch.KeyMode = store.KeyModeRandom
	keys, _ = PlanKeys(ch)
	if len(keys) != 2 {
		t.Fatalf("随机模式仍应包含全部可用 Key，得到 %+v", keys)
	}
	got := map[string]bool{keys[0].key: true, keys[1].key: true}
	if !got["key-two-12345678"] || !got["key-three-12345678"] {
		t.Fatalf("随机模式的候选集合错误: %+v", keys)
	}

	MarkKeyFailure(chID, "key-two-12345678")
	MarkKeyFailure(chID, "key-three-12345678")
	if keys, reason := PlanKeys(ch); len(keys) != 0 || reason == "" {
		t.Fatalf("全部 Key 冷却时应返回不可用原因，得到 %+v（%q）", keys, reason)
	}
}

func candidateIndexes(keys []keyCandidate) []int {
	out := make([]int, len(keys))
	for i, k := range keys {
		out[i] = k.index
	}
	return out
}

// Key 调度：顺序 + 亲和从上次成功 Key 的配置位置开始，按原有顺序环形顺延，
// 而不是把它搬到首位后让其余 Key 从第一个重来。
func TestPlanKeysSequentialAffinityStartsAtPosition(t *testing.T) {
	const chID = "plan-seq-affinity"
	ClearChannelKeyState(chID)
	defer ClearChannelKeyState(chID)

	ch := store.Channel{
		ID: chID,
		APIKeys: []store.ChannelKey{
			{Key: "k1-12345678"}, {Key: "k2-12345678"}, {Key: "k3-12345678"}, {Key: "k4-12345678"},
		},
		KeyMode:     store.KeyModeSequential,
		KeyAffinity: true,
	}

	MarkKeySuccess(chID, "k2-12345678")
	plan := mustPlan(t, ch)
	if got := candidateIndexes(plan); !slices.Equal(got, []int{2, 3, 4, 1}) {
		t.Fatalf("亲和键在第 2 位时应得到 2,3,4,1，实际 %v", got)
	}
	if !plan[0].affinity {
		t.Fatal("亲和键应标记 affinity")
	}
	for _, k := range plan[1:] {
		if k.affinity {
			t.Fatalf("非亲和键不应标记 affinity: %v", candidateIndexes(plan))
		}
	}

	MarkKeySuccess(chID, "k4-12345678")
	plan = mustPlan(t, ch)
	if got := candidateIndexes(plan); !slices.Equal(got, []int{4, 1, 2, 3}) {
		t.Fatalf("亲和键在第 4 位时应得到 4,1,2,3，实际 %v", got)
	}
	if !plan[0].affinity || plan[0].index != 4 {
		t.Fatalf("首位应是标记 affinity 的 4 号 Key: %+v", plan)
	}

	// 冷却中的 Key 直接跳过，其余 Key 仍保持配置顺序。
	MarkKeyFailure(chID, "k1-12345678")
	plan = mustPlan(t, ch)
	if got := candidateIndexes(plan); !slices.Equal(got, []int{4, 2, 3}) {
		t.Fatalf("跳过冷却 Key 后应得到 4,2,3，实际 %v", got)
	}
	if !plan[0].affinity {
		t.Fatal("冷却跳过其它 Key 后，亲和键仍应标记 affinity")
	}

	// 亲和键自身冷却时无法定位，退回从第一个可用 Key 开始。
	MarkKeyFailure(chID, "k4-12345678")
	plan = mustPlan(t, ch)
	if got := candidateIndexes(plan); !slices.Equal(got, []int{2, 3}) {
		t.Fatalf("亲和键冷却时应得到 2,3，实际 %v", got)
	}
	for _, k := range plan {
		if k.affinity {
			t.Fatalf("亲和键不在可用列表里时不应标记 affinity: %v", candidateIndexes(plan))
		}
	}

	// 关闭亲和后恢复纯配置顺序。
	ch.KeyAffinity = false
	if got := candidateIndexes(mustPlan(t, ch)); !slices.Equal(got, []int{2, 3}) {
		t.Fatalf("关闭亲和后应得到 2,3，实际 %v", got)
	}
	plan = mustPlan(t, ch)
	for _, k := range plan {
		if k.affinity {
			t.Fatalf("关闭亲和后不应标记 affinity: %v", candidateIndexes(plan))
		}
	}
}

// Key 调度：随机模式每次完整洗牌，4 个 Key 的 24 种排列都会出现，
// 而不是只在配置顺序上循环挪动起点（那样只有 4 种）。
func TestPlanKeysRandomShufflesWholeChain(t *testing.T) {
	const chID = "plan-random-shuffle"
	ClearChannelKeyState(chID)
	defer ClearChannelKeyState(chID)

	ch := store.Channel{
		ID: chID,
		APIKeys: []store.ChannelKey{
			{Key: "k1-12345678"}, {Key: "k2-12345678"}, {Key: "k3-12345678"}, {Key: "k4-12345678"},
		},
		KeyMode: store.KeyModeRandom,
	}

	const rounds = 5000
	chains := map[string]bool{}
	first := map[int]int{}
	for i := 0; i < rounds; i++ {
		keys, reason := PlanKeys(ch)
		if reason != "" || len(keys) != 4 {
			t.Fatalf("随机模式应返回全部 4 个 Key，得到 %v（%s）", candidateIndexes(keys), reason)
		}
		chains[fmt.Sprint(candidateIndexes(keys))] = true
		first[keys[0].index]++
	}
	if len(chains) != 24 {
		t.Fatalf("完整洗牌应出现 24 种排列，实际 %d 种: %v", len(chains), chains)
	}
	for i := 1; i <= 4; i++ {
		if first[i] < rounds/4*8/10 || first[i] > rounds/4*12/10 {
			t.Errorf("首个 Key 分布不均: %v", first)
		}
	}
}

// Key 调度：随机 + 亲和时亲和键固定首位，其余 Key 完整洗牌。
func TestPlanKeysRandomAffinityPinsFirstKey(t *testing.T) {
	const chID = "plan-random-affinity"
	ClearChannelKeyState(chID)
	defer ClearChannelKeyState(chID)

	ch := store.Channel{
		ID: chID,
		APIKeys: []store.ChannelKey{
			{Key: "k1-12345678"}, {Key: "k2-12345678"}, {Key: "k3-12345678"}, {Key: "k4-12345678"},
		},
		KeyMode:     store.KeyModeRandom,
		KeyAffinity: true,
	}
	MarkKeySuccess(chID, "k2-12345678")

	rest := map[string]bool{}
	for i := 0; i < 2000; i++ {
		keys, _ := PlanKeys(ch)
		if keys[0].index != 2 {
			t.Fatalf("亲和键应固定在首位，得到 %v", candidateIndexes(keys))
		}
		if !keys[0].affinity {
			t.Fatal("首位的亲和键应标记 affinity")
		}
		for _, k := range keys[1:] {
			if k.affinity {
				t.Fatalf("其余 Key 不应标记 affinity: %v", candidateIndexes(keys))
			}
		}
		rest[fmt.Sprint(candidateIndexes(keys[1:]))] = true
	}
	if len(rest) != 6 {
		t.Fatalf("其余 3 个 Key 应完整洗牌（6 种排列），实际 %d 种: %v", len(rest), rest)
	}

	// 亲和键冷却后无法再定位，其余 Key 正常洗牌。
	MarkKeyFailure(chID, "k2-12345678")
	for i := 0; i < 50; i++ {
		keys, reason := PlanKeys(ch)
		if reason != "" || len(keys) != 3 {
			t.Fatalf("冷却 Key 应被跳过，得到 %v（%s）", candidateIndexes(keys), reason)
		}
		for _, k := range keys {
			if k.index == 2 {
				t.Fatalf("冷却中的亲和键不应出现，得到 %v", candidateIndexes(keys))
			}
		}
	}
}

func mustPlan(t *testing.T, ch store.Channel) []keyCandidate {
	t.Helper()
	keys, reason := PlanKeys(ch)
	if reason != "" {
		t.Fatalf("PlanKeys 不应返回不可用原因: %s", reason)
	}
	return keys
}

// 多 Key 渠道的备注只用于展示，不能进入认证头。
func TestKeyNoteNotSentUpstream(t *testing.T) {
	ClearChannelKeyState("note")
	defer ClearChannelKeyState("note")

	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	defer srv.Close()

	st := newTestStore(t)
	now := time.Now().UnixMilli()
	if err := st.SaveChannel(store.Channel{
		ID: "note", Type: store.ChannelOpenAI, BaseURL: srv.URL,
		APIKeys: []store.ChannelKey{{Key: "sk-note-key-12345678", Note: "主账号"}},
		Models:  []string{"m"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "note/m", Type: store.ModelTypeChannel, ChannelID: "note", Upstream: "m",
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	body := []byte(`{"model":"note/m","messages":[{"role":"user","content":"hi"}]}`)
	req := &Request{Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{}, Body: body, JSON: map[string]any{"model": "note/m"}}
	rec := httptest.NewRecorder()
	New(st).Do(context.Background(), rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("请求应成功，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if got != "Bearer sk-note-key-12345678" {
		t.Errorf("认证头不应包含备注，得到 %q", got)
	}
}

// Key 亲和命中要落到日志字段：亲和 Key 成功时最终日志标记 KeyAffinity；
// 亲和 Key 失败并换到其它 Key 后，最终标记跟着最终 Key 走，
// 而失败的那次尝试仍在重试明细里保留 KeyAffinity，方便还原调度过程。
func TestKeyAffinityRecordedInResult(t *testing.T) {
	const chID = "relay-key-affinity"
	ClearChannelKeyState(chID)
	defer ClearChannelKeyState(chID)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer sk-first-12345678" {
			w.WriteHeader(http.StatusInternalServerError)
			io.WriteString(w, `{"error":{"message":"boom"}}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	defer srv.Close()

	st := newTestStore(t)
	now := time.Now().UnixMilli()
	if err := st.SaveChannel(store.Channel{
		ID: chID, Type: store.ChannelOpenAI, BaseURL: srv.URL,
		APIKeys: []store.ChannelKey{
			{Key: "sk-first-12345678", Note: "主账号"},
			{Key: "sk-second-12345678", Note: "备用账号"},
		},
		KeyMode: store.KeyModeSequential, KeyAffinity: true,
		Models: []string{"m"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: chID + "/m", Type: store.ModelTypeChannel, ChannelID: chID, Upstream: "m",
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	body := []byte(`{"model":"` + chID + `/m","messages":[{"role":"user","content":"hi"}]}`)
	do := func() *Result {
		t.Helper()
		req := &Request{Path: "/v1/chat/completions", Method: http.MethodPost,
			Header: http.Header{}, Body: body, JSON: map[string]any{"model": chID + "/m"}}
		rec := httptest.NewRecorder()
		res := New(st).Do(context.Background(), rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("请求应成功，实际 %d: %s", rec.Code, rec.Body.String())
		}
		return res
	}

	// 上次成功的是第一个 Key；它这次失败，换到第二个 Key。
	MarkKeySuccess(chID, "sk-first-12345678")
	res := do()
	if res.Retries != 1 || len(res.Attempts) != 2 {
		t.Fatalf("应记录 2 次尝试，得到 retries=%d attempts=%d", res.Retries, len(res.Attempts))
	}
	if !res.Attempts[0].KeyAffinity {
		t.Error("亲和 Key 的失败尝试应标记 KeyAffinity")
	}
	if res.Attempts[1].KeyAffinity {
		t.Error("换用的非亲和 Key 不应标记 KeyAffinity")
	}
	if res.KeyAffinity {
		t.Error("最终使用的是非亲和 Key，顶层不应标记 KeyAffinity")
	}
	if res.KeyNote != "备用账号" {
		t.Errorf("最终 Key 应是备用账号，得到 %q", res.KeyNote)
	}

	// 换成第二个 Key 亲和，且它这次成功：顶层应标记 KeyAffinity。
	ClearChannelKeyState(chID)
	MarkKeySuccess(chID, "sk-second-12345678")
	res = do()
	if len(res.Attempts) != 0 {
		t.Fatalf("没有重试时不应记录尝试明细，得到 %d 条", len(res.Attempts))
	}
	if !res.KeyAffinity {
		t.Error("亲和 Key 成功时应标记 KeyAffinity")
	}
	if res.KeyNote != "备用账号" {
		t.Errorf("最终 Key 应是备用账号，得到 %q", res.KeyNote)
	}
}
