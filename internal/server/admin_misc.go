package server

import (
	"log"
	"net/http"
	"strconv"
	"time"

	"ldmapi/internal/relay"
	"ldmapi/internal/store"
)

// EnsureDefaultToken 在首次启动时生成一个可直接使用的 API 密钥。
// 返回空字符串表示已经存在密钥，无需展示。
func (s *Server) EnsureDefaultToken() (string, error) {
	tokens, err := s.store.ListTokens()
	if err != nil {
		return "", err
	}
	if len(tokens) > 0 {
		return "", nil
	}
	now := time.Now().UnixMilli()
	t := store.Token{
		ID:        randomHex(8),
		Name:      "默认密钥",
		Key:       newAPIKey(),
		Enabled:   true,
		Remark:    "首次启动自动创建",
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := s.store.SaveToken(t); err != nil {
		return "", err
	}
	return t.Key, nil
}

// Cleanup 按设置分别清理过期日志与统计桶。
// 两个保留天数互相独立：日志清理不影响看板，统计清理也不删调用日志。
func (s *Server) Cleanup() {
	st, err := s.store.GetSettings()
	if err != nil {
		return
	}
	now := time.Now()
	if st.LogRetentionDays > 0 {
		cutoff := now.AddDate(0, 0, -st.LogRetentionDays).UnixMilli()
		if n, err := s.store.PurgeLogsBefore(cutoff); err == nil && n > 0 {
			log.Printf("清理过期日志：%d 条（保留 %d 天）", n, st.LogRetentionDays)
		}
	}
	if days := st.StatsRetention(); days > 0 {
		cutoff := now.AddDate(0, 0, -days).UnixMilli()
		if n, err := s.store.PurgeStatsBefore(cutoff); err == nil && n > 0 {
			log.Printf("清理过期统计：%d 个时段（保留 %d 天）", n, days)
		}
	}
}

// affinityCleanupMetaKey 是「上次真正清理到亲和记录」的时刻（毫秒）。
// 放 meta 桶而不是 Settings：定时器只改这一个值，不会和前端保存设置互相覆盖。
const affinityCleanupMetaKey = "affinity_cleanup_at"

// CleanupAffinity 清理空闲超时的亲和记录，返回这次清掉的条数。
// 由 main 每分钟调用一次，不会整批清空：判定依据是每条亲和「最后一次成功使用」
// 的时刻，只有超过设置里空闲时长的条目才会被删，正在用的模型不受影响。
func (s *Server) CleanupAffinity() int {
	st, err := s.store.GetSettings()
	if err != nil || st.AffinityCleanupMinutes <= 0 {
		return 0
	}
	if !st.AffinityCleanChannel && !st.AffinityCleanModel {
		return 0
	}
	idle := time.Duration(st.AffinityCleanupMinutes) * time.Minute
	res := relay.ClearIdleAffinity(st.AffinityCleanChannel, st.AffinityCleanModel, idle)
	if res.Affinity == 0 {
		return 0
	}
	s.setAffinityCleanupAt(time.Now())
	log.Printf("清理空闲亲和：%d 条（空闲超过 %d 分钟）", res.Affinity, st.AffinityCleanupMinutes)
	return res.Affinity
}

// affinityCleanupAt 返回上次真正清理到亲和记录的时刻，没有记录时返回零值。
func (s *Server) affinityCleanupAt() time.Time {
	raw, err := s.store.GetMeta(affinityCleanupMetaKey)
	if err != nil || raw == "" {
		return time.Time{}
	}
	ms, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || ms <= 0 {
		return time.Time{}
	}
	return time.UnixMilli(ms)
}

func (s *Server) setAffinityCleanupAt(t time.Time) {
	_ = s.store.SetMeta(affinityCleanupMetaKey, strconv.FormatInt(t.UnixMilli(), 10))
}

// clearAffinity 立即清空亲和记录，供系统设置里的「立即清理」使用。
// 只清亲和，不动失败冷却；body 里的 channel / model 决定清理范围，都不传时全部清。
func (s *Server) clearAffinity(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Channel *bool `json:"channel"`
		Model   *bool `json:"model"`
	}
	if r.ContentLength > 0 {
		if err := readJSON(r, &req); err != nil {
			writeErr(w, http.StatusBadRequest, "请求格式错误")
			return
		}
	}
	channel, model := true, true
	if req.Channel != nil {
		channel = *req.Channel
	}
	if req.Model != nil {
		model = *req.Model
	}
	if !channel && !model {
		writeErr(w, http.StatusBadRequest, "请至少选择一种亲和")
		return
	}
	writeOK(w, relay.ClearAffinity(channel, model))
}
