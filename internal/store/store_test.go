package store

import (
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// 导出期间持有写锁：并发的保存操作必须等锁释放后才能完成。
func TestWithWriteLockBlocksWrites(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "lock.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	locked := make(chan struct{})
	release := make(chan struct{})
	lockDone := make(chan struct{})
	go func() {
		defer close(lockDone)
		_ = st.WithWriteLock(func() error {
			close(locked)
			<-release
			return nil
		})
	}()
	<-locked

	writeDone := make(chan error, 1)
	go func() {
		writeDone <- st.SaveToken(Token{ID: "t1", Key: "sk-test", Name: "并发写入"})
	}()

	select {
	case err := <-writeDone:
		t.Fatalf("写锁释放前写入不应完成（err=%v）", err)
	case <-time.After(100 * time.Millisecond):
	}

	close(release)
	select {
	case err := <-writeDone:
		if err != nil {
			t.Fatalf("锁释放后写入应成功: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("锁释放后写入仍未完成")
	}
	<-lockDone
}

func TestSaveTokenRejectsDuplicateKey(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "token-key.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	if err := st.SaveToken(Token{ID: "t1", Key: "sk-one", Name: "旧名称"}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveToken(Token{ID: "t2", Key: "sk-two"}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveToken(Token{ID: "t2", Key: "sk-one"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("其他令牌占用密钥时应返回 ErrConflict，得到 %v", err)
	}
	got, err := st.GetToken("t2")
	if err != nil {
		t.Fatal(err)
	}
	if got.Key != "sk-two" {
		t.Errorf("冲突保存不应覆盖原密钥，得到 %q", got.Key)
	}

	// 排除自身，同值更新其它字段可以正常保存。
	if err := st.SaveToken(Token{ID: "t1", Key: "sk-one", Name: "新名称"}); err != nil {
		t.Fatalf("同值更新自身密钥应成功: %v", err)
	}

	// 检查和写入在同一个写事务里，并发抢同一个密钥也只能成功一个。
	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for _, id := range []string{"race-a", "race-b"} {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			<-start
			errs <- st.SaveToken(Token{ID: id, Key: "sk-race"})
		}(id)
	}
	close(start)
	wg.Wait()
	close(errs)
	succeeded, conflicts := 0, 0
	for err := range errs {
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrConflict):
			conflicts++
		default:
			t.Fatalf("并发保存出现意外错误: %v", err)
		}
	}
	if succeeded != 1 || conflicts != 1 {
		t.Errorf("并发保存应有 1 次成功、1 次冲突，得到 %d / %d", succeeded, conflicts)
	}
}

// 近 N 次调用统计：按时间倒序取每个模型最新的 limit 条，取消的调用不算失败。
func TestRecentModelStats(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "recent.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	base := time.Now().UnixMilli()
	logs := []Log{
		{ID: "a-old-ok", Time: base - 5000, ModelID: "a", StatusCode: 200},
		{ID: "a-mid-err", Time: base - 4000, ModelID: "a", StatusCode: 500, Error: "上游失败"},
		{ID: "a-new-ok", Time: base - 3000, ModelID: "a", StatusCode: 200},
		{ID: "b-canceled", Time: base - 2000, ModelID: "b", StatusCode: 200, Canceled: true},
		{ID: "b-as-content", Time: base - 6000, ModelID: "b", StatusCode: 200, Error: "上游失败", AsContent: true},
		{ID: "x-err", Time: base - 1000, ModelID: "x", StatusCode: 500},
	}
	for _, l := range logs {
		if err := st.AppendLog(l); err != nil {
			t.Fatal(err)
		}
	}

	got, err := st.RecentModelStats([]string{"a", "b", "c"}, 2, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if r := got["a"]; r.Requests != 2 || r.Errors != 1 {
		t.Fatalf("a 期望 2 次调用 / 1 次失败，得到 %+v", r)
	}
	if r := got["b"]; r.Requests != 2 || r.Errors != 0 {
		t.Fatalf("b 期望 2 次调用 / 0 次失败，得到 %+v", r)
	}
	if _, ok := got["c"]; ok {
		t.Fatal("没有日志的模型不应出现在结果里")
	}
	if _, ok := got["x"]; ok {
		t.Fatal("未请求的模型不应出现在结果里")
	}

	// maxScan 限制回扫条数：最新 3 条里只有 a-new-ok 属于 a
	got, err = st.RecentModelStats([]string{"a"}, 2, 3)
	if err != nil {
		t.Fatal(err)
	}
	if r := got["a"]; r.Requests != 1 || r.Errors != 0 {
		t.Fatalf("maxScan=3 时 a 期望 1 次调用 / 0 次失败，得到 %+v", r)
	}
}

func TestQueryLogsRetryStatusFilter(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "logs.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	base := time.Now().UnixMilli()
	logs := []Log{
		{ID: "ok-plain", Time: base - 5000, StatusCode: 200},
		{ID: "ok-retried", Time: base - 4000, StatusCode: 200, Retries: 2},
		{ID: "err-plain", Time: base - 3000, StatusCode: 502, Error: "上游失败"},
		{ID: "err-retried", Time: base - 2000, StatusCode: 502, Error: "上游失败", Retries: 1},
		{ID: "canceled-retried", Time: base - 1000, StatusCode: 200, Canceled: true, Retries: 1},
		{ID: "as-content", Time: base - 500, StatusCode: 200, Error: "上游 500", AsContent: true},
	}
	for _, l := range logs {
		if err := st.AppendLog(l); err != nil {
			t.Fatal(err)
		}
	}

	ids := func(f LogFilter) []string {
		f.Limit = 100
		out, total, err := st.QueryLogs(f)
		if err != nil {
			t.Fatal(err)
		}
		if total != len(out) {
			t.Fatalf("total=%d 与返回条数 %d 不一致", total, len(out))
		}
		got := make([]string, 0, len(out))
		for _, l := range out {
			got = append(got, l.ID)
		}
		return got
	}

	cases := []struct {
		status string
		want   []string
	}{
		{"retry", []string{"canceled-retried", "err-retried", "ok-retried"}},
		{"success", []string{"as-content", "canceled-retried", "ok-retried", "ok-plain"}},
		{"error", []string{"err-retried", "err-plain"}},
		{"", []string{"as-content", "canceled-retried", "err-retried", "err-plain", "ok-retried", "ok-plain"}},
	}
	for _, tc := range cases {
		got := ids(LogFilter{Status: tc.status})
		if len(got) != len(tc.want) {
			t.Fatalf("status=%q 期望 %v，得到 %v", tc.status, tc.want, got)
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Fatalf("status=%q 期望 %v，得到 %v", tc.status, tc.want, got)
			}
		}
	}
}

