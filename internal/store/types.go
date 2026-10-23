package store

import (
	"strings"
	"time"
)

// DefaultCooldownSec 是冷却时长未设置（旧数据）时的默认值。
const DefaultCooldownSec = 300

// Caps 描述一个模型的能力参数。
// ContextLength / MaxOutput 仅用于模型广场和模型列表的展示。
// ToolCalling / Thinking / Vision 是三态：nil 表示不设置，true 表示支持，
// false 表示不支持。明确标记为不支持时，网关会在转发前检查请求：
// 对应的 *Error 开关打开则直接返回 400，关闭则从请求里移除相关内容后继续。
type Caps struct {
	ContextLength *int  `json:"context_length,omitempty"`
	MaxOutput     *int  `json:"max_output,omitempty"`
	ToolCalling   *bool `json:"tool_calling,omitempty"`
	Thinking      *bool `json:"thinking,omitempty"`
	Vision        *bool `json:"vision,omitempty"`
	// 以下开关只在对应能力明确为 false（不支持）时生效。
	ToolCallingError bool `json:"tool_calling_error,omitempty"`
	ThinkingError    bool `json:"thinking_error,omitempty"`
	VisionError      bool `json:"vision_error,omitempty"`
}

func (c Caps) Clone() Caps {
	out := Caps{}
	if c.ContextLength != nil {
		v := *c.ContextLength
		out.ContextLength = &v
	}
	if c.MaxOutput != nil {
		v := *c.MaxOutput
		out.MaxOutput = &v
	}
	if c.ToolCalling != nil {
		v := *c.ToolCalling
		out.ToolCalling = &v
	}
	if c.Thinking != nil {
		v := *c.Thinking
		out.Thinking = &v
	}
	if c.Vision != nil {
		v := *c.Vision
		out.Vision = &v
	}
	out.ToolCallingError = c.ToolCallingError
	out.ThinkingError = c.ThinkingError
	out.VisionError = c.VisionError
	return out
}

// 渠道类型
const (
	ChannelOpenAI    = "openai"
	ChannelAnthropic = "anthropic"
	ChannelGemini    = "gemini"
)

// 渠道多 Key 路由模式
const (
	// KeyModeSequential 按配置顺序尝试：未开启亲和时始终从第一个可用 Key 开始；
	// 开启亲和后从上次成功 Key 的位置开始顺延。
	KeyModeSequential = "sequential"
	// KeyModeRandom 每次请求把可用 Key 完整洗牌后依次尝试。
	KeyModeRandom = "random"
)

// ChannelKey 一条上游 Key 及其备注。
type ChannelKey struct {
	Key  string `json:"key"`
	Note string `json:"note,omitempty"`
}

// Channel 一个上游渠道。
type Channel struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Type    string `json:"type"`
	BaseURL string `json:"base_url"`
	// APIKey 是 v1.7.0 及更早版本使用的单 Key 字段，仅用于读取已发布版本的旧数据。
	// 新数据使用 APIKeys；保存时会把第一个 Key 同步到这里，避免降级后读到过期配置。
	APIKey string   `json:"api_key,omitempty"`
	Models []string `json:"models"`
	// APIKeys 是渠道的多 Key 列表，Key 和备注分开保存。
	APIKeys []ChannelKey `json:"api_keys,omitempty"`
	// MultiKey 控制是否启用多 Key 模式。nil 表示旧数据未设置：
	// 只有一个 Key 时视为关闭，多个 Key 时视为开启，避免已有配置失效。
	MultiKey *bool `json:"multi_key,omitempty"`
	// KeyMode 是多个 Key 之间的调度方式：sequential（顺序）或 random（随机）。
	// 空值按顺序处理。
	KeyMode string `json:"key_mode,omitempty"`
	// KeyAffinity 开启后，上次成功使用的 Key 优先尝试：
	// 顺序模式从它的位置开始顺延，随机模式先试它、其余洗牌。
	KeyAffinity bool `json:"key_affinity,omitempty"`
	// KeyCooldownSec 是 Key 失败后的冷却时长（秒）。nil 表示旧数据未设置，
	// 按默认 300 秒；显式 0 表示不冷却。
	KeyCooldownSec *int `json:"key_cooldown_sec,omitempty"`
	// KeyCooldownReset 控制全部 Key 都在冷却中时是否自动清空冷却再调度一遍。
	KeyCooldownReset bool `json:"key_cooldown_reset,omitempty"`
	// KeyCooldownStatus 是触发 Key 冷却的上游状态码规则，支持单个状态码和区间，
	// 例如 "401,403,429,500-599"。nil 表示旧数据未设置，按默认规则；
	// 显式空字符串表示任何状态码都不冷却 Key（状态码仍会参与路由重试）。
	KeyCooldownStatus *string `json:"key_cooldown_status,omitempty"`
	// AppendV1 控制是否在接口地址后补全 /v1。nil 表示旧数据，按默认开启处理。
	// 关闭后按 BaseURL 原样拼接，适合火山方舟（/api/v3）这类非 v1 前缀的服务。
	AppendV1  *bool             `json:"append_v1,omitempty"`
	Headers   map[string]string `json:"headers,omitempty"`
	Enabled   bool              `json:"enabled"`
	Weight    int               `json:"weight"`
	Remark    string            `json:"remark,omitempty"`
	CreatedAt int64             `json:"created_at"`
	UpdatedAt int64             `json:"updated_at"`
}

