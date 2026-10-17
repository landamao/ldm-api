package server

import (
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"

	"ldmapi/internal/store"
)

// providerSeedVersion 标记默认提供商与存量模型自动归属已经执行过。
// 之后用户手动清空某个模型的提供商，重启也不会再被自动加回去。
// v2：新增 Claude / 月之暗面 / 阿里巴巴，升级时补齐缺失的默认提供商。
// v3：月之暗面图标从 Kimi 换成 Moonshot。
const providerSeedVersion = "providers_seeded_v3"

// defaultProviders 是首次启动时写入的提供商列表。
// Match 里的关键词按「模型 ID 小写包含」匹配，顺序即匹配优先级。
func defaultProviders() []store.Provider {
	now := time.Now().UnixMilli()
	defs := []struct {
		id, name, icon, color string
		match                 []string
	}{
		{"zhipu", "智谱", "zhipu", "#3859FF", []string{"glm", "zhipu", "智谱", "chatglm"}},
		{"deepseek", "DeepSeek", "deepseek", "#4D6BFE", []string{"deepseek", "深度求索"}},
		{"xai", "xAI", "xai", "#000000", []string{"grok", "xai"}},
		{"openai", "OpenAI", "openai", "#10A37F", []string{"gpt", "openai", "chatgpt"}},
		{"stepfun", "阶跃星辰", "stepfun", "#005AFF", []string{"step", "stepfun", "阶跃"}},
		{"bytedance", "字节跳动", "bytedance", "#325AB4", []string{"doubao", "豆包", "bytedance", "字节"}},
		{"xiaomi", "小米", "xiaomi", "#FF6900", []string{"mimo", "xiaomi", "小米"}},
		{"minimax", "MiniMax", "minimax", "#F23F5D", []string{"minimax", "abab"}},
		{"gemini", "Gemini", "gemini", "#3186FF", []string{"gemin", "google"}},
		{"claude", "Claude", "claude", "#D97757", []string{"claude", "anthropic"}},
		{"moonshot", "月之暗面", "moonshot", "#5A32E6", []string{"kimi", "moonshot", "月之暗面"}},
		{"alibaba", "阿里巴巴", "qwen", "#615CED", []string{"qwen", "qwq", "tongyi", "通义", "千问", "alibaba"}},
	}
	out := make([]store.Provider, 0, len(defs))
	for i, d := range defs {
		out = append(out, store.Provider{
			ID: d.id, Name: d.name, Icon: d.icon, Color: d.color, Match: d.match,
			Sort: i, Builtin: true, CreatedAt: now + int64(i), UpdatedAt: now + int64(i),
		})
	}
	return out
}

// EnsureProviders 首次启动时写入默认提供商，并给存量模型补齐提供商。
// 升级到 v2 时会把新增的默认提供商补进已有列表，不会覆盖用户改过的配置。
func (s *Server) EnsureProviders() error {
	if done, _ := s.store.GetMeta(providerSeedVersion); done == "1" {
		return nil
	}
	providers, err := s.store.ListProviders()
	if err != nil {
		return err
	}
	existing := providerMap(providers)
	for _, p := range defaultProviders() {
		if _, ok := existing[p.ID]; ok {
			continue
		}
		if err := s.store.SaveProvider(p); err != nil {
			return err
		}
	}
	// v3：旧版本月之暗面误用了 Kimi 的图标，这里修正为 Moonshot（只处理默认值）
	if cur, err := s.store.GetProvider("moonshot"); err == nil && cur.Icon == "kimi" {
		cur.Icon = "moonshot"
		cur.Color = "#5A32E6"
		cur.UpdatedAt = time.Now().UnixMilli()
		if err := s.store.SaveProvider(cur); err != nil {
			return err
		}
	}
	if providers, err = s.store.ListProviders(); err != nil {
		return err
	}

	models, err := s.store.ListModels()
	if err != nil {
		return err
	}
	now := time.Now().UnixMilli()
	for _, m := range models {
		if m.ProviderID != "" {
			continue
		}
		pid := matchProvider(providers, providerMatchKey(m))
		if pid == "" {
			continue
		}
		m.ProviderID = pid
		m.UpdatedAt = now
		if err := s.store.SaveModel(m); err != nil {
			return err
		}
	}
	return s.store.SetMeta(providerSeedVersion, "1")
}

