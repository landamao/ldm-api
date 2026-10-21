package server

import (
	"bytes"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// chatDirectClient 专门给在线聊天的「临时测试」使用：
// 上游地址由管理员临时填写，连接池和超时都不跟渠道配置共用。
// 不设置 Client.Timeout，流式回复可能持续很久，由请求上下文负责取消。
var chatDirectClient = &http.Client{
	Transport: &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   20 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:          50,
		MaxIdleConnsPerHost:   10,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   20 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		ResponseHeaderTimeout: 300 * time.Second,
		ForceAttemptHTTP2:     true,
	},
}

// chatDirect 把在线聊天的请求原样转发到临时填写的上游。
// 与正式调用最大的区别：不查渠道、不查模型、不写日志与统计。
func (s *Server) chatDirect(w http.ResponseWriter, r *http.Request, body []byte, stream bool, baseURL, apiKey string) {
	target, err := chatDirectURL(baseURL)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	upReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "API 地址格式不正确")
		return
	}
	upReq.Header.Set("Content-Type", "application/json")
	if stream {
		upReq.Header.Set("Accept", "text/event-stream")
	} else {
		upReq.Header.Set("Accept", "application/json")
	}
	if key := strings.TrimSpace(apiKey); key != "" {
		upReq.Header.Set("Authorization", "Bearer "+key)
	}

	resp, err := chatDirectClient.Do(upReq)
	if err != nil {
		// 客户端主动停止时上游请求会跟着取消，不用再回一条错误
		if r.Context().Err() != nil {
			return
		}
		writeErr(w, http.StatusBadGateway, "请求上游失败："+truncateErr(err.Error()))
		return
	}
	defer resp.Body.Close()

	// 上游的状态码、内容类型和响应体都原样透传：
	// 前端按 Content-Type 判断流式 / 非流式，错误体也能保持上游原文。
	h := w.Header()
	ct := resp.Header.Get("Content-Type")
	if ct != "" {
		h.Set("Content-Type", ct)
	}
	if strings.Contains(strings.ToLower(ct), "text/event-stream") {
		h.Set("Cache-Control", "no-cache")
		h.Set("Connection", "keep-alive")
		h.Set("X-Accel-Buffering", "no")
	}
	w.WriteHeader(resp.StatusCode)
	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}

	buf := make([]byte, 32*1024)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if rerr != nil {
			return
		}
	}
}

// chatDirectURL 把用户填写的地址规范成 OpenAI 兼容的 chat/completions 端点。
// 三种写法都支持：
//   - 完整端点：https://api.example.com/v1/chat/completions
//   - 带版本段的基础地址：https://api.example.com/v1、https://ark.example.com/api/v3
//   - 裸域名：https://api.example.com（自动补 /v1）
func chatDirectURL(base string) (string, error) {
	base = strings.TrimSpace(base)
	if base == "" {
		return "", errors.New("请填写 API 地址")
	}
	if !strings.Contains(base, "://") {
		base = "https://" + base
	}
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || !validDirectHost(u) {
		return "", errors.New("API 地址格式不正确，需要以 http:// 或 https:// 开头")
	}

	p := strings.TrimRight(u.Path, "/")
	switch {
	case strings.HasSuffix(strings.ToLower(p), "/chat/completions"):
		// 已经是完整端点
	case hasVersionSuffix(p):
		p += "/chat/completions"
	default:
		p += "/v1/chat/completions"
	}
	u.Path = p
	u.Fragment = ""
	return u.String(), nil
}

// validDirectHost 排除 "https://::" 这类能被 url.Parse 接受、但实际无法拨号的地址。
func validDirectHost(u *url.URL) bool {
	host := u.Hostname()
	if host == "" {
		return false
	}
	if strings.HasPrefix(u.Host, "[") {
		return net.ParseIP(host) != nil
	}
	return !strings.ContainsAny(host, ":[]@ ")
}

// hasVersionSuffix 判断路径最后一段是否形如 v1 / v2 / v1beta / v3alpha。
// 和 upstream.JoinURL 的版本段识别保持一致。
func hasVersionSuffix(p string) bool {
	if p == "" {
		return false
	}
	seg := p[strings.LastIndexByte(p, '/')+1:]
	if len(seg) < 2 || seg[0] != 'v' || seg[1] < '0' || seg[1] > '9' {
		return false
	}
	i := 1
	for i < len(seg) && seg[i] >= '0' && seg[i] <= '9' {
		i++
	}
	if strings.HasPrefix(seg[i:], "alpha") {
		i += len("alpha")
	} else if strings.HasPrefix(seg[i:], "beta") {
		i += len("beta")
	}
	for i < len(seg) && seg[i] >= '0' && seg[i] <= '9' {
		i++
	}
	return i == len(seg)
}
