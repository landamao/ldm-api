package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"time"

	"ldmapi/internal/relay"
	"ldmapi/internal/store"
)

// modelView 是返回给前端的模型视图。
// 注意：Routes 会遮蔽内嵌 Model 的同名字段，因此对外输出的是带 model_id 的详细路由。
type modelView struct {
	store.Model
	ChannelName   string      `json:"channel_name,omitempty"`
	ChannelType   string      `json:"channel_type,omitempty"`
	ChannelReady  bool        `json:"channel_ready"`
	ProviderName  string      `json:"provider_name,omitempty"`
	ProviderIcon  string      `json:"provider_icon,omitempty"`
	ProviderColor string      `json:"provider_color,omitempty"`
	Routes        []routeView `json:"routes,omitempty"`
	CapsSource    string      `json:"caps_source,omitempty"`
	Effective     store.Caps  `json:"effective_caps"`
}

type routeView struct {
	ModelID       string `json:"model_id"`
	ChannelID     string `json:"channel_id"`
	ChannelName   string `json:"channel_name,omitempty"`
	Upstream      string `json:"upstream"`
	ChannelReady  bool   `json:"channel_ready"`
	UpstreamModel string `json:"upstream_model"`
	Weight        int    `json:"weight,omitempty"`
	Group         int    `json:"group,omitempty"`
}

func (s *Server) listModels(w http.ResponseWriter, r *http.Request) {
	models, err := s.store.ListModels()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	chans, _ := s.store.ListChannels()
	byID := map[string]store.Channel{}
	for _, c := range chans {
		byID[c.ID] = c
	}
	providers, _ := s.store.ListProviders()
	providerByID := providerMap(providers)
	modelByID := map[string]store.Model{}
	for _, m := range models {
		modelByID[m.ID] = m
	}

	out := make([]modelView, 0, len(models))
	for _, m := range models {
		v := modelView{Model: m, ChannelReady: true}
		if p, ok := providerByID[m.ProviderID]; ok {
			v.ProviderName = p.Name
			v.ProviderIcon = p.Icon
			v.ProviderColor = p.Color
		}
		if m.Type == store.ModelTypeChannel {
			if c, ok := byID[m.ChannelID]; ok {
				v.ChannelName = c.Name
				v.ChannelType = c.Type
				v.ChannelReady = c.Enabled
			} else {
				v.ChannelReady = false
			}
		} else {
			// 自定义模型只要还有一条路由的渠道可用，整体就算可用；
			// 调度时会自动跳过渠道已禁用的条目，不能因为部分条目不可用就整模判死。
			anyReady := false
			for _, rt := range m.Routes {
				rv := routeView{
					ModelID:       rt.ChannelID + "/" + rt.Upstream,
					ChannelID:     rt.ChannelID,
					Upstream:      rt.Upstream,
					UpstreamModel: rt.Upstream,
					Weight:        rt.Weight,
					Group:         rt.Group,
				}
				if c, ok := byID[rt.ChannelID]; ok {
					rv.ChannelName = c.Name
					rv.ChannelReady = c.Enabled
				}
				v.Routes = append(v.Routes, rv)
				if rv.ChannelReady {
					anyReady = true
				}
			}
			v.ChannelReady = anyReady
		}
		v.CapsSource = m.ParamSource
		v.Effective = s.effectiveCapsOf(m, modelByID, 0)
		out = append(out, v)
	}
	writeOK(w, out)
}

func (s *Server) effectiveCapsOf(m store.Model, byID map[string]store.Model, depth int) store.Caps {
	if depth > 4 || m.ParamSource == "" || m.ParamSource == m.ID {
		return m.Caps
	}
	src, ok := byID[m.ParamSource]
	if !ok {
		return m.Caps
	}
	return s.effectiveCapsOf(src, byID, depth+1)
}

