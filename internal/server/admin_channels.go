package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"ldmapi/internal/store"
	"ldmapi/internal/upstream"
)

// channelView 是返回给前端的渠道视图，附带派生信息。
type channelView struct {
	store.Channel
	ChannelModels []string `json:"channel_models"` // 派生的渠道模型 ID
	AddedCount    int      `json:"added_count"`    // 已加入模型设置的渠道模型数量
}

func (s *Server) listChannels(w http.ResponseWriter, r *http.Request) {
	chans, err := s.store.ListChannels()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	models, _ := s.store.ListModels()
	added := map[string]bool{}
	for _, m := range models {
		if m.Type == store.ModelTypeChannel {
			added[m.ChannelID+"/"+m.Upstream] = true
		}
	}
	out := make([]channelView, 0, len(chans))
	for _, c := range chans {
		v := channelView{Channel: c, ChannelModels: []string{}}
		for _, name := range c.Models {
			id := c.ID + "/" + name
			v.ChannelModels = append(v.ChannelModels, id)
			if added[id] {
				v.AddedCount++
			}
		}
		v.APIKey = maskKey(c.APIKey)
		out = append(out, v)
	}
	writeOK(w, out)
}

func maskKey(k string) string {
	if len(k) <= 8 {
		if k == "" {
			return ""
		}
		return "****"
	}
	return k[:4] + "****" + k[len(k)-4:]
}

// 指针字段未出现在请求里时表示「不修改」，这样列表页的启停开关只提交
// enabled 也不会把其余配置清掉；完整编辑表单则带全所有字段（含显式清空）。
type channelRequest struct {
	ID      string             `json:"id"`
	Name    *string            `json:"name"`
	Type    string             `json:"type"`
	BaseURL *string            `json:"base_url"`
	APIKey  string             `json:"api_key"`
	Models  *[]string          `json:"models"`
	Headers *map[string]string `json:"headers"`
	Enabled *bool              `json:"enabled"`
	Weight  *int               `json:"weight"`
	Timeout *int               `json:"timeout"`
	Remark  *string            `json:"remark"`
}