// ShouldAppendV1 返回是否自动补全 /v1；旧数据未设置时默认开启。
func (c Channel) ShouldAppendV1() bool {
	return c.AppendV1 == nil || *c.AppendV1
}

// KeyCooldown 返回 Key 失败冷却时长。nil 表示旧数据未设置，按默认 300 秒；
// 显式 0 表示不冷却。
func (c Channel) KeyCooldown() time.Duration {
	if c.KeyCooldownSec == nil {
		return DefaultCooldownSec * time.Second
	}
	return time.Duration(*c.KeyCooldownSec) * time.Second
}

// KeyList 返回去重后的 Key 和备注列表，保持配置顺序。
// 新数据读 APIKeys；只有已发布版本的单 APIKey 时按一条无备注的 Key 处理。
func (c Channel) KeyList() []ChannelKey {
	out := make([]ChannelKey, 0, len(c.APIKeys)+1)
	seen := make(map[string]bool, len(c.APIKeys)+1)
	for _, item := range c.APIKeys {
		key := strings.TrimSpace(item.Key)
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, ChannelKey{Key: key, Note: strings.TrimSpace(item.Note)})
	}
	if len(out) > 0 {
		return out
	}
	if key := strings.TrimSpace(c.APIKey); key != "" {
		return []ChannelKey{{Key: key}}
	}
	return nil
}

// Keys 返回渠道配置的全部非空 Key。一个 Key 都没有时返回空字符串占位，
// 保持原有的「不带认证头」行为。
func (c Channel) Keys() []string {
	list := c.KeyList()
	if len(list) == 0 {
		return []string{""}
	}
	out := make([]string, 0, len(list))
	for _, item := range list {
		out = append(out, item.Key)
	}
	return out
}

// MultiKeyEnabled 返回是否启用多 Key 模式。旧数据未设置时按 Key 数量推断：
// 只有一个 Key（含单 Key 旧字段）视为关闭，多个 Key 视为开启。
func (c Channel) MultiKeyEnabled() bool {
	if c.MultiKey != nil {
		return *c.MultiKey
	}
	return len(c.KeyList()) > 1
}

// KeyModeOrDefault 返回生效的 Key 调度方式。
func (c Channel) KeyModeOrDefault() string {
	if c.KeyMode == KeyModeRandom {
		return KeyModeRandom
	}
	return KeyModeSequential
}

// WithKey 返回只使用指定 Key 的渠道副本，供上游认证使用。
func (c Channel) WithKey(key string) Channel {
	c.APIKey = key
	c.APIKeys = nil
	return c
}

// 模型类型
const (
	ModelTypeChannel = "channel"
	ModelTypeCustom  = "custom"
)

