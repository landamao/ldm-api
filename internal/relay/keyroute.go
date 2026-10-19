package relay

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"sync"
	"time"

	"ldmapi/internal/store"
)

// 渠道多 Key 调度：按配置顺序或随机选起始 Key，支持 Key 亲和与失败冷却。
// 冷却状态按「渠道 ID + Key 指纹」记录，指纹只用于内存索引，不保存明文。

const (
	defaultKeyCooldownSec = 300
	maxKeyCooldownSec     = 86400
)

// keyCandidate 是一次 Key 调度里的候选项。
type keyCandidate struct {
	key    string
	index  int // 从 1 开始的配置顺序，用于日志定位
	masked string
	note   string
	// affinity 表示这个 Key 是上次成功的 Key、本次因 Key 亲和被优先尝试。
	affinity bool
}

var keyStates = struct {
	sync.Mutex
	failedAt map[string]time.Time // 渠道ID + Key 指纹 -> 最近一次失败时刻
	lastKey  map[string]string    // 渠道ID -> 上次成功使用的 Key 指纹（亲和）
}{
	failedAt: map[string]time.Time{},
	lastKey:  map[string]string{},
}

// keyFingerprint 返回 Key 的短指纹，避免把明文 Key 当作内存索引。
func keyFingerprint(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:8])
}

func keyStateID(channelID, key string) string {
	return channelID + "\x00" + keyFingerprint(key)
}

// MaskKey 把上游 Key 脱敏成首尾各留 4 位的展示形式。
// 后台响应和日志都用它，确保同一条 Key 在各处显示一致。
func MaskKey(k string) string {
	if k == "" {
		return ""
	}
	if len(k) <= 8 {
		return "****"
	}
	return k[:4] + "****" + k[len(k)-4:]
}

// PlanKeys 生成一次渠道请求的 Key 尝试链。
// 返回 nil 表示所有 Key 都在失败冷却中，reason 给出原因。
//
// 规则：
//  1. 跳过冷却中的 Key；冷却时长取渠道当前配置，修改后立即生效。
//  2. 顺序模式按配置顺序尝试；随机模式每次把可用 Key 完整洗牌后依次尝试。
//  3. 开启 Key 亲和且上次成功的 Key 可用时：
//     顺序模式从它在配置里的位置开始顺延，其余 Key 的相对顺序不变；
//     随机模式先试它，其余 Key 洗牌后顺延。
func PlanKeys(ch store.Channel) ([]keyCandidate, string) {
	list := ch.KeyList()
	// 没有配置 Key：保持旧行为（不带认证头），也不做冷却记录。
	if len(list) == 0 {
		return []keyCandidate{{key: "", index: 1}}, ""
	}

	cooldown := time.Duration(ch.KeyCooldownSec) * time.Second
	if cooldown <= 0 {
		cooldown = defaultKeyCooldownSec * time.Second
	}
	now := time.Now()

	all := make([]keyCandidate, 0, len(list))
	for i, item := range list {
		all = append(all, keyCandidate{key: item.Key, index: i + 1, masked: MaskKey(item.Key), note: item.Note})
	}

	live := make([]keyCandidate, 0, len(all))
	keyStates.Lock()
	for _, c := range all {
		id := keyStateID(ch.ID, c.key)
		if failedAt, failed := keyStates.failedAt[id]; failed {
			elapsed := now.Sub(failedAt)
			if elapsed < cooldown {
				continue
			}
			if elapsed >= time.Duration(maxKeyCooldownSec)*time.Second {
				delete(keyStates.failedAt, id)
			}
		}
		live = append(live, c)
	}
	if len(live) == 0 && ch.KeyCooldownReset {
		// 全部 Key 都在冷却中：按渠道配置自动清空该渠道的 Key 冷却，再按正常规则调度。
		for _, c := range all {
			delete(keyStates.failedAt, keyStateID(ch.ID, c.key))
		}
		live = all
	}
	last := keyStates.lastKey[ch.ID]
	keyStates.Unlock()

	if len(live) == 0 {
		return nil, "所有 Key 都在失败冷却中"
	}

	chain := make([]keyCandidate, 0, len(live))
	// 亲和键在当前可用列表里的位置；不在列表里（冷却中或已删除）时不启用亲和。
	affinityAt := -1
	if ch.KeyAffinity && last != "" {
		for i, c := range live {
			if keyFingerprint(c.key) == last {
				affinityAt = i
				break
			}
		}
	}

	if ch.KeyModeOrDefault() == store.KeyModeRandom {
		if affinityAt >= 0 {
			// 亲和键固定先试，其余 Key 完整洗牌后顺延。
			live[affinityAt].affinity = true
			chain = append(chain, live[affinityAt])
			rest := make([]keyCandidate, 0, len(live)-1)
			rest = append(rest, live[:affinityAt]...)
			rest = append(rest, live[affinityAt+1:]...)
			shuffleCandidates(rest)
			chain = append(chain, rest...)
		} else {
			chain = append(chain, live...)
			shuffleCandidates(chain)
		}
	} else if affinityAt > 0 {
		// 从亲和键的配置位置开始环形顺延，其余 Key 保持原有相对顺序。
		live[affinityAt].affinity = true
		chain = append(chain, live[affinityAt:]...)
		chain = append(chain, live[:affinityAt]...)
	} else {
		if affinityAt == 0 {
			// 亲和键本来就在首位，顺序不变，但仍算命中亲和。
			live[0].affinity = true
		}
		chain = append(chain, live...)
	}
	return chain, ""
}

