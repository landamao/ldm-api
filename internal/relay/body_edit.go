package relay

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"strings"

	"ldmapi/internal/store"
)

// 请求体修改（渠道高级设置）：在请求体发往上游之前，按渠道配置删除或设置字段。
// 只认 JSON 请求体；multipart / 表单请求原样透传。
//
// 应用时机在协议转换之后，所以字段名要按上游协议书写：OpenAI 兼容渠道就是
// OpenAI 的字段，Anthropic / Gemini 渠道是各自协议的结构。这与 new-api 的
// 参数覆盖一致——改的是上游真正收到的请求体。

// editPathSeg 是解析后的一个路径段：对象键或数组下标。
type editPathSeg struct {
	key   string
	idx   int
	isIdx bool
}

// parseEditPath 把 "messages.0.role" 拆成三段。
//
// 规则与 gjson 的点号路径一致：点号分层，纯数字段是数组下标（支持负数，
// -1 表示最后一项），字段名本身带点号时用 \. 转义；转义过的数字段按对象键处理
// （对应 gjson 里 a."0" 的用法）。
func parseEditPath(raw string) ([]editPathSeg, error) {
	p := strings.TrimSpace(raw)
	if p == "" {
		return nil, errors.New("路径不能为空")
	}
	segs := make([]editPathSeg, 0, 4)
	var sb strings.Builder
	escaped := false
	flush := func() error {
		seg := sb.String()
		sb.Reset()
		wasEscaped := escaped
		escaped = false
		if seg == "" {
			return fmt.Errorf("路径“%s”里有空的层级", p)
		}
		if !wasEscaped && isPathIndex(seg) {
			n, err := strconv.Atoi(seg)
			if err != nil {
				return fmt.Errorf("路径“%s”里的下标 %s 有误", p, seg)
			}
			segs = append(segs, editPathSeg{idx: n, isIdx: true})
			return nil
		}
		segs = append(segs, editPathSeg{key: seg})
		return nil
	}
	for i := 0; i < len(p); i++ {
		c := p[i]
		switch c {
		case '\\':
			if i+1 >= len(p) {
				return nil, fmt.Errorf("路径“%s”以反斜杠结尾", p)
			}
			i++
			sb.WriteByte(p[i])
			escaped = true
		case '.':
			if err := flush(); err != nil {
				return nil, err
			}
		default:
			sb.WriteByte(c)
		}
	}
	if err := flush(); err != nil {
		return nil, err
	}
	return segs, nil
}

// isPathIndex 判断一段是不是数组下标（纯十进制数字，允许负号）。
func isPathIndex(seg string) bool {
	if seg == "" {
		return false
	}
	body := seg
	if body[0] == '-' {
		body = body[1:]
	}
	if body == "" {
		return false
	}
	for i := 0; i < len(body); i++ {
		if body[i] < '0' || body[i] > '9' {
			return false
		}
	}
	return true
}

// editIndex 把路径里的下标换算成实际位置；负数从末尾算起。
func editIndex(idx, length int) int {
	if idx < 0 {
		return length + idx
	}
	return idx
}

// getEditValue 按路径取值。第二个返回值为 false 表示路径不存在。
func getEditValue(root any, segs []editPathSeg) (any, bool) {
	cur := root
	for _, seg := range segs {
		if seg.isIdx {
			arr, ok := cur.([]any)
			if !ok {
				return nil, false
			}
			i := editIndex(seg.idx, len(arr))
			if i < 0 || i >= len(arr) {
				return nil, false
			}
			cur = arr[i]
			continue
		}
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		v, exists := m[seg.key]
		if !exists {
			return nil, false
		}
		cur = v
	}
	return cur, true
}

