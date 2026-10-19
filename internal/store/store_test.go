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
