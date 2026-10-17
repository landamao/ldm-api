package store

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	bolt "go.etcd.io/bbolt"
)

var (
	ErrNotFound = errors.New("not found")
	ErrConflict = errors.New("already exists")
)

var (
	bChannels  = []byte("channels")
	bModels    = []byte("models")
	bProviders = []byte("providers")
	bTokens    = []byte("tokens")
	bLogs      = []byte("logs")
	bStats     = []byte("stats")
	bSettings  = []byte("settings")
	bMeta      = []byte("meta")
)

// Store 是全部持久化状态的入口。bbolt 只允许单个写事务，这里用一把互斥锁串行化写入。
type Store struct {
	db *bolt.DB
	mu sync.Mutex
}

func Open(path string) (*Store, error) {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
	}
	db, err := bolt.Open(path, 0o600, &bolt.Options{Timeout: 5 * time.Second})
	if err != nil {
		return nil, err
	}
	s := &Store{db: db}
	err = db.Update(func(tx *bolt.Tx) error {
		for _, b := range [][]byte{bChannels, bModels, bProviders, bTokens, bLogs, bStats, bSettings, bMeta} {
			if _, err := tx.CreateBucketIfNotExists(b); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func put(b *bolt.Bucket, key string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return b.Put([]byte(key), data)
}

func get[T any](b *bolt.Bucket, key string) (T, error) {
	var out T
	raw := b.Get([]byte(key))
	if raw == nil {
		return out, ErrNotFound
	}
	err := json.Unmarshal(raw, &out)
	return out, err
}

func listAll[T any](b *bolt.Bucket, fn func(T) bool) ([]T, error) {
	out := []T{}
	err := b.ForEach(func(k, v []byte) error {
		var item T
		if err := json.Unmarshal(v, &item); err != nil {
			return nil // 跳过损坏记录而不是让整个列表失败
		}
		if fn == nil || fn(item) {
			out = append(out, item)
		}
		return nil
	})
	return out, err
}

// ---------- Channels ----------

func (s *Store) ListChannels() ([]Channel, error) {
	var out []Channel
	err := s.db.View(func(tx *bolt.Tx) error {
		var err error
		out, err = listAll[Channel](tx.Bucket(bChannels), nil)
		return err
	})
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt < out[j].CreatedAt })
	return out, err
}

func (s *Store) GetChannel(id string) (Channel, error) {
	var out Channel
	err := s.db.View(func(tx *bolt.Tx) error {
		var err error
		out, err = get[Channel](tx.Bucket(bChannels), id)
		return err
	})
	return out, err
}

func (s *Store) SaveChannel(c Channel) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.Update(func(tx *bolt.Tx) error {
		return put(tx.Bucket(bChannels), c.ID, c)
	})
}

func (s *Store) DeleteChannel(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bChannels).Delete([]byte(id))
	})
}

// ---------- Providers ----------

func (s *Store) ListProviders() ([]Provider, error) {
	var out []Provider
	err := s.db.View(func(tx *bolt.Tx) error {
		var err error
		out, err = listAll[Provider](tx.Bucket(bProviders), nil)
		return err
	})
	sort.Slice(out, func(i, j int) bool {
		// 内置提供商始终排在前面，保持默认顺序；自定义提供商按创建/排序值排在后面。
		if out[i].Builtin != out[j].Builtin {
			return out[i].Builtin
		}
		if out[i].Sort != out[j].Sort {
			return out[i].Sort < out[j].Sort
		}
		return out[i].CreatedAt < out[j].CreatedAt
	})
	return out, err
}

func (s *Store) GetProvider(id string) (Provider, error) {
	var out Provider
	err := s.db.View(func(tx *bolt.Tx) error {
		var err error
		out, err = get[Provider](tx.Bucket(bProviders), id)
		return err
	})
	return out, err
}

func (s *Store) SaveProvider(p Provider) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.Update(func(tx *bolt.Tx) error {
		return put(tx.Bucket(bProviders), p.ID, p)
	})
}

func (s *Store) DeleteProvider(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bProviders).Delete([]byte(id))
	})
}

// ---------- Models ----------

func (s *Store) ListModels() ([]Model, error) {
	var out []Model
	err := s.db.View(func(tx *bolt.Tx) error {
		var err error
		out, err = listAll[Model](tx.Bucket(bModels), nil)
		return err
	})
	sort.Slice(out, func(i, j int) bool {
		if out[i].Type != out[j].Type {
			return out[i].Type == ModelTypeCustom // 自定义模型排在前面
		}
		return out[i].CreatedAt < out[j].CreatedAt
	})
	return out, err
}

