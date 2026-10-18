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