// Route 自定义模型的一条路由：指向某个渠道模型。
// Weight 只在同组路由里生效：按权重加权随机选首选，失败后组内顺延。
// Group 是组号：按配置顺序切分，连续相同 Group 的条目属于同一组（0 表示未分组）。
type Route struct {
	ChannelID string `json:"channel_id"`
	Upstream  string `json:"upstream"`
	Weight    int    `json:"weight,omitempty"`
	Group     int    `json:"group,omitempty"`
}

// Provider 模型提供商（厂商）。模型按 ProviderID 归类，广场按提供商筛选。
// Icon 可以是内置图标名（见前端 provider-icons.js）、图片直链或 emoji 文本。
// Match 是自动归属关键词：模型 ID 小写包含任一关键词即归入该提供商。
type Provider struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Icon      string   `json:"icon,omitempty"`
	Color     string   `json:"color,omitempty"`
	Match     []string `json:"match,omitempty"`
	Sort      int      `json:"sort"`
	Builtin   bool     `json:"builtin,omitempty"`
	CreatedAt int64    `json:"created_at"`
	UpdatedAt int64    `json:"updated_at"`
}

// Model 模型设置里的一条已配置模型。
// Type == channel 时：ChannelID + Upstream 指向唯一的渠道模型。
// Type == custom  时：Routes 是有序路由链，按组划分优先级、组内按权重选择。
type Model struct {
	ID         string  `json:"id"`
	Type       string  `json:"type"`
	ChannelID  string  `json:"channel_id,omitempty"`
	Upstream   string  `json:"upstream,omitempty"`
	Routes     []Route `json:"routes,omitempty"`
	ProviderID string  `json:"provider_id,omitempty"`
	Caps       Caps    `json:"caps"`
	Enabled    bool    `json:"enabled"`

	// Affinity 开启后：某条路由本次请求成功，下一次请求优先从它开始。
	// CooldownSec 是路由失败后的不可用冷却时长（秒）。nil 表示旧数据未设置，
	// 按默认 300 秒；显式 0 表示不冷却。
	// CooldownReset 控制「全部路由都在冷却中」时的行为：true 自动重置所有冷却再路由一遍，
	// false 直接返回不可用。
	Affinity      bool `json:"affinity,omitempty"`
	CooldownSec   *int `json:"cooldown_sec,omitempty"`
	CooldownReset bool `json:"cooldown_reset,omitempty"`

	// Timeout 是模型级超时（秒），0 表示默认 300。
	// 非流式为整次请求超时，流式为首字超时（首块数据到达后不再限时）。
	Timeout int `json:"timeout,omitempty"`

	// NoRetryStatus 是不可重试的上游状态码规则，支持单个状态码和区间，
	// 例如 "400-430,500"。命中后直接返回上游错误，不再尝试其它路由，
	// 也不记录 Key / 路由冷却。nil 表示旧数据未设置，按默认规则；
	// 显式空字符串表示所有状态码都可重试。
	NoRetryStatus *string `json:"no_retry_status,omitempty"`

	// 错误覆写。
	// ErrorEnabled 是总开关：关闭时以下配置均不生效。
	// ErrorAlways 开启后不请求上游，所有调用直接返回配置的错误；
	// 关闭时只在请求最终失败（上游错误、超时、无可用路由等）时用它替代原始错误。
	// ErrorStatus 是返回给调用方的状态码（400–599），ErrorMessage 是错误详情，
	// 为空时使用默认文案。
	// ErrorAsContent 开启后不按错误返回，而是把错误详情当成正常正文，
	// 以 HTTP 200 返回（流式请求按 SSE 输出）。此时 ErrorStatus 不再生效。
	// ErrorKeepNoRetry 开启后，命中 NoRetryStatus 的上游错误跳过覆写、原样返回；
	// 只在「失败时重写」模式下有意义，对「覆写为正文」同样生效，
	// 即命中规则的错误仍然是上游的原始错误，不会变成 200 正文。
	// nil 表示旧数据未设置，按默认开启处理；显式 false 表示关闭。
	ErrorEnabled     *bool  `json:"error_enabled,omitempty"`
	ErrorAlways      *bool  `json:"error_always,omitempty"`
	ErrorStatus      int    `json:"error_status,omitempty"`
	ErrorMessage     string `json:"error_message,omitempty"`
	ErrorAsContent   *bool  `json:"error_as_content,omitempty"`
	ErrorKeepNoRetry *bool  `json:"error_keep_no_retry,omitempty"`

	// 自定义内容返回。
	// ContentEnabled 开启后，所有调用都直接返回 ContentText，不再请求上游；
	// 优先级高于错误覆写，两者同时开启时错误配置不生效。
	// ContentReasoning 是可选的思考内容，为空时不输出思考字段。
	// ContentFirstByteMs / ContentSpeed / ContentLatencyMs 用于模拟响应耗时：
	// 首字等待（毫秒）、流式每秒输出字符数、非流式延迟（毫秒）。
	ContentEnabled     *bool  `json:"content_enabled,omitempty"`
	ContentText        string `json:"content_text,omitempty"`
	ContentReasoning   string `json:"content_reasoning,omitempty"`
	ContentFirstByteMs int    `json:"content_first_byte_ms,omitempty"`
	ContentSpeed       int    `json:"content_speed,omitempty"`
	ContentLatencyMs   int    `json:"content_latency_ms,omitempty"`

	// 思考覆写。
	// ThinkingOverrideOn 开启后，上游返回的思考内容会被替换为
	// ThinkingOverrideText；文本为空时直接隐藏思考内容（响应里不再出现思考字段）。
	// 正文、工具调用与用量统计不受影响。自定义内容返回优先级最高，开启后本项不生效。
	ThinkingOverrideOn   *bool  `json:"thinking_override_enabled,omitempty"`
	ThinkingOverrideText string `json:"thinking_override_text,omitempty"`

	// 系统提示词注入。
	// SystemPromptOn 开启后，请求里自带的系统提示词会被全部移除，
	// 只把 SystemPrompt 作为唯一的系统提示词放在最前面。
	SystemPromptOn *bool  `json:"system_prompt_enabled,omitempty"`
	SystemPrompt   string `json:"system_prompt,omitempty"`

	DisplayName string   `json:"display_name,omitempty"`
	Description string   `json:"description,omitempty"`
	Tags        []string `json:"tags,omitempty"`

	CreatedAt int64 `json:"created_at"`
	UpdatedAt int64 `json:"updated_at"`
}

