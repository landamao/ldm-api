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
	// 没有配置开关时一律视为关闭，不能仅凭状态码推断。
	if (Model{}).CustomErrorEnabled() || (Model{}).CustomErrorAlways() {
		t.Error("未配置开关时应为关闭")
	}
	statusOnly := Model{ErrorStatus: 503}
	if statusOnly.CustomErrorEnabled() || statusOnly.CustomErrorAlways() {
		t.Error("只有状态码、没有开关时应视为关闭")
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
	keep := Model{ErrorEnabled: &on, ErrorKeepNoRetry: &on}
	if !keep.CustomErrorKeepNoRetry() {
		t.Error("总开关开启时应读取保留不可重试状态码的开关")
	}
	if !(Model{ErrorEnabled: &on}).CustomErrorKeepNoRetry() {
		t.Error("未设置保留开关时应默认开启")
	}
	if (Model{ErrorEnabled: &on, ErrorKeepNoRetry: &off}).CustomErrorKeepNoRetry() {
		t.Error("显式关闭时保留开关不应生效")
	}
	if (Model{ErrorEnabled: &off, ErrorKeepNoRetry: &on}).CustomErrorKeepNoRetry() {
		t.Error("总开关关闭时保留开关不应生效")
	}
}

func TestModelCustomErrorAsContentSwitch(t *testing.T) {
	on, off := true, false
	if (Model{}).CustomErrorAsContent() {
		t.Error("未配置开关时不应覆写为正文")
	}
	// 覆写为正文属于错误覆写的子项：总开关关闭时不生效。
	if (Model{ErrorEnabled: &off, ErrorAsContent: &on}).CustomErrorAsContent() {
		t.Error("总开关关闭时覆写为正文不应生效")
	}
	asContent := Model{ErrorEnabled: &on, ErrorAsContent: &on, ErrorKeepNoRetry: &on}
	if !asContent.CustomErrorAsContent() {
		t.Error("总开关与覆写为正文都开时应生效")
	}
	// 跳过不可重试状态码与覆写为正文互不影响：两者可以同时生效。
	if !asContent.CustomErrorKeepNoRetry() {
		t.Error("覆写为正文时跳过不可重试状态码也应继续生效")
	}
}

func TestModelCustomContentSwitch(t *testing.T) {
	if (Model{}).CustomContentEnabled() {
		t.Error("未配置开关时应为关闭")
	}
	textOnly := Model{ContentText: "好的"}
	if textOnly.CustomContentEnabled() {
		t.Error("只有内容、没有开关时应视为关闭")
	}
	on, off := true, false
	if !(Model{ContentEnabled: &on}).CustomContentEnabled() {
		t.Error("开启后应生效")
	}
	if (Model{ContentEnabled: &off}).CustomContentEnabled() {
		t.Error("关闭后不应生效")
	}
}

func TestModelSystemPromptSwitch(t *testing.T) {
	if (Model{}).SystemPromptEnabled() {
		t.Error("未配置开关时应为关闭")
	}
	textOnly := Model{SystemPrompt: "你是懒大猫"}
	if textOnly.SystemPromptEnabled() {
		t.Error("只有提示词、没有开关时应视为关闭")
	}
	on, off := true, false
	if !(Model{SystemPromptOn: &on}).SystemPromptEnabled() {
		t.Error("开启后应生效")
	}
	if (Model{SystemPromptOn: &off}).SystemPromptEnabled() {
		t.Error("关闭后不应生效")
	}
}

// 失败判定：客户端取消与错误覆写「覆写为正文」都不算失败。
func TestLogFailed(t *testing.T) {
	cases := []struct {
		name string
		log  Log
		want bool
	}{
		{"正常 200", Log{StatusCode: 200}, false},
		{"503 失败", Log{StatusCode: 503}, true},
		{"200 但内部原因非空", Log{StatusCode: 200, Error: "流式中途断开"}, true},
		{"客户端取消", Log{StatusCode: 200, Error: "客户端已断开连接", Canceled: true}, false},
		{"覆写为正文", Log{StatusCode: 200, Error: "upstream status 500", AsContent: true}, false},
	}
	for _, tc := range cases {
		if got := tc.log.Failed(); got != tc.want {
			t.Errorf("%s: Failed()=%v，期望 %v", tc.name, got, tc.want)
		}
	}
}
