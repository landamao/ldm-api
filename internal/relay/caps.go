package relay

import (
	"encoding/json"
	"net/http"
	"strings"

	"ldmapi/internal/store"
)

// imageRemovedText 是图片被移除后留下的占位文本，避免整条消息变成空内容。
const imageRemovedText = "[图片已因模型不支持而被移除]"

// thinkingKeys 是各家协议里表示「本次请求要思考」的顶层参数。
var thinkingKeys = []string{
	"reasoning_effort", "thinking", "enable_thinking", "reasoning",
	"include_reasoning", "thinking_budget", "reasoning_budget",
}

// capViolation 是请求里命中的一项模型明确不支持的输入能力。
type capViolation struct {
	kind  string // thinking / tool / vision
	label string // 对外文案：思考 / 工具调用 / 图片输入
}

// capsRejection 是一次能力校验失败，调用方已经收到错误响应。
type capsRejection struct {
	status    int
	clientErr string
	detail    string
}

// enforceModelCaps 在转发前按模型的能力参数处理请求：
//   - 能力标记为「不支持」且开启报错：直接返回 400；
//   - 能力标记为「不支持」但未开启报错：从请求里移除相关内容后继续；
//   - 「支持」或「不设置」：不做任何处理。
//
// 返回非 nil 表示已经写出错误响应；否则请求可能已被就地清理。
func enforceModelCaps(w http.ResponseWriter, req *Request, m store.Model) *capsRejection {
	violations := unsupportedInput(req.JSON, m.Caps)
	if len(violations) == 0 {
		return nil
	}
	for _, v := range violations {
		if !rejectUnsupported(m.Caps, v.kind) {
			continue
		}
		msg := "模型「" + m.ID + "」不支持" + v.label
		writeAPIError(w, http.StatusBadRequest, "invalid_request_error", msg)
		return &capsRejection{
			status:    http.StatusBadRequest,
			clientErr: msg,
			detail:    "模型能力校验：请求包含" + v.label + "内容，模型标记为不支持并开启了报错",
		}
	}
	// 命中的能力都没有开启报错：从上下文里移除后继续请求上游。
	stripUnsupportedInput(req, m.Caps)
	return nil
}

// rejectUnsupported 返回某项能力是否标记为不支持且要求报错。
func rejectUnsupported(c store.Caps, kind string) bool {
	switch kind {
	case "thinking":
		return c.Thinking != nil && !*c.Thinking && c.ThinkingError
	case "tool":
		return c.ToolCalling != nil && !*c.ToolCalling && c.ToolCallingError
	case "vision":
		return c.Vision != nil && !*c.Vision && c.VisionError
	}
	return false
}

// unsupportedInput 返回请求里用到的、模型明确声明不支持的输入能力。
// 顺序固定为思考、工具调用、图片输入，便于对外文案稳定。
func unsupportedInput(body map[string]any, caps store.Caps) []capViolation {
	if body == nil {
		return nil
	}
	var out []capViolation
	if c := caps.Thinking; c != nil && !*c && hasThinkingInput(body) {
		out = append(out, capViolation{kind: "thinking", label: "思考"})
	}
	if c := caps.ToolCalling; c != nil && !*c && hasToolInput(body) {
		out = append(out, capViolation{kind: "tool", label: "工具调用"})
	}
	if c := caps.Vision; c != nil && !*c && hasImageInput(body) {
		out = append(out, capViolation{kind: "vision", label: "图片输入"})
	}
	return out
}

// ---------- 检测 ----------

func hasThinkingInput(body map[string]any) bool {
	for _, k := range thinkingKeys {
		if v, ok := body[k]; ok && thinkingActive(v) {
			return true
		}
	}
	// 历史消息里的思考内容同样算命中：模型不支持思考时，
	// 不能让调用方把思考内容（包括伪造注入的）带进上下文。
	for _, mv := range listOf(body["messages"]) {
		m := mapOf(mv)
		if m == nil {
			continue
		}
		for _, k := range []string{"reasoning_content", "reasoning", "reasoning_details"} {
			if v, ok := m[k]; ok && valueTruthy(v) {
				return true
			}
		}
		for _, pv := range listOf(m["content"]) {
			if p := mapOf(pv); p != nil && isThinkingPart(p) {
				return true
			}
		}
	}
	for _, iv := range listOf(body["input"]) {
		item := mapOf(iv)
		if item == nil {
			continue
		}
		if strings.EqualFold(stringOf(item["type"]), "reasoning") {
			return true
		}
		for _, pv := range listOf(item["content"]) {
			if p := mapOf(pv); p != nil && isThinkingPart(p) {
				return true
			}
		}
	}
	return false
}