// RouteCooldown 返回路由失败冷却时长，语义同 Channel.KeyCooldown。
func (m Model) RouteCooldown() time.Duration {
	if m.CooldownSec == nil {
		return DefaultCooldownSec * time.Second
	}
	return time.Duration(*m.CooldownSec) * time.Second
}

// RouteCooldownSec 返回秒数形式的有效冷却时长（nil 按默认 300，0 表示不冷却）。
func (m Model) RouteCooldownSec() int {
	if m.CooldownSec == nil {
		return DefaultCooldownSec
	}
	return *m.CooldownSec
}

// CustomErrorEnabled 返回错误覆写总开关。
func (m Model) CustomErrorEnabled() bool {
	return m.ErrorEnabled != nil && *m.ErrorEnabled
}

// CustomErrorAlways 返回是否始终返回覆写结果。总开关关闭时永远为 false。
func (m Model) CustomErrorAlways() bool {
	return m.CustomErrorEnabled() && m.ErrorAlways != nil && *m.ErrorAlways
}

// ErrorKeepNoRetryOn 返回配置值，未设置时默认开启。
func (m Model) ErrorKeepNoRetryOn() bool {
	return m.ErrorKeepNoRetry == nil || *m.ErrorKeepNoRetry
}

// CustomErrorAsContent 返回错误是否覆写为正文（HTTP 200）。总开关关闭时永远为 false。
func (m Model) CustomErrorAsContent() bool {
	return m.CustomErrorEnabled() && m.ErrorAsContent != nil && *m.ErrorAsContent
}

// CustomErrorKeepNoRetry 返回命中不可重试状态码时是否跳过覆写、保留上游原始错误。
func (m Model) CustomErrorKeepNoRetry() bool {
	return m.CustomErrorEnabled() && m.ErrorKeepNoRetryOn()
}

