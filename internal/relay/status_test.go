package relay

import (
	"context"
	"encoding/json"
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
func boolp(v bool) *bool    { return &v }

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

// 模型不可重试状态码与渠道 Key 冷却状态码都留空时，401/403 也要按配置
// 继续尝试后续路由：先换完本路由的所有 Key，再落到下一条路由。
func TestEmptyStatusRulesRetryForbiddenToNextRoute(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()

	var forbiddenHits atomic.Int32
	forbidden := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forbiddenHits.Add(1)
		w.WriteHeader(http.StatusForbidden)
		io.WriteString(w, `{"error":{"message":"no access"}}`)
	}))
	defer forbidden.Close()
	var fallbackHits atomic.Int32
	fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fallbackHits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"ok","usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	defer fallback.Close()

	st := newTestStore(t)
	ch := statusTestChannel(t, st, "fr-a", forbidden.URL, []string{"key-k-000001", "key-k-000002"}, []string{"a"})
	ch.KeyCooldownStatus = strp("")
	if err := st.SaveChannel(ch); err != nil {
		t.Fatal(err)
	}
	statusTestChannel(t, st, "fr-b", fallback.URL, []string{"key-k-000003"}, []string{"b"})
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "smart", Type: store.ModelTypeCustom,
		Routes:        []store.Route{{ChannelID: "fr-a", Upstream: "a"}, {ChannelID: "fr-b", Upstream: "b"}},
		NoRetryStatus: strp(""),
		Enabled:       true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, statusTestRequest("smart"))

	if rec.Code != http.StatusOK || res.Err != "" {
		t.Fatalf("403 留空不可重试时应继续路由到备用模型，得到 %d: %s", rec.Code, rec.Body.String())
	}
	if got := forbiddenHits.Load(); got != 2 {
		t.Errorf("应先尝试完前一条路由的两个 Key，实际 %d 次", got)
	}
	if got := fallbackHits.Load(); got != 1 {
		t.Errorf("备用路由应被调用一次，实际 %d 次", got)
	}
	if len(res.Attempts) != 3 {
		t.Errorf("应记录三次尝试（两个 Key + 一条备用路由），得到 %d", len(res.Attempts))
	}
	// 渠道没把 403 算作 Key 故障，两个 Key 都不应冷却；路由本身按失败冷却。
	if keys, reason := PlanKeys(ch); reason != "" || len(keys) != 2 {
		t.Errorf("留空 Key 冷却状态码时不应冷却 Key，得到 %v（%s）", candidateIndexes(keys), reason)
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

// 模型配置自定义错误返回时，不请求任何上游渠道，直接返回配置的状态码和错误详情。
func TestModelCustomErrorSkipsUpstream(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()

	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"ok"}`)
	}))
	defer srv.Close()

	st := newTestStore(t)
	ch := statusTestChannel(t, st, "ce", srv.URL, []string{"key-g-000001"}, []string{"a"})
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "ce/a", Type: store.ModelTypeChannel, ChannelID: "ce", Upstream: "a",
		ErrorEnabled: boolp(true), ErrorAlways: boolp(true),
		ErrorStatus: http.StatusServiceUnavailable, ErrorMessage: "维护中，请稍后再试",
		NoRetryStatus: strp(""),
		Enabled:       true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, statusTestRequest("ce/a"))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("应返回配置的 503，得到 %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "维护中，请稍后再试") {
		t.Errorf("响应应包含配置的错误详情: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"type":"server_error"`) {
		t.Errorf("5xx 错误的 type 应为 server_error: %s", rec.Body.String())
	}
	if got := hits.Load(); got != 0 {
		t.Errorf("配置自定义错误后不应请求上游，实际 %d 次", got)
	}
	if res.StatusCode != http.StatusServiceUnavailable || res.ClientErr != "维护中，请稍后再试" {
		t.Errorf("结果应记录实际返回给调用方的状态与文案: %+v", res)
	}
	if len(res.Attempts) != 0 {
		t.Errorf("未请求上游时不应记录路由尝试: %+v", res.Attempts)
	}
	// 未真正调用上游，Key 不应进入冷却
	if keys, reason := PlanKeys(ch); reason != "" || len(keys) != 1 {
		t.Errorf("自定义错误不应冷却 Key，得到 %v（%s）", candidateIndexes(keys), reason)
	}
}