func (s *Store) GetModel(id string) (Model, error) {
	var out Model
	err := s.db.View(func(tx *bolt.Tx) error {
		var err error
		out, err = get[Model](tx.Bucket(bModels), id)
		return err
	})
	return out, err
}

func (s *Store) SaveModel(m Model) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.Update(func(tx *bolt.Tx) error {
		return put(tx.Bucket(bModels), m.ID, m)
	})
}

func (s *Store) DeleteModel(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bModels).Delete([]byte(id))
	})
}

// SaveModels 批量写入（添加模型时使用），整体一个事务。
func (s *Store) SaveModels(ms []Model) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bModels)
		for _, m := range ms {
			if err := put(b, m.ID, m); err != nil {
				return err
			}
		}
		return nil
	})
}

// DeleteModels 批量删除。
func (s *Store) DeleteModels(ids []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bModels)
		for _, id := range ids {
			if err := b.Delete([]byte(id)); err != nil {
				return err
			}
		}
		return nil
	})
}

// ---------- Tokens ----------

func (s *Store) ListTokens() ([]Token, error) {
	var out []Token
	err := s.db.View(func(tx *bolt.Tx) error {
		var err error
		out, err = listAll[Token](tx.Bucket(bTokens), nil)
		return err
	})
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt < out[j].CreatedAt })
	return out, err
}

func (s *Store) GetToken(id string) (Token, error) {
	var out Token
	err := s.db.View(func(tx *bolt.Tx) error {
		var err error
		out, err = get[Token](tx.Bucket(bTokens), id)
		return err
	})
	return out, err
}

func (s *Store) FindTokenByKey(key string) (Token, error) {
	var out Token
	err := s.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bTokens).ForEach(func(k, v []byte) error {
			var t Token
			if err := json.Unmarshal(v, &t); err != nil {
				return nil
			}
			if t.Key == key {
				out = t
				return errStop
			}
			return nil
		})
	})
	if errors.Is(err, errStop) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	if out.ID == "" {
		return out, ErrNotFound
	}
	return out, nil
}

var errStop = errors.New("stop")

func (s *Store) SaveToken(t Token) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.Update(func(tx *bolt.Tx) error {
		return put(tx.Bucket(bTokens), t.ID, t)
	})
}

func (s *Store) DeleteToken(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bTokens).Delete([]byte(id))
	})
}

// AddTokenUsage 累加令牌的已用额度。
func (s *Store) AddTokenUsage(id string, tokens int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bTokens)
		t, err := get[Token](b, id)
		if err != nil {
			return nil
		}
		t.UsedQuota += tokens
		t.LastUsedAt = time.Now().UnixMilli()
		return put(b, t.ID, t)
	})
}

// ---------- Logs ----------
// 日志按时间倒序写入：key = 反序时间戳(8字节) + id，这样正序遍历就是最新的在前。

func logKey(t time.Time, id string) []byte {
	rev := uint64(^uint64(t.UnixMilli())) // 取反实现倒序
	key := make([]byte, 8+len(id))
	binary.BigEndian.PutUint64(key[:8], rev)
	copy(key[8:], id)
	return key
}

func (s *Store) AppendLog(l Log) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.Update(func(tx *bolt.Tx) error {
		data, err := json.Marshal(l)
		if err != nil {
			return err
		}
		return tx.Bucket(bLogs).Put(logKey(time.UnixMilli(l.Time), l.ID), data)
	})
}

// QueryLogs 返回过滤后的日志和总数。before 为游标（毫秒时间戳），返回早于该时间的记录。
type LogFilter struct {
	TokenID   string
	ModelID   string
	ChannelID string
	// Status 按结果过滤："success" 只看成功，"error" 只看失败，空表示全部。
	Status    string
	OnlyError bool // 兼容旧参数，等价于 Status == "error"
	Start     int64
	End       int64
	Limit     int
	Offset    int
}

