package store

import "testing"

func TestParseStatusSet(t *testing.T) {
	set, err := ParseStatusSet("400, 404-408，429; 500-599")
	if err != nil {
		t.Fatal(err)
	}
	for _, code := range []int{400, 404, 406, 408, 429, 500, 550, 599} {
		if !set.Match(code) {
			t.Errorf("%d 应命中规则", code)
		}
	}
	for _, code := range []int{399, 401, 403, 409, 430, 499, 600} {
		if set.Match(code) {
			t.Errorf("%d 不应命中规则", code)
		}
	}

	empty, err := ParseStatusSet("   ")
	if err != nil {
		t.Fatal(err)
	}
	if !empty.Empty() || empty.Match(400) {
		t.Error("空规则应不匹配任何状态码")
	}
}

func TestNormalizeStatusSet(t *testing.T) {
	got, err := NormalizeStatusSet(" 400 , 404-408，429 429 404-408 ")
	if err != nil {
		t.Fatal(err)
	}
	if got != "400,404-408,429" {
		t.Fatalf("规范化结果错误: %q", got)
	}
	if got, err := NormalizeStatusSet(""); err != nil || got != "" {
		t.Fatalf("空规则应原样返回空字符串: %q %v", got, err)
	}
}

func TestParseStatusSetInvalid(t *testing.T) {
	for _, raw := range []string{"99", "600", "400-399", "400-", "-400", "abc", "400-abc"} {
		if _, err := NormalizeStatusSet(raw); err == nil {
			t.Errorf("%q 应被判定为非法规则", raw)
		}
	}
}

func TestStatusSetDefaults(t *testing.T) {
	// 未配置：视为空规则，所有状态码都可重试 / 不冷却 Key
	var m Model
	if !m.NoRetryStatusSet().Empty() {
		t.Error("未配置的模型不应有不可重试状态码")
	}
	var c Channel
	if !c.KeyCooldownStatusSet().Empty() {
		t.Error("未配置的渠道不应有 Key 冷却状态码")
	}

	// 显式空字符串：同样关闭对应行为
	empty := ""
	if !(Model{NoRetryStatus: &empty}).NoRetryStatusSet().Empty() {
		t.Error("显式空字符串应表示没有不可重试状态码")
	}
	if !(Channel{KeyCooldownStatus: &empty}).KeyCooldownStatusSet().Empty() {
		t.Error("显式空字符串应表示没有 Key 冷却状态码")
	}

	// 手工改坏的数据也按空规则处理
	bad := "oops"
	if !(Model{NoRetryStatus: &bad}).NoRetryStatusSet().Empty() {
		t.Error("非法数据应视为没有不可重试状态码")
	}
	if !(Channel{KeyCooldownStatus: &bad}).KeyCooldownStatusSet().Empty() {
		t.Error("非法数据应视为没有 Key 冷却状态码")
	}
}
