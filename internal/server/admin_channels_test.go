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
