package relay

import (
	"strings"
	"sync"
	"time"

	"ldmapi/internal/store"
)

// 路由调度：按配置顺序切分优先级组，组间顺序故障转移，组内按权重随机抽首选；
// 支持模型亲和（上次成功者下次优先）与失败冷却（冷却期内跳过）。
// 冷却状态按「渠道ID/上游模型」全局共享，但时长取当前请求模型的 CooldownSec，
// 修改配置后对已存在的冷却立即生效。

const defaultCooldownSec = 300

// 冷却时长配置上限（与后台保存时的限制一致）。超过这个时长的失败记录对所有模型
// 都已过期，可以安全清理；不能按当前模型的时长清理，否则短冷却模型会删掉
// 长冷却模型还需要共享的记录。
const maxCooldownSec = 86400

// routeKey 生成一条路由的全局唯一键。
func routeKey(chID, upstream string) string { return chID + "/" + upstream }

// routeStates 记录路由的运行时状态。key 是「渠道ID/上游模型」：
// 同一渠道模型被多个自定义模型引用时共享状态——上游真的挂了，对所有引用它的模型都该冷却。
var routeStates = struct {
	sync.Mutex
	failedAt  map[string]time.Time // 路由 key -> 最近一次失败时刻
	lastRoute map[string]string    // 模型ID -> 上次请求成功走的路由 key（亲和）
}{
	failedAt:  map[string]time.Time{},
	lastRoute: map[string]string{},
}

// MarkSuccess 在一次请求成功后记录：清掉该条目的冷却，并记下模型亲和。
func MarkSuccess(modelID, channelID, upstream string) {
	routeStates.Lock()
	defer routeStates.Unlock()
	k := routeKey(channelID, upstream)
	delete(routeStates.failedAt, k)
	routeStates.lastRoute[modelID] = k
}

// MarkFailure 记录失败时刻。冷却时长不在这里固化：判定时用当前模型配置的
// CooldownSec 计算，这样修改冷却时长对已经处于冷却的条目也能立即生效。
func MarkFailure(channelID, upstream string) {
	markFailureAt(channelID, upstream, time.Now())
}

func markFailureAt(channelID, upstream string, at time.Time) {
	routeStates.Lock()
	defer routeStates.Unlock()
	routeStates.failedAt[routeKey(channelID, upstream)] = at
}

// clearCooldowns 清掉指定渠道模型的冷却（全部冷却且开启重置时用）。
func clearCooldowns(keys []string) {
	routeStates.Lock()
	defer routeStates.Unlock()
	for _, k := range keys {
		delete(routeStates.failedAt, k)
	}
}

// ClearAllCooldowns 清空内存中所有路由的失败冷却，返回被清除的条目数。
func ClearAllCooldowns() int {
	routeStates.Lock()
	defer routeStates.Unlock()
	n := len(routeStates.failedAt)
	clear(routeStates.failedAt)
	return n
}

// ClearCooldownsForModel 清掉该模型路由涉及的失败冷却，返回清除条数。
// 冷却按「渠道ID/上游模型」全局共享，因此会同时解除其他引用同一条路由的模型的冷却。
func ClearCooldownsForModel(m store.Model) int {
	var keys []string
	if m.Type == store.ModelTypeChannel {
		keys = []string{routeKey(m.ChannelID, m.Upstream)}
	} else {
		for _, rt := range m.Routes {
			keys = append(keys, routeKey(rt.ChannelID, rt.Upstream))
		}
	}
	routeStates.Lock()
	defer routeStates.Unlock()
	n := 0
	for _, k := range keys {
		if _, ok := routeStates.failedAt[k]; ok {
			delete(routeStates.failedAt, k)
			n++
		}
	}
	return n
}

// ClearCooldownsForChannel 清掉某个渠道下所有上游模型的冷却，返回清除条数。
func ClearCooldownsForChannel(channelID string) int {
	prefix := channelID + "/"
	routeStates.Lock()
	defer routeStates.Unlock()
	n := 0
	for k := range routeStates.failedAt {
		if strings.HasPrefix(k, prefix) {
			delete(routeStates.failedAt, k)
			n++
		}
	}
	return n
}

// ClearModelRoutes 删除/重命名模型时清理它的亲和记录。
func ClearModelRoutes(modelID string) {
	routeStates.Lock()
	defer routeStates.Unlock()
	delete(routeStates.lastRoute, modelID)
}

// PruneModelRoutes 在编辑模型后调用：亲和记录指向的路由已不在新配置里时清掉记录，
// 避免之后把同一路由加回来时旧亲和“复活”。
func PruneModelRoutes(modelID string, routes []store.Route) {
	routeStates.Lock()
	defer routeStates.Unlock()
	last, ok := routeStates.lastRoute[modelID]
	if !ok {
		return
	}
	for _, rt := range routes {
		if routeKey(rt.ChannelID, rt.Upstream) == last {
			return
		}
	}
	delete(routeStates.lastRoute, modelID)
}

