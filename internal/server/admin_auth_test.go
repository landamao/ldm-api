package server

import (
	"net/http"
	"testing"
)

func TestLoginRateKey(t *testing.T) {
	cases := []struct {
		name   string
		remote string
		xff    string
		want   string
	}{
		// 公网 / 内网直连：请求头里的 X-Forwarded-For 一律不认
		{"公网直连忽略伪造头", "203.0.113.9:51234", "1.2.3.4", "203.0.113.9"},
		{"内网直连也不认", "192.168.1.10:5000", "198.51.100.7", "192.168.1.10"},
		{"公网直连无头", "203.0.113.9:51234", "", "203.0.113.9"},

		// 本机反代：取最后一跳（只有这一段是代理追加的）
		{"反代取最后一跳", "127.0.0.1:5000", "6.6.6.6, 198.51.100.7", "198.51.100.7"},
		{"反代单跳", "127.0.0.1:5000", "198.51.100.7", "198.51.100.7"},
		{"IPv6 本机反代", "[::1]:5000", "198.51.100.7", "198.51.100.7"},

		// 非法值必须回落，否则每次换个字符串就是一个新的限流桶
		{"末跳是垃圾串", "127.0.0.1:5000", "not-an-ip", "127.0.0.1"},
		{"末跳垃圾混在前面", "127.0.0.1:5000", "198.51.100.7, x", "127.0.0.1"},
		{"末跳为空", "127.0.0.1:5000", "198.51.100.7, ", "127.0.0.1"},
		{"末跳是 CIDR", "127.0.0.1:5000", "198.51.100.0/24", "127.0.0.1"},

		// 归一化：带端口能解析，IPv6 展开写法要压成同一种
		{"末跳带端口", "127.0.0.1:5000", "198.51.100.7:443", "198.51.100.7"},
		{"IPv6 压缩写法", "127.0.0.1:5000", "2001:db8::1", "2001:db8::1"},
		{"IPv6 展开写法", "127.0.0.1:5000", "2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::1"},

		// RemoteAddr 没有端口时也要能处理
		{"无端口 RemoteAddr", "203.0.113.9", "", "203.0.113.9"},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := &http.Request{RemoteAddr: c.remote, Header: http.Header{}}
			if c.xff != "" {
				r.Header.Set("X-Forwarded-For", c.xff)
			}
			if got := loginRateKey(r); got != c.want {
				t.Fatalf("loginRateKey() = %q, want %q", got, c.want)
			}
		})
	}
}

// 换个伪造头不能换出一个新桶：这是限流能不能被绕过的关键。
func TestLoginRateKeyDoesNotSplitOnGarbage(t *testing.T) {
	for _, junk := range []string{"a", "b", "c", "../../etc", "<script>", "127.0.0.1; DROP"} {
		r := &http.Request{RemoteAddr: "127.0.0.1:5000", Header: http.Header{}}
		r.Header.Set("X-Forwarded-For", junk)
		if k := loginRateKey(r); k != "127.0.0.1" {
			t.Fatalf("伪造值 %q 不应该变成新的限流 key，实际得到 %q", junk, k)
		}
	}
}
