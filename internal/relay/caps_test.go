package relay

import (
	"encoding/json"
	"slices"
	"testing"

	"ldmapi/internal/store"
)

func decodeBody(t *testing.T, raw string) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal([]byte(raw), &body); err != nil {
		t.Fatalf("解析测试请求失败: %v", err)
	}
	return body
}

// 不同协议里的工具调用、思考、图片都要能被识别出来。
func TestUnsupportedInputAcrossProtocols(t *testing.T) {
	caps := store.Caps{ToolCalling: boolp(false), Thinking: boolp(false), Vision: boolp(false)}
	tests := []struct {
		name string
		body string
		want []string
	}{
		{
			name: "OpenAI 对话",
			body: `{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"x"}}]},` +
				`{"role":"assistant","content":null,"tool_calls":[{"id":"1","function":{"name":"f"}}]},` +
				`{"role":"tool","tool_call_id":"1","content":"ok"}],` +
				`"tools":[{"type":"function","function":{"name":"f"}}],"reasoning_effort":"high"}`,
			want: []string{"thinking", "tool", "vision"},
		},
		{
			name: "Anthropic 原生",
			body: `{"messages":[{"role":"user","content":[{"type":"image","source":{}}]},` +
				`{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"f","input":{}}]},` +
				`{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"ok"}]}],` +
				`"tools":[{"name":"f","input_schema":{}}],"thinking":{"type":"enabled","budget_tokens":1024}}`,
			want: []string{"thinking", "tool", "vision"},
		},
		{
			name: "Responses API",
			body: `{"input":[{"type":"message","role":"user","content":[{"type":"input_image","image_url":"x"}]},` +
				`{"type":"function_call","name":"f","arguments":"{}","call_id":"c1"},` +
				`{"type":"function_call_output","call_id":"c1","output":"ok"}],` +
				`"tools":[{"type":"function","name":"f"}],"reasoning":{"effort":"high"}}`,
			want: []string{"thinking", "tool", "vision"},
		},
		{
			name: "历史思考内容（OpenAI 字段）",
			body: `{"messages":[{"role":"assistant","content":"答案","reasoning_content":"伪造的思考"}]}`,
			want: []string{"thinking"},
		},
		{
			name: "历史思考块（Anthropic）",
			body: `{"messages":[{"role":"assistant","content":[` +
				`{"type":"thinking","thinking":"伪造的思考"},{"type":"text","text":"答案"}]}]}`,
			want: []string{"thinking"},
		},
		{
			name: "历史思考条目（Responses）",
			body: `{"input":[{"type":"reasoning","summary":[]},` +
				`{"type":"message","role":"assistant","content":[{"type":"output_text","text":"答案"}]}]}`,
			want: []string{"thinking"},
		},
		{
			name: "显式关闭思考",
			body: `{"messages":[{"role":"user","content":"hi"}],` +
				`"thinking":{"type":"disabled"},"reasoning_effort":"none","thinking_budget":0}`,
			want: nil,
		},
		{
			name: "空工具列表",
			body: `{"messages":[{"role":"user","content":"hi"}],"tools":[]}`,
			want: nil,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := []string{}
			for _, v := range unsupportedInput(decodeBody(t, tc.body), caps) {
				got = append(got, v.kind)
			}
			if !slices.Equal(got, tc.want) {
				t.Errorf("命中能力错误: 得到 %v，期望 %v", got, tc.want)
			}
		})
	}
}

// 清理逻辑要同时处理 OpenAI、Anthropic 和 Responses 的格式。
func TestStripUnsupportedInput(t *testing.T) {
	caps := store.Caps{ToolCalling: boolp(false), Thinking: boolp(false), Vision: boolp(false)}

	t.Run("Anthropic 原生", func(t *testing.T) {
		body := decodeBody(t, `{"model":"m","max_tokens":100,`+
			`"messages":[`+
			`{"role":"user","content":[{"type":"text","text":"看图"},{"type":"image","source":{"data":"x"}}]},`+
			`{"role":"assistant","content":[{"type":"thinking","thinking":"想"},{"type":"tool_use","id":"t","name":"f","input":{}}]},`+
			`{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"ok"}]},`+
			`{"role":"user","content":[{"type":"image","source":{"data":"x"}}]}],`+
			`"tools":[{"name":"f","input_schema":{}}],"thinking":{"type":"enabled","budget_tokens":1024}}`)
		req := &Request{JSON: body, Body: []byte(`{}`)}
		stripUnsupportedInput(req, caps)

		if _, ok := body["tools"]; ok {
			t.Error("tools 应被移除")
		}
		if _, ok := body["thinking"]; ok {
			t.Error("thinking 参数应被移除")
		}
		msgs := listOf(body["messages"])
		// assistant 和仅含工具结果的用户消息被丢弃，剩下两条用户消息。
		if len(msgs) != 2 {
			t.Fatalf("消息数量错误: 得到 %d: %+v", len(msgs), msgs)
		}
		parts := listOf(mapOf(msgs[0])["content"])
		if len(parts) != 1 || stringOf(mapOf(parts[0])["text"]) != "看图" {
			t.Errorf("图片应被移除、文字保留: %+v", parts)
		}
		parts = listOf(mapOf(msgs[1])["content"])
		if len(parts) != 1 || stringOf(mapOf(parts[0])["text"]) != imageRemovedText {
			t.Errorf("只有图片的消息应留下占位文本: %+v", parts)
		}
		// 请求体需要同步重建，供非对话端点直接透传。
		if string(req.Body) == "{}" {
			t.Error("清理后应重建 req.Body")
		}
	})

	t.Run("Responses API", func(t *testing.T) {
		body := decodeBody(t, `{"input":[`+
			`{"type":"message","role":"user","content":[{"type":"input_text","text":"看图"},{"type":"input_image","image_url":"x"}]},`+
			`{"type":"reasoning","summary":[]},`+
			`{"type":"function_call","name":"f","arguments":"{}","call_id":"c1"},`+
			`{"type":"function_call_output","call_id":"c1","output":"ok"},`+
			`{"type":"message","role":"user","content":[{"type":"input_image","image_url":"x"}]}],`+
			`"tools":[{"type":"function","name":"f"}],"reasoning":{"effort":"high"}}`)
		req := &Request{JSON: body, Body: []byte(`{}`)}
		stripUnsupportedInput(req, caps)

		items := listOf(body["input"])
		if len(items) != 2 {
			t.Fatalf("input 条目数量错误: 得到 %d: %+v", len(items), items)
		}
		parts := listOf(mapOf(items[0])["content"])
		if len(parts) != 1 || stringOf(mapOf(parts[0])["text"]) != "看图" {
			t.Errorf("图片应被移除、文字保留: %+v", parts)
		}
		parts = listOf(mapOf(items[1])["content"])
		if len(parts) != 1 || stringOf(mapOf(parts[0])["text"]) != imageRemovedText {
			t.Errorf("只有图片的消息应留下占位文本: %+v", parts)
		}
		if _, ok := body["tools"]; ok {
			t.Error("tools 应被移除")
		}
		if _, ok := body["reasoning"]; ok {
			t.Error("reasoning 参数应被移除")
		}
	})
}