// pickByWeight 按权重加权随机抽一个下标；权重全部非正时等概率。
func pickByWeight(n int, weight func(i int) int) int {
	total := 0
	for i := 0; i < n; i++ {
		if w := weight(i); w > 0 {
			total += w
		}
	}
	if total <= 0 {
		return int(randUint64() % uint64(n))
	}
	r := randUint64() % uint64(total)
	for i := 0; i < n; i++ {
		w := weight(i)
		if w < 0 {
			w = 0
		}
		if r < uint64(w) {
			return i
		}
		r -= uint64(w)
	}
	return n - 1
}

// planCandidate 是一次调度里的一个候选项。
type planCandidate struct {
	cfgIdx  int           // 在 m.Routes 里的下标
	rt      store.Route   // 配置
	ch      store.Channel // 已确认存在且启用的渠道
	cooling bool          // 当前是否在冷却中
}

// PlanRoute 生成一次请求的尝试链。
// channels 是已确认存在的渠道表；enabled 判断渠道是否启用。
// 全部条目都在冷却中且未开重置时返回 nil（调用方给出「不可用」原因）。
//
// 规则：
//  1. 剔除渠道禁用与冷却中的条目；全被冷却时按 CooldownReset 重置所有冷却再来一遍。
//  2. 按配置顺序把连续同 Group 的条目切成优先级组（Group 为 0 的条目每条自成一组），
//     组间按顺序故障转移；组内按权重加权随机抽出首选，其余保持配置顺序在组内顺延。
//  3. 开启亲和且上次成功的条目可用时，把它提到整条链的最前面（无论它属于哪个组）。
func PlanRoute(m store.Model, channels map[string]store.Channel, enabled func(string) bool) []planCandidate {
	if len(m.Routes) == 0 {
		return nil
	}
	cooldown := time.Duration(m.CooldownSec) * time.Second
	if cooldown <= 0 {
		cooldown = defaultCooldownSec * time.Second
	}

	var all, live []planCandidate
	now := time.Now()
	routeStates.Lock()
	for i, rt := range m.Routes {
		ch, ok := channels[rt.ChannelID]
		if !ok || !enabled(rt.ChannelID) {
			continue
		}
		c := planCandidate{cfgIdx: i, rt: rt, ch: ch}
		all = append(all, c)
		k := routeKey(rt.ChannelID, rt.Upstream)
		if failedAt, failed := routeStates.failedAt[k]; failed {
			elapsed := now.Sub(failedAt)
			if elapsed < cooldown {
				c.cooling = true
				continue
			}
			if elapsed >= time.Duration(maxCooldownSec)*time.Second {
				delete(routeStates.failedAt, k)
			}
		}
		live = append(live, c)
	}
	routeStates.Unlock()

	if len(live) == 0 {
		if !m.CooldownReset || len(all) == 0 {
			return nil
		}
		keys := make([]string, 0, len(all))
		for _, c := range all {
			keys = append(keys, routeKey(c.rt.ChannelID, c.rt.Upstream))
		}
		clearCooldowns(keys)
		live = all
	}

	// 连续相同 Group 的切成一组；Group 为 0 的每条独立
	type group struct{ members []planCandidate }
	var groups []group
	for _, c := range live {
		if c.rt.Group == 0 {
			groups = append(groups, group{members: []planCandidate{c}})
			continue
		}
		if n := len(groups); n > 0 && groups[n-1].members[0].rt.Group == c.rt.Group {
			groups[n-1].members = append(groups[n-1].members, c)
		} else {
			groups = append(groups, group{members: []planCandidate{c}})
		}
	}

	// 组内加权随机抽首选，其余作为顺延
	chain := make([]planCandidate, 0, len(live))
	for _, g := range groups {
		ms := g.members
		if len(ms) == 1 {
			chain = append(chain, ms[0])
			continue
		}
		first := pickByWeight(len(ms), func(i int) int { return ms[i].rt.Weight })
		for i := 0; i < len(ms); i++ {
			chain = append(chain, ms[(first+i)%len(ms)])
		}
	}

	// 亲和：上次成功的条目提到链首
	if m.Affinity {
		routeStates.Lock()
		last := routeStates.lastRoute[m.ID]
		routeStates.Unlock()
		if last != "" {
			for i, c := range chain {
				if routeKey(c.rt.ChannelID, c.rt.Upstream) == last {
					chain = append([]planCandidate{c}, append(chain[:i:i], chain[i+1:]...)...)
					break
				}
			}
		}
	}
	return chain
}
