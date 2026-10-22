package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"ldmapi/internal/server"
	"ldmapi/internal/store"
	"ldmapi/internal/termtitle"
)

var version = "1.16.10"

func main() {
	var (
		host     = flag.String("host", "127.0.0.1", "监听地址")
		port     = flag.Int("port", 6700, "监听端口")
		dataDir  = flag.String("data", "", "数据目录（默认：可执行文件同级的 data 目录）")
		password = flag.String("password", "", "重置管理端密码后启动（可选）")
		open     = flag.Bool("open", false, "启动后自动打开浏览器")
		ver      = flag.Bool("version", false, "打印版本号")
	)
	flag.Parse()

	if *ver {
		fmt.Printf("懒大猫 API %s (%s/%s)\n", version, runtime.GOOS, runtime.GOARCH)
		return
	}

	termtitle.Set("LDMAPI")

	dir := *dataDir
	if dir == "" {
		dir = defaultDataDir()
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Fatalf("无法创建数据目录 %s: %v", dir, err)
	}
	dbPath := filepath.Join(dir, "ldmapi.db")

	st, err := store.Open(dbPath)
	if err != nil {
		log.Fatalf("打开数据文件失败: %v", err)
	}
	defer st.Close()

	srv := server.New(st)
	srv.Version = version
	srv.DataDir = dir
	if dir := os.Getenv("LDMAPI_DEV"); dir != "" {
		srv.DevDir = dir
		log.Printf("开发模式：前端资源从 %s 读取", dir)
	}

	isDefaultPwd, err := srv.EnsureDefaultPassword()
	if err != nil {
		log.Fatalf("初始化密码失败: %v", err)
	}
	if *password != "" {
		if err := srv.SetPassword(*password); err != nil {
			log.Fatalf("设置密码失败: %v", err)
		}
		isDefaultPwd = false
	}

	// 首次启动时生成一个可直接使用的 API 密钥
	firstKey, err := srv.EnsureDefaultToken()
	if err != nil {
		log.Fatalf("初始化密钥失败: %v", err)
	}

	ln, err := net.Listen("tcp", fmt.Sprintf("%s:%d", *host, *port))
	if err != nil {
		log.Fatalf("端口 %d 监听失败: %v", *port, err)
	}
	actualPort := ln.Addr().(*net.TCPAddr).Port

	httpSrv := &http.Server{
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		// 每天清理一次过期日志与统计
		ticker := time.NewTicker(6 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			srv.Cleanup()
		}
	}()

	go func() {
		if err := httpSrv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Fatalf("服务异常退出: %v", err)
		}
	}()

	printBanner(actualPort, dbPath, firstKey, isDefaultPwd)

	if *open {
		openBrowser(fmt.Sprintf("http://127.0.0.1:%d", actualPort))
	}

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM)
	<-quit

	fmt.Println("\n正在关闭…")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
	_ = st.Close()
	fmt.Println("已退出。")
}

