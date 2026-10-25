package relay

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/textproto"
	"net/url"
	"strings"
)

// maxFormMemory 与 handleAPI 读取请求体时的上限一致。
// 图片编辑、语音转写用 multipart/form-data 提交，整段请求体已经读过一次，
// 这里把表单也完整解析在内存里，转发时逐字段重建即可，不依赖临时文件。
const maxFormMemory = maxBodyBytes

// Prepare 解析请求体，得到模型名与请求形式。
//
// 语言模型端点用 JSON，图片编辑 / 语音转写等端点用 multipart/form-data
// 或 application/x-www-form-urlencoded。只按 JSON 解析会拿不到表单里的
// model，调用方会收到「请求体中缺少 model 字段」。表单解析结果保留在
// Request 上，转发到上游时用它重建请求体并把 model 改成渠道的上游模型名。
func (req *Request) Prepare() {
	if req.prepared {
		return
	}
	req.prepared = true

	if req.JSON != nil {
		if req.Model == "" {
			req.Model = jsonModel(req.JSON)
		}
		if v, ok := req.JSON["stream"].(bool); ok {
			req.Stream = v
		}
		return
	}
	if len(req.Body) == 0 {
		req.Model = modelFromPath(req.Path)
		return
	}

	ct, _, _ := mime.ParseMediaType(req.Header.Get("Content-Type"))
	switch {
	case strings.EqualFold(ct, "multipart/form-data"):
		form, err := parseMultipartForm(req.Header.Get("Content-Type"), req.Body)
		if err == nil {
			req.multipartForm = form
			req.Model = firstFormValue(form.Value, "model")
			req.Stream = formBool(form.Value, "stream")
		}
	case strings.EqualFold(ct, "application/x-www-form-urlencoded"):
		values, err := url.ParseQuery(string(req.Body))
		if err == nil {
			req.formValues = values
			req.Model = values.Get("model")
			req.Stream = formBool(values, "stream")
		}
	default:
		// 没带 Content-Type 的 JSON 请求同样按 JSON 解析，保持原有行为。
		var m map[string]any
		dec := json.NewDecoder(bytes.NewReader(req.Body))
		dec.UseNumber()
		if err := dec.Decode(&m); err == nil {
			req.JSON = m
			req.Model = jsonModel(m)
			if v, ok := m["stream"].(bool); ok {
				req.Stream = v
			}
		}
	}
	if req.Model == "" {
		// 旧版 OpenAI engines 嵌入端点把模型名写在路径里。
		req.Model = modelFromPath(req.Path)
	}
	if req.Model == "" {
		req.Model = defaultModelForPath(req.Path)
	}
}

// defaultModelForPath 为允许省略 model 的端点补上默认模型名，和 new-api 保持一致：
// 音频转写/翻译用 whisper-1，语音合成用 tts-1，内容审核用 text-moderation-stable。
// 这些名字仍需要在模型管理里配置成同名 ID 才能路由；没配置时会返回模型不存在，
// 比笼统的「缺少 model 字段」更容易定位。
func defaultModelForPath(path string) string {
	switch strings.TrimSuffix(path, "/") {
	case "/v1/audio/transcriptions", "/v1/audio/translations":
		return "whisper-1"
	case "/v1/audio/speech":
		return "tts-1"
	case "/v1/moderations":
		return "text-moderation-stable"
	}
	return ""
}

// jsonModel 从 JSON 请求体里取模型名。
func jsonModel(m map[string]any) string {
	if s, ok := m["model"].(string); ok {
		return s
	}
	return ""
}

// modelFromPath 从 /v1/engines/{model}/embeddings 这类路径里取模型名。
func modelFromPath(path string) string {
	p := strings.TrimSuffix(path, "/")
	const prefix = "/v1/engines/"
	const suffix = "/embeddings"
	if !strings.HasPrefix(p, prefix) || !strings.HasSuffix(p, suffix) {
		return ""
	}
	raw := strings.TrimSuffix(strings.TrimPrefix(p, prefix), suffix)
	if raw == "" || strings.Contains(raw, "/") {
		return ""
	}
	if v, err := url.PathUnescape(raw); err == nil {
		return v
	}
	return raw
}

// parseMultipartForm 按 Content-Type 里的 boundary 解析表单。
func parseMultipartForm(contentType string, body []byte) (*multipart.Form, error) {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return nil, err
	}
	boundary := params["boundary"]
	if boundary == "" {
		return nil, errors.New("multipart 缺少 boundary")
	}
	return multipart.NewReader(bytes.NewReader(body), boundary).ReadForm(maxFormMemory)
}

// firstFormValue 返回同名表单字段里第一个非空值。
func firstFormValue(values map[string][]string, key string) string {
	for _, v := range values[key] {
		if v != "" {
			return v
		}
	}
	return ""
}

// formBool 解析表单里的布尔字段（不同客户端会写 true / 1 / yes）。
func formBool(values map[string][]string, key string) bool {
	switch strings.ToLower(strings.TrimSpace(firstFormValue(values, key))) {
	case "true", "1", "yes", "on":
		return true
	}
	return false
}

// rebuildMultipart 用解析好的表单重建请求体，并把 model 换成上游模型名。
// 文件内容、字段名和文件名保持原样；boundary 重新生成，同时返回新的
// Content-Type 供转发请求使用。
func rebuildMultipart(form *multipart.Form, upstreamModel string) ([]byte, string, error) {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	if err := w.WriteField("model", upstreamModel); err != nil {
		return nil, "", err
	}
	for name, values := range form.Value {
		if name == "model" {
			continue
		}
		for _, v := range values {
			if err := w.WriteField(name, v); err != nil {
				return nil, "", err
			}
		}
	}
	for name, files := range form.File {
		for _, fh := range files {
			if err := copyFormFile(w, name, fh); err != nil {
				return nil, "", err
			}
		}
	}
	if err := w.Close(); err != nil {
		return nil, "", err
	}
	return buf.Bytes(), w.FormDataContentType(), nil
}

// copyFormFile 把表单里的一个文件原样写入新的 multipart 请求体。
func copyFormFile(w *multipart.Writer, field string, fh *multipart.FileHeader) error {
	f, err := fh.Open()
	if err != nil {
		return err
	}
	defer f.Close()

	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", `form-data; name="`+escapeFormQuotes(field)+
		`"; filename="`+escapeFormQuotes(fh.Filename)+`"`)
	contentType := fh.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	h.Set("Content-Type", contentType)

	part, err := w.CreatePart(h)
	if err != nil {
		return err
	}
	_, err = io.Copy(part, f)
	return err
}

var formQuoteEscaper = strings.NewReplacer("\\", "\\\\", `"`, "\\\"")

func escapeFormQuotes(s string) string { return formQuoteEscaper.Replace(s) }

// replaceFormModel 复制一份 urlencoded 表单并替换 model，保持其它字段不变。
func replaceFormModel(values url.Values, upstreamModel string) string {
	next := make(url.Values, len(values))
	for k, vs := range values {
		next[k] = append([]string(nil), vs...)
	}
	next.Set("model", upstreamModel)
	return next.Encode()
}

// formTextOf 取出表单里用于估算用量的文本字段（图片/语音端点没有 token 概念，
// 只把 prompt 之类的文本计入输入）。
func formTextOf(req *Request, fields ...string) string {
	var sb strings.Builder
	for _, f := range fields {
		if req.multipartForm != nil {
			for _, v := range req.multipartForm.Value[f] {
				sb.WriteString(v)
				sb.WriteString("\n")
			}
		} else if req.formValues != nil {
			sb.WriteString(req.formValues.Get(f))
		}
	}
	return sb.String()
}
