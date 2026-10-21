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
	"net"
	"net/http"
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

// errTokenQuota 标记额度不足，调用方据此返回额度提示；其余校验失败一律按密钥无效处理。
var errTokenQuota = errors.New("该 API 密钥额度不足")

func tokenValid(t store.Token) error {
	if !t.Enabled {
		return errors.New("该 API 密钥已被禁用")
	}
	if t.ExpiresAt > 0 && time.Now().UnixMilli() > t.ExpiresAt {
		return errors.New("该 API 密钥已过期")
	}
	if t.QuotaLimit > 0 && t.UsedQuota >= t.QuotaLimit {
		return fmt.Errorf("%w（%s / %s）", errTokenQuota, humanTokens(t.UsedQuota), humanTokens(t.QuotaLimit))
	}
	return nil
}

func tokenAllowsModel(t store.Token, model string) bool {
	if len(t.AllowedModels) == 0 {
		return true
	}
	for _, m := range t.AllowedModels {
		if m == model {
			return true
		}
		// 含 * 的条目按通配模式匹配：* 匹配任意长度（含空），也能跨过模型 ID 里的 /
		if strings.Contains(m, "*") && wildcardMatch(m, model) {
			return true
		}
	}
	return false
}

// wildcardMatch 用双指针回溯实现通配：* 匹配任意字节序列（包括空），
// 其余字符按字面比较。UTF-8 多字节字符按字节比较仍然安全，因为 * 是单字节 ASCII，
// 不会与多字节字符的后续字节混淆。
func wildcardMatch(pattern, s string) bool {
	p, i := 0, 0
	star, match := -1, 0
	for i < len(s) {
		switch {
		case p < len(pattern) && pattern[p] == s[i]:
			p++
			i++
		case p < len(pattern) && pattern[p] == '*':
			star = p
			match = i
			p++
		case star >= 0:
			p = star + 1
			match++
			i = match
		default:
			return false
		}
	}
	for p < len(pattern) && pattern[p] == '*' {
		p++
	}
	return p == len(pattern)
}

// requestIP 返回用于 IP 白名单校验的客户端地址。
// 只有直连方是本机或内网（同机 Nginx/Caddy、Docker 网关等）时才信任代理头，
// 并取 X-Forwarded-For 的最后一跳，避免公网客户端直接伪造该头绕过白名单。
func requestIP(r *http.Request) string {
	host := r.RemoteAddr
	if h, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		host = h
	}
	remote := net.ParseIP(host)
	if remote == nil || !(remote.IsLoopback() || remote.IsPrivate()) {
		return host
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		if v := strings.TrimSpace(parts[len(parts)-1]); net.ParseIP(v) != nil {
			return v
		}
	}
	if xr := strings.TrimSpace(r.Header.Get("X-Real-Ip")); net.ParseIP(xr) != nil {
		return xr
	}
	return host
}

// tokenAllowsIP 判断来源 IP 是否命中令牌的白名单。
// 未配置规则表示不限制；配置了规则但地址无法解析时按拒绝处理。
func tokenAllowsIP(t store.Token, ip string) bool {
	if len(t.AllowedIPs) == 0 {
		return true
	}
	addr := net.ParseIP(strings.TrimSpace(ip))
	if addr == nil {
		return false
	}
	for _, rule := range t.AllowedIPs {
		if ipRuleMatches(rule, addr) {
			return true
		}
	}
	return false
}

// normalizeIPRules 去空白、去重并校验白名单规则。
func normalizeIPRules(in []string) ([]string, error) {
	out := make([]string, 0, len(in))
	seen := make(map[string]bool, len(in))
	for _, raw := range in {
		rule := strings.TrimSpace(raw)
		if rule == "" {
			continue
		}
		if !validIPRule(rule) {
			return nil, fmt.Errorf("IP 规则「%s」格式不正确，支持单个 IP、CIDR 网段或 192.168.* 通配", rule)
		}
		if seen[rule] {
			continue
		}
		seen[rule] = true
		out = append(out, rule)
	}
	return out, nil
}

func validIPRule(rule string) bool {
	if rule == "*" {
		return true
	}
	if net.ParseIP(rule) != nil {
		return true
	}
	if _, _, err := net.ParseCIDR(rule); err == nil {
		return true
	}
	return validIPv4Wildcard(rule)
}

// validIPv4Wildcard 校验 192.168.1.* / 10.* 这类尾部通配。
// 通配符只能出现一次且必须在末尾。
func validIPv4Wildcard(rule string) bool {
	if !strings.Contains(rule, "*") {
		return false
	}
	parts := strings.Split(rule, ".")
	if len(parts) > 4 {
		return false
	}
	wildcard := false
	for _, p := range parts {
		if p == "*" {
			wildcard = true
			continue
		}
		if wildcard {
			return false
		}
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 || n > 255 {
			return false
		}
	}
	return wildcard
}

func ipRuleMatches(rule string, addr net.IP) bool {
	if rule == "*" {
		return true
	}
	if ip := net.ParseIP(rule); ip != nil {
		return ip.Equal(addr)
	}
	if _, ipnet, err := net.ParseCIDR(rule); err == nil {
		return ipnet.Contains(addr)
	}
	v4 := addr.To4()
	if v4 == nil {
		return false
	}
	parts := strings.Split(rule, ".")
	if len(parts) > len(v4) {
		return false
	}
	for i, p := range parts {
		if p == "*" {
			return true
		}
		n, err := strconv.Atoi(p)
		if err != nil || int(v4[i]) != n {
			return false
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
