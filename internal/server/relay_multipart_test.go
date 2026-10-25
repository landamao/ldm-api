package server

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ldmapi/internal/store"
)

// 表单请求里的 model 也要参与密钥的模型白名单校验，
// 不能因为不是 JSON 请求就绕过限制。
func TestHandleAPIMultipartModelPermission(t *testing.T) {
	s, st := newTestServer(t, "multipart-permission")
	if err := st.SaveToken(store.Token{
		ID: "t1", Key: "sk-test", Enabled: true, AllowedModels: []string{"allowed"},
	}); err != nil {
		t.Fatal(err)
	}
	gw := httptest.NewServer(s.Handler())
	defer gw.Close()

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	if err := mw.WriteField("model", "denied"); err != nil {
		t.Fatal(err)
	}
	part, err := mw.CreateFormFile("image", "a.png")
	if err != nil {
		t.Fatal(err)
	}
	part.Write([]byte("png"))
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}

	req, err := http.NewRequest(http.MethodPost, gw.URL+"/v1/images/edits", &body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer sk-test")
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("应返回 403，得到 %d（%s）", resp.StatusCode, raw)
	}
	if !strings.Contains(string(raw), "model_not_allowed") {
		t.Errorf("应返回 model_not_allowed，得到 %s", raw)
	}
	if !strings.Contains(string(raw), "denied") {
		t.Errorf("错误信息应带上被拒绝的模型名，得到 %s", raw)
	}
}

// 端到端：网关收到图片编辑的 multipart 表单，解析 model、改写后转发，
// 并把上游响应原样返回。
func TestHandleAPIMultipartImageEdit(t *testing.T) {
	var (
		gotModel  string
		gotPrompt string
		gotFile   []byte
		handleErr string
	)
	upstreamSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(8 << 20); err != nil {
			handleErr = "解析表单失败: " + err.Error()
			http.Error(w, "bad form", http.StatusBadRequest)
			return
		}
		gotModel = r.FormValue("model")
		gotPrompt = r.FormValue("prompt")
		f, _, err := r.FormFile("image")
		if err != nil {
			handleErr = "读取图片失败: " + err.Error()
		} else {
			gotFile, _ = io.ReadAll(f)
			f.Close()
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"created":1,"data":[{"b64_json":"QUJD"}]}`)
	}))
	defer upstreamSrv.Close()

	s, st := newTestServer(t, "multipart-image-edit")
	now := time.Now().UnixMilli()
	if err := st.SaveChannel(store.Channel{
		ID: "A", Type: store.ChannelOpenAI, BaseURL: upstreamSrv.URL, APIKey: "sk-up",
		Models: []string{"up-edit"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "img-edit", Type: store.ModelTypeCustom,
		Routes:  []store.Route{{ChannelID: "A", Upstream: "up-edit"}},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveToken(store.Token{ID: "t1", Key: "sk-test", Enabled: true}); err != nil {
		t.Fatal(err)
	}

	gw := httptest.NewServer(s.Handler())
	defer gw.Close()

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	mw.WriteField("model", "img-edit")
	mw.WriteField("prompt", "换成蓝天")
	part, err := mw.CreateFormFile("image", "in.png")
	if err != nil {
		t.Fatal(err)
	}
	part.Write([]byte("PNGDATA"))
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}

	req, err := http.NewRequest(http.MethodPost, gw.URL+"/v1/images/edits", &body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer sk-test")
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)

	if handleErr != "" {
		t.Fatal(handleErr)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("应返回 200，得到 %d（%s）", resp.StatusCode, raw)
	}
	if gotModel != "up-edit" {
		t.Errorf("上游 model 应改写为 up-edit，得到 %q", gotModel)
	}
	if gotPrompt != "换成蓝天" || string(gotFile) != "PNGDATA" {
		t.Errorf("表单字段或文件丢失：prompt=%q file=%q", gotPrompt, gotFile)
	}
	if !strings.Contains(string(raw), "b64_json") {
		t.Errorf("响应应原样返回，得到 %s", raw)
	}
}
