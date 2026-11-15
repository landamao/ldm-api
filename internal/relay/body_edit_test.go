package relay

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"ldmapi/internal/store"
)

// bodyEditJSON 把请求体解成 map 方便断言，数字统一用 json.Number。
func bodyEditJSON(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		t.Fatalf("解析结果失败：%v，原文 %s", err, raw)
	}
	return m
}

func mustEdits(t *testing.T, edits []store.BodyEdit) []store.BodyEdit {
	t.Helper()
	out, err := NormalizeBodyEdits(edits)
	if err != nil {
		t.Fatalf("规范化失败：%v", err)
	}
	return out
}

func TestApplyBodyEditsSetAndDelete(t *testing.T) {
	body := []byte(`{"model":"gpt","temperature":1,"messages":[{"role":"user","content":"hi"}]}`)
	edits := mustEdits(t, []store.BodyEdit{
		{Mode: "set", Path: "temperature", ValueType: "number", Value: json.RawMessage(`0.2`), KeepOrigin: true},
		{Mode: "set", Path: "top_p", ValueType: "number", Value: json.RawMessage(`0.9`)},
		{Mode: "set", Path: "metadata.user", ValueType: "string", Value: json.RawMessage(`"u1"`)},
		{Mode: "set", Path: "stop.0", ValueType: "string", Value: json.RawMessage(`"\n"`)},
		{Mode: "delete", Path: "messages.0.content"},
	})

	out, changed, err := ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatalf("应用失败：%v", err)
	}
	if !changed {
		t.Fatal("应当有改动")
	}
	got := bodyEditJSON(t, out)
	if got["temperature"].(json.Number).String() != "1" {
		t.Errorf("keep_origin 应该保留客户端原值，实际 %v", got["temperature"])
	}
	if got["top_p"].(json.Number).String() != "0.9" {
		t.Errorf("top_p 应被设置为 0.9，实际 %v", got["top_p"])
	}
	if meta, ok := got["metadata"].(map[string]any); !ok || meta["user"] != "u1" {
		t.Errorf("嵌套对象未创建：%v", got["metadata"])
	}
	if stop, ok := got["stop"].([]any); !ok || len(stop) != 1 || stop[0] != "\n" {
		t.Errorf("数组字段未设置：%v", got["stop"])
	}
	msg := got["messages"].([]any)[0].(map[string]any)
	if _, exists := msg["content"]; exists {
		t.Errorf("content 应被删除：%v", msg)
	}
	if msg["role"] != "user" {
		t.Errorf("同级的 role 不应受影响：%v", msg)
	}
}

func TestApplyBodyEditsKeepOriginOff(t *testing.T) {
	body := []byte(`{"stream":true}`)
	edits := mustEdits(t, []store.BodyEdit{
		{Mode: "set", Path: "stream", ValueType: "boolean", Value: json.RawMessage(`false`)},
	})
	out, _, err := ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	if got := bodyEditJSON(t, out)["stream"]; got != false {
		t.Errorf("未开启保持原值时应该覆盖，实际 %v", got)
	}
}

func TestApplyBodyEditsNegativeIndexAndEscape(t *testing.T) {
	body := []byte(`{"tools":[{"type":"a"},{"type":"b"}],"a.b":{"c":1}}`)
	edits := mustEdits(t, []store.BodyEdit{
		{Mode: "set", Path: "tools.-1.type", ValueType: "string", Value: json.RawMessage(`"z"`)},
		{Mode: "set", Path: `a\.b.c`, ValueType: "number", Value: json.RawMessage(`2`)},
	})
	out, _, err := ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	got := bodyEditJSON(t, out)
	tools := got["tools"].([]any)
	if tools[1].(map[string]any)["type"] != "z" {
		t.Errorf("负数下标应指向最后一项：%v", tools)
	}
	if tools[0].(map[string]any)["type"] != "a" {
		t.Errorf("前面的元素不应被改：%v", tools)
	}
	inner := got["a.b"].(map[string]any)
	if inner["c"].(json.Number).String() != "2" {
		t.Errorf("转义的点号应按字面键处理：%v", got)
	}
}

func TestApplyBodyEditsDeleteMissingIsNoop(t *testing.T) {
	body := []byte(`{"a":1}`)
	edits := mustEdits(t, []store.BodyEdit{
		{Mode: "delete", Path: "nope.deep"},
		{Mode: "delete", Path: "a.b.c"},
	})
	out, changed, err := ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Errorf("没有命中任何字段时不应重写请求体：%s", out)
	}
	if string(out) != string(body) {
		t.Errorf("请求体应保持原样，实际 %s", out)
	}
}

