//go:build !windows

package termtitle

import (
	"fmt"
	"os"
	"strings"
)

// Set 通过 OSC 序列设置终端标题；输出被重定向时跳过，避免污染日志。
func Set(title string) {
	info, err := os.Stdout.Stat()
	if err != nil || info.Mode()&os.ModeCharDevice == 0 {
		return
	}

	// OSC 2 只设窗口标题，OSC 0 同时设图标名和窗口标题；
	// 不同终端支持的序列不一样，两个都发兼容性最好。
	seq := "\033]0;" + title + "\a\033]2;" + title + "\a"

	// tmux / screen 会拦截 OSC，需要用各自的透传格式。
	switch {
	case os.Getenv("TMUX") != "":
		seq = "\033Ptmux;" + strings.ReplaceAll(seq, "\033", "\033\033") + "\033\\"
	case strings.HasPrefix(os.Getenv("TERM"), "screen"):
		seq = "\033P" + seq + "\033\\"
	}

	fmt.Fprint(os.Stdout, seq)
}
