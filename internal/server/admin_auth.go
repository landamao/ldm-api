package server

import (
	"net/http"
	"strings"
	"time"

	"ldmapi/internal/store"
)

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if !s.CheckPassword(req.Password) {
		time.Sleep(300 * time.Millisecond) // 简单抑制暴力破解
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
	writeOK(w, map[string]any{
		"logged_in":        true,
		"version":          s.Version,
		"started_at":       s.StartedAt.UnixMilli(),
		"uptime_seconds":   int64(time.Since(s.StartedAt).Seconds()),
		"default_password": s.CheckPassword(DefaultPassword),
		"counts":           counts,
		"settings":         publicSettings(st),
	})
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
		writeErr(w, http.StatusInternalServerError, err.Error())
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
		PrimaryColor     *string `json:"primary_color"`
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
	if req.PrimaryColor != nil {
		st.PrimaryColor = strings.TrimSpace(*req.PrimaryColor)
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