func TestApplyBodyEditsConditions(t *testing.T) {
	body := []byte(`{"temperature":0.9,"model":"gpt-4o","meta":{"tag":"prod-a"}}`)
	cases := []struct {
		name  string
		edit  store.BodyEdit
		apply bool
	}{
		{
			name: "全等命中",
			edit: store.BodyEdit{Mode: "set", Path: "reasoning_effort", ValueType: "string",
				Value:      json.RawMessage(`"high"`),
				Conditions: []store.BodyEditCondition{{Path: "model", Mode: "full", Value: json.RawMessage(`"gpt-4o"`)}}},
			apply: true,
		},
		{
			name: "全等未命中",
			edit: store.BodyEdit{Mode: "set", Path: "reasoning_effort", ValueType: "string",
				Value:      json.RawMessage(`"high"`),
				Conditions: []store.BodyEditCondition{{Path: "model", Mode: "full", Value: json.RawMessage(`"gpt-4"`)}}},
			apply: false,
		},
		{
			name: "取反命中",
			edit: store.BodyEdit{Mode: "set", Path: "reasoning_effort", ValueType: "string",
				Value:      json.RawMessage(`"high"`),
				Conditions: []store.BodyEditCondition{{Path: "model", Mode: "full", Value: json.RawMessage(`"gpt-4"`), Invert: true}}},
			apply: true,
		},
		{
			name: "前缀命中",
			edit: store.BodyEdit{Mode: "set", Path: "reasoning_effort", ValueType: "string",
				Value:      json.RawMessage(`"high"`),
				Conditions: []store.BodyEditCondition{{Path: "meta.tag", Mode: "prefix", Value: json.RawMessage(`"prod"`)}}},
			apply: true,
		},
		{
			name: "包含命中",
			edit: store.BodyEdit{Mode: "set", Path: "reasoning_effort", ValueType: "string",
				Value:      json.RawMessage(`"high"`),
				Conditions: []store.BodyEditCondition{{Path: "model", Mode: "contains", Value: json.RawMessage(`"4o"`)}}},
			apply: true,
		},
		{
			name: "大于等于命中",
			edit: store.BodyEdit{Mode: "set", Path: "reasoning_effort", ValueType: "string",
				Value:      json.RawMessage(`"high"`),
				Conditions: []store.BodyEditCondition{{Path: "temperature", Mode: "gte", Value: json.RawMessage(`0.9`)}}},
			apply: true,
		},
		{
			name: "大于未命中",
			edit: store.BodyEdit{Mode: "set", Path: "reasoning_effort", ValueType: "string",
				Value:      json.RawMessage(`"high"`),
				Conditions: []store.BodyEditCondition{{Path: "temperature", Mode: "gt", Value: json.RawMessage(`0.9`)}}},
			apply: false,
		},
		{
			name: "字段缺失默认不通过",
			edit: store.BodyEdit{Mode: "set", Path: "reasoning_effort", ValueType: "string",
				Value:      json.RawMessage(`"high"`),
				Conditions: []store.BodyEditCondition{{Path: "missing", Mode: "full", Value: json.RawMessage(`"x"`)}}},
			apply: false,
		},
		{
			name: "字段缺失标记通过",
			edit: store.BodyEdit{Mode: "set", Path: "reasoning_effort", ValueType: "string",
				Value:      json.RawMessage(`"high"`),
				Conditions: []store.BodyEditCondition{{Path: "missing", Mode: "full", Value: json.RawMessage(`"x"`), PassMissingKey: true}}},
			apply: true,
		},
		{
			name: "OR 任一命中",
			edit: store.BodyEdit{Mode: "set", Path: "reasoning_effort", ValueType: "string",
				Value: json.RawMessage(`"high"`),
				Conditions: []store.BodyEditCondition{
					{Path: "model", Mode: "full", Value: json.RawMessage(`"gpt-4"`)},
					{Path: "temperature", Mode: "lt", Value: json.RawMessage(`1`)},
				}, Logic: "or"},
			apply: true,
		},
		{
			name: "AND 全部命中才执行",
			edit: store.BodyEdit{Mode: "set", Path: "reasoning_effort", ValueType: "string",
				Value: json.RawMessage(`"high"`),
				Conditions: []store.BodyEditCondition{
					{Path: "model", Mode: "full", Value: json.RawMessage(`"gpt-4"`)},
					{Path: "temperature", Mode: "lt", Value: json.RawMessage(`1`)},
				}, Logic: "and"},
			apply: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out, _, err := ApplyBodyEdits(body, mustEdits(t, []store.BodyEdit{tc.edit}))
			if err != nil {
				t.Fatal(err)
			}
			_, exists := bodyEditJSON(t, out)["reasoning_effort"]
			if exists != tc.apply {
				t.Errorf("期望生效=%v，实际=%v；结果 %s", tc.apply, exists, out)
			}
		})
	}
}

func TestApplyBodyEditsNumbersStayExact(t *testing.T) {
	body := []byte(`{"seed":1}`)
	edits := mustEdits(t, []store.BodyEdit{
		{Mode: "set", Path: "seed", ValueType: "number", Value: json.RawMessage(`9007199254740993`)},
	})
	out, _, err := ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), `"seed":9007199254740993`) {
		t.Errorf("大整数不应被浮点化：%s", out)
	}
}

func TestApplyBodyEditsOrder(t *testing.T) {
	body := []byte(`{"a":{"b":1}}`)
	edits := mustEdits(t, []store.BodyEdit{
		{Mode: "set", Path: "a", ValueType: "json", Value: json.RawMessage(`{"c":2}`)},
		{Mode: "set", Path: "a.b", ValueType: "number", Value: json.RawMessage(`3`)},
	})
	out, _, err := ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	a := bodyEditJSON(t, out)["a"].(map[string]any)
	if a["c"].(json.Number).String() != "2" || a["b"].(json.Number).String() != "3" {
		t.Errorf("规则应按顺序执行：%v", a)
	}
}

func TestApplyBodyEditsBadBody(t *testing.T) {
	edits := mustEdits(t, []store.BodyEdit{{Mode: "delete", Path: "a"}})
	if _, _, err := ApplyBodyEdits([]byte(`not json`), edits); err == nil {
		t.Fatal("非法 JSON 应当报错")
	}
	if _, _, err := ApplyBodyEdits([]byte(`[1,2]`), edits); err == nil {
		t.Fatal("数组请求体应当报错")
	}
}

