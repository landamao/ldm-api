// 渠道用量页的隔离演示数据。只写指定的测试数据库，不要指向正式数据。
package main

import (
	"flag"
	"fmt"
	"log"
	"time"

	"ldmapi/internal/store"
)

func main() {
	db := flag.String("db", "", "测试数据库 ldmapi.db 的完整路径（必填）")
	flag.Parse()
	if *db == "" {
		log.Fatal("必须通过 -db 指定临时测试数据库")
	}
	st, err := store.Open(*db)
	if err != nil {
		log.Fatal(err)
	}
	defer st.Close()

	for _, c := range []store.Channel{
		{ID: "alpha", Name: "主渠道", Type: "openai", Enabled: true},
		{ID: "beta", Name: "备用渠道", Type: "openai", Enabled: true},
		{ID: "empty", Name: "空闲渠道", Type: "openai", Enabled: true},
	} {
		if err := st.SaveChannel(c); err != nil {
			log.Fatal(err)
		}
	}

	now := time.Now()
	seed := []struct {
		channelID   string
		channelName string
		upstream    string
		requests    int
		tokens      int
	}{
		{"alpha", "主渠道", "GPT-4o", 5, 2000},
		{"beta", "备用渠道", "gpt-4O", 4, 2500},
		{"retired", "历史渠道", "Gpt-4o", 1, 3000},
		{"alpha", "主渠道", "glm-4", 3, 1800},
		{"beta", "备用渠道", "GLM-4", 2, 1600},
	}
	for i := 2; i < 17; i++ {
		channelID, channelName := "alpha", "主渠道"
		if i%2 == 1 {
			channelID, channelName = "beta", "备用渠道"
		}
		seed = append(seed, struct {
			channelID   string
			channelName string
			upstream    string
			requests    int
			tokens      int
		}{channelID, channelName, fmt.Sprintf("upstream-model-%02d", i), i%4 + 1, 300 + i*117})
	}

	id := 0
	for _, group := range seed {
		for j := 0; j < group.requests; j++ {
			id++
			failed := group.channelID == "beta" && group.upstream == "gpt-4O" && j == 0
			status := 200
			errText := ""
			if failed {
				status = 500
				errText = "测试失败请求"
			}
			entry := store.Log{
				ID: fmt.Sprintf("usage-%03d", id), Time: now.Add(-time.Duration(id) * time.Minute).UnixMilli(),
				TokenID: "demo", TokenName: "演示令牌", ModelID: "alias-" + group.upstream,
				ChannelID: group.channelID, ChannelName: group.channelName, UpstreamModel: group.upstream,
				PromptTokens: group.tokens * 7 / 10, CompletionTokens: group.tokens * 3 / 10,
				TotalTokens: group.tokens, LatencyMs: 800, FirstByteMs: 120, TokensPerSec: 36,
				StatusCode: status, Error: errText,
			}
			if err := st.AppendLog(entry); err != nil {
				log.Fatal(err)
			}
			if err := st.RecordStat(entry); err != nil {
				log.Fatal(err)
			}
		}
	}
	fmt.Printf("已写入 %d 条渠道用量测试日志：%s\n", id, *db)
}
