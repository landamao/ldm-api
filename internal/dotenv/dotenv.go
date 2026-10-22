// Package dotenv 负责读取 .env 文件。
//
// 支持常见的写法：KEY=VALUE、export KEY=VALUE、# 注释、单引号原样值、
// 双引号值（支持 \n \r \t \" \\ 转义）以及未加引号值的行尾注释。
// 不支持多行值和变量展开。
package dotenv

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"
)

// Pair 是 .env 中的一条键值对。
type Pair struct {
	Key   string
	Value string
}

// Load 依次读取 paths 中存在的文件，并把键值写入进程环境变量。
// 已存在的环境变量不会被覆盖，因此真实环境变量优先于 .env；
// 同一个文件里重复出现的键以最后一次为准。
// 返回实际读取到的文件路径。
func Load(paths ...string) ([]string, error) {
	var loaded []string
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return loaded, err
		}
		if info.IsDir() {
			continue
		}
		pairs, err := ParseFile(path)
		if err != nil {
			return loaded, err
		}
		// 倒序写入，让同一个文件里重复的键以最后一次为准；
		// 已存在的环境变量（包括更早加载的文件）保持原值。
		for i := len(pairs) - 1; i >= 0; i-- {
			p := pairs[i]
			if _, ok := os.LookupEnv(p.Key); ok {
				continue
			}
			if err := os.Setenv(p.Key, p.Value); err != nil {
				return loaded, err
			}
		}
		loaded = append(loaded, path)
	}
	return loaded, nil
}

// ParseFile 解析单个 .env 文件。
func ParseFile(path string) ([]Pair, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	pairs, err := Parse(f)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return pairs, nil
}

// Parse 解析 .env 内容，空行和 # 开头的行会被忽略。
func Parse(r io.Reader) ([]Pair, error) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	var pairs []Pair
	for n := 1; scanner.Scan(); n++ {
		line := scanner.Text()
		if n == 1 {
			line = strings.TrimPrefix(line, "\ufeff")
		}
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if len(line) > 6 && strings.HasPrefix(line, "export") && (line[6] == ' ' || line[6] == '\t') {
			line = strings.TrimLeft(line[6:], " \t")
		}

		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			return nil, fmt.Errorf("第 %d 行：缺少 =，应为 KEY=VALUE", n)
		}
		key := strings.TrimSpace(line[:eq])
		if !validKey(key) {
			return nil, fmt.Errorf("第 %d 行：无效的变量名 %q", n, key)
		}
		value, err := parseValue(strings.TrimSpace(line[eq+1:]))
		if err != nil {
			return nil, fmt.Errorf("第 %d 行：%v", n, err)
		}
		pairs = append(pairs, Pair{Key: key, Value: value})
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return pairs, nil
}

func validKey(key string) bool {
	if key == "" {
		return false
	}
	for i, r := range key {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r == '_':
		case i > 0 && r >= '0' && r <= '9':
		default:
			return false
		}
	}
	return true
}

func parseValue(raw string) (string, error) {
	if raw == "" {
		return "", nil
	}
	switch raw[0] {
	case '"':
		return parseDoubleQuoted(raw)
	case '\'':
		return parseSingleQuoted(raw)
	}
	// 未加引号：只有空白后的 # 才算注释，避免误伤密码里的 #
	if i := inlineComment(raw); i >= 0 {
		raw = raw[:i]
	}
	return strings.TrimSpace(raw), nil
}

func inlineComment(s string) int {
	for i := 1; i < len(s); i++ {
		if s[i] == '#' && (s[i-1] == ' ' || s[i-1] == '\t') {
			return i
		}
	}
	return -1
}

func parseSingleQuoted(s string) (string, error) {
	end := strings.IndexByte(s[1:], '\'')
	if end < 0 {
		return "", fmt.Errorf("单引号没有闭合")
	}
	end++ // 换算成 s 中的下标
	if err := checkTrailing(s[end+1:]); err != nil {
		return "", err
	}
	return s[1:end], nil
}

func parseDoubleQuoted(s string) (string, error) {
	var b strings.Builder
	for i := 1; i < len(s); i++ {
		switch s[i] {
		case '\\':
			if i+1 >= len(s) {
				return "", fmt.Errorf("双引号没有闭合")
			}
			i++
			switch s[i] {
			case 'n':
				b.WriteByte('\n')
			case 'r':
				b.WriteByte('\r')
			case 't':
				b.WriteByte('\t')
			case '"':
				b.WriteByte('"')
			case '\\':
				b.WriteByte('\\')
			default:
				// 未知转义保持原样，避免把 Windows 路径里的 \d 吃掉
				b.WriteByte('\\')
				b.WriteByte(s[i])
			}
		case '"':
			if err := checkTrailing(s[i+1:]); err != nil {
				return "", err
			}
			return b.String(), nil
		default:
			b.WriteByte(s[i])
		}
	}
	return "", fmt.Errorf("双引号没有闭合")
}

func checkTrailing(rest string) error {
	rest = strings.TrimSpace(rest)
	if rest != "" && !strings.HasPrefix(rest, "#") {
		return fmt.Errorf("引号结束后还有多余内容")
	}
	return nil
}