func TestNormalizeBodyEdits(t *testing.T) {
	out, err := NormalizeBodyEdits([]store.BodyEdit{
		{Mode: "", Path: " temperature ", ValueType: "NUMBER", Value: json.RawMessage(`0.5`)},
		{Mode: "delete", Path: "logprobs", Value: json.RawMessage(`"x"`), KeepOrigin: true},
		{Mode: "set", Path: "   "},
		{Mode: "set", Path: "x", ValueType: "", Value: json.RawMessage(`{"a":1}`),
			Conditions: []store.BodyEditCondition{{Path: "model", Mode: "", Value: json.RawMessage(`"m"`)}}},
	})
	if err != nil {
		t.Fatalf("规范化失败：%v", err)
	}
	if len(out) != 3 {
		t.Fatalf("空路径的行应当被丢掉，实际 %d 条", len(out))
	}
	if out[0].Mode != store.BodyEditSet || out[0].Path != "temperature" || out[0].ValueType != store.BodyValueNumber {
		t.Errorf("默认值与大小写规范化不对：%+v", out[0])
	}
	if out[1].Mode != store.BodyEditDelete || len(out[1].Value) != 0 || out[1].KeepOrigin {
		t.Errorf("删除规则应清掉值和覆盖开关：%+v", out[1])
	}
	if out[2].ValueType != store.BodyValueJSON || out[2].Logic != "or" {
		t.Errorf("值类型默认 json、条件关系默认 or：%+v", out[2])
	}
	if out[2].Conditions[0].Mode != store.CondFull {
		t.Errorf("条件默认 full：%+v", out[2].Conditions[0])
	}

	if _, err := NormalizeBodyEdits([]store.BodyEdit{{Mode: "prepend", Path: "a"}}); err == nil {
		t.Error("不支持的操作类型应当报错")
	}
	if _, err := NormalizeBodyEdits([]store.BodyEdit{{Mode: "set", Path: "a", ValueType: "number", Value: json.RawMessage(`"5"`)}}); err == nil {
		t.Error("值类型与值不匹配应当报错")
	}
	if _, err := NormalizeBodyEdits([]store.BodyEdit{{Mode: "set", Path: "a"}}); err == nil {
		t.Error("设置字段没填值应当报错")
	}
	if _, err := NormalizeBodyEdits([]store.BodyEdit{{Mode: "set", Path: "a..b", ValueType: "string", Value: json.RawMessage(`"x"`)}}); err == nil {
		t.Error("空层级路径应当报错")
	}
	if _, err := NormalizeBodyEdits([]store.BodyEdit{{
		Mode: "delete", Path: "a",
		Conditions: []store.BodyEditCondition{{Path: "b", Mode: "like", Value: json.RawMessage(`"x"`)}},
	}}); err == nil {
		t.Error("不支持的比较方式应当报错")
	}
}

func TestApplyBodyEditsConditionsWithJSONTypes(t *testing.T) {
	// 条件值按 JSON 类型比较：布尔 true 不会和字符串 "true" 混在一起。
	body := []byte(`{"stream":true}`)
	edits := mustEdits(t, []store.BodyEdit{{
		Mode: "set", Path: "extra", ValueType: "json", Value: json.RawMessage(`{"ok":1}`),
		Conditions: []store.BodyEditCondition{{Path: "stream", Mode: "full", Value: json.RawMessage(`true`)}},
	}})
	out, _, err := ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := bodyEditJSON(t, out)["extra"]; !exists {
		t.Errorf("布尔条件应命中：%s", out)
	}

	edits = mustEdits(t, []store.BodyEdit{{
		Mode: "set", Path: "extra", ValueType: "json", Value: json.RawMessage(`{"ok":1}`),
		Conditions: []store.BodyEditCondition{{Path: "stream", Mode: "full", Value: json.RawMessage(`"true"`)}},
	}})
	out, _, err = ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := bodyEditJSON(t, out)["extra"]; exists {
		t.Errorf("类型不同不应命中：%s", out)
	}
}