// 自定义模型即使没有可用路由，自定义错误也优先于「没有可用渠道」返回。
func TestModelCustomErrorWithoutRoutes(t *testing.T) {
	st := newTestStore(t)
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "maint", Type: store.ModelTypeCustom, Routes: []store.Route{},
		ErrorEnabled: boolp(true), ErrorAlways: boolp(true),
		ErrorStatus: http.StatusTooManyRequests,
		Enabled:     true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, statusTestRequest("maint"))

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("应返回配置的 429，得到 %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "暂不可用") {
		t.Errorf("未填写错误详情时应返回默认文案: %s", rec.Body.String())
	}
	if res.ClientErr == "" || !strings.Contains(res.Err, "错误覆写") {
		t.Errorf("日志应区分自定义错误与普通无可用渠道: %+v", res)
	}
}

// 只开总开关：请求成功时正常返回；上游报错时才用配置的错误替代原始错误。
func TestModelCustomErrorRewritesUpstreamError(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()

	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
		io.WriteString(w, `{"error":{"message":"upstream boom"}}`)
	}))
	defer srv.Close()

	st := newTestStore(t)
	statusTestChannel(t, st, "rw", srv.URL, []string{"key-h-000001"}, []string{"a"})
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "rw/a", Type: store.ModelTypeChannel, ChannelID: "rw", Upstream: "a",
		ErrorEnabled: boolp(true), ErrorAlways: boolp(false),
		ErrorStatus: http.StatusServiceUnavailable, ErrorMessage: "维护中，请稍后再试",
		NoRetryStatus: strp(""),
		Enabled:       true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, statusTestRequest("rw/a"))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("应返回配置的 503，得到 %d: %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "维护中，请稍后再试") {
		t.Errorf("响应应包含配置的错误详情: %s", body)
	}
	if strings.Contains(body, "upstream boom") {
		t.Errorf("上游原始错误不应透传给调用方: %s", body)
	}
	if got := hits.Load(); got != 1 {
		t.Errorf("失败时重写仍应先请求上游，实际 %d 次", got)
	}
	if res.StatusCode != http.StatusServiceUnavailable || res.ClientErr != "维护中，请稍后再试" {
		t.Errorf("结果应记录实际返回给调用方的状态与文案: %+v", res)
	}
	if !strings.Contains(res.Err, "upstream boom") {
		t.Errorf("内部失败原因应保留在日志里: %+v", res.Err)
	}
}

// 失败时重写不能改变原有冷却规则：命中不可重试状态码时仍然不冷却 Key / 路由。
func TestModelCustomErrorRewriteKeepsNoRetryRules(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()

	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
		io.WriteString(w, `{"error":{"message":"boom"}}`)
	}))
	defer srv.Close()

	st := newTestStore(t)
	ch := statusTestChannel(t, st, "rwnr", srv.URL, []string{"key-i-000001", "key-i-000002"}, []string{"a"})
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "smart", Type: store.ModelTypeCustom,
		Routes:       []store.Route{{ChannelID: "rwnr", Upstream: "a"}},
		ErrorEnabled: boolp(true), ErrorAlways: boolp(false),
		ErrorStatus: http.StatusServiceUnavailable, ErrorMessage: "统一错误",
		ErrorKeepNoRetry: boolp(false),
		NoRetryStatus:    strp("500"),
		Enabled:          true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, statusTestRequest("smart"))

	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "统一错误") {
		t.Fatalf("应返回配置的错误，得到 %d: %s", rec.Code, rec.Body.String())
	}
	if got := hits.Load(); got != 1 {
		t.Errorf("不可重试状态码只应尝试一次，实际 %d 次", got)
	}
	if res.Err == "" {
		t.Error("内部失败原因不应为空")
	}
	if keys, reason := PlanKeys(ch); reason != "" || len(keys) != 2 {
		t.Errorf("不可重试状态码不应冷却 Key，得到 %v（%s）", candidateIndexes(keys), reason)
	}
	m, _ := st.GetModel("smart")
	chans, _ := st.ListChannels()
	byID := map[string]store.Channel{}
	for _, c := range chans {
		byID[c.ID] = c
	}
	if plan, _ := PlanRoute(m, byID, func(string) bool { return true }); len(plan) != 1 {
		t.Errorf("不可重试状态码不应冷却路由，得到 %d 条可用路由", len(plan))
	}
}

