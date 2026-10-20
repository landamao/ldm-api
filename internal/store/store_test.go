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

// 日志状态筛选：「有重试」只看重试过的请求，和成功/失败是独立维度。
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