// TestBodyEditsReachUpstream 走完整的转发链路：客户端请求 → 协议转换 → 请求体修改 → 上游。
// 断言上游真正收到的是改过的字段，而不只是 ApplyBodyEdits 的单元结果。
func TestBodyEditsReachUpstream(t *testing.T) {
	st := newTestStore(t)
	var mu sync.Mutex
	var got map[string]any
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var in map[string]any
		_ = json.Unmarshal(raw, &in)
		mu.Lock()
		got = in
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"x","object":"chat.completion","model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	defer up.Close()

	now := time.Now().UnixMilli()
	if err := st.SaveChannel(store.Channel{
		ID: "c", Name: "c", Type: store.ChannelOpenAI, BaseURL: up.URL,
		Models: []string{"m"}, Enabled: true, CreatedAt: now, UpdatedAt: now,
		BodyEdits: []store.BodyEdit{
			{Mode: "set", Path: "temperature", ValueType: "number", Value: json.RawMessage(`0.2`), KeepOrigin: true},
			{Mode: "set", Path: "metadata.tag", ValueType: "string", Value: json.RawMessage(`"gw"`)},
			{Mode: "delete", Path: "logprobs"},
			{Mode: "set", Path: "reasoning_effort", ValueType: "string", Value: json.RawMessage(`"high"`),
				Conditions: []store.BodyEditCondition{{Path: "model", Mode: "full", Value: json.RawMessage(`"m"`)}}},
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveModel(store.Model{
		ID: "m", Type: store.ModelTypeCustom, Timeout: 5,
		Routes:  []store.Route{{ChannelID: "c", Upstream: "m"}},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	req := &Request{
		Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{"Content-Type": {"application/json"}},
		Body:   []byte(`{"model":"m","messages":[{"role":"user","content":"hi"}],"temperature":0.7,"logprobs":true}`),
		JSON: map[string]any{"model": "m", "temperature": 0.7, "logprobs": true,
			"messages": []any{map[string]any{"role": "user", "content": "hi"}}},
	}
	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, req)
	if res.Err != "" {
		t.Fatalf("不应失败: %+v", res)
	}

	mu.Lock()
	body := got
	mu.Unlock()
	if body == nil {
		t.Fatal("上游没有收到请求")
	}
	if v, ok := body["temperature"].(float64); !ok || v != 0.7 {
		t.Errorf("keep_origin 应保留客户端温度 0.7，实际 %v", body["temperature"])
	}
	if meta, ok := body["metadata"].(map[string]any); !ok || meta["tag"] != "gw" {
		t.Errorf("嵌套字段没写进上游请求体：%v", body["metadata"])
	}
	if _, exists := body["logprobs"]; exists {
		t.Errorf("logprobs 应被删除：%v", body["logprobs"])
	}
	if body["reasoning_effort"] != "high" {
		t.Errorf("条件命中的字段应写进上游请求体，实际 %v", body["reasoning_effort"])
	}
	if body["model"] != "m" {
		t.Errorf("model 不应被请求体修改影响，实际 %v", body["model"])
	}
}

func TestNormalizeCondValueType(t *testing.T) {
	base := func(cond store.BodyEditCondition) []store.BodyEdit {
		return []store.BodyEdit{{
			Mode: "set", Path: "x", ValueType: "string", Value: json.RawMessage(`"v"`),
			Conditions: []store.BodyEditCondition{cond},
		}}
	}

	// 显式类型按原样保留，值类型也必须对得上。
	out, err := NormalizeBodyEdits(base(store.BodyEditCondition{
		Path: "temperature", Mode: "gte", ValueType: "number", Value: json.RawMessage(`0.9`),
	}))
	if err != nil {
		t.Fatalf("数字条件不应报错：%v", err)
	}
	if got := out[0].Conditions[0].ValueType; got != store.BodyValueNumber {
		t.Errorf("条件值类型应保留 number，实际 %q", got)
	}

	// 没有类型字段的旧数据按值推断，字符串 "5" 不会被当成数字。
	out, err = NormalizeBodyEdits(base(store.BodyEditCondition{
		Path: "model", Mode: "full", Value: json.RawMessage(`"5"`),
	}))
	if err != nil {
		t.Fatal(err)
	}
	if got := out[0].Conditions[0].ValueType; got != store.BodyValueString {
		t.Errorf("引号里的 5 应推断为字符串，实际 %q", got)
	}

	out, err = NormalizeBodyEdits(base(store.BodyEditCondition{
		Path: "stream", Mode: "full", Value: json.RawMessage(`true`),
	}))
	if err != nil {
		t.Fatal(err)
	}
	if got := out[0].Conditions[0].ValueType; got != store.BodyValueBoolean {
		t.Errorf("布尔值应推断为 boolean，实际 %q", got)
	}

	// 空值（null）按 JSON 类型处理。
	out, err = NormalizeBodyEdits(base(store.BodyEditCondition{Path: "logprobs", Mode: "full"}))
	if err != nil {
		t.Fatal(err)
	}
	if got := out[0].Conditions[0].ValueType; got != store.BodyValueJSON {
		t.Errorf("空值应记为 json，实际 %q", got)
	}

	// 声明数字却给了字符串，保存时就该拒绝，而不是等调用时永远不命中。
	if _, err := NormalizeBodyEdits(base(store.BodyEditCondition{
		Path: "temperature", Mode: "gt", ValueType: "number", Value: json.RawMessage(`"0.9"`),
	})); err == nil {
		t.Error("数字类型配字符串值应当报错")
	}
	if _, err := NormalizeBodyEdits(base(store.BodyEditCondition{
		Path: "model", Mode: "full", ValueType: "string", Value: json.RawMessage(`5`),
	})); err == nil {
		t.Error("字符串类型配数字值应当报错")
	}
	if _, err := NormalizeBodyEdits(base(store.BodyEditCondition{
		Path: "model", Mode: "full", ValueType: "date", Value: json.RawMessage(`"2026"`),
	})); err == nil {
		t.Error("不支持的值类型应当报错")
	}
}

// TestCompareEditValuesStringModes 前缀 / 后缀 / 包含按字符串语义比较：
// 数字、布尔、对象都能先转成文本再匹配，和 new-api 的口径一致。
func TestCompareEditValuesStringModes(t *testing.T) {
	cases := []struct {
		name string
		have any
		want string
		mode string
		ok   bool
	}{
		{"数字前缀", json.Number("123"), `12`, store.CondPrefix, true},
		{"数字后缀", json.Number("123"), `23`, store.CondSuffix, true},
		{"数字包含", json.Number("123"), `2`, store.CondContains, true},
		{"数字前缀不命中", json.Number("123"), `23`, store.CondPrefix, false},
		{"布尔包含", true, `"ru"`, store.CondContains, true},
		{"布尔前缀", false, `"fal"`, store.CondPrefix, true},
		{"布尔前缀不命中", false, `"tru"`, store.CondPrefix, false},
		{"对象包含", map[string]any{"type": "disabled"}, `"disabled"`, store.CondContains, true},
		{"数组包含", []any{"a", "b"}, `"b"`, store.CondContains, true},
		{"字符串照旧", "gpt-4o", `"gpt"`, store.CondPrefix, true},
		{"全等仍按类型", json.Number("5"), `"5"`, store.CondFull, false},
		{"全等数字", json.Number("5"), `5`, store.CondFull, true},
		{"空值不参与文本匹配", nil, `""`, store.CondPrefix, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			want, err := decodeEditValue(json.RawMessage(tc.want))
			if err != nil {
				t.Fatalf("条件值解析失败：%v", err)
			}
			if got := compareEditValues(tc.have, want, tc.mode); got != tc.ok {
				t.Errorf("期望 %v，实际 %v（have=%v want=%s mode=%s）", tc.ok, got, tc.have, tc.want, tc.mode)
			}
		})
	}
}

// TestApplyBodyEditsPatch 「修改字段」只在客户端已经带了该字段时才改。
func TestApplyBodyEditsPatch(t *testing.T) {
	body := []byte(`{"temperature":1,"model":"gpt-4o"}`)
	edits := mustEdits(t, []store.BodyEdit{
		{Mode: "patch", Path: "temperature", ValueType: "number", Value: json.RawMessage(`0.2`)},
		{Mode: "patch", Path: "top_p", ValueType: "number", Value: json.RawMessage(`0.9`)},
		{Mode: "patch", Path: "model", ValueType: "string", Value: json.RawMessage(`"gpt-4o-mini"`),
			Conditions: []store.BodyEditCondition{
				{Path: "model", Mode: "prefix", Value: json.RawMessage(`"gpt-4o"`)},
			}},
	})
	out, changed, err := ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Fatal("应当有改动")
	}
	got := bodyEditJSON(t, out)
	if got["temperature"].(json.Number).String() != "0.2" {
		t.Errorf("客户端传了 temperature，应被改成 0.2，实际 %v", got["temperature"])
	}
	if _, exists := got["top_p"]; exists {
		t.Errorf("客户端没传 top_p，不应凭空创建：%v", got["top_p"])
	}
	if got["model"] != "gpt-4o-mini" {
		t.Errorf("条件命中时 model 应被修改，实际 %v", got["model"])
	}
}

// TestApplyBodyEditsPatchConditions 修改字段同样要满足条件；条件不命中时原值不动。
func TestApplyBodyEditsPatchConditions(t *testing.T) {
	body := []byte(`{"temperature":0.7,"model":"gpt-4o","extra":{"n":1}}`)
	edits := mustEdits(t, []store.BodyEdit{
		{Mode: "patch", Path: "temperature", ValueType: "number", Value: json.RawMessage(`0.2`),
			Conditions: []store.BodyEditCondition{
				{Path: "model", Mode: "full", Value: json.RawMessage(`"claude-3"`)},
			}},
		{Mode: "patch", Path: "extra.n", ValueType: "number", Value: json.RawMessage(`9`),
			Conditions: []store.BodyEditCondition{
				{Path: "temperature", Mode: "gt", ValueType: "number", Value: json.RawMessage(`0.5`)},
			}},
	})
	out, _, err := ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	got := bodyEditJSON(t, out)
	if got["temperature"].(json.Number).String() != "0.7" {
		t.Errorf("条件未命中时不应修改：%v", got["temperature"])
	}
	if got["extra"].(map[string]any)["n"].(json.Number).String() != "9" {
		t.Errorf("嵌套字段的修改应生效：%v", got["extra"])
	}
}

func TestNormalizeBodyEditsPatch(t *testing.T) {
	out, err := NormalizeBodyEdits([]store.BodyEdit{{
		Mode: "patch", Path: "temperature", ValueType: "number",
		Value: json.RawMessage(`0.2`), KeepOrigin: true,
	}})
	if err != nil {
		t.Fatalf("修改字段不应报错：%v", err)
	}
	if out[0].Mode != store.BodyEditPatch {
		t.Errorf("模式应为 patch，实际 %q", out[0].Mode)
	}
	if out[0].KeepOrigin {
		t.Error("修改字段不需要 keep_origin，应被清掉")
	}
	if out[0].ValueType != store.BodyValueNumber || string(out[0].Value) != "0.2" {
		t.Errorf("值应保留：%+v", out[0])
	}
	if _, err := NormalizeBodyEdits([]store.BodyEdit{{Mode: "patch", Path: "a"}}); err == nil {
		t.Error("修改字段没填值应当报错")
	}
}

// TestApplyBodyEditsMove 移动字段：把源路径的值搬到目标路径，源字段消失。
func TestApplyBodyEditsMove(t *testing.T) {
	// 顶层搬到嵌套对象
	body := []byte(`{"model":"m","reasoning_effort":"max","temperature":0.7}`)
	edits := mustEdits(t, []store.BodyEdit{
		{Mode: "move", Path: "reasoning_effort", Target: "chat_template_kwargs.reasoning_effort"},
	})
	out, changed, err := ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Fatal("应当有改动")
	}
	got := bodyEditJSON(t, out)
	if _, exists := got["reasoning_effort"]; exists {
		t.Errorf("源字段应被删除：%v", got)
	}
	kwargs, ok := got["chat_template_kwargs"].(map[string]any)
	if !ok || kwargs["reasoning_effort"] != "max" {
		t.Errorf("值应搬到目标路径：%v", got["chat_template_kwargs"])
	}
	if got["model"] != "m" {
		t.Errorf("同级的其他字段不应受影响：%v", got)
	}

	// 反向：嵌套对象搬回顶层，数字原样保留
	body = []byte(`{"chat_template_kwargs":{"reasoning_effort":1024,"keep":true}}`)
	edits = mustEdits(t, []store.BodyEdit{
		{Mode: "move", Path: "chat_template_kwargs.reasoning_effort", Target: "reasoning_effort"},
	})
	out, _, err = ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	got = bodyEditJSON(t, out)
	if got["reasoning_effort"].(json.Number).String() != "1024" {
		t.Errorf("值应原样搬到顶层：%v", got["reasoning_effort"])
	}
	kwargs = got["chat_template_kwargs"].(map[string]any)
	if _, exists := kwargs["reasoning_effort"]; exists {
		t.Errorf("嵌套里的源字段应被删除：%v", kwargs)
	}
	if kwargs["keep"] != true {
		t.Errorf("同层的其他字段不应受影响：%v", kwargs)
	}
}

// TestApplyBodyEditsMoveTarget 目标已有值直接覆盖：移动的语义就是不要原来的。
func TestApplyBodyEditsMoveTarget(t *testing.T) {
	body := []byte(`{"a":"new","b":{"a":"old"}}`)

	edits := mustEdits(t, []store.BodyEdit{{Mode: "move", Path: "a", Target: "b.a"}})
	out, _, err := ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	got := bodyEditJSON(t, out)
	if _, exists := got["a"]; exists {
		t.Errorf("源字段应被删除：%v", got)
	}
	if got["b"].(map[string]any)["a"] != "new" {
		t.Errorf("目标已有值时应被覆盖：%v", got["b"])
	}

	// 勾了「目标已有值不覆盖」：目标保留自己的值，源照样删掉——移动的语义
	// 就是不要原来的，源字段不能留在请求体里。
	edits = mustEdits(t, []store.BodyEdit{
		{Mode: "move", Path: "a", Target: "b.a", KeepOrigin: true},
	})
	out, changed, err := ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Errorf("删掉源字段也算改动：%s", out)
	}
	got = bodyEditJSON(t, out)
	if _, exists := got["a"]; exists {
		t.Errorf("源字段应被删除：%v", got)
	}
	if got["b"].(map[string]any)["a"] != "old" {
		t.Errorf("不覆盖时目标应保留原值：%v", got["b"])
	}

	// 目标不存在时「不覆盖」也照常搬过去
	edits = mustEdits(t, []store.BodyEdit{
		{Mode: "move", Path: "a", Target: "c.a", KeepOrigin: true},
	})
	out, _, err = ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	got = bodyEditJSON(t, out)
	if got["c"].(map[string]any)["a"] != "new" {
		t.Errorf("目标不存在时应正常搬运：%v", got["c"])
	}

	// 源字段不存在：跳过，不凭空造字段
	edits = mustEdits(t, []store.BodyEdit{{Mode: "move", Path: "nope.x", Target: "c.x"}})
	out, changed, err = ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Errorf("源字段不存在时不应改动：%s", out)
	}
}