// setEditValue 在路径上写入 val，返回新的根。
//
// 中间层级缺失时按下一段的类型补对象或数组；中间层级存在但不是容器时直接替换——
// 用户明确要设置这个字段，保留一个不兼容的旧值只会让上游报错。
func setEditValue(root any, segs []editPathSeg, val any) (any, error) {
	if len(segs) == 0 {
		return val, nil
	}
	seg := segs[0]
	if seg.isIdx {
		arr, ok := root.([]any)
		if !ok {
			arr = []any{}
		}
		i := editIndex(seg.idx, len(arr))
		if i < 0 {
			return nil, fmt.Errorf("数组下标 %d 越界", seg.idx)
		}
		for len(arr) <= i {
			arr = append(arr, nil)
		}
		next, err := setEditValue(arr[i], segs[1:], val)
		if err != nil {
			return nil, err
		}
		arr[i] = next
		return arr, nil
	}
	m, ok := root.(map[string]any)
	if !ok {
		m = map[string]any{}
	}
	next, err := setEditValue(m[seg.key], segs[1:], val)
	if err != nil {
		return nil, err
	}
	m[seg.key] = next
	return m, nil
}

// pruneEmptyParents 把变空的父对象逐层删掉，返回新的根。
//
// 移动字段会把源字段摘走、删除字段会把它删掉，如果它原本是父对象里最后一个键，
// 父对象就成了 {"a": {}}。这种空壳对上游没有任何意义，有些严格的上游还会直接
// 400，所以顺手清掉；删掉一层后它自己的父级也可能变空，继续往上清。
//
// 只清对象键，不动数组元素：删除数组元素会让后面的下标整体前移，
// 把同一次请求里后续规则的目标路径全部错位，代价比留一个空壳大得多。
func pruneEmptyParents(root any, segs []editPathSeg) any {
	// 源本身就是顶层字段时没有父级可清。
	if len(segs) < 2 {
		return root
	}
	parent := segs[:len(segs)-1]
	if parent[len(parent)-1].isIdx {
		return root
	}
	cur, exists := getEditValue(root, parent)
	if !exists {
		return root
	}
	m, ok := cur.(map[string]any)
	if !ok || len(m) > 0 {
		return root
	}
	next, removed, err := deleteEditValue(root, parent)
	if err != nil || !removed {
		return root
	}
	return pruneEmptyParents(next, parent)
}

// deleteEditValue 删除路径上的字段，返回新的根。
// 第二个返回值表示是否真的删掉了内容；路径不存在时原样返回。
func deleteEditValue(root any, segs []editPathSeg) (any, bool, error) {
	if len(segs) == 0 {
		return root, false, errors.New("不能删除根节点")
	}
	seg := segs[0]
	last := len(segs) == 1

	if seg.isIdx {
		arr, ok := root.([]any)
		if !ok {
			return root, false, nil
		}
		i := editIndex(seg.idx, len(arr))
		if i < 0 || i >= len(arr) {
			return root, false, nil
		}
		if last {
			arr = append(arr[:i], arr[i+1:]...)
			return arr, true, nil
		}
		next, changed, err := deleteEditValue(arr[i], segs[1:])
		if err != nil || !changed {
			return root, changed, err
		}
		arr[i] = next
		return arr, true, nil
	}

	m, ok := root.(map[string]any)
	if !ok {
		return root, false, nil
	}
	if last {
		if _, exists := m[seg.key]; !exists {
			return root, false, nil
		}
		delete(m, seg.key)
		return m, true, nil
	}
	child, exists := m[seg.key]
	if !exists {
		return root, false, nil
	}
	next, changed, err := deleteEditValue(child, segs[1:])
	if err != nil || !changed {
		return root, changed, err
	}
	m[seg.key] = next
	return m, true, nil
}

// decodeEditValue 把保存的原始 JSON 解成 any，数字用 json.Number 保留精度。
func decodeEditValue(raw json.RawMessage) (any, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return v, nil
}

