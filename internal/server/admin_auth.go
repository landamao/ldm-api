package server

import (
	"fmt"
	"net"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"ldmapi/internal/store"
)

// loginFailureDelay 是密码错误时故意增加的响应延迟。
var loginFailureDelay = 2 * time.Second

const (
	loginWindow      = 10 * time.Minute
	loginMaxAttempts = 10
)

// loginLimiter 按客户端 IP 做滑动窗口限流：每个窗口内最多允许 N 次登录尝试。
type loginLimiter struct {
	mu          sync.Mutex
	attempts    map[string][]time.Time
	lastCleanup time.Time
}

func newLoginLimiter() *loginLimiter {
	return &loginLimiter{attempts: map[string][]time.Time{}}
}

// allow 记录一次尝试；超过限制时返回 false 和需要等待的时长。
func (l *loginLimiter) allow(key string, now time.Time) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()

	// 定期清掉已经过期的 key，避免长期运行后 map 无限增长。
	if l.lastCleanup.IsZero() || now.Sub(l.lastCleanup) >= loginWindow {
		for k, list := range l.attempts {
			if len(list) == 0 || now.Sub(list[len(list)-1]) >= loginWindow {
				delete(l.attempts, k)
			}
		}
		l.lastCleanup = now
	}

	cutoff := now.Add(-loginWindow)
	list := l.attempts[key]
	i := 0
	for i < len(list) && !list[i].After(cutoff) {
		i++
	}
	list = list[i:]
	if len(list) >= loginMaxAttempts {
		l.attempts[key] = list
		return false, list[0].Add(loginWindow).Sub(now)
	}
	l.attempts[key] = append(list, now)
	return true, 0
}

// loginRateKey 取限流用的客户端标识。
// 只有请求来自本机（常见于 Nginx/Caddy 反向代理）时才信任 X-Forwarded-For，
// 并且取最后一跳，避免外部客户端直接伪造该头绕过限流。
func loginRateKey(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if v := strings.TrimSpace(parts[len(parts)-1]); v != "" {
				return v
			}
		}
	}
	return host
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	key := loginRateKey(r)
	if ok, retry := s.loginLimiter.allow(key, time.Now()); !ok {
		secs := int(retry/time.Second) + 1
		w.Header().Set("Retry-After", strconv.Itoa(secs))
		writeErr(w, http.StatusTooManyRequests,
			fmt.Sprintf("登录尝试过于频繁，请 %d 分钟后再试", (secs+59)/60))
		return
	}

	var req struct {
		Password string `json:"password"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if !s.CheckPassword(req.Password) {
		// 故意拖慢错误密码的响应，抑制暴力破解。
		time.Sleep(loginFailureDelay)
		writeErr(w, http.StatusUnauthorized, "密码错误")
		return
	}
	token, err := s.issueSession()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(sessionTTL.Seconds()),
	})
	writeOK(w, map[string]any{"success": true, "default_password": s.CheckPassword(DefaultPassword)})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/", HttpOnly: true, MaxAge: -1,
	})
	writeOK(w, nil)
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	st, _ := s.store.GetSettings()
	counts, _ := s.store.Stats()
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	writeOK(w, map[string]any{
		"logged_in":          true,
		"version":            s.Version,
		"started_at":         s.StartedAt.UnixMilli(),
		"uptime_seconds":     int64(time.Since(s.StartedAt).Seconds()),
		"system":             systemName(),
		"memory_bytes":       mem.Sys,
		"memory_total_bytes": totalSystemMemory(),
		"default_password":   s.CheckPassword(DefaultPassword),
		"counts":             counts,
		"settings":           publicSettings(st),
	})
}

// systemName 返回便于展示的运行平台，如 “Windows · amd64”。
func systemName() string {
	name := runtime.GOOS
	switch name {
	case "windows":
		name = "Windows"
	case "darwin":
		name = "macOS"
	case "linux":
		name = "Linux"
	}
	return name + " · " + runtime.GOARCH
}

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Old string `json:"old_password"`
		New string `json:"new_password"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if !s.CheckPassword(req.Old) {
		writeErr(w, http.StatusBadRequest, "原密码不正确")
		return
	}
	if err := s.SetPassword(req.New); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeOK(w, map[string]any{"success": true})
}

// ---------- 设置 ----------

func publicSettings(st store.Settings) store.Settings {
	out := st
	out.RootPasswordHash = ""
	out.RootPasswordSalt = ""
	return out
}

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	st, err := s.store.GetSettings()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "读取设置失败")
		return
	}
	writeOK(w, publicSettings(st))
}

func (s *Server) saveSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SiteName         *string `json:"site_name"`
		SiteSubtitle     *string `json:"site_subtitle"`
		Logo             *string `json:"logo"`
		Theme            *string `json:"theme"`
		LogRetentionDays *int    `json:"log_retention_days"`
		AllowOrigins     *string `json:"allow_origins"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	st, err := s.store.GetSettings()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if req.SiteName != nil {
		st.SiteName = strings.TrimSpace(*req.SiteName)
	}
	if req.SiteSubtitle != nil {
		st.SiteSubtitle = strings.TrimSpace(*req.SiteSubtitle)
	}
	if req.Logo != nil {
		st.Logo = strings.TrimSpace(*req.Logo)
	}
	if req.Theme != nil && (*req.Theme == "light" || *req.Theme == "dark") {
		st.Theme = *req.Theme
	}
	if req.LogRetentionDays != nil && *req.LogRetentionDays >= 0 {
		st.LogRetentionDays = *req.LogRetentionDays
	}
	if req.AllowOrigins != nil {
		st.AllowOrigins = strings.TrimSpace(*req.AllowOrigins)
	}
	if err := s.store.SaveSettings(st); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeOK(w, publicSettings(st))
}