// TestApplyBodyEditsMoveWriteFails 目标路径写不进去时要把源值放回去，别吃掉字段。
func TestApplyBodyEditsMoveWriteFails(t *testing.T) {
	body := []byte(`{"a":1,"list":[]}`)
	edits := mustEdits(t, []store.BodyEdit{{Mode: "move", Path: "a", Target: "list.-3"}})
	out, changed, err := ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Errorf("目标越界时不应算改动：%s", out)
	}
	got := bodyEditJSON(t, out)
	if got["a"].(json.Number).String() != "1" {
		t.Errorf("源字段应被放回原位：%v", got)
	}
}

// TestApplyBodyEditsMovePrunesEmptyParents 搬走父对象里最后一个键时，
// 空的父对象要跟着删掉，并且逐层往上清。
func TestApplyBodyEditsMovePrunesEmptyParents(t *testing.T) {
	// 单层：搬走唯一的子键后 a 变空，整个删掉
	body := []byte(`{"a":{"b":"max"},"model":"m"}`)
	edits := mustEdits(t, []store.BodyEdit{{Mode: "move", Path: "a.b", Target: "x.y"}})
	out, _, err := ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	got := bodyEditJSON(t, out)
	if _, exists := got["a"]; exists {
		t.Errorf("空掉的父对象应被删除：%v", got["a"])
	}
	if got["x"].(map[string]any)["y"] != "max" {
		t.Errorf("值应搬到目标路径：%v", got["x"])
	}
	if got["model"] != "m" {
		t.Errorf("无关字段不应受影响：%v", got)
	}

	// 连锁：删掉 c 后 a.b 空、a 也跟着空，两层都要清掉
	body = []byte(`{"a":{"b":{"c":"max"}}}`)
	edits = mustEdits(t, []store.BodyEdit{{Mode: "move", Path: "a.b.c", Target: "x"}})
	out, _, err = ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	got = bodyEditJSON(t, out)
	if _, exists := got["a"]; exists {
		t.Errorf("连续变空的父级应逐层删除：%v", got)
	}
	if got["x"] != "max" {
		t.Errorf("值应搬到目标路径：%v", got)
	}

	// 父对象里还有别的键时不能删
	body = []byte(`{"a":{"b":"max","d":1}}`)
	edits = mustEdits(t, []store.BodyEdit{{Mode: "move", Path: "a.b", Target: "x"}})
	out, _, err = ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	got = bodyEditJSON(t, out)
	a, ok := got["a"].(map[string]any)
	if !ok || len(a) != 1 || a["d"].(json.Number).String() != "1" {
		t.Errorf("没搬空的父对象应保留其余键：%v", got["a"])
	}

	// 父级是数组元素时只清字段、不删元素：删元素会让后面的下标整体前移
	body = []byte(`{"messages":[{"content":"hi","role":"user"}],"x":{}}`)
	edits = mustEdits(t, []store.BodyEdit{{Mode: "move", Path: "messages.0.content", Target: "x.y"}})
	out, _, err = ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	got = bodyEditJSON(t, out)
	msgs := got["messages"].([]any)
	if len(msgs) != 1 {
		t.Fatalf("数组元素不应被删除：%v", msgs)
	}
	if _, exists := msgs[0].(map[string]any)["content"]; exists {
		t.Errorf("源字段应被删除：%v", msgs[0])
	}
	if msgs[0].(map[string]any)["role"] != "user" {
		t.Errorf("同级的其他键不应受影响：%v", msgs[0])
	}
}

