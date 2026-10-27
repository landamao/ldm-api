package server

import (
	"encoding/json"
	"hash/fnv"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"ldmapi/internal/relay"
	"ldmapi/internal/store"
	"ldmapi/web"
)

type Server struct {
	store        *store.Store
	relay        *relay.Relay
	secret       []byte
	secretMu     sync.RWMutex
	loginLimiter *loginLimiter
	StartedAt    time.Time
	Version      string
	// DataDir 是数据目录，备份文件写到 <DataDir>/backups。
	// 为空时回退到数据库文件所在目录。
	DataDir string
	// DevDir 非空时前端资源从磁盘目录读取，方便改前端时无需重新编译。
	DevDir string
}

func New(st *store.Store) *Server {
	s := &Server{
		store:        st,
		relay:        relay.New(st),
		loginLimiter: newLoginLimiter(),
		StartedAt:    time.Now(),
		Version:      "1.0.0",
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
	mux.HandleFunc("POST /api/channels", s.admin(s.createChannel))
	mux.HandleFunc("PUT /api/channels/{id}", s.admin(s.saveChannel))
	mux.HandleFunc("DELETE /api/channels/{id}", s.admin(s.deleteChannel))
	mux.HandleFunc("GET /api/channels/{id}/refs", s.admin(s.listChannelRefs))
	mux.HandleFunc("POST /api/channels/{id}/test", s.admin(s.testChannel))
	mux.HandleFunc("POST /api/channels/{id}/prune-refs", s.admin(s.pruneChannelRefs))
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
	mux.HandleFunc("GET /api/logs/facets", s.admin(s.logFacets))
	mux.HandleFunc("DELETE /api/logs", s.admin(s.clearLogs))
	mux.HandleFunc("GET /api/stats/overview", s.admin(s.statsOverview))
	mux.HandleFunc("GET /api/stats/series", s.admin(s.statsSeries))
	mux.HandleFunc("GET /api/stats/breakdown", s.admin(s.statsBreakdown))

	// ---- 设置 ----
	mux.HandleFunc("GET /api/settings", s.handleGetSettings)
	mux.HandleFunc("PUT /api/settings", s.admin(s.saveSettings))

	// ---- 备份导出 ----
	mux.HandleFunc("POST /api/backup/export", s.admin(s.exportBackup))

	// ---- 模型广场 / 在线聊天 ----
	mux.HandleFunc("GET /api/plaza", s.admin(s.plaza))
	mux.HandleFunc("POST /api/chat", s.admin(s.chat))

	// ---- 对外 OpenAI 兼容接口 ----
	mux.HandleFunc("/v1/", s.handleAPI)

	// ---- 前端 ----
	mux.HandleFunc("/", s.serveStatic)

	return s.withCORS(withRecover(withLogger(mux)))
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
				// 详情只进日志；对外给固定文案，避免 panic 内容带出内部路径等细节
				log.Printf("panic on %s %s: %v", r.Method, r.URL.Path, rec)
				writeJSON(w, http.StatusInternalServerError, map[string]any{
					"error": map[string]any{"message": "服务内部错误，请稍后重试", "type": "internal_error"},
				})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func (s *Server) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 只有对外的 /v1 接口需要 CORS：浏览器端 SDK 会用 Authorization 头携带
		// API 密钥，不依赖 Cookie，因此不回显 Allow-Credentials。
		// 管理端 /api 只给同源页面使用，不返回任何 CORS 头；跨站写请求由
		// admin 中间件里的同源校验拦截。
		if strings.HasPrefix(r.URL.Path, "/v1/") {
			if origin := r.Header.Get("Origin"); origin != "" {
				// 响应是否带 CORS 头取决于 Origin 与设置的比较结果，必须声明 Vary，
				// 避免中间缓存把放行结果错发给别的来源。
				w.Header().Add("Vary", "Origin")
				if s.originAllowed(origin) {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Set("Access-Control-Allow-Headers", "*")
					w.Header().Set("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS")
					w.Header().Set("Access-Control-Max-Age", "600")
				}
			}
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// originAllowed 判断 /v1 的 CORS 是否放行该 Origin。
// 设置里 allow_origins 为空时保持默认行为：反射任意 Origin（/v1 用 API 密钥
// 认证、不依赖 Cookie，开放跨域没有风险）。配置了白名单则只放行列表内的
// Origin：逗号 / 分号 / 空白分隔，"*" 仍表示全部放行。
// 读设置失败时退回默认行为，避免存储异常把对外接口的浏览器调用全部打断。
func (s *Server) originAllowed(origin string) bool {
	st, err := s.store.GetSettings()
	if err != nil {
		return true
	}
	list := strings.TrimSpace(st.AllowOrigins)
	if list == "" || list == "*" {
		return true
	}
	for _, item := range strings.FieldsFunc(list, func(r rune) bool {
		return r == ',' || r == '，' || r == ';' || r == '；' || r == ' ' || r == '\t' || r == '\n' || r == '\r'
	}) {
		item = strings.TrimSpace(item)
		if item == "*" || strings.EqualFold(item, origin) {
			return true
		}
	}
	return false
}

type statusWriter struct {
	http.ResponseWriter
	status  int
	written bool
}

func (w *statusWriter) WriteHeader(code int) {
	// 只把第一次的状态码透传给底层 writer；重复调用直接吞掉，
	// 否则标准库会记一条 superfluous response.WriteHeader 告警日志
	if w.written {
		return
	}
	w.status = code
	w.written = true
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
		// 管理端写操作只接受同源页面发起。SameSite=Lax 只能挡住跨站请求，
		// 同一主机不同端口（同站）的页面仍然会带上会话 Cookie，因此这里再
		// 校验 Origin / Referer / Sec-Fetch-Site，防止同站 CSRF。
		if isMutatingMethod(r.Method) && !sameOriginRequest(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{
				"error": map[string]any{"message": "跨站请求已被拒绝", "type": "forbidden"},
			})
			return
		}
		next(w, r)
	}
}

func isMutatingMethod(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	}
	return false
}

