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
	Status        string      `json:"status"`
	ProviderName  string      `json:"provider_name,omitempty"`
	ProviderIcon  string      `json:"provider_icon,omitempty"`
	ProviderColor string      `json:"provider_color,omitempty"`
	Routes        []routeView `json:"routes,omitempty"`
}

type routeView struct {
	ModelID       string `json:"model_id"`
	ChannelID     string `json:"channel_id"`
	ChannelName   string `json:"channel_name,omitempty"`
	Upstream      string `json:"upstream"`
	ChannelReady  bool   `json:"channel_ready"`
	Status        string `json:"status"`
	UpstreamModel string `json:"upstream_model"`
	Weight        int    `json:"weight,omitempty"`
	Group         int    `json:"group,omitempty"`
}

// 模型/路由状态。前端据此显示「可用」「不可用」「渠道已禁用」「渠道模型不存在」。
const (
	statusOK              = "ok"
	statusDisabled        = "disabled"
	statusChannelDisabled = "channel_disabled"
	statusChannelMissing  = "channel_missing"
	statusModelMissing    = "model_missing"
	statusNoRoutes        = "no_routes"
	statusUnavailable     = "unavailable"
	statusCustomError     = "custom_error"
	statusCustomContent   = "custom_content"
)

// routeState 判断一条「渠道 + 上游模型」引用是否真的可用。
func routeState(channelID, upstream string, byID map[string]store.Channel) (string, bool) {
	c, ok := byID[channelID]
	if !ok {
		return statusChannelMissing, false
	}
	if !c.Enabled {
		return statusChannelDisabled, false
	}
	if !containsString(c.Models, upstream) {
		return statusModelMissing, false
	}
	return statusOK, true
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

	out := make([]modelView, 0, len(models))
	for _, m := range models {
		v := modelView{Model: m, Status: statusOK}
		// 回填开关的生效值，前端直接按布尔值渲染（nil 表示未配置）。
		errorEnabled := m.CustomErrorEnabled()
		errorAlways := m.CustomErrorAlways()
		errorAsContent := m.CustomErrorAsContent()
		errorKeepNoRetry := m.ErrorKeepNoRetryOn()
		contentEnabled := m.CustomContentEnabled()
		thinkingOverrideOn := m.ThinkingOverrideEnabled()
		systemPromptOn := m.SystemPromptEnabled()
		forceStream := m.ForceStreamOn()
		v.ErrorEnabled = &errorEnabled
		v.ErrorAlways = &errorAlways
		v.ErrorAsContent = &errorAsContent
		v.ErrorKeepNoRetry = &errorKeepNoRetry
		v.ContentEnabled = &contentEnabled
		v.ThinkingOverrideOn = &thinkingOverrideOn
		v.SystemPromptOn = &systemPromptOn
		v.ForceStream = &forceStream
		if p, ok := providerByID[m.ProviderID]; ok {
			v.ProviderName = p.Name
			v.ProviderIcon = p.Icon
			v.ProviderColor = p.Color
		}
		if m.Type == store.ModelTypeChannel {
			if c, ok := byID[m.ChannelID]; ok {
				v.ChannelName = c.Name
				v.ChannelType = c.Type
			}
			v.Status, v.ChannelReady = routeState(m.ChannelID, m.Upstream, byID)
		} else {
			// 自定义模型只要还有一条路由真正可用，整体就算可用；
			// 其余条目的具体原因放在 route.status 里。
			anyReady := false
			for _, rt := range m.Routes {
				status, ready := routeState(rt.ChannelID, rt.Upstream, byID)
				rv := routeView{
					ModelID:       rt.ChannelID + "/" + rt.Upstream,
					ChannelID:     rt.ChannelID,
					Upstream:      rt.Upstream,
					UpstreamModel: rt.Upstream,
					Weight:        rt.Weight,
					Group:         rt.Group,
					Status:        status,
					ChannelReady:  ready,
				}
				if c, ok := byID[rt.ChannelID]; ok {
					rv.ChannelName = c.Name
				}
				v.Routes = append(v.Routes, rv)
				if ready {
					anyReady = true
				}
			}
			v.ChannelReady = anyReady
			if anyReady {
				v.Status = statusOK
			} else if len(m.Routes) == 0 {
				v.Status = statusNoRoutes
			} else {
				v.Status = statusUnavailable
			}
		}
		if !m.Enabled {
			v.Status = statusDisabled
		} else if m.CustomContentEnabled() {
			// 自定义内容返回不依赖路由，即使没有可用路由也能正常调用。
			v.Status = statusCustomContent
		} else if m.CustomErrorEnabled() && m.CustomErrorAlways() {
			// 始终返回错误的模型即使路由完好也不会真正转发，
			// 列表状态单独标出来，避免显示成「可用」。
			v.Status = statusCustomError
		}
		out = append(out, v)
	}
	writeOK(w, out)
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
	ID                   string         `json:"id"`
	Type                 string         `json:"type"`
	ChannelID            string         `json:"channel_id"`
	Upstream             string         `json:"upstream"`
	Routes               *[]store.Route `json:"routes"`
	ProviderID           *string        `json:"provider_id"`
	Caps                 *store.Caps    `json:"caps"`
	Enabled              *bool          `json:"enabled"`
	DisplayName          *string        `json:"display_name"`
	Description          *string        `json:"description"`
	Tags                 *[]string      `json:"tags"`
	Affinity             *bool          `json:"affinity"`
	CooldownSec          *int           `json:"cooldown_sec"`
	CooldownReset        *bool          `json:"cooldown_reset"`
	NoRetryStatus        *string        `json:"no_retry_status"`
	ErrorEnabled         *bool          `json:"error_enabled"`
	ErrorAlways          *bool          `json:"error_always"`
	ErrorStatus          *int           `json:"error_status"`
	ErrorMessage         *string        `json:"error_message"`
	ErrorAsContent       *bool          `json:"error_as_content"`
	ErrorKeepNoRetry     *bool          `json:"error_keep_no_retry"`
	ContentEnabled       *bool          `json:"content_enabled"`
	ContentText          *string        `json:"content_text"`
	ContentReasoning     *string        `json:"content_reasoning"`
	ContentFirstByteMs   *int           `json:"content_first_byte_ms"`
	ContentSpeed         *int           `json:"content_speed"`
	ContentLatencyMs     *int           `json:"content_latency_ms"`
	ThinkingOverrideOn   *bool          `json:"thinking_override_enabled"`
	ThinkingOverrideText *string        `json:"thinking_override_text"`
	SystemPromptOn       *bool          `json:"system_prompt_enabled"`
	SystemPrompt         *string        `json:"system_prompt"`
	Timeout              *int           `json:"timeout"`
	ForceStream          *bool          `json:"force_stream"`
}