// TestApplyBodyEditsDeletePrunesEmptyParents 删除字段后父对象变空时同样逐层清掉，
// 和移动字段保持一致。
func TestApplyBodyEditsDeletePrunesEmptyParents(t *testing.T) {
	// 单层：删掉唯一的子键后 a 变空，整个删掉
	body := []byte(`{"a":{"b":"max"},"model":"m"}`)
	edits := mustEdits(t, []store.BodyEdit{{Mode: "delete", Path: "a.b"}})
	out, _, err := ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	got := bodyEditJSON(t, out)
	if _, exists := got["a"]; exists {
		t.Errorf("空掉的父对象应被删除：%v", got["a"])
	}
	if got["model"] != "m" {
		t.Errorf("无关字段不应受影响：%v", got)
	}

	// 连锁：c 删掉后 a.b 空、a 也空，两层一起清
	body = []byte(`{"a":{"b":{"c":"max"}}}`)
	edits = mustEdits(t, []store.BodyEdit{{Mode: "delete", Path: "a.b.c"}})
	out, _, err = ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	if got = bodyEditJSON(t, out); len(got) != 0 {
		t.Errorf("连续变空的父级应逐层删除，实际 %v", got)
	}

	// 父对象里还有别的键时不能删
	body = []byte(`{"a":{"b":"max","d":1}}`)
	edits = mustEdits(t, []store.BodyEdit{{Mode: "delete", Path: "a.b"}})
	out, _, err = ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	got = bodyEditJSON(t, out)
	a, ok := got["a"].(map[string]any)
	if !ok || len(a) != 1 || a["d"].(json.Number).String() != "1" {
		t.Errorf("没删空的父对象应保留其余键：%v", got["a"])
	}

	// 父级是数组元素时只清字段、不删元素：删元素会让后面的下标整体前移
	body = []byte(`{"messages":[{"content":"hi"}],"x":{}}`)
	edits = mustEdits(t, []store.BodyEdit{{Mode: "delete", Path: "messages.0.content"}})
	out, _, err = ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	got = bodyEditJSON(t, out)
	msgs := got["messages"].([]any)
	if len(msgs) != 1 {
		t.Fatalf("数组元素不应被删除：%v", msgs)
	}
	if len(msgs[0].(map[string]any)) != 0 {
		t.Errorf("元素应变成空对象但保留在数组里：%v", msgs[0])
	}
}

