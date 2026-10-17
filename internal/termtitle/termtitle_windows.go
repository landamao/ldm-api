//go:build windows

package termtitle

import (
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var procSetConsoleTitleW = windows.NewLazySystemDLL("kernel32.dll").NewProc("SetConsoleTitleW")

// Set 设置当前控制台窗口标题。没有控制台时静默忽略。
func Set(title string) {
	p, err := syscall.UTF16PtrFromString(title)
	if err != nil {
		return
	}
	_, _, _ = procSetConsoleTitleW.Call(uintptr(unsafe.Pointer(p)))
}
