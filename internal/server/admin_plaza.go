package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"time"

	"ldmapi/internal/relay"
	"ldmapi/internal/store"
)

// plazaItem 是模型广场里展示的一张卡片。
type plazaItem struct {
	ID            string      `json:"id"`
	Type          string      `json:"type"`
	DisplayName   string      `json:"display_name,omitempty"`
	Description   string      `json:"description,omitempty"`
	Tags          []string    `json:"tags"`
	Caps          store.Caps  `json:"caps"`
	Available     bool        `json:"available"`
	Status        string      `json:"status"`
	Source        string      `json:"source,omitempty"`
	Upstream      string      `json:"upstream,omitempty"`
	ChannelType   string      `json:"channel_type,omitempty"`
	ProviderID    string      `json:"provider_id,omitempty"`
	ProviderName  string      `json:"provider_name,omitempty"`
	ProviderIcon  string      `json:"provider_icon,omitempty"`
	ProviderColor string      `json:"provider_color,omitempty"`
	Routes        []routeView `json:"routes,omitempty"`

	// 自定义模型的路由调度配置，详情抽屉需要展示真实的分组/亲和/冷却信息
	Affinity      bool `json:"affinity,omitempty"`
	CooldownSec   int  `json:"cooldown_sec,omitempty"`
	CooldownReset bool `json:"cooldown_reset,omitempty"`

	Requests24h int64   `json:"requests_24h"`
	Errors24h   int64   `json:"errors_24h"`
	SuccessRate float64 `json:"success_rate"`
}

func (s *Server) plaza(w http.ResponseWriter, r *http.Request) {
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

	// 最近 24 小时的调用量与失败量
	stats, _ := s.store.RangeStats(time.Now().Add(-24*time.Hour).UnixMilli(), time.Now().UnixMilli())
	reqs := map[string]int64{}
	errs := map[string]int64{}
	for _, b := range stats {
		for k, v := range b.ModelCounts {
			reqs[k] += v
		}
		for k, v := range b.ModelErrors {
			errs[k] += v
		}
	}

	out := []plazaItem{}
	for _, m := range models {
		item := plazaItem{
			ID: m.ID, Type: m.Type, DisplayName: m.DisplayName, Description: m.Description,
			Tags: m.Tags, Caps: s.effectiveCapsOf(m, modelByID, 0), Available: m.Enabled,
			ProviderID: m.ProviderID,
			Affinity:   m.Affinity, CooldownSec: m.CooldownSec, CooldownReset: m.CooldownReset,
			Requests24h: reqs[m.ID], Errors24h: errs[m.ID],
		}
		if p, ok := providerByID[m.ProviderID]; ok {
			item.ProviderName = p.Name
			item.ProviderIcon = p.Icon
			item.ProviderColor = p.Color
		}
		if item.Tags == nil {
			item.Tags = []string{}
		}
		if m.Type == store.ModelTypeChannel {
			item.Upstream = m.Upstream
			status, ready := routeState(m.ChannelID, m.Upstream, byID)
			item.Status = status
			item.Available = m.Enabled && ready
			if c, ok := byID[m.ChannelID]; ok {
				item.Source = c.ID
				if c.Name != "" {
					item.Source = c.ID + "（" + c.Name + "）"
				}
				item.ChannelType = c.Type
			}
			if !m.Enabled {
				item.Status = statusDisabled
			}
		} else {
			// 只要还有一条路由可用，自定义模型就整体可用；不可用的条目只在详情里标状态。
			anyReady := false
			for _, rt := range m.Routes {
				status, routeReady := routeState(rt.ChannelID, rt.Upstream, byID)
				rv := routeView{
					ModelID: rt.ChannelID + "/" + rt.Upstream, ChannelID: rt.ChannelID,
					Upstream: rt.Upstream, UpstreamModel: rt.Upstream,
					Weight: rt.Weight, Group: rt.Group,
					Status: status, ChannelReady: routeReady,
				}
				if c, ok := byID[rt.ChannelID]; ok {
					rv.ChannelName = c.Name
					item.ChannelType = c.Type
				}
				if routeReady {
					anyReady = true
				}
				item.Routes = append(item.Routes, rv)
			}
			item.Available = m.Enabled && anyReady
			switch {
			case !m.Enabled:
				item.Status = statusDisabled
			case anyReady:
				item.Status = statusOK
			case len(m.Routes) == 0:
				item.Status = statusNoRoutes
			default:
				item.Status = statusUnavailable
			}
			if len(m.Routes) > 0 {
				parts := make([]string, 0, len(m.Routes))
				for _, rt := range m.Routes {
					parts = append(parts, rt.ChannelID+"/"+rt.Upstream)
				}
				item.Source = joinArrow(parts)
			} else {
				item.Source = "自定义路由 · 未配置目标"
			}
		}

		// 一次调用都没有时标记成「无数据」，前端显示为 —，
		// 而不是伪造一个 100% 让人误以为跑得很健康
		if item.Requests24h > 0 {
			item.SuccessRate = float64(item.Requests24h-item.Errors24h) * 100 / float64(item.Requests24h)
		} else {
			item.SuccessRate = -1
		}
		out = append(out, item)
	}
	writeOK(w, out)
}

