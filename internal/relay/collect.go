package relay

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"ldmapi/internal/upstream"
)

// withStream 复制一份请求体并把 stream 打开。
// 不能直接改调用方的原始请求体：同一次请求可能在多条路由之间重试，
// 后面失败的尝试不该带上「强制流式」的痕迹；客户端要的形态也不应该被改写。
func withStream(in map[string]any) map[string]any {
	out := make(map[string]any, len(in)+1)
	for k, v := range in {
		out[k] = v
	}
	out["stream"] = true
	return out
}

// collectStream 读完整条上游流式响应，聚合成一次完整的非流式响应写给调用方。
//
// 用于「强制流式」：调用方要非流式，网关却按流式请求上游（超时只约束首字），
// 拿到内容后自己收集完再返回。也用于上游在非流式请求下自行回了流的情况。
// 返回的 outcome 在失败时 wrote 为 false——这时还没有任何一个字节写给调用方，
// 因此可以像普通非流式请求一样继续尝试后面的路由。
func collectStream(ctx context.Context, w http.ResponseWriter, req *Request, resp *http.Response,
	st upstream.Stream, timer *time.Timer, timedOut *atomic.Bool, started time.Time) attemptOutcome {

	col := upstream.NewCollector()
	// 兜底值先用响应头到达的时间：上游一直没吐内容（例如中途断开）时，
	// 至少还能看出等响应头花了多久。拿到第一段真正的内容后会覆盖成更准的值。
	firstByte := time.Since(started).Milliseconds()
	gotFirst := false
	gotContent := false
	reader := resp.Body
	tmp := make([]byte, 32*1024)
	var pending []byte
	// consume 把一行上游数据喂给翻译器，并在第一段真正的内容到达时记下首字。
	consume := func(line []byte) {
		out := st.Translate(line)
		if len(out) == 0 {
			return
		}
		col.Feed(out)
		if !gotContent && col.HasContent() {
			gotContent = true
			firstByte = time.Since(started).Milliseconds()
		}
	}
	for {
		n, rerr := reader.Read(tmp)
		if n > 0 {
			// 首块数据到达：超时只约束到首字，之后不再限时。
			// 定时器按「首块数据」停，与流式路径保持一致：心跳也算上游活着，
			// 只是不计入下面展示的首字耗时。
			if !gotFirst {
				gotFirst = true
				timer.Stop()
			}
			pending = append(pending, tmp[:n]...)
			for {
				idx := indexByte(pending, '\n')
				if idx < 0 {
					break
				}
				line := pending[:idx]
				pending = pending[idx+1:]
				consume(line)
			}
		}
		if rerr == nil {
			continue
		}
		if rerr == io.EOF {
			break
		}
		// 调用方断开（点停止、关页面）不是上游的问题，也不能再写响应。
		if ctx.Err() != nil {
			return attemptOutcome{err: errors.New("客户端已断开连接"), canceled: true, firstByte: firstByte}
		}
		if timedOut.Load() {
			return attemptOutcome{err: errors.New("上游响应超时"), retryable: true,
				status: http.StatusBadGateway, firstByte: firstByte, keyFailed: true}
		}
		return attemptOutcome{err: fmt.Errorf("读取上游响应失败: %w", rerr), retryable: true,
			status: http.StatusBadGateway, firstByte: firstByte, keyFailed: true}
	}
	if len(pending) > 0 {
		consume(pending)
	}
	if out := st.Finish(); len(out) > 0 {
		col.Feed(out)
	}
	usage, estimated := streamUsage(st, req)
	// 翻译过程中遇到的致命错误（例如 Anthropic 的 error 事件）：
	// 此时还没写给调用方，按上游失败处理，让请求换下一条路由。
	// 已经收到的半截内容直接丢弃，不能当成正常回复返回。
	if err := st.Err(); err != nil {
		return attemptOutcome{err: fmt.Errorf("上游流式响应出错: %v", err), retryable: true,
			status: http.StatusBadGateway, firstByte: firstByte, keyFailed: true,
			upstreamBroken: true}
	}
	// 一个数据块都没解析出来：上游的流不是可用的对话内容（协议不匹配、
	// 只有心跳等）。这种空响应不能当成成功返回，按上游失败处理换路由。
	if col.Chunks() == 0 {
		return attemptOutcome{err: errors.New("上游流式响应为空"), retryable: true,
			status: http.StatusBadGateway, firstByte: firstByte, keyFailed: true,
			upstreamBroken: true}
	}

	h := w.Header()
	// 上游流式响应的 Content-Type 是 text/event-stream，不能透传：
	// 调用方要的是非流式，这里必须按 JSON 返回。
	for k, vs := range resp.Header {
		if strings.HasPrefix(strings.ToLower(k), "x-") {
			for _, v := range vs {
				h.Set(k, v)
			}
		}
	}
	h.Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(resp.StatusCode)
	w.Write(mustJSON(collectedResponse(req.Path, modelOf(req), col, usage)))

	return attemptOutcome{status: resp.StatusCode, usage: usage, firstByte: firstByte,
		wrote: true, estimated: estimated, reasoning: st.ReasoningChars()}
}