// 未设置「不覆盖不可重试状态码」时默认开启：命中规则的错误原样透传。
func TestModelCustomErrorKeepsNoRetryUpstream(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()

	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		io.WriteString(w, `{"error":{"message":"upstream boom"}}`)
	}))
	defer srv.Close()

	st := newTestStore(t)
	ch := statusTestChannel(t, st, "keep", srv.URL, []string{"key-k-000001", "key-k-000002"}, []string{"a"})
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "keep/a", Type: store.ModelTypeCustom,
		Routes:       []store.Route{{ChannelID: "keep", Upstream: "a"}},
		ErrorEnabled: boolp(true), ErrorAlways: boolp(false),
		ErrorStatus: http.StatusServiceUnavailable, ErrorMessage: "统一错误",
		NoRetryStatus: strp("500"),
		Enabled:       true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, statusTestRequest("keep/a"))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("应原样返回上游 500，得到 %d: %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "upstream boom") || strings.Contains(body, "统一错误") {
		t.Errorf("响应应为上游原始错误: %s", body)
	}
	if got := hits.Load(); got != 1 {
		t.Errorf("不可重试状态码只应尝试一次，实际 %d 次", got)
	}
	if res.StatusCode != http.StatusInternalServerError || !strings.Contains(res.ClientErr, "upstream boom") {
		t.Errorf("结果应记录实际返回给调用方的上游错误: %+v", res)
	}
	if keys, reason := PlanKeys(ch); reason != "" || len(keys) != 2 {
		t.Errorf("不应冷却 Key，得到 %v（%s）", candidateIndexes(keys), reason)
	}
	m, _ := st.GetModel("keep/a")
	chans, _ := st.ListChannels()
	byID := map[string]store.Channel{}
	for _, c := range chans {
		byID[c.ID] = c
	}
	if plan, _ := PlanRoute(m, byID, func(string) bool { return true }); len(plan) != 1 {
		t.Errorf("不应冷却路由，得到 %d 条可用路由", len(plan))
	}
}

// 没命中不可重试状态码的失败仍然按自定义错误重写。
func TestModelCustomErrorKeepNoRetryOnlyMatchesRule(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		io.WriteString(w, `{"error":{"message":"upstream boom"}}`)
	}))
	defer srv.Close()

	st := newTestStore(t)
	statusTestChannel(t, st, "keep2", srv.URL, []string{"key-l-000001"}, []string{"a"})
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "keep2/a", Type: store.ModelTypeCustom,
		Routes:       []store.Route{{ChannelID: "keep2", Upstream: "a"}},
		ErrorEnabled: boolp(true), ErrorAlways: boolp(false),
		ErrorStatus: http.StatusServiceUnavailable, ErrorMessage: "统一错误",
		ErrorKeepNoRetry: boolp(true),
		NoRetryStatus:    strp("502"),
		Enabled:          true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	New(st).Do(context.Background(), rec, statusTestRequest("keep2/a"))

	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "统一错误") {
		t.Fatalf("未命中规则时应返回配置的错误，得到 %d: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "upstream boom") {
		t.Errorf("未命中规则时不应透传上游错误: %s", rec.Body.String())
	}
}

// 只开总开关时，没有可用路由也属于失败，应返回配置的错误。
func TestModelCustomErrorRewritesNoRoute(t *testing.T) {
	st := newTestStore(t)
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "maint2", Type: store.ModelTypeCustom, Routes: []store.Route{},
		ErrorEnabled: boolp(true), ErrorAlways: boolp(false),
		ErrorStatus: http.StatusServiceUnavailable, ErrorMessage: "维护中",
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, statusTestRequest("maint2"))

	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "维护中") {
		t.Fatalf("应返回配置的错误，得到 %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(res.Err, "尚未配置路由") {
		t.Errorf("日志应保留内部失败原因: %+v", res.Err)
	}
}

