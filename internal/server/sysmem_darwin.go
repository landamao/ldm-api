//go:build darwin

package server

import (
	"runtime"

	"golang.org/x/sys/unix"
)

// totalSystemMemory 返回物理内存总量（字节），获取失败时返回 0。
func totalSystemMemory() uint64 {
	n, err := unix.SysctlUint64("hw.memsize")
	if err != nil {
		return 0
	}
	return n
}

// processMemory 返回当前进程占用的内存（字节）。
//
// macOS 上取进程常驻内存要走 libproc / mach，都需要 cgo；本程序是纯静态编译，
// 所以这里退回 Go 运行时向系统申请的内存总量（Sys）—— 它不含可执行文件本身
// 的映射，但量级和 RSS 最接近，比堆上在用的 Alloc 更接近任务管理器里的数字。
func processMemory() uint64 {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	return mem.Sys
}
