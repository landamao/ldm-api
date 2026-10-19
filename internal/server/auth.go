package server

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"ldmapi/internal/store"
)

const (
	sessionCookie = "ldm_session"
	sessionTTL    = 7 * 24 * time.Hour

	// DefaultPassword 管理端首次启动时使用的默认密码。
	DefaultPassword = "landamao"
)

// hashPassword 用迭代 SHA-256 派生密码摘要，避免引入额外依赖。
func hashPassword(password, salt string) string {
	h := sha256.Sum256([]byte(salt + "\x00" + password))
	sum := h[:]
	for i := 0; i < 100_000; i++ {
		next := sha256.Sum256(append(sum, []byte(salt)...))
		sum = next[:]
	}
	return hex.EncodeToString(sum)
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return strings.Repeat("0", n*2)
	}
	return hex.EncodeToString(b)
}

type sessionPayload struct {
	User string `json:"u"`
	Exp  int64  `json:"e"`
}

func (s *Server) sessionSecret() []byte {
	s.secretMu.RLock()
	if s.secret != nil {
		v := s.secret
		s.secretMu.RUnlock()
		return v
	}
	s.secretMu.RUnlock()

	s.secretMu.Lock()
	defer s.secretMu.Unlock()
	if s.secret != nil {
		return s.secret
	}
	v, err := s.store.GetMeta("session_secret")
	if err != nil || v == "" {
		v = randomHex(32)
		_ = s.store.SetMeta("session_secret", v)
	}
	s.secret = []byte(v)
	return s.secret
}

// rotateSessionSecret 生成新的会话密钥。改密后调用，
// 所有用旧密钥签发的会话会立即失效。
func (s *Server) rotateSessionSecret() error {
	v := randomHex(32)
	if err := s.store.SetMeta("session_secret", v); err != nil {
		return err
	}
	s.secretMu.Lock()
	s.secret = []byte(v)
	s.secretMu.Unlock()
	return nil
}

func (s *Server) issueSession() (string, error) {
	payload := sessionPayload{User: "root", Exp: time.Now().Add(sessionTTL).Unix()}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	body := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, s.sessionSecret())
	mac.Write([]byte(body))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return body + "." + sig, nil
}

func (s *Server) verifySession(token string) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return false
	}
	mac := hmac.New(sha256.New, s.sessionSecret())
	mac.Write([]byte(parts[0]))
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(want), []byte(parts[1])) != 1 {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return false
	}
	var p sessionPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return false
	}
	return p.Exp > time.Now().Unix()
}

// CheckPassword 校验管理端密码。
func (s *Server) CheckPassword(password string) bool {
	st, err := s.store.GetSettings()
	if err != nil {
		return false
	}
	if st.RootPasswordHash == "" || st.RootPasswordSalt == "" {
		return password == DefaultPassword
	}
	return subtle.ConstantTimeCompare(
		[]byte(hashPassword(password, st.RootPasswordSalt)),
		[]byte(st.RootPasswordHash)) == 1
}

// SetPassword 更新管理端密码。
func (s *Server) SetPassword(password string) error {
	if len(password) < 6 {
		return errors.New("密码至少 6 位")
	}
	st, err := s.store.GetSettings()
	if err != nil {
		return err
	}
	st.RootPasswordSalt = randomHex(16)
	st.RootPasswordHash = hashPassword(password, st.RootPasswordSalt)
	if err := s.store.SaveSettings(st); err != nil {
		return err
	}
	// 改密后轮换会话密钥，让改密前签发的所有会话立即失效。
	return s.rotateSessionSecret()
}

// EnsureDefaultPassword 首次启动时写入默认密码，并返回是否为默认密码。
func (s *Server) EnsureDefaultPassword() (bool, error) {
	st, err := s.store.GetSettings()
	if err != nil {
		return false, err
	}
	if st.RootPasswordHash != "" {
		return s.CheckPassword(DefaultPassword), nil
	}
	st.RootPasswordSalt = randomHex(16)
	st.RootPasswordHash = hashPassword(DefaultPassword, st.RootPasswordSalt)
	return true, s.store.SaveSettings(st)
}

// ---------- API Key ----------

func newAPIKey() string {
	return "sk-ldm-" + randomHex(20)
}

// FindToken 根据请求头里的密钥查找令牌。
func (s *Server) findToken(authHeader, xAPIKey string) (store.Token, error) {
	key := strings.TrimSpace(xAPIKey)
	if key == "" {
		if strings.HasPrefix(strings.ToLower(authHeader), "bearer ") {
			key = strings.TrimSpace(authHeader[7:])
		} else if authHeader != "" {
			key = strings.TrimSpace(authHeader)
		}
	}
	if key == "" {
		return store.Token{}, errors.New("缺少 API 密钥")
	}
	return s.store.FindTokenByKey(key)
}

func tokenValid(t store.Token) error {
	if !t.Enabled {
		return errors.New("该 API 密钥已被禁用")
	}
	if t.ExpiresAt > 0 && time.Now().UnixMilli() > t.ExpiresAt {
		return errors.New("该 API 密钥已过期")
	}
	if t.QuotaLimit > 0 && t.UsedQuota >= t.QuotaLimit {
		return fmt.Errorf("该 API 密钥额度已用尽（%s / %s）", humanTokens(t.UsedQuota), humanTokens(t.QuotaLimit))
	}
	return nil
}

func tokenAllowsModel(t store.Token, model string) bool {
	if len(t.AllowedModels) == 0 {
		return true
	}
	for _, m := range t.AllowedModels {
		if m == model || m == "*" {
			return true
		}
	}
	return false
}

func humanTokens(n int64) string {
	switch {
	case n >= 1_000_000:
		return strconv.FormatFloat(float64(n)/1_000_000, 'f', 2, 64) + "M"
	case n >= 1_000:
		return strconv.FormatFloat(float64(n)/1_000, 'f', 2, 64) + "K"
	}
	return strconv.FormatInt(n, 10)
}
