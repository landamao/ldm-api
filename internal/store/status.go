package store

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"
)

// 状态码规则：支持单个状态码和闭区间，用逗号、分号或空白分隔，
// 例如 "400, 404-408, 429"。未配置时视为空规则。

// StatusSet 是一组 HTTP 状态码，内部按闭区间保存。
// 零值不匹配任何状态码。
type StatusSet struct {
	ranges [][2]int
}

// Match 判断状态码是否命中规则。
func (s StatusSet) Match(code int) bool {
	for _, r := range s.ranges {
		if code >= r[0] && code <= r[1] {
			return true
		}
	}
	return false
}

// Empty 表示规则里没有任何状态码。
func (s StatusSet) Empty() bool { return len(s.ranges) == 0 }

// ParseStatusSet 解析状态码规则。空字符串得到空集合，不报错。
func ParseStatusSet(raw string) (StatusSet, error) {
	_, ranges, err := normalizeStatusSet(raw)
	if err != nil {
		return StatusSet{}, err
	}
	return StatusSet{ranges: ranges}, nil
}

// NormalizeStatusSet 校验并规范化状态码规则，返回去掉多余空白和重复项后的文本。
func NormalizeStatusSet(raw string) (string, error) {
	normalized, _, err := normalizeStatusSet(raw)
	return normalized, err
}

func normalizeStatusSet(raw string) (string, [][2]int, error) {
	parts := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == '，' || r == ';' || r == '；' || unicode.IsSpace(r)
	})
	out := make([]string, 0, len(parts))
	ranges := make([][2]int, 0, len(parts))
	seen := make(map[[2]int]bool, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		lo, hi, err := parseStatusRange(part)
		if err != nil {
			return "", nil, err
		}
		key := [2]int{lo, hi}
		if seen[key] {
			continue
		}
		seen[key] = true
		if lo == hi {
			out = append(out, strconv.Itoa(lo))
		} else {
			out = append(out, strconv.Itoa(lo)+"-"+strconv.Itoa(hi))
		}
		ranges = append(ranges, key)
	}
	return strings.Join(out, ","), ranges, nil
}

func parseStatusRange(part string) (int, int, error) {
	if i := strings.Index(part, "-"); i >= 0 {
		loText := strings.TrimSpace(part[:i])
		hiText := strings.TrimSpace(part[i+1:])
		lo, errLo := strconv.Atoi(loText)
		hi, errHi := strconv.Atoi(hiText)
		if errLo != nil || errHi != nil || lo < 100 || hi > 599 || lo > hi {
			return 0, 0, fmt.Errorf("状态码区间「%s」不合法，应为 100–599 之间的 a-b", part)
		}
		return lo, hi, nil
	}
	code, err := strconv.Atoi(part)
	if err != nil || code < 100 || code > 599 {
		return 0, 0, fmt.Errorf("状态码「%s」不合法，应为 100–599 之间的整数", part)
	}
	return code, code, nil
}

// NoRetryStatusSet 返回模型生效的不可重试状态码规则。
// 未设置（nil）或数据损坏时都视为空规则：所有状态码都可重试。
func (m Model) NoRetryStatusSet() StatusSet {
	if m.NoRetryStatus == nil {
		return StatusSet{}
	}
	set, err := ParseStatusSet(*m.NoRetryStatus)
	if err != nil {
		return StatusSet{}
	}
	return set
}

// KeyCooldownStatusSet 返回渠道生效的 Key 冷却触发规则。
// 未设置（nil）或数据损坏时都视为空规则：任何状态码都不冷却 Key。
func (c Channel) KeyCooldownStatusSet() StatusSet {
	if c.KeyCooldownStatus == nil {
		return StatusSet{}
	}
	set, err := ParseStatusSet(*c.KeyCooldownStatus)
	if err != nil {
		return StatusSet{}
	}
	return set
}