// matchProvider 返回模型 ID 命中的第一个提供商 ID，未命中返回空串。
func matchProvider(providers []store.Provider, modelID string) string {
	hay := strings.ToLower(modelID)
	for _, p := range providers {
		for _, kw := range p.Match {
			kw = strings.ToLower(strings.TrimSpace(kw))
			if kw != "" && strings.Contains(hay, kw) {
				return p.ID
			}
		}
	}
	return ""
}

// providerMatchKey 是自动归属时参与关键词匹配的文本。
// 渠道模型只看上游模型名，避免渠道 ID 里恰好带 gpt/glm 等字样时整批误归类。
func providerMatchKey(m store.Model) string {
	if m.Type == store.ModelTypeChannel && m.Upstream != "" {
		return m.Upstream
	}
	return m.ID
}

func providerMap(providers []store.Provider) map[string]store.Provider {
	out := make(map[string]store.Provider, len(providers))
	for _, p := range providers {
		out[p.ID] = p
	}
	return out
}

// ---------- 提供商管理接口 ----------

type providerView struct {
	store.Provider
	ModelCount int `json:"model_count"`
}

func (s *Server) listProviders(w http.ResponseWriter, r *http.Request) {
	providers, err := s.store.ListProviders()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	models, _ := s.store.ListModels()
	counts := map[string]int{}
	for _, m := range models {
		if m.ProviderID != "" {
			counts[m.ProviderID]++
		}
	}
	out := make([]providerView, 0, len(providers))
	for _, p := range providers {
		out = append(out, providerView{Provider: p, ModelCount: counts[p.ID]})
	}
	writeOK(w, out)
}

type providerRequest struct {
	ID    string   `json:"id"`
	Name  string   `json:"name"`
	Icon  string   `json:"icon"`
	Color string   `json:"color"`
	Match []string `json:"match"`
	Sort  int      `json:"sort"`
}

var providerIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