// thinkingActive 判断一个思考参数是否真的要求思考；
// 显式的 false / 0 / "none" / type=disabled 不算。
func thinkingActive(v any) bool {
	if !valueTruthy(v) {
		return false
	}
	if m := mapOf(v); m != nil {
		switch strings.ToLower(stringOf(m["type"])) {
		case "disabled", "none":
			return false
		}
		if b, ok := m["enabled"].(bool); ok && !b {
			return false
		}
		return true
	}
	switch strings.ToLower(strings.TrimSpace(stringOf(v))) {
	case "none", "off", "disabled", "false":
		return false
	}
	return true
}

func hasToolInput(body map[string]any) bool {
	if len(listOf(body["tools"])) > 0 || len(listOf(body["functions"])) > 0 {
		return true
	}
	for _, mv := range listOf(body["messages"]) {
		m := mapOf(mv)
		if m == nil {
			continue
		}
		switch strings.ToLower(stringOf(m["role"])) {
		case "tool", "function":
			return true
		}
		if len(listOf(m["tool_calls"])) > 0 {
			return true
		}
		if v, ok := m["function_call"]; ok && valueTruthy(v) {
			return true
		}
		for _, pv := range listOf(m["content"]) {
			if isToolPart(pv) {
				return true
			}
		}
	}
	for _, iv := range listOf(body["input"]) {
		item := mapOf(iv)
		if item == nil {
			continue
		}
		if isToolPartType(stringOf(item["type"])) {
			return true
		}
		for _, pv := range listOf(item["content"]) {
			if isToolPart(pv) {
				return true
			}
		}
	}
	return false
}

func isToolPart(v any) bool {
	p := mapOf(v)
	return p != nil && isToolPartMap(p)
}

func isToolPartMap(p map[string]any) bool {
	return isToolPartType(stringOf(p["type"]))
}

func isToolPartType(t string) bool {
	switch t {
	case "tool_use", "tool_result", "function_call", "function_call_output":
		return true
	}
	return false
}

func hasImageInput(body map[string]any) bool {
	for _, mv := range listOf(body["messages"]) {
		if m := mapOf(mv); m != nil && contentHasImage(m["content"]) {
			return true
		}
	}
	for _, iv := range listOf(body["input"]) {
		item := mapOf(iv)
		if item == nil {
			continue
		}
		if isImagePart(item) || contentHasImage(item["content"]) {
			return true
		}
	}
	return false
}

func contentHasImage(content any) bool {
	for _, pv := range listOf(content) {
		if isImagePart(pv) {
			return true
		}
	}
	return false
}

func isImagePart(v any) bool {
	p := mapOf(v)
	return p != nil && isImagePartMap(p)
}

func isImagePartMap(p map[string]any) bool {
	switch stringOf(p["type"]) {
	case "image_url", "input_image", "image":
		return true
	}
	return false
}

// ---------- 清理 ----------

func stripUnsupportedInput(req *Request, caps store.Caps) {
	body := req.JSON
	if body == nil {
		return
	}
	changed := false
	if c := caps.Thinking; c != nil && !*c {
		changed = stripThinkingInput(body) || changed
	}
	if c := caps.ToolCalling; c != nil && !*c {
		changed = stripToolInput(body) || changed
	}
	if c := caps.Vision; c != nil && !*c {
		changed = stripImageInput(body) || changed
	}
	if changed {
		// 非对话端点（例如 Responses）是直接透传 req.Body 的，必须同步重建。
		req.Body = mustJSON(body)
	}
}

func stripThinkingInput(body map[string]any) bool {
	changed := false
	for _, k := range thinkingKeys {
		if _, ok := body[k]; ok {
			delete(body, k)
			changed = true
		}
	}
	if msgs, ok := body["messages"].([]any); ok {
		kept := make([]any, 0, len(msgs))
		for _, mv := range msgs {
			m := mapOf(mv)
			if m == nil {
				kept = append(kept, mv)
				continue
			}
			removed := false
			for _, k := range []string{"reasoning_content", "reasoning", "reasoning_details"} {
				if _, ok := m[k]; ok {
					delete(m, k)
					removed = true
				}
			}
			if parts, ok := m["content"].([]any); ok {
				np, r := removeParts(parts, isThinkingPart)
				if r {
					m["content"] = np
					removed = true
				}
			}
			if removed {
				changed = true
				if isEmptyContent(m["content"]) && !messageHasToolCalls(m) {
					continue
				}
			}
			kept = append(kept, mv)
		}
		if len(kept) != len(msgs) {
			body["messages"] = kept
		}
	}
	if items, ok := body["input"].([]any); ok {
		kept := make([]any, 0, len(items))
		for _, iv := range items {
			item := mapOf(iv)
			if item != nil && strings.EqualFold(stringOf(item["type"]), "reasoning") {
				changed = true
				continue
			}
			kept = append(kept, iv)
		}
		if len(kept) != len(items) {
			body["input"] = kept
		}
	}
	return changed
}