// availableChannelModels 列出全部渠道模型（含已添加状态），供批量选择弹窗使用。
func (s *Server) availableChannelModels(w http.ResponseWriter, r *http.Request) {
	chans, err := s.store.ListChannels()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	models, _ := s.store.ListModels()
	added := map[string]string{} // 渠道模型 ID -> 已添加的模型 ID
	modelByID := map[string]store.Model{}
	for _, m := range models {
		modelByID[m.ID] = m
		if m.Type == store.ModelTypeChannel {
			added[m.ChannelID+"/"+m.Upstream] = m.ID
		}
	}
	providers, _ := s.store.ListProviders()
	providerByID := providerMap(providers)

	type item struct {
		ID           string `json:"id"`
		ChannelID    string `json:"channel_id"`
		ChannelName  string `json:"channel_name,omitempty"`
		ChannelType  string `json:"channel_type"`
		Upstream     string `json:"upstream"`
		ChannelReady bool   `json:"channel_ready"`
		Added        bool   `json:"added"`
		AddedModelID string `json:"added_model_id,omitempty"`
		ProviderID   string `json:"provider_id,omitempty"`
		ProviderName string `json:"provider_name,omitempty"`
		ProviderIcon string `json:"provider_icon,omitempty"`
	}
	out := []item{}
	for _, c := range chans {
		for _, name := range c.Models {
			id := c.ID + "/" + name
			it := item{
				ID: id, ChannelID: c.ID, ChannelName: c.Name, ChannelType: c.Type,
				Upstream: name, ChannelReady: c.Enabled,
			}
			if mid, ok := added[id]; ok {
				it.Added = true
				it.AddedModelID = mid
				it.ProviderID = modelByID[mid].ProviderID
			}
			if it.ProviderID == "" {
				it.ProviderID = matchProvider(providers, name)
			}
			if p, ok := providerByID[it.ProviderID]; ok {
				it.ProviderName = p.Name
				it.ProviderIcon = p.Icon
			}
			out = append(out, it)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	writeOK(w, out)
}

type modelRequest struct {
	ID            string        `json:"id"`
	Type          string        `json:"type"`
	ChannelID     string        `json:"channel_id"`
	Upstream      string        `json:"upstream"`
	Routes        []store.Route `json:"routes"`
	ParamSource   string        `json:"param_source"`
	ProviderID    *string       `json:"provider_id"`
	Caps          store.Caps    `json:"caps"`
	Enabled       *bool         `json:"enabled"`
	DisplayName   string        `json:"display_name"`
	Description   string        `json:"description"`
	Tags          []string      `json:"tags"`
	Affinity      bool          `json:"affinity"`
	CooldownSec   int           `json:"cooldown_sec"`
	CooldownReset bool          `json:"cooldown_reset"`
}

func (s *Server) clearModelCooldowns(w http.ResponseWriter, r *http.Request) {
	writeOK(w, map[string]any{"cleared": relay.ClearAllCooldowns()})
}

func (s *Server) saveModel(w http.ResponseWriter, r *http.Request) {
	var req modelRequest
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	// URL 里是模型当前 ID，body 里是目标 ID。改名时两者不同，
	// 新建或未改名时两者一致。
	currentID := strings.TrimSpace(r.PathValue("id"))
	targetID := strings.TrimSpace(req.ID)
	if currentID == "" {
		currentID = targetID
	}
	if targetID == "" {
		targetID = currentID
	}
	if targetID == "" {
		writeErr(w, http.StatusBadRequest, "模型 ID 不能为空")
		return
	}

	existing, err := s.store.GetModel(currentID)
	isNew := errors.Is(err, store.ErrNotFound)
	if err != nil && !isNew {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if isNew {
		currentID = targetID
	}

	// 改名：自定义模型可以随便改；渠道模型的 ID 由「渠道 ID / 上游模型名」推导，不能改。
	renamed := !isNew && targetID != currentID
	if renamed {
		if existing.Type != store.ModelTypeCustom {
			writeErr(w, http.StatusBadRequest, "渠道模型的 ID 由「渠道 ID / 上游模型名」决定，不能修改")
			return
		}
		if _, err := s.store.GetModel(targetID); err == nil {
			writeErr(w, http.StatusConflict, "模型 ID "+targetID+" 已存在")
			return
		}
	}
	req.ID = targetID

	m := existing
	if isNew {
		m = store.Model{ID: targetID, CreatedAt: time.Now().UnixMilli(), Enabled: true, Type: req.Type}
	}
	m.ID = targetID
	if req.Type != "" {
		m.Type = req.Type
	}
	if m.Type == "" {
		m.Type = store.ModelTypeChannel
	}
	if m.Type != store.ModelTypeChannel && m.Type != store.ModelTypeCustom {
		writeErr(w, http.StatusBadRequest, "模型类型必须是 channel 或 custom")
		return
	}

	if m.Type == store.ModelTypeChannel {
		if req.ChannelID != "" {
			m.ChannelID = strings.TrimSpace(req.ChannelID)
		}
		if req.Upstream != "" {
			m.Upstream = strings.TrimSpace(req.Upstream)
		}
		if m.ChannelID == "" || m.Upstream == "" {
			writeErr(w, http.StatusBadRequest, "渠道模型必须指定渠道与上游模型名")
			return
		}
		ch, err := s.store.GetChannel(m.ChannelID)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "渠道 "+m.ChannelID+" 不存在")
			return
		}
		if !containsString(ch.Models, m.Upstream) {
			writeErr(w, http.StatusBadRequest, fmt.Sprintf("渠道 %s 未配置模型 %s，请先在渠道设置中添加", m.ChannelID, m.Upstream))
			return
		}
		// 渠道模型的 ID 必须与「渠道ID/上游模型名」一致，保证可追溯
		m.ID = m.ChannelID + "/" + m.Upstream
		req.ID = m.ID
		if isNew {
			if _, err := s.store.GetModel(m.ID); err == nil {
				writeErr(w, http.StatusConflict, "该渠道模型已添加过了")
				return
			}
		}
		m.Routes = nil
		m.ParamSource = ""
		m.Affinity = false
		m.CooldownSec = 0
		m.CooldownReset = false
	} else {
		if err := s.validateCustomRoutes(req.Routes); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		m.Routes = req.Routes
		if m.Routes == nil {
			m.Routes = []store.Route{}
		}
		m.Affinity = req.Affinity
		m.CooldownSec = req.CooldownSec
		if m.CooldownSec < 0 {
			m.CooldownSec = 0
		}
		if m.CooldownSec > 86400 {
			m.CooldownSec = 86400
		}
		m.CooldownReset = req.CooldownReset
		m.ChannelID = ""
		m.Upstream = ""
		if req.ParamSource != "" && req.ParamSource != m.ID {
			if _, err := s.store.GetModel(req.ParamSource); err != nil {
				writeErr(w, http.StatusBadRequest, "参数来源模型 "+req.ParamSource+" 不存在")
				return
			}
			m.ParamSource = req.ParamSource
		} else {
			m.ParamSource = ""
		}
	}

	if isNew {
		if _, err := s.store.GetModel(m.ID); err == nil {
			writeErr(w, http.StatusConflict, "模型 ID "+m.ID+" 已存在")
			return
		}
	}

	// 提供商：请求里显式给了就以请求为准（空串表示清空）；
	// 没给时，新模型或尚未归属的模型按关键词自动匹配。
	providers, _ := s.store.ListProviders()
	if req.ProviderID != nil {
		pid := strings.TrimSpace(*req.ProviderID)
		if pid != "" {
			if _, ok := providerMap(providers)[pid]; !ok {
				writeErr(w, http.StatusBadRequest, "提供商 "+pid+" 不存在")
				return
			}
		}
		m.ProviderID = pid
	} else if isNew || m.ProviderID == "" {
		m.ProviderID = matchProvider(providers, providerMatchKey(m))
	}

	// 始终以请求为准：否则用户没法把已有配置清空回「全部透传」
	m.Caps = req.Caps
	if req.Enabled != nil {
		m.Enabled = *req.Enabled
	}
	m.DisplayName = strings.TrimSpace(req.DisplayName)
	m.Description = strings.TrimSpace(req.Description)
	m.Tags = req.Tags
	if m.Tags == nil {
		m.Tags = []string{}
	}
	m.UpdatedAt = time.Now().UnixMilli()

	if err := s.store.SaveModel(m); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	// ID 变了，旧的亲和记录作废
	if renamed {
		relay.ClearModelRoutes(currentID)
	}
	if renamed {
		if err := s.store.DeleteModel(currentID); err != nil {
			writeErr(w, http.StatusInternalServerError, "旧模型记录清理失败: "+err.Error())
			return
		}
		s.renameModelRefs(currentID, targetID)
	}
	writeOK(w, m)
}

// renameModelRefs 把其它模型里指向旧 ID 的参数继承关系改到新 ID 上。
func (s *Server) renameModelRefs(oldID, newID string) {
	models, err := s.store.ListModels()
	if err != nil {
		return
	}
	for _, m := range models {
		if m.ParamSource != oldID {
			continue
		}
		m.ParamSource = newID
		m.UpdatedAt = time.Now().UnixMilli()
		_ = s.store.SaveModel(m)
	}
}

// extractReplyText 从上游返回的 OpenAI 格式响应里取出正文，用于测试结果展示。
func extractReplyText(raw []byte) string {
	var resp struct {
		Choices []struct {
			Message struct {
				Content          string `json:"content"`
				ReasoningContent string `json:"reasoning_content"`
			} `json:"message"`
		} `json:"choices"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return truncateText(strings.TrimSpace(string(raw)), 600)
	}
	if len(resp.Choices) > 0 {
		if c := resp.Choices[0].Message.Content; c != "" {
			return truncateText(c, 600)
		}
		if rc := resp.Choices[0].Message.ReasoningContent; rc != "" {
			return truncateText(rc, 600)
		}
	}
	if resp.Error != nil {
		return truncateText(resp.Error.Message, 600)
	}
	return truncateText(strings.TrimSpace(string(raw)), 600)
}

func truncateText(s string, n int) string {
	if len(s) <= n {
		return s
	}
	// 按 rune 截断，避免把一个多字节字符劈开
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// testModel 用一次真实的最小调用验证模型是否可用，并返回耗时与上游正文。
func (s *Server) testModel(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	id := strings.TrimSpace(req.ID)
	if id == "" {
		writeErr(w, http.StatusBadRequest, "缺少模型 ID")
		return
	}
	if _, err := s.store.GetModel(id); err != nil {
		writeErr(w, http.StatusNotFound, "模型 "+id+" 不存在")
		return
	}

	payload := map[string]any{
		"model":      id,
		"messages":   []any{map[string]any{"role": "user", "content": "你好"}},
		"max_tokens": 64,
		"stream":     false,
	}
	body, _ := json.Marshal(payload)

	rec := httptest.NewRecorder()
	source := store.Token{ID: "modeltest", Name: "模型测试"}
	relayReq := &relay.Request{
		Token:  source,
		Path:   "/v1/chat/completions",
		Method: http.MethodPost,
		Header: http.Header{"Content-Type": []string{"application/json"}},
		Body:   body,
		IP:     clientIP(r),
	}
	_ = json.Unmarshal(body, &relayReq.JSON)

	start := time.Now()
	res := s.relay.Do(r.Context(), rec, relayReq)
	elapsed := time.Since(start).Milliseconds()
	res.LatencyMs = elapsed
	s.record(source, relayReq, res)

	ok := res.StatusCode < 400 && res.Err == ""
	out := map[string]any{
		"ok":                ok,
		"latency_ms":        elapsed,
		"status_code":       res.StatusCode,
		"channel_id":        res.ChannelID,
		"upstream_model":    res.UpstreamModel,
		"prompt_tokens":     res.Usage.PromptTokens,
		"completion_tokens": res.Usage.CompletionTokens,
		"total_tokens":      res.Usage.TotalTokens,
	}
	if ok {
		out["content"] = extractReplyText(rec.Body.Bytes())
	} else {
		msg := res.Err
		if msg == "" {
			msg = extractReplyText(rec.Body.Bytes())
		}
		out["error"] = truncateText(msg, 600)
	}
	writeOK(w, out)
}

func (s *Server) validateCustomRoutes(routes []store.Route) error {
	seen := map[string]bool{}
	for i, rt := range routes {
		key := rt.ChannelID + "/" + rt.Upstream
		if rt.ChannelID == "" || rt.Upstream == "" {
			return fmt.Errorf("第 %d 条路由缺少渠道或模型", i+1)
		}
		if seen[key] {
			return errors.New("路由目标重复：" + key)
		}
		seen[key] = true
		if rt.Weight < 0 || rt.Weight > 1000 {
			return fmt.Errorf("第 %d 条路由的权重需在 0–1000 之间", i+1)
		}
		if rt.Group < 0 || rt.Group > 1000 {
			return fmt.Errorf("第 %d 条路由的分组需在 0–1000 之间", i+1)
		}
		ch, err := s.store.GetChannel(rt.ChannelID)
		if err != nil {
			return fmt.Errorf("路由目标 %s 的渠道不存在", key)
		}
		if !containsString(ch.Models, rt.Upstream) {
			return fmt.Errorf("渠道 %s 未配置模型 %s", rt.ChannelID, rt.Upstream)
		}
	}
	return nil
}

func (s *Server) deleteModel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := s.store.GetModel(id); errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "模型不存在")
		return
	}
	if err := s.store.DeleteModel(id); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	relay.ClearModelRoutes(id)
	// 清理其它模型对它的参数继承引用
	models, _ := s.store.ListModels()
	for _, m := range models {
		if m.ParamSource == id {
			m.ParamSource = ""
			m.UpdatedAt = time.Now().UnixMilli()
			_ = s.store.SaveModel(m)
		}
	}
	writeOK(w, nil)
}

// batchAddModels 批量把渠道模型加入模型设置。
func (s *Server) batchAddModels(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IDs []string `json:"ids"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if len(req.IDs) == 0 {
		writeErr(w, http.StatusBadRequest, "请至少选择一个渠道模型")
		return
	}
	chans, _ := s.store.ListChannels()
	chanByID := map[string]store.Channel{}
	for _, c := range chans {
		chanByID[c.ID] = c
	}
	providers, _ := s.store.ListProviders()

	now := time.Now().UnixMilli()
	var toSave []store.Model
	var skipped []string
	for _, raw := range req.IDs {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		chID, upstream, ok := splitChannelModel(id)
		if !ok {
			skipped = append(skipped, id+"（格式错误）")
			continue
		}
		ch, ok := chanByID[chID]
		if !ok {
			skipped = append(skipped, id+"（渠道不存在）")
			continue
		}
		if !containsString(ch.Models, upstream) {
			skipped = append(skipped, id+"（渠道未配置该模型）")
			continue
		}
		if _, err := s.store.GetModel(id); err == nil {
			skipped = append(skipped, id+"（已存在）")
			continue
		}
		toSave = append(toSave, store.Model{
			ID: id, Type: store.ModelTypeChannel, ChannelID: chID, Upstream: upstream,
			ProviderID: matchProvider(providers, upstream),
			Enabled:    true, CreatedAt: now, UpdatedAt: now, Tags: []string{},
		})
	}
	if len(toSave) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"added": 0, "skipped": skipped})
		return
	}
	if err := s.store.SaveModels(toSave); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeOK(w, map[string]any{"added": len(toSave), "skipped": skipped, "models": toSave})
}

func (s *Server) batchDeleteModels(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IDs []string `json:"ids"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if len(req.IDs) == 0 {
		writeErr(w, http.StatusBadRequest, "请至少选择一个模型")
		return
	}
	if err := s.store.DeleteModels(req.IDs); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	gone := map[string]bool{}
	for _, id := range req.IDs {
		gone[id] = true
	}
	models, _ := s.store.ListModels()
	for _, m := range models {
		if gone[m.ParamSource] {
			m.ParamSource = ""
			_ = s.store.SaveModel(m)
		}
	}
	writeOK(w, map[string]any{"deleted": len(req.IDs)})
}

func splitChannelModel(id string) (string, string, bool) {
	i := strings.Index(id, "/")
	if i <= 0 || i == len(id)-1 {
		return "", "", false
	}
	return id[:i], id[i+1:], true
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
