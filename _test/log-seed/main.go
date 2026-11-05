// 一次性脚本：往临时库里灌一批调用日志，用来看日志页的分页/贴底布局。
// 用法：go run ./_test/log-seed -db _test/tmp-ui2/ldmapi.db -n 180
package main

import (
	"flag"
	"fmt"
	"log"
	"math/rand"
	"time"

	"ldmapi/internal/store"
)

func main() {
	dbPath := flag.String("db", "_test/tmp-ui2/ldmapi.db", "BoltDB 路径")
	n := flag.Int("n", 180, "生成条数")
	// -rmodel：每隔三条记一个和请求不同的响应模型，用来看日志页的「响应模型」标记。
	rmodel := flag.Bool("rmodel", false, "给部分日志写入不同的响应模型")
	flag.Parse()

	st, err := store.Open(*dbPath)
	if err != nil {
		log.Fatalf("打开数据库失败: %v", err)
	}
	defer st.Close()

	models, err := st.ListModels()
	if err != nil {
		log.Fatalf("读取模型失败: %v", err)
	}
	channels, err := st.ListChannels()
	if err != nil {
		log.Fatalf("读取渠道失败: %v", err)
	}
	tokens, err := st.ListTokens()
	if err != nil {
		log.Fatalf("读取密钥失败: %v", err)
	}
	if len(models) == 0 || len(channels) == 0 {
		log.Fatal("库里没有模型或渠道，先跑一次网关再灌日志")
	}
	modelIDs := make([]string, 0, len(models))
	for _, m := range models {
		modelIDs = append(modelIDs, m.ID)
	}
	chIDs := make([]string, 0, len(channels))
	for _, c := range channels {
		chIDs = append(chIDs, c.ID)
	}
	tokID, tokName := "seed-token", "演示密钥"
	if len(tokens) > 0 {
		tokID, tokName = tokens[0].ID, tokens[0].Name
	}

	now := time.Now()
	for i := 0; i < *n; i++ {
		ts := now.Add(-time.Duration(i) * 7 * time.Minute).UnixMilli()
		mid := modelIDs[rand.Intn(len(modelIDs))]
		cid := chIDs[rand.Intn(len(chIDs))]
		fail := rand.Intn(10) == 0
		code := 200
		errMsg := ""
		if fail {
			code = 502
			errMsg = "上游返回 502 Bad Gateway"
		}
		pt := 400 + rand.Intn(3000)
		ct := 60 + rand.Intn(900)
		respModel := ""
		if *rmodel && i%3 == 0 {
			respModel = mid + "-2025-01-01"
		}
		l := store.Log{
			ID:               fmt.Sprintf("seed-%03d", i),
			Time:             ts,
			TokenID:          tokID,
			TokenName:        tokName,
			ModelID:          mid,
			ChannelID:        cid,
			ChannelName:      cid,
			UpstreamModel:    mid,
			ResponseModel:    respModel,
			Endpoint:         "/v1/chat/completions",
			PromptTokens:     pt,
			CompletionTokens: ct,
			TotalTokens:      pt + ct,
			TokensPerSec:     20 + rand.Float64()*60,
			LatencyMs:        int64(300 + rand.Intn(2400)),
			FirstByteMs:      int64(120 + rand.Intn(600)),
			StatusCode:       code,
			Error:            errMsg,
			Stream:           rand.Intn(2) == 0,
			IP:               "127.0.0.1",
		}
		if err := st.AppendLog(l); err != nil {
			log.Fatalf("写入日志失败: %v", err)
		}
	}
	fmt.Printf("已写入 %d 条日志\n", *n)
}
