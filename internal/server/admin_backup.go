package server

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"ldmapi/internal/store"
)

// backupScopeOrder 是可导出的数据范围，顺序固定，保证同样的勾选得到同样的文件结构。
var backupScopeOrder = []string{"channels", "models", "providers", "tokens", "settings", "logs", "stats"}

func isBackupScope(key string) bool {
	for _, k := range backupScopeOrder {
		if k == key {
			return true
		}
	}
	return false
}

// backupDir 返回备份文件目录。默认放在数据目录下的 backups/。
func (s *Server) backupDir() string {
	dir := s.DataDir
	if dir == "" {
		dir = filepath.Dir(s.store.Path())
	}
	return filepath.Join(dir, "backups")
}

// exportBackup 把选中的数据写成服务器本地 JSON 文件。
//
// 文件包含明文上游 Key 与 API 密钥，因此内容只落盘，绝不放进响应体，
// 浏览器拿到的只有文件名、绝对路径和统计信息。
//
// 整个导出过程持有 Store 的写锁：导出开始后所有写入（保存渠道、写日志等）
// 都会排队等待，保证各个范围的数据来自同一时刻，不会出现「渠道已导出、
// 模型却被改掉」这类竞态。
func (s *Server) exportBackup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Scopes []string `json:"scopes"`
		Indent int      `json:"indent"` // JSON 缩进空格数，0 表示紧凑输出
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if req.Indent < 0 || req.Indent > 8 {
		writeErr(w, http.StatusBadRequest, "缩进只能是 0 到 8 个空格")
		return
	}

	selected := make(map[string]bool, len(req.Scopes))
	for _, key := range req.Scopes {
		key = strings.TrimSpace(key)
		if key == "" || selected[key] {
			continue
		}
		if !isBackupScope(key) {
			writeErr(w, http.StatusBadRequest, "未知的导出范围："+key)
			return
		}
		selected[key] = true
	}
	scopes := make([]string, 0, len(selected))
	for _, key := range backupScopeOrder {
		if selected[key] {
			scopes = append(scopes, key)
		}
	}
	if len(scopes) == 0 {
		writeErr(w, http.StatusBadRequest, "请至少选择一个导出范围")
		return
	}

	dir := s.backupDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		writeErr(w, http.StatusInternalServerError, "无法创建备份目录："+err.Error())
		return
	}

	now := time.Now()
	name := "ldmapi-backup-" + now.Format("20060102-150405") + "-" + randomHex(3) + ".json"
	path := filepath.Join(dir, name)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "无法创建备份文件："+err.Error())
		return
	}

	// 导出失败时删掉半成品，避免留下一个看起来完整的备份文件。
	removeOnError := func(err error) {
		_ = f.Close()
		_ = os.Remove(path)
		writeErr(w, http.StatusInternalServerError, "导出失败："+err.Error())
	}

	var counts map[string]int
	err = s.store.WithWriteLock(func() error {
		var werr error
		counts, werr = s.writeBackup(f, scopes, now, req.Indent)
		return werr
	})
	if err != nil {
		removeOnError(err)
		return
	}
	if err := f.Sync(); err != nil {
		removeOnError(err)
		return
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(path)
		writeErr(w, http.StatusInternalServerError, "导出失败："+err.Error())
		return
	}

	info, err := os.Stat(path)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	writeOK(w, map[string]any{
		"file":        name,
		"path":        abs,
		"dir":         filepath.Dir(abs),
		"size":        info.Size(),
		"counts":      counts,
		"scopes":      scopes,
		"indent":      req.Indent,
		"exported_at": now.UnixMilli(),
	})
}

// backupEncoder 负责把备份 JSON 流式写入文件。
// 日志可能很多，因此逐条编码，不把全部数据先读进内存。
// indent 为 0 时输出紧凑 JSON，大于 0 时按指定空格数缩进。
type backupEncoder struct {
	bw     *bufio.Writer
	pretty bool
	indent string
}

func newBackupEncoder(w io.Writer, spaces int) *backupEncoder {
	return &backupEncoder{
		bw:     bufio.NewWriterSize(w, 256<<10),
		pretty: spaces > 0,
		indent: strings.Repeat(" ", spaces),
	}
}

func (e *backupEncoder) writeString(s string) error {
	_, err := e.bw.WriteString(s)
	return err
}

// newline 在美化模式下换行并写入 level 层缩进；紧凑模式什么也不做。
func (e *backupEncoder) newline(level int) error {
	if !e.pretty {
		return nil
	}
	if err := e.writeString("\n"); err != nil {
		return err
	}
	for i := 0; i < level; i++ {
		if err := e.writeString(e.indent); err != nil {
			return err
		}
	}
	return nil
}

func (e *backupEncoder) marshal(v any, level int) ([]byte, error) {
	if !e.pretty {
		return json.Marshal(v)
	}
	return json.MarshalIndent(v, strings.Repeat(e.indent, level), e.indent)
}

func (e *backupEncoder) value(v any, level int) error {
	data, err := e.marshal(v, level)
	if err != nil {
		return err
	}
	_, err = e.bw.Write(data)
	return err
}