// TestApplyBodyEditsMoveWithinSameBranch 源和目标在同一分支上互相嵌套时，
// 先删后写要能正确处理，不能被「清理空父级」打乱。
func TestApplyBodyEditsMoveWithinSameBranch(t *testing.T) {
	// 目标在源内部：顶层字段搬进以它命名的对象
	body := []byte(`{"a":"max"}`)
	edits := mustEdits(t, []store.BodyEdit{{Mode: "move", Path: "a", Target: "a.b"}})
	out, _, err := ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	got := bodyEditJSON(t, out)
	a, ok := got["a"].(map[string]any)
	if !ok || a["b"] != "max" {
		t.Errorf("值应下沉到 a.b：%v", got["a"])
	}

	// 目标是源的父级：子字段的值提上来覆盖整个父对象
	body = []byte(`{"a":{"b":"max"}}`)
	edits = mustEdits(t, []store.BodyEdit{{Mode: "move", Path: "a.b", Target: "a"}})
	out, _, err = ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	got = bodyEditJSON(t, out)
	if got["a"] != "max" {
		t.Errorf("父对象应被值本身替换：%v", got["a"])
	}

	// 同一父级内换键：a.b 搬到 a.c，a 不能因为中间的短暂空壳被删掉
	body = []byte(`{"a":{"b":"max"}}`)
	edits = mustEdits(t, []store.BodyEdit{{Mode: "move", Path: "a.b", Target: "a.c"}})
	out, _, err = ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	got = bodyEditJSON(t, out)
	a, ok = got["a"].(map[string]any)
	if !ok || a["c"] != "max" {
		t.Errorf("同一父级内换键应成功：%v", got["a"])
	}
	if _, exists := a["b"]; exists {
		t.Errorf("源字段应被删除：%v", a)
	}
}

