package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"

	bolt "go.etcd.io/bbolt"
)

type Log struct {
	ID               string  `json:"id"`
	Time             int64   `json:"time"`
	ModelID          string  `json:"model_id"`
	ChannelID        string  `json:"channel_id"`
	UpstreamModel    string  `json:"upstream_model"`
	PromptTokens     int     `json:"prompt_tokens"`
	CompletionTokens int     `json:"completion_tokens"`
	TotalTokens      int     `json:"total_tokens"`
	Stream           bool    `json:"stream"`
	StatusCode       int     `json:"status_code"`
	Error            string  `json:"error"`
	TokensPerSec     float64 `json:"tokens_per_sec"`
	CachedTokens     int     `json:"cached_tokens"`
	ReasoningTokens  int     `json:"reasoning_tokens"`
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
	start := 0
	if len(logs) > 40 {
		start = len(logs) - 40
	}
	for _, l := range logs[start:] {
		fmt.Printf("%s model=%s ch=%s up=%s p=%d c=%d t=%d stream=%v st=%d cached=%d reason=%d err=%.60s\n",
			l.ID, l.ModelID, l.ChannelID, l.UpstreamModel, l.PromptTokens, l.CompletionTokens, l.TotalTokens, l.Stream, l.StatusCode, l.CachedTokens, l.ReasoningTokens, l.Error)
	}
	fmt.Printf("total logs=%d\n", len(logs))
}
