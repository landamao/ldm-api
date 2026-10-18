package server

import (
	"encoding/json"
	"fmt"
	"hash/fnv"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"ldmapi/internal/relay"
	"ldmapi/internal/store"
	"ldmapi/web"
)

type Server struct {
	store     *store.Store
	relay     *relay.Relay
	secret    []byte
	StartedAt time.Time
	Version   string
	// DevDir 非空时前端资源从磁盘目录读取，方便改前端时无需重新编译。
	DevDir string
}

func New(st *store.Store) *Server {
	s := &Server{
		store:     st,
		relay:     relay.New(st),
		StartedAt: time.Now(),
		Version:   "1.0.0",
	}
	if err := s.EnsureProviders(); err != nil {
		log.Printf("初始化提供商失败: %v", err)
	}
	return s
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// ---- 管理端认证 ----
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	mux.HandleFunc("GET /api/auth/me", s.admin(s.handleMe))
	mux.HandleFunc("POST /api/auth/password", s.admin(s.handleChangePassword))

	// ---- 渠道 ----
	mux.HandleFunc("GET /api/channels", s.admin(s.listChannels))
	mux.HandleFunc("POST /api/channels", s.admin(s.saveChannel))
	mux.HandleFunc("PUT /api/channels/{id}", s.admin(s.saveChannel))
	mux.HandleFunc("DELETE /api/channels/{id}", s.admin(s.deleteChannel))
	mux.HandleFunc("POST /api/channels/{id}/test", s.admin(s.testChannel))
	mux.HandleFunc("POST /api/channels/discover", s.admin(s.discoverChannelModels))

	// ---- 模型 ----
	mux.HandleFunc("GET /api/models", s.admin(s.listModels))
	mux.HandleFunc("GET /api/models/available", s.admin(s.availableChannelModels))
	mux.HandleFunc("POST /api/models", s.admin(s.saveModel))
	mux.HandleFunc("PUT /api/models/{id...}", s.admin(s.saveModel))
	mux.HandleFunc("DELETE /api/models/{id...}", s.admin(s.deleteModel))
	mux.HandleFunc("POST /api/models/batch", s.admin(s.batchAddModels))
	mux.HandleFunc("POST /api/models/batch-delete", s.admin(s.batchDeleteModels))
	mux.HandleFunc("POST /api/models/batch-provider", s.admin(s.batchSetModelProvider))
	mux.HandleFunc("POST /api/models/clear-cooldowns", s.admin(s.clearModelCooldowns))
	mux.HandleFunc("POST /api/models/test", s.admin(s.testModel))

	// ---- 提供商 ----
	mux.HandleFunc("GET /api/providers", s.admin(s.listProviders))
	mux.HandleFunc("GET /api/providers/defaults", s.admin(s.listDefaultProviders))
	mux.HandleFunc("POST /api/providers", s.admin(s.saveProvider))
	mux.HandleFunc("POST /api/providers/restore-defaults", s.admin(s.restoreDefaultProviders))
	mux.HandleFunc("PUT /api/providers/{id}", s.admin(s.saveProvider))
	mux.HandleFunc("DELETE /api/providers/{id}", s.admin(s.deleteProvider))

	// ---- 令牌 ----
	mux.HandleFunc("GET /api/tokens", s.admin(s.listTokens))
	mux.HandleFunc("POST /api/tokens", s.admin(s.saveToken))
	mux.HandleFunc("PUT /api/tokens/{id}", s.admin(s.saveToken))
	mux.HandleFunc("DELETE /api/tokens/{id}", s.admin(s.deleteToken))

	// ---- 日志 / 统计 ----
	mux.HandleFunc("GET /api/logs", s.admin(s.listLogs))
	mux.HandleFunc("DELETE /api/logs", s.admin(s.clearLogs))
	mux.HandleFunc("GET /api/stats/overview", s.admin(s.statsOverview))
	mux.HandleFunc("GET /api/stats/series", s.admin(s.statsSeries))
	mux.HandleFunc("GET /api/stats/breakdown", s.admin(s.statsBreakdown))

	// ---- 设置 ----
	mux.HandleFunc("GET /api/settings", s.handleGetSettings)
	mux.HandleFunc("PUT /api/settings", s.admin(s.saveSettings))

	// ---- 模型广场 / 在线对话 ----
	mux.HandleFunc("GET /api/plaza", s.admin(s.plaza))
	mux.HandleFunc("POST /api/chat", s.admin(s.chat))

	// ---- 对外 OpenAI 兼容接口 ----
	mux.HandleFunc("/v1/", s.handleAPI)

	// ---- 前端 ----
	mux.HandleFunc("/", s.serveStatic)

	return withCORS(withRecover(withLogger(mux)))
}