func (s *Server) clearModelCooldowns(w http.ResponseWriter, r *http.Request) {
	// 三种用法：
	//   body {"model_ids":[...]}  批量按模型清（模型列表多选）
	//   ?model_id= / ?channel_id= 单个模型或渠道
	//   都不传                    清空全部
	var req struct {
		ModelIDs []string `json:"model_ids"`
	}
	if r.ContentLength > 0 {
		if err := readJSON(r, &req); err != nil {
			writeErr(w, http.StatusBadRequest, "请求格式错误")
			return
		}
	}
	if len(req.ModelIDs) > 0 {
		cleared := 0
		for _, raw := range req.ModelIDs {
			id := strings.TrimSpace(raw)
			if id == "" {
				continue
			}
			m, err := s.store.GetModel(id)
			if err != nil {
				continue // 选中的模型可能刚被删除，跳过
			}
			cleared += relay.ClearCooldownsForModel(m)
		}
		writeOK(w, map[string]any{"cleared": cleared})
		return
	}
	q := r.URL.Query()
	modelID := strings.TrimSpace(q.Get("model_id"))
	channelID := strings.TrimSpace(q.Get("channel_id"))
	switch {
	case modelID != "":
		m, err := s.store.GetModel(modelID)
		if err != nil {
			writeErr(w, http.StatusNotFound, "模型不存在")
			return
		}
		writeOK(w, map[string]any{"cleared": relay.ClearCooldownsForModel(m)})
	case channelID != "":
		writeOK(w, map[string]any{"cleared": relay.ClearCooldownsForChannel(channelID)})
	default:
		writeOK(w, map[string]any{"cleared": relay.ClearAllCooldowns()})
	}
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
	// POST 只用于新建：目标 ID 已被占用（无论是渠道模型还是自定义模型）一律拒绝。
	// 不做这个检查时，POST 会被下面的逻辑当成「编辑」处理，静默覆盖已有模型的
	// 类型与全部配置——两个自定义模型同名、自定义模型顶掉渠道模型都从这里来。
	if r.PathValue("id") == "" {
		if _, err := s.store.GetModel(targetID); err == nil {
			writeErr(w, http.StatusConflict, "模型 ID "+targetID+" 已存在")
			return
		}
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
		// 不校验渠道与上游模型是否存在：允许先配好模型，之后再补渠道或模型名。
		// 渠道模型的 ID 必须与「渠道ID/上游模型名」一致，保证可追溯
		m.ID = m.ChannelID + "/" + m.Upstream
		req.ID = m.ID
		// 归属决定派生 ID：已有渠道模型的 channel_id / upstream 不允许改。
		// 否则派生 ID 的变化会绕过上面的改名检查——旧记录不删、按新 ID 覆盖
		// 已有模型。要换归属请删除后重新添加。
		if !isNew && m.ID != existing.ID {
			writeErr(w, http.StatusBadRequest, "渠道模型的归属（渠道 / 上游模型名）不能修改，请删除后重新添加")
			return
		}
		if isNew {
			if _, err := s.store.GetModel(m.ID); err == nil {
				writeErr(w, http.StatusConflict, "该渠道模型已添加过了")
				return
			}
		}
		m.Routes = nil
		m.Affinity = false
		m.CooldownSec = nil
		m.CooldownReset = false
	} else {
		// 只更新请求里出现的字段：启停等部分更新不能把路由、参数和描述清空。
		if req.Routes != nil {
			if err := s.validateCustomRoutes(*req.Routes); err != nil {
				writeErr(w, http.StatusBadRequest, err.Error())
				return
			}
			m.Routes = *req.Routes
			if m.Routes == nil {
				m.Routes = []store.Route{}
			}
		} else if isNew {
			m.Routes = []store.Route{}
		}
		if req.Affinity != nil {
			m.Affinity = *req.Affinity
		}
		if req.CooldownSec != nil {
			v := *req.CooldownSec
			if v < 0 {
				v = 0
			}
			if v > 86400 {
				v = 86400
			}
			m.CooldownSec = &v
		}
		if req.CooldownReset != nil {
			m.CooldownReset = *req.CooldownReset
		}
		m.ChannelID = ""
		m.Upstream = ""
	}

	// 不可重试状态码对所有模型类型生效：命中后直接返回上游错误，
	// 不再尝试其它路由，也不记录 Key / 路由冷却。
	if req.NoRetryStatus != nil {
		status, err := store.NormalizeStatusSet(*req.NoRetryStatus)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "不可重试状态码格式有误："+err.Error())
			return
		}
		m.NoRetryStatus = &status
	} else if isNew {
		// 新建模型默认留空：所有状态码都可重试，需要时再手动填入模板。
		empty := ""
		m.NoRetryStatus = &empty
	}

	// 自定义内容返回：开启后所有调用都直接返回配置内容，优先于错误覆写。
	contentEnabled := m.CustomContentEnabled()
	if req.ContentEnabled != nil {
		contentEnabled = *req.ContentEnabled
	}
	if req.ContentText != nil {
		m.ContentText = *req.ContentText
	}
	if req.ContentReasoning != nil {
		m.ContentReasoning = *req.ContentReasoning
	}
	// 时间模拟参数做范围保护：首字/非流式延迟最长 10 分钟，
	// 速度上限 100000 字/秒，避免配置异常值长时间占用连接。
	if req.ContentFirstByteMs != nil {
		m.ContentFirstByteMs = clampInt(*req.ContentFirstByteMs, 0, 600000)
	}
	if req.ContentSpeed != nil {
		m.ContentSpeed = clampInt(*req.ContentSpeed, 0, 100000)
	}
	if req.ContentLatencyMs != nil {
		m.ContentLatencyMs = clampInt(*req.ContentLatencyMs, 0, 600000)
	}
	if contentEnabled && strings.TrimSpace(m.ContentText) == "" {
		writeErr(w, http.StatusBadRequest, "开启自定义内容返回时请填写返回内容")
		return
	}
	m.ContentEnabled = &contentEnabled

	// 思考覆写：只改写模型返回的思考内容，不影响正文和路由。
	// 自定义内容返回优先级更高，同时开启时本项不生效，但配置会保留，
	// 关闭内容返回后自动恢复。
	thinkingOverrideOn := m.ThinkingOverrideEnabled()
	if req.ThinkingOverrideOn != nil {
		thinkingOverrideOn = *req.ThinkingOverrideOn
	}
	if req.ThinkingOverrideText != nil {
		m.ThinkingOverrideText = *req.ThinkingOverrideText
	}
	m.ThinkingOverrideOn = &thinkingOverrideOn

	// 错误覆写：总开关关闭时，子开关与状态码都不生效。
	// 显式关闭总开关会同时关闭「始终返回错误」；「跳过不可重试状态码」
	// 属于保留配置，关闭总开关时不清空，重新开启后继续生效。
	errorEnabled := m.CustomErrorEnabled()
	errorAlways := m.CustomErrorAlways()
	// 覆写为正文属于保留配置：总开关关闭时也按原值保留，重新开启后继续生效。
	errorAsContent := m.ErrorAsContent != nil && *m.ErrorAsContent
	errorKeepNoRetry := m.ErrorKeepNoRetryOn()
	if req.ErrorEnabled != nil {
		errorEnabled = *req.ErrorEnabled
		if !errorEnabled {
			errorAlways = false
		}
	}
	if req.ErrorAlways != nil {
		errorAlways = *req.ErrorAlways
		if errorAlways {
			errorEnabled = true
		}
	}
	if req.ErrorAsContent != nil {
		errorAsContent = *req.ErrorAsContent
		// 单独打开覆写为正文时一并打开总开关；显式关闭总开关时以总开关为准。
		if errorAsContent && req.ErrorEnabled == nil {
			errorEnabled = true
		}
	}
	if req.ErrorKeepNoRetry != nil {
		errorKeepNoRetry = *req.ErrorKeepNoRetry
	}
	if !errorEnabled {
		errorAlways = false
	}
	// 内容返回开启时自动关闭错误覆写，与前端行为保持一致。
	if contentEnabled {
		errorEnabled = false
		errorAlways = false
	}
	if req.ErrorStatus != nil {
		status := *req.ErrorStatus
		if status != 0 && (status < 400 || status > 599) {
			writeErr(w, http.StatusBadRequest, "错误覆写的状态码需在 400–599 之间")
			return
		}
		m.ErrorStatus = status
	}
	if req.ErrorMessage != nil {
		m.ErrorMessage = strings.TrimSpace(*req.ErrorMessage)
	}
	// 内容返回开启时错误配置不生效，允许暂时没有有效状态码；
	// 覆写为正文时状态码固定为 200，同样不需要配置。
	if errorEnabled && m.ErrorStatus == 0 && !contentEnabled && !errorAsContent {
		writeErr(w, http.StatusBadRequest, "开启错误覆写时请填写 400–599 的状态码，或改为「覆写为正文」")
		return
	}
	m.ErrorEnabled = &errorEnabled
	m.ErrorAlways = &errorAlways
	m.ErrorAsContent = &errorAsContent
	m.ErrorKeepNoRetry = &errorKeepNoRetry

	// 系统提示词注入：开启后请求里自带的系统提示词全部丢弃，
	// 只用这里配置的内容作为唯一的系统提示词。
	systemPromptOn := m.SystemPromptEnabled()
	if req.SystemPromptOn != nil {
		systemPromptOn = *req.SystemPromptOn
	}
	if req.SystemPrompt != nil {
		m.SystemPrompt = strings.TrimSpace(*req.SystemPrompt)
	}
	if systemPromptOn && m.SystemPrompt == "" {
		writeErr(w, http.StatusBadRequest, "开启系统提示词注入时请填写提示词内容")
		return
	}
	m.SystemPromptOn = &systemPromptOn

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
		m.ProviderID = strings.TrimSpace(*req.ProviderID)
	} else if isNew || m.ProviderID == "" {
		m.ProviderID = matchProvider(providers, providerMatchKey(m))
	}

	// 只更新请求里出现的字段；显式传空值（caps: {} / tags: [] / ""）才清空。
	if req.Caps != nil {
		m.Caps = *req.Caps
	}
	if req.Enabled != nil {
		m.Enabled = *req.Enabled
	}
	// 超时对所有模型类型生效，0 表示默认 300 秒。
	if req.Timeout != nil {
		m.Timeout = *req.Timeout
		if m.Timeout < 0 {
			m.Timeout = 0
		}
	}
	// 强制流式：开启后对话类请求都用流式请求上游，超时按首字计算。
	// 关闭时保留配置语义，显式 false 也存下来，便于与旧数据（nil）区分。
	if req.ForceStream != nil {
		v := *req.ForceStream
		m.ForceStream = &v
	}
	if req.DisplayName != nil {
		m.DisplayName = strings.TrimSpace(*req.DisplayName)
	}
	if req.Description != nil {
		m.Description = strings.TrimSpace(*req.Description)
	}
	if req.Tags != nil {
		m.Tags = *req.Tags
		if m.Tags == nil {
			m.Tags = []string{}
		}
	} else if isNew {
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
	// 亲和记录指向的路由已从配置里删掉时一并清理，避免以后加回来时旧亲和复活
	relay.PruneModelRoutes(m.ID, m.Routes)
	if renamed {
		if err := s.store.DeleteModel(currentID); err != nil {
			writeErr(w, http.StatusInternalServerError, "旧模型记录清理失败: "+err.Error())
			return
		}
	}
	writeOK(w, m)
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
		// 测试入口不受模型/渠道启用状态限制：禁用只是不对外提供服务，
		// 仍需要能验证上游配置是否正确。
		AllowDisabled: true,
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
	// 只做结构性校验；渠道/上游是否存在由模型列表接口计算状态，不阻止保存。
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
	providers, _ := s.store.ListProviders()

	now := time.Now().UnixMilli()
	noRetryStatus := ""
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
		if _, err := s.store.GetModel(id); err == nil {
			skipped = append(skipped, id+"（已存在）")
			continue
		}
		toSave = append(toSave, store.Model{
			ID: id, Type: store.ModelTypeChannel, ChannelID: chID, Upstream: upstream,
			ProviderID: matchProvider(providers, upstream),
			Enabled:    true, CreatedAt: now, UpdatedAt: now, Tags: []string{},
			NoRetryStatus: &noRetryStatus,
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
	for _, id := range req.IDs {
		relay.ClearModelRoutes(id)
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

func clampInt(v, min, max int) int {
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}
