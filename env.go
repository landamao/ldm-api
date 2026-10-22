package main

import (
	"flag"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"ldmapi/internal/dotenv"
)

// loadDotEnv 在解析命令行参数之前加载 .env，使其中的环境变量成为参数默认值。
// 查找顺序：LDMAPI_ENV_FILE 指定的文件；否则依次尝试当前目录和可执行文件所在目录的 .env。
// 已存在的环境变量不会被覆盖，因此命令行和真实环境变量优先于 .env。
func loadDotEnv() {
	var candidates []string
	if p := os.Getenv("LDMAPI_ENV_FILE"); p != "" {
		info, err := os.Stat(p)
		if err != nil {
			log.Fatalf("无法读取配置文件 %s: %v", p, err)
		}
		if info.IsDir() {
			log.Fatalf("配置文件 %s 是一个目录", p)
		}
		candidates = append(candidates, p)
	} else {
		candidates = append(candidates, ".env")
		if exe, err := os.Executable(); err == nil {
			if p := filepath.Join(filepath.Dir(exe), ".env"); !samePath(p, ".env") {
				candidates = append(candidates, p)
			}
		}
	}

	loaded, err := dotenv.Load(candidates...)
	if err != nil {
		log.Fatalf("加载配置文件失败: %v", err)
	}
	for _, p := range loaded {
		if abs, err := filepath.Abs(p); err == nil {
			p = abs
		}
		log.Printf("已加载配置文件 %s", p)
	}
}

func envString(name, def string) string {
	if v, ok := os.LookupEnv(name); ok {
		return v
	}
	return def
}

func envInt(name string, def int) int {
	v, ok := os.LookupEnv(name)
	if !ok || strings.TrimSpace(v) == "" {
		return def
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil {
		log.Printf("环境变量 %s=%q 不是有效数字，使用默认值 %d", name, v, def)
		return def
	}
	return n
}

func envBool(name string, def bool) bool {
	v, ok := os.LookupEnv(name)
	if !ok || strings.TrimSpace(v) == "" {
		return def
	}
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on", "y":
		return true
	case "0", "false", "no", "off", "n":
		return false
	default:
		log.Printf("环境变量 %s=%q 不是有效布尔值，使用默认值 %v", name, v, def)
		return def
	}
}

// passwordSource 说明待设置的密码来自命令行还是环境变量，便于排查 .env 配置。
func passwordSource() string {
	source := "环境变量 LDMAPI_PASSWORD（可能来自 .env）"
	flag.Visit(func(f *flag.Flag) {
		if f.Name == "password" {
			source = "命令行参数 -password"
		}
	})
	return source
}

func samePath(a, b string) bool {
	ai, errA := os.Stat(a)
	bi, errB := os.Stat(b)
	if errA == nil && errB == nil {
		return os.SameFile(ai, bi)
	}
	absA, absErrA := filepath.Abs(a)
	absB, absErrB := filepath.Abs(b)
	if absErrA != nil || absErrB != nil {
		return a == b
	}
	if runtime.GOOS == "windows" {
		return strings.EqualFold(absA, absB)
	}
	return absA == absB
}
