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

// Cleanup 按设置清理过期日志与统计桶。
func (s *Server) Cleanup() {
	st, err := s.store.GetSettings()
	if err != nil || st.LogRetentionDays <= 0 {
		return
	}
	cutoff := time.Now().AddDate(0, 0, -st.LogRetentionDays).UnixMilli()
	_, _ = s.store.PurgeLogsBefore(cutoff)
	_ = s.store.PurgeStatsBefore(cutoff)
}

// affinityCleanupMetaKey 是「上次亲和自动清理」的时刻（毫秒）。
// 放 meta 桶而不是 Settings：定时器只改这一个值，不会和前端保存设置互相覆盖。
const affinityCleanupMetaKey = "affinity_cleanup_at"

// CleanupAffinity 按系统设置定时清空亲和记录，返回这次清掉的条数。
// 由 main 每分钟调用一次，是否真的执行由清理间隔决定；未开启或没到点时返回 0。
func (s *Server) CleanupAffinity() int {
	st, err := s.store.GetSettings()
	if err != nil || st.AffinityCleanupHours <= 0 {
		return 0
	}
	if !st.AffinityCleanChannel && !st.AffinityCleanModel {
		return 0
	}
	now := time.Now()
	last := s.affinityCleanupAt()
	if last.IsZero() {
		// 首次运行（含刚升级）只记基线，不在启动后立刻清一遍。
		s.setAffinityCleanupAt(now)
		return 0
	}
	if now.Sub(last) < time.Duration(st.AffinityCleanupHours)*time.Hour {
		return 0
	}
	res := relay.ClearAffinity(st.AffinityCleanChannel, st.AffinityCleanModel)
	s.setAffinityCleanupAt(now)
	if res.Affinity > 0 {
		log.Printf("定时清理亲和：%d 条", res.Affinity)
	}
	return res.Affinity
}

// affinityCleanupAt 返回上次亲和自动清理的时刻，没有记录时返回零值。
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