// 只开总开关时，成功的请求保持原样，不受自定义错误影响。
func TestModelCustomErrorRewriteLeavesSuccessUntouched(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"ok","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	defer srv.Close()

	st := newTestStore(t)
	statusTestChannel(t, st, "rws", srv.URL, []string{"key-j-000001"}, []string{"a"})
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "rws/a", Type: store.ModelTypeChannel, ChannelID: "rws", Upstream: "a",
		ErrorEnabled: boolp(true), ErrorAlways: boolp(false),
		ErrorStatus: http.StatusServiceUnavailable, ErrorMessage: "维护中",
		NoRetryStatus: strp(""),
		Enabled:       true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, statusTestRequest("rws/a"))

	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"id":"ok"`) {
		t.Fatalf("成功请求应原样返回，得到 %d: %s", rec.Code, rec.Body.String())
	}
	if res.Err != "" || res.ClientErr != "" {
		t.Errorf("成功请求不应记录错误: %+v", res)
	}
}

// 开启「覆写为正文」且始终返回时：不请求上游，错误文案以 200 正文返回。
func TestModelErrorAsContentAlways(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()

	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"ok"}`)
	}))
	defer srv.Close()

	st := newTestStore(t)
	statusTestChannel(t, st, "ac", srv.URL, []string{"key-ac-000001"}, []string{"a"})
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "ac/a", Type: store.ModelTypeChannel, ChannelID: "ac", Upstream: "a",
		ErrorEnabled: boolp(true), ErrorAlways: boolp(true), ErrorAsContent: boolp(true),
		ErrorMessage: "维护中，请稍后再试",
		NoRetryStatus: strp(""),
		Enabled:       true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, statusTestRequest("ac/a"))

	if rec.Code != http.StatusOK {
		t.Fatalf("覆写为正文应返回 200，得到 %d: %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"object":"chat.completion"`) || !strings.Contains(body, "维护中，请稍后再试") {
		t.Errorf("应按正常对话响应返回错误文案: %s", body)
	}
	if strings.Contains(body, `"error"`) {
		t.Errorf("覆写为正文不应出现 error 字段: %s", body)
	}
	if got := hits.Load(); got != 0 {
		t.Errorf("始终返回时不应请求上游，实际 %d 次", got)
	}
	if res.StatusCode != http.StatusOK || res.ClientErr != "维护中，请稍后再试" {
		t.Errorf("结果应记录实际返回给调用方的状态与文案: %+v", res)
	}
	if !res.AsContent {
		t.Error("覆写为正文的响应应标记 AsContent，日志按黄色 200 的成功记录记账")
	}
}

// 只开总开关 + 覆写为正文：上游失败时把错误文案写成 200 正文。
func TestModelErrorAsContentRewritesFailure(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		io.WriteString(w, `{"error":{"message":"upstream boom"}}`)
	}))
	defer srv.Close()

	st := newTestStore(t)
	statusTestChannel(t, st, "af", srv.URL, []string{"key-af-000001"}, []string{"a"})
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "af/a", Type: store.ModelTypeChannel, ChannelID: "af", Upstream: "a",
		ErrorEnabled: boolp(true), ErrorAlways: boolp(false), ErrorAsContent: boolp(true),
		ErrorMessage: "上游异常，请稍后再试",
		NoRetryStatus: strp(""),
		Enabled:       true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, statusTestRequest("af/a"))

	if rec.Code != http.StatusOK {
		t.Fatalf("失败被覆写为正文时应返回 200，得到 %d: %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "上游异常，请稍后再试") || strings.Contains(body, "upstream boom") {
		t.Errorf("应只返回配置的文案，不透传上游错误: %s", body)
	}
	if !strings.Contains(res.Err, "500") {
		t.Errorf("日志应保留内部失败原因: %+v", res.Err)
	}
	if !res.AsContent || res.StatusCode != http.StatusOK {
		t.Errorf("覆写为正文应按 200 并标记 AsContent 记账: %+v", res)
	}
}

// 覆写为正文时，流式请求按 SSE 输出错误文案，状态码仍是 200。
func TestModelErrorAsContentStream(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()

	st := newTestStore(t)
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "acs", Type: store.ModelTypeCustom, Routes: []store.Route{},
		ErrorEnabled: boolp(true), ErrorAlways: boolp(true), ErrorAsContent: boolp(true),
		ErrorMessage: "维护中，请稍后再试",
		Enabled:     true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	req := statusTestRequest("acs")
	req.Stream = true
	req.JSON = map[string]any{"model": "acs", "stream": true}

	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("流式覆写为正文应返回 200，得到 %d: %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Errorf("流式覆写为正文应按 SSE 返回，Content-Type 为 %s", ct)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"content":"维护中，请稍后再试"`) || !strings.Contains(body, "data: [DONE]") {
		t.Errorf("SSE 应包含正文分块与结束标记: %s", body)
	}
	if res.StatusCode != http.StatusOK {
		t.Errorf("结果状态码应为 200，得到 %d", res.StatusCode)
	}
}