// collectedResponse 把聚合结果写成对应端点的非流式响应体。
// 网关对外的响应统一是 OpenAI 结构，形状与直接非流式转发保持一致。
func collectedResponse(path, model string, col *upstream.Collector, usage upstream.Usage) map[string]any {
	created := col.Created
	if created == 0 {
		created = time.Now().Unix()
	}
	// 上游给了模型名就用上游的（与流式 / 非流式透传一致），没给就用调用方请求的名字。
	name := strings.TrimSpace(col.Model)
	if name == "" {
		name = model
	}
	finish := col.Finish
	if finish == "" {
		finish = "stop"
	}
	content := col.Content.String()
	reasoning := col.Reasoning.String()
	usageMap := openAIUsageMap(usage)

	if strings.HasSuffix(strings.TrimSuffix(path, "/"), "/completions") &&
		!strings.HasSuffix(strings.TrimSuffix(path, "/"), "/chat/completions") {
		choice := map[string]any{
			"text": content, "index": 0, "logprobs": nil, "finish_reason": finish,
		}
		if reasoning != "" {
			choice["reasoning_content"] = reasoning
		}
		return map[string]any{
			"id":      nonEmptyID(col.ID, "cmpl-"),
			"object":  "text_completion",
			"created": created,
			"model":   name,
			"choices": []any{choice},
			"usage":   usageMap,
		}
	}

	message := map[string]any{"role": "assistant", "content": content}
	if reasoning != "" {
		message["reasoning_content"] = reasoning
	}
	if len(col.ToolCalls) > 0 {
		calls := make([]any, 0, len(col.ToolCalls))
		for _, tc := range col.ToolCalls {
			args := strings.TrimSpace(tc.Arguments)
			if args == "" {
				args = "{}"
			}
			id := tc.ID
			if id == "" {
				id = "call_" + customContentID()
			}
			calls = append(calls, map[string]any{
				"id": id, "type": "function",
				"function": map[string]any{"name": tc.Name, "arguments": args},
			})
		}
		message["tool_calls"] = calls
		// 与 Anthropic 非流式转换保持一致：只有工具调用时正文留空（null）。
		if content == "" {
			message["content"] = nil
		}
	}
	return map[string]any{
		"id":      nonEmptyID(col.ID, "chatcmpl-"),
		"object":  "chat.completion",
		"created": created,
		"model":   name,
		"choices": []any{map[string]any{
			"index": 0, "message": message, "finish_reason": finish,
		}},
		"usage": usageMap,
	}
}

// nonEmptyID 在上游没给响应 ID 时补一个带前缀的随机 ID。
func nonEmptyID(id, prefix string) string {
	if s := strings.TrimSpace(id); s != "" {
		return s
	}
	return prefix + customContentID()
}

// openAIUsageMap 把内部用量渲染成 OpenAI 兼容的 usage 对象，
// 缓存命中与思考 token 按 OpenAI 的字段位置带上，便于调用方统计。
func openAIUsageMap(us upstream.Usage) map[string]any {
	out := map[string]any{
		"prompt_tokens":     us.PromptTokens,
		"completion_tokens": us.CompletionTokens,
		"total_tokens":      us.TotalTokens,
	}
	if us.CachedTokens > 0 {
		out["prompt_tokens_details"] = map[string]any{"cached_tokens": us.CachedTokens}
	}
	if us.ReasoningTokens > 0 {
		out["completion_tokens_details"] = map[string]any{"reasoning_tokens": us.ReasoningTokens}
	}
	return out
}