// sameOriginRequest 判断一个写请求是否来自同源页面。
// 非浏览器客户端（curl、脚本）通常不带 Origin/Referer/Sec-Fetch-Site，
// 这里放行；浏览器只要带了这些头，就必须与当前 Host 一致。
func sameOriginRequest(r *http.Request) bool {
	switch r.Header.Get("Sec-Fetch-Site") {
	case "", "same-origin", "none":
		// 继续用 Origin/Referer 校验
	default:
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		return originHostMatches(r, origin)
	}
	if referer := r.Header.Get("Referer"); referer != "" {
		return originHostMatches(r, referer)
	}
	return true
}

func originHostMatches(r *http.Request, raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return false
	}
	if strings.EqualFold(u.Host, r.Host) {
		return true
	}
	// 反向代理通常会改写 Host。浏览器无法在跨站请求里自行设置
	// X-Forwarded-Host：自定义请求头会触发预检，而 /api 不返回任何
	// CORS 头，预检必然失败；非浏览器客户端本来就可以不带 Origin。
	// 因此这里信任代理写入的值，兼容 Nginx 默认的 Host 改写。
	if xfh := r.Header.Get("X-Forwarded-Host"); xfh != "" {
		first := strings.TrimSpace(strings.Split(xfh, ",")[0])
		if first != "" && strings.EqualFold(u.Host, first) {
			return true
		}
	}
	return false
}

func (s *Server) isAdmin(r *http.Request) bool {
	// 管理端只认登录会话。API 密钥是给调用方调模型用的，
	// 不能因为持有密钥就获得管理权限（禁用/过期的密钥同样不行）。
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return false
	}
	return s.verifySession(c.Value)
}

// ---------- 静态资源 ----------

func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	// Windows 下反斜杠也是路径分隔符，path.Clean 不会处理它。
	// 直接拒绝，避免开发模式从 DevDir 之外读取文件。
	if strings.ContainsRune(name, '\\') {
		http.NotFound(w, r)
		return
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
		// 开发模式直接从磁盘读取，必须确保路径不会逃出 DevDir。
		// 反斜杠在 Windows 上同样是分隔符，先拒绝再按目录前缀校验。
		if strings.ContainsRune(name, '\\') {
			return nil, fs.ErrInvalid
		}
		root := filepath.Clean(s.DevDir)
		full := filepath.Clean(filepath.Join(root, filepath.FromSlash(name)))
		rel, err := filepath.Rel(root, full)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return nil, fs.ErrInvalid
		}
		return os.ReadFile(full)
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
	return readJSONLimit(r, v, 8<<20)
}

// readJSONLimit 与 readJSON 相同，但允许调用方指定请求体上限。
// 在线聊天需要容纳 base64 图片与附件，因此单独放宽到 64MB。
func readJSONLimit(r *http.Request, v any, limit int64) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, limit))
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
