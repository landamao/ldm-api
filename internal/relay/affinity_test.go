package relay

import "testing"

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

// 定时清理只清亲和，不能顺手把失败冷却也清掉。
func TestClearAffinityKeepsCooldowns(t *testing.T) {
	resetAffinityState()
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
