//go:build darwin

package server

import "golang.org/x/sys/unix"

// totalSystemMemory 返回物理内存总量（字节），获取失败时返回 0。
func totalSystemMemory() uint64 {
	n, err := unix.SysctlUint64("hw.memsize")
	if err != nil {
		return 0
	}
	return n
}
