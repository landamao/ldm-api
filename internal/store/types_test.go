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