// ---------- 中间件 ----------

func withLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(sw, r)
		log.Printf("%s %s %d %dms", r.Method, r.URL.Path, sw.status, time.Since(start).Milliseconds())
	})
}

func withRecover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("panic on %s %s: %v", r.Method, r.URL.Path, rec)
				writeJSON(w, http.StatusInternalServerError, map[string]any{
					"error": map[string]any{"message": fmt.Sprint(rec), "type": "internal_error"},
				})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/") || strings.HasPrefix(r.URL.Path, "/api/") {
			origin := r.Header.Get("Origin")
			if origin != "" {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
				w.Header().Set("Access-Control-Allow-Credentials", "true")
			}
			w.Header().Set("Access-Control-Allow-Headers", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status  int
	written bool
}

func (w *statusWriter) WriteHeader(code int) {
	if !w.written {
		w.status = code
		w.written = true
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	w.written = true
	return w.ResponseWriter.Write(b)
}

func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// admin 包装需要登录的管理接口。
func (s *Server) admin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.isAdmin(r) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{
				"error": map[string]any{"message": "未登录或会话已过期", "type": "unauthorized"},
			})
			return
		}
		next(w, r)
	}
}

func (s *Server) isAdmin(r *http.Request) bool {
	if c, err := r.Cookie(sessionCookie); err == nil && s.verifySession(c.Value) {
		return true
	}
	// 兼容用 API 密钥直接调管理接口的场景
	if _, err := s.findToken(r.Header.Get("Authorization"), r.Header.Get("x-api-key")); err == nil {
		return true
	}
	return false
}

// ---------- 静态资源 ----------

func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	data, err := s.readAsset(name)
	if err != nil {
		// SPA 回退
		data, err = s.readAsset("index.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		name = "index.html"
	}
	ctype := mime.TypeByExtension(path.Ext(name))
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ctype)

	if s.DevDir != "" {
		// 开发模式下每次都从磁盘读，也要求浏览器不要缓存，改完前端刷新即可生效
		w.Header().Set("Cache-Control", "no-store")
		w.Write(data)
		return
	}

	// 用内容哈希做 ETag，并要求浏览器每次都回来验证。
	// 这样升级二进制后刷新就能立刻拿到新前端，而不是继续跑缓存里的旧页面；
	// 内容没变时服务端只回一个 304，几乎没有开销。
	etag := `"` + contentHash(data) + `"`
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "no-cache")
	if etagMatches(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Write(data)
}

func contentHash(data []byte) string {
	h := fnv.New64a()
	h.Write(data)
	return strconv.FormatUint(h.Sum64(), 16)
}

// etagMatches 处理 If-None-Match，兼容 W/ 前缀与逗号分隔的多个标签。
func etagMatches(header, etag string) bool {
	if header == "" {
		return false
	}
	if strings.TrimSpace(header) == "*" {
		return true
	}
	for _, tag := range strings.Split(header, ",") {
		if strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(tag), "W/")) == etag {
			return true
		}
	}
	return false
}

func (s *Server) readAsset(name string) ([]byte, error) {
	if s.DevDir != "" {
		return os.ReadFile(filepath.Join(s.DevDir, filepath.FromSlash(name)))
	}
	return fs.ReadFile(web.FS, name)
}

// ---------- 工具 ----------

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.Encode(v)
}

func writeOK(w http.ResponseWriter, v any) {
	if v == nil {
		v = map[string]any{"success": true}
	}
	writeJSON(w, http.StatusOK, v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]any{"message": msg, "type": "error"}})
}

func readJSON(r *http.Request, v any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if err != nil {
		return err
	}
	if len(body) == 0 {
		return nil
	}
	dec := json.NewDecoder(strings.NewReader(string(body)))
	dec.UseNumber()
	return dec.Decode(v)
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.Index(xff, ","); i > 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	if xr := r.Header.Get("X-Real-Ip"); xr != "" {
		return xr
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
