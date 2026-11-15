package upstream

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// NormalizeProxyURL 校验渠道代理地址。空值沿用环境代理，错误不包含用户填写的认证信息。
func NormalizeProxyURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", errors.New("代理地址格式有误，请填写 协议://主机:端口")
	}
	u.Scheme = strings.ToLower(u.Scheme)
	switch u.Scheme {
	case "http", "https", "socks5", "socks5h":
	default:
		return "", errors.New("代理地址仅支持 http://、https://、socks5://、socks5h://")
	}
	if u.Opaque != "" || u.Host == "" || u.Hostname() == "" {
		return "", errors.New("代理地址缺少主机，请填写 协议://主机:端口")
	}
	host := u.Hostname()
	if strings.ContainsAny(host, " \t\r\n/\\?#@") {
		return "", errors.New("代理主机格式有误")
	}
	if strings.HasPrefix(u.Host, "[") {
		// 方括号只用于 IPv6；保留本地链路地址的 zone（例如 %25eth0）。
		ip, _, _ := strings.Cut(host, "%")
		if !strings.Contains(ip, ":") || net.ParseIP(ip) == nil {
			return "", errors.New("代理 IPv6 地址格式有误")
		}
	} else if strings.Contains(host, ":") || strings.ContainsAny(host, "[]%") {
		return "", errors.New("代理主机格式有误，IPv6 地址需要用方括号包围")
	}
	if strings.HasSuffix(u.Host, ":") {
		return "", errors.New("代理端口不能为空")
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return "", errors.New("代理端口必须是 1–65535 的整数")
		}
	}
	if (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.ForceQuery || strings.Contains(raw, "#") {
		return "", errors.New("代理地址不能包含路径、查询参数或片段")
	}
	if u.User != nil {
		password, _ := u.User.Password()
		if u.User.Username() == "****" || password == "****" {
			return "", errors.New("代理认证信息已隐藏，更换代理时请填写完整的用户名和密码")
		}
	}
	u.Path, u.RawPath = "", ""
	return u.String(), nil
}

// MaskProxyURL 只向管理界面返回代理服务器地址，隐藏用户名和密码。
func MaskProxyURL(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "（代理地址格式有误，请重新填写）"
	}
	if u.User == nil {
		return raw
	}
	u.User = nil
	return strings.Replace(u.String(), "://", "://****:****@", 1)
}

type proxyContextKey struct{}

// WithProxy 将渠道代理绑定到本次请求；重定向和取消仍沿用原请求的上下文。
func WithProxy(req *http.Request, proxyURL string) *http.Request {
	return req.WithContext(context.WithValue(req.Context(), proxyContextKey{}, proxyURL))
}

// ProxyForRequest 供共享 Transport 使用。连接池由标准库按完整代理地址隔离，
// 不修改运行中的 Transport，也不会在代理配置无效时退回直连。
func ProxyForRequest(req *http.Request) (*url.URL, error) {
	raw, _ := req.Context().Value(proxyContextKey{}).(string)
	normalized, err := NormalizeProxyURL(raw)
	if err != nil {
		return nil, err
	}
	if normalized == "" {
		return http.ProxyFromEnvironment(req)
	}
	return url.Parse(normalized)
}
