package store

import "testing"

func TestChannelShouldAppendV1(t *testing.T) {
	// 旧数据没有 append_v1 字段，必须按默认开启处理
	var legacy Channel
	if !legacy.ShouldAppendV1() {
		t.Error("未设置 append_v1 时应默认开启")
	}

	off := false
	if (Channel{AppendV1: &off}).ShouldAppendV1() {
		t.Error("显式关闭时应返回 false")
	}

	on := true
	if !(Channel{AppendV1: &on}).ShouldAppendV1() {
		t.Error("显式开启时应返回 true")
	}
}

func TestChannelMultiKeyEnabled(t *testing.T) {
	// 旧数据没有 multi_key 字段：按 Key 数量推断。
	single := Channel{APIKeys: []ChannelKey{{Key: "sk-a"}}}
	if single.MultiKeyEnabled() {
		t.Error("只有一个 Key 的旧数据应视为关闭多 Key 模式")
	}
	legacySingle := Channel{APIKey: "sk-legacy"}
	if legacySingle.MultiKeyEnabled() {
		t.Error("单 Key 旧字段应视为关闭多 Key 模式")
	}
	multi := Channel{APIKeys: []ChannelKey{{Key: "sk-a"}, {Key: "sk-b"}}}
	if !multi.MultiKeyEnabled() {
		t.Error("多个 Key 的旧数据应视为开启多 Key 模式")
	}

	// 显式值优先于 Key 数量。
	on, off := true, false
	if !(Channel{MultiKey: &on}).MultiKeyEnabled() {
		t.Error("显式开启时应返回 true")
	}
	if (Channel{MultiKey: &off, APIKeys: []ChannelKey{{Key: "sk-a"}, {Key: "sk-b"}}}).MultiKeyEnabled() {
		t.Error("显式关闭时应返回 false")
	}
}

func TestChannelKeyList(t *testing.T) {
	ch := Channel{APIKeys: []ChannelKey{
		{Key: "sk-a-12345678", Note: " 主账号 "},
		{Key: "sk-b-12345678"},
		{Key: "sk-a-12345678", Note: "重复的 Key 应被去重"},
		{Key: "   "},
	}}
	keys := ch.Keys()
	if len(keys) != 2 || keys[0] != "sk-a-12345678" || keys[1] != "sk-b-12345678" {
		t.Fatalf("Keys() 应去重并跳过空 Key，得到 %v", keys)
	}
	list := ch.KeyList()
	if len(list) != 2 || list[0].Key != "sk-a-12345678" || list[0].Note != "主账号" {
		t.Fatalf("KeyList() 应保留备注并去掉前后空格，得到 %+v", list)
	}

	// v1.7.0 及更早版本只有 api_key 字段
	legacy := Channel{APIKey: "sk-legacy#12345678"}
	if keys := legacy.Keys(); len(keys) != 1 || keys[0] != "sk-legacy#12345678" {
		t.Errorf("旧数据应回退到 APIKey 且不做 # 解析，得到 %v", keys)
	}
	if list := legacy.KeyList(); len(list) != 1 || list[0].Note != "" {
		t.Errorf("旧数据的 Key 应没有备注，得到 %+v", list)
	}

	// 完全没有 Key 时保留空字符串占位
	empty := Channel{}
	if keys := empty.Keys(); len(keys) != 1 || keys[0] != "" {
		t.Errorf("未配置 Key 时应返回空字符串占位，得到 %v", keys)
	}
}

func TestModelCustomErrorSwitches(t *testing.T) {
	// 旧数据没有两个开关：有状态码即视为开启且始终返回。
	legacy := Model{ErrorStatus: 503}
	if !legacy.CustomErrorEnabled() || !legacy.CustomErrorAlways() {
		t.Error("旧数据有状态码时应视为开启且始终返回")
	}
	if (Model{}).CustomErrorEnabled() || (Model{}).CustomErrorAlways() {
		t.Error("没有状态码的旧数据应视为关闭")
	}

	on, off := true, false
	rewrite := Model{ErrorEnabled: &on, ErrorAlways: &off, ErrorStatus: 429}
	if !rewrite.CustomErrorEnabled() || rewrite.CustomErrorAlways() {
		t.Error("只开总开关时应为失败时重写")
	}
	always := Model{ErrorEnabled: &on, ErrorAlways: &on, ErrorStatus: 429}
	if !always.CustomErrorEnabled() || !always.CustomErrorAlways() {
		t.Error("两个开关都开时应始终返回")
	}
	disabled := Model{ErrorEnabled: &off, ErrorAlways: &on, ErrorStatus: 429}
	if disabled.CustomErrorEnabled() || disabled.CustomErrorAlways() {
		t.Error("总开关关闭时子开关不应生效")
	}
}