// CustomContentEnabled 返回自定义内容返回总开关。
func (m Model) CustomContentEnabled() bool {
	return m.ContentEnabled != nil && *m.ContentEnabled
}

// ThinkingOverrideEnabled 返回思考覆写总开关。
func (m Model) ThinkingOverrideEnabled() bool {
	return m.ThinkingOverrideOn != nil && *m.ThinkingOverrideOn
}

// SystemPromptEnabled 返回系统提示词注入总开关。
func (m Model) SystemPromptEnabled() bool {
	return m.SystemPromptOn != nil && *m.SystemPromptOn
}

// Token 调用方使用的 API Key。
type Token struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Key           string   `json:"key"`
	Enabled       bool     `json:"enabled"`
	ExpiresAt     int64    `json:"expires_at"` // 0 表示永不过期（毫秒）
	QuotaLimit    int64    `json:"quota_limit"`
	UsedQuota     int64    `json:"used_quota"`
	AllowedModels []string `json:"allowed_models,omitempty"`
	// AllowedIPs 是允许调用该密钥的来源 IP 白名单。为空表示不限制；
	// 支持单个 IP、CIDR 网段、IPv4 尾部通配（如 192.168.1.*）和 "*"。
	AllowedIPs []string `json:"allowed_ips,omitempty"`
	Remark     string   `json:"remark,omitempty"`
	CreatedAt  int64    `json:"created_at"`
	UpdatedAt  int64    `json:"updated_at"`
	LastUsedAt int64    `json:"last_used_at"`
}

// LogAttempt 是一次路由尝试的明细。只在请求发生过重试时记录，
// 用来还原「先打了哪条路由、报了什么错、最后落到哪条」。
type LogAttempt struct {
	ChannelID     string `json:"channel_id"`
	ChannelName   string `json:"channel_name,omitempty"`
	UpstreamModel string `json:"upstream_model"`
	// KeyIndex/KeyMasked 表示本次尝试使用的上游 Key（从 1 开始，掩码展示）。
	// KeyNote 是 Key 的备注，用于在分层重试历史里区分同一渠道的多个 Key。
	// 单 Key 渠道不记录，避免给旧日志增加无意义字段。
	KeyIndex  int    `json:"key_index,omitempty"`
	KeyMasked string `json:"key_masked,omitempty"`
	KeyNote   string `json:"key_note,omitempty"`
	// KeyAffinity 表示这次尝试的 Key 是上次成功的 Key、因 Key 亲和被优先尝试。
	KeyAffinity bool   `json:"key_affinity,omitempty"`
	StatusCode  int    `json:"status_code"`
	LatencyMs   int64  `json:"latency_ms"`
	Error       string `json:"error,omitempty"`
}