func defaultDataDir() string {
	exe, err := os.Executable()
	if err == nil {
		// 优先放在可执行文件旁边，符合“一个文件就能跑”的预期
		dir := filepath.Dir(exe)
		if isWritable(dir) {
			return filepath.Join(dir, "data")
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "data"
	}
	return filepath.Join(home, ".ldmapi")
}

func isWritable(dir string) bool {
	if strings.HasPrefix(dir, os.TempDir()) {
		return false
	}
	f, err := os.CreateTemp(dir, ".ldmapi-write-test-*")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	os.Remove(name)
	return true
}

// browserBlockedPorts 是 Chromium 系浏览器拒绝访问的端口，直接打开会报 ERR_UNSAFE_PORT。
// 完整列表见 Chromium 的 kRestrictedPorts；这里照搬过来，避免用户踩坑。
var browserBlockedPorts = map[int]bool{
	1: true, 7: true, 9: true, 11: true, 13: true, 15: true, 17: true, 19: true,
	20: true, 21: true, 22: true, 23: true, 25: true, 37: true, 42: true, 43: true,
	53: true, 69: true, 77: true, 79: true, 87: true, 95: true, 101: true, 102: true,
	103: true, 104: true, 109: true, 110: true, 111: true, 113: true, 115: true,
	117: true, 119: true, 123: true, 135: true, 137: true, 139: true, 143: true,
	161: true, 179: true, 389: true, 427: true, 465: true, 512: true, 513: true,
	514: true, 515: true, 526: true, 530: true, 531: true, 532: true, 540: true,
	548: true, 554: true, 556: true, 563: true, 587: true, 601: true, 636: true,
	989: true, 990: true, 993: true, 995: true, 1719: true, 1720: true, 1723: true,
	2049: true, 3659: true, 4045: true, 5060: true, 5061: true, 6000: true,
	6566: true, 6665: true, 6666: true, 6667: true, 6668: true, 6669: true,
	6697: true, 10080: true,
}

const boxWidth = 62

// dispWidth 计算字符串在终端里的显示宽度：CJK 与 emoji 占两列。
func dispWidth(s string) int {
	w := 0
	for _, r := range s {
		switch {
		case r == 0x2329 || r == 0x232A,
			r >= 0x1100 && r <= 0x115F,
			r >= 0x2E80 && r <= 0xA4CF && r != 0x303F,
			r >= 0xAC00 && r <= 0xD7A3,
			r >= 0xF900 && r <= 0xFAFF,
			r >= 0xFE30 && r <= 0xFE6F,
			r >= 0xFF00 && r <= 0xFF60,
			r >= 0xFFE0 && r <= 0xFFE6,
			r >= 0x1F300 && r <= 0x1F9FF,
			r >= 0x20000 && r <= 0x3FFFD:
			w += 2
		default:
			w++
		}
	}
	return w
}

// boxLine 把内容渲染成一行边框，按显示宽度补空格。
func boxLine(content string) string {
	if dispWidth(content) > boxWidth {
		var b strings.Builder
		w := 0
		for _, r := range content {
			rw := dispWidth(string(r))
			if w+rw > boxWidth {
				break
			}
			b.WriteRune(r)
			w += rw
		}
		content = b.String()
	}
	return "  │" + content + strings.Repeat(" ", boxWidth-dispWidth(content)) + "│"
}

func printBanner(port int, dbPath, firstKey string, isDefaultPwd bool) {
	addr := "http://127.0.0.1:" + strconv.Itoa(port)
	fmt.Println()
	fmt.Println("  ╭" + strings.Repeat("─", boxWidth) + "╮")
	fmt.Println(boxLine("  🐱 懒大猫 API   v" + version))
	fmt.Println(boxLine(""))
	fmt.Println(boxLine("  控制台     " + addr))
	fmt.Println(boxLine("  API 地址   " + addr + "/v1"))
	fmt.Println(boxLine("  数据文件   " + shortenPath(dbPath, 42)))
	fmt.Println("  ╰" + strings.Repeat("─", boxWidth) + "╯")
	if browserBlockedPorts[port] {
		fmt.Printf("  ⚠ 端口 %d 被浏览器列为不安全端口，直接访问会报 ERR_UNSAFE_PORT\n", port)
		fmt.Printf("    请换一个端口启动，例如：%s -port %d\n", filepath.Base(os.Args[0]), suggestPort(port))
	}
	if isDefaultPwd {
		fmt.Println("  ⚠ 管理端默认密码：" + server.DefaultPassword + "   请登录后立即在「系统设置」中修改")
	}
	if firstKey != "" {
		fmt.Println()
		fmt.Println("  ✨ 已为你生成一个可直接使用的 API 密钥：")
		fmt.Println("     " + firstKey)
		fmt.Println("     在「令牌管理」里可以查看、复制和新增更多密钥。")
	}
	fmt.Println()
	fmt.Println("  按 Ctrl+C 停止服务")
	fmt.Println()
}

func shortenPath(p string, max int) string {
	if dispWidth(p) <= max {
		return p
	}
	r := []rune(p)
	for len(r) > 0 && dispWidth(string(r)) > max-1 {
		r = r[1:]
	}
	return "…" + string(r)
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}

// suggestPort 在当前端口附近找一个浏览器允许的端口。
func suggestPort(port int) int {
	for p := port + 1; p < port+20; p++ {
		if !browserBlockedPorts[p] {
			return p
		}
	}
	return 8080
}
