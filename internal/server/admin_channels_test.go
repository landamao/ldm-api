package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ldmapi/internal/store"
)

// upstreamHit 记录一次打到假上游的请求。
type upstreamHit struct {
	Key   string // Authorization 头
	Path  string
	Model string // 对话请求体里的模型名
}

// fakeUpstream 模拟同时支持模型列表与对话接口的上游：
// 只有 valid 里的 Key 能通过认证，其余一律 401；所有请求记录进 hits。
func fakeUpstream(t *testing.T, hits *[]upstreamHit, valid ...string) *httptest.Server {
	t.Helper()
	ok := map[string]bool{}
	for _, k := range valid {
		if k != "" {
			ok["Bearer "+k] = true
		}
	}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		model := ""
		if r.Method == http.MethodPost {
			var body struct {
				Model string `json:"model"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			model = body.Model
		}
		*hits = append(*hits, upstreamHit{Key: auth, Path: r.URL.Path, Model: model})
		if len(ok) > 0 && !ok[auth] {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"error":{"message":"bad key"}}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/models") {
			w.Write([]byte(`{"object":"list","data":[{"id":"a"},{"id":"b"}]}`))
			return
		}
		w.Write([]byte(`{"id":"cmpl-1","choices":[{"message":{"content":"hi"}}]}`))
	}))
}

func callChannelTest(s *Server, id, payload string) (int, map[string]any) {
	req := httptest.NewRequest(http.MethodPost, "/api/channels/"+id+"/test", strings.NewReader(payload))
	req.SetPathValue("id", id)
	rec := httptest.NewRecorder()
	s.testChannel(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// 测试弹窗的 Key 选择：key_index 指定哪个就只测哪个，
// 不带 body 时保持旧的「逐个尝试到第一个可用」行为。
func TestTestChannelKeyIndexSelection(t *testing.T) {
	var hits []upstreamHit
	up := fakeUpstream(t, &hits, "sk-two")
	defer up.Close()
	s, st := newTestServer(t, "ct-key")
	now := time.Now().UnixMilli()
	if err := st.SaveChannel(store.Channel{
		ID: "c", Type: store.ChannelOpenAI, BaseURL: up.URL, Enabled: true,
		APIKeys: []store.ChannelKey{{Key: "sk-one"}, {Key: "sk-two"}},
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	// 指定第 2 个 Key：只发一次请求，且用的是 sk-two
	code, out := callChannelTest(s, "c", `{"mode":"list","key_index":1}`)
	if code != http.StatusOK {
		t.Fatalf("状态码 %d: %v", code, out)
	}
	if out["ok"] != true {
		t.Errorf("指定可用 Key 应通过: %v", out)
	}
	if len(hits) != 1 || hits[0].Key != "Bearer sk-two" {
		t.Errorf("应只用第 2 个 Key 发起一次请求，实际 %v", hits)
	}

	// 指定第 1 个 Key（无效）：单次失败，不回退到其它 Key
	hits = nil
	_, out = callChannelTest(s, "c", `{"mode":"list","key_index":0}`)
	if out["ok"] != false {
		t.Errorf("无效 Key 应失败: %v", out)
	}
	if len(hits) != 1 || hits[0].Key != "Bearer sk-one" {
		t.Errorf("指定 Key 失败时不应尝试其它 Key，实际 %v", hits)
	}

	// 越界直接报错，不发请求
	hits = nil
	_, out = callChannelTest(s, "c", `{"mode":"list","key_index":9}`)
	if out["ok"] != false {
		t.Errorf("越界 Key 应返回失败: %v", out)
	}
	if msg, _ := out["message"].(string); !strings.Contains(msg, "超出范围") {
		t.Errorf("越界 Key 应返回错误说明: %v", out)
	}
	if len(hits) != 0 {
		t.Errorf("越界时不应发起请求: %v", hits)
	}

	// 不带 body：保持旧行为，逐个 Key 尝试到成功
	hits = nil
	_, out = callChannelTest(s, "c", ``)
	if out["ok"] != true {
		t.Errorf("整渠道探测应命中可用 Key: %v", out)
	}
	if len(hits) != 2 {
		t.Errorf("应依次尝试两个 Key，实际 %v", hits)
	}
	if msg, _ := out["message"].(string); !strings.Contains(msg, "第 2/2") {
		t.Errorf("成功信息应标注命中的 Key 序号: %v", out)
	}
}

// 指定模型名的测试走一次最小对话请求，模型名不必在渠道配置里。
func TestTestChannelModelRequest(t *testing.T) {
	var hits []upstreamHit
	up := fakeUpstream(t, &hits, "sk-live")
	defer up.Close()
	s, st := newTestServer(t, "ct-model")
	now := time.Now().UnixMilli()
	if err := st.SaveChannel(store.Channel{
		ID: "c", Type: store.ChannelOpenAI, BaseURL: up.URL, Enabled: true,
		APIKey: "sk-live", Models: []string{"m1"}, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	code, out := callChannelTest(s, "c", `{"model":"m-not-configured"}`)
	if code != http.StatusOK {
		t.Fatalf("状态码 %d: %v", code, out)
	}
	if out["ok"] != true {
		t.Errorf("指定模型测试应通过: %v", out)
	}
	if len(hits) != 1 || !strings.HasSuffix(hits[0].Path, "/chat/completions") {
		t.Fatalf("应请求对话接口，实际 %v", hits)
	}
	if hits[0].Model != "m-not-configured" {
		t.Errorf("应把指定模型名带给上游: %+v", hits[0])
	}
	if hits[0].Key != "Bearer sk-live" {
		t.Errorf("单 Key 渠道应直接用保存的 Key: %+v", hits[0])
	}
}

// 渠道里测某个模型是一次真实的上游调用，要留一条日志让「刚才那次测试报了什么」可回溯；
// 但它没有令牌身份，也不该混进看板统计（测试失败不能拉低渠道成功率）。
func TestChannelModelTestWritesLog(t *testing.T) {
	var hits []upstreamHit
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		hits = append(hits, upstreamHit{Key: r.Header.Get("Authorization"), Path: r.URL.Path, Model: body.Model})
		w.Header().Set("Content-Type", "application/json")
		if body.Model == "broken" {
			w.WriteHeader(http.StatusInternalServerError)
			w.Write([]byte(`{"error":{"message":"model is gone"}}`))
			return
		}
		w.Write([]byte(`{"id":"cmpl-1","model":"m1","choices":[{"message":{"content":"hi"}}],` +
			`"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}`))
	}))
	defer up.Close()

	s, st := newTestServer(t, "ct-log")
	now := time.Now().UnixMilli()
	if err := st.SaveChannel(store.Channel{
		ID: "c", Name: "测试渠道", Type: store.ChannelOpenAI, BaseURL: up.URL, Enabled: true,
		APIKey: "sk-live", Models: []string{"m1"}, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	if _, out := callChannelTest(s, "c", `{"model":"m1"}`); out["ok"] != true {
		t.Fatalf("测试应通过: %v", out)
	}
	logs, total, err := st.QueryLogs(store.LogFilter{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || len(logs) != 1 {
		t.Fatalf("测模型应写入一条日志，实际 total=%d len=%d", total, len(logs))
	}
	l := logs[0]
	if l.Source != store.LogSourceTest {
		t.Errorf("日志来源应标成测试: %q", l.Source)
	}
	if l.ModelID != "m1" || l.UpstreamModel != "m1" || l.ResponseModel != "m1" {
		t.Errorf("模型字段不对: %+v", l)
	}
	if l.ChannelID != "c" || l.ChannelName != "测试渠道" {
		t.Errorf("渠道字段不对: %+v", l)
	}
	if l.TokenID != "" || l.TokenName != "" {
		t.Errorf("测试没有令牌身份，令牌列应为空: %+v", l)
	}
	if l.StatusCode != http.StatusOK || l.Error != "" || l.Failed() {
		t.Errorf("成功的测试应记成 200: %+v", l)
	}
	if l.PromptTokens != 7 || l.CompletionTokens != 2 || l.TotalTokens != 9 {
		t.Errorf("应带上游上报的用量: %+v", l)
	}
	if l.Endpoint != "/v1/chat/completions" || l.IP == "" {
		t.Errorf("应记录请求路径与来源 IP: %+v", l)
	}
	// 单 Key 渠道不记 Key 序号，和正式调用保持一致。
	if l.KeyIndex != 0 || l.KeyMasked != "" {
		t.Errorf("单 Key 渠道不该带 Key 信息: %+v", l)
	}

	// 失败的测试同样留痕，上游状态码和原因都要能点开看。
	if _, out := callChannelTest(s, "c", `{"model":"broken"}`); out["ok"] != false {
		t.Fatalf("上游 500 应判失败: %v", out)
	}
	logs, total, err = st.QueryLogs(store.LogFilter{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if total != 2 {
		t.Fatalf("失败的测试也要写日志，实际 total=%d", total)
	}
	failed := logs[0] // 倒序写入，最新在前
	if failed.StatusCode != http.StatusInternalServerError || !failed.Failed() {
		t.Errorf("失败测试应记上游状态码: %+v", failed)
	}
	if !strings.Contains(failed.Error, "model is gone") {
		t.Errorf("日志应保留上游错误原文: %q", failed.Error)
	}

	// 测试只写日志，不进统计：看板里的请求数不该被测试刷高。
	buckets, err := st.RangeStats(now-3600000, time.Now().UnixMilli()+3600000)
	if err != nil {
		t.Fatal(err)
	}
	if len(buckets) != 0 {
		t.Errorf("测试不应写入统计桶: %+v", buckets)
	}
}

// 多 Key 渠道测模型：日志要记下最终生效的 Key 和逐个尝试的明细，
// 否则「第几个 Key 挂了」只能靠猜。
func TestChannelModelTestLogsKeyAttempts(t *testing.T) {
	var hits []upstreamHit
	up := fakeUpstream(t, &hits, "sk-good")
	defer up.Close()
	s, st := newTestServer(t, "ct-log-keys")
	now := time.Now().UnixMilli()
	if err := st.SaveChannel(store.Channel{
		ID: "c", Type: store.ChannelOpenAI, BaseURL: up.URL, Enabled: true,
		APIKeys: []store.ChannelKey{{Key: "sk-bad", Note: "旧"}, {Key: "sk-good", Note: "新"}},
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	if _, out := callChannelTest(s, "c", `{"model":"m1"}`); out["ok"] != true {
		t.Fatalf("第 2 个 Key 可用时测试应通过: %v", out)
	}
	logs, _, err := st.QueryLogs(store.LogFilter{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(logs) != 1 {
		t.Fatalf("应写入一条日志，实际 %d", len(logs))
	}
	l := logs[0]
	if l.KeyIndex != 2 || l.KeyMasked != maskKey("sk-good") || l.KeyNote != "新" {
		t.Errorf("应记录最终生效的 Key: %+v", l)
	}
	if l.Retries != 1 || len(l.Attempts) != 2 {
		t.Fatalf("两个 Key 逐个尝试应记为 1 次重试: retries=%d attempts=%d", l.Retries, len(l.Attempts))
	}
	if l.Attempts[0].StatusCode != http.StatusUnauthorized || l.Attempts[0].KeyIndex != 1 {
		t.Errorf("第一次尝试应记在前一个 Key 上: %+v", l.Attempts[0])
	}
	if l.Attempts[1].StatusCode != http.StatusOK || !strings.HasSuffix(l.Attempts[1].UpstreamModel, "m1") {
		t.Errorf("最后一次尝试应是成功的那个 Key: %+v", l.Attempts[1])
	}
}

// 新建渠道（POST）只创建、不覆盖：ID 已被占用时返回 409，
// 已有渠道的名称、接口地址、密钥和模型都必须保持原样。
func TestCreateChannelRejectsDuplicateID(t *testing.T) {
	s, st := newTestServer(t, "channel-create-dup")
	create := func(payload string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/channels", strings.NewReader(payload))
		rec := httptest.NewRecorder()
		s.createChannel(rec, req)
		return rec
	}

	first := create(`{"id":"c","name":"原有渠道","type":"openai","base_url":"https://old.example.com",
		"key_rows":[{"key":"sk-old-key-123456"}],"models":["m1"]}`)
	if first.Code != http.StatusOK {
		t.Fatalf("首次创建失败 %d: %s", first.Code, first.Body.String())
	}

	dup := create(`{"id":"c","name":"覆盖渠道","type":"openai","base_url":"https://new.example.com",
		"key_rows":[{"key":"sk-new-key-123456"}],"models":["m2"]}`)
	if dup.Code != http.StatusConflict {
		t.Fatalf("重复 ID 应返回 409，实际 %d: %s", dup.Code, dup.Body.String())
	}
	if !strings.Contains(dup.Body.String(), "已存在") {
		t.Errorf("冲突提示应说明 ID 已存在: %s", dup.Body.String())
	}

	ch, err := st.GetChannel("c")
	if err != nil {
		t.Fatal(err)
	}
	if ch.Name != "原有渠道" || ch.BaseURL != "https://old.example.com" {
		t.Errorf("已有渠道的名称/地址被覆盖: %+v", ch)
	}
	if ch.APIKey != "sk-old-key-123456" {
		t.Errorf("已有渠道的 Key 被覆盖: %q", ch.APIKey)
	}
	if len(ch.Models) != 1 || ch.Models[0] != "m1" {
		t.Errorf("已有渠道的模型被覆盖: %v", ch.Models)
	}

	// 编辑同一个渠道仍然正常（PUT 走更新，不会因为「已存在」被拦）。
	req := httptest.NewRequest(http.MethodPut, "/api/channels/c", strings.NewReader(`{"name":"改名后"}`))
	req.SetPathValue("id", "c")
	rec := httptest.NewRecorder()
	s.saveChannel(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("编辑已有渠道失败 %d: %s", rec.Code, rec.Body.String())
	}
	if updated, err := st.GetChannel("c"); err != nil || updated.Name != "改名后" {
		t.Errorf("编辑未生效: %+v %v", updated, err)
	}
}