func isThinkingPart(p map[string]any) bool {
	switch stringOf(p["type"]) {
	case "thinking", "redacted_thinking", "reasoning":
		return true
	}
	return false
}

func stripToolInput(body map[string]any) bool {
	changed := false
	for _, k := range []string{"tools", "tool_choice", "functions", "function_call"} {
		if _, ok := body[k]; ok {
			delete(body, k)
			changed = true
		}
	}
	if msgs, ok := body["messages"].([]any); ok {
		kept := make([]any, 0, len(msgs))
		for _, mv := range msgs {
			m := mapOf(mv)
			if m == nil {
				kept = append(kept, mv)
				continue
			}
			switch strings.ToLower(stringOf(m["role"])) {
			case "tool", "function":
				changed = true
				continue
			}
			removed := false
			for _, k := range []string{"tool_calls", "function_call"} {
				if _, ok := m[k]; ok {
					delete(m, k)
					removed = true
				}
			}
			if parts, ok := m["content"].([]any); ok {
				np, r := removeParts(parts, isToolPartMap)
				if r {
					m["content"] = np
					removed = true
				}
			}
			if removed {
				changed = true
				if isEmptyContent(m["content"]) {
					continue
				}
			}
			kept = append(kept, mv)
		}
		if len(kept) != len(msgs) {
			body["messages"] = kept
		}
	}
	if items, ok := body["input"].([]any); ok {
		kept := make([]any, 0, len(items))
		for _, iv := range items {
			item := mapOf(iv)
			if item != nil && isToolPartType(stringOf(item["type"])) {
				changed = true
				continue
			}
			kept = append(kept, iv)
		}
		if len(kept) != len(items) {
			body["input"] = kept
		}
	}
	return changed
}

func stripImageInput(body map[string]any) bool {
	changed := false
	if msgs, ok := body["messages"].([]any); ok {
		for _, mv := range msgs {
			m := mapOf(mv)
			if m == nil {
				continue
			}
			parts, ok := m["content"].([]any)
			if !ok {
				continue
			}
			np, removed := removeParts(parts, isImagePartMap)
			if !removed {
				continue
			}
			if len(np) == 0 {
				np = []any{map[string]any{"type": "text", "text": imageRemovedText}}
			}
			m["content"] = np
			changed = true
		}
	}
	if items, ok := body["input"].([]any); ok {
		kept := make([]any, 0, len(items))
		for _, iv := range items {
			item := mapOf(iv)
			if item == nil {
				kept = append(kept, iv)
				continue
			}
			if isImagePart(item) {
				changed = true
				continue
			}
			parts, ok := item["content"].([]any)
			if !ok {
				kept = append(kept, iv)
				continue
			}
			np, removed := removeParts(parts, isImagePartMap)
			if removed {
				if len(np) == 0 {
					np = []any{map[string]any{"type": "input_text", "text": imageRemovedText}}
				}
				item["content"] = np
				changed = true
			}
			kept = append(kept, iv)
		}
		if len(kept) != len(items) {
			body["input"] = kept
		}
	}
	return changed
}

// removeParts 移除不符合条件的内容块；没有移除时返回原切片。
func removeParts(parts []any, drop func(map[string]any) bool) ([]any, bool) {
	kept := make([]any, 0, len(parts))
	removed := false
	for _, pv := range parts {
		if p := mapOf(pv); p != nil && drop(p) {
			removed = true
			continue
		}
		kept = append(kept, pv)
	}
	if !removed {
		return parts, false
	}
	return kept, true
}

func messageHasToolCalls(m map[string]any) bool {
	return len(listOf(m["tool_calls"])) > 0 || valueTruthy(m["function_call"])
}

func isEmptyContent(v any) bool {
	switch c := v.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(c) == ""
	case []any:
		for _, pv := range c {
			p := mapOf(pv)
			if p == nil {
				return false
			}
			if t := stringOf(p["type"]); t != "" && t != "text" && t != "input_text" {
				return false
			}
			if strings.TrimSpace(stringOf(p["text"])) != "" {
				return false
			}
		}
		return true
	}
	return false
}

// ---------- 通用取值 ----------

func mapOf(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return nil
}

func listOf(v any) []any {
	if s, ok := v.([]any); ok {
		return s
	}
	return nil
}

func stringOf(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// valueTruthy 判断 JSON 值是否表示「开启 / 有内容」。
// relay 解析请求时用了 UseNumber，这里要同时兼容 json.Number 和 float64。
func valueTruthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return strings.TrimSpace(x) != ""
	case json.Number:
		f, err := x.Float64()
		return err == nil && f != 0
	case float64:
		return x != 0
	case float32:
		return x != 0
	case int:
		return x != 0
	case int64:
		return x != 0
	case []any:
		return len(x) > 0
	case map[string]any:
		return len(x) > 0
	}
	return true
}