func TestQueryLogFacets(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "facets.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	base := time.Now().UnixMilli()
	logs := []Log{
		{ID: "old-gpt", Time: base - 10000, ModelID: "gpt-4o", ChannelID: "c1", ChannelName: "主力", TokenID: "t1", TokenName: "生产", StatusCode: 200},
		{ID: "new-gpt", Time: base - 3000, ModelID: "gpt-4o", ChannelID: "c1", TokenID: "t1", StatusCode: 200},
		{ID: "new-legacy", Time: base - 2000, ModelID: "retired-model", ChannelID: "c2", ChannelName: "备用", TokenID: "t2", TokenName: "测试", StatusCode: 200},
		{ID: "new-legacy2", Time: base - 1000, ModelID: "retired-model", StatusCode: 200},
	}
	for _, l := range logs {
		if err := st.AppendLog(l); err != nil {
			t.Fatal(err)
		}
	}

	// 全区间：两个模型都在，历史模型（配置里已删）也要出现
	all, err := st.QueryLogFacets(0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(all.Models) != 2 {
		t.Fatalf("期望 2 个模型，得到 %+v", all.Models)
	}
	if all.Models[0].ID != "gpt-4o" || all.Models[0].Count != 2 {
		t.Fatalf("按出现次数倒序，期望 gpt-4o 出现 2 次，得到 %+v", all.Models)
	}
	if len(all.Channels) != 2 || all.Channels[0].ID != "c1" {
		t.Fatalf("渠道统计异常：%+v", all.Channels)
	}
	if all.Channels[1].Name != "备用" && all.Channels[0].Name != "主力" {
		t.Fatalf("渠道名称应随日志带出：%+v", all.Channels)
	}
	if len(all.Tokens) != 2 || all.Tokens[0].ID != "t1" {
		t.Fatalf("密钥统计异常：%+v", all.Tokens)
	}

	// 只看最近 2.5 秒：只剩历史模型
	recent, err := st.QueryLogFacets(base-2500, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(recent.Models) != 1 || recent.Models[0].ID != "retired-model" || recent.Models[0].Count != 2 {
		t.Fatalf("时间筛选后的模型统计异常：%+v", recent.Models)
	}
	if len(recent.Channels) != 1 || recent.Channels[0].ID != "c2" {
		t.Fatalf("时间筛选后的渠道统计异常：%+v", recent.Channels)
	}

	// 空区间：三个列表都要是空数组而不是 null，前端好直接 map
	empty, err := st.QueryLogFacets(base-100, base-50)
	if err != nil {
		t.Fatal(err)
	}
	if empty.Models == nil || empty.Channels == nil || empty.Tokens == nil {
		t.Fatalf("空区间应返回空数组：%+v", empty)
	}
	if len(empty.Models)+len(empty.Channels)+len(empty.Tokens) != 0 {
		t.Fatalf("空区间不应有取值：%+v", empty)
	}
}

// 旧版本按小时保存的亲和阈值要换算成分钟，且只迁移一次。
func TestSettingsAffinityMinutesMigration(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "settings-migrate.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	// 模拟 1.31.1 的存量配置：只有小时字段。
	if err := st.SaveSettings(Settings{AffinityCleanupHours: 24, AffinityCleanChannel: true}); err != nil {
		t.Fatal(err)
	}
	got, err := st.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if got.AffinityCleanupMinutes != 1440 {
		t.Fatalf("24 小时应换算成 1440 分钟，实际 %d", got.AffinityCleanupMinutes)
	}
	if got.AffinityCleanupHours != 0 {
		t.Fatalf("迁移后旧字段应清空，实际 %d", got.AffinityCleanupHours)
	}
	if !got.AffinityCleanChannel {
		t.Error("迁移不应影响其它设置")
	}

	// 换算结果已经落盘，再读不会重复换算。
	again, err := st.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if again.AffinityCleanupMinutes != 1440 || again.AffinityCleanupHours != 0 {
		t.Fatalf("再次读取应保持 1440 分钟，实际 %d / %d", again.AffinityCleanupMinutes, again.AffinityCleanupHours)
	}

	// 已经有分钟值时以分钟为准，不被残留的小时值覆盖。
	if err := st.SaveSettings(Settings{AffinityCleanupMinutes: 30, AffinityCleanupHours: 24}); err != nil {
		t.Fatal(err)
	}
	got, err = st.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if got.AffinityCleanupMinutes != 30 {
		t.Fatalf("应保留已有的 30 分钟，实际 %d", got.AffinityCleanupMinutes)
	}
	if got.AffinityCleanupHours != 0 {
		t.Fatalf("残留小时字段应被清空，实际 %d", got.AffinityCleanupHours)
	}
}
