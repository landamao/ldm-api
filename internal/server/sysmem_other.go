//go:build !windows && !linux && !darwin

package server

// totalSystemMemory 在不支持的平台上返回 0，前端只展示进程占用。
func totalSystemMemory() uint64 { return 0 }