// 跳过不可重试状态码与覆写为正文同时开启：命中的错误原样返回，不变成 200 正文。
func TestModelErrorAsContentSkipsNoRetryStatus(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		io.WriteString(w, `{"error":{"message":"bad request from upstream"}}`)
	}))
	defer srv.Close()

	st := newTestStore(t)
	statusTestChannel(t, st, "ak", srv.URL, []string{"key-ak-000001"}, []string{"a"})
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "ak/a", Type: store.ModelTypeChannel, ChannelID: "ak", Upstream: "a",
		ErrorEnabled: boolp(true), ErrorAlways: boolp(false), ErrorAsContent: boolp(true),
		ErrorKeepNoRetry: boolp(true), ErrorMessage: "出错了，请稍后再试",
		NoRetryStatus: strp("400"),
		Enabled:       true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	New(st).Do(context.Background(), rec, statusTestRequest("ak/a"))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("命中不可重试状态码时应原样返回上游 400，得到 %d: %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "bad request from upstream") || strings.Contains(body, "出错了，请稍后再试") {
		t.Errorf("应透传上游原始错误，不做任何覆写: %s", body)
	}
}

// 关闭「跳过不可重试状态码」后，覆写为正文连命中的错误也改成 200 正文。
func TestModelErrorAsContentWithoutSkipNoRetry(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		io.WriteString(w, `{"error":{"message":"bad request from upstream"}}`)
	}))
	defer srv.Close()

	st := newTestStore(t)
	statusTestChannel(t, st, "as2", srv.URL, []string{"key-as2-000001"}, []string{"a"})
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "as2/a", Type: store.ModelTypeChannel, ChannelID: "as2", Upstream: "a",
		ErrorEnabled: boolp(true), ErrorAlways: boolp(false), ErrorAsContent: boolp(true),
		ErrorKeepNoRetry: boolp(false), ErrorMessage: "出错了，请稍后再试",
		NoRetryStatus: strp("400"),
		Enabled:       true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	New(st).Do(context.Background(), rec, statusTestRequest("as2/a"))

	if rec.Code != http.StatusOK {
		t.Fatalf("关闭跳过后应把错误覆写成 200 正文，得到 %d: %s", rec.Code, rec.Body.String())
	}
	if body := rec.Body.String(); !strings.Contains(body, "出错了，请稍后再试") {
		t.Errorf("应返回配置的文案: %s", body)
	}
}

// 模型配置自定义内容返回时，不请求任何上游渠道，直接返回配置的内容。
func TestModelCustomContentSkipsUpstream(t *testing.T) {
	ClearAllCooldowns()
	defer ClearAllCooldowns()

	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"ok"}`)
	}))
	defer srv.Close()

	st := newTestStore(t)
	statusTestChannel(t, st, "cc", srv.URL, []string{"key-cc-000001"}, []string{"a"})
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "cc/a", Type: store.ModelTypeChannel, ChannelID: "cc", Upstream: "a",
		ContentEnabled: boolp(true), ContentText: "好的",
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, statusTestRequest("cc/a"))

	if rec.Code != http.StatusOK {
		t.Fatalf("应返回 200，得到 %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Object  string `json:"object"`
		Model   string `json:"model"`
		Choices []struct {
			Message struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage struct {
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是合法 JSON: %v: %s", err, rec.Body.String())
	}
	if body.Object != "chat.completion" || body.Model != "cc/a" {
		t.Errorf("响应结构不正确: %+v", body)
	}
	if len(body.Choices) != 1 || body.Choices[0].Message.Role != "assistant" ||
		body.Choices[0].Message.Content != "好的" || body.Choices[0].FinishReason != "stop" {
		t.Errorf("应返回配置的正文: %+v", body.Choices)
	}
	if body.Usage.CompletionTokens == 0 {
		t.Errorf("应估算输出 token: %+v", body.Usage)
	}
	if got := hits.Load(); got != 0 {
		t.Errorf("配置自定义内容后不应请求上游，实际 %d 次", got)
	}
	if res.StatusCode != http.StatusOK || res.Err != "" || res.ClientErr != "" {
		t.Errorf("结果应记为成功: %+v", res)
	}
	if res.ChannelID != "" || res.UpstreamModel != "" {
		t.Errorf("未请求上游时不应记录渠道: %+v", res)
	}
}

// 自定义内容返回优先于自定义错误返回：两者同时开启时只返回内容。
func TestModelCustomContentWinsOverCustomError(t *testing.T) {
	st := newTestStore(t)
	now := time.Now().UnixMilli()
	on := true
	if err := st.SaveModel(store.Model{
		ID: "both", Type: store.ModelTypeCustom,
		ContentEnabled: &on, ContentText: "好的",
		ErrorEnabled: &on, ErrorAlways: &on, ErrorStatus: http.StatusServiceUnavailable, ErrorMessage: "维护中",
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, statusTestRequest("both"))

	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"content":"好的"`) {
		t.Fatalf("内容返回应优先于自定义错误，得到 %d: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "维护中") {
		t.Errorf("自定义错误不应生效: %s", rec.Body.String())
	}
	if res.Err != "" || res.ClientErr != "" {
		t.Errorf("结果应记为成功: %+v", res)
	}
}