// editNumber 取出数值，供大小比较使用。
func editNumber(v any) (float64, bool) {
	switch n := v.(type) {
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}

// editStringOf 把任意 JSON 值转成用于「前缀 / 后缀 / 包含」比较的文本。
// 这四种比较按字符串语义走：数字用原文（json.Number）、布尔是 true / false、
// 对象和数组用紧凑 JSON，所以「数字 12 以 1 开头」「JSON 里含某段文字」都能命中。
func editStringOf(v any) (string, bool) {
	switch t := v.(type) {
	case nil:
		return "", false
	case string:
		return t, true
	case json.Number:
		return t.String(), true
	case bool:
		if t {
			return "true", true
		}
		return "false", true
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	// 和请求体重写保持同一套转义规则，含 < > & 的 JSON 也能按原文匹配。
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "", false
	}
	return strings.TrimRight(buf.String(), "\n"), true
}

// compareEditValues 按比较方式判断请求体里的值是否命中条件值。
// 「等于」按类型严格比较（字符串 "5" 不等于数字 5）；「前缀 / 后缀 / 包含」
// 先把两边转成文本；「大于 / 小于」两边都必须是数字。
func compareEditValues(have any, want any, mode string) bool {
	switch mode {
	case "", store.CondFull:
		return equalEditValues(have, want)
	case store.CondPrefix, store.CondSuffix, store.CondContains:
		hs, hok := editStringOf(have)
		ws, wok := editStringOf(want)
		if !hok || !wok {
			return false
		}
		switch mode {
		case store.CondPrefix:
			return strings.HasPrefix(hs, ws)
		case store.CondSuffix:
			return strings.HasSuffix(hs, ws)
		default:
			return strings.Contains(hs, ws)
		}
	case store.CondGt, store.CondGte, store.CondLt, store.CondLte:
		hn, hok := editNumber(have)
		wn, wok := editNumber(want)
		if !hok || !wok {
			return false
		}
		switch mode {
		case store.CondGt:
			return hn > wn
		case store.CondGte:
			return hn >= wn
		case store.CondLt:
			return hn < wn
		default:
			return hn <= wn
		}
	}
	return false
}

// equalEditValues 判断两个 JSON 值是否相等。数字按数值比较（1 与 1.0 相等），
// 对象和数组按结构比较，其余类型必须同类型且值相同。
func equalEditValues(have any, want any) bool {
	if have == nil || want == nil {
		return have == nil && want == nil
	}
	if hn, ok := editNumber(have); ok {
		wn, ok := editNumber(want)
		return ok && hn == wn
	}
	if hs, ok := have.(string); ok {
		ws, ok := want.(string)
		return ok && hs == ws
	}
	if hb, ok := have.(bool); ok {
		wb, ok := want.(bool)
		return ok && hb == wb
	}
	return reflect.DeepEqual(have, want)
}

// editConditionsPass 按 AND / OR 组合所有条件。没有条件时直接通过。
func editConditionsPass(root any, edit store.BodyEdit) bool {
	if len(edit.Conditions) == 0 {
		return true
	}
	and := strings.EqualFold(strings.TrimSpace(edit.Logic), "and")
	for _, cond := range edit.Conditions {
		segs, err := parseEditPath(cond.Path)
		if err != nil {
			// 路径写错的单条条件按不通过处理，不影响整次请求。
			if and {
				return false
			}
			continue
		}
		have, exists := getEditValue(root, segs)
		ok := false
		if !exists {
			ok = cond.PassMissingKey
		} else {
			want, err := decodeEditValue(cond.Value)
			if err == nil {
				ok = compareEditValues(have, want, cond.Mode)
			}
			if cond.Invert {
				ok = !ok
			}
		}
		if and {
			if !ok {
				return false
			}
			continue
		}
		if ok {
			return true
		}
	}
	return and
}

// ApplyBodyEdits 按顺序把渠道的请求体修改应用到 body 上。
//
// 返回新的请求体、是否有改动、以及错误。没有命中任何规则时返回原字节，
// 避免白白重排一次格式。请求体不是 JSON 对象时返回错误，由调用方决定
// 是放弃这次请求还是原样转发。
func ApplyBodyEdits(body []byte, edits []store.BodyEdit) ([]byte, bool, error) {
	if len(edits) == 0 || len(bytes.TrimSpace(body)) == 0 {
		return body, false, nil
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var root any
	if err := dec.Decode(&root); err != nil {
		return body, false, fmt.Errorf("请求体不是合法 JSON：%w", err)
	}
	obj, ok := root.(map[string]any)
	if !ok {
		return body, false, errors.New("请求体不是 JSON 对象")
	}

	changed := false
	for _, edit := range edits {
		segs, err := parseEditPath(edit.Path)
		if err != nil {
			// 配置在保存时已经校验过，这里只可能读到旧数据或手改的库，跳过不影响转发。
			continue
		}
		if !editConditionsPass(obj, edit) {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(edit.Mode)) {
		case store.BodyEditDelete:
			next, removed, err := deleteEditValue(obj, segs)
			if err != nil || !removed {
				continue
			}
			obj, _ = next.(map[string]any)
			// 删完变空的父对象一起清掉，和移动字段保持一致：
			// 空对象对上游没有意义，还可能被严格的接口判成非法参数。
			obj, _ = pruneEmptyParents(obj, segs).(map[string]any)
			changed = true
		case store.BodyEditSet, store.BodyEditPatch:
			_, exists := getEditValue(obj, segs)
			// 修改字段只在客户端已经带了该字段时生效：没传就跳过，不凭空造一个。
			if edit.Mode == store.BodyEditPatch && !exists {
				continue
			}
			// 设置字段默认覆盖；勾了「已有同名字段不覆盖」时，客户端自己传的就保留。
			if edit.Mode == store.BodyEditSet && edit.KeepOrigin && exists {
				continue
			}
			// 值解成原生结构再写入：后面的规则可以继续往里加字段，
			// 数字用 json.Number 保留原始精度。
			val, err := decodeEditValue(edit.Value)
			if err != nil {
				continue
			}
			next, err := setEditValue(obj, segs, val)
			if err != nil {
				continue
			}
			obj, _ = next.(map[string]any)
			changed = true
		case store.BodyEditMove:
			targets, err := parseEditPath(edit.Target)
			if err != nil {
				continue
			}
			val, exists := getEditValue(obj, segs)
			// 源字段不存在就没有可搬的值，跳过而不是凭空造一个。
			if !exists {
				continue
			}
			// 移动的语义就是「不要原来的」：源字段一律删掉，不看目标有没有值。
			// 勾了「目标已有值不覆盖」时目标保留自己的原值、源的值丢掉（不搬过去）；
			// 没勾就覆盖目标。两种情况下源都不能再出现在请求体里。
			overwrite := true
			if edit.KeepOrigin {
				if _, has := getEditValue(obj, targets); has {
					overwrite = false
				}
			}
			// 先删源再写目标：目标可能是源的子路径（a 搬到 a.b），
			// 顺序反过来会把刚写进去的值又删掉。
			next, removed, err := deleteEditValue(obj, segs)
			if err != nil || !removed {
				continue
			}
			obj, _ = next.(map[string]any)
			// 源是父对象里最后一个键时父对象会剩成空壳（{"a": {}}），
			// 一起清掉：空对象对上游没有意义，还可能被严格的接口判成非法参数。
			obj, _ = pruneEmptyParents(obj, segs).(map[string]any)
			before := changed
			changed = true
			if !overwrite {
				// 目标已有值且勾了不覆盖：源已经删掉，目标原样保留。
				continue
			}
			written, err := setEditValue(obj, targets, val)
			if err != nil {
				// 目标写不进去（例如负数下标越界）时把源值放回原位，
				// 别让一条配置有误的规则把字段吃掉；源放回去了就算没改动。
				if restore, rerr := setEditValue(obj, segs, val); rerr == nil {
					obj, _ = restore.(map[string]any)
					changed = before
				}
				continue
			}
			obj, _ = written.(map[string]any)
		case store.BodyEditCopy:
			targets, err := parseEditPath(edit.Target)
			if err != nil {
				continue
			}
			val, exists := getEditValue(obj, segs)
			// 源字段不存在就没有可复制的值，跳过而不是凭空造一个。
			if !exists {
				continue
			}
			// 勾了「目标已有值不覆盖」时目标原样保留，这种场景下复制等于没发生。
			if edit.KeepOrigin {
				if _, has := getEditValue(obj, targets); has {
					continue
				}
			}
			// 复制不动源字段，也不需要清理空父对象：源还在，父对象不会被搬空。
			written, err := setEditValue(obj, targets, val)
			if err != nil {
				continue
			}
			obj, _ = written.(map[string]any)
			changed = true
		}
	}
	if !changed {
		return body, false, nil
	}

	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	// 不转义 HTML 字符：请求内容里出现 < > & 时保持原样，只做字段层面的修改。
	enc.SetEscapeHTML(false)
	if err := enc.Encode(obj); err != nil {
		return body, false, fmt.Errorf("重新生成请求体失败：%w", err)
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), true, nil
}

// NormalizeBodyEdits 校验并规范化后台提交的请求体修改配置。
// 路径为空的行直接丢掉（前端加了空行没填），其余问题一律报错，
// 避免把一条永远不会生效的规则静默存下来。
func NormalizeBodyEdits(edits []store.BodyEdit) ([]store.BodyEdit, error) {
	if len(edits) == 0 {
		return nil, nil
	}
	out := make([]store.BodyEdit, 0, len(edits))
	for i, edit := range edits {
		label := fmt.Sprintf("第 %d 条规则", i+1)
		path := strings.TrimSpace(edit.Path)
		if path == "" {
			continue
		}
		if _, err := parseEditPath(path); err != nil {
			return nil, fmt.Errorf("%s：%s", label, err.Error())
		}
		mode := strings.ToLower(strings.TrimSpace(edit.Mode))
		if mode == "" {
			mode = store.BodyEditSet
		}
		next := store.BodyEdit{Mode: mode, Path: path}
		switch mode {
		case store.BodyEditDelete:
			// 删除不需要值和覆盖开关，顺手清掉避免历史脏数据留在库里。
		case store.BodyEditSet, store.BodyEditPatch:
			valueType := strings.ToLower(strings.TrimSpace(edit.ValueType))
			if valueType == "" {
				valueType = store.BodyValueJSON
			}
			norm, err := normalizeEditValue(valueType, edit.Value)
			if err != nil {
				return nil, fmt.Errorf("%s：%s", label, err.Error())
			}
			next.ValueType = valueType
			next.Value = norm
			// 「已有字段不覆盖」只对设置字段有意义：修改字段本身就是「客户端带了才改」。
			if mode == store.BodyEditSet {
				next.KeepOrigin = edit.KeepOrigin
			}
		case store.BodyEditMove:
			target := strings.TrimSpace(edit.Target)
			if target == "" {
				return nil, fmt.Errorf("%s：移动字段要填目标路径", label)
			}
			if _, err := parseEditPath(target); err != nil {
				return nil, fmt.Errorf("%s：目标路径有误：%s", label, err.Error())
			}
			if target == path {
				return nil, fmt.Errorf("%s：目标路径不能和源路径相同", label)
			}
			// 移动不需要值：搬过去的永远是请求体里现有的内容。
			// keep_origin 在移动里表示「目标已有值就保留目标自己的值」，
			// 但源字段无论哪种情况都会删掉——移动的语义就是不要原来的。
			next.Target = target
			next.KeepOrigin = edit.KeepOrigin
		case store.BodyEditCopy:
			target := strings.TrimSpace(edit.Target)
			if target == "" {
				return nil, fmt.Errorf("%s：复制字段要填目标路径", label)
			}
			if _, err := parseEditPath(target); err != nil {
				return nil, fmt.Errorf("%s：目标路径有误：%s", label, err.Error())
			}
			if target == path {
				return nil, fmt.Errorf("%s：目标路径不能和源路径相同", label)
			}
			// 复制不需要值：复制过去的永远是请求体里现有的内容。
			// keep_origin 表示目标已有值就保留目标自己的值，不覆盖。
			next.Target = target
			next.KeepOrigin = edit.KeepOrigin
		default:
			return nil, fmt.Errorf("%s：不支持的修改方式“%s”，只能是 set / patch / delete / move / copy", label, edit.Mode)
		}

		for j, cond := range edit.Conditions {
			condLabel := fmt.Sprintf("%s的条件 %d", label, j+1)
			condPath := strings.TrimSpace(cond.Path)
			if condPath == "" {
				continue
			}
			if _, err := parseEditPath(condPath); err != nil {
				return nil, fmt.Errorf("%s：%s", condLabel, err.Error())
			}
			condMode := strings.ToLower(strings.TrimSpace(cond.Mode))
			if condMode == "" {
				condMode = store.CondFull
			}
			switch condMode {
			case store.CondFull, store.CondPrefix, store.CondSuffix, store.CondContains,
				store.CondGt, store.CondGte, store.CondLt, store.CondLte:
			default:
				return nil, fmt.Errorf("%s：不支持的比较方式“%s”", condLabel, cond.Mode)
			}
			valueType := strings.ToLower(strings.TrimSpace(cond.ValueType))
			if valueType == "" {
				// 旧数据没有类型字段，按值本身推断，回填时不会跑偏成字符串。
				valueType = inferEditValueType(cond.Value)
			}
			raw, err := normalizeCondValue(valueType, cond.Value)
			if err != nil {
				return nil, fmt.Errorf("%s：%s", condLabel, err.Error())
			}
			next.Conditions = append(next.Conditions, store.BodyEditCondition{
				Path:           condPath,
				Mode:           condMode,
				ValueType:      valueType,
				Value:          raw,
				Invert:         cond.Invert,
				PassMissingKey: cond.PassMissingKey,
			})
		}
		// 没有条件时不用存关系，JSON 里少一个永远用不上的字段。
		if len(next.Conditions) > 0 {
			switch strings.ToLower(strings.TrimSpace(edit.Logic)) {
			case "and":
				next.Logic = "and"
			case "", "or":
				next.Logic = "or"
			default:
				return nil, fmt.Errorf("%s：条件关系只能是 and 或 or", label)
			}
		}
		out = append(out, next)
	}
	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}

// normalizeEditValue 按声明的类型校验写入值，返回压紧后的原始 JSON。
func normalizeEditValue(valueType string, raw json.RawMessage) (json.RawMessage, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, errors.New("设置字段需要填写值")
	}
	if !json.Valid(trimmed) {
		return nil, errors.New("值不是合法的 JSON")
	}
	v, err := decodeEditValue(trimmed)
	if err != nil {
		return nil, errors.New("值不是合法的 JSON")
	}
	if err := checkTypedValue(valueType, v); err != nil {
		return nil, err
	}
	return trimmed, nil
}

// normalizeCondValue 校验条件值。空值按 null 处理，与 new-api 一致：
// 可以用来判断某个字段是不是 null。
func normalizeCondValue(valueType string, raw json.RawMessage) (json.RawMessage, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return json.RawMessage("null"), nil
	}
	if !json.Valid(trimmed) {
		return nil, errors.New("条件值不是合法的 JSON")
	}
	v, err := decodeEditValue(trimmed)
	if err != nil {
		return nil, errors.New("条件值不是合法的 JSON")
	}
	if err := checkTypedValue(valueType, v); err != nil {
		return nil, err
	}
	return trimmed, nil
}

