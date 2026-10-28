package upstream

import "testing"

// 分块里的正文、思考、工具调用要按顺序聚合到一起。
func TestCollectorAggregatesChunks(t *testing.T) {
	c := NewCollector()
	c.Feed([]byte(`data: {"id":"chatcmpl-1","model":"up","created":1700,"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}` + "\n\n"))
	c.Feed([]byte(`data: {"choices":[{"index":0,"delta":{"reasoning_content":"想"}}]}` + "\n\n"))
	c.Feed([]byte(`data: {"choices":[{"index":0,"delta":{"content":"你"}}]}` + "\n\n"))
	// 半行 + 后续数据，验证跨段拼接
	c.Feed([]byte(`data: {"choices":[{"index":0,"delta":{"content":"好"}}]}` + "\n\ndata: {\"choices\":[{\"index\":0,\"del"))
	c.Feed([]byte(`ta":{"content":"！"},"finish_reason":"stop"}]}` + "\n\n"))
	c.Feed([]byte("data: [DONE]\n\n"))

	if c.ID != "chatcmpl-1" || c.Model != "up" || c.Created != 1700 {
		t.Fatalf("响应标识未取到: %+v", c)
	}
	if got := c.Content.String(); got != "你好！" {
		t.Fatalf("正文聚合错误: %q", got)
	}
	if got := c.Reasoning.String(); got != "想" {
		t.Fatalf("思考聚合错误: %q", got)
	}
	if c.Finish != "stop" {
		t.Fatalf("finish_reason 应为 stop，实际 %q", c.Finish)
	}
}

// 多个工具调用的参数要按 index 归位，不能串到别的调用上。
func TestCollectorMergesToolCallsByIndex(t *testing.T) {
	c := NewCollector()
	c.Feed([]byte(`data: {"choices":[{"index":0,"delta":{"tool_calls":[` +
		`{"index":0,"id":"call_a","type":"function","function":{"name":"a","arguments":"{\"x\""}},` +
		`{"index":1,"id":"call_b","type":"function","function":{"name":"b","arguments":""}}]}}]}` + "\n\n"))
	c.Feed([]byte(`data: {"choices":[{"index":0,"delta":{"tool_calls":[` +
		`{"index":1,"function":{"arguments":"{\"y\":2}"}},` +
		`{"index":0,"function":{"arguments":":1}"}}]}}]}` + "\n\n"))

	if len(c.ToolCalls) != 2 {
		t.Fatalf("应聚合出两个工具调用: %+v", c.ToolCalls)
	}
	if c.ToolCalls[0].ID != "call_a" || c.ToolCalls[0].Name != "a" || c.ToolCalls[0].Arguments != `{"x":1}` {
		t.Fatalf("第一个工具调用错误: %+v", c.ToolCalls[0])
	}
	if c.ToolCalls[1].ID != "call_b" || c.ToolCalls[1].Arguments != `{"y":2}` {
		t.Fatalf("第二个工具调用错误: %+v", c.ToolCalls[1])
	}
}

// content 用数组下发时要拼成文本；reasoning 字段名也要兼容。
func TestCollectorAcceptsArrayContent(t *testing.T) {
	c := NewCollector()
	c.Feed([]byte(`data: {"choices":[{"index":0,"delta":{"content":[{"type":"text","text":"甲"},{"type":"text","text":"乙"}],"reasoning":"想"}}]}` + "\n\n"))

	if got := c.Content.String(); got != "甲乙" {
		t.Fatalf("数组内容应拼成文本: %q", got)
	}
	if got := c.Reasoning.String(); got != "想" {
		t.Fatalf("reasoning 字段应兼容: %q", got)
	}
	if c.Chunks() != 1 {
		t.Fatalf("应解析出 1 个数据块，实际 %d", c.Chunks())
	}
}

// n > 1 时只聚合第一个候选，不能把多个候选的正文拼在一起。
func TestCollectorKeepsFirstChoiceOnly(t *testing.T) {
	c := NewCollector()
	c.Feed([]byte(`data: {"choices":[{"index":0,"delta":{"content":"A"}},{"index":1,"delta":{"content":"B"}}]}` + "\n\n"))
	c.Feed([]byte(`data: {"choices":[{"index":1,"delta":{"content":"C"},"finish_reason":"stop"}]}` + "\n\n"))
	c.Feed([]byte(`data: {"choices":[{"index":0,"delta":{"content":"D"},"finish_reason":"stop"}]}` + "\n\n"))

	if got := c.Content.String(); got != "AD" {
		t.Fatalf("只应聚合第一个候选: %q", got)
	}
}

// 判断「第一段真实内容」：只有带正文、思考或工具调用的块才算首字。
func TestHasVisibleDelta(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"只带 role", `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}`, false},
		{"只有用量", `data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":0}}`, false},
		{"结束标记", `data: [DONE]`, false},
		{"空 delta", `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`, false},
		{"正文", `data: {"choices":[{"index":0,"delta":{"content":"你"}}]}`, true},
		{"思考", `data: {"choices":[{"index":0,"delta":{"reasoning_content":"想"}}]}`, true},
		{"思考旧字段", `data: {"choices":[{"index":0,"delta":{"reasoning":"想"}}]}`, true},
		{"工具调用", `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"f","arguments":""}}]}}]}`, true},
		{"非零候选不算", `data: {"choices":[{"index":1,"delta":{"content":"B"}}]}`, false},
		{"Responses 正文增量", `data: {"type":"response.output_text.delta","delta":"你"}`, true},
		{"Responses 完成事件", `data: {"type":"response.completed","response":{"output":[]}}`, false},
		{"非 data 行", `event: ping`, false},
	}
	for _, c := range cases {
		if got := HasVisibleDelta([]byte(c.in + "\n\n")); got != c.want {
			t.Errorf("%s: 期望 %v，得到 %v", c.name, c.want, got)
		}
	}
}