// Log 一次请求日志。
type Log struct {
	ID            string `json:"id"`
	Time          int64  `json:"time"`
	TokenID       string `json:"token_id"`
	TokenName     string `json:"token_name"`
	ModelID       string `json:"model_id"`
	ChannelID     string `json:"channel_id"`
	ChannelName   string `json:"channel_name,omitempty"`
	UpstreamModel string `json:"upstream_model"`
	Endpoint      string `json:"endpoint"`
	// KeyIndex/KeyMasked/KeyNote 是最终尝试使用的上游 Key；单 Key 渠道为空。
	KeyIndex  int    `json:"key_index,omitempty"`
	KeyMasked string `json:"key_masked,omitempty"`
	KeyNote   string `json:"key_note,omitempty"`
	// KeyAffinity 表示最终尝试使用的 Key 命中了 Key 亲和。
	KeyAffinity      bool `json:"key_affinity,omitempty"`
	PromptTokens     int  `json:"prompt_tokens"`
	CompletionTokens int  `json:"completion_tokens"`
	TotalTokens      int  `json:"total_tokens"`
	// UsageEstimate 表示 token 用量是网关估算的（上游没有上报），前端会标注「估算」。
	UsageEstimate bool  `json:"usage_estimate,omitempty"`
	LatencyMs     int64 `json:"latency_ms"`
	FirstByteMs   int64 `json:"first_byte_ms"`
	StatusCode    int   `json:"status_code"`
	// Error 是内部失败原因，可能包含渠道、上游地址等细节，只用于后台排查。
	Error string `json:"error,omitempty"`
	// ClientError 是实际返回给调用方的错误内容。网关对外会收敛成笼统提示，
	// 上游错误则原样透传；没有响应体（如流式中断、客户端取消）时为空。
	ClientError string `json:"client_error,omitempty"`
	Stream      bool   `json:"stream"`
	Retries     int    `json:"retries"`
	IP          string `json:"ip"`

	// Attempts 是本次请求的每次路由尝试，仅在重试过（尝试次数 > 1）时记录。
	Attempts []LogAttempt `json:"attempts,omitempty"`

	// Affinity 表示本次请求命中了模型亲和：上次成功的路由被优先尝试。
	Affinity bool `json:"affinity,omitempty"`

	// ReasoningChars 是本次响应里思考内容的字符数，模型没输出思考时为 0。
	ReasoningChars int `json:"reasoning_chars,omitempty"`
	// ReasoningTokens 是上游单独上报的思考 token 数，未上报时为 0。
	ReasoningTokens int `json:"reasoning_tokens,omitempty"`
	// CachedTokens 是输入里命中提示词缓存的部分，未上报时为 0。
	CachedTokens int `json:"cached_tokens,omitempty"`
	// TokensPerSec 是流式请求的输出速度，按「生成耗时」而非总耗时计算。
	TokensPerSec float64 `json:"tokens_per_sec,omitempty"`
	// Canceled 表示客户端主动断开（在线聊天点「停止」等），不计入错误统计。
	Canceled bool `json:"canceled,omitempty"`
}

// ModelRecent 是某个模型最近若干次调用的结果。
type ModelRecent struct {
	Requests int64 `json:"requests"`
	Errors   int64 `json:"errors"`
}

// Bucket 按小时聚合的统计。
type Bucket struct {
	Hour             int64 `json:"hour"`
	Requests         int64 `json:"requests"`
	Errors           int64 `json:"errors"`
	PromptTokens     int64 `json:"prompt_tokens"`
	CompletionTokens int64 `json:"completion_tokens"`
	TotalTokens      int64 `json:"total_tokens"`
	LatencySum       int64 `json:"latency_sum"`
	// 以下字段只统计同时有首字耗时、总耗时和输出速度的记录（流式且有输出），
	// 用于数据看板的「平均速度」指标。
	SpeedCount        int64            `json:"speed_count"`
	SpeedSum          float64          `json:"speed_sum"`
	SpeedLatencySum   int64            `json:"speed_latency_sum"`
	SpeedFirstByteSum int64            `json:"speed_first_byte_sum"`
	ModelCounts       map[string]int64 `json:"model_counts"`
	ModelErrors       map[string]int64 `json:"model_errors,omitempty"`
	ChannelCounts     map[string]int64 `json:"channel_counts"`
	TokenCounts       map[string]int64 `json:"token_counts"`
}

// Settings 系统设置。
type Settings struct {
	SiteName     string `json:"site_name"`
	SiteSubtitle string `json:"site_subtitle"`
	// Logo 是站点图标的地址，可以填任意直链（http/https/data URI）；
	// 留空则使用内置的默认图标。
	Logo             string `json:"logo"`
	Theme            string `json:"theme"` // light | dark
	PrimaryColor     string `json:"primary_color"`
	LogRetentionDays int    `json:"log_retention_days"`
	RootPasswordHash string `json:"root_password_hash"`
	RootPasswordSalt string `json:"root_password_salt"`
	AllowOrigins     string `json:"allow_origins"`
}

// ChannelModel 是渠道 + 模型名派生出来的“渠道模型”视图，不作为独立实体存储。
type ChannelModel struct {
	ID        string `json:"id"` // channelID + "/" + upstream
	ChannelID string `json:"channel_id"`
	Upstream  string `json:"upstream"`
}

func NewChannelModel(channelID, upstream string) ChannelModel {
	return ChannelModel{ID: channelID + "/" + upstream, ChannelID: channelID, Upstream: upstream}
}