func (s *Server) saveChannel(w http.ResponseWriter, r *http.Request) {
	var req channelRequest
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	id := strings.TrimSpace(req.ID)
	if id == "" {
		id = strings.TrimSpace(r.PathValue("id"))
	}
	if err := validateChannelID(id); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	existing, err := s.store.GetChannel(id)
	isNew := errors.Is(err, store.ErrNotFound)
	if err != nil && !isNew {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	ch := existing
	if isNew {
		ch = store.Channel{CreatedAt: time.Now().UnixMilli(), Enabled: true, Weight: 1}
	}
	ch.ID = id
	if req.Name != nil {
		ch.Name = strings.TrimSpace(*req.Name)
	}
	if req.Type != "" {
		ch.Type = req.Type
	}
	if ch.Type == "" {
		ch.Type = store.ChannelOpenAI
	}
	if _, ok := upstream.TypeNames[ch.Type]; !ok {
		writeErr(w, http.StatusBadRequest, "不支持的渠道类型："+ch.Type)
		return
	}
	if req.BaseURL != nil {
		base := strings.TrimSpace(*req.BaseURL)
		if base == "" {
			writeErr(w, http.StatusBadRequest, "接口地址（Base URL）不能为空")
			return
		}
		if !strings.Contains(base, "://") {
			writeErr(w, http.StatusBadRequest, "接口地址需要带上协议，例如 https://api.example.com")
			return
		}
		ch.BaseURL = base
	}
	if isNew && ch.BaseURL == "" {
		writeErr(w, http.StatusBadRequest, "接口地址（Base URL）不能为空")
		return
	}
	// 前端拿到的是掩码后的密钥，未改动时保持原值
	if req.APIKey != "" && !strings.Contains(req.APIKey, "****") {
		ch.APIKey = strings.TrimSpace(req.APIKey)
	}
	if req.Models != nil {
		models, err := normalizeModelNames(*req.Models)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		ch.Models = models
	}
	if req.Headers != nil {
		ch.Headers = *req.Headers
	}
	if req.Enabled != nil {
		ch.Enabled = *req.Enabled
	}
	if req.Weight != nil {
		ch.Weight = *req.Weight
	}
	if req.Timeout != nil {
		ch.Timeout = *req.Timeout
	}
	if req.Remark != nil {
		ch.Remark = strings.TrimSpace(*req.Remark)
	}
	ch.UpdatedAt = time.Now().UnixMilli()

	if err := s.store.SaveChannel(ch); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	// 渠道模型改名后，同步更新已添加的渠道模型与自定义模型路由
	removed := s.syncChannelModelRefs(ch, existing, isNew)
	writeOK(w, map[string]any{
		"channel":        ch,
		"removed_models": removed,
		"channel_models": prefixed(ch.ID, ch.Models),
		"created":        isNew,
	})
}

func prefixed(id string, models []string) []string {
	out := make([]string, 0, len(models))
	for _, m := range models {
		out = append(out, id+"/"+m)
	}
	return out
}

// syncChannelModelRefs 处理渠道模型列表变化带来的引用清理。
func (s *Server) syncChannelModelRefs(ch, old store.Channel, isNew bool) []string {
	if isNew {
		return nil
	}
	oldSet := map[string]bool{}
	for _, m := range old.Models {
		oldSet[m] = true
	}
	newSet := map[string]bool{}
	for _, m := range ch.Models {
		newSet[m] = true
	}
	var gone []string
	for m := range oldSet {
		if !newSet[m] {
			gone = append(gone, m)
		}
	}
	if len(gone) == 0 {
		return nil
	}
	models, err := s.store.ListModels()
	if err != nil {
		return nil
	}
	var removed []string
	for _, m := range models {
		if m.Type == store.ModelTypeChannel && m.ChannelID == ch.ID {
			for _, g := range gone {
				if m.Upstream == g {
					_ = s.store.DeleteModel(m.ID)
					removed = append(removed, m.ID)
				}
			}
			continue
		}
		if m.Type == store.ModelTypeCustom {
			kept := make([]store.Route, 0, len(m.Routes))
			changed := false
			for _, rt := range m.Routes {
				if rt.ChannelID == ch.ID && !newSet[rt.Upstream] {
					changed = true
					continue
				}
				kept = append(kept, rt)
			}
			if changed {
				m.Routes = kept
				m.UpdatedAt = time.Now().UnixMilli()
				_ = s.store.SaveModel(m)
			}
		}
	}
	return removed
}

func validateChannelID(id string) error {
	if id == "" {
		return errors.New("渠道 ID 不能为空")
	}
	if strings.Contains(id, "/") {
		return errors.New("渠道 ID 不能包含 '/'")
	}
	if strings.ContainsAny(id, " \t\n\r") {
		return errors.New("渠道 ID 不能包含空格")
	}
	if len(id) > 64 {
		return errors.New("渠道 ID 过长（最多 64 字符）")
	}
	return nil
}

func normalizeModelNames(in []string) ([]string, error) {
	out := []string{}
	seen := map[string]bool{}
	for _, raw := range in {
		// 支持一次粘贴多行/逗号分隔
		for _, part := range strings.FieldsFunc(raw, func(r rune) bool {
			return r == ',' || r == '\n' || r == '\r' || r == ';'
		}) {
			name := strings.TrimSpace(part)
			if name == "" || seen[name] {
				continue
			}
			seen[name] = true
			out = append(out, name)
		}
	}
	if len(out) == 0 {
		return out, nil
	}
	return out, nil
}

func (s *Server) deleteChannel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	ch, err := s.store.GetChannel(id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "渠道不存在")
		return
	}
	removed, err := s.store.DeleteChannelCascade(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = ch
	writeOK(w, map[string]any{"success": true, "removed_models": removed})
}

// ---------- 渠道测试 / 探测 ----------

func (s *Server) testChannel(w http.ResponseWriter, r *http.Request) {
	ch, err := s.store.GetChannel(r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusNotFound, "渠道不存在")
		return
	}
	result := s.probeChannel(ch)
	writeOK(w, result)
}

type probeResult struct {
	OK      bool     `json:"ok"`
	Message string   `json:"message"`
	Latency int64    `json:"latency_ms"`
	Models  []string `json:"models,omitempty"`
}

