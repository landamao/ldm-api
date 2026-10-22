package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"time"

	bolt "go.etcd.io/bbolt"
)

type Log struct {
	ID               string  `json:"id"`
	Time             int64   `json:"time"`
	TokenName        string  `json:"token_name"`
	ModelID          string  `json:"model_id"`
	ChannelID        string  `json:"channel_id"`
	ChannelName      string  `json:"channel_name"`
	UpstreamModel    string  `json:"upstream_model"`
	Endpoint         string  `json:"endpoint"`
	PromptTokens     int     `json:"prompt_tokens"`
	CompletionTokens int     `json:"completion_tokens"`
	TotalTokens      int     `json:"total_tokens"`
	LatencyMs        int64   `json:"latency_ms"`
	FirstByteMs      int64   `json:"first_byte_ms"`
	StatusCode       int     `json:"status_code"`
	Error            string  `json:"error"`
	ClientError      string  `json:"client_error"`
	Stream           bool    `json:"stream"`
	Canceled         bool    `json:"canceled"`
	Retries          int     `json:"retries"`
	TokensPerSec     float64 `json:"tokens_per_sec"`
}

func main() {
	path := os.Args[1]
	db, err := bolt.Open(path, 0o600, &bolt.Options{ReadOnly: true})
	if err != nil {
		panic(err)
	}
	defer db.Close()
	var logs []Log
	db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("logs"))
		if b == nil {
			return nil
		}
		return b.ForEach(func(k, v []byte) error {
			var l Log
			if json.Unmarshal(v, &l) == nil {
				logs = append(logs, l)
			}
			return nil
		})
	})
	sort.Slice(logs, func(i, j int) bool { return logs[i].Time < logs[j].Time })
	fmt.Printf("total=%d\n", len(logs))
	if len(logs) == 0 {
		return
	}
	fmt.Printf("range=%s .. %s\n",
		time.UnixMilli(logs[0].Time).Format("2006-01-02 15:04:05"),
		time.UnixMilli(logs[len(logs)-1].Time).Format("2006-01-02 15:04:05"))

	type stat struct {
		n, zero, canceled, stream, zeroCanceled, zeroOK int
		promptSum, compSum                              int64
	}
	byEndpoint := map[string]*stat{}
	byChannel := map[string]*stat{}
	byModel := map[string]*stat{}
	byHour := map[string]*stat{}
	bump := func(m map[string]*stat, k string) *stat {
		s := m[k]
		if s == nil {
			s = &stat{}
			m[k] = s
		}
		return s
	}
	var zeroCanceled, zeroNotCanceled int
	add := func(m map[string]*stat, k string, l Log) {
		s := bump(m, k)
		s.n++
		s.promptSum += int64(l.PromptTokens)
		s.compSum += int64(l.CompletionTokens)
		if l.Stream {
			s.stream++
		}
		if l.Canceled {
			s.canceled++
		}
		if l.CompletionTokens == 0 {
			s.zero++
			if l.Canceled {
				s.zeroCanceled++
			}
			if l.StatusCode == 200 {
				s.zeroOK++
			}
		}
	}
	for _, l := range logs {
		add(byEndpoint, l.Endpoint, l)
		add(byChannel, l.ChannelID, l)
		add(byModel, l.ModelID, l)
		add(byHour, time.UnixMilli(l.Time).Format("01-02 15h"), l)
		if l.CompletionTokens == 0 {
			if l.Canceled {
				zeroCanceled++
			} else {
				zeroNotCanceled++
			}
		}
	}
	printMap := func(name string, m map[string]*stat) {
		type row struct {
			k string
			s *stat
		}
		var rows []row
		for k, s := range m {
			rows = append(rows, row{k, s})
		}
		sort.Slice(rows, func(i, j int) bool { return rows[i].s.n > rows[j].s.n })
		fmt.Printf("\n== by %s ==\n", name)
		for _, r := range rows {
			s := r.s
			fmt.Printf("%-28s n=%-6d zero=%-6d (canceled=%-5d ok=%-5d) stream=%-5d canceled=%-5d prompt=%-10d comp=%d\n",
				trunc(r.k, 28), s.n, s.zero, s.zeroCanceled, s.zeroOK, s.stream, s.canceled, s.promptSum, s.compSum)
		}
	}
	printMap("endpoint", byEndpoint)
	printMap("channel", byChannel)
	printMap("model", byModel)
	printMap("hour", byHour)
	fmt.Printf("\nzero comp: canceled=%d not_canceled=%d\n", zeroCanceled, zeroNotCanceled)

	// 0 输出按状态码、端点、渠道交叉统计，区分正常失败与异常成功。
	type key struct {
		ep, ch, model string
		st            int
	}
	zeroCross := map[key]int{}
	for _, l := range logs {
		if l.CompletionTokens == 0 {
			zeroCross[key{l.Endpoint, l.ChannelID, l.ModelID, l.StatusCode}]++
		}
	}
	type crow struct {
		k key
		n int
	}
	var crows []crow
	for k, n := range zeroCross {
		crows = append(crows, crow{k, n})
	}
	sort.Slice(crows, func(i, j int) bool { return crows[i].n > crows[j].n })
	fmt.Printf("\n== c=0 by endpoint/channel/model/status ==\n")
	for i, r := range crows {
		if i >= 20 {
			break
		}
		fmt.Printf("%-20s %-14s %-28s st=%-3d n=%d\n",
			r.k.ep, trunc(r.k.ch, 14), trunc(r.k.model, 28), r.k.st, r.n)
	}

	// 抽样：Responses 请求
	fmt.Printf("\n== responses samples ==\n")
	n := 0
	for i := len(logs) - 1; i >= 0 && n < 8; i-- {
		l := logs[i]
		if l.Endpoint == "/v1/responses" {
			fmt.Printf("%s t=%s model=%s ch=%s p=%d c=%d stream=%v lat=%d\n",
				l.ID, time.UnixMilli(l.Time).Format("01-02 15:04:05"), l.ModelID, l.ChannelID,
				l.PromptTokens, l.CompletionTokens, l.Stream, l.LatencyMs)
			n++
		}
	}

	// 抽样：非 canceled 且 c=0 的 200 流式记录
	fmt.Printf("\n== all c=0, not canceled, 200 (chat/completions) ==\n")
	n = 0
	for i := len(logs) - 1; i >= 0 && n < 60; i-- {
		l := logs[i]
		if l.CompletionTokens == 0 && !l.Canceled && l.StatusCode == 200 && l.Endpoint == "/v1/chat/completions" {
			fmt.Printf("%s t=%s model=%s ch=%s p=%d c=%d stream=%v lat=%d fb=%d tps=%.1f err=%.80s\n",
				l.ID, time.UnixMilli(l.Time).Format("01-02 15:04:05"), l.ModelID, l.ChannelID,
				l.PromptTokens, l.CompletionTokens, l.Stream, l.LatencyMs, l.FirstByteMs, l.TokensPerSec, l.Error)
			n++
		}
	}
	fmt.Printf("count=%d\n", n)
	fmt.Printf("\n== responses by hour ==\n")
	respByHour := map[string]int{}
	for _, l := range logs {
		if l.Endpoint == "/v1/responses" {
			respByHour[time.UnixMilli(l.Time).Format("01-02 15h")]++
		}
	}
	var hs []string
	for h := range respByHour {
		hs = append(hs, h)
	}
	sort.Strings(hs)
	for _, h := range hs {
		fmt.Printf("%s n=%d\n", h, respByHour[h])
	}
	fmt.Printf("\n== samples: c=0, canceled, 200 ==\n")
	n = 0
	for i := len(logs) - 1; i >= 0 && n < 10; i-- {
		l := logs[i]
		if l.CompletionTokens == 0 && l.Canceled {
			fmt.Printf("%s t=%s model=%s ch=%s ep=%s p=%d c=%d stream=%v lat=%d fb=%d\n",
				l.ID, time.UnixMilli(l.Time).Format("01-02 15:04:05"), l.ModelID, l.ChannelID, l.Endpoint,
				l.PromptTokens, l.CompletionTokens, l.Stream, l.LatencyMs, l.FirstByteMs)
			n++
		}
	}
}

func trunc(s string, n int) string {
	if s == "" {
		return "(empty)"
	}
	if len(s) > n {
		return s[:n]
	}
	return s
}
