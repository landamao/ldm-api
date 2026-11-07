//go:build windows

package server

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

// memoryStatusEx 对应 Win32 的 MEMORYSTATUSEX 结构体。
type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

var globalMemoryStatusEx = windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalMemoryStatusEx")

// totalSystemMemory 返回物理内存总量（字节），获取失败时返回 0。
func totalSystemMemory() uint64 {
	var st memoryStatusEx
	st.Length = uint32(unsafe.Sizeof(st))
	r, _, _ := globalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&st)))
	if r == 0 {
		return 0
	}
	return st.TotalPhys
}

// processMemoryCountersEx 对应 Win32 的 PROCESS_MEMORY_COUNTERS_EX 结构体。
type processMemoryCountersEx struct {
	CB                         uint32
	PageFaultCount             uint32
	PeakWorkingSetSize         uintptr
	WorkingSetSize             uintptr
	QuotaPeakPagedPoolUsage    uintptr
	QuotaPagedPoolUsage        uintptr
	QuotaPeakNonPagedPoolUsage uintptr
	QuotaNonPagedPoolUsage     uintptr
	PagefileUsage              uintptr
	PeakPagefileUsage          uintptr
	PrivateUsage               uintptr
}

var k32GetProcessMemoryInfo = windows.NewLazySystemDLL("kernel32.dll").NewProc("K32GetProcessMemoryInfo")

// processMemory 返回当前进程实际占用的物理内存（工作集，字节），获取失败时返回 0。
func processMemory() uint64 {
	var c processMemoryCountersEx
	c.CB = uint32(unsafe.Sizeof(c))
	r, _, _ := k32GetProcessMemoryInfo.Call(uintptr(windows.CurrentProcess()), uintptr(unsafe.Pointer(&c)), unsafe.Sizeof(c))
	if r == 0 {
		return 0
	}
	return uint64(c.WorkingSetSize)
}
