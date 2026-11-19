/* ==========================================================================
   预览演示数据
   —— 字段名、层级、派生状态全部照抄真实接口：
      /api/channels、/api/models、/api/providers、/api/tokens、/api/plaza、
      /api/logs、/api/stats/*。
      这样预览里定稿的交互，搬到正式前端时只需要把 mock 换成 API.get。
   ========================================================================== */
(function () {
  'use strict';

  // 预览数据固定到「今天 20:12」，保证首次打开就能看到一整天的曲线；
  // 正式页面当然用真实时钟，这里只是让演示数据有足够的形状。
  const NOW = (() => {
    const d = new Date();
    d.setHours(20, 12, 0, 0);
    return d.getTime();
  })();
  const MIN = 60000;
  const HOUR = 3600000;
  const DAY = 86400000;

  let seed = 20261120;
  function rnd() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));

  // ---------- 提供商（与内置一致的 12 个） ----------
  const providers = [
    { id: 'zhipu', name: '智谱', icon: 'zhipu', color: '#3859ff', match: ['glm'], sort: 1, builtin: true, model_count: 0 },
    { id: 'deepseek', name: 'DeepSeek', icon: 'deepseek', color: '#4d6bfe', match: ['deepseek'], sort: 2, builtin: true, model_count: 0 },
    { id: 'xai', name: 'xAI', icon: 'xai', color: '#111111', match: ['grok'], sort: 3, builtin: true, model_count: 0 },
    { id: 'openai', name: 'OpenAI', icon: 'openai', color: '#10a37f', match: ['gpt'], sort: 4, builtin: true, model_count: 0 },
    { id: 'stepfun', name: '阶跃星辰', icon: 'stepfun', color: '#1a73e8', match: ['step'], sort: 5, builtin: true, model_count: 0 },
    { id: 'bytedance', name: '字节跳动', icon: 'bytedance', color: '#1664ff', match: ['doubao'], sort: 6, builtin: true, model_count: 0 },
    { id: 'xiaomi', name: '小米', icon: 'xiaomi', color: '#ff6900', match: ['mimo'], sort: 7, builtin: true, model_count: 0 },
    { id: 'minimax', name: 'MiniMax', icon: 'minimax', color: '#fe5b4b', match: ['minimax'], sort: 8, builtin: true, model_count: 0 },
    { id: 'google', name: 'Google', icon: 'google', color: '#4285f4', match: ['gemini'], sort: 9, builtin: true, model_count: 0 },
    { id: 'anthropic', name: 'Anthropic', icon: 'anthropic', color: '#d97757', match: ['claude'], sort: 10, builtin: true, model_count: 0 },
    { id: 'moonshot', name: '月之暗面', icon: 'moonshot', color: '#1f1f1f', match: ['kimi'], sort: 11, builtin: true, model_count: 0 },
    { id: 'alibaba', name: '阿里巴巴', icon: 'alibaba', color: '#ff6a00', match: ['qwen'], sort: 12, builtin: true, model_count: 0 },
  ];

  function matchProvider(name) {
    const lower = String(name || '').toLowerCase();
    for (const p of providers) {
      if ((p.match || []).some((k) => lower.includes(String(k).toLowerCase()))) return p.id;
    }
    return '';
  }
  const provider = (id) => providers.find((p) => p.id === id) || null;

  // ---------- 渠道 ----------
  // 字段与 GET /api/channels 的 channelView 对齐
  const channels = [
    {
      id: 'ch-main', name: '主力 OpenAI', type: 'openai', base_url: 'https://api.openai.com/v1',
      proxy_url: '', enabled: true, remark: '主账号，走官方直连',
      models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'text-embedding-3-large'],
      multi_key_enabled: true, key_mode: 'sequential', key_affinity: true,
      key_rows: [
        { index: 0, masked: 'sk-p****9f2a', note: '主账号' },
        { index: 1, masked: 'sk-p****71cd', note: '备用额度' },
      ],
      key_cooldown_sec: 300, key_cooldown_reset: true, key_cooldown_status: '401,403,429,500-599',
      append_v1: true, headers: {}, body_edits: [],
      created_at: NOW - 42 * DAY, updated_at: NOW - 2 * HOUR,
    },
    {
      id: 'ch-ds', name: 'DeepSeek 官转', type: 'openai', base_url: 'https://api.deepseek.com',
      proxy_url: '', enabled: true, remark: '',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      multi_key_enabled: false, key_mode: 'sequential', key_affinity: false,
      key_rows: [{ index: 0, masked: 'sk-d****3b81', note: '' }],
      key_cooldown_sec: 300, key_cooldown_reset: false, key_cooldown_status: '401,403,429,500-599',
      append_v1: true, headers: {}, body_edits: [],
      created_at: NOW - 35 * DAY, updated_at: NOW - 3 * DAY,
    },
    {
      id: 'ch-claude', name: 'Claude 直连', type: 'anthropic', base_url: 'https://api.anthropic.com',
      proxy_url: 'http://127.0.0.1:7890', enabled: true, remark: '走本地代理',
      models: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
      multi_key_enabled: false, key_mode: 'sequential', key_affinity: false,
      key_rows: [{ index: 0, masked: 'sk-a****41e9', note: '' }],
      key_cooldown_sec: 300, key_cooldown_reset: false, key_cooldown_status: '401,403,429,500-599',
      append_v1: true, headers: {}, body_edits: [],
      created_at: NOW - 28 * DAY, updated_at: NOW - 5 * DAY,
    },
    {
      id: 'ch-gemini', name: 'Gemini 备用', type: 'gemini', base_url: 'https://generativelanguage.googleapis.com',
      proxy_url: '', enabled: true, remark: '',
      models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
      multi_key_enabled: false, key_mode: 'random', key_affinity: false,
      key_rows: [{ index: 0, masked: 'AIz****kQ2w', note: '' }],
      key_cooldown_sec: 120, key_cooldown_reset: true, key_cooldown_status: '429,500-599',
      append_v1: false, headers: {}, body_edits: [],
      created_at: NOW - 21 * DAY, updated_at: NOW - 9 * DAY,
    },
    {
      id: 'ch-kimi', name: '月之暗面', type: 'openai', base_url: 'https://api.moonshot.cn/v1',
      proxy_url: '', enabled: false, remark: '额度用完，暂时停用',
      models: ['kimi-k2', 'kimi-latest'],
      multi_key_enabled: false, key_mode: 'sequential', key_affinity: false,
      key_rows: [{ index: 0, masked: 'sk-m****88aa', note: '' }],
      key_cooldown_sec: 300, key_cooldown_reset: false, key_cooldown_status: '',
      append_v1: true, headers: {}, body_edits: [],
      created_at: NOW - 18 * DAY, updated_at: NOW - 6 * DAY,
    },
    {
      id: 'ch-local', name: '本地 Ollama', type: 'openai', base_url: 'http://127.0.0.1:11434/v1',
      proxy_url: '', enabled: true, remark: '局域网机器，跑小模型',
      models: ['qwen3:32b', 'llama3.3:70b'],
      multi_key_enabled: false, key_mode: 'sequential', key_affinity: false,
      key_rows: [{ index: 0, masked: '****', note: '' }],
      key_cooldown_sec: 0, key_cooldown_reset: false, key_cooldown_status: '',
      append_v1: false, headers: {}, body_edits: [],
      created_at: NOW - 12 * DAY, updated_at: NOW - 12 * HOUR,
    },
  ];

  const channel = (id) => channels.find((c) => c.id === id) || null;

  // 渠道模型 ID：渠道ID/上游模型名
  channels.forEach((c) => {
    c.channel_models = c.models.map((m) => c.id + '/' + m);
  });

  // ---------- 模型 ----------
  const CAPS = {
    'gpt-4o': { context_length: 128000, max_output: 16384, tool_calling: true, thinking: false, vision: true },
    'gpt-4o-mini': { context_length: 128000, max_output: 16384, tool_calling: true, thinking: false, vision: true },
    'o3-mini': { context_length: 200000, max_output: 100000, tool_calling: true, thinking: true, vision: false },
    'text-embedding-3-large': { context_length: 8191, max_output: 0, tool_calling: false, vision: false },
    'deepseek-chat': { context_length: 128000, max_output: 8192, tool_calling: true, thinking: false, vision: false },
    'deepseek-reasoner': { context_length: 128000, max_output: 65536, tool_calling: false, thinking: true, vision: false },
    'claude-sonnet-4-5': { context_length: 200000, max_output: 64000, tool_calling: true, thinking: true, vision: true },
    'claude-haiku-4-5': { context_length: 200000, max_output: 32000, tool_calling: true, thinking: true, vision: true },
    'gemini-2.5-pro': { context_length: 1048576, max_output: 65536, tool_calling: true, thinking: true, vision: true },
    'gemini-2.5-flash': { context_length: 1048576, max_output: 65536, tool_calling: true, thinking: true, vision: true },
    'kimi-k2': { context_length: 128000, max_output: 16384, tool_calling: true, thinking: false, vision: false },
    'kimi-latest': { context_length: 128000, max_output: 8192, tool_calling: true, thinking: false, vision: true },
    'qwen3:32b': { context_length: 32768, max_output: 8192, tool_calling: true, thinking: true, vision: false },
    'llama3.3:70b': { context_length: 131072, max_output: 8192, tool_calling: true, thinking: false, vision: false },
  };

  const models = [];

  // 已接入的渠道模型（渠道模型 ID 由渠道/上游派生，不可改）
  const addedChannelModels = [
    ['ch-main', 'gpt-4o', { description: '通用旗舰，工具调用与图片输入都支持', tags: ['旗舰', '稳定'] }],
    ['ch-main', 'gpt-4o-mini', { description: '便宜快，适合高并发的小任务' }],
    ['ch-main', 'o3-mini', { description: '推理模型，适合数学与代码', tags: ['推理'] }],
    ['ch-ds', 'deepseek-chat'],
    ['ch-ds', 'deepseek-reasoner', { description: '深度思考，输出较长' }],
    ['ch-claude', 'claude-sonnet-4-5', { description: '长上下文写作与代码' }],
    ['ch-gemini', 'gemini-2.5-pro'],
    ['ch-gemini', 'gemini-2.5-flash', { description: '超长上下文，响应快' }],
  ];

  addedChannelModels.forEach(([cid, upstream, extra], i) => {
    const p = provider(matchProvider(upstream));
    models.push(Object.assign({
      id: cid + '/' + upstream,
      type: 'channel',
      channel_id: cid,
      upstream,
      provider_id: p ? p.id : '',
      caps: CAPS[upstream] || {},
      enabled: true,
      timeout: 300,
      force_stream: upstream === 'deepseek-reasoner',
      no_retry_status: '',
      content_enabled: false,
      thinking_override_enabled: false,
      system_prompt_enabled: false,
      error_enabled: false,
      error_always: false,
      error_status: 0,
      error_message: '',
      error_as_content: false,
      error_keep_no_retry: true,
      display_name: '',
      description: '',
      tags: [],
      created_at: NOW - (30 - i) * DAY,
      updated_at: NOW - i * HOUR,
    }, extra));
  });

  // 自定义模型：路由系统
  models.push({
    id: 'LDM', type: 'custom', routes: [
      { channel_id: 'ch-main', upstream: 'gpt-4o', weight: 70, group: 1 },
      { channel_id: 'ch-ds', upstream: 'deepseek-chat', weight: 30, group: 1 },
      { channel_id: 'ch-claude', upstream: 'claude-sonnet-4-5' },
    ],
    provider_id: 'openai', caps: { context_length: 200000, max_output: 16384, tool_calling: true, thinking: true, vision: true },
    enabled: true, affinity: true, cooldown_sec: 300, cooldown_reset: false,
    timeout: 300, force_stream: false, no_retry_status: '',
    content_enabled: false, thinking_override_enabled: false, system_prompt_enabled: false,
    error_enabled: false, error_always: false, error_status: 0, error_message: '', error_as_content: false, error_keep_no_retry: true,
    display_name: '懒大猫主路由', description: '日常默认：主力渠道优先，失败自动切 DeepSeek 和 Claude。',
    tags: ['默认', '多路由'], created_at: NOW - 40 * DAY, updated_at: NOW - 2 * HOUR,
  });

  models.push({
    id: 'fast', type: 'custom', routes: [
      { channel_id: 'ch-main', upstream: 'gpt-4o-mini' },
      { channel_id: 'ch-gemini', upstream: 'gemini-2.5-flash' },
    ],
    provider_id: 'openai', caps: { context_length: 128000, max_output: 16384, tool_calling: true, vision: true },
    enabled: true, affinity: false, cooldown_sec: 120, cooldown_reset: true,
    timeout: 120, force_stream: false, no_retry_status: '400-428,430-499',
    content_enabled: false, thinking_override_enabled: false, system_prompt_enabled: false,
    error_enabled: false, error_always: false, error_status: 0, error_message: '', error_as_content: false, error_keep_no_retry: true,
    display_name: '极速通道', description: '两个便宜小模型兜底，优先保证响应速度。',
    tags: ['低延迟', '便宜'], created_at: NOW - 26 * DAY, updated_at: NOW - DAY,
  });

  models.push({
    id: 'claude-pro', type: 'custom', routes: [
      { channel_id: 'ch-claude', upstream: 'claude-sonnet-4-5' },
      { channel_id: 'ch-gemini', upstream: 'gemini-2.5-pro' },
    ],
    provider_id: 'anthropic', caps: { context_length: 1000000, max_output: 64000, tool_calling: true, thinking: true, vision: true },
    enabled: true, affinity: true, cooldown_sec: 300, cooldown_reset: false,
    timeout: 600, force_stream: true, no_retry_status: '',
    content_enabled: false, thinking_override_enabled: false, system_prompt_enabled: false,
    error_enabled: false, error_always: false, error_status: 0, error_message: '', error_as_content: false, error_keep_no_retry: true,
    display_name: '长文双备', description: 'Claude 与 Gemini Pro 互备，适合长文档。',
    tags: ['长上下文'], created_at: NOW - 15 * DAY, updated_at: NOW - 4 * HOUR,
  });

  models.push({
    id: 'vision-lab', type: 'custom', routes: [
      { channel_id: 'ch-gemini', upstream: 'gemini-2.5-pro' },
    ],
    provider_id: 'google', caps: { context_length: 1048576, max_output: 65536, tool_calling: true, thinking: true, vision: true },
    enabled: true, affinity: false, cooldown_sec: 300, cooldown_reset: false,
    timeout: 300, force_stream: false, no_retry_status: '',
    content_enabled: false, thinking_override_enabled: false, system_prompt_enabled: false,
    error_enabled: false, error_always: false, error_status: 0, error_message: '', error_as_content: false, error_keep_no_retry: true,
    display_name: '', description: '图片理解测试用，单路由。',
    tags: [], created_at: NOW - 9 * DAY, updated_at: NOW - 2 * DAY,
  });

  models.push({
    id: 'kimi-draft', type: 'custom', routes: [],
    provider_id: 'moonshot', caps: {},
    enabled: false, affinity: true, cooldown_sec: 300, cooldown_reset: false,
    timeout: 300, force_stream: false, no_retry_status: '',
    content_enabled: false, thinking_override_enabled: false, system_prompt_enabled: false,
    error_enabled: false, error_always: false, error_status: 0, error_message: '', error_as_content: false, error_keep_no_retry: true,
    display_name: '', description: '', tags: ['草稿'], created_at: NOW - 2 * DAY, updated_at: NOW - 2 * DAY,
  });

  const model = (id) => models.find((m) => m.id === id) || null;

  // ---------- 派生视图（与后端 listModels / plaza 的字段一致） ----------
  function routeState(channelId, upstream) {
    const c = channel(channelId);
    if (!c) return { ready: false, status: 'channel_missing' };
    if (!c.enabled) return { ready: false, status: 'channel_disabled' };
    if (!c.models.includes(upstream)) return { ready: false, status: 'model_missing' };
    return { ready: true, status: 'ok' };
  }

  function enrichModel(m) {
    const p = provider(m.provider_id);
    const out = Object.assign({}, m, {
      provider_name: p ? p.name : '',
      provider_icon: p ? p.icon : '',
      provider_color: p ? p.color : '',
    });
    if (m.type === 'channel') {
      const c = channel(m.channel_id);
      const r = routeState(m.channel_id, m.upstream);
      out.channel_name = c ? c.name : '';
      out.channel_type = c ? c.type : '';
      out.channel_ready = r.ready && m.enabled;
      out.status = !m.enabled ? 'disabled' : r.status;
    } else {
      const routes = (m.routes || []).map((r) => {
        const c = channel(r.channel_id);
        const st = routeState(r.channel_id, r.upstream);
        return Object.assign({}, r, {
          model_id: r.channel_id + '/' + r.upstream,
          channel_name: c ? c.name : '',
          channel_ready: st.ready,
          status: st.status,
          upstream_model: r.upstream,
        });
      });
      out.routes = routes;
      out.channel_ready = routes.some((r) => r.channel_ready);
      let status = 'ok';
      if (!routes.length) status = 'no_routes';
      else if (!out.channel_ready) status = 'unavailable';
      if (!m.enabled) status = 'disabled';
      if (m.enabled && m.content_enabled) status = 'custom_content';
      else if (m.enabled && m.error_enabled && m.error_always) status = 'custom_error';
      out.status = status;
    }
    return out;
  }

  const modelsView = () => models.map(enrichModel);

  // 提供商模型数
  providers.forEach((p) => {
    p.model_count = models.filter((m) => m.provider_id === p.id).length;
  });

  // 渠道已接入数量
  channels.forEach((c) => {
    c.added_count = models.filter((m) => m.type === 'channel' && m.channel_id === c.id).length;
  });

  // ---------- 模型广场 ----------
  function plazaItems() {
    const out = [];
    modelsView().forEach((m) => {
      const available = m.enabled && (m.type === 'channel' ? m.channel_ready : (m.channel_ready || m.content_enabled));
      let source = '';
      if (m.type === 'channel') {
        const c = channel(m.channel_id);
        source = c ? `${c.id}（${c.name}）` : m.channel_id;
      } else {
        source = (m.routes || []).length
          ? m.routes.map((r) => r.model_id).join(' → ')
          : (m.content_enabled ? '自定义内容返回' : '自定义路由 · 未配置目标');
      }
      const traffic = trafficFor(m.id);
      out.push({
        id: m.id, type: m.type, display_name: m.display_name || '', description: m.description || '',
        tags: m.tags || [], caps: m.caps || {}, available, status: m.status, source,
        upstream: m.upstream || '', channel_type: m.channel_type || '',
        provider_id: m.provider_id || '', provider_name: m.provider_name || '',
        provider_icon: m.provider_icon || '', provider_color: m.provider_color || '',
        routes: m.routes || [], affinity: !!m.affinity, cooldown_sec: m.cooldown_sec == null ? 300 : m.cooldown_sec,
        cooldown_reset: !!m.cooldown_reset,
        requests_24h: traffic.requests24h, errors_24h: traffic.errors24h, success_rate: traffic.rate24h,
        requests_200: traffic.requests200, errors_200: traffic.errors200, success_rate_200: traffic.rate200,
      });
    });
    return out;
  }

  // ---------- 令牌 ----------
  const tokens = [
    {
      id: 'tk_8f21c3a0', name: '主力应用', key: 'sk-ldm-3f8a91c4d2e74b0fa6c15d8e9b2047f3a6c8d1e2',
      enabled: true, expires_at: 0, quota_limit: 500000000, used_quota: 184320000,
      allowed_models: [], allowed_ips: ['192.168.1.0/24'], remark: '公司内网的主力业务',
      created_at: NOW - 30 * DAY, updated_at: NOW - 2 * DAY, last_used_at: NOW - 8 * MIN, expired: false, used_pct: 37,
    },
    {
      id: 'tk_2b7d90ee', name: '手机客户端', key: 'sk-ldm-9a2c47e1b6d803f5a1e9c2b7d4f60a83c5e1b9d7',
      enabled: true, expires_at: 0, quota_limit: 0, used_quota: 2340000,
      allowed_models: ['LDM', 'fast', 'claude*'], allowed_ips: [], remark: '',
      created_at: NOW - 12 * DAY, updated_at: NOW - 3 * DAY, last_used_at: NOW - 2 * HOUR, expired: false, used_pct: 0,
    },
    {
      id: 'tk_5c13af70', name: '临时测试', key: 'sk-ldm-64b0f3e9a1d7c28540e6b9d2f8a3c7e15b0d9f42',
      enabled: false, expires_at: NOW - 2 * DAY, quota_limit: 1000000, used_quota: 998000,
      allowed_models: ['LDM'], allowed_ips: ['203.0.113.7'], remark: '给朋友试用的，已经到期',
      created_at: NOW - 8 * DAY, updated_at: NOW - 2 * DAY, last_used_at: NOW - 3 * DAY, expired: true, used_pct: 99.8,
    },
    {
      id: 'tk_a0e47d19', name: '日志归档任务', key: 'sk-ldm-c7e2a1f89b3d6045e8a2c1b7f9d3405c6a8e2b71',
      enabled: true, expires_at: NOW + 180 * DAY, quota_limit: 20000000, used_quota: 3210000,
      allowed_models: ['fast'], allowed_ips: [], remark: '每天凌晨跑一次摘要',
      created_at: NOW - 20 * DAY, updated_at: NOW - 20 * DAY, last_used_at: NOW - 26 * HOUR, expired: false, used_pct: 16,
    },
  ];

  // ---------- 调用日志 + 统计 ----------
  // 用同一批日志喂看板、渠道用量和日志页，三个页面口径能对得上。
  const trafficModels = [
    { id: 'LDM', weight: 26, via: ['ch-main/gpt-4o', 'ch-main/gpt-4o', 'ch-ds/deepseek-chat', 'ch-claude/claude-sonnet-4-5'] },
    { id: 'fast', weight: 17, via: ['ch-main/gpt-4o-mini', 'ch-gemini/gemini-2.5-flash'] },
    { id: 'claude-pro', weight: 8, via: ['ch-claude/claude-sonnet-4-5', 'ch-gemini/gemini-2.5-pro'] },
    { id: 'vision-lab', weight: 3, via: ['ch-gemini/gemini-2.5-pro'] },
    { id: 'ch-main/gpt-4o', weight: 16, via: ['ch-main/gpt-4o'] },
    { id: 'ch-main/o3-mini', weight: 6, via: ['ch-main/o3-mini'] },
    { id: 'ch-ds/deepseek-chat', weight: 10, via: ['ch-ds/deepseek-chat'] },
    { id: 'ch-ds/deepseek-reasoner', weight: 6, via: ['ch-ds/deepseek-reasoner'] },
    { id: 'ch-gemini/gemini-2.5-flash', weight: 6, via: ['ch-gemini/gemini-2.5-flash'] },
    { id: 'ch-local/qwen3:32b', weight: 2, via: ['ch-local/qwen3:32b'] },
  ];
  const weightTotal = trafficModels.reduce((a, b) => a + b.weight, 0);

  function pickTraffic() {
    let r = rnd() * weightTotal;
    for (const t of trafficModels) {
      if (r < t.weight) return t;
      r -= t.weight;
    }
    return trafficModels[0];
  }

  const endpointList = ['/v1/chat/completions', '/v1/chat/completions', '/v1/chat/completions', '/v1/messages', '/v1/embeddings'];
  const ipList = ['10.0.0.12', '10.0.0.31', '192.168.1.24', '192.168.1.77', '203.0.113.7', '127.0.0.1'];

  const logs = [];
  const trafficByModel = new Map();
  const recentByModel = new Map();
  let logSeq = 0;

  (function generateLogs() {
    const days = 8;
    for (let d = days - 1; d >= 0; d--) {
      const dayStart = NOW - d * DAY;
      const date = new Date(dayStart);
      date.setHours(0, 0, 0, 0);
      const base = date.getTime();
      const isToday = d === 0;
      const limitHour = isToday ? new Date(NOW).getHours() : 23;
      for (let h = 0; h <= limitHour; h++) {
        // 白天多、深夜少
        const curve = h >= 9 && h <= 23 ? 1 : h >= 1 && h <= 7 ? 0.18 : 0.55;
        const n = Math.round((isToday ? 13 : 15) * curve * (0.65 + rnd() * 0.8));
        for (let i = 0; i < n; i++) {
          const t = pickTraffic();
          const via = pick(t.via);
          const [channelId, upstream] = via.split('/');
          const c = channel(channelId);
          const kp = provider(matchProvider(upstream));
          const time = base + h * HOUR + Math.floor(rnd() * HOUR);
          if (time > NOW) continue;

          const prompt = int(260, 5200);
          const completion = int(80, 2200);
          const first = int(90, 2100);
          const latency = first + int(500, 14000);
          const isReasoning = /o3|reasoner|thinking/.test(upstream);
          const reasoningTokens = isReasoning ? int(2, 4) * completion : 0;

          // 95.5% 成功；少量 429/500；400 不进统计（日志仍展示）
          const roll = rnd();
          let status = 200;
          let err = '';
          let clientErr = '';
          if (roll > 0.975) {
            status = pick([429, 500, 502]);
            err = status === 429 ? '上游限流：rate limit exceeded' : '上游网关错误：upstream connect error or disconnect/reset before headers';
          } else if (roll > 0.965) {
            status = 400;
            err = 'invalid_request_error: messages[1].content must be a string or array';
            clientErr = '请求体格式有误';
          }

          const retries = roll > 0.94 && roll <= 0.975 ? int(1, 2) : 0;
          const failed = status >= 400;
          const total = failed ? 0 : prompt + completion;
          const tps = failed ? 0 : completion / Math.max(0.2, (latency - first) / 1000);

          const attempts = [];
          for (let a = 0; a < retries; a++) {
            attempts.push({
              channel_id: channelId, channel_name: c ? c.name : '',
              upstream_model: upstream,
              key_index: c && c.multi_key_enabled ? a % c.key_rows.length : 0,
              key_masked: c && c.key_rows[0] ? c.key_rows[0].masked : '',
              key_note: c && c.key_rows[0] ? c.key_rows[0].note : '',
              key_affinity: !!(c && c.key_affinity && a > 0),
              status_code: pick([429, 500, 502]),
              latency_ms: int(400, 4200),
              error: '上游返回错误，已切换下一条路由',
            });
          }

          const log = {
            id: 'lg_' + (++logSeq).toString(36) + Math.floor(rnd() * 1000).toString(36),
            time,
            token_id: pick(tokens).id,
            token_name: pick(tokens).name,
            model_id: t.id,
            channel_id: channelId,
            channel_name: c ? c.name : '',
            upstream_model: upstream,
            response_model: !failed && rnd() > 0.88 ? upstream + '-2026-06-01' : upstream,
            endpoint: pick(endpointList),
            key_index: c && c.multi_key_enabled ? int(0, c.key_rows.length - 1) : 0,
            key_masked: c && c.key_rows[0] ? c.key_rows[0].masked : '',
            key_note: c && c.key_rows[0] ? c.key_rows[0].note : '',
            key_affinity: !!(c && c.key_affinity) && rnd() > 0.4,
            prompt_tokens: prompt,
            completion_tokens: failed ? 0 : completion,
            total_tokens: total,
            usage_estimate: rnd() > 0.94,
            output_estimate: rnd() > 0.96,
            latency_ms: latency,
            first_byte_ms: first,
            status_code: status,
            error: err,
            client_error: clientErr,
            stream: rnd() > 0.18,
            retries,
            ip: pick(ipList),
            attempts,
            affinity: !!(t.id === 'LDM' || t.id === 'claude-pro') && rnd() > 0.35,
            reasoning_chars: isReasoning ? int(200, 2400) : 0,
            reasoning_tokens: reasoningTokens,
            cached_tokens: rnd() > 0.7 ? int(0, prompt / 2) : 0,
            tokens_per_sec: tps,
            canceled: false,
            as_content: false,
            source: '',
          };
          logs.push(log);

          if (status !== 400) {
            const key = t.id;
            const rec = trafficByModel.get(key) || { requests: 0, errors: 0, tokens: 0 };
            rec.requests += 1;
            if (failed) rec.errors += 1;
            rec.tokens += total;
            trafficByModel.set(key, rec);
          }
          if (time > NOW - DAY) {
            const rec = recentByModel.get(t.id) || { requests: 0, errors: 0 };
            rec.requests += 1;
            if (failed) rec.errors += 1;
            recentByModel.set(t.id, rec);
          }
        }
      }
    }
    logs.sort((a, b) => b.time - a.time);
  })();

  function trafficFor(modelId) {
    const m = trafficByModel.get(modelId) || { requests: 0, errors: 0, tokens: 0 };
    const r = recentByModel.get(modelId) || { requests: 0, errors: 0 };
    return {
      requests24h: r.requests,
      errors24h: r.errors,
      rate24h: r.requests ? ((r.requests - r.errors) / r.requests) * 100 : -1,
      requests200: m.requests,
      errors200: m.errors,
      rate200: m.requests ? ((m.requests - m.errors) / m.requests) * 100 : -1,
      totalTokens: m.tokens,
    };
  }

  // 区间：today / yesterday / 7d / 30d / all / custom(start,end)
  function rangeBounds(key, start, end) {
    const todayStart = new Date(NOW);
    todayStart.setHours(0, 0, 0, 0);
    const t0 = todayStart.getTime();
    if (key === 'today') return [t0, 0];
    if (key === 'yesterday') return [t0 - DAY, t0];
    if (key === '7d') return [t0 - 6 * DAY, 0];
    if (key === '30d') return [t0 - 29 * DAY, 0];
    if (key === 'all') return [0, 0];
    return [start || 0, end || 0];
  }

  const inRange = (l, s, e) => (!s || l.time >= s) && (!e || l.time <= e);
  const failedOf = (l) => l.status_code >= 400 && l.status_code !== 400;

  function summarize(list) {
    let requests = 0, errors = 0, prompt = 0, completion = 0, tokens = 0;
    let speedSamples = 0, speedSum = 0, firstSum = 0, latencySum = 0;
    list.forEach((l) => {
      requests += 1;
      if (failedOf(l)) errors += 1;
      prompt += l.prompt_tokens;
      completion += l.completion_tokens;
      tokens += l.total_tokens;
      if (l.tokens_per_sec > 0 && l.first_byte_ms > 0 && l.latency_ms > 0) {
        speedSamples += 1;
        speedSum += l.tokens_per_sec;
        firstSum += l.first_byte_ms;
        latencySum += l.latency_ms;
      }
    });
    return {
      requests, errors, prompt_tokens: prompt, completion_tokens: completion, total_tokens: tokens,
      avg_latency: requests ? Math.round((list.reduce((a, l) => a + l.latency_ms, 0) / requests) * 10) / 10 : 0,
      success_rate: requests ? Math.round(((requests - errors) / requests) * 1000) / 10 : 100,
      speed_samples: speedSamples,
      avg_speed: speedSamples ? Math.round((speedSum / speedSamples) * 10) / 10 : 0,
      avg_first_byte: speedSamples ? Math.round(firstSum / speedSamples) : 0,
      avg_speed_latency: speedSamples ? Math.round(latencySum / speedSamples) : 0,
    };
  }

  function statsOverview(rangeKey, modelId, customStart, customEnd) {
    const [s, e] = rangeBounds(rangeKey, customStart, customEnd);
    const list = logs.filter((l) => inRange(l, s, e) && (!modelId || l.model_id === modelId));
    const cur = summarize(list);
    let prev = null;
    if (s) {
      const span = (e || NOW) - s;
      prev = summarize(logs.filter((l) => l.time >= s - span && l.time < s && (!modelId || l.model_id === modelId)));
    }
    return { range: rangeKey, model: modelId || '', start: s, end: e, current: cur, previous: prev };
  }

  function statsSeries(rangeKey, modelId, customStart, customEnd) {
    const [s, e] = rangeBounds(rangeKey, customStart, customEnd);
    const from = s || (logs.length ? logs[logs.length - 1].time : NOW - DAY);
    const to = e || NOW;
    const span = to - from;
    const byDay = span > 36 * HOUR;
    const step = byDay ? DAY : HOUR;
    const anchor = new Date(from);
    if (byDay) anchor.setHours(0, 0, 0, 0);
    else anchor.setMinutes(0, 0, 0);
    const startT = anchor.getTime();
    const times = [];
    for (let t = startT; t <= to; t += step) times.push(t);

    const list = logs.filter((l) => inRange(l, s, e));
    const modelsInRange = [...new Set(list.map((l) => l.model_id))];
    const bucketOf = (t) => Math.max(0, Math.min(times.length - 1, Math.floor((t - startT) / step)));

    const points = times.map((t) => ({ time: t, requests: 0, errors: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, _lat: 0 }));
    const modelSeries = {};
    modelsInRange.forEach((id) => {
      modelSeries[id] = { requests: [], errors: [], prompt_tokens: [], completion_tokens: [], total_tokens: [] };
      times.forEach(() => {
        modelSeries[id].requests.push(0);
        modelSeries[id].errors.push(0);
        modelSeries[id].prompt_tokens.push(0);
        modelSeries[id].completion_tokens.push(0);
        modelSeries[id].total_tokens.push(0);
      });
    });

    list.forEach((l) => {
      const i = bucketOf(l.time);
      const p = points[i];
      p.requests += 1;
      if (failedOf(l)) p.errors += 1;
      p.prompt_tokens += l.prompt_tokens;
      p.completion_tokens += l.completion_tokens;
      p.total_tokens += l.total_tokens;
      p._lat += l.latency_ms;
      const ms = modelSeries[l.model_id];
      if (ms) {
        ms.requests[i] += 1;
        if (failedOf(l)) ms.errors[i] += 1;
        ms.prompt_tokens[i] += l.prompt_tokens;
        ms.completion_tokens[i] += l.completion_tokens;
        ms.total_tokens[i] += l.total_tokens;
      }
    });
    points.forEach((p) => {
      p.avg_latency = p.requests ? Math.round(p._lat / p.requests) : 0;
      delete p._lat;
    });

    // 只保留 Top 12，避免图例爆掉（真实接口也是 12）
    const top = Object.entries(modelSeries)
      .sort((a, b) => b[1].requests.reduce((x, y) => x + y, 0) - a[1].requests.reduce((x, y) => x + y, 0))
      .slice(0, 12);
    const limitedSeries = {};
    top.forEach(([k, v]) => { limitedSeries[k] = v; });
    if (modelId) {
      return { step_ms: step, points, model_series: {} };
    }
    return { step_ms: step, points, model_series: limitedSeries };
  }

  function statsBreakdown(rangeKey, customStart, customEnd) {
    const [s, e] = rangeBounds(rangeKey, customStart, customEnd);
    const list = logs.filter((l) => inRange(l, s, e));
    const agg = new Map();
    list.forEach((l) => {
      const rec = agg.get(l.model_id) || { name: l.model_id, value: 0, errors: 0, tokens: 0 };
      rec.value += 1;
      if (failedOf(l)) rec.errors += 1;
      rec.tokens += l.total_tokens;
      agg.set(l.model_id, rec);
    });
    const modelsArr = [...agg.values()].sort((a, b) => b.value - a.value).slice(0, 12);
    const modelsByTokens = [...agg.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 12);

    const rank = (keyFn, tokenFn) => {
      const map = new Map();
      list.forEach((l) => {
        const name = keyFn(l);
        if (!name) return;
        const rec = map.get(name) || { name, value: 0, tokens: 0 };
        rec.value += 1;
        if (tokenFn) rec.tokens += l.total_tokens;
        else rec.tokens += l.total_tokens;
        map.set(name, rec);
      });
      return [...map.values()];
    };

    const tokenNames = new Map(tokens.map((t) => [t.id, t.name]));
    const channelsRank = rank((l) => l.channel_id);
    const keysRank = rank((l) => tokenNames.get(l.token_id) || l.token_name);
    return {
      models: modelsArr,
      models_by_tokens: modelsByTokens,
      channels: channelsRank.sort((a, b) => b.value - a.value).slice(0, 12),
      channels_by_tokens: [...channelsRank].sort((a, b) => b.tokens - a.tokens).slice(0, 12),
      keys: keysRank.sort((a, b) => b.value - a.value).slice(0, 12),
      keys_by_tokens: [...keysRank].sort((a, b) => b.tokens - a.tokens).slice(0, 12),
      total: list.length,
      errors: list.filter(failedOf).length,
      tokens_used: list.reduce((a, l) => a + l.total_tokens, 0),
    };
  }

  function statsChannelUsage(rangeKey, channelId, customStart, customEnd) {
    const [s, e] = rangeBounds(rangeKey, customStart, customEnd);
    let list = logs.filter((l) => inRange(l, s, e));
    if (channelId) list = list.filter((l) => l.channel_id === channelId);

    const channelsOut = channels.map((c) => {
      const cl = list.filter((l) => l.channel_id === c.id);
      return { id: c.id, name: c.name, requests: cl.length, total_tokens: cl.reduce((a, l) => a + l.total_tokens, 0) };
    });

    const map = new Map();
    list.forEach((l) => {
      const key = String(l.upstream_model || '').trim().toLowerCase();
      const rec = map.get(key) || {
        key, name: l.upstream_model, requests: 0, errors: 0,
        prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, _channels: new Set(),
      };
      rec.requests += 1;
      if (failedOf(l)) rec.errors += 1;
      rec.prompt_tokens += l.prompt_tokens;
      rec.completion_tokens += l.completion_tokens;
      rec.total_tokens += l.total_tokens;
      rec._channels.add(l.channel_id);
      map.set(key, rec);
    });
    const modelsOut = [...map.values()].map((r) => ({
      key: r.key, name: r.name, requests: r.requests, errors: r.errors,
      prompt_tokens: r.prompt_tokens, completion_tokens: r.completion_tokens,
      total_tokens: r.total_tokens,
      success_rate: r.requests ? Math.round(((r.requests - r.errors) / r.requests) * 1000) / 10 : 100,
      channel_count: r._channels.size,
    })).sort((a, b) => b.total_tokens - a.total_tokens || b.requests - a.requests);

    return {
      range: rangeKey, start: s, end: e, channel_id: channelId || '',
      summary: summarize(list), channels: channelsOut, models: modelsOut,
    };
  }

  // 日志查询（分页 + 筛选），行为对齐 GET /api/logs
  let logsCleared = false;
  function queryLogs(opts) {
    const o = opts || {};
    if (logsCleared) return { items: [], total: 0 };
    let list = logs.filter((l) => {
      if (o.model_id && l.model_id !== o.model_id) return false;
      if (o.channel_id && l.channel_id !== o.channel_id) return false;
      if (o.token_id && l.token_id !== o.token_id) return false;
      if (o.status === 'success' && failedOf(l)) return false;
      if (o.status === 'error' && !failedOf(l)) return false;
      if (o.status === 'retry' && !(l.retries > 0)) return false;
      if (o.start && l.time < o.start) return false;
      if (o.end && l.time > o.end) return false;
      return true;
    });
    const total = list.length;
    const offset = o.offset || 0;
    const limit = o.limit || 30;
    return { items: list.slice(offset, offset + limit), total };
  }

  function logFacets(start, end) {
    if (logsCleared) return { models: [], channels: [], tokens: [] };
    const list = logs.filter((l) => (!start || l.time >= start) && (!end || l.time <= end));
    const collect = (keyFn, nameFn) => {
      const map = new Map();
      list.forEach((l) => {
        const id = keyFn(l);
        if (!id) return;
        const rec = map.get(id) || { id, name: nameFn(l), count: 0 };
        rec.count += 1;
        map.set(id, rec);
      });
      return [...map.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
    };
    return {
      models: collect((l) => l.model_id, () => ''),
      channels: collect((l) => l.channel_id, (l) => l.channel_name),
      tokens: collect((l) => l.token_id, (l) => l.token_name),
    };
  }

  // ---------- 上游模型探测（模拟 POST /api/channels/discover） ----------
  const extraUpstream = {
    'ch-main': ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o-realtime-preview', 'dall-e-3', 'whisper-1'],
    'ch-ds': ['deepseek-v3.2', 'deepseek-coder-v2'],
    'ch-claude': ['claude-opus-4-1', 'claude-sonnet-4-0'],
    'ch-gemini': ['gemini-2.5-flash-lite', 'gemini-embedding-001'],
    'ch-kimi': ['kimi-k2-turbo', 'moonshot-v1-128k'],
    'ch-local': ['mistral-small:24b', 'nomic-embed-text'],
  };

  function discover(channelId) {
    return new Promise((resolve) => {
      setTimeout(() => {
        const c = channel(channelId);
        const list = [...new Set([...(c ? c.models : []), ...(extraUpstream[channelId] || [])])];
        resolve({ models: list, message: `上游返回 ${list.length} 个模型`, latency_ms: 320 + Math.floor(rnd() * 500) });
      }, 650);
    });
  }

  // ---------- 系统设置 / 运行信息 ----------
  const settings = {
    site_name: '懒大猫 API',
    site_subtitle: '模型聚合网关',
    logo: '',
    theme: 'light',
    log_retention_days: 30,
    allow_origins: '',
    allow_unlisted_channel_models: false,
    affinity_cleanup_hours: 6,
    affinity_clean_channel: true,
    affinity_clean_model: true,
    affinity_cleanup_at: NOW - 3 * HOUR,
    affinity_model_count: 7,
    affinity_channel_count: 3,
  };

  const me = {
    logged_in: true,
    version: '1.31.0',
    started_at: NOW - 2 * DAY - 5 * HOUR,
    uptime_seconds: 2 * 86400 + 5 * 3600 + 23 * 60,
    system: 'Windows · amd64',
    memory_bytes: 78 * 1024 * 1024,
    memory_total_bytes: 32 * 1024 * 1024 * 1024,
    default_password: false,
    counts: { channels: channels.length, models: models.length, tokens: tokens.length, logs: logs.length },
  };

  window.PVDATA = {
    NOW, channels, models, providers, tokens, logs, settings, me,
    channel, model, provider, matchProvider,
    modelsView, plazaItems, trafficFor,
    statsOverview, statsSeries, statsBreakdown, statsChannelUsage,
    queryLogs, logFacets, discover, rangeBounds,
    clearLogs() {
      // 与线上一致：只删日志，统计桶不回滚
      logsCleared = true;
      return logs.length;
    },
  };
})();
