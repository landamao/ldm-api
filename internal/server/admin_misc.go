package server

import (
	"time"

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
