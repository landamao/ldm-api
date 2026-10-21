package relay

import (
	"strings"
)

// applySystemPrompt 用模型配置的系统提示词覆盖请求里自带的系统提示词：
// 删除所有系统消息，只保留配置内容并放在最前面。
// 支持 OpenAI 对话（messages 里的 system/developer）、Anthropic 原生
// （顶层 system 字段）和 Responses（instructions + input 里的系统条目）。
func applySystemPrompt(req *Request, prompt string) {
	if req.JSON == nil {
		return
	}
	prompt = strings.TrimSpace(prompt)
	changed := false

	if msgs, ok := req.JSON["messages"].([]any); ok {
		kept := make([]any, 0, len(msgs)+1)
		for _, mv := range msgs {
			if m, ok := mv.(map[string]any); ok && isSystemRole(m["role"]) {
				changed = true
				continue
			}
			kept = append(kept, mv)
		}
		// Anthropic 原生的顶层 system 字段也一并去掉，避免上游收到两份。
		if _, ok := req.JSON["system"]; ok {
			delete(req.JSON, "system")
			changed = true
		}
		if prompt != "" {
			kept = append([]any{map[string]any{"role": "system", "content": prompt}}, kept...)
			changed = true
		}
		if changed {
			req.JSON["messages"] = kept
		}
	} else if _, ok := req.JSON["system"]; ok {
		// 没有 messages 的 Anthropic 风格请求：顶层 system 同样换成配置内容。
		if prompt != "" {
			req.JSON["system"] = prompt
		} else {
			delete(req.JSON, "system")
		}
		changed = true
	}

	// Responses API 的系统提示词放在 instructions，input 里也可能带系统条目。
	path := strings.TrimSuffix(req.Path, "/")
	if strings.HasSuffix(path, "/responses") || strings.HasSuffix(path, "/responses/compact") {
		if prompt != "" {
			req.JSON["instructions"] = prompt
		} else {
			delete(req.JSON, "instructions")
		}
		if items, ok := req.JSON["input"].([]any); ok {
			kept := make([]any, 0, len(items))
			for _, item := range items {
				if m, ok := item.(map[string]any); ok && isSystemRole(m["role"]) {
					continue
				}
				kept = append(kept, item)
			}
			req.JSON["input"] = kept
		}
		changed = true
	}

	// 非对话端点的请求体通常原样透传，这里同步重建一次，
	// 保证注入对直接透传请求体的渠道类型也生效。
	if changed {
		req.Body = mustJSON(req.JSON)
	}
}

func isSystemRole(v any) bool {
	s, _ := v.(string)
	switch strings.ToLower(s) {
	case "system", "developer":
		return true
	}
	return false
}