// checkTypedValue 按声明的类型检查解析后的 JSON 值。
// 类型必须真的对得上：选择「数字」却填了 "5" 会直接报错，而不是存下去以后
// 在调用时才表现为「条件永远不命中」。
func checkTypedValue(valueType string, v any) error {
	switch valueType {
	case store.BodyValueString:
		if _, ok := v.(string); !ok {
			return errors.New("声明为字符串，但填入的不是字符串")
		}
	case store.BodyValueNumber:
		if _, ok := v.(json.Number); !ok {
			return errors.New("声明为数字，但填入的不是数字")
		}
	case store.BodyValueBoolean:
		if _, ok := v.(bool); !ok {
			return errors.New("声明为布尔，但填入的不是 true / false")
		}
	case store.BodyValueJSON:
		// 任意合法 JSON 都行。
	default:
		return fmt.Errorf("不支持的值类型“%s”，只能是 string / number / boolean / json", valueType)
	}
	return nil
}

// inferEditValueType 按 JSON 值的实际类型推断 value_type，
// 供没有类型字段的旧数据（以及空值）使用。
func inferEditValueType(raw json.RawMessage) string {
	v, err := decodeEditValue(raw)
	if err != nil || v == nil {
		return store.BodyValueJSON
	}
	switch v.(type) {
	case string:
		return store.BodyValueString
	case json.Number:
		return store.BodyValueNumber
	case bool:
		return store.BodyValueBoolean
	}
	return store.BodyValueJSON
}
