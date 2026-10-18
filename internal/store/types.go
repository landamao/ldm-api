package store

// Caps 描述一个模型的能力参数。所有字段都是可空的：
// nil 表示“从上游透传”（不做任何改写，由上游自己决定）。
type Caps struct {
	ContextLength *int  `json:"context_length,omitempty"`
	MaxOutput     *int  `json:"max_output,omitempty"`
	ToolCalling   *bool `json:"tool_calling,omitempty"`
	Thinking      *bool `json:"thinking,omitempty"`
	Vision        *bool `json:"vision,omitempty"`
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
	return out
}

// 渠道类型
const (
	ChannelOpenAI    = "openai"
	ChannelAnthropic = "anthropic"
	ChannelGemini    = "gemini"
)

// Channel 一个上游渠道。
type Channel struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Type      string            `json:"type"`
	BaseURL   string            `json:"base_url"`
	APIKey    string            `json:"api_key"`
	Models    []string          `json:"models"`
	Headers   map[string]string `json:"headers,omitempty"`
	Enabled   bool              `json:"enabled"`
	Weight    int               `json:"weight"`
	Timeout   int               `json:"timeout"` // 秒，0 表示默认 300
	Remark    string            `json:"remark,omitempty"`
	CreatedAt int64             `json:"created_at"`
	UpdatedAt int64             `json:"updated_at"`
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
	ID          string  `json:"id"`
	Type        string  `json:"type"`
	ChannelID   string  `json:"channel_id,omitempty"`
	Upstream    string  `json:"upstream,omitempty"`
	Routes      []Route `json:"routes,omitempty"`
	ParamSource string  `json:"param_source,omitempty"` // "" 表示使用自身 Caps，否则继承该模型 ID 的 Caps
	ProviderID  string  `json:"provider_id,omitempty"`
	Caps        Caps    `json:"caps"`
	Enabled     bool    `json:"enabled"`

	// Affinity 开启后：某条路由本次请求成功，下一次请求优先从它开始。
	// CooldownSec 是路由失败后的不可用冷却时长（秒），0 表示默认 300。
	// CooldownReset 控制「全部路由都在冷却中」时的行为：true 自动重置所有冷却再路由一遍，
	// false 直接返回不可用。
	Affinity      bool `json:"affinity,omitempty"`
	CooldownSec   int  `json:"cooldown_sec,omitempty"`
	CooldownReset bool `json:"cooldown_reset,omitempty"`

	DisplayName string   `json:"display_name,omitempty"`
	Description string   `json:"description,omitempty"`
	Tags        []string `json:"tags,omitempty"`

	CreatedAt int64 `json:"created_at"`
	UpdatedAt int64 `json:"updated_at"`
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
	Remark        string   `json:"remark,omitempty"`
	CreatedAt     int64    `json:"created_at"`
	UpdatedAt     int64    `json:"updated_at"`
	LastUsedAt    int64    `json:"last_used_at"`
}

// LogAttempt 是一次路由尝试的明细。只在请求发生过重试时记录，
// 用来还原「先打了哪条路由、报了什么错、最后落到哪条」。
type LogAttempt struct {
	ChannelID     string `json:"channel_id"`
	ChannelName   string `json:"channel_name,omitempty"`
	UpstreamModel string `json:"upstream_model"`
	StatusCode    int    `json:"status_code"`
	LatencyMs     int64  `json:"latency_ms"`
	Error         string `json:"error,omitempty"`
}

// Log 一次请求日志。
type Log struct {
	ID               string `json:"id"`
	Time             int64  `json:"time"`
	TokenID          string `json:"token_id"`
	TokenName        string `json:"token_name"`
	ModelID          string `json:"model_id"`
	ChannelID        string `json:"channel_id"`
	UpstreamModel    string `json:"upstream_model"`
	Endpoint         string `json:"endpoint"`
	PromptTokens     int    `json:"prompt_tokens"`
	CompletionTokens int    `json:"completion_tokens"`
	TotalTokens      int    `json:"total_tokens"`
	LatencyMs        int64  `json:"latency_ms"`
	FirstByteMs      int64  `json:"first_byte_ms"`
	StatusCode       int    `json:"status_code"`
	Error            string `json:"error,omitempty"`
	Stream           bool   `json:"stream"`
	Retries          int    `json:"retries"`
	IP               string `json:"ip"`

	// Attempts 是本次请求的每次路由尝试，仅在重试过（尝试次数 > 1）时记录。
	Attempts []LogAttempt `json:"attempts,omitempty"`

	// ReasoningChars 是本次响应里思考内容的字符数，模型没输出思考时为 0。
	ReasoningChars int `json:"reasoning_chars,omitempty"`
	// ReasoningTokens 是上游单独上报的思考 token 数，未上报时为 0。
	ReasoningTokens int `json:"reasoning_tokens,omitempty"`
	// CachedTokens 是输入里命中提示词缓存的部分，未上报时为 0。
	CachedTokens int `json:"cached_tokens,omitempty"`
	// TokensPerSec 是流式请求的输出速度，按「生成耗时」而非总耗时计算。
	TokensPerSec float64 `json:"tokens_per_sec,omitempty"`
	// Canceled 表示客户端主动断开（在线对话点「停止」等），不计入错误统计。
	Canceled bool `json:"canceled,omitempty"`
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
