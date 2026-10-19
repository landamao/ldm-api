package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"ldmapi/internal/store"
)

const (
	backupUpstreamKey = "sk-upstream-plain-1111"
	backupTokenKey    = "sk-ldm-token-plain-2222"
)

// seedBackupData 写入覆盖所有导出范围的测试数据。
func seedBackupData(t *testing.T, st *store.Store) {
	t.Helper()
	now := time.Now().UnixMilli()
	if err := st.SaveChannel(store.Channel{
		ID: "c1", Name: "渠道一", Type: store.ChannelOpenAI, BaseURL: "https://example.com",
		APIKeys: []store.ChannelKey{
			{Key: backupUpstreamKey, Note: "主 Key"},
			{Key: "sk-upstream-plain-3333"},
		},
		Models: []string{"gpt-4o"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveToken(store.Token{
		ID: "t1", Name: "测试密钥", Key: backupTokenKey, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveSettings(store.Settings{SiteName: "备份测试", LogRetentionDays: 30}); err != nil {
		t.Fatal(err)
	}
	logEntry := store.Log{
		ID: "l1", Time: now, TokenID: "t1", TokenName: "测试密钥",
		ModelID: "gpt-4o", ChannelID: "c1", StatusCode: 200, LatencyMs: 12,
	}
	if err := st.AppendLog(logEntry); err != nil {
		t.Fatal(err)
	}
	if err := st.RecordStat(logEntry); err != nil {
		t.Fatal(err)
	}
}

func callExport(t *testing.T, s *Server, body string) (int, map[string]any, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/backup/export", strings.NewReader(body))
	rec := httptest.NewRecorder()
	s.exportBackup(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out, rec.Body.String()
}

// 明文 Key 只能写进服务器本地文件，HTTP 响应里不能出现。
func TestBackupExportWritesPlaintextKeysLocallyOnly(t *testing.T) {
	s, st := newTestServer(t, "backup-all")
	s.DataDir = t.TempDir()
	seedBackupData(t, st)

	code, out, body := callExport(t, s, `{"scopes":["channels","models","providers","tokens","settings","logs","stats"]}`)
	if code != http.StatusOK {
		t.Fatalf("状态码 %d: %s", code, body)
	}
	for _, secret := range []string{backupUpstreamKey, backupTokenKey} {
		if strings.Contains(body, secret) {
			t.Errorf("导出响应不应包含明文密钥 %q: %s", secret, body)
		}
	}

	path, _ := out["path"].(string)
	if path == "" {
		t.Fatal("响应应返回备份文件路径")
	}
	wantDir := filepath.Join(s.DataDir, "backups")
	if filepath.Dir(path) != wantDir {
		t.Errorf("备份应写在 %s，实际 %s", wantDir, path)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取备份文件失败: %v", err)
	}
	for _, secret := range []string{backupUpstreamKey, backupTokenKey} {
		if !strings.Contains(string(raw), secret) {
			t.Errorf("备份文件应包含明文密钥 %q", secret)
		}
	}

	var file struct {
		Format     string                     `json:"format"`
		Version    int                        `json:"version"`
		AppVersion string                     `json:"app_version"`
		ExportedAt int64                      `json:"exported_at"`
		Scopes     []string                   `json:"scopes"`
		Data       map[string]json.RawMessage `json:"data"`
		Counts     map[string]int             `json:"counts"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatalf("备份 JSON 解析失败: %v", err)
	}
	if file.Format != "ldmapi-backup" || file.Version != 1 {
		t.Errorf("备份格式标识不正确: %+v", file)
	}
	if file.ExportedAt == 0 {
		t.Error("备份应记录导出时间")
	}
	for _, scope := range []string{"channels", "models", "providers", "tokens", "settings", "logs", "stats"} {
		if _, ok := file.Data[scope]; !ok {
			t.Errorf("备份缺少范围 %q", scope)
		}
	}
	if file.Counts["channels"] != 1 || file.Counts["tokens"] != 1 || file.Counts["settings"] != 1 {
		t.Errorf("导出计数不正确: %+v", file.Counts)
	}
	if file.Counts["logs"] != 1 || file.Counts["stats"] != 1 {
		t.Errorf("日志/统计计数不正确: %+v", file.Counts)
	}

	var channels []store.Channel
	if err := json.Unmarshal(file.Data["channels"], &channels); err != nil {
		t.Fatal(err)
	}
	if len(channels) != 1 || len(channels[0].APIKeys) != 2 || channels[0].APIKeys[0].Key != backupUpstreamKey {
		t.Errorf("渠道 Key 未按明文完整导出: %+v", channels)
	}

	var tokens []store.Token
	if err := json.Unmarshal(file.Data["tokens"], &tokens); err != nil {
		t.Fatal(err)
	}
	if len(tokens) != 1 || tokens[0].Key != backupTokenKey {
		t.Errorf("令牌 Key 未按明文导出: %+v", tokens)
	}

	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Errorf("备份文件权限应为 0600，实际 %o", perm)
		}
	}
}

// 勾选范围之外的敏感数据不能出现在文件里。
func TestBackupExportScopeFilter(t *testing.T) {
	s, st := newTestServer(t, "backup-scope")
	s.DataDir = t.TempDir()
	seedBackupData(t, st)

	code, out, body := callExport(t, s, `{"scopes":["tokens"]}`)
	if code != http.StatusOK {
		t.Fatalf("状态码 %d: %s", code, body)
	}
	path, _ := out["path"].(string)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), backupUpstreamKey) {
		t.Error("只导出令牌时不应包含上游渠道 Key")
	}

	var file struct {
		Scopes []string                   `json:"scopes"`
		Data   map[string]json.RawMessage `json:"data"`
		Counts map[string]int             `json:"counts"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Data) != 1 {
		t.Errorf("只应导出一个范围，实际 %v", file.Data)
	}
	if _, ok := file.Data["tokens"]; !ok {
		t.Error("应导出 tokens 范围")
	}
	if len(file.Counts) != 1 || file.Counts["tokens"] != 1 {
		t.Errorf("计数应只包含 tokens: %+v", file.Counts)
	}
	if len(file.Scopes) != 1 || file.Scopes[0] != "tokens" {
		t.Errorf("范围记录不正确: %v", file.Scopes)
	}
}

// 缩进选项：0 输出单行紧凑 JSON，大于 0 按空格数美化；越界值拒绝。
func TestBackupExportIndentOption(t *testing.T) {
	s, st := newTestServer(t, "backup-indent")
	s.DataDir = t.TempDir()
	seedBackupData(t, st)

	readBackup := func(body string) string {
		t.Helper()
		code, out, resp := callExport(t, s, body)
		if code != http.StatusOK {
			t.Fatalf("状态码 %d: %s", code, resp)
		}
		path, _ := out["path"].(string)
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}

	compact := readBackup(`{"scopes":["tokens"]}`)
	if strings.Contains(compact, "\n") {
		t.Errorf("默认输出应为单行紧凑 JSON:\n%s", compact)
	}

	pretty := readBackup(`{"scopes":["tokens"],"indent":2}`)
	for _, want := range []string{
		"\n  \"format\": \"ldmapi-backup\"",
		"\n    \"tokens\": [",
		"\n        \"id\": \"t1\"",
	} {
		if !strings.Contains(pretty, want) {
			t.Errorf("2 空格缩进输出缺少 %q:\n%s", want, pretty)
		}
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(pretty), &parsed); err != nil {
		t.Errorf("缩进后的 JSON 无法解析: %v", err)
	}

	for _, body := range []string{
		`{"scopes":["tokens"],"indent":-1}`,
		`{"scopes":["tokens"],"indent":9}`,
	} {
		code, _, resp := callExport(t, s, body)
		if code != http.StatusBadRequest {
			t.Errorf("%s: 应返回 400，得到 %d（%s）", body, code, resp)
		}
	}
}

func TestBackupExportRejectsInvalidScopes(t *testing.T) {
	s, _ := newTestServer(t, "backup-invalid")
	s.DataDir = t.TempDir()

	for _, body := range []string{`{"scopes":[]}`, `{}`, `{"scopes":["secrets"]}`} {
		code, _, resp := callExport(t, s, body)
		if code != http.StatusBadRequest {
			t.Errorf("%s: 应返回 400，得到 %d（%s）", body, code, resp)
		}
	}
	if _, err := os.Stat(filepath.Join(s.DataDir, "backups")); !os.IsNotExist(err) {
		t.Error("参数非法时不应创建备份目录或文件")
	}
}

// 备份接口只认管理端会话，API 密钥不能触发导出。
func TestBackupExportRequiresAdminSession(t *testing.T) {
	s, _ := newTestServer(t, "backup-auth")
	s.DataDir = t.TempDir()
	key, err := s.EnsureDefaultToken()
	if err != nil {
		t.Fatal(err)
	}
	gw := httptest.NewServer(s.Handler())
	defer gw.Close()

	do := func(cookie *http.Cookie, apiKey string) int {
		t.Helper()
		req, err := http.NewRequest(http.MethodPost, gw.URL+"/api/backup/export",
			strings.NewReader(`{"scopes":["tokens"]}`))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		if cookie != nil {
			req.AddCookie(cookie)
		}
		if apiKey != "" {
			req.Header.Set("Authorization", "Bearer "+apiKey)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, resp.Body)
		return resp.StatusCode
	}

	if code := do(nil, ""); code != http.StatusUnauthorized {
		t.Errorf("未登录导出应返回 401，得到 %d", code)
	}
	if code := do(nil, key); code != http.StatusUnauthorized {
		t.Errorf("API 密钥导出应返回 401，得到 %d", code)
	}
	sess, err := s.issueSession()
	if err != nil {
		t.Fatal(err)
	}
	if code := do(&http.Cookie{Name: sessionCookie, Value: sess}, ""); code != http.StatusOK {
		t.Errorf("管理端会话导出应成功，得到 %d", code)
	}
}