// TestApplyBodyEditsCopy 复制字段：源字段保留，值写到目标，目标已有值时看 keep_origin。
func TestApplyBodyEditsCopy(t *testing.T) {
	body := []byte(`{"a":"new","b":{"a":"old"},"list":[]}`)

	// 默认覆盖目标，源保留
	edits := mustEdits(t, []store.BodyEdit{{Mode: "copy", Path: "a", Target: "b.a"}})
	out, changed, err := ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Fatal("应当有改动")
	}
	got := bodyEditJSON(t, out)
	if got["a"] != "new" {
		t.Errorf("源字段应保留：%v", got)
	}
	if got["b"].(map[string]any)["a"] != "new" {
		t.Errorf("目标已有值时应被覆盖：%v", got["b"])
	}

	// 勾了「目标已有值不覆盖」：目标保留自己的值，请求体不变
	edits = mustEdits(t, []store.BodyEdit{
		{Mode: "copy", Path: "a", Target: "b.a", KeepOrigin: true},
	})
	out, changed, err = ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Errorf("目标已有值且不覆盖时不应改动：%s", out)
	}
	got = bodyEditJSON(t, out)
	if got["a"] != "new" || got["b"].(map[string]any)["a"] != "old" {
		t.Errorf("源和目标都应保持原样：%v", got)
	}

	// 目标不存在时「不覆盖」也照常复制
	edits = mustEdits(t, []store.BodyEdit{
		{Mode: "copy", Path: "a", Target: "c.a", KeepOrigin: true},
	})
	out, _, err = ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	got = bodyEditJSON(t, out)
	if got["c"].(map[string]any)["a"] != "new" {
		t.Errorf("目标不存在时应正常复制：%v", got["c"])
	}

	// 源字段不存在：跳过，不凭空造字段
	edits = mustEdits(t, []store.BodyEdit{{Mode: "copy", Path: "nope", Target: "c.x"}})
	out, changed, err = ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Errorf("源字段不存在时不应改动：%s", out)
	}

	// 目标写不进去：整条不算改动，源字段也不能受影响
	edits = mustEdits(t, []store.BodyEdit{{Mode: "copy", Path: "a", Target: "list.-3"}})
	out, changed, err = ApplyBodyEdits(body, edits)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Errorf("目标越界时不应算改动：%s", out)
	}
	got = bodyEditJSON(t, out)
	if got["a"] != "new" {
		t.Errorf("源字段应保留：%v", got)
	}
}

func TestNormalizeBodyEditsCopy(t *testing.T) {
	out, err := NormalizeBodyEdits([]store.BodyEdit{{
		Mode: "COPY", Path: " reasoning_effort ", Target: " chat_template_kwargs.reasoning_effort ",
		ValueType: "string", Value: json.RawMessage(`"max"`), KeepOrigin: true,
	}})
	if err != nil {
		t.Fatalf("复制字段不应报错：%v", err)
	}
	if out[0].Mode != store.BodyEditCopy {
		t.Errorf("模式应为 copy，实际 %q", out[0].Mode)
	}
	if out[0].Path != "reasoning_effort" || out[0].Target != "chat_template_kwargs.reasoning_effort" {
		t.Errorf("路径两端空格应被去掉：%+v", out[0])
	}
	if len(out[0].Value) != 0 || out[0].ValueType != "" {
		t.Errorf("复制规则不应保留值和值类型：%+v", out[0])
	}
	if !out[0].KeepOrigin {
		t.Errorf("「目标已有值不覆盖」应保留：%+v", out[0])
	}

	if _, err := NormalizeBodyEdits([]store.BodyEdit{{Mode: "copy", Path: "a"}}); err == nil {
		t.Error("复制字段没填目标路径应当报错")
	}
	if _, err := NormalizeBodyEdits([]store.BodyEdit{{Mode: "copy", Path: "a", Target: " a "}}); err == nil {
		t.Error("目标路径与源路径相同应当报错")
	}
}

func TestNormalizeBodyEditsMove(t *testing.T) {
	out, err := NormalizeBodyEdits([]store.BodyEdit{{
		Mode: "MOVE", Path: " reasoning_effort ", Target: " chat_template_kwargs.reasoning_effort ",
		ValueType: "string", Value: json.RawMessage(`"max"`), KeepOrigin: true,
	}})
	if err != nil {
		t.Fatalf("移动字段不应报错：%v", err)
	}
	if out[0].Mode != store.BodyEditMove {
		t.Errorf("模式应为 move，实际 %q", out[0].Mode)
	}
	if out[0].Path != "reasoning_effort" || out[0].Target != "chat_template_kwargs.reasoning_effort" {
		t.Errorf("路径两端空格应被去掉：%+v", out[0])
	}
	if len(out[0].Value) != 0 || out[0].ValueType != "" {
		t.Errorf("移动规则不应保留值和值类型：%+v", out[0])
	}
	if !out[0].KeepOrigin {
		t.Errorf("「目标已有值不覆盖」应保留：%+v", out[0])
	}
	if _, err := NormalizeBodyEdits([]store.BodyEdit{{Mode: "move", Path: "a"}}); err == nil {
		t.Error("移动字段没填目标路径应当报错")
	}
	if _, err := NormalizeBodyEdits([]store.BodyEdit{{Mode: "move", Path: "a", Target: " a "}}); err == nil {
		t.Error("目标路径与源路径相同应当报错")
	}
	if _, err := NormalizeBodyEdits([]store.BodyEdit{{Mode: "move", Path: "a", Target: "b..c"}}); err == nil {
		t.Error("目标路径有错误层级应当报错")
	}
	if _, err := NormalizeBodyEdits([]store.BodyEdit{{Mode: "rename", Path: "a", Target: "b"}}); err == nil {
		t.Error("不支持的修改方式应当报错")
	}
}
