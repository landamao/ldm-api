package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ldmapi/internal/store"
)

// seedRouteModel 添加一个自定义模型，路由指向指定渠道模型。
func seedRouteModel(t *testing.T, st *store.Store, id string, routes []store.Route) {
	t.Helper()
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: id, Type: store.ModelTypeCustom, Routes: routes,
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
}

// 图片编辑使用 multipart/form-data，网关必须从表单里读出 model，
// 并在转发时把它改成渠道的上游模型名，同时保留文件与其它字段。
func TestMultipartImageEditRewritesModel(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()

	var (
		gotPath        string
		gotContentType string
		gotModel       string
		gotPrompt      string
		gotFile        []byte
		handleErr      string
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotContentType = r.Header.Get("Content-Type")
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
	defer srv.Close()

	st := newTestStore(t)
	now := time.Now().UnixMilli()
	if err := st.SaveChannel(store.Channel{
		ID: "A", Name: "图片线路", Type: store.ChannelOpenAI, BaseURL: srv.URL,
		APIKey: "sk-up", Models: []string{"gpt-image-1"}, Enabled: true,
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	seedRouteModel(t, st, "img-edit", []store.Route{{ChannelID: "A", Upstream: "gpt-image-1"}})

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	if err := mw.WriteField("model", "img-edit"); err != nil {
		t.Fatal(err)
	}
	if err := mw.WriteField("prompt", "把背景换成蓝天"); err != nil {
		t.Fatal(err)
	}
	part, err := mw.CreateFormFile("image", "input.png")
	if err != nil {
		t.Fatal(err)
	}
	part.Write([]byte("PNGDATA"))
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}

	req := &Request{
		Path:   "/v1/images/edits",
		Method: http.MethodPost,
		Header: http.Header{"Content-Type": []string{mw.FormDataContentType()}},
		Body:   body.Bytes(),
	}
	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, req)

	if handleErr != "" {
		t.Fatal(handleErr)
	}
	if rec.Code != http.StatusOK || res.Err != "" {
		t.Fatalf("请求失败 %d: %s / %s", rec.Code, rec.Body.String(), res.Err)
	}
	if res.ModelID != "img-edit" {
		t.Errorf("日志里的请求模型应为 img-edit，得到 %q", res.ModelID)
	}
	if gotPath != "/v1/images/edits" {
		t.Errorf("上游路径 = %q", gotPath)
	}
	if gotModel != "gpt-image-1" {
		t.Errorf("上游收到的 model 应改写为 gpt-image-1，得到 %q", gotModel)
	}
	if gotPrompt != "把背景换成蓝天" {
		t.Errorf("表单字段丢失，prompt = %q", gotPrompt)
	}
	if string(gotFile) != "PNGDATA" {
		t.Errorf("图片内容应原样转发，得到 %q", string(gotFile))
	}
	if !strings.HasPrefix(gotContentType, "multipart/form-data; boundary=") {
		t.Errorf("上游 Content-Type 应为 multipart，得到 %q", gotContentType)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Errorf("响应 Content-Type 应透传上游，得到 %q", ct)
	}
	if res.Usage.PromptTokens == 0 {
		t.Error("表单里的 prompt 应计入输入 token 估算")
	}
}

// application/x-www-form-urlencoded 提交的图片编辑同样要能解析并改写 model。
func TestFormURLEncodedModelRewrite(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()

	var gotForm, gotModel string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotForm = r.Header.Get("Content-Type")
		gotModel = r.PostFormValue("model")
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"created":1,"data":[]}`)
	}))
	defer srv.Close()

	st := newTestStore(t)
	now := time.Now().UnixMilli()
	if err := st.SaveChannel(store.Channel{
		ID: "A", Type: store.ChannelOpenAI, BaseURL: srv.URL,
		Models: []string{"up-edit"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	seedRouteModel(t, st, "form-edit", []store.Route{{ChannelID: "A", Upstream: "up-edit"}})

	req := &Request{
		Path:   "/v1/images/edits",
		Method: http.MethodPost,
		Header: http.Header{"Content-Type": []string{"application/x-www-form-urlencoded"}},
		Body:   []byte("model=form-edit&prompt=hello"),
	}
	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, req)
	if rec.Code != http.StatusOK || res.Err != "" {
		t.Fatalf("请求失败 %d: %s / %s", rec.Code, rec.Body.String(), res.Err)
	}
	if gotModel != "up-edit" {
		t.Errorf("上游收到的 model 应为 up-edit，得到 %q", gotModel)
	}
	if !strings.HasPrefix(gotForm, "application/x-www-form-urlencoded") {
		t.Errorf("上游 Content-Type = %q", gotForm)
	}
}

// 语音合成是 JSON 请求 + 二进制响应：模型名要改写，音频内容和
// Content-Type 必须原样返回，不能被当成 JSON 处理。
func TestAudioSpeechBinaryResponsePassthrough(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()

	audio := []byte("ID3\x04\x00\x00\x00fake-mp3")
	var gotModel string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in map[string]any
		_ = json.NewDecoder(r.Body).Decode(&in)
		gotModel, _ = in["model"].(string)
		w.Header().Set("Content-Type", "audio/mpeg")
		w.Write(audio)
	}))
	defer srv.Close()

	st := newTestStore(t)
	now := time.Now().UnixMilli()
	if err := st.SaveChannel(store.Channel{
		ID: "A", Type: store.ChannelOpenAI, BaseURL: srv.URL,
		Models: []string{"tts-up"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	seedRouteModel(t, st, "tts", []store.Route{{ChannelID: "A", Upstream: "tts-up"}})

	payload := `{"model":"tts","input":"你好","voice":"alloy"}`
	req := &Request{
		Path:   "/v1/audio/speech",
		Method: http.MethodPost,
		Header: http.Header{"Content-Type": []string{"application/json"}, "Accept": []string{"audio/mpeg"}},
		Body:   []byte(payload),
	}
	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, req)
	if rec.Code != http.StatusOK || res.Err != "" {
		t.Fatalf("请求失败 %d: %s / %s", rec.Code, rec.Body.String(), res.Err)
	}
	if gotModel != "tts-up" {
		t.Errorf("上游收到的 model 应为 tts-up，得到 %q", gotModel)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "audio/mpeg" {
		t.Errorf("音频 Content-Type 应原样返回，得到 %q", ct)
	}
	if !bytes.Equal(rec.Body.Bytes(), audio) {
		t.Errorf("音频内容应原样返回，得到 %q", rec.Body.Bytes())
	}
}

// 表单里缺少 model 时仍然返回明确的 400，且不会请求上游。
func TestMultipartMissingModel(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
	}))
	defer srv.Close()

	st := newTestStore(t)
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	mw.WriteField("prompt", "no model")
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req := &Request{
		Path:   "/v1/images/edits",
		Method: http.MethodPost,
		Header: http.Header{"Content-Type": []string{mw.FormDataContentType()}},
		Body:   body.Bytes(),
	}
	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("应返回 400，得到 %d（%s）", rec.Code, rec.Body.String())
	}
	if res.ClientErr != "请求体中缺少 model 字段" {
		t.Errorf("错误文案 = %q", res.ClientErr)
	}
	if hits != 0 {
		t.Errorf("缺少 model 时不应请求上游，实际 %d 次", hits)
	}
}

// 旧版 engines 嵌入端点把模型名写在路径里，也要能解析出来。
func TestPrepareModelFromEnginesPath(t *testing.T) {
	req := &Request{
		Path:   "/v1/engines/text-embedding-3-small/embeddings",
		Method: http.MethodPost,
		Header: http.Header{"Content-Type": []string{"application/json"}},
		Body:   []byte(`{"input":"hello"}`),
	}
	req.Prepare()
	if req.Model != "text-embedding-3-small" {
		t.Errorf("应从路径解析出模型名，得到 %q", req.Model)
	}
	if req.JSON == nil {
		t.Error("JSON 请求体应被解析")
	}
}

// 嵌入模型：模型名要改写，上游返回的 usage 要记账。
func TestEmbeddingRequestRewriteAndUsage(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()

	var gotModel, gotInput string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in map[string]any
		_ = json.NewDecoder(r.Body).Decode(&in)
		gotModel, _ = in["model"].(string)
		gotInput, _ = in["input"].(string)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"object":"list","data":[{"object":"embedding","index":0,"embedding":[0.1]}],`+
			`"usage":{"prompt_tokens":3,"total_tokens":3}}`)
	}))
	defer srv.Close()

	st := newTestStore(t)
	now := time.Now().UnixMilli()
	if err := st.SaveChannel(store.Channel{
		ID: "A", Type: store.ChannelOpenAI, BaseURL: srv.URL,
		Models: []string{"embed-up"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	seedRouteModel(t, st, "embed", []store.Route{{ChannelID: "A", Upstream: "embed-up"}})

	req := &Request{
		Path:   "/v1/embeddings",
		Method: http.MethodPost,
		Header: http.Header{"Content-Type": []string{"application/json"}},
		Body:   []byte(`{"model":"embed","input":"hello"}`),
	}
	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, req)
	if rec.Code != http.StatusOK || res.Err != "" {
		t.Fatalf("请求失败 %d: %s / %s", rec.Code, rec.Body.String(), res.Err)
	}
	if gotModel != "embed-up" || gotInput != "hello" {
		t.Errorf("上游收到 model=%q input=%q", gotModel, gotInput)
	}
	if res.Usage.PromptTokens != 3 {
		t.Errorf("应记录上游上报的用量，得到 %+v", res.Usage)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Errorf("响应 Content-Type = %q", ct)
	}
}

// 语音转写：允许省略 model（按 OpenAI 默认的 whisper-1 路由），
// 表单文件原样转发，响应文本原样返回。
func TestAudioTranscriptionMultipartDefaultModel(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()

	var (
		gotModel  string
		gotFile   []byte
		handleErr string
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(8 << 20); err != nil {
			handleErr = "解析表单失败: " + err.Error()
			http.Error(w, "bad form", http.StatusBadRequest)
			return
		}
		gotModel = r.FormValue("model")
		f, _, err := r.FormFile("file")
		if err != nil {
			handleErr = "读取音频失败: " + err.Error()
		} else {
			gotFile, _ = io.ReadAll(f)
			f.Close()
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"text":"你好"}`)
	}))
	defer srv.Close()

	st := newTestStore(t)
	now := time.Now().UnixMilli()
	if err := st.SaveChannel(store.Channel{
		ID: "A", Type: store.ChannelOpenAI, BaseURL: srv.URL,
		Models: []string{"stt-up"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	seedRouteModel(t, st, "whisper-1", []store.Route{{ChannelID: "A", Upstream: "stt-up"}})

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, err := mw.CreateFormFile("file", "audio.mp3")
	if err != nil {
		t.Fatal(err)
	}
	part.Write([]byte("MP3DATA"))
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}

	req := &Request{
		Path:   "/v1/audio/transcriptions",
		Method: http.MethodPost,
		Header: http.Header{"Content-Type": []string{mw.FormDataContentType()}},
		Body:   body.Bytes(),
	}
	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, req)
	if handleErr != "" {
		t.Fatal(handleErr)
	}
	if rec.Code != http.StatusOK || res.Err != "" {
		t.Fatalf("请求失败 %d: %s / %s", rec.Code, rec.Body.String(), res.Err)
	}
	if gotModel != "stt-up" {
		t.Errorf("省略 model 时应按 whisper-1 路由并改写成 stt-up，得到 %q", gotModel)
	}
	if string(gotFile) != "MP3DATA" {
		t.Errorf("音频内容应原样转发，得到 %q", string(gotFile))
	}
	if !strings.Contains(rec.Body.String(), `"text":"你好"`) {
		t.Errorf("转写结果应原样返回，得到 %s", rec.Body.String())
	}
}
