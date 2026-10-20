package store

import (
	"path/filepath"
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
	if r := got["b"]; r.Requests != 1 || r.Errors != 0 {
		t.Fatalf("b 期望 1 次调用 / 0 次失败，得到 %+v", r)
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
		{"success", []string{"canceled-retried", "ok-retried", "ok-plain"}},
		{"error", []string{"err-retried", "err-plain"}},
		{"", []string{"canceled-retried", "err-retried", "err-plain", "ok-retried", "ok-plain"}},
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