// probeChannel 用最轻量的方式验证渠道是否可用。
func (s *Server) probeChannel(ch store.Channel) probeResult {
	start := time.Now()
	base := upstream.NormalizeBase(ch.BaseURL)
	if base == "" {
		return probeResult{OK: false, Message: "该渠道还没有填写接口地址"}
	}
	client := &http.Client{Timeout: 30 * time.Second}

	// 先试模型列表接口，它最省额度
	listPath := "/v1/models"
	if ch.Type == store.ChannelGemini {
		listPath = "/v1beta/models"
	}
	if ch.Type == store.ChannelAnthropic {
		listPath = "/v1/models"
	}
	req, err := http.NewRequest(http.MethodGet, upstream.JoinURL(base, listPath), nil)
	if err == nil {
		upstream.Get(ch.Type).Auth(req, ch)
		if resp, err := client.Do(req); err == nil {
			raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			resp.Body.Close()
			if resp.StatusCode < 400 {
				models := parseModelIDs(raw)
				msg := fmt.Sprintf("连接成功，上游返回 %d 个模型", len(models))
				if len(models) == 0 {
					msg = "连接成功"
				}
				return probeResult{OK: true, Message: msg, Latency: time.Since(start).Milliseconds(), Models: models}
			}
		}
	}

	// 回退到一次极小的对话请求
	if len(ch.Models) == 0 {
		return probeResult{OK: false, Message: "渠道未配置任何模型，且模型列表接口不可用", Latency: time.Since(start).Milliseconds()}
	}
	model := ch.Models[0]
	payload := map[string]any{
		"model":      model,
		"messages":   []any{map[string]any{"role": "user", "content": "hi"}},
		"max_tokens": 1,
	}
	path := "/v1/chat/completions"
	if ch.Type == store.ChannelAnthropic {
		path = "/v1/messages"
		payload["max_tokens"] = 1
		delete(payload, "messages")
		payload["messages"] = []any{map[string]any{"role": "user", "content": "hi"}}
	}
	if ch.Type == store.ChannelGemini {
		path = upstream.Get(ch.Type).UpstreamPath("/v1/chat/completions", model, false)
		payload = map[string]any{
			"contents":         []any{map[string]any{"role": "user", "parts": []any{map[string]any{"text": "hi"}}}},
			"generationConfig": map[string]any{"maxOutputTokens": 1},
		}
	}
	body, _ := json.Marshal(payload)
	req, err = http.NewRequest(http.MethodPost, upstream.JoinURL(base, path), strings.NewReader(string(body)))
	if err != nil {
		return probeResult{OK: false, Message: err.Error(), Latency: time.Since(start).Milliseconds()}
	}
	upstream.Get(ch.Type).Auth(req, ch)
	resp, err := client.Do(req)
	if err != nil {
		return probeResult{OK: false, Message: "请求失败: " + err.Error(), Latency: time.Since(start).Milliseconds()}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 400 {
		return probeResult{OK: false, Message: fmt.Sprintf("HTTP %d: %s", resp.StatusCode, truncateErr(string(raw))),
			Latency: time.Since(start).Milliseconds()}
	}
	return probeResult{OK: true, Message: "连接成功（模型 " + model + " 可用）", Latency: time.Since(start).Milliseconds()}
}

// parseModelIDs 兼容 OpenAI / Anthropic / Gemini 三种模型列表结构。
func parseModelIDs(raw []byte) []string {
	var openai struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &openai); err == nil && len(openai.Data) > 0 {
		out := make([]string, 0, len(openai.Data))
		for _, d := range openai.Data {
			if d.ID != "" {
				out = append(out, d.ID)
			}
		}
		return out
	}
	var gemini struct {
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	if err := json.Unmarshal(raw, &gemini); err == nil && len(gemini.Models) > 0 {
		out := make([]string, 0, len(gemini.Models))
		for _, m := range gemini.Models {
			out = append(out, strings.TrimPrefix(m.Name, "models/"))
		}
		return out
	}
	return nil
}

// discoverChannelModels 用表单里当前填写的连接信息去上游拉取模型列表。
// 渠道不需要先保存——填好接口地址和 API Key 就能用，避免「要获取模型必须先保存、
// 要保存又必须先填模型」的死循环。
func (s *Server) discoverChannelModels(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID      string `json:"id"`
		Type    string `json:"type"`
		BaseURL string `json:"base_url"`
		APIKey  string `json:"api_key"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式错误")
		return
	}

	ch := store.Channel{
		ID:      strings.TrimSpace(req.ID),
		Type:    strings.TrimSpace(req.Type),
		BaseURL: strings.TrimSpace(req.BaseURL),
		APIKey:  strings.TrimSpace(req.APIKey),
	}
	if ch.Type == "" {
		ch.Type = store.ChannelOpenAI
	}
	if _, ok := upstream.TypeNames[ch.Type]; !ok {
		writeErr(w, http.StatusBadRequest, "不支持的渠道类型："+ch.Type)
		return
	}
	// 密钥留空、或者填的是列表页展示的掩码值时，回退到已保存的渠道配置
	if ch.APIKey == "" || strings.Contains(ch.APIKey, "****") {
		if saved, err := s.store.GetChannel(ch.ID); err == nil {
			ch.APIKey = saved.APIKey
			if ch.BaseURL == "" {
				ch.BaseURL = saved.BaseURL
			}
			if ch.Type == store.ChannelOpenAI && saved.Type != "" {
				ch.Type = saved.Type
			}
		}
	}
	// 接口地址必须显式填写：网关不会替用户猜一个默认上游，
	// 否则填错或漏填时会静默打到官方 API 上。
	if ch.BaseURL == "" {
		writeErr(w, http.StatusBadRequest, "请先填写接口地址")
		return
	}
	if !strings.Contains(ch.BaseURL, "://") {
		writeErr(w, http.StatusBadRequest, "接口地址需要带上协议，例如 https://api.example.com")
		return
	}

	res := s.probeChannel(ch)
	if !res.OK {
		writeErr(w, http.StatusBadGateway, res.Message)
		return
	}
	writeOK(w, map[string]any{
		"models": res.Models, "message": res.Message, "latency_ms": res.Latency,
	})
}