// field 写入对象的一个键。first 用于自动补逗号。
func (e *backupEncoder) field(first *bool, level int, key string) error {
	if !*first {
		if err := e.writeString(","); err != nil {
			return err
		}
	}
	*first = false
	if err := e.newline(level); err != nil {
		return err
	}
	if _, err := e.bw.WriteString(strconv.Quote(key)); err != nil {
		return err
	}
	if e.pretty {
		return e.writeString(": ")
	}
	return e.writeString(":")
}

// array 流式写入一个数组，each 负责逐项产出。level 是数组项所在层级。
func (e *backupEncoder) array(level int, each func(yield func(any) error) error) error {
	if err := e.writeString("["); err != nil {
		return err
	}
	n := 0
	if err := each(func(v any) error {
		if n > 0 {
			if err := e.writeString(","); err != nil {
				return err
			}
		}
		if err := e.newline(level); err != nil {
			return err
		}
		if err := e.value(v, level); err != nil {
			return err
		}
		n++
		return nil
	}); err != nil {
		return err
	}
	if n > 0 {
		if err := e.newline(level - 1); err != nil {
			return err
		}
	}
	return e.writeString("]")
}

func writeBackupArray[T any](e *backupEncoder, level int, items []T) error {
	return e.array(level, func(yield func(any) error) error {
		for _, item := range items {
			if err := yield(item); err != nil {
				return err
			}
		}
		return nil
	})
}

// writeBackup 把备份 JSON 流式写入 w。调用方必须持有 Store 的写锁。
func (s *Server) writeBackup(w io.Writer, scopes []string, now time.Time, indent int) (map[string]int, error) {
	e := newBackupEncoder(w, indent)
	counts := make(map[string]int, len(scopes))

	if err := e.writeString("{"); err != nil {
		return counts, err
	}
	topFirst := true

	writeTop := func(key string, v any) error {
		if err := e.field(&topFirst, 1, key); err != nil {
			return err
		}
		return e.value(v, 1)
	}

	if err := writeTop("format", "ldmapi-backup"); err != nil {
		return counts, err
	}
	if err := writeTop("version", 1); err != nil {
		return counts, err
	}
	if err := writeTop("app_version", s.Version); err != nil {
		return counts, err
	}
	if err := writeTop("exported_at", now.UnixMilli()); err != nil {
		return counts, err
	}
	if err := writeTop("scopes", scopes); err != nil {
		return counts, err
	}

	if err := e.field(&topFirst, 1, "data"); err != nil {
		return counts, err
	}
	if err := e.writeString("{"); err != nil {
		return counts, err
	}
	dataFirst := true

	for _, scope := range scopes {
		if err := e.field(&dataFirst, 2, scope); err != nil {
			return counts, err
		}

		switch scope {
		case "channels":
			items, err := s.store.ListChannels()
			if err != nil {
				return counts, err
			}
			if err := writeBackupArray(e, 3, items); err != nil {
				return counts, err
			}
			counts[scope] = len(items)

		case "models":
			items, err := s.store.ListModels()
			if err != nil {
				return counts, err
			}
			if err := writeBackupArray(e, 3, items); err != nil {
				return counts, err
			}
			counts[scope] = len(items)

		case "providers":
			items, err := s.store.ListProviders()
			if err != nil {
				return counts, err
			}
			if err := writeBackupArray(e, 3, items); err != nil {
				return counts, err
			}
			counts[scope] = len(items)

		case "tokens":
			items, err := s.store.ListTokens()
			if err != nil {
				return counts, err
			}
			if err := writeBackupArray(e, 3, items); err != nil {
				return counts, err
			}
			counts[scope] = len(items)

		case "settings":
			st, err := s.store.GetSettings()
			if err != nil {
				return counts, err
			}
			if err := e.value(st, 2); err != nil {
				return counts, err
			}
			counts[scope] = 1

		case "logs":
			n := 0
			err := e.array(3, func(yield func(any) error) error {
				return s.store.ForEachLog(func(l store.Log) error {
					if err := yield(l); err != nil {
						return err
					}
					n++
					return nil
				})
			})
			if err != nil {
				return counts, err
			}
			counts[scope] = n

		case "stats":
			items, err := s.store.RangeStats(0, now.UnixMilli())
			if err != nil {
				return counts, err
			}
			if err := writeBackupArray(e, 3, items); err != nil {
				return counts, err
			}
			counts[scope] = len(items)
		}
	}

	if len(scopes) > 0 {
		if err := e.newline(1); err != nil {
			return counts, err
		}
	}
	if err := e.writeString("}"); err != nil {
		return counts, err
	}

	if err := e.field(&topFirst, 1, "counts"); err != nil {
		return counts, err
	}
	if err := e.value(counts, 1); err != nil {
		return counts, err
	}

	if err := e.newline(0); err != nil {
		return counts, err
	}
	if err := e.writeString("}"); err != nil {
		return counts, err
	}
	if err := e.bw.Flush(); err != nil {
		return counts, err
	}
	return counts, nil
}