func (s *Store) QueryLogs(f LogFilter) ([]Log, int, error) {
	if f.Limit <= 0 {
		f.Limit = 50
	}
	var out []Log
	total := 0
	err := s.db.View(func(tx *bolt.Tx) error {
		c := tx.Bucket(bLogs).Cursor()
		for k, v := c.First(); k != nil; k, v = c.Next() {
			var l Log
			if err := json.Unmarshal(v, &l); err != nil {
				continue
			}
			if f.Start > 0 && l.Time < f.Start {
				continue
			}
			if f.End > 0 && l.Time > f.End {
				continue
			}
			if f.TokenID != "" && l.TokenID != f.TokenID {
				continue
			}
			if f.ModelID != "" && l.ModelID != f.ModelID {
				continue
			}
			if f.ChannelID != "" && l.ChannelID != f.ChannelID {
				continue
			}
			// 失败的定义与统计口径一致：状态码 >= 400，或响应已开始但中途出错（如流式断开）。
			failed := !l.Canceled && (l.StatusCode >= 400 || l.Error != "")
			if (f.Status == "error" || f.OnlyError) && !failed {
				continue
			}
			if f.Status == "success" && failed {
				continue
			}
			total++
			if total <= f.Offset {
				continue
			}
			if len(out) < f.Limit {
				out = append(out, l)
			}
		}
		return nil
	})
	return out, total, err
}

// PurgeLogsBefore 删除早于 ts 的日志。
func (s *Store) PurgeLogsBefore(ts int64) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	removed := 0
	err := s.db.Update(func(tx *bolt.Tx) error {
		c := tx.Bucket(bLogs).Cursor()
		for k, v := c.First(); k != nil; k, v = c.Next() {
			var l Log
			if err := json.Unmarshal(v, &l); err != nil {
				c.Delete()
				continue
			}
			if l.Time < ts {
				if err := c.Delete(); err != nil {
					return err
				}
				removed++
			}
		}
		return nil
	})
	return removed, err
}

func (s *Store) CountLogs() (int, error) {
	n := 0
	err := s.db.View(func(tx *bolt.Tx) error {
		n = tx.Bucket(bLogs).Stats().KeyN
		return nil
	})
	return n, err
}

// ---------- Stats ----------

func hourKey(h int64) []byte {
	b := make([]byte, 8)
	binary.BigEndian.PutUint64(b, uint64(h))
	return b
}

func hourOf(ms int64) int64 { return ms / 3600000 * 3600000 }

func ensureCounts(m map[string]int64) map[string]int64 {
	if m == nil {
		return map[string]int64{}
	}
	return m
}

// RecordStat 把一次请求计入小时桶。
func (s *Store) RecordStat(l Log) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bStats)
		h := hourOf(l.Time)
		var bk Bucket
		if raw := b.Get(hourKey(h)); raw != nil {
			_ = json.Unmarshal(raw, &bk)
		}
		bk.Hour = h
		bk.ModelCounts = ensureCounts(bk.ModelCounts)
		bk.ModelErrors = ensureCounts(bk.ModelErrors)
		bk.ChannelCounts = ensureCounts(bk.ChannelCounts)
		bk.TokenCounts = ensureCounts(bk.TokenCounts)
		bk.Requests++
		failed := !l.Canceled && (l.StatusCode >= 400 || l.Error != "")
		if failed {
			bk.Errors++
		}
		bk.PromptTokens += int64(l.PromptTokens)
		bk.CompletionTokens += int64(l.CompletionTokens)
		bk.TotalTokens += int64(l.TotalTokens)
		bk.LatencySum += l.LatencyMs
		if l.ModelID != "" {
			bk.ModelCounts[l.ModelID]++
			if failed {
				bk.ModelErrors[l.ModelID]++
			}
		}
		if l.ChannelID != "" {
			bk.ChannelCounts[l.ChannelID]++
		}
		if l.TokenID != "" {
			bk.TokenCounts[l.TokenName]++
		}
		data, err := json.Marshal(bk)
		if err != nil {
			return err
		}
		return b.Put(hourKey(h), data)
	})
}

// RangeStats 返回 [from, to] 之间的小时桶（毫秒时间戳）。
func (s *Store) RangeStats(from, to int64) ([]Bucket, error) {
	out := []Bucket{}
	err := s.db.View(func(tx *bolt.Tx) error {
		c := tx.Bucket(bStats).Cursor()
		start := hourKey(hourOf(from))
		for k, v := c.Seek(start); k != nil; k, v = c.Next() {
			var bk Bucket
			if err := json.Unmarshal(v, &bk); err != nil {
				continue
			}
			if bk.Hour > to {
				break
			}
			out = append(out, bk)
		}
		return nil
	})
	return out, err
}

// PurgeStatsBefore 清理过期统计桶。
func (s *Store) PurgeStatsBefore(ts int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.Update(func(tx *bolt.Tx) error {
		c := tx.Bucket(bStats).Cursor()
		for k, _ := c.First(); k != nil; k, _ = c.Next() {
			if len(k) != 8 {
				continue
			}
			h := int64(binary.BigEndian.Uint64(k))
			if h < ts {
				if err := c.Delete(); err != nil {
					return err
				}
			} else {
				break
			}
		}
		return nil
	})
}