func (s *Server) saveProvider(w http.ResponseWriter, r *http.Request) {
	var req providerRequest
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	currentID := strings.TrimSpace(r.PathValue("id"))
	id := strings.TrimSpace(req.ID)
	if id == "" {
		id = currentID
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeErr(w, http.StatusBadRequest, "提供商名称不能为空")
		return
	}

	now := time.Now().UnixMilli()
	existing, err := s.store.GetProvider(currentID)
	isNew := currentID == "" || err == store.ErrNotFound
	if err != nil && err != store.ErrNotFound {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if isNew {
		if id == "" {
			id = slugifyProviderID(name)
		}
		if id == "" {
			id = "provider-" + time.Now().Format("20060102150405")
		}
		if !providerIDPattern.MatchString(id) {
			writeErr(w, http.StatusBadRequest, "提供商 ID 只能包含小写字母、数字、下划线和短横线")
			return
		}
		if _, err := s.store.GetProvider(id); err == nil {
			writeErr(w, http.StatusConflict, "提供商 ID "+id+" 已存在")
			return
		}
		existing = store.Provider{ID: id, CreatedAt: now}
	} else {
		id = existing.ID
	}

	p := existing
	p.ID = id
	p.Name = name
	p.Icon = strings.TrimSpace(req.Icon)
	p.Color = strings.TrimSpace(req.Color)
	p.Match = normalizeMatch(req.Match)
	if req.Sort != 0 {
		p.Sort = req.Sort
	} else if isNew {
		providers, _ := s.store.ListProviders()
		p.Sort = len(providers)
	}
	p.UpdatedAt = now
	if err := s.store.SaveProvider(p); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeOK(w, p)
}

// listDefaultProviders 列出全部内置提供商，并标记当前是否还存在。
// 用于「恢复内置提供商」弹窗：只展示被删除的项供用户勾选找回。
func (s *Server) listDefaultProviders(w http.ResponseWriter, r *http.Request) {
	providers, err := s.store.ListProviders()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	existing := providerMap(providers)
	type defaultView struct {
		store.Provider
		Exists bool `json:"exists"`
	}
	out := make([]defaultView, 0, len(defaultProviders()))
	for _, p := range defaultProviders() {
		_, ok := existing[p.ID]
		out = append(out, defaultView{Provider: p, Exists: ok})
	}
	writeOK(w, out)
}

// restoreDefaultProviders 按用户勾选的 ID 补回被删除的内置提供商，
// 并只针对这些提供商给未归属模型重新自动匹配。已存在的提供商不会被覆盖。
func (s *Server) restoreDefaultProviders(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IDs []string `json:"ids"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if len(req.IDs) == 0 {
		writeErr(w, http.StatusBadRequest, "请选择要恢复的内置提供商")
		return
	}
	defaults := map[string]store.Provider{}
	for _, p := range defaultProviders() {
		defaults[p.ID] = p
	}
	providers, err := s.store.ListProviders()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	existing := providerMap(providers)
	addedSet := map[string]bool{}
	seen := map[string]bool{}
	for _, raw := range req.IDs {
		id := strings.TrimSpace(raw)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		p, ok := defaults[id]
		if !ok {
			writeErr(w, http.StatusBadRequest, "内置提供商 "+id+" 不存在")
			return
		}
		if _, ok := existing[id]; ok {
			continue
		}
		if err := s.store.SaveProvider(p); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		addedSet[id] = true
	}
	// 按默认顺序重新排列，保证多关键词命中时归属稳定
	added := []store.Provider{}
	for _, p := range defaultProviders() {
		if addedSet[p.ID] {
			added = append(added, p)
		}
	}

	// 只针对刚恢复的提供商，把失去归属的模型匹配回去
	models, err := s.store.ListModels()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	now := time.Now().UnixMilli()
	reassigned := 0
	if len(added) > 0 {
		for _, m := range models {
			if m.ProviderID != "" {
				continue
			}
			pid := matchProvider(added, providerMatchKey(m))
			if pid == "" {
				continue
			}
			m.ProviderID = pid
			m.UpdatedAt = now
			if err := s.store.SaveModel(m); err != nil {
				writeErr(w, http.StatusInternalServerError, err.Error())
				return
			}
			reassigned++
		}
	}
	writeOK(w, map[string]any{"added": len(added), "reassigned": reassigned, "providers": added})
}

func (s *Server) deleteProvider(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeErr(w, http.StatusBadRequest, "缺少提供商 ID")
		return
	}
	if _, err := s.store.GetProvider(id); err == store.ErrNotFound {
		writeErr(w, http.StatusNotFound, "提供商不存在")
		return
	}
	if err := s.store.DeleteProvider(id); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	// 删除提供商后，原来归入它的模型回到「未设置」，不影响调用
	models, _ := s.store.ListModels()
	for _, m := range models {
		if m.ProviderID != id {
			continue
		}
		m.ProviderID = ""
		m.UpdatedAt = time.Now().UnixMilli()
		_ = s.store.SaveModel(m)
	}
	writeOK(w, nil)
}

func normalizeMatch(list []string) []string {
	out := make([]string, 0, len(list))
	seen := map[string]bool{}
	for _, raw := range list {
		v := strings.ToLower(strings.TrimSpace(raw))
		if v == "" || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	return out
}

// slugifyProviderID 把名称转成可用的 ID：英文/数字直接保留，中文等无法转写的字符丢弃。
func slugifyProviderID(name string) string {
	var b strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(strings.TrimSpace(name)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			lastDash = false
		case r == '_' || r == '-' || unicode.IsSpace(r):
			if b.Len() > 0 && !lastDash {
				b.WriteByte('-')
				lastDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}

// ---------- 批量设置模型提供商 ----------

func (s *Server) batchSetModelProvider(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IDs        []string `json:"ids"`
		ProviderID string   `json:"provider_id"`
		Auto       bool     `json:"auto"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if len(req.IDs) == 0 {
		writeErr(w, http.StatusBadRequest, "请至少选择一个模型")
		return
	}
	providers, err := s.store.ListProviders()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	byID := providerMap(providers)
	pid := strings.TrimSpace(req.ProviderID)
	if !req.Auto && pid != "" {
		if _, ok := byID[pid]; !ok {
			writeErr(w, http.StatusBadRequest, "提供商 "+pid+" 不存在")
			return
		}
	}

	now := time.Now().UnixMilli()
	updated := make([]store.Model, 0, len(req.IDs))
	seen := map[string]bool{}
	for _, raw := range req.IDs {
		id := strings.TrimSpace(raw)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		m, err := s.store.GetModel(id)
		if err != nil {
			continue
		}
		if req.Auto {
			m.ProviderID = matchProvider(providers, providerMatchKey(m))
		} else {
			m.ProviderID = pid
		}
		m.UpdatedAt = now
		updated = append(updated, m)
	}
	if len(updated) == 0 {
		writeErr(w, http.StatusBadRequest, "没有找到可更新的模型")
		return
	}
	if err := s.store.SaveModels(updated); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeOK(w, map[string]any{"updated": len(updated)})
}
