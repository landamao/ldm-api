package relay

import (
	"testing"
	"time"
)

// resetAffinityState 把全局运行时状态清干净，避免用例之间互相影响。
func resetAffinityState() {
	routeStates.Lock()
	clear(routeStates.failedAt)
	clear(routeStates.lastRoute)
	routeStates.Unlock()

	keyStates.Lock()
	clear(keyStates.failedAt)
	clear(keyStates.lastKey)
	keyStates.Unlock()
}

// 手动清理只清亲和，不能顺手把失败冷却也清掉。
func TestClearAffinityKeepsCooldowns(t *testing.T) {	resetAffinityState()
	t.Cleanup(resetAffinityState)

	MarkSuccess("m1", "ch1", "up1")
	MarkSuccess("m2", "ch2", "up2")
	MarkKeySuccess("ch1", "sk-a")
	MarkKeySuccess("ch2", "sk-b")
	MarkFailure("ch1", "up9")
	MarkKeyFailure("ch3", "sk-c")

	if m, c := AffinityCount(); m != 2 || c != 2 {
		t.Fatalf("亲和计数应为模型 2 / 渠道 2，实际 %d / %d", m, c)
	}

	// 只清模型：渠道亲和与所有冷却都保留。
	res := ClearAffinity(false, true)
	if res.Affinity != 2 || res.Cleared != 0 {
		t.Fatalf("只清模型应清 2 条亲和、0 条冷却，实际 %+v", res)
	}
	if m, c := AffinityCount(); m != 0 || c != 2 {
		t.Fatalf("清完模型后应为 0 / 2，实际 %d / %d", m, c)
	}
	routeStates.Lock()
	_, routeCooling := routeStates.failedAt[routeKey("ch1", "up9")]
	routeStates.Unlock()
	if !routeCooling {
		t.Error("路由冷却不应被亲和清理带走")
	}
	keyStates.Lock()
	_, keyCooling := keyStates.failedAt[keyStateID("ch3", "sk-c")]
	keyStates.Unlock()
	if !keyCooling {
		t.Error("Key 冷却不应被亲和清理带走")
	}

	// 再清渠道：两条渠道亲和一起清掉。
	res = ClearAffinity(true, false)
	if res.Affinity != 2 {
		t.Fatalf("渠道亲和应清 2 条，实际 %+v", res)
	}
	if m, c := AffinityCount(); m != 0 || c != 0 {
		t.Fatalf("清完后应没有亲和，实际 %d / %d", m, c)
	}
}

// 空闲清理只删超过阈值的条目：刚用过的不动，闲置的才清，冷却不受影响。
func TestClearIdleAffinity(t *testing.T) {
	resetAffinityState()
	t.Cleanup(resetAffinityState)

	MarkSuccess("idle-m", "ch1", "up1")
	MarkSuccess("busy-m", "ch2", "up2")
	MarkKeySuccess("ch1", "sk-a")
	MarkKeySuccess("ch2", "sk-b")
	MarkFailure("ch1", "up1")

	// 把 idle-m 与 ch1 的 Key 亲和拨到两小时前，其余保持刚写入。
	routeStates.Lock()
	a := routeStates.lastRoute["idle-m"]
	a.usedAt = time.Now().Add(-2 * time.Hour)
	routeStates.lastRoute["idle-m"] = a
	routeStates.Unlock()

	keyStates.Lock()
	k := keyStates.lastKey["ch1"]
	k.usedAt = time.Now().Add(-2 * time.Hour)
	keyStates.lastKey["ch1"] = k
	keyStates.Unlock()

	// 阈值 1 小时：只清两条过期的，刚写入的两条保留。
	res := ClearIdleAffinity(true, true, time.Hour)
	if res.Affinity != 2 || res.Cleared != 0 {
		t.Fatalf("应清掉 2 条空闲亲和、0 条冷却，实际 %+v", res)
	}
	if m, c := AffinityCount(); m != 1 || c != 1 {
		t.Fatalf("应保留刚写入的 1 模型 / 1 渠道亲和，实际 %d / %d", m, c)
	}
	routeStates.Lock()
	_, hasBusy := routeStates.lastRoute["busy-m"]
	_, stillCooling := routeStates.failedAt[routeKey("ch1", "up1")]
	routeStates.Unlock()
	if !hasBusy {
		t.Error("未到空闲阈值的模型亲和不该被清")
	}
	if !stillCooling {
		t.Error("空闲清理不应带走失败冷却")
	}

	// 只清模型时不碰渠道亲和。
	MarkKeySuccess("ch3", "sk-c")
	if res := ClearIdleAffinity(false, true, time.Hour); res.Affinity != 0 {
		t.Fatalf("模型亲和都还没到阈值，实际清了 %d 条", res.Affinity)
	}
	if _, c := AffinityCount(); c < 1 {
		t.Fatalf("渠道亲和应保留，实际 %d 条", c)
	}

	// 阈值非正时不做任何清理，避免配置异常导致一次性全清。
	if res := ClearIdleAffinity(true, true, 0); res.Affinity != 0 {
		t.Fatalf("阈值为 0 时不应清理，实际清了 %d 条", res.Affinity)
	}
	if m, c := AffinityCount(); m+c == 0 {
		t.Error("阈值为 0 时应原样保留亲和")
	}
}

// 一次成功命中会刷新空闲时刻，正在用的模型不会被空闲清理误清。
func TestMarkSuccessRefreshesAffinityIdle(t *testing.T) {
	resetAffinityState()
	t.Cleanup(resetAffinityState)

	MarkSuccess("m1", "ch1", "up1")
	routeStates.Lock()
	a := routeStates.lastRoute["m1"]
	a.usedAt = time.Now().Add(-2 * time.Hour)
	routeStates.lastRoute["m1"] = a
	routeStates.Unlock()

	// 再次命中同一条路由：时刻刷新到当前，清理阈值 1 小时不该清掉它。
	MarkSuccess("m1", "ch1", "up1")
	if res := ClearIdleAffinity(false, true, time.Hour); res.Affinity != 0 {
		t.Fatalf("成功命中后应刷新空闲时刻，实际清了 %d 条", res.Affinity)
	}
	if m, _ := AffinityCount(); m != 1 {
		t.Fatalf("亲和应保留，实际模型 %d 条", m)
	}
}
