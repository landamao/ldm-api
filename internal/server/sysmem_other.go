//go:build !windows && !linux && !darwin

package server

import "runtime"

// totalSystemMemory 在不支持的平台上返回 0，前端只展示进程占用。
func totalSystemMemory() uint64 { return 0 }

// processMemory 返回当前进程占用的内存（字节）。
// 没有通用的系统接口，退回 Go 运行时向系统申请的内存总量。
func processMemory() uint64 {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	return mem.Sys
}