// 自定义模型没有路由时，开启自定义内容返回也能正常调用。
func TestModelCustomContentWithoutRoutes(t *testing.T) {
	st := newTestStore(t)
	now := time.Now().UnixMilli()
	on := true
	if err := st.SaveModel(store.Model{
		ID: "fixed", Type: store.ModelTypeCustom,
		ContentEnabled: &on, ContentText: "好的",
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	resolved, err := New(st).Resolve("fixed")
	if err != nil {
		t.Fatal(err)
	}
	if resolved.NoRoute != "" || len(resolved.Routes) != 0 {
		t.Errorf("自定义内容模型不需要解析路由: %+v", resolved)
	}

	rec := httptest.NewRecorder()
	New(st).Do(context.Background(), rec, statusTestRequest("fixed"))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"content":"好的"`) {
		t.Fatalf("无路由的内容模型应正常返回，得到 %d: %s", rec.Code, rec.Body.String())
	}
}

// 自定义模型没有路由、也没有内容/错误返回时，返回普通的「没有可用渠道」错误。
func TestModelCustomWithoutRoutesFallsBackToNoChannel(t *testing.T) {
	st := newTestStore(t)
	now := time.Now().UnixMilli()
	if err := st.SaveModel(store.Model{
		ID: "empty", Type: store.ModelTypeCustom, Routes: []store.Route{},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, statusTestRequest("empty"))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("应返回 503，得到 %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "没有可用渠道") {
		t.Errorf("应返回普通的没有可用渠道错误: %s", rec.Body.String())
	}
	if !strings.Contains(res.Err, "尚未配置路由目标") {
		t.Errorf("日志应保留内部原因: %+v", res.Err)
	}
}

// 流式请求按 SSE 返回配置的内容。
func TestModelCustomContentStream(t *testing.T) {
	st := newTestStore(t)
	now := time.Now().UnixMilli()
	on := true
	if err := st.SaveModel(store.Model{
		ID: "fixed", Type: store.ModelTypeCustom,
		ContentEnabled: &on, ContentText: "好的",
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	req := statusTestRequest("fixed")
	req.Stream = true
	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("应返回 200，得到 %d: %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Errorf("流式响应应使用 SSE，得到 %q", ct)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"content":"好的"`) || !strings.Contains(body, `"finish_reason":"stop"`) {
		t.Errorf("SSE 应包含正文与结束标记: %s", body)
	}
	if !strings.HasSuffix(body, "data: [DONE]\n\n") {
		t.Errorf("SSE 应以 [DONE] 结束: %s", body)
	}
	if !res.Stream || res.StatusCode != http.StatusOK {
		t.Errorf("结果应记录为流式成功: %+v", res)
	}
}

// 自定义内容可以附带思考内容；留空时响应里不出现思考字段。
func TestModelCustomContentReasoning(t *testing.T) {
	st := newTestStore(t)
	now := time.Now().UnixMilli()
	on := true
	save := func(id, text, reasoning string) {
		t.Helper()
		if err := st.SaveModel(store.Model{
			ID: id, Type: store.ModelTypeCustom,
			ContentEnabled: &on, ContentText: text, ContentReasoning: reasoning,
			Enabled: true, CreatedAt: now, UpdatedAt: now,
		}); err != nil {
			t.Fatal(err)
		}
	}
	save("think", "好的", "先想一想")
	save("plain", "好的", "")

	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, statusTestRequest("think"))
	if rec.Code != http.StatusOK {
		t.Fatalf("应返回 200，得到 %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Choices []struct {
			Message struct {
				Content          string `json:"content"`
				ReasoningContent string `json:"reasoning_content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是合法 JSON: %v: %s", err, rec.Body.String())
	}
	if len(body.Choices) != 1 || body.Choices[0].Message.Content != "好的" ||
		body.Choices[0].Message.ReasoningContent != "先想一想" {
		t.Errorf("非流式响应应包含思考内容与正文: %+v", body.Choices)
	}
	if res.ReasoningChars != len([]rune("先想一想")) {
		t.Errorf("应记录思考内容字符数，得到 %d", res.ReasoningChars)
	}

	// 没有思考内容时，响应里不应出现 reasoning_content。
	rec = httptest.NewRecorder()
	New(st).Do(context.Background(), rec, statusTestRequest("plain"))
	if strings.Contains(rec.Body.String(), "reasoning_content") {
		t.Errorf("思考内容为空时不应输出字段: %s", rec.Body.String())
	}

	// 流式：思考内容先于正文输出。
	req := statusTestRequest("think")
	req.Stream = true
	rec = httptest.NewRecorder()
	New(st).Do(context.Background(), rec, req)
	raw := rec.Body.String()
	thinkIdx := strings.Index(raw, `"reasoning_content":"先想一想"`)
	contentIdx := strings.Index(raw, `"content":"好的"`)
	if thinkIdx < 0 || contentIdx < 0 || thinkIdx > contentIdx {
		t.Errorf("流式响应应先输出思考内容再输出正文: %s", raw)
	}
}

// 首字时间、流式速度和非流式延迟按配置模拟。
func TestModelCustomContentTiming(t *testing.T) {
	st := newTestStore(t)
	now := time.Now().UnixMilli()
	on := true
	if err := st.SaveModel(store.Model{
		ID: "slow", Type: store.ModelTypeCustom,
		ContentEnabled: &on, ContentText: "好的",
		ContentFirstByteMs: 40, ContentSpeed: 50, ContentLatencyMs: 60,
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	// 非流式：返回前等待配置的延迟。
	started := time.Now()
	rec := httptest.NewRecorder()
	res := New(st).Do(context.Background(), rec, statusTestRequest("slow"))
	elapsed := time.Since(started).Milliseconds()
	if elapsed < 50 {
		t.Errorf("非流式应等待约 60ms，实际 %dms", elapsed)
	}
	if res.LatencyMs < 50 {
		t.Errorf("日志应记录实际延迟，得到 %dms", res.LatencyMs)
	}
	if res.FirstByteMs != 0 {
		t.Errorf("非流式不应记录首字耗时，得到 %dms", res.FirstByteMs)
	}

	// 流式：首字等待 40ms，再按 50 字/秒输出 2 个字（约 40ms）。
	req := statusTestRequest("slow")
	req.Stream = true
	started = time.Now()
	rec = httptest.NewRecorder()
	res = New(st).Do(context.Background(), rec, req)
	elapsed = time.Since(started).Milliseconds()
	if res.FirstByteMs < 30 {
		t.Errorf("应记录首字耗时约 40ms，得到 %dms", res.FirstByteMs)
	}
	if elapsed < 65 {
		t.Errorf("流式总耗时应约 80ms，实际 %dms", elapsed)
	}
	if res.LatencyMs < 65 {
		t.Errorf("日志应记录流式总耗时，得到 %dms", res.LatencyMs)
	}
}

func TestCustomContentChunks(t *testing.T) {
	if got := customContentChunks("", 10); got != nil {
		t.Errorf("空文本不应分块: %v", got)
	}
	if got := customContentChunks("好的", 0); len(got) != 1 || got[0] != "好的" {
		t.Errorf("速度为 0 时应整段返回: %v", got)
	}
	chunks := customContentChunks("你好世界", 2)
	if len(chunks) != 4 {
		t.Errorf("每秒 2 字应逐字分块，得到 %d 块: %v", len(chunks), chunks)
	}
	if d := customContentChunkDelay("好", 20); d != 50*time.Millisecond {
		t.Errorf("每秒 20 字时每个字应等待 50ms，得到 %v", d)
	}
	if d := customContentChunkDelay("好", 0); d != 0 {
		t.Errorf("速度为 0 时不应等待，得到 %v", d)
	}
}