// ---------- Settings ----------

func (s *Store) GetSettings() (Settings, error) {
	var out Settings
	err := s.db.View(func(tx *bolt.Tx) error {
		var err error
		out, err = get[Settings](tx.Bucket(bSettings), "main")
		return err
	})
	if errors.Is(err, ErrNotFound) {
		return Settings{}, nil
	}
	return out, err
}

func (s *Store) SaveSettings(st Settings) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.Update(func(tx *bolt.Tx) error {
		return put(tx.Bucket(bSettings), "main", st)
	})
}

func (s *Store) GetMeta(key string) (string, error) {
	var out string
	err := s.db.View(func(tx *bolt.Tx) error {
		v := tx.Bucket(bMeta).Get([]byte(key))
		if v == nil {
			return ErrNotFound
		}
		out = string(v)
		return nil
	})
	return out, err
}

func (s *Store) SetMeta(key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bMeta).Put([]byte(key), []byte(value))
	})
}

// ---------- 便捷查询 ----------

// ChannelModelIDs 返回所有渠道派生出的渠道模型 ID。
func (s *Store) ChannelModelIDs() (map[string]ChannelModel, error) {
	chans, err := s.ListChannels()
	if err != nil {
		return nil, err
	}
	out := map[string]ChannelModel{}
	for _, c := range chans {
		for _, m := range c.Models {
			m = strings.TrimSpace(m)
			if m == "" {
				continue
			}
			cm := NewChannelModel(c.ID, m)
			out[cm.ID] = cm
		}
	}
	return out, nil
}

// DeleteChannelCascade 删除渠道，并清理它派生出的渠道模型及其路由引用。
func (s *Store) DeleteChannelCascade(id string) (removedModels []string, err error) {
	models, err := s.ListModels()
	if err != nil {
		return nil, err
	}
	prefix := id + "/"
	var toDelete []string
	for _, m := range models {
		if m.Type == ModelTypeChannel && m.ChannelID == id {
			toDelete = append(toDelete, m.ID)
			continue
		}
		if m.Type == ModelTypeCustom {
			kept := m.Routes[:0]
			changed := false
			for _, r := range m.Routes {
				if r.ChannelID == id {
					changed = true
					continue
				}
				kept = append(kept, r)
			}
			if changed {
				m.Routes = append([]Route{}, kept...)
				if err := s.SaveModel(m); err != nil {
					return nil, err
				}
			}
		}
		_ = prefix
	}
	if len(toDelete) > 0 {
		if err := s.DeleteModels(toDelete); err != nil {
			return nil, err
		}
	}
	if err := s.DeleteChannel(id); err != nil {
		return nil, err
	}
	return toDelete, nil
}

// ModelRouteRefs 返回引用了某个渠道模型的所有自定义模型 ID。
func (s *Store) ModelRouteRefs(channelID, upstream string) ([]string, error) {
	models, err := s.ListModels()
	if err != nil {
		return nil, err
	}
	var out []string
	for _, m := range models {
		if m.Type != ModelTypeCustom {
			continue
		}
		for _, r := range m.Routes {
			if r.ChannelID == channelID && r.Upstream == upstream {
				out = append(out, m.ID)
				break
			}
		}
	}
	return out, nil
}

// ChannelModelRefs 返回直接引用某个渠道模型（作为渠道模型配置）的模型 ID。
func (s *Store) ChannelModelRefs(channelID, upstream string) ([]string, error) {
	models, err := s.ListModels()
	if err != nil {
		return nil, err
	}
	var out []string
	for _, m := range models {
		if m.Type == ModelTypeChannel && m.ChannelID == channelID && m.Upstream == upstream {
			out = append(out, m.ID)
		}
	}
	return out, nil
}

func (s *Store) Stats() (map[string]int, error) {
	out := map[string]int{}
	err := s.db.View(func(tx *bolt.Tx) error {
		out["channels"] = tx.Bucket(bChannels).Stats().KeyN
		out["models"] = tx.Bucket(bModels).Stats().KeyN
		out["tokens"] = tx.Bucket(bTokens).Stats().KeyN
		out["logs"] = tx.Bucket(bLogs).Stats().KeyN
		return nil
	})
	return out, err
}

func (s *Store) String() string { return fmt.Sprintf("store(%s)", s.db.Path()) }
