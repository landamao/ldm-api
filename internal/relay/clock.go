package relay

import (
	"context"
	"sync/atomic"
	"time"
)

// attemptClock 管一次上游尝试的计时：首字前等「首字」，首字后等「下一段」。
//
// 首字到达以前，超时时间内一段内容都没有，判上游响应超时。
// 首字到达以后，只有正文、思考内容或工具参数的增量才算进展：
// 心跳（`: ping`）、只带 role 的空块、纯 usage 块都不续命——
// 上游拿心跳吊着连接却一直不出字，同样按停滞立刻切路由，
// 否则一次请求能一直被拖到几分钟后上游自己断开。
type attemptClock struct {
	timer *time.Timer
	dur   time.Duration
	// sawText 表示已经收到过真正的输出，用来区分超时与停滞两种失败。
	sawText  atomic.Bool
	timedOut atomic.Bool
	stalled  atomic.Bool
}

// newAttemptClock 起表。dur 到期时会取消请求上下文，让阻塞中的 Read 立刻返回。
func newAttemptClock(cancel context.CancelFunc, dur time.Duration) *attemptClock {
	c := &attemptClock{dur: dur}
	c.timer = time.AfterFunc(dur, func() {
		if c.sawText.Load() {
			c.stalled.Store(true)
		} else {
			c.timedOut.Store(true)
		}
		cancel()
	})
	return c
}

// progress 在一段真实输出到达时调用，把计时器整体推后一个 dur。
//
// 只由「有内容」的块触发，这是本类型和单纯 Stop 定时器的唯一区别：
// 心跳不能让请求无限期地等下去。
func (c *attemptClock) progress() {
	// 先置位再 Reset：两者之间定时器恰好触发的极端情况下，
	// 失败原因会记成「停滞」而不是「超时」，与实际场景相符。
	c.sawText.Store(true)
	c.timer.Reset(c.dur)
}

// stop 在本次尝试结束时释放计时器。
func (c *attemptClock) stop() { c.timer.Stop() }

// reason 返回本次尝试因何中断，没有超时返回空串。
func (c *attemptClock) reason() string {
	switch {
	case c.stalled.Load():
		return "上游响应停滞"
	case c.timedOut.Load():
		return "上游响应超时"
	}
	return ""
}