// shuffleCandidates 用 Fisher-Yates 完整打乱候选顺序。
func shuffleCandidates(list []keyCandidate) {
	for i := len(list) - 1; i > 0; i-- {
		j := int(randUint64() % uint64(i+1))
		list[i], list[j] = list[j], list[i]
	}
}

// MarkKeySuccess 记录一次 Key 成功：清掉它的冷却，并记下渠道亲和。
func MarkKeySuccess(channelID, key string) {
	if key == "" {
		return
	}
	id := keyStateID(channelID, key)
	keyStates.Lock()
	delete(keyStates.failedAt, id)
	keyStates.lastKey[channelID] = keyFingerprint(key)
	keyStates.Unlock()
}

// MarkKeyFailure 记录一次 Key 失败时刻，冷却时长在调度时动态计算。
func MarkKeyFailure(channelID, key string) {
	if key == "" {
		return
	}
	keyStates.Lock()
	keyStates.failedAt[keyStateID(channelID, key)] = time.Now()
	keyStates.Unlock()
}

// clearKeyCooldownsForChannel 清掉某个渠道所有 Key 的冷却，返回清除条数。
func clearKeyCooldownsForChannel(channelID string) int {
	prefix := channelID + "\x00"
	keyStates.Lock()
	defer keyStates.Unlock()
	n := 0
	for k := range keyStates.failedAt {
		if strings.HasPrefix(k, prefix) {
			delete(keyStates.failedAt, k)
			n++
		}
	}
	return n
}

// ClearChannelKeyState 删除渠道时清掉它的全部 Key 状态（冷却与亲和）。
func ClearChannelKeyState(channelID string) {
	prefix := channelID + "\x00"
	keyStates.Lock()
	defer keyStates.Unlock()
	for k := range keyStates.failedAt {
		if strings.HasPrefix(k, prefix) {
			delete(keyStates.failedAt, k)
		}
	}
	delete(keyStates.lastKey, channelID)
}

// PruneChannelKeys 在编辑渠道后调用：清掉已从配置里删除的 Key 的冷却与亲和记录，
// 避免以后把同一个 Key 加回来时旧状态「复活」。
func PruneChannelKeys(channelID string, keys []string) {
	validKeys := make(map[string]bool, len(keys))
	validIDs := make(map[string]bool, len(keys))
	for _, k := range keys {
		if k == "" {
			continue
		}
		validKeys[keyFingerprint(k)] = true
		validIDs[keyStateID(channelID, k)] = true
	}
	prefix := channelID + "\x00"
	keyStates.Lock()
	defer keyStates.Unlock()
	if last, ok := keyStates.lastKey[channelID]; ok && !validKeys[last] {
		delete(keyStates.lastKey, channelID)
	}
	for k := range keyStates.failedAt {
		if strings.HasPrefix(k, prefix) && !validIDs[k] {
			delete(keyStates.failedAt, k)
		}
	}
}