func joinArrow(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += " → "
		}
		out += p
	}
	return out
}

// chat 是管理端的在线对话入口：不需要创建 API 密钥就能直接和任意已启用的模型对话。
// 流式与非流式调用都会照常写进日志与统计，方便在「调用日志」里回看。
func (s *Server) chat(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Model    string `json:"model"`
		Messages []any  `json:"messages"`
		Stream   bool   `json:"stream"`
		// 采样参数用指针区分「没传」和「传了 0」：在线对话里每个参数
		// 都有独立开关，关掉的参数不能出现在请求体里。
		Temp    *float64        `json:"temperature"`
		TopP    *float64        `json:"top_p"`
		FreqPen *float64        `json:"frequency_penalty"`
		PresPen *float64        `json:"presence_penalty"`
		MaxTok  *int            `json:"max_tokens"`
		Seed    *int64          `json:"seed"`
		Raw     json.RawMessage `json:"raw"` // 自定义请求体：原样转发，不再由网关拼装
	}
	// 在线对话可能带上 base64 图片或附件，单独放宽到 64MB。
	if err := readJSONLimit(r, &req, 64<<20); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式错误")
		return
	}

	var payload map[string]any
	stream := req.Stream
	if len(req.Raw) > 0 && string(req.Raw) != "null" {
		dec := json.NewDecoder(bytes.NewReader(req.Raw))
		dec.UseNumber()
		if err := dec.Decode(&payload); err != nil || payload == nil {
			writeErr(w, http.StatusBadRequest, "自定义请求体不是合法的 JSON 对象")
			return
		}
		model, _ := payload["model"].(string)
		if model == "" {
			writeErr(w, http.StatusBadRequest, "自定义请求体缺少 model 字段")
			return
		}
		req.Model = model
		if sv, ok := payload["stream"].(bool); ok {
			stream = sv
		}
	} else {
		if req.Model == "" {
			writeErr(w, http.StatusBadRequest, "缺少模型 ID")
			return
		}
		payload = map[string]any{
			"model":    req.Model,
			"messages": req.Messages,
			"stream":   req.Stream,
		}
		if req.Temp != nil {
			payload["temperature"] = *req.Temp
		}
		if req.TopP != nil {
			payload["top_p"] = *req.TopP
		}
		if req.FreqPen != nil {
			payload["frequency_penalty"] = *req.FreqPen
		}
		if req.PresPen != nil {
			payload["presence_penalty"] = *req.PresPen
		}
		if req.MaxTok != nil && *req.MaxTok > 0 {
			payload["max_tokens"] = *req.MaxTok
		}
		if req.Seed != nil {
			payload["seed"] = *req.Seed
		}
	}
	body, _ := json.Marshal(payload)

	source := store.Token{ID: "playground", Name: "在线对话"}
	relayReq := &relay.Request{
		Token:  source,
		Path:   "/v1/chat/completions",
		Method: http.MethodPost,
		Header: r.Header.Clone(),
		Body:   body,
		Stream: stream,
		IP:     clientIP(r),
	}
	_ = json.Unmarshal(body, &relayReq.JSON)

	res := s.relay.Do(r.Context(), w, relayReq)
	s.record(source, relayReq, res)
}
