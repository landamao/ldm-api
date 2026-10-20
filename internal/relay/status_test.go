package relay

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ldmapi/internal/store"
)

func strp(v string) *string { return &v }

func statusTestRequest(model string) *Request {
	body := []byte(fmt.Sprintf(`{"model":%q,"messages":[{"role":"user","content":"hi"}]}`, model))
	return &Request{
		Path: "/v1/chat/completions", Method: http.MethodPost,
		Header: http.Header{}, Body: body,
		JSON: map[string]any{"model": model},
	}
}

func statusTestChannel(t *testing.T, st *store.Store, id, baseURL string, keys []string, models []string) store.Channel {
	t.Helper()
	now := time.Now().UnixMilli()
	ch := store.Channel{
		ID: id, Name: id, Type: store.ChannelOpenAI, BaseURL: baseURL,
		Models: models, Enabled: true, CreatedAt: now, UpdatedAt: now,
		KeyMode: store.KeyModeSequential,
	}
	for _, k := range keys {
		ch.APIKeys = append(ch.APIKeys, store.ChannelKey{Key: k})
	}
	if err := st.SaveChannel(ch); err != nil {
		t.Fatal(err)
	}
	return ch
}

// 命中不可重试状态码时直接返回，不再换 Key / 换路由，也不记录任何冷却。
func TestNoRetryStatusStopsRouting(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()

	var hits atomic.Int32
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
		io.WriteString(w, `{"error":{"message":"boom"}}`)
	}))
	defer bad.Close()
	var fallbackHits atomic.Int32
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fallbackHits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"ok","usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	defer good.Close()

	st := newTestStore(t)
	chA := statusTestChannel(t, st, "nr-a", bad.URL, []string{"key-a-000001", "key-a-000002"}, []string{"a"})
	statusTestChannel(t, st, "nr-b", good.URL, []string{"key-b-000001"}, []string{"b"})
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "smart", Type: store.ModelTypeCustom,
		Routes:        []store.Route{{ChannelID: "nr-a", Upstream: "a"}, {ChannelID: "nr-b", Upstream: "b"}},
		NoRetryStatus: strp("500"),
		Enabled:       true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, statusTestRequest("smart"))

	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), "boom") {
		t.Fatalf("应原样返回上游 500，得到 %d: %s", rec.Code, rec.Body.String())
	}
	if got := hits.Load(); got != 1 {
		t.Errorf("不可重试错误只应尝试一次，实际 %d 次", got)
	}
	if got := fallbackHits.Load(); got != 0 {
		t.Errorf("不可重试错误不应继续路由，备用渠道被调用 %d 次", got)
	}
	if len(res.Attempts) != 0 {
		t.Errorf("只尝试一次时不应记录重试明细: %+v", res.Attempts)
	}
	// Key 与路由都不应进入冷却
	if keys, reason := PlanKeys(chA); reason != "" || len(keys) != 2 {
		t.Errorf("不可重试错误不应冷却 Key，得到 %v（%s）", candidateIndexes(keys), reason)
	}
	m, _ := st.GetModel("smart")
	chans, _ := st.ListChannels()
	byID := map[string]store.Channel{}
	for _, c := range chans {
		byID[c.ID] = c
	}
	if plan, _ := PlanRoute(m, byID, func(string) bool { return true }); len(plan) != 2 {
		t.Errorf("不可重试错误不应冷却路由，得到 %d 条可用路由", len(plan))
	}
}

// 渠道配置的 Key 冷却状态码只决定 Key 是否冷却；不在列表里的 429 仍会继续路由，
// 全部 Key 失败后路由照常冷却。
func TestKeyCooldownStatusControlsKeyCooldown(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()

	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusTooManyRequests)
		io.WriteString(w, `{"error":{"message":"rate limited"}}`)
	}))
	defer srv.Close()

	st := newTestStore(t)
	ch := statusTestChannel(t, st, "kc", srv.URL, []string{"key-c-000001", "key-c-000002"}, []string{"a"})
	ch.KeyCooldownStatus = strp("401,403")
	if err := st.SaveChannel(ch); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "kc/a", Type: store.ModelTypeChannel, ChannelID: "kc", Upstream: "a",
		NoRetryStatus: strp(""),
		Enabled:       true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, statusTestRequest("kc/a"))

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("应透传上游 429，得到 %d: %s", rec.Code, rec.Body.String())
	}
	if got := hits.Load(); got != 2 {
		t.Errorf("429 不在冷却列表时仍应尝试两个 Key，实际 %d 次", got)
	}
	if len(res.Attempts) != 2 {
		t.Errorf("应记录两次 Key 尝试，得到 %d", len(res.Attempts))
	}
	if keys, reason := PlanKeys(ch); reason != "" || len(keys) != 2 {
		t.Errorf("不在冷却列表的状态码不应冷却 Key，得到 %v（%s）", candidateIndexes(keys), reason)
	}
	// 路由本身仍会在全部 Key 失败后冷却
	m, _ := st.GetModel("kc/a")
	chans, _ := st.ListChannels()
	byID := map[string]store.Channel{}
	for _, c := range chans {
		byID[c.ID] = c
	}
	if plan, _ := PlanRoute(m, byID, func(string) bool { return true }); len(plan) != 0 {
		t.Errorf("全部 Key 失败后路由应进入冷却，得到 %d 条可用路由", len(plan))
	}
}

