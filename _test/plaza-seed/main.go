// 一次性示例数据脚本：为模型广场演示生成渠道、模型与近 24 小时统计。
// 用法：go run ./_test/plaza-seed -db _test/plaza-demo/data/ldmapi.db
package main

import (
	"flag"
	"fmt"
	"log"
	"time"

	"ldmapi/internal/store"
)

func intp(v int) *int    { return &v }
func boolp(v bool) *bool { return &v }

type modelSeed struct {
	id          string
	upstream    string
	channelID   string
	providerID  string
	description string
	tags        []string
	caps        store.Caps
	requests    int
	errors      int
}

// 渠道模型 ID 必须使用「渠道ID/上游模型名」的形式，和界面添加模型时保持一致。
func (ms modelSeed) modelID() string {
	return ms.channelID + "/" + ms.upstream
}

type channelSeed struct {
	id      string
	name    string
	typ     string
	baseURL string
	remark  string
}

func main() {
	dbPath := flag.String("db", "_test/plaza-demo/data/ldmapi.db", "BoltDB 路径")
	flag.Parse()

	st, err := store.Open(*dbPath)
	if err != nil {
		log.Fatalf("打开数据库失败: %v", err)
	}
	defer st.Close()

	now := time.Now().UnixMilli()

	channels := []channelSeed{
		{"ch_openai_main", "OpenAI 主线路", store.ChannelOpenAI, "https://api.openai.com", "演示数据"},
		{"ch_openai_backup", "OpenAI 备用线路", store.ChannelOpenAI, "https://api.openai.com", "演示数据"},
		{"ch_anthropic", "Anthropic 官方", store.ChannelAnthropic, "https://api.anthropic.com", "演示数据"},
		{"ch_gemini", "Google Gemini", store.ChannelGemini, "https://generativelanguage.googleapis.com", "演示数据"},
		{"ch_deepseek", "DeepSeek 官方", store.ChannelOpenAI, "https://api.deepseek.com", "演示数据"},
		{"ch_aliyun", "阿里云百炼", store.ChannelOpenAI, "https://dashscope.aliyuncs.com/compatible-mode", "演示数据"},
		{"ch_moonshot", "月之暗面", store.ChannelOpenAI, "https://api.moonshot.cn", "演示数据"},
		{"ch_zhipu", "智谱开放平台", store.ChannelOpenAI, "https://open.bigmodel.cn/api/paas", "演示数据"},
		{"ch_xai", "xAI", store.ChannelOpenAI, "https://api.x.ai", "演示数据"},
		{"ch_volc", "火山方舟", store.ChannelOpenAI, "https://ark.cn-beijing.volces.com/api/v3", "演示数据"},
	}
	for i, c := range channels {
		appendV1 := true
		if c.id == "ch_volc" {
			appendV1 = false
		}
		ch := store.Channel{
			ID: c.id, Name: c.name, Type: c.typ, BaseURL: c.baseURL,
			APIKey: "sk-demo-0000000000000000", Enabled: true, Weight: 1,
			AppendV1: boolp(appendV1), Remark: c.remark,
			CreatedAt: now - int64(len(channels)-i)*1000, UpdatedAt: now,
		}
		if err := st.SaveChannel(ch); err != nil {
			log.Fatalf("写入渠道 %s 失败: %v", c.id, err)
		}
	}

	models := []modelSeed{
		{
			id: "gpt-5.2", upstream: "gpt-5.2", channelID: "ch_openai_main", providerID: "openai",
			description: "旗舰通用模型，适合复杂推理与长文写作。", tags: []string{"旗舰"},
			caps:     store.Caps{ContextLength: intp(400000), MaxOutput: intp(128000), ToolCalling: boolp(true), Thinking: boolp(true), Vision: boolp(true)},
			requests: 700, errors: 0,
		},
		{
			id: "claude-sonnet-4.5", upstream: "claude-sonnet-4.5", channelID: "ch_anthropic", providerID: "claude",
			description: "均衡型模型，代码与长上下文表现稳定。", tags: []string{"代码"},
			caps:     store.Caps{ContextLength: intp(200000), MaxOutput: intp(64000), ToolCalling: boolp(true), Thinking: boolp(true), Vision: boolp(true)},
			requests: 700, errors: 35,
		},
		{
			id: "gemini-2.5-pro", upstream: "gemini-2.5-pro", channelID: "ch_gemini", providerID: "gemini",
			description: "超长上下文与多模态理解。", tags: []string{"多模态"},
			caps:     store.Caps{ContextLength: intp(1048576), MaxOutput: intp(65536), ToolCalling: boolp(true), Thinking: boolp(true), Vision: boolp(true)},
			requests: 700, errors: 70,
		},
		{
			id: "deepseek-v3.2", upstream: "deepseek-chat", channelID: "ch_deepseek", providerID: "deepseek",
			description: "高性价比推理模型，中文场景友好。", tags: []string{"性价比"},
			caps:     store.Caps{ContextLength: intp(128000), MaxOutput: intp(32768), ToolCalling: boolp(true), Thinking: boolp(true)},
			requests: 700, errors: 71,
		},
		{
			id: "qwen3-max", upstream: "qwen3-max", channelID: "ch_aliyun", providerID: "alibaba",
			description: "通义千问旗舰版，工具调用能力强。", tags: []string{"通义"},
			caps:     store.Caps{ContextLength: intp(262144), MaxOutput: intp(32768), ToolCalling: boolp(true), Thinking: boolp(true)},
			requests: 700, errors: 105,
		},
		{
			id: "kimi-k2", upstream: "kimi-k2", channelID: "ch_moonshot", providerID: "moonshot",
			description: "长文本处理与智能体任务。", tags: []string{"长文本"},
			caps:     store.Caps{ContextLength: intp(262144), MaxOutput: intp(32768), ToolCalling: boolp(true)},
			requests: 700, errors: 140,
		},
		{
			id: "glm-4.6", upstream: "glm-4.6", channelID: "ch_zhipu", providerID: "zhipu",
			description: "中文理解与代码生成。", tags: []string{"中文"},
			caps:     store.Caps{ContextLength: intp(204800), MaxOutput: intp(32768), ToolCalling: boolp(true), Thinking: boolp(true)},
			requests: 700, errors: 141,
		},
		{
			id: "grok-4.1", upstream: "grok-4.1", channelID: "ch_xai", providerID: "xai",
			description: "实时信息与推理。", tags: []string{"推理"},
			caps:     store.Caps{ContextLength: intp(262144), MaxOutput: intp(32768), ToolCalling: boolp(true), Thinking: boolp(true)},
			requests: 700, errors: 175,
		},
		{
			id: "llama-4-maverick", upstream: "llama-4-maverick", channelID: "ch_openai_backup", providerID: "",
			description: "开源多模态模型，走兼容接口。", tags: []string{"开源"},
			caps:     store.Caps{ContextLength: intp(1048576), MaxOutput: intp(32768), ToolCalling: boolp(true), Vision: boolp(true)},
			requests: 700, errors: 210,
		},
		{
			id: "mistral-large-3", upstream: "mistral-large-3", channelID: "ch_openai_backup", providerID: "",
			description: "欧洲开源厂商的旗舰模型。", tags: []string{"开源"},
			caps:     store.Caps{ContextLength: intp(131072), MaxOutput: intp(32768), ToolCalling: boolp(true)},
			requests: 700, errors: 211,
		},
		{
			id: "doubao-seed-2.0", upstream: "doubao-seed-2.0", channelID: "ch_volc", providerID: "bytedance",
			description: "火山方舟豆包系列，/api/v3 端点。", tags: []string{"豆包"},
			caps:     store.Caps{ContextLength: intp(262144), MaxOutput: intp(32768), ToolCalling: boolp(true), Thinking: boolp(true)},
			requests: 700, errors: 350,
		},
	}

	for i, ms := range models {
		m := store.Model{
			ID: ms.modelID(), Type: store.ModelTypeChannel, ChannelID: ms.channelID, Upstream: ms.upstream,
			ProviderID: ms.providerID, Caps: ms.caps, Enabled: true,
			Description: ms.description, Tags: ms.tags,
			CreatedAt: now - int64(len(models)-i)*1000, UpdatedAt: now,
		}
		if err := st.SaveModel(m); err != nil {
			log.Fatalf("写入模型 %s 失败: %v", ms.modelID(), err)
		}
	}

	// 渠道声明的模型名要和实际接入的模型一致，否则模型会被标成「渠道模型不存在」。
	byChannel := map[string][]string{}
	for _, ms := range models {
		byChannel[ms.channelID] = append(byChannel[ms.channelID], ms.upstream)
	}
	for _, c := range channels {
		ch, err := st.GetChannel(c.id)
		if err != nil {
			log.Fatalf("读取渠道 %s 失败: %v", c.id, err)
		}
		ch.Models = byChannel[c.id]
		if err := st.SaveChannel(ch); err != nil {
			log.Fatalf("更新渠道 %s 模型列表失败: %v", c.id, err)
		}
	}

	// 自定义模型：两条路线，24 小时内没有任何调用，广场应显示灰色「—」。
	custom := store.Model{
		ID: "ldm-custom-router", Type: store.ModelTypeCustom,
		Routes: []store.Route{
			{ChannelID: "ch_openai_main", Upstream: "gpt-5.2", Weight: 3, Group: 1},
			{ChannelID: "ch_deepseek", Upstream: "deepseek-chat", Weight: 1, Group: 2},
		},
		ProviderID: "", Caps: store.Caps{ContextLength: intp(262144), MaxOutput: intp(32768), ToolCalling: boolp(true)},
		Enabled: true, Description: "自定义路由示例：主线路优先，失败后切备用。", Tags: []string{"自定义"},
		Affinity: true, CooldownSec: 300, CooldownReset: true,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := st.SaveModel(custom); err != nil {
		log.Fatalf("写入自定义模型失败: %v", err)
	}

	// 近 24 小时统计：每个模型 700 次请求，按小时均匀铺开，
	// 错误全部放在前 N 次，得到 100.0 / 90.0 / 89.9 等边界值。
	start := time.Now()
	for _, ms := range models {
		if err := seedStats(st, ms.modelID(), ms.channelID, ms.requests, ms.errors); err != nil {
			log.Fatalf("写入统计 %s 失败: %v", ms.modelID(), err)
		}
	}

	// 再补一小组最近的调用日志，方便顺手查看「调用日志」页面。
	for i, ms := range models {
		status := 200
		errMsg := ""
		if ms.errors > 0 && i%3 == 0 {
			status = 500
			errMsg = "mock upstream error: rate limited"
		}
		l := store.Log{
			ID:      fmt.Sprintf("demo-log-%02d", i),
			Time:    time.Now().Add(-time.Duration(i+1) * time.Minute).UnixMilli(),
			ModelID: ms.modelID(), ChannelID: ms.channelID, UpstreamModel: ms.upstream,
			Endpoint: "/v1/chat/completions", StatusCode: status, Error: errMsg,
			PromptTokens: 128, CompletionTokens: 256, TotalTokens: 384,
			LatencyMs: 1800 + int64(i*137), FirstByteMs: 320 + int64(i*11),
			Stream: true, TokensPerSec: 38.5 + float64(i),
		}
		if status != 200 {
			l.PromptTokens, l.CompletionTokens, l.TotalTokens, l.TokensPerSec = 0, 0, 0, 0
		}
		if err := st.AppendLog(l); err != nil {
			log.Fatalf("写入日志失败: %v", err)
		}
	}

	fmt.Printf("示例数据写入完成：%s（%d 个渠道，%d 个模型，%d 次统计请求，用时 %s）\n",
		*dbPath, len(channels), len(models)+1, len(models)*700, time.Since(start).Round(time.Millisecond))
}

func seedStats(st *store.Store, modelID, channelID string, requests, errors int) error {
	now := time.Now().UnixMilli()
	for i := 0; i < requests; i++ {
		hourOffset := int64(i % 24)
		ts := now - hourOffset*3600_000 - int64(i%60)*60_000
		l := store.Log{
			ID:               fmt.Sprintf("seed-%s-%04d", modelID, i),
			Time:             ts,
			ModelID:          modelID,
			ChannelID:        channelID,
			Endpoint:         "/v1/chat/completions",
			StatusCode:       200,
			PromptTokens:     128,
			CompletionTokens: 256,
			TotalTokens:      384,
			LatencyMs:        2400 + int64(i%1600),
			FirstByteMs:      280 + int64(i%240),
			TokensPerSec:     36.5 + float64(i%18),
			Stream:           true,
		}
		if i < errors {
			l.StatusCode = 500
			l.Error = "mock upstream error: overloaded"
			l.PromptTokens, l.CompletionTokens, l.TotalTokens = 0, 0, 0
			l.LatencyMs = 800 + int64(i%400)
			l.FirstByteMs, l.TokensPerSec = 0, 0
		}
		if err := st.RecordStat(l); err != nil {
			return err
		}
	}
	return nil
}
