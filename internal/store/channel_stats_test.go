package store

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	bolt "go.etcd.io/bbolt"
)

func TestRecordStatChannelUsageMergesUpstreamCase(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "channel-stats.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	now := time.Now()
	logs := []Log{
		{
			Time: now.UnixMilli(), ModelID: "public-alias", ChannelID: "ch-1", ChannelName: "主渠道",
			UpstreamModel: "  GPT-4o  ", PromptTokens: 10, CompletionTokens: 5, TotalTokens: 15,
			StatusCode: 200, LatencyMs: 100, FirstByteMs: 20, TokensPerSec: 50,
		},
		{
			Time: now.UnixMilli(), ModelID: "another-alias", ChannelID: "ch-1", ChannelName: "主渠道",
			UpstreamModel: "gpt-4O", PromptTokens: 20, CompletionTokens: 7, TotalTokens: 27,
			StatusCode: 500, Error: "upstream failed", LatencyMs: 90,
		},
		{
			Time: now.UnixMilli(), ModelID: "ch-2/gpt-4o", ChannelID: "ch-2", ChannelName: "备用渠道",
			UpstreamModel: "gpt-4o", PromptTokens: 1, CompletionTokens: 2, TotalTokens: 3, StatusCode: 200,
		},
	}
	for _, l := range logs {
		if err := st.RecordStat(l); err != nil {
			t.Fatal(err)
		}
	}

	buckets, err := st.RangeStats(now.Add(-time.Hour).UnixMilli(), now.Add(time.Hour).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if len(buckets) != 1 {
		t.Fatalf("期望 1 个小时桶，得到 %d", len(buckets))
	}
	b := buckets[0]
	if len(b.ChannelStats) != 2 {
		t.Fatalf("期望 2 个渠道分项，得到 %+v", b.ChannelStats)
	}
	ch := b.ChannelStats["ch-1"]
	if ch.Name != "主渠道" || ch.Requests != 2 || ch.Errors != 1 {
		t.Errorf("渠道请求 / 失败统计错误：%+v", ch)
	}
	if ch.PromptTokens != 30 || ch.CompletionTokens != 12 || ch.TotalTokens != 42 {
		t.Errorf("渠道 Token 统计错误：%+v", ch.ModelStat)
	}
	if ch.LatencySum != 100 || ch.SpeedCount != 1 || ch.SpeedSum != 50 {
		t.Errorf("渠道耗时 / 速度统计错误：%+v", ch.ModelStat)
	}
	if len(ch.Models) != 1 {
		t.Fatalf("仅大小写不同的上游模型应合并，得到 %+v", ch.Models)
	}
	model := ch.Models["gpt-4o"]
	if model.Name != "GPT-4o" {
		t.Errorf("应保留稳定的原始展示名，得到 %q", model.Name)
	}
	if model.Requests != 2 || model.Errors != 1 || model.TotalTokens != 42 {
		t.Errorf("归并模型统计错误：%+v", model.ModelStat)
	}
	other := b.ChannelStats["ch-2"]
	if other.Requests != 1 || len(other.Models) != 1 || other.Models["gpt-4o"].TotalTokens != 3 {
		t.Errorf("不同渠道应先保留独立分项：%+v", other)
	}
}

func TestChannelStatsBackfillIsIdempotentAndSurvivesLogPurge(t *testing.T) {
	path := filepath.Join(t.TempDir(), "channel-backfill.db")
	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	logs := []Log{
		{ID: "a", Time: now.UnixMilli(), ModelID: "alias-a", ChannelID: "ch-1", ChannelName: "甲", UpstreamModel: "GPT-4o", PromptTokens: 10, CompletionTokens: 2, TotalTokens: 12, StatusCode: 200},
		{ID: "b", Time: now.UnixMilli(), ModelID: "alias-b", ChannelID: "ch-2", ChannelName: "乙", UpstreamModel: "gpt-4O", PromptTokens: 20, CompletionTokens: 3, TotalTokens: 23, StatusCode: 200},
		{ID: "bad-request", Time: now.UnixMilli(), ChannelID: "ch-1", UpstreamModel: "GPT-4o", TotalTokens: 1000, StatusCode: 400},
		{ID: "probe", Time: now.UnixMilli(), ChannelID: "ch-1", UpstreamModel: "GPT-4o", TotalTokens: 1000, StatusCode: 200, Source: LogSourceTest},
	}
	for _, l := range logs {
		if err := st.AppendLog(l); err != nil {
			t.Fatal(err)
		}
		// 与 Server.record 一致：400 和渠道测试只留日志，不写小时统计。
		if l.StatusCode != 400 && l.Source != LogSourceTest {
			if err := st.RecordStat(l); err != nil {
				t.Fatal(err)
			}
		}
	}

	// 模拟升级前的数据：旧桶没有 ChannelStats，也没有迁移完成标记。
	if err := st.db.Update(func(tx *bolt.Tx) error {
		stats := tx.Bucket(bStats)
		return stats.ForEach(func(k, v []byte) error {
			var b Bucket
			if err := json.Unmarshal(v, &b); err != nil {
				return err
			}
			b.ChannelStats = nil
			data, err := json.Marshal(b)
			if err != nil {
				return err
			}
			return stats.Put(k, data)
		})
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bMeta).Delete([]byte(channelStatsBackfillVersion))
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	// Open 自动执行一次回填。
	st, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	assertStats := func() {
		t.Helper()
		buckets, err := st.RangeStats(now.Add(-time.Hour).UnixMilli(), now.Add(time.Hour).UnixMilli())
		if err != nil {
			t.Fatal(err)
		}
		if len(buckets) != 1 {
			t.Fatalf("期望 1 个小时桶，得到 %d", len(buckets))
		}
		b := buckets[0]
		if b.Requests != 2 || b.TotalTokens != 35 {
			t.Errorf("回填不得改变原有汇总：%+v", b)
		}
		if len(b.ChannelStats) != 2 {
			t.Fatalf("400 和渠道测试不应回填，得到 %+v", b.ChannelStats)
		}
		if got := b.ChannelStats["ch-1"].Models["gpt-4o"].TotalTokens; got != 12 {
			t.Errorf("ch-1 回填 Token = %d，期望 12", got)
		}
		if got := b.ChannelStats["ch-2"].Models["gpt-4o"].TotalTokens; got != 23 {
			t.Errorf("ch-2 回填 Token = %d，期望 23", got)
		}
	}
	assertStats()

	// 完成标记存在时直接返回，重复调用不会翻倍。
	if err := st.backfillChannelStats(); err != nil {
		t.Fatal(err)
	}
	assertStats()

	if _, err := st.PurgeLogsBefore(now.Add(time.Second).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	assertStats()
}