// 显式把 429 加入渠道的冷却列表后，Key 会进入冷却。
func TestKeyCooldownStatusCoolsMatchingKey(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		io.WriteString(w, `{"error":{"message":"rate limited"}}`)
	}))
	defer srv.Close()

	st := newTestStore(t)
	ch := statusTestChannel(t, st, "kc2", srv.URL, []string{"key-d-000001", "key-d-000002"}, []string{"a"})
	ch.KeyCooldownStatus = strp("429")
	if err := st.SaveChannel(ch); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "kc2/a", Type: store.ModelTypeChannel, ChannelID: "kc2", Upstream: "a",
		NoRetryStatus: strp(""),
		Enabled:       true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	New(st).Do(context.Background(), httptest.NewRecorder(), statusTestRequest("kc2/a"))

	if keys, reason := PlanKeys(ch); reason == "" || len(keys) != 0 {
		t.Errorf("命中冷却列表的 Key 应被冷却，得到 %v（%s）", candidateIndexes(keys), reason)
	}
}

// 显式留空不可重试状态码：4xx 也会继续路由到下一个模型。
func TestEmptyNoRetryStatusRetriesAll(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()

	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		io.WriteString(w, `{"error":{"message":"bad request"}}`)
	}))
	defer bad.Close()
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"ok","usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	defer good.Close()

	st := newTestStore(t)
	statusTestChannel(t, st, "er-a", bad.URL, []string{"key-e-000001"}, []string{"a"})
	statusTestChannel(t, st, "er-b", good.URL, []string{"key-e-000002"}, []string{"b"})
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "smart", Type: store.ModelTypeCustom,
		Routes:        []store.Route{{ChannelID: "er-a", Upstream: "a"}, {ChannelID: "er-b", Upstream: "b"}},
		NoRetryStatus: strp(""),
		Enabled:       true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, statusTestRequest("smart"))
	if rec.Code != http.StatusOK || res.Err != "" {
		t.Fatalf("4xx 应继续路由到备用模型，得到 %d: %s", rec.Code, rec.Body.String())
	}
}

// 把 401 从渠道的 Key 冷却列表里移除后，即使还有其它 Key 也不再换 Key，
// 而是按模型的不可重试规则直接返回。
func TestUnauthorizedWithoutKeyCooldownStopsFailover(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()

	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusUnauthorized)
		io.WriteString(w, `{"error":{"message":"invalid key"}}`)
	}))
	defer srv.Close()

	st := newTestStore(t)
	ch := statusTestChannel(t, st, "na", srv.URL, []string{"key-f-000001", "key-f-000002"}, []string{"a"})
	ch.KeyCooldownStatus = strp("")
	if err := st.SaveChannel(ch); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "na/a", Type: store.ModelTypeChannel, ChannelID: "na", Upstream: "a",
		// 模型侧把 401 视为不可重试，用来验证渠道不把它算作 Key 故障时不会换 Key。
		NoRetryStatus: strp("400-428,430-499"),
		Enabled:       true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	New(st).Do(context.Background(), rec, statusTestRequest("na/a"))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("应返回上游 401，得到 %d: %s", rec.Code, rec.Body.String())
	}
	if got := hits.Load(); got != 1 {
		t.Errorf("不在 Key 冷却列表里的 401 不应换 Key，实际尝试 %d 次", got)
	}
	if keys, reason := PlanKeys(ch); reason != "" || len(keys) != 2 {
		t.Errorf("401 不在冷却列表时不应冷却 Key，得到 %v（%s）", candidateIndexes(keys), reason)
	}
}
