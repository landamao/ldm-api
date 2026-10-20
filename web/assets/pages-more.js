/* ==========================================================================
   懒大猫 API · 数据看板 / 模型广场 / 令牌 / 日志 / 设置
   ========================================================================== */
(function () {
  'use strict';

  const {
    esc, API, State, Toast, openModal, confirmDialog, promptDialog, icon, providerIcon, providerAvatar,
    badge, statusBadge, emptyState, loadingBlock, fmtTime, fmtInt, fmtUnit, fmtNum, fmtDuration,
    fmtUptime, relTime, copyText, debounce, fmtContext, Theme, switchEl, colorBadge, isCoarsePointer,
  } = window.LDM;

  const { areaChart, barChart, donutChart, rankList, timeLabel, hideTip } = window.Charts;

  // 密钥默认只露头尾，点眼睛才展开——列表一屏能显示很多条，明文摆着太容易泄露
  const maskKey = (k) => {
    if (!k) return '';
    if (k.length <= 16) return k.slice(0, 4) + '••••';
    return k.slice(0, 12) + '••••' + k.slice(-4);
  };

  // 失败判定：上游错误透传时 error 为空，但 client_error 仍有内容，
  // 状态码 >= 400 或客户端取消也属于失败。成功记录不提供错误弹窗入口。
  const logOK = (l) => !l.canceled && l.status_code > 0 && l.status_code < 400
    && !l.error && !l.client_error;

  // 模型亲和标记：橙色四角星叠在模型徽章右上角，样式对齐 NewAPI 的渠道亲和标。
  const AFFINITY_STAR = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M10.9 2.4l1.9 5.3a2.6 2.6 0 001.5 1.5l5.3 1.9-5.3 1.9a2.6 2.6 0 00-1.5 1.5l-1.9 5.3-1.9-5.3a2.6 2.6 0 00-1.5-1.5L2.2 11.1l5.3-1.9a2.6 2.6 0 001.5-1.5z"/><path d="M19 2l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z"/></svg>`;
  const affinityTitle = (l) => l.retries
    ? '模型亲和命中：优先尝试上次成功的路由，失败后已切换'
    : '模型亲和命中：本次直接复用了上次成功的路由';
  const KEY_AFFINITY_TITLE = 'Key 亲和命中：优先使用了上次成功的 Key';

  // 错误详情弹窗：顶部概要只放请求模型、渠道模型、渠道和状态码，
  // 下面分成「错误详情」和「内部原因」两个独立块。错误详情是调用方实际
  // 收到的内容，内部原因只给后台排查。
  function showLogError(l) {
    const status = l.status_code > 0 ? String(l.status_code) : '—';
    const statusTone = l.canceled ? 'amber' : 'red';
    const channelModel = l.channel_id
      ? `${l.channel_id}/${l.upstream_model || '—'}`
      : '—';
    const channelLabel = l.channel_id
      ? `${l.channel_id}${l.channel_name ? '（' + l.channel_name + '）' : ''}`
      : '未命中渠道';
    const summary = [
      ['请求模型', `<span class="mono">${esc(l.model_id || '—')}</span>`],
      ['渠道模型', `<span class="mono">${esc(channelModel)}</span>`],
      ['渠道', `<span class="mono">${esc(channelLabel)}</span>`],
      ['状态码', `<span class="badge badge--${statusTone}">${esc(status)}</span>`],
      l.endpoint ? ['接口', `<span class="mono">${esc(l.endpoint)}</span>`] : null,
    ].filter(Boolean);

    const block = (text, tone) => {
      const v = (text || '').trim();
      return v
        ? `<div class="log-error__block log-error__block--${tone}">${esc(v)}</div>`
        : '<div class="log-error__block log-error__block--empty">—</div>';
    };

    openModal({
      title: '错误信息',
      size: 'lg',
      body: `<div class="log-error">
        <dl class="kv log-error__summary">
          ${summary.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}
        </dl>
        <div class="log-error__section">
          <div class="log-error__label">错误详情</div>
          ${block(l.client_error, statusTone)}
        </div>
        <div class="log-error__section">
          <div class="log-error__label">内部原因</div>
          ${block(l.error, 'internal')}
        </div>
      </div>`,
      footer: `<div class="spacer"></div><button class="btn" data-close>关闭</button>`,
    });
  }

  // ======================================================================
  // 数据看板
  // ======================================================================
  const DASH_RANGES = {
    today: { label: '今日', compare: '较昨日同期' },
    week: { label: '本周', compare: '较上周同期' },
    month: { label: '本月', compare: '较上月同期' },
  };
  const dashRange = { key: 'today' };
  const dashRangeInfo = () => DASH_RANGES[dashRange.key] || DASH_RANGES.today;
  const dashMetric = { m: 'requests' };
  const DASH_UNIT_KEY = 'ldmapi.dashboard.unit';
  const dashUnit = { mode: 'cn' };
  try {
    const saved = localStorage.getItem(DASH_UNIT_KEY);
    if (saved === 'en' || saved === 'cn' || saved === 'none') dashUnit.mode = saved;
  } catch (e) { /* 存储不可用时用默认值 */ }

  // 看板数字单位：en = K/M/B，cn = 万/亿，none = 完整数字
  function fmtDash(n) {
    n = Number(n) || 0;
    const abs = Math.abs(n);
    if (dashUnit.mode === 'none') return n.toLocaleString('zh-CN');
    const fixed = (v) => v.toFixed(2).replace(/\.?0+$/, '');
    if (dashUnit.mode === 'en') {
      if (abs >= 1e9) return fixed(n / 1e9) + 'B';
      if (abs >= 1e6) {
        const v = n / 1e6;
        return Math.abs(v) >= 999.995 ? fixed(n / 1e9) + 'B' : fixed(v) + 'M';
      }
      if (abs >= 1e3) {
        const v = n / 1e3;
        return Math.abs(v) >= 999.995 ? fixed(n / 1e6) + 'M' : fixed(v) + 'K';
      }
      return n.toLocaleString('zh-CN');
    }
    if (abs >= 1e8) return fixed(n / 1e8) + '亿';
    if (abs >= 1e4) {
      const v = n / 1e4;
      return Math.abs(v) >= 9999.995 ? fixed(n / 1e8) + '亿' : fixed(v) + '万';
    }
    return n.toLocaleString('zh-CN');
  }

  window.LDM.registerPage('dashboard', {
    title: '数据看板',
    desc: '网关调用量、Token 消耗与渠道健康度',
    async render(root, actions) {
      actions.innerHTML = `
        <div class="pill-toggle" id="range-toggle">
          <button data-r="today" class="${dashRange.key === 'today' ? 'is-on' : ''}">今日</button>
          <button data-r="week" class="${dashRange.key === 'week' ? 'is-on' : ''}">本周</button>
          <button data-r="month" class="${dashRange.key === 'month' ? 'is-on' : ''}">本月</button>
        </div>
        <select class="select" id="dash-unit" aria-label="数字单位" style="width:auto;min-width:128px">
          <option value="en"${dashUnit.mode === 'en' ? ' selected' : ''}>英文单位 K/M</option>
          <option value="cn"${dashUnit.mode === 'cn' ? ' selected' : ''}>中文单位 万/亿</option>
          <option value="none"${dashUnit.mode === 'none' ? ' selected' : ''}>无单位</option>
        </select>
        <button class="btn" id="btn-refresh">${icon('refresh', 14)}刷新</button>`;

      actions.querySelector('#btn-refresh').onclick = () => window.LDM.navigate();
      actions.querySelector('#dash-unit').onchange = (e) => {
        dashUnit.mode = e.target.value;
        try { localStorage.setItem(DASH_UNIT_KEY, dashUnit.mode); } catch (err) { /* 忽略配额错误 */ }
        if (dashData) renderBody();
      };
      actions.querySelectorAll('#range-toggle button').forEach((b) => {
        b.onclick = () => {
          dashRange.key = b.dataset.r;
          actions.querySelectorAll('#range-toggle button').forEach((x) => x.classList.toggle('is-on', x === b));
          load();
        };
      });

      root.innerHTML = `<div id="dash-body">${loadingBlock()}</div>`;
      const body = root.querySelector('#dash-body');

      let dashData = null;
      let loadSeq = 0;
      async function load() {
        const seq = ++loadSeq;
        dashData = null;
        body.innerHTML = loadingBlock();
        try {
          const [overview, series, breakdown, logs] = await Promise.all([
            API.get('/api/stats/overview?range=' + dashRange.key),
            API.get('/api/stats/series?range=' + dashRange.key),
            API.get('/api/stats/breakdown?range=' + dashRange.key),
            API.get('/api/logs?limit=8'),
          ]);
          if (seq !== loadSeq) return;
          dashData = { overview, series, breakdown, logs };
        } catch (e) {
          if (seq !== loadSeq) return;
          body.innerHTML = `<div class="card card--pad"><div class="alert alert--warn">${icon('alert', 16)}<div>${esc(e.message)}</div></div></div>`;
          return;
        }
        renderBody();
      }

      function renderBody() {
        hideTip();
        const { overview, series, breakdown, logs } = dashData;
        const t = overview.current;
        const y = overview.previous;
        const delta = (cur, prev) => {
          if (!prev) return cur > 0 ? '<span class="stat__delta up">新增</span>' : '<span class="muted">—</span>';
          const d = ((cur - prev) / prev) * 100;
          const cls = d >= 0 ? 'up' : 'down';
          const arrow = d >= 0 ? '↑' : '↓';
          return `<span class="stat__delta ${cls}">${arrow} ${Math.abs(d).toFixed(1)}%</span> ${dashRangeInfo().compare}`;
        };

        const points = series.points || [];
        const labels = points.map((p) => timeLabel(p.time, series.step_ms * points.length));
        const times = points.map((p) => p.time);

        body.innerHTML = `
          <div class="stat-grid">
            <div class="stat">
              <div class="stat__label">${icon('zap', 13)}${dashRangeInfo().label}请求</div>
              <div class="stat__value">${fmtDash(t.requests)}<small>次</small></div>
              <div class="stat__foot">${delta(t.requests, y.requests)}</div>
            </div>
            <div class="stat">
              <div class="stat__label">${icon('bolt', 13)}${dashRangeInfo().label} Token</div>
              <div class="stat__value">${fmtDash(t.total_tokens)}</div>
              <div class="stat__foot">${delta(t.total_tokens, y.total_tokens)}</div>
            </div>
            <div class="stat">
              <div class="stat__label">${icon('check', 13)}成功率</div>
              <div class="stat__value" style="color:${rateColor(t.requests ? t.success_rate : 100)}">${t.requests ? t.success_rate.toFixed(1) : '100.0'}<small style="color:inherit">%</small></div>
              <div class="stat__foot">${t.errors ? `${fmtInt(t.errors)} 次失败` : '全部成功'}</div>
            </div>
            <div class="stat">
              <div class="stat__label">${icon('clock', 13)}平均速度</div>
              <div class="stat__value">${t.speed_samples ? `${t.avg_speed.toFixed(1)}<small>t/s</small>` : '—'}</div>
              <div class="stat__foot">${t.speed_samples
                ? `首字 ${fmtDuration(t.avg_first_byte)} · 总耗时 ${fmtDuration(t.avg_speed_latency)}`
                : '暂无流式记录'}</div>
            </div>
            <div class="stat">
              <div class="stat__label">${icon('channels', 13)}渠道</div>
              <div class="stat__value">${fmtDash(overview.channels.enabled)}<small>/ ${fmtDash(overview.channels.total)}</small></div>
              <div class="stat__foot">已启用 / 总数</div>
            </div>
            <div class="stat">
              <div class="stat__label">${icon('models', 13)}模型</div>
              <div class="stat__value">${fmtDash(overview.models.enabled)}<small>/ ${fmtDash(overview.models.total)}</small></div>
              <div class="stat__foot">运行 ${fmtUptime(overview.uptime)}</div>
            </div>
          </div>

          <div class="chart-grid">
            <div class="card">
              <div class="card__head">
                <div>
                  <div class="card__title">调用趋势</div>
                  <div class="card__sub">请求量与 Token 消耗</div>
                </div>
                <div class="card__actions">
                  <div class="pill-toggle" id="metric-toggle">
                    <button data-m="requests" class="${dashMetric.m === 'requests' ? 'is-on' : ''}">请求数</button>
                    <button data-m="tokens" class="${dashMetric.m === 'tokens' ? 'is-on' : ''}">Token</button>
                  </div>
                </div>
              </div>
              <div class="card__body"><div id="trend-chart"></div></div>
            </div>

            <div class="card">
              <div class="card__head">
                <div>
                  <div class="card__title">模型调用分布</div>
                  <div class="card__sub">${dashRangeInfo().label}</div>
                </div>
              </div>
              <div class="card__body"><div id="model-donut"></div></div>
            </div>
          </div>

          <div class="chart-grid">
            <div class="card">
              <div class="card__head">
                <div>
                  <div class="card__title">渠道调用量</div>
                  <div class="card__sub">按上游渠道统计</div>
                </div>
              </div>
              <div class="card__body"><div id="channel-rank"></div></div>
            </div>
            <div class="card">
              <div class="card__head">
                <div>
                  <div class="card__title">密钥调用量</div>
                  <div class="card__sub">按 API 密钥统计</div>
                </div>
              </div>
              <div class="card__body"><div id="token-rank"></div></div>
            </div>
          </div>

          <div class="card">
            <div class="card__head">
              <div>
                <div class="card__title">最近调用</div>
                <div class="card__sub">最新 8 条请求记录</div>
              </div>
              <div class="card__actions">
                <button class="btn btn--sm" id="go-logs">查看全部${icon('logs', 13)}</button>
              </div>
            </div>
            <div id="recent-logs"></div>
          </div>`;

        const trendHost = body.querySelector('#trend-chart');
        const drawTrend = (metric) => {
          const s = metric === 'tokens'
            ? [
                { name: '输入 Token', color: '#88c0d0', values: points.map((p) => p.prompt_tokens) },
                { name: '输出 Token', color: '#f33b7c', values: points.map((p) => p.completion_tokens) },
              ]
            : [
                { name: '请求数', color: '#f33b7c', values: points.map((p) => p.requests) },
                { name: '失败数', color: '#f59e0b', values: points.map((p) => p.errors) },
              ];
          areaChart(trendHost, {
            labels, times, series: s, height: 216, spanMs: series.step_ms,
            valueFmt: fmtDash,
            axisFmt: fmtDash,
          });
        };
        drawTrend(dashMetric.m);
        body.querySelectorAll('#metric-toggle button').forEach((b) => {
          b.onclick = () => {
            dashMetric.m = b.dataset.m;
            body.querySelectorAll('#metric-toggle button').forEach((x) => x.classList.toggle('is-on', x === b));
            drawTrend(b.dataset.m);
          };
        });

        donutChart(body.querySelector('#model-donut'), {
          items: (breakdown.models || []).map((x) => ({ name: x.name, value: x.value })),
          valueFmt: fmtDash,
        });

        rankList(body.querySelector('#channel-rank'), breakdown.channels || [], { nameWidth: 200, fmt: fmtDash });
        rankList(body.querySelector('#token-rank'), breakdown.tokens || [], { nameWidth: 200, fmt: fmtDash });

        const items = logs.items || [];
        body.querySelector('#recent-logs').innerHTML = items.length
          ? `<div class="table-wrap" style="border:none;border-radius:0">
              <table class="tbl tbl--flat">
                <thead><tr>
                  <th>时间</th><th>模型</th><th>渠道</th><th class="right">耗时</th>
                  <th class="right">Token</th><th>状态</th>
                </tr></thead>
                <tbody>${items.map((l, idx) => `<tr>
                  <td class="nowrap muted fs-12">${esc(fmtTime(l.time))}</td>
                  <td>${colorBadge(l.model_id)}</td>
                  <td>${l.channel_id ? `<span class="code">${esc(l.channel_id)}</span>` : '<span class="muted">—</span>'}</td>
                  <td class="right num">${esc(fmtDuration(l.latency_ms))}</td>
                  <td class="right num" title="${fmtInt(l.total_tokens)}">${fmtDash(l.total_tokens)}</td>
                  <td>${l.canceled
                    ? `<button type="button" class="badge badge--amber badge--click" data-recent-error="${idx}" title="${esc(l.error || '点击查看错误详情')}">${esc(l.status_code || 200)}</button>`
                    : (logOK(l)
                      ? '<span class="badge badge--green">成功</span>'
                      : `<button type="button" class="badge badge--red badge--click" data-recent-error="${idx}" title="${esc(l.error || '点击查看错误详情')}">${esc(l.status_code || '失败')}</button>`)}</td>
                </tr>`).join('')}</tbody>
              </table>
            </div>`
          : emptyState('还没有调用记录', '通过 API 调用任意模型后，这里会显示实时统计。', '', 'logs');

        body.querySelectorAll('#recent-logs [data-recent-error]').forEach((btn) => {
          btn.onclick = () => showLogError(items[Number(btn.dataset.recentError)]);
        });

        body.querySelector('#go-logs').onclick = () => { location.hash = '#/logs'; };
      }

      await load();
    },
  });

  // ======================================================================
  // 模型广场
  // ======================================================================
  const plazaState = { keyword: '', filter: 'all', provider: 'all' };

  window.LDM.registerPage('plaza', {
    title: '模型广场',
    desc: '所有已启用、可被调用的模型',
    async render(root, actions) {
      const [items, providers] = await Promise.all([
        API.get('/api/plaza'),
        State.loadProviders(),
      ]);
      const providerByID = {};
      (providers || []).forEach((p) => { providerByID[p.id] = p; });
      // 「可用」筛选已移除（广场只显示可用模型），清理旧会话残留的筛选状态
      if (plazaState.filter === 'available') plazaState.filter = 'all';

      actions.innerHTML = `<button class="btn" id="btn-refresh">${icon('refresh', 14)}刷新</button>`;
      actions.querySelector('#btn-refresh').onclick = () => window.LDM.navigate();

      // 提供商筛选只展示「广场里有可用模型」的提供商；没有模型的提供商不出现。
      const availableItems = items.filter((m) => m.available);
      const providerCounts = {};
      let unassigned = 0;
      availableItems.forEach((m) => {
        if (m.provider_id && providerByID[m.provider_id]) providerCounts[m.provider_id] = (providerCounts[m.provider_id] || 0) + 1;
        else unassigned++;
      });
      const plazaProviders = (providers || []).filter((p) => providerCounts[p.id] > 0);
      if (plazaState.provider !== 'all' && plazaState.provider !== '__none' && !providerCounts[plazaState.provider]) {
        plazaState.provider = 'all';
      }
      if (plazaState.provider === '__none' && !unassigned) plazaState.provider = 'all';

      root.innerHTML = `
        <div class="card mb-18">
          <div class="toolbar">
            <div class="search">
              <span class="search__icon">${icon('search', 15)}</span>
              <input class="input" id="plaza-search" placeholder="搜索模型…" value="${esc(plazaState.keyword)}">
            </div>
            <div class="pill-toggle" id="plaza-filter">
              <button data-f="all" class="${plazaState.filter === 'all' ? 'is-on' : ''}">全部</button>
              <button data-f="custom" class="${plazaState.filter === 'custom' ? 'is-on' : ''}">自定义模型</button>
              <button data-f="channel" class="${plazaState.filter === 'channel' ? 'is-on' : ''}">渠道模型</button>
            </div>
            <div class="toolbar__spacer"></div>
            <span class="muted fs-12" id="plaza-count"></span>
          </div>
          <div class="provider-filter" id="plaza-providers">
            <button class="provider-chip${plazaState.provider === 'all' ? ' is-on' : ''}" data-p="all">全部提供商<span class="provider-chip__count">${availableItems.length}</span></button>
            ${plazaProviders.map((p) => `<button class="provider-chip${plazaState.provider === p.id ? ' is-on' : ''}" data-p="${esc(p.id)}">${providerIcon(p.icon, 15)}<span>${esc(p.name)}</span><span class="provider-chip__count">${providerCounts[p.id]}</span></button>`).join('')}
            ${unassigned ? `<button class="provider-chip${plazaState.provider === '__none' ? ' is-on' : ''}" data-p="__none">${providerIcon('', 15)}<span>未设置</span><span class="provider-chip__count">${unassigned}</span></button>` : ''}
          </div>
        </div>
        <div id="plaza-grid"></div>`;

      const grid = root.querySelector('#plaza-grid');
      const countEl = root.querySelector('#plaza-count');

      const renderGrid = () => {
        const kw = plazaState.keyword.trim().toLowerCase();
        // 不可用的模型（被禁用、渠道被禁用或渠道已删除）不进广场
        let list = items.filter((m) => {
          if (!m.available) return false;
          if (plazaState.filter === 'custom' && m.type !== 'custom') return false;
          if (plazaState.filter === 'channel' && m.type !== 'channel') return false;
          if (plazaState.provider === '__none') {
            if (m.provider_id && providerByID[m.provider_id]) return false;
          } else if (plazaState.provider !== 'all' && m.provider_id !== plazaState.provider) {
            return false;
          }
          if (kw) {
            const hay = (m.id + ' ' + (m.display_name || '') + ' ' + (m.description || '') + ' ' + (m.provider_name || '') + ' ' + (m.tags || []).join(' ')).toLowerCase();
            if (!hay.includes(kw)) return false;
          }
          return true;
        });
        countEl.textContent = `共 ${list.length} 个模型`;

        if (!list.length) {
          grid.innerHTML = `<div class="card">${emptyState(
            items.filter((m) => m.available).length === 0 ? '还没有可用的模型' : '没有匹配的模型',
            items.filter((m) => m.available).length === 0
              ? '先在「渠道管理」配置上游，再到「模型管理」把模型添加进来。'
              : '换个关键词或筛选条件试试。',
            items.filter((m) => m.available).length === 0 ? `<button class="btn btn--primary" id="go-models">${icon('plus', 15)}去添加模型</button>` : '',
            'plaza'
          )}</div>`;
          const b = grid.querySelector('#go-models');
          if (b) b.onclick = () => { location.hash = '#/models'; };
          return;
        }

        grid.innerHTML = `<div class="plaza-grid">${list.map((m) => {
          const isCustom = m.type === 'custom';
          const provider = m.provider_id ? providerByID[m.provider_id] : null;
          const fallback = isCustom ? '🔀' : (m.channel_type === 'anthropic' ? '🅰️' : m.channel_type === 'gemini' ? '✨' : '🧠');
          const avatar = providerAvatar(provider, 34, fallback);
          return `<div class="model-card" data-detail="${esc(m.id)}">
            <div class="model-card__head">
              ${avatar}
              <div style="min-width:0;flex:1">
                <div class="model-card__name" title="${esc(m.id)}">${esc(m.id)}</div>
                <div class="model-card__type ${isCustom ? 'is-custom' : 'is-channel'}">${isCustom ? '自定义' : '渠道'}</div>
                <div class="model-card__sub">${provider ? `${esc(provider.name)}` : '未设置提供商'}</div>
              </div>
            </div>
            ${m.description ? `<div class="model-card__desc">${esc(m.description)}</div>` : ''}
            <div class="model-card__caps">
              ${m.caps && m.caps.context_length ? badge('上下文 ' + fmtContext(m.caps.context_length), 'gray') : ''}
              ${m.caps && m.caps.tool_calling === true ? badge('工具调用', 'green') : ''}
              ${m.caps && m.caps.thinking === true ? badge('思考', 'violet') : ''}
              ${m.caps && m.caps.vision === true ? badge('图片', 'pink') : ''}
              ${(m.tags || []).map((t) => badge(t, 'gray')).join('')}
            </div>
            ${isCustom && m.routes && m.routes.length ? `<div class="fs-12 muted truncate" style="font-family:var(--mono)" title="${esc(m.routes.map((r) => r.model_id).join(' → '))}">
              ${esc(m.routes.map((r) => r.model_id).join(' → '))}</div>` : ''}
            ${!isCustom && m.source ? `<div class="fs-12 muted">来源：${esc(m.source)}</div>` : ''}
            <div class="model-card__foot">
              <div class="flex gap-12" style="flex:1;min-width:0">
                <span class="model-card__stat">近 24h <b>${fmtInt(m.requests_24h)}</b> 次</span>
                <span class="model-card__stat">成功率
                  ${m.success_rate >= 0
                    ? `<b style="color:${rateColor(m.success_rate)}">${m.success_rate.toFixed(1)}%</b>`
                    : '<b class="muted">—</b>'}
                </span>
              </div>
              <div class="flex gap-6">
                <button class="btn btn--sm btn--icon" data-copy="${esc(m.id)}" title="复制模型 ID">${icon('copy', 13)}</button>
                <button class="btn btn--sm" data-goto="${esc(m.id)}">${icon('chat', 13)}对话</button>
              </div>
            </div>
          </div>`;
        }).join('')}</div>`;

        grid.querySelectorAll('[data-copy]').forEach((b) => {
          b.onclick = () => copyText(b.dataset.copy, '模型 ID ');
        });
        grid.querySelectorAll('[data-goto]').forEach((b) => {
          b.onclick = () => { location.hash = '#/chat?model=' + encodeURIComponent(b.dataset.goto); };
        });
        // 点卡片主体滑出详情，点按钮不触发
        grid.querySelectorAll('[data-detail]').forEach((card) => {
          card.onclick = (e) => {
            if (e.target.closest('button')) return;
            const m = list.find((x) => x.id === card.dataset.detail);
            if (m) openModelDrawer(m);
          };
        });
      };

      const searchEl = root.querySelector('#plaza-search');
      searchEl.addEventListener('input', debounce(() => {
        plazaState.keyword = searchEl.value;
        renderGrid();
      }, 180));
      root.querySelectorAll('#plaza-filter button').forEach((b) => {
        b.onclick = () => {
          plazaState.filter = b.dataset.f;
          root.querySelectorAll('#plaza-filter button').forEach((x) => x.classList.toggle('is-on', x === b));
          renderGrid();
        };
      });
      root.querySelectorAll('#plaza-providers .provider-chip').forEach((b) => {
        b.onclick = () => {
          plazaState.provider = b.dataset.p;
          root.querySelectorAll('#plaza-providers .provider-chip').forEach((x) => x.classList.toggle('is-on', x === b));
          renderGrid();
        };
      });

      renderGrid();
    },
  });

  // ---------- 模型详情抽屉 ----------
  const capLabel = (v) => (v === true ? '支持' : v === false ? '不支持' : '从上游透传');
  const capBadge = (v) => (v === true
    ? badge('支持', 'green')
    : (v === false ? badge('不支持', 'red') : badge('从上游透传', 'gray')));

  function openModelDrawer(m) {
    const isCustom = m.type === 'custom';
    const caps = m.caps || {};
    const prev = document.activeElement;

    const row = (k, v) => `<dt>${esc(k)}</dt><dd>${v}</dd>`;
    const providerHtml = m.provider_name
      ? `<span class="provider-tag">${providerIcon(m.provider_icon, 15)}${esc(m.provider_name)}</span>`
      : '<span class="muted">未设置</span>';
    const statusHtml = (() => {
      if (m.status === 'disabled') return statusBadge(false, '', '已禁用');
      if (m.status === 'channel_disabled') return badge('渠道已禁用', 'red');
      if (m.status === 'channel_missing' || m.status === 'model_missing') return badge('渠道模型不存在', 'red');
      if (m.status === 'not_added') return badge('未接入模型管理', 'red');
      if (m.status === 'ok') return statusBadge(true, '可用');
      return badge('不可用', 'red');
    })();

    // 来源：自定义模型展示路由模型列表，有分组时按组显示（与模型配置页一致）；
    // 渠道模型展示所属渠道。
    const routeStatusBadge = (r) => {
      if (r.status === 'channel_disabled') return badge('渠道已禁用', 'red');
      if (r.status === 'channel_missing' || r.status === 'model_missing') return badge('渠道模型不存在', 'red');
      if (r.status === 'ok') return badge('可用', 'green');
      return r.channel_ready === false ? badge('不可用', 'red') : badge('可用', 'green');
    };
    const routeItemHtml = (r, num, inGroup) => `
      <div class="route-item ${inGroup ? 'is-grouped' : ''}">
        ${num ? `<span class="route-item__idx">${num}</span>` : ''}
        <span class="route-item__name" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.model_id)}</span>
        <span class="route-item__meta">
          ${r.channel_name ? `<span class="muted fs-12" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.channel_name)}</span>` : ''}
          ${routeStatusBadge(r)}
        </span>
      </div>`;
    // 连续相同 group 的条目归为一组（group=0 视为普通条目），与模型配置页的分组规则一致
    const routeSegments = (routes) => {
      const segs = [];
      routes.forEach((r, i) => {
        const last = segs[segs.length - 1];
        if (r.group && last && routes[last[0]].group === r.group) last.push(i);
        else segs.push([i]);
      });
      return segs;
    };
    let sourceHtml = '<span class="muted">—</span>';
    if (isCustom && m.routes && m.routes.length) {
      // 编号按单元（普通条目或整组）递增，组内成员不单独编号
      let num = 0;
      const units = routeSegments(m.routes).map((seg) => {
        num++;
        if (seg.length === 1) return routeItemHtml(m.routes[seg[0]], num, false);
        const ws = seg.reduce((s, i) => s + Math.max(0, m.routes[i].weight || 0), 0);
        const ratio = seg.map((i) => m.routes[i].weight || 0).join(' ∶ ');
        return `<div class="route-group">
          <div class="route-group__head">
            <span class="route-item__idx">${num}</span>
            <span class="route-group__tag">${icon('box', 12)}${seg.length}个模型</span>
            <span class="muted fs-11" style="margin-left:auto">组内权重比 ${ws > 0 ? ratio : '均等（随机）'}</span>
          </div>
          ${seg.map((i) => routeItemHtml(m.routes[i], 0, true)).join('')}
        </div>`;
      });
      sourceHtml = `<div class="route-list">${units.join('')}</div>`;
    } else if (isCustom) {
      sourceHtml = badge('未配置路由目标', 'red');
    } else {
      sourceHtml = `<span class="code">${esc(m.source || m.channel_id || '—')}</span>`
        + `<span class="muted fs-12"> → 上游模型 ${esc(m.upstream || '—')}</span>`;
    }

    const backdrop = document.createElement('div');
    backdrop.className = 'drawer-backdrop';
    backdrop.innerHTML = `
      <aside class="drawer" role="dialog" aria-modal="true">
        <div class="drawer__head">
          <div style="min-width:0">
            <div class="model-card__title-row">
              <span style="font-size:17px;font-weight:700;font-family:var(--mono);word-break:break-all">${esc(m.id)}</span>
              ${badge(isCustom ? '自定义' : '渠道', isCustom ? 'pink' : 'blue')}
            </div>
          </div>
          <button class="drawer__close" data-close aria-label="关闭">${icon('x', 17)}</button>
        </div>
        <div class="drawer__actions">
          <button class="btn btn--sm" data-act="copy">${icon('copy', 13)}复制模型 ID</button>
          <button class="btn btn--sm btn--primary" data-act="chat" ${m.available ? '' : 'disabled'}>${icon('chat', 13)}去对话</button>
        </div>
        <div class="drawer__body">
          ${m.description ? `<div class="drawer__section"><div class="alert alert--pink">${icon('info', 15)}<div>${esc(m.description)}</div></div></div>` : ''}

          <div class="drawer__section">
            <div class="section-title">基本信息</div>
            <dl class="kv">
              ${row('模型 ID', `<span class="mono">${esc(m.id)}</span>`)}
              ${row('类型', isCustom ? '自定义模型' : '渠道模型')}
              ${row('状态', statusHtml)}
              ${row('提供商', providerHtml)}
              ${row(isCustom ? '路由模型' : '来源', sourceHtml)}
              ${isCustom && m.routes && m.routes.length
                ? row('路由调度', (() => {
                    const gs = new Set(m.routes.filter((r) => r.group).map((r) => r.group)).size;
                    const parts = [gs ? `${gs} 个优先级组 / ${m.routes.length} 条路由` : `${m.routes.length} 条顺序路由（无分组）`];
                    if (m.affinity) parts.push('模型亲和');
                    if (m.cooldown_sec > 0) parts.push(`冷却 ${m.cooldown_sec}s`);
                    else parts.push('冷却 300s（默认）');
                    if (m.cooldown_reset) parts.push('全冷却自动重置');
                    return esc(parts.join(' · '));
                  })())
                : ''}
            </dl>
          </div>

          <div class="drawer__section">
            <div class="section-title">能力参数</div>
            <dl class="kv">
              ${row('上下文长度', caps.context_length
                ? `<b>${fmtContext(caps.context_length)}</b> tokens` : capBadge(undefined))}
              ${row('最大输出', caps.max_output
                ? `<b>${fmtInt(caps.max_output)}</b> tokens` : capBadge(undefined))}
              ${row('工具调用', capBadge(caps.tool_calling))}
              ${row('思考', capBadge(caps.thinking))}
              ${row('图片输入', capBadge(caps.vision))}
            </dl>
          </div>

          <div class="drawer__section">
            <div class="section-title">近 24 小时</div>
            <dl class="kv">
              ${row('调用次数', `<b>${fmtInt(m.requests_24h || 0)}</b> 次`)}
              ${row('失败次数', (m.errors_24h || 0) > 0
                ? `<b style="color:var(--red-500)">${fmtInt(m.errors_24h)}</b> 次`
                : '0 次')}
              ${row('成功率', m.success_rate >= 0
                ? `<b style="color:${rateColor(m.success_rate)}">${m.success_rate.toFixed(1)}%</b>`
                : '<span class="muted">暂无调用记录</span>')}
            </dl>
          </div>
        </div>
      </aside>`;

    const close = () => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      if (prev && prev.focus) prev.focus();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };

    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelector('[data-close]').onclick = close;
    backdrop.querySelector('[data-act=copy]').onclick = () => copyText(m.id, '模型 ID ');
    backdrop.querySelector('[data-act=chat]').onclick = () => {
      close();
      location.hash = '#/chat?model=' + encodeURIComponent(m.id);
    };

    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
    document.body.style.overflow = 'hidden';
  }

  // 模型管理页复用同一个详情抽屉。
  window.LDM.openModelDrawer = openModelDrawer;

  // ======================================================================
  // 在线对话
  // ======================================================================
  function rateColor(r) {
    r = Number(r) || 0;
    if (r >= 90) return 'var(--green-500)';
    if (r >= 80) return 'var(--blue-500)';
    if (r >= 70) return 'var(--amber-500)';
    return 'var(--red-500)';
  }

  // 对话状态放在页面外面：切到其它页面时请求继续在后台跑，
  // 回到对话页再把还在进行的流重新挂到新的气泡上。
  const CHAT_KEY = 'ldmapi.chat';
  const CHAT_MODEL_KEY = 'ldmapi.chat.model';
  const chatStore = {
    history: [],
    loaded: false,
    run: null,
    view: null,
    model: '',
  };
  let chatQuotaWarned = false;

  function loadChatHistory() {
    try {
      const raw = localStorage.getItem(CHAT_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function loadChatModel() {
    try {
      return localStorage.getItem(CHAT_MODEL_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function persistChatModel(id) {
    try {
      if (id) localStorage.setItem(CHAT_MODEL_KEY, id);
      else localStorage.removeItem(CHAT_MODEL_KEY);
    } catch (e) { /* 存储不可用时忽略 */ }
  }

  function persistChatHistory() {
    try {
      if (!chatStore.history.length) localStorage.removeItem(CHAT_KEY);
      else localStorage.setItem(CHAT_KEY, JSON.stringify(chatStore.history));
    } catch (e) {
      // 带图片/附件的对话可能超出 localStorage 配额：内存里继续可用，
      // 只提醒一次，避免每发一条都弹错误
      if (!chatQuotaWarned) {
        chatQuotaWarned = true;
        Toast.error('对话内容过大，无法保存到浏览器本地；刷新后附件可能丢失');
      }
    }
  }

  // 错误条目只用于回看和重试，永远不进入下一次请求的上下文
  function chatContext(list) {
    return (list || [])
      .filter((m) => m && !m.error && m.content != null && m.content !== '')
      .map((m) => ({ role: m.role, content: m.content }));
  }

  // 关标签页/刷新时浏览器会直接掐断请求，把已经生成的部分存下来，回来还能看到
  window.addEventListener('beforeunload', () => {
    const run = chatStore.run;
    if (!run || run.discarded || run.unloadSaved || (!run.answer && !run.think)) return;
    run.unloadSaved = true;
    const entry = { role: 'assistant', content: run.answer, model: run.sentModel.id, stopped: true };
    if (run.think) entry.think = run.think;
    entry.meta = [[`模型 ${run.sentModel.id}`], ['页面关闭，已停止生成']];
    if (run.sentModel.provider_icon) entry.provider_icon = run.sentModel.provider_icon;
    chatStore.history.push(entry);
    persistChatHistory();
  });

  window.LDM.registerPage('chat', {
    title: '在线对话',
    desc: '在线和可用模型对话',
    async render(root, actions) {
      const all = await State.loadModels(true);
      const usable = all.filter((m) => m.enabled && m.channel_ready);

      actions.innerHTML = `<button class="btn" id="chat-reload">${icon('refresh', 14)}刷新模型</button>`;
      actions.querySelector('#chat-reload').onclick = () => window.LDM.navigate();

      if (!usable.length) {
        root.innerHTML = `<div class="card">${emptyState(
          '还没有可用的模型',
          '先到「渠道管理」配置上游服务商，再到「模型管理」把模型添加进来，就能在这里对话了。',
          `<button class="btn btn--primary" id="go-models">${icon('plus', 15)}去添加模型</button>`,
          'chat'
        )}</div>`;
        root.querySelector('#go-models').onclick = () => { location.hash = '#/models'; };
        return;
      }

      const preset = window.LDM.routeParam('model') || chatStore.model || loadChatModel();
      const initial = usable.some((m) => m.id === preset) ? preset : usable[0].id;
      chatStore.model = initial;
      persistChatModel(initial);

      // 采样参数：每一项都能单独开关，关闭后不会出现在请求体里。
      // 默认值与 NewAPI 保持一致，减少迁移时的落差。
      const PARAM_KEY = 'ldmapi.chat.params';
      const paramDefs = [
        { key: 'temperature', label: '温度', min: 0, max: 2, step: 0.1, def: 0.7, on: true },
        { key: 'top_p', label: 'Top P', min: 0, max: 1, step: 0.05, def: 1, on: true },
        { key: 'max_tokens', label: '最大 Token', type: 'number', def: 4096, on: false },
        { key: 'frequency_penalty', label: '频率惩罚', min: -2, max: 2, step: 0.1, def: 0, on: true },
        { key: 'presence_penalty', label: '存在惩罚', min: -2, max: 2, step: 0.1, def: 0, on: true },
        { key: 'seed', label: '种子', type: 'number', def: '', on: false },
      ];
      const paramValues = {};
      const paramEnabled = {};
      paramDefs.forEach((p) => {
        paramValues[p.key] = p.def;
        paramEnabled[p.key] = p.on;
      });
      try {
        const saved = JSON.parse(localStorage.getItem(PARAM_KEY) || 'null');
        if (saved && typeof saved === 'object') {
          paramDefs.forEach((p) => {
            if (saved.values && saved.values[p.key] !== undefined && saved.values[p.key] !== null) {
              paramValues[p.key] = saved.values[p.key];
            }
            if (saved.enabled && typeof saved.enabled[p.key] === 'boolean') {
              paramEnabled[p.key] = saved.enabled[p.key];
            }
          });
        }
      } catch (e) { /* 存储不可用时使用默认值 */ }

      const paramRowHtml = (p) => {
        const value = paramValues[p.key];
        const shown = String(value === '' ? '—' : value);
        const control = p.type === 'number'
          ? `<input class="input input--sm chat-param__num" id="chat-param-${p.key}" type="number" min="0" step="1" value="${esc(String(value))}" placeholder="${p.key === 'seed' ? '留空则随机' : '不限制'}">`
          : `<input class="chat-range" id="chat-param-${p.key}" type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${esc(String(value))}">`;
        return `<div class="chat-param" data-param="${p.key}">
          <div class="chat-param__head">
            <span class="chat-param__label">${p.label}</span>
            <span class="chat-param__value" id="chat-param-${p.key}-value">${esc(shown)}</span>
            <div class="toolbar__spacer"></div>
            ${switchEl(paramEnabled[p.key], '', `id="chat-param-${p.key}-enable" title="开启后发送 ${p.key} 参数"`)}
          </div>
          ${control}
        </div>`;
      };

      root.classList.add('content__inner--fill');
      root.innerHTML = `
        <div class="card chat-card" id="chat-card">
          <div class="chat-layout" id="chat-layout">
            <div class="chat-side-scrim" id="chat-side-scrim"></div>
            <aside class="chat-side" id="chat-side">
              <div class="chat-side__head">
                ${icon('settings', 15)}
                <span class="chat-side__title">模型配置</span>
                <button class="btn btn--ghost btn--icon btn--sm chat-side__close" id="chat-side-close" title="收起设置" aria-label="收起设置">${icon('x', 15)}</button>
              </div>
              <div class="chat-side__body">
                <div class="chat-field chat-custom-toggle">
                  <div class="chat-switch-row">
                    <span class="chat-switch-row__label">自定义请求体</span>
                    ${switchEl(false, '', 'id="chat-custom-switch" title="开启后直接发送下方编辑的 JSON"')}
                  </div>
                </div>
                <div class="chat-fields" id="chat-normal-fields">
                  <div class="chat-field">
                    <label class="chat-field__label" for="chat-model">模型</label>
                    <select class="select" id="chat-model">
                      ${usable.map((m) => `<option value="${esc(m.id)}"${m.id === initial ? ' selected' : ''}>${esc(m.id)}</option>`).join('')}
                    </select>
                    <div class="chat-model-meta">
                      <span class="badge badge--pink" id="chat-kind"></span>
                      <span class="chat-route-row">
                        <span class="muted fs-12 chat-route-text" id="chat-route"></span>
                        <button class="btn btn--ghost btn--icon btn--sm chat-route-toggle" id="chat-route-toggle" title="展开" aria-label="展开" aria-expanded="false" hidden>${icon('chevron', 12)}</button>
                      </span>
                    </div>
                  </div>
                  <div class="chat-field">
                    <div class="chat-field__label">生成</div>
                    <div class="chat-switch-row">
                      <span class="chat-switch-row__label">流式输出</span>
                      ${switchEl(true, '', 'id="chat-stream" title="关闭后等完整回复再一次性显示"')}
                    </div>
                  </div>
                  <div class="chat-field">
                    <div class="chat-field__head">
                      <div class="chat-field__label">参数</div>
                      <button class="btn btn--ghost btn--sm chat-field__reset" id="chat-params-reset" title="恢复默认参数">${icon('refresh', 12)}重置</button>
                    </div>
                    <div class="chat-params">
                      ${paramDefs.map(paramRowHtml).join('')}
                    </div>
                  </div>
                </div>
                <div class="chat-custom" id="chat-custom" hidden>
                  <div class="chat-custom__head">
                    <span class="chat-custom__title">请求体 JSON</span>
                    <div class="toolbar__spacer"></div>
                    <button class="btn btn--sm" id="chat-custom-format">格式化</button>
                    <button class="btn btn--sm" id="chat-custom-reset">重置</button>
                  </div>
                  <div class="muted fs-12">发送时使用下方 JSON 原文；模型与流式以 JSON 为准，输入框的图片/附件不会自动加入</div>
                  <textarea class="textarea chat-custom__body" id="chat-custom-body" spellcheck="false" placeholder='{"model":"...","messages":[...],"stream":true}'></textarea>
                  <div class="chat-custom__hint muted fs-12" id="chat-custom-hint"></div>
                </div>
              </div>
              <div class="chat-side__foot">
                <button class="btn btn--sm btn--block" id="chat-clear">${icon('trash', 13)}清空对话</button>
              </div>
            </aside>
            <div class="chat-main">
              <div class="chat-mobile-bar">
                <button class="btn btn--ghost btn--icon" id="chat-side-toggle" title="展开设置" aria-label="展开设置">${icon('settings', 16)}</button>
                <select class="select chat-mobile-bar__model" id="chat-mobile-model" aria-label="模型">
                  ${usable.map((m) => `<option value="${esc(m.id)}"${m.id === initial ? ' selected' : ''}>${esc(m.id)}</option>`).join('')}
                </select>
                ${switchEl(true, '流式', 'id="chat-stream-top" title="流式输出"')}
              </div>
              <div class="chat-log" id="chat-log"></div>
              <div class="chat-compose">
                <div class="chat-attachments" id="chat-attachments"></div>
                <div class="chat-input">
                  <button class="btn btn--ghost btn--icon" id="chat-pick-image" title="添加图片">${icon('image', 16)}</button>
                  <button class="btn btn--ghost btn--icon" id="chat-pick-file" title="添加附件">${icon('paperclip', 16)}</button>
                  <textarea class="textarea" id="chat-text" rows="1" placeholder="输入消息，Enter 发送，Shift+Enter 换行；可粘贴或拖入图片/附件"></textarea>
                  <button class="btn btn--primary" id="chat-send">${icon('send', 14)}发送</button>
                </div>
              </div>
            </div>
          </div>
          <input type="file" id="chat-image-input" accept="image/*" multiple hidden>
          <input type="file" id="chat-file-input" multiple hidden>
        </div>`;

      const card = root.querySelector('#chat-card');
      const layout = root.querySelector('#chat-layout');
      const sideToggle = root.querySelector('#chat-side-toggle');
      const sideClose = root.querySelector('#chat-side-close');
      const sideScrim = root.querySelector('#chat-side-scrim');
      const mobileModelSel = root.querySelector('#chat-mobile-model');
      const modelSel = root.querySelector('#chat-model');
      const kindEl = root.querySelector('#chat-kind');
      const modelMeta = root.querySelector('.chat-model-meta');
      const routeEl = root.querySelector('#chat-route');
      const routeToggle = root.querySelector('#chat-route-toggle');
      const log = root.querySelector('#chat-log');
      const text = root.querySelector('#chat-text');
      // 触摸设备上程序化聚焦会弹出虚拟键盘，切模型 / 改开关后不应打断输入
      const focusText = () => { if (!isCoarsePointer) text.focus(); };
      const sendBtn = root.querySelector('#chat-send');
      const streamToggle = root.querySelector('#chat-stream');
      const streamInput = streamToggle.querySelector('input');
      const streamTop = root.querySelector('#chat-stream-top');
      const streamTopInput = streamTop.querySelector('input');
      const customSwitch = root.querySelector('#chat-custom-switch');
      const customSwitchInput = customSwitch.querySelector('input');
      const customPanel = root.querySelector('#chat-custom');
      const normalFields = root.querySelector('#chat-normal-fields');
      const customEditor = root.querySelector('#chat-custom-body');
      const customHint = root.querySelector('#chat-custom-hint');
      const paramsReset = root.querySelector('#chat-params-reset');
      const attWrap = root.querySelector('#chat-attachments');
      const imageInput = root.querySelector('#chat-image-input');
      const fileInput = root.querySelector('#chat-file-input');
      const pickImage = root.querySelector('#chat-pick-image');
      const pickFile = root.querySelector('#chat-pick-file');

      // 用户消息头像用站点图标；模型回复头像用该模型所属提供商的图标。
      const siteLogo = ((State.settings && State.settings.logo) || 'assets/logo.jpg').trim() || 'assets/logo.jpg';
      const avatarHtml = (role, providerIconKey) => {
        if (role === 'user') {
          return `<div class="msg__avatar msg__avatar--logo"><img src="${esc(siteLogo)}" alt=""></div>`;
        }
        if (providerIconKey) {
          return `<div class="msg__avatar msg__avatar--provider">${providerIcon(providerIconKey, 16)}</div>`;
        }
        return '<div class="msg__avatar">🐱</div>';
      };

      // 对话只有一份，存在页面外的 chatStore 里，切页面和后台请求共用
      const history = chatStore.history;
      if (!chatStore.loaded) {
        chatStore.loaded = true;
        history.push(...loadChatHistory());
      }
      let sending = false;
      // 暂存的图片/附件，发送后清空
      let staged = [];

      // 流式输出与自定义请求体开关记在本地
      const STREAM_KEY = 'ldmapi.chat.stream';
      const CUSTOM_KEY = 'ldmapi.chat.custom';
      let streaming = true;
      try { streaming = localStorage.getItem(STREAM_KEY) !== '0'; } catch (e) { /* 存储不可用时默认开启 */ }
      let customMode = false;
      try { customMode = localStorage.getItem(CUSTOM_KEY) === '1'; } catch (e) { /* 存储不可用 */ }
      // 流式开关在设置栏和收起后的顶栏各有一个，始终同步
      const setStreaming = (on) => {
        streaming = on;
        streamInput.checked = on;
        streamTopInput.checked = on;
        try { localStorage.setItem(STREAM_KEY, on ? '1' : '0'); } catch (e) { /* 忽略配额错误 */ }
      };
      setStreaming(streaming);
      streamInput.onchange = () => {
        setStreaming(streamInput.checked);
        focusText();
      };
      streamTopInput.onchange = () => {
        setStreaming(streamTopInput.checked);
        focusText();
      };

      const paramEls = paramDefs.map((p) => ({
        def: p,
        input: root.querySelector('#chat-param-' + p.key),
        enable: root.querySelector('#chat-param-' + p.key + '-enable'),
        value: root.querySelector('#chat-param-' + p.key + '-value'),
      }));

      const persistParams = () => {
        try {
          localStorage.setItem(PARAM_KEY, JSON.stringify({ values: paramValues, enabled: paramEnabled }));
        } catch (e) { /* 忽略配额错误 */ }
      };

      // 只收集开启且填了值的参数，关闭的参数不进入请求体
      const collectParams = () => {
        const out = {};
        paramEls.forEach((row) => {
          const key = row.def.key;
          if (!paramEnabled[key]) return;
          const raw = String(row.input.value).trim();
          if (raw === '') return;
          const num = Number(raw);
          if (!Number.isFinite(num)) return;
          out[key] = num;
        });
        return out;
      };

      // 关闭的参数置灰；发送中或自定义请求体模式下整组禁用
      const syncParamRow = (row) => {
        const on = paramEnabled[row.def.key];
        const locked = sending || customMode;
        const checkbox = row.enable.querySelector('input');
        checkbox.checked = on;
        checkbox.disabled = locked;
        row.enable.classList.toggle('is-disabled', locked);
        row.input.disabled = !on || locked;
        row.input.closest('.chat-param').classList.toggle('is-off', !on || customMode);
        const raw = String(row.input.value).trim();
        row.value.textContent = raw === '' ? '—' : raw;
      };
      const syncAllParams = () => paramEls.forEach(syncParamRow);

      // 桌面端可以收起设置栏；窄屏下这个状态不生效（窄屏用抽屉）
      const SIDE_KEY = 'ldmapi.chat.sidebar';
      try {
        if (localStorage.getItem(SIDE_KEY) === '0') layout.classList.add('is-settings-collapsed');
      } catch (e) { /* 存储不可用时保持展开 */ }

      const currentModel = () => usable.find((m) => m.id === modelSel.value) || usable[0];

      let routeExpanded = false;
      const setRouteExpanded = (on) => {
        routeExpanded = on;
        routeEl.classList.toggle('is-expanded', on);
        routeToggle.classList.toggle('is-expanded', on);
        modelMeta.classList.toggle('is-route-open', on);
        routeToggle.title = on ? '收起' : '展开';
        routeToggle.setAttribute('aria-label', on ? '收起' : '展开');
        routeToggle.setAttribute('aria-expanded', on ? 'true' : 'false');
        if (!on) requestAnimationFrame(syncRouteToggle);
      };

      // 路由一行显示不下时才出现展开按钮；展开状态下不重新测量
      const syncRouteToggle = () => {
        if (!routeEl.isConnected || routeExpanded) return;
        routeToggle.hidden = routeEl.scrollWidth <= routeEl.clientWidth + 1;
      };

      // 侧栏宽度变化或首次布局完成时都会触发，避免在页面还没排版时测错
      const routeObserver = typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(syncRouteToggle)
        : null;
      if (routeObserver) routeObserver.observe(routeEl);

      const setRouteText = (text) => {
        setRouteExpanded(false);
        routeEl.textContent = text;
        routeToggle.hidden = true;
        syncRouteToggle();
        requestAnimationFrame(syncRouteToggle);
      };

      const refreshMeta = () => {
        const m = currentModel();
        const isCustom = m.type === 'custom';
        kindEl.textContent = isCustom ? '自定义模型' : '渠道模型';
        if (isCustom) {
          const routes = (m.routes || []).map((r) => r.model_id);
          setRouteText('路由：' + (routes.length ? routes.join(' → ') : '未配置'));
        } else {
          setRouteText('来源：' + (m.channel_id || '') + (m.channel_name ? '（' + m.channel_name + '）' : ''));
        }
        mobileModelSel.value = m.id;
      };

      routeToggle.onclick = () => setRouteExpanded(!routeExpanded);

      // ---------- 内容渲染 ----------

      const fmtBytes = (n) => {
        n = Number(n) || 0;
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / (1024 * 1024)).toFixed(1) + ' MB';
      };

      const appendImage = (box, url) => {
        const link = document.createElement('a');
        link.className = 'msg__image-link';
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener';
        const img = document.createElement('img');
        img.className = 'msg__image';
        img.src = url;
        img.alt = '图片';
        img.loading = 'lazy';
        link.appendChild(img);
        box.appendChild(link);
      };

      // 精确判断文本 MIME。不能用 contains('xml')：docx 的
      // application/vnd.openxmlformats-... 里就带 xml，会被误判成文本。
      const isTextMime = (mime) => {
        const m = (mime || '').toLowerCase();
        return m.startsWith('text/')
          || m === 'application/json'
          || m === 'application/xml'
          || m === 'application/x-yaml'
          || m === 'application/yaml'
          || m === 'application/javascript'
          || m === 'application/x-javascript'
          || m === 'application/x-sh'
          || m === 'application/x-python'
          || m === 'application/x-httpd-php'
          || m.endsWith('+json')
          || m.endsWith('+xml');
      };

      // 附件统一显示成一张卡片；点击打开右侧抽屉预览。
      const attachmentKind = (att) => {
        if (att.kind === 'image') return 'image';
        if (att.kind === 'text' || att.text != null) return 'text';
        const mime = (att.mime || '').toLowerCase();
        if (mime === 'application/pdf' || /\.pdf$/i.test(att.name || '')) return 'pdf';
        if (mime.startsWith('image/')) return 'image';
        if (BINARY_EXT.test(att.name || '')) return 'other';
        if (att.kind === 'file') return isTextMime(mime) ? 'text' : 'other';
        if (isTextMime(mime) || TEXT_EXT.test(att.name || '')) return 'text';
        return 'other';
      };

      const attachmentLabel = (kind) => (
        kind === 'text' ? '文本' : kind === 'image' ? '图片' : kind === 'pdf' ? 'PDF' : '二进制'
      );

      const dataUrlToBlob = (data) => {
        if (typeof data !== 'string' || !data.startsWith('data:')) return null;
        const comma = data.indexOf(',');
        if (comma < 0) return null;
        const meta = data.slice(5, comma);
        const payload = data.slice(comma + 1);
        const mime = meta.split(';')[0] || 'application/octet-stream';
        try {
          if (/;base64/i.test(meta)) {
            const bin = atob(payload);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return new Blob([bytes], { type: mime });
          }
          return new Blob([decodeURIComponent(payload)], { type: mime });
        } catch (e) {
          return null;
        }
      };

      // 把 data URL 里的文本解码出来，供抽屉预览（自定义请求体里可能直接带文件）
      const dataUrlText = (data) => {
        if (typeof data !== 'string' || !data.startsWith('data:')) return '';
        const comma = data.indexOf(',');
        if (comma < 0) return '';
        const meta = data.slice(5, comma);
        const payload = data.slice(comma + 1);
        try {
          if (/;base64/i.test(meta)) {
            const bin = atob(payload);
            const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
            return new TextDecoder().decode(bytes);
          }
          return decodeURIComponent(payload);
        } catch (e) {
          return '';
        }
      };

      const openAttachmentDrawer = (att) => {
        const name = att.name || '附件';
        const mime = att.mime || '';
        const kind = attachmentKind(att);
        const sizeText = att.size ? fmtBytes(att.size) : '—';
        const prev = document.activeElement;

        const backdrop = document.createElement('div');
        backdrop.className = 'drawer-backdrop';
        backdrop.innerHTML = `
          <aside class="drawer" role="dialog" aria-modal="true">
            <div class="drawer__head">
              <div style="min-width:0">
                <div class="model-card__title-row">
                  <span style="font-size:16px;font-weight:700;word-break:break-all">${esc(name)}</span>
                  ${badge(attachmentLabel(kind), kind === 'text' ? 'blue' : kind === 'image' ? 'pink' : kind === 'pdf' ? 'amber' : 'gray')}
                </div>
              </div>
              <button class="drawer__close" data-close aria-label="关闭">${icon('x', 17)}</button>
            </div>
            <div class="drawer__actions" id="att-actions"></div>
            <div class="drawer__body">
              <div class="drawer__section">
                <div class="section-title">附件信息</div>
                <dl class="kv">
                  <dt>文件名</dt><dd>${esc(name)}</dd>
                  <dt>大小</dt><dd>${sizeText}</dd>
                  <dt>类型</dt><dd>${esc(mime || attachmentLabel(kind))}</dd>
                </dl>
              </div>
              <div class="drawer__section">
                <div class="section-title">预览</div>
                <div id="att-preview"></div>
              </div>
            </div>
          </aside>`;

        const preview = backdrop.querySelector('#att-preview');
        const tempUrls = [];
        let pdfHref = '';
        if (kind === 'text') {
          let text = att.text;
          if (text == null) text = dataUrlText(att.data || '');
          if (text) {
            const pre = document.createElement('pre');
            pre.className = 'attachment-preview';
            const limit = 200000;
            pre.textContent = text.length > limit
              ? text.slice(0, limit) + '\n\n…（内容过长，仅显示前 200000 个字符，下载后可查看完整内容）'
              : text;
            preview.appendChild(pre);
          } else {
            preview.innerHTML = '<div class="attachment-unsupported">'
              + `${icon('file', 30)}`
              + '<div class="attachment-unsupported__title">该附件没有可预览的文本</div>'
              + '</div>';
          }
        } else if (kind === 'image' && att.data) {
          const img = document.createElement('img');
          img.className = 'attachment-preview__image';
          img.src = att.data;
          img.alt = name;
          preview.appendChild(img);
        } else if (kind === 'pdf' && att.data) {
          // 浏览器内置 PDF 阅读器可以直接显示 Blob URL；
          // 比 data URL 可靠，也不会受远程地址的 X-Frame-Options 影响。
          pdfHref = att.data;
          if (String(pdfHref).startsWith('data:')) {
            const blob = dataUrlToBlob(pdfHref);
            if (blob) {
              pdfHref = URL.createObjectURL(blob);
              tempUrls.push(pdfHref);
            }
          }
          if (pdfHref) {
            const frame = document.createElement('iframe');
            frame.className = 'attachment-pdf';
            frame.src = pdfHref;
            frame.title = name;
            preview.appendChild(frame);
            const note = document.createElement('div');
            note.className = 'muted fs-12 mt-8';
            note.textContent = '如果预览空白，说明当前浏览器不支持内嵌 PDF，请下载后查看。';
            preview.appendChild(note);
          } else {
            preview.innerHTML = '<div class="attachment-unsupported">'
              + `${icon('file', 30)}`
              + '<div class="attachment-unsupported__title">PDF 解析失败</div>'
              + '<div class="muted fs-12">请下载后查看。</div>'
              + '</div>';
          }
        } else {
          preview.innerHTML = '<div class="attachment-unsupported">'
            + `${icon('file', 30)}`
            + '<div class="attachment-unsupported__title">该格式暂不支持在线预览</div>'
            + '<div class="muted fs-12">Word、压缩包等二进制文件请下载后查看。</div>'
            + '</div>';
        }

        const actions = backdrop.querySelector('#att-actions');
        let href = att.data || '';
        if (!href && att.text != null) {
          const url = URL.createObjectURL(new Blob([att.text], { type: att.mime || 'text/plain' }));
          tempUrls.push(url);
          href = url;
        }
        if (href && (String(href).startsWith('data:') || String(href).startsWith('blob:') || /^https?:\/\//.test(String(href)))) {
          const download = document.createElement('a');
          download.className = 'btn btn--sm btn--primary';
          download.href = href;
          download.download = name;
          download.target = '_blank';
          download.rel = 'noopener';
          download.innerHTML = icon('download', 13) + '下载附件';
          actions.appendChild(download);
        }
        if (kind === 'image' && att.data) {
          const open = document.createElement('a');
          open.className = 'btn btn--sm';
          open.href = att.data;
          open.target = '_blank';
          open.rel = 'noopener';
          open.innerHTML = icon('eye', 13) + '新标签页打开';
          actions.appendChild(open);
        }
        if (kind === 'pdf' && pdfHref) {
          const open = document.createElement('a');
          open.className = 'btn btn--sm';
          open.href = pdfHref;
          open.target = '_blank';
          open.rel = 'noopener';
          open.innerHTML = icon('eye', 13) + '新标签页打开';
          actions.appendChild(open);
        }

        const close = () => {
          backdrop.remove();
          document.removeEventListener('keydown', onKey);
          document.body.style.overflow = '';
          if (tempUrls.length) {
            setTimeout(() => tempUrls.forEach((u) => URL.revokeObjectURL(u)), 1000);
          }
          if (prev && prev.focus) prev.focus();
        };
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
        backdrop.querySelector('[data-close]').onclick = close;
        document.addEventListener('keydown', onKey);
        document.body.appendChild(backdrop);
        document.body.style.overflow = 'hidden';
      };

      const appendAttachment = (box, att) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'msg__file';
        chip.title = '查看附件';
        const ic = document.createElement('span');
        ic.className = 'msg__file-icon';
        ic.innerHTML = icon('file', 15);
        chip.appendChild(ic);
        const nm = document.createElement('span');
        nm.className = 'msg__file-name';
        nm.textContent = att.name || '附件';
        chip.appendChild(nm);
        const meta = document.createElement('span');
        meta.className = 'msg__file-meta';
        meta.textContent = att.size ? fmtBytes(att.size) : (att.mime || '附件');
        chip.appendChild(meta);
        chip.onclick = () => openAttachmentDrawer(att);
        box.appendChild(chip);
      };

      const appendTextPart = (box, t) => {
        if (!t) return;
        const el = document.createElement('div');
        el.className = 'msg__answer';
        el.textContent = t;
        box.appendChild(el);
      };

      // 把字符串或 OpenAI 多模态 content 数组渲染到气泡里
      const renderContent = (box, content, clear) => {
        if (clear !== false) box.innerHTML = '';
        if (content == null || content === '') return;
        if (typeof content === 'string') {
          appendTextPart(box, content);
          return;
        }
        if (!Array.isArray(content)) {
          appendTextPart(box, String(content));
          return;
        }
        for (const pv of content) {
          if (typeof pv === 'string') {
            appendTextPart(box, pv);
            continue;
          }
          if (!pv || typeof pv !== 'object') continue;
          const type = pv.type;
          if (type === 'text' || type === 'input_text') {
            appendTextPart(box, pv.text != null ? pv.text : pv.content);
          } else if (type === 'image_url' || type === 'input_image' || type === 'image') {
            let url = '';
            if (typeof pv.image_url === 'string') url = pv.image_url;
            else if (pv.image_url && pv.image_url.url) url = pv.image_url.url;
            else if (pv.url) url = pv.url;
            else if (pv.source && pv.source.type === 'base64' && pv.source.data) {
              url = `data:${pv.source.media_type || 'image/png'};base64,${pv.source.data}`;
            } else if (pv.source && pv.source.url) url = pv.source.url;
            if (url) appendImage(box, url);
          } else if (type === 'attachment') {
            const a = pv.attachment || pv;
            appendAttachment(box, {
              kind: a.kind || (a.text != null ? 'text' : 'file'),
              name: a.name || a.filename || '附件',
              mime: a.mime || a.mime_type || '',
              size: a.size,
              text: a.text,
              data: a.data || a.file_data || a.url || '',
            });
          } else if (type === 'file' || type === 'input_file' || type === 'document') {
            const f = pv.file && typeof pv.file === 'object' ? pv.file : pv;
            const name = f.filename || f.name || pv.filename || pv.title || '附件';
            let data = f.file_data || f.data || f.file_url || f.url || '';
            let mime = f.mime_type || pv.media_type || '';
            let text = null;
            if (!data && pv.source && typeof pv.source === 'object') {
              const src = pv.source;
              if (src.type === 'base64' && src.data) {
                data = `data:${src.media_type || 'application/octet-stream'};base64,${src.data}`;
                mime = mime || src.media_type || '';
              } else if (src.type === 'url' && src.url) {
                data = src.url;
              } else if (src.type === 'text' && src.data) {
                text = src.data;
                mime = mime || 'text/plain';
              }
            }
            if (text == null && isTextMime(mime) && !BINARY_EXT.test(name) && data) {
              text = dataUrlText(data);
            }
            appendAttachment(box, {
              kind: text != null ? 'text' : (mime.startsWith('image/') ? 'image' : 'file'),
              name,
              mime,
              data,
              text,
              size: data ? Math.round(String(data).length * 0.75) : (text ? new Blob([text]).size : 0),
            });
          }
        }
      };

      const flattenText = (content) => {
        if (typeof content === 'string') return content;
        if (!Array.isArray(content)) return content == null ? '' : String(content);
        return content
          .map((p) => {
            if (p && typeof p === 'object') {
              if (p.text != null) return p.text;
              if (p.content != null) return p.content;
              return '';
            }
            return String(p == null ? '' : p);
          })
          .filter(Boolean)
          .join('\n');
      };

      const lastUserContent = (messages) => {
        if (!Array.isArray(messages)) return '';
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m && m.role === 'user' && m.content != null) return m.content;
        }
        return '';
      };

      const addMsg = (role, content, isError, providerIconKey) => {
        const el = document.createElement('div');
        el.className = 'msg msg--' + (role === 'user' ? 'user' : 'assistant') + (isError ? ' msg--error' : '');
        el.innerHTML = avatarHtml(role, providerIconKey)
          + '<div class="msg__body"><div class="msg__bubble"></div></div>';
        renderContent(el.querySelector('.msg__bubble'), content);
        log.appendChild(el);
        log.scrollTop = log.scrollHeight;
        return el.querySelector('.msg__bubble');
      };

      // 在气泡下方追加统计信息。传入的是「组」的数组：
      // [输入相关]、[输出相关]、[耗时相关]，组内用 · 连接，组间用竖线分隔。
      const setMeta = (bubble, groups) => {
        if (!groups || !groups.length) return;
        const body = bubble.closest('.msg__body');
        if (!body) return;
        let el = body.querySelector('.msg__meta');
        if (!el) {
          el = document.createElement('div');
          el.className = 'msg__meta';
          body.appendChild(el);
        }
        el.innerHTML = groups
          .filter((g) => g && g.length)
          .map((g) => `<span class="msg__meta-group">${g.map((x) => esc(x)).join(' · ')}</span>`)
          .join('');
      };

      // 兼容早期版本存下来的扁平格式（一维字符串数组）
      const normalizeMeta = (m) => {
        if (!Array.isArray(m) || !m.length) return [];
        return typeof m[0] === 'string' ? [m] : m;
      };

      // 旧记录没存图标时，从统计信息里的「模型 xxx」反查当前提供商图标
      const storedProviderIcon = (m) => {
        if (m.provider_icon) return m.provider_icon;
        const flat = normalizeMeta(m.meta).reduce((acc, g) => acc.concat(g), []);
        const tag = flat.find((x) => typeof x === 'string' && x.startsWith('模型 '));
        const mid = tag ? tag.slice(3) : (m.model || '');
        const model = mid ? usable.find((x) => x.id === mid) : null;
        return (model && model.provider_icon) || '';
      };

      // 按存下来的数据结构重建一条消息（含思考折叠块）
      const renderStored = (m) => {
        const el = document.createElement('div');
        el.className = 'msg msg--' + (m.role === 'user' ? 'user' : 'assistant') + (m.error ? ' msg--error' : '');
        el.innerHTML = avatarHtml(m.role, m.role === 'user' ? '' : storedProviderIcon(m))
          + '<div class="msg__body"><div class="msg__bubble"></div></div>';
        const bubble = el.querySelector('.msg__bubble');
        if (m.role === 'assistant' && m.think) {
          const det = document.createElement('details');
          det.className = 'think-block';
          det.open = false;
          det.innerHTML = '<summary>深度思考<span class="think-block__meta"></span></summary>'
            + '<div class="think-block__body"></div>';
          det.querySelector('.think-block__meta').textContent = ` ${m.think.length} 字`;
          det.querySelector('.think-block__body').textContent = m.think;
          bubble.appendChild(det);
        }
        const contentEl = document.createElement('div');
        contentEl.className = 'msg__content';
        bubble.appendChild(contentEl);
        renderContent(contentEl, m.display || m.content || '');
        if (m.error) {
          const errEl = document.createElement('div');
          errEl.className = 'msg__error-text';
          errEl.textContent = m.error;
          contentEl.appendChild(errEl);
        }
        const groups = normalizeMeta(m.meta);
        if (groups.length) {
          const metaEl = document.createElement('div');
          metaEl.className = 'msg__meta';
          metaEl.innerHTML = groups
            .filter((g) => g && g.length)
            .map((g) => `<span class="msg__meta-group">${g.map((x) => esc(x)).join(' · ')}</span>`)
            .join('');
          el.querySelector('.msg__body').appendChild(metaEl);
        }
        if (m.role === 'assistant') addMessageActions(el, m);
        log.appendChild(el);
      };

      const reset = () => {
        // 清空时如果还有后台请求，先停掉并丢弃它的结果，避免往空历史里追加
        const run = chatStore.run;
        if (run) {
          run.discarded = true;
          run.view = null;
          run.bubble = null;
          run.msgEl = null;
          run.thinkBlock = run.thinkBody = run.thinkMeta = run.answerEl = null;
          run.ctl.abort();
          chatStore.run = null;
        }
        history.splice(0, history.length);
        staged = [];
        renderStaged();
        persistChatHistory();
        log.innerHTML = '';
        setBusy(false);
        if (customMode) syncCustomBody();
        refreshMeta();
      };

      // 进入页面时恢复上一次的对话（不生成任何占位消息）
      const restore = () => {
        log.innerHTML = '';
        refreshMeta();
        history.forEach(renderStored);
        // 后台请求还在跑：重建一个气泡，把流重新接上来
        const run = chatStore.run;
        if (run) {
          if (usable.some((m) => m.id === run.sentModel.id)) {
            chatStore.model = run.sentModel.id;
            persistChatModel(run.sentModel.id);
            modelSel.value = run.sentModel.id;
            mobileModelSel.value = run.sentModel.id;
            refreshMeta();
          }
          const bubble = addMsg('assistant', '', false, run.sentModel.provider_icon);
          run.attach(bubble, view);
          setBusy(true);
        }
        log.scrollTop = log.scrollHeight;
      };

      // 生成过程中发送按钮变成停止按钮，点击中断流式请求
      const setBusy = (busy) => {
        sending = busy;
        sendBtn.disabled = false;
        sendBtn.classList.toggle('btn--primary', !busy);
        sendBtn.classList.toggle('btn--danger', busy);
        sendBtn.innerHTML = busy ? icon('stop', 14) + '停止' : icon('send', 14) + '发送';
        sendBtn.title = busy ? '停止生成' : '';
        streamInput.disabled = busy || customMode;
        streamToggle.classList.toggle('is-disabled', busy || customMode);
        streamTopInput.disabled = busy || customMode;
        streamTop.classList.toggle('is-disabled', busy || customMode);
        modelSel.disabled = busy || customMode;
        mobileModelSel.disabled = busy || customMode;
        paramsReset.disabled = busy || customMode;
        syncAllParams();
        customSwitchInput.disabled = busy;
        customSwitch.classList.toggle('is-disabled', busy);
        customEditor.disabled = busy;
        pickImage.disabled = busy || customMode;
        pickFile.disabled = busy || customMode;
        log.querySelectorAll('[data-retry], [data-delete]').forEach((b) => { b.disabled = busy; });
      };

      const stopStream = () => {
        const run = chatStore.run;
        if (!run) return;
        run.ctl.abort();
      };

      const typingHtml = '<span class="typing"><span></span><span></span><span></span></span>';

      // 在 AI 消息下面加操作按钮：重试 / 复制 / 删除（纯图标）
      const addMessageActions = (msgEl, entry) => {
        const body = msgEl && msgEl.querySelector('.msg__body');
        if (!body || body.querySelector('.msg__actions')) return;
        const row = document.createElement('div');
        row.className = 'msg__actions';
        const makeBtn = (act, iconName, title, onclick) => {
          const btn = document.createElement('button');
          btn.className = 'btn btn--ghost btn--sm btn--icon';
          btn.dataset[act] = '1';
          btn.title = title;
          btn.setAttribute('aria-label', title);
          btn.innerHTML = icon(iconName, 12);
          btn.onclick = onclick;
          row.appendChild(btn);
          return btn;
        };
        makeBtn('retry', 'refresh', entry.error
          ? '重新生成这条回复（会移除这条之后的消息）'
          : '用当前选中的模型重新生成（会移除这条之后的消息）', () => retryAssistant(entry, msgEl));
        const copySource = entry.error
          ? ((entry.content ? entry.content + '\n\n' : '') + entry.error)
          : (entry.content || '');
        makeBtn('copy', 'copy', entry.error ? '复制错误信息' : '复制这条回复', () => copyText(copySource, entry.error ? '错误信息' : '回复内容'));
        makeBtn('delete', 'trash', '删除这一轮对话（含用户消息）', () => {
          const aiIdx = history.indexOf(entry);
          // 找到这条回复对应的用户消息，连同它一起删除
          let userEntry = null;
          if (aiIdx >= 0) {
            for (let i = aiIdx - 1; i >= 0; i--) {
              if (history[i].role === 'user') { userEntry = history[i]; break; }
            }
          }
          if (aiIdx >= 0) history.splice(aiIdx, 1);
          if (userEntry) {
            const userIdx = history.indexOf(userEntry);
            if (userIdx >= 0) history.splice(userIdx, 1);
          }
          persistChatHistory();
          // DOM 里同样移除这条回复和它前面的用户消息
          let prev = msgEl.previousElementSibling;
          while (prev && !prev.classList.contains('msg--user')) prev = prev.previousElementSibling;
          if (prev) prev.remove();
          msgEl.remove();
          Toast.success('这一轮对话已删除');
        });
        body.appendChild(row);
      };

      // ---------- 附件 ----------

      const MAX_FILE_BYTES = 20 * 1024 * 1024;
      const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
      const TEXT_MAX_BYTES = 2 * 1024 * 1024;
      const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|log|xml|ya?ml|html?|css|js|jsx|ts|tsx|py|go|java|c|h|cpp|hpp|cs|php|rb|rs|swift|kt|sql|sh|bash|zsh|ps1|ini|toml|conf|env|tex|srt|vtt)$/i;
      const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)$/i;
      // 即使 MIME 被识别成 text/plain，这些扩展名也按二进制处理，避免把正文读成乱码
      const BINARY_EXT = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|gz|tgz|bz2|xz|tar|png|jpe?g|gif|webp|bmp|svg|avif|heic|heif|mp3|wav|flac|ogg|m4a|mp4|mov|avi|mkv|webm|exe|dll|so|dylib|bin|iso|apk|ipa|woff2?|ttf|otf|eot)$/i;

      const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
      const stagedBytes = () => staged.reduce((n, a) => n + (a.size || 0), 0);
      const isImageFile = (f) => (f.type || '').startsWith('image/') || IMAGE_EXT.test(f.name || '');
      const isTextFile = (f) => {
        if (BINARY_EXT.test(f.name || '')) return false;
        return isTextMime(f.type) || TEXT_EXT.test(f.name || '');
      };
      const readDataURL = (f) => new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ''));
        r.onerror = () => reject(r.error || new Error('读取失败'));
        r.readAsDataURL(f);
      });
      const readText = (f) => new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ''));
        r.onerror = () => reject(r.error || new Error('读取失败'));
        r.readAsText(f);
      });
      const loadImage = (src) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片解码失败'));
        img.src = src;
      });

      // 图片先在浏览器里压到最长边 1600px，避免一次对话就把 localStorage 撑爆
      const compressImage = async (f) => {
        const original = await readDataURL(f);
        if (f.type === 'image/gif' || f.type === 'image/svg+xml') {
          return { data: original, size: f.size };
        }
        try {
          const img = await loadImage(original);
          const max = 1600;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          if (scale === 1 && f.size <= 700 * 1024) return { data: original, size: f.size };
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) return { data: original, size: f.size };
          const keepPng = f.type === 'image/png' && f.size <= 900 * 1024;
          if (!keepPng) {
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, w, h);
          }
          ctx.drawImage(img, 0, 0, w, h);
          const out = canvas.toDataURL(keepPng ? 'image/png' : 'image/jpeg', 0.86);
          return { data: out, size: Math.round(out.length * 0.75) };
        } catch (e) {
          return { data: original, size: f.size };
        }
      };

      const addFiles = async (files) => {
        const list = Array.from(files || []);
        if (!list.length) return;
        for (const f of list) {
          if (!f || !f.size) continue;
          if (f.size > MAX_FILE_BYTES) {
            Toast.error(`${f.name || '文件'} 超过 20MB，已跳过`);
            continue;
          }
          if (stagedBytes() + f.size > MAX_TOTAL_BYTES) {
            Toast.error('附件总大小超过 30MB，已停止添加');
            break;
          }
          try {
            if (isImageFile(f)) {
              const img = await compressImage(f);
              staged.push({
                id: uid(), kind: 'image', name: f.name || '图片', size: img.size,
                mime: f.type || 'image/png', data: img.data,
              });
            } else if (isTextFile(f)) {
              if (f.size > TEXT_MAX_BYTES) {
                Toast.error(`${f.name || '文本文件'} 超过 2MB，已跳过`);
                continue;
              }
              const content = await readText(f);
              staged.push({
                id: uid(), kind: 'text', name: f.name || '文本', size: f.size,
                mime: f.type || 'text/plain', text: content,
              });
            } else {
              const data = await readDataURL(f);
              staged.push({
                id: uid(), kind: 'file', name: f.name || '附件', size: f.size,
                mime: f.type || 'application/octet-stream', data,
              });
            }
          } catch (e) {
            Toast.error(`读取 ${f.name || '文件'} 失败`);
          }
        }
        renderStaged();
        focusText();
      };

      const renderStaged = () => {
        attWrap.innerHTML = '';
        staged.forEach((a) => {
          const el = document.createElement('div');
          el.className = 'chat-attachment';
          if (a.kind === 'image') {
            const img = document.createElement('img');
            img.className = 'chat-attachment__thumb';
            img.src = a.data;
            img.alt = '';
            el.appendChild(img);
          } else {
            const ic = document.createElement('span');
            ic.className = 'chat-attachment__icon';
            ic.innerHTML = icon('file', 15);
            el.appendChild(ic);
          }
          const name = document.createElement('span');
          name.className = 'chat-attachment__name';
          name.title = a.name;
          name.textContent = a.name;
          el.appendChild(name);
          const size = document.createElement('span');
          size.className = 'chat-attachment__size';
          size.textContent = fmtBytes(a.size);
          el.appendChild(size);
          const rm = document.createElement('button');
          rm.type = 'button';
          rm.className = 'chat-attachment__remove';
          rm.title = '移除';
          rm.innerHTML = icon('x', 12);
          rm.onclick = () => {
            staged = staged.filter((x) => x.id !== a.id);
            renderStaged();
          };
          el.appendChild(rm);
          attWrap.appendChild(el);
        });
        attWrap.classList.toggle('is-disabled', customMode);
      };

      // 把输入文字与暂存附件组装成 OpenAI 多模态 content
      const buildContent = (t) => {
        const parts = [];
        if (t) parts.push({ type: 'text', text: t });
        for (const a of staged) {
          if (a.kind === 'image') {
            parts.push({ type: 'image_url', image_url: { url: a.data } });
          } else if (a.kind === 'text') {
            parts.push({ type: 'text', text: `【附件：${a.name}】\n${a.text}` });
          } else {
            parts.push({ type: 'file', file: { filename: a.name, file_data: a.data } });
          }
        }
        if (!parts.length) return '';
        if (parts.length === 1 && parts[0].type === 'text' && !staged.length) return t;
        return parts;
      };

      // 界面展示用：附件只显示卡片，不把正文铺在气泡里。
      // history 里的 content 用于请求，display 用于回看。
      const buildDisplay = (t) => {
        const parts = [];
        if (t) parts.push({ type: 'text', text: t });
        for (const a of staged) {
          if (a.kind === 'image') {
            parts.push({ type: 'image_url', image_url: { url: a.data } });
          } else {
            parts.push({
              type: 'attachment',
              attachment: {
                kind: a.kind, name: a.name, mime: a.mime, size: a.size,
                text: a.kind === 'text' ? a.text : undefined,
                data: a.kind === 'file' ? a.data : undefined,
              },
            });
          }
        }
        if (!parts.length) return '';
        if (parts.length === 1 && parts[0].type === 'text' && !staged.length) return t;
        return parts;
      };

      // ---------- 自定义请求体 ----------

      const buildPayload = () => {
        const m = currentModel();
        return {
          model: m.id,
          messages: chatContext(history),
          stream: streaming,
          ...collectParams(),
        };
      };

      const syncCustomBody = () => {
        customEditor.value = JSON.stringify(buildPayload(), null, 2);
        updateCustomHint();
      };

      const updateCustomHint = () => {
        const raw = customEditor.value.trim();
        if (!raw) {
          customHint.textContent = '开启后会自动填入当前对话的请求体';
          customHint.classList.remove('is-error');
          return;
        }
        try {
          const p = JSON.parse(raw);
          const n = Array.isArray(p.messages) ? p.messages.length : 0;
          const model = typeof p.model === 'string' && p.model ? p.model : '未指定模型';
          customHint.textContent = `模型 ${model} · ${p.stream === true ? '流式' : '非流式'} · ${n} 条消息`;
          customHint.classList.remove('is-error');
        } catch (e) {
          customHint.textContent = 'JSON 格式错误：' + e.message;
          customHint.classList.add('is-error');
        }
      };
      const updateCustomHintDebounced = debounce(updateCustomHint, 150);

      const setCustomMode = (on) => {
        customMode = on;
        customSwitchInput.checked = on;
        customPanel.hidden = !on;
        // 自定义请求体模式下模型、流式与采样参数都由 JSON 决定，整组隐藏
        normalFields.hidden = on;
        try { localStorage.setItem(CUSTOM_KEY, on ? '1' : '0'); } catch (e) { /* 忽略 */ }
        if (on) {
          if (!customEditor.value.trim()) syncCustomBody();
          updateCustomHint();
        }
        modelSel.disabled = on || sending;
        mobileModelSel.disabled = on || sending;
        paramsReset.disabled = on || sending;
        syncAllParams();
        streamInput.disabled = on || sending;
        streamToggle.classList.toggle('is-disabled', on || sending);
        streamTopInput.disabled = on || sending;
        streamTop.classList.toggle('is-disabled', on || sending);
        customEditor.disabled = sending;
        pickImage.disabled = on || sending;
        pickFile.disabled = on || sending;
        attWrap.classList.toggle('is-disabled', on);
        if (!on) focusText();
      };

      // ---------- 请求 ----------

      // 只负责一次流式调用与气泡渲染，历史由调用方维护。
      // run 放在 chatStore 里，页面切走再回来时可以重新 attach 到新气泡。
      const streamAssistant = async (run, bubble, view) => {
        const sentModel = run.sentModel;
        const customBody = run.customBody;
        // 实际是否流式以响应头为准：自定义请求体可能不带 stream 字段，
        // 上游此时按非流式返回 JSON；普通模式也可能遇到上游不支持流式直接回 JSON。
        let useStream = customBody ? customBody.stream === true : streaming;
        const t0 = run.t0;
        const isAbort = (e) => (e && e.name === 'AbortError') || run.ctl.signal.aborted;
        const scrollLog = () => {
          const v = run.view;
          if (v && v.alive()) v.scroll();
        };

        const clearPlaceholder = () => {
          const b = run.bubble;
          if (!b) return;
          const typing = b.querySelector('.typing');
          if (typing) typing.remove();
        };
        const ensureThink = () => {
          const b = run.bubble;
          if (!b) return;
          if (run.thinkBlock && b.contains(run.thinkBlock)) return;
          clearPlaceholder();
          const det = document.createElement('details');
          det.className = 'think-block';
          det.open = !run.thinkFolded;
          det.innerHTML = '<summary>深度思考<span class="think-block__meta"></span></summary>'
            + '<div class="think-block__body"></div>';
          b.insertBefore(det, b.firstChild);
          run.thinkBlock = det;
          run.thinkBody = det.querySelector('.think-block__body');
          run.thinkMeta = det.querySelector('.think-block__meta');
          run.thinkMeta.textContent = run.answer ? ` ${run.think.length} 字` : ' 思考中…';
        };
        const ensureAnswer = () => {
          const b = run.bubble;
          if (!b) return;
          if (run.answerEl && b.contains(run.answerEl)) return;
          clearPlaceholder();
          run.answerEl = document.createElement('div');
          run.answerEl.className = 'msg__answer';
          b.appendChild(run.answerEl);
        };
        const paintThink = (thinking) => {
          if (!run.bubble) return;
          ensureThink();
          if (!run.thinkBody || !run.thinkMeta) return;
          run.thinkBody.textContent = run.think;
          if (thinking) run.thinkMeta.textContent = ` 思考中…（${run.think.length} 字）`;
          else run.thinkMeta.textContent = ` ${run.think.length} 字`;
        };
        const paintAnswer = () => {
          // 正文开始了就把思考块收起来，想看还能再点开
          if (run.think && !run.thinkFolded) {
            run.thinkFolded = true;
            if (run.thinkBlock) run.thinkBlock.open = false;
            if (run.bubble) paintThink(false);
          }
          if (!run.bubble) return;
          ensureAnswer();
          if (run.answerEl) run.answerEl.textContent = run.answer;
        };
        const paintFailure = (message) => {
          const b = run.bubble;
          if (!b) return;
          if (run.think) paintThink(false);
          if (run.answer) paintAnswer();
          if (!run.think && !run.answer) b.innerHTML = '';
          const errEl = document.createElement('div');
          errEl.className = 'msg__error-text';
          errEl.textContent = message;
          b.appendChild(errEl);
          const msg = b.closest('.msg');
          if (msg) msg.classList.add('msg--error');
        };

        // 页面切走再回来时，把累计内容重新画到新的气泡上
        run.attach = (b, v) => {
          run.bubble = b;
          run.msgEl = b.closest('.msg');
          run.view = v || null;
          run.thinkBlock = run.thinkBody = run.thinkMeta = run.answerEl = null;
          b.innerHTML = '';
          if (run.think) {
            ensureThink();
            if (run.thinkBlock) run.thinkBlock.open = !run.thinkFolded;
            paintThink(false);
          }
          if (run.answer) {
            ensureAnswer();
            if (run.answerEl) run.answerEl.textContent = run.answer;
          }
          if (!run.think && !run.answer) b.innerHTML = typingHtml;
        };
        run.attach(bubble, view);

        try {
          const payload = customBody
            ? { raw: customBody }
            : {
                model: sentModel.id,
                // 只发正文，思考内容和错误提示都不参与上下文
                messages: run.messages,
                stream: streaming,
                ...collectParams(),
              };
          const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            signal: run.ctl.signal,
            body: JSON.stringify(payload),
          });
          if (!res.ok) {
            let msg = `HTTP ${res.status}`;
            try {
              const j = await res.json();
              msg = (j.error && j.error.message) || msg;
            } catch (e) { /* 响应不是 JSON，保留状态码 */ }
            throw new Error(msg);
          }
          // 请求体里的 stream 只代表意愿，真正决定解析方式的是上游实际返回的类型
          useStream = (res.headers.get('content-type') || '').toLowerCase().includes('text/event-stream');
          if (!useStream) {
            // 非流式：等完整响应，思考与正文一次性渲染
            const j = await res.json();
            run.usage = j.usage || null;
            const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
            const reasoning = msg.reasoning_content || msg.reasoning || '';
            if (reasoning) {
              run.think = reasoning;
              run.thinkFolded = true;
              if (run.bubble) {
                ensureThink();
                if (run.thinkBlock) run.thinkBlock.open = false;
                paintThink(false);
              }
            }
            const content = flattenText(msg.content);
            if (content) {
              run.answer = content;
              if (run.bubble) {
                ensureAnswer();
                if (run.answerEl) run.answerEl.textContent = run.answer;
              }
            }
            scrollLog();
          } else {
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            for (;;) {
              let chunk;
              try {
                chunk = await reader.read();
              } catch (e) {
                // 主动停止：跳出循环，交给后面的收尾逻辑
                if (isAbort(e)) { run.stopped = true; break; }
                throw e;
              }
              if (chunk.done) break;
              buf += decoder.decode(chunk.value, { stream: true });
              const lines = buf.split('\n');
              buf = lines.pop();
              for (const line of lines) {
                const t = line.trim();
                if (!t.startsWith('data:')) continue;
                const data = t.slice(5).trim();
                if (data === '[DONE]') continue;
                let j;
                try { j = JSON.parse(data); } catch (e) { continue; }
                if (j.usage) run.usage = j.usage;
                const d = j.choices && j.choices[0] && j.choices[0].delta;
                if (!d) continue;
                if (!run.firstTokenMs && (d.reasoning_content || d.content)) {
                  run.firstTokenMs = Date.now() - t0;
                }
                if (d.reasoning_content) {
                  run.think += d.reasoning_content;
                  paintThink(true);
                }
                if (d.content) {
                  run.answer += d.content;
                  paintAnswer();
                }
              }
              scrollLog();
            }
          }
        } catch (e) {
          if (isAbort(e)) run.stopped = true;
          else run.failed = e;
        }

        if (run.failed) {
          const errorText = '调用失败：' + (run.failed.message || run.failed);
          paintFailure(errorText);
          const entry = {
            role: 'assistant',
            content: run.answer,
            display: run.answer,
            error: errorText,
            model: sentModel.id,
          };
          if (run.think) entry.think = run.think;
          if (customBody) entry.custom = true;
          if (sentModel.provider_icon) entry.provider_icon = sentModel.provider_icon;
          entry.meta = [[`模型 ${sentModel.id}`], ['调用失败'], [`总耗时 ${fmtDuration(Date.now() - t0)}`]];
          if (run.bubble) setMeta(run.bubble, entry.meta);
          return { ok: false, entry };
        }

        if (run.think && !run.thinkFolded) {
          run.thinkFolded = true;
          if (run.thinkBlock) run.thinkBlock.open = false;
          if (run.bubble) paintThink(false);
        }
        if (!run.answer && !run.think && run.bubble) {
          run.bubble.textContent = run.stopped ? '（已停止生成）' : '（模型没有返回内容）';
        }

        const totalMs = Date.now() - t0;
        const usage = run.usage;

        // 输入组：输入 token + 缓存命中
        const inputParts = [];
        if (usage) {
          if (usage.prompt_tokens) inputParts.push(`输入 ${fmtInt(usage.prompt_tokens)}`);
          const cached = (usage.prompt_tokens_details
            && usage.prompt_tokens_details.cached_tokens)
            || usage.prompt_cache_hit_tokens || 0;
          if (cached) inputParts.push(`缓存读 ${fmtInt(cached)}`);
        }

        // 输出组：输出 token、思考 token、速度
        const outputParts = [];
        if (usage) {
          if (usage.completion_tokens) outputParts.push(`输出 ${fmtInt(usage.completion_tokens)}`);
          const rt = usage.completion_tokens_details
            && usage.completion_tokens_details.reasoning_tokens;
          if (rt) outputParts.push(`思考 ${fmtInt(rt)}`);
          const genMs = totalMs - run.firstTokenMs;
          if (useStream && usage.completion_tokens && genMs > 0) {
            outputParts.push(`${(usage.completion_tokens * 1000 / genMs).toFixed(1)} t/s`);
          }
        }

        // 耗时组：首字、总耗时，总 token 跟在耗时后面
        const timingParts = [];
        if (run.firstTokenMs) timingParts.push(`首字 ${fmtDuration(run.firstTokenMs)}`);
        timingParts.push(`总耗时 ${fmtDuration(totalMs)}`);
        if (usage && usage.total_tokens) timingParts.push(`总token ${fmtInt(usage.total_tokens)}`);

        // 对话共用一份历史，所以在每条回复上标明用的是哪个模型
        const metaGroups = [[`模型 ${sentModel.id}`], inputParts, outputParts, timingParts]
          .filter((g) => g.length);
        if (run.stopped) metaGroups.push(['已停止生成']);
        if (run.bubble) setMeta(run.bubble, metaGroups);

        // 只把正文带回下一轮，思考内容与统计信息单独存起来用于回看
        if (run.answer || run.think) {
          const entry = { role: 'assistant', content: run.answer, model: sentModel.id };
          if (run.think) entry.think = run.think;
          if (metaGroups.length) entry.meta = metaGroups;
          if (sentModel.provider_icon) entry.provider_icon = sentModel.provider_icon;
          if (customBody) entry.custom = true;
          return { ok: true, entry };
        }
        return { ok: true, entry: null };
      };

      const finishRun = (run, res) => {
        if (res && res.entry && !run.discarded && !run.unloadSaved) {
          // 自定义请求体模式下编辑器里的 JSON 是下一次请求的唯一来源，
          // 回复必须写回它的 messages，否则下一轮会用旧请求体覆盖本地历史。
          if (res.ok && run.customBody && res.entry.content) {
            const msgs = run.customBody.messages;
            if (Array.isArray(msgs)) {
              msgs.push({ role: 'assistant', content: res.entry.content });
              // 页面切走时编辑器已经不在文档里，回来会按历史重新生成
              if (customEditor.isConnected) {
                customEditor.value = JSON.stringify(run.customBody, null, 2);
                updateCustomHint();
              }
            }
          }
          history.push(res.entry);
          persistChatHistory();
        }
        if (chatStore.run === run) chatStore.run = null;
        const v = run.view;
        if (v && v.alive()) {
          if (res && res.entry && run.msgEl) v.addActions(run.msgEl, res.entry);
          v.setBusy(false);
          v.scroll();
        }
      };

      // 新建一次请求：历史快照、气泡和 run 都交给 chatStore，
      // 页面切走时只解绑 DOM，不取消 fetch。
      const startRun = async ({ messages, sentModel, customBody }) => {
        if (chatStore.run) return null;
        const run = {
          messages, sentModel, customBody,
          ctl: new AbortController(),
          t0: Date.now(), firstTokenMs: 0, usage: null,
          think: '', answer: '', thinkFolded: false,
          stopped: false, failed: null,
          bubble: null, msgEl: null, view: null,
          entry: null, discarded: false, unloadSaved: false,
        };
        chatStore.run = run;
        if (usable.some((m) => m.id === sentModel.id)) {
          chatStore.model = sentModel.id;
          persistChatModel(sentModel.id);
          modelSel.value = sentModel.id;
          mobileModelSel.value = sentModel.id;
          refreshMeta();
        }
        setBusy(true);
        const bubble = addMsg('assistant', '', false, sentModel.provider_icon);
        bubble.innerHTML = typingHtml;
        const res = await streamAssistant(run, bubble, view);
        finishRun(run, res);
        return res;
      };

      const retryAssistant = async (entry, msgEl) => {
        if (sending || chatStore.run) return;
        if (customMode) {
          if (!entry.custom) {
            Toast.info('自定义请求体模式下请直接编辑 JSON 后发送');
            return;
          }
          // 自定义请求体：移除这条错误，再用编辑器里的 JSON 重发
          const idx = history.indexOf(entry);
          if (idx >= 0) history.splice(idx);
          persistChatHistory();
          const all = [...log.querySelectorAll('.msg')];
          const pos = all.indexOf(msgEl);
          if (pos >= 0) all.slice(pos).forEach((el) => el.remove());
          await doSendCustom(true);
          return;
        }
        const idx = history.indexOf(entry);
        if (idx < 0) return;
        // 用当前选中的模型重试，而不是这条消息生成时的模型
        const sentModel = currentModel();
        // 重试点之后的消息全部丢弃，保证上下文连续
        history.splice(idx);
        persistChatHistory();
        const all = [...log.querySelectorAll('.msg')];
        const pos = all.indexOf(msgEl);
        if (pos >= 0) all.slice(pos).forEach((el) => el.remove());
        await startRun({ messages: chatContext(history), sentModel });
      };

      const doSend = async () => {
        if (customMode) {
          await doSendCustom(false);
          return;
        }
        const v = text.value.trim();
        if ((!v && !staged.length) || sending || chatStore.run) return;
        // 先固定本轮使用的模型，避免流式过程中切换模型导致头像/统计错位
        const sentModel = currentModel();
        const content = buildContent(v);
        const display = buildDisplay(v);
        text.value = '';
        text.style.height = 'auto';
        addMsg('user', display);
        history.push({ role: 'user', content, display });
        persistChatHistory();
        staged = [];
        renderStaged();
        await startRun({ messages: chatContext(history), sentModel });
      };

      // 自定义模式：编辑器里的 JSON 是唯一事实来源；输入框有文字时追加成一条 user 消息
      const doSendCustom = async (retry) => {
        if (sending || chatStore.run) return;
        let payload;
        try {
          payload = JSON.parse(customEditor.value);
        } catch (e) {
          Toast.error('自定义请求体 JSON 解析失败：' + e.message);
          return;
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          Toast.error('自定义请求体必须是一个 JSON 对象');
          return;
        }
        if (typeof payload.model !== 'string' || !payload.model) {
          Toast.error('自定义请求体缺少 model 字段');
          return;
        }
        if (!Array.isArray(payload.messages)) {
          Toast.error('自定义请求体缺少 messages 数组');
          return;
        }
        const typed = text.value.trim();
        if (typed) {
          payload.messages.push({ role: 'user', content: typed });
          customEditor.value = JSON.stringify(payload, null, 2);
          updateCustomHint();
        }
        const sentModel = usable.find((m) => m.id === payload.model)
          || { id: payload.model, provider_icon: '', type: 'custom' };
        const shown = typed || lastUserContent(payload.messages) || '（自定义请求体）';
        text.value = '';
        text.style.height = 'auto';
        // 重试时不重复插入用户气泡，除非用户又输入了新内容
        if (!retry || typed) addMsg('user', shown);
        // 让本地历史与请求体保持一致，切回普通模式后可以接着聊
        history.splice(0, history.length, ...payload.messages
          .filter((m) => m && typeof m === 'object' && (m.role === 'user' || m.role === 'assistant'))
          .map((m) => ({ role: m.role, content: m.content })));
        persistChatHistory();
        await startRun({
          messages: chatContext(history), sentModel, customBody: payload,
        });
      };

      // ---------- 事件 ----------

      // 桌面端收起 / 展开设置栏；窄屏下改为抽屉开合
      const isNarrow = () => window.matchMedia('(max-width: 900px)').matches;
      const setSideOpen = (on) => {
        if (isNarrow()) {
          layout.classList.toggle('is-settings-open', on);
          return;
        }
        layout.classList.toggle('is-settings-collapsed', !on);
        try { localStorage.setItem(SIDE_KEY, on ? '1' : '0'); } catch (e) { /* 忽略配额错误 */ }
      };
      sideToggle.onclick = () => setSideOpen(true);
      sideClose.onclick = () => setSideOpen(false);
      sideScrim.onclick = () => setSideOpen(false);

      // 参数值变更与单项开关
      paramEls.forEach((row) => {
        row.input.addEventListener('input', () => {
          const raw = String(row.input.value).trim();
          paramValues[row.def.key] = raw === '' ? '' : Number(raw);
          row.value.textContent = raw === '' ? '—' : raw;
          persistParams();
        });
        row.enable.querySelector('input').onchange = () => {
          paramEnabled[row.def.key] = row.enable.querySelector('input').checked;
          syncParamRow(row);
          persistParams();
          focusText();
        };
      });

      // 恢复默认值与默认开关状态，并同步到本地存储
      paramsReset.onclick = () => {
        paramDefs.forEach((p) => {
          paramValues[p.key] = p.def;
          paramEnabled[p.key] = p.on;
          const row = paramEls.find((r) => r.def.key === p.key);
          if (row) row.input.value = String(p.def);
        });
        syncAllParams();
        persistParams();
        Toast.success('参数已恢复默认');
        focusText();
      };

      // 换模型只更新左侧的路由信息，已有的对话原样保留
      modelSel.onchange = () => {
        mobileModelSel.value = modelSel.value;
        chatStore.model = modelSel.value;
        persistChatModel(modelSel.value);
        refreshMeta();
        focusText();
      };
      // 收起设置栏后，顶部下拉框也能直接换模型
      mobileModelSel.onchange = () => {
        modelSel.value = mobileModelSel.value;
        chatStore.model = modelSel.value;
        persistChatModel(modelSel.value);
        refreshMeta();
        focusText();
      };
      sendBtn.onclick = () => {
        if (sending) stopStream();
        else doSend();
      };
      root.querySelector('#chat-clear').onclick = () => {
        if (history.length) {
          const ok = window.confirm('确定清空本地保存的对话记录吗？');
          if (!ok) return;
        }
        reset();
      };
      text.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
      });
      text.addEventListener('input', () => {
        text.style.height = 'auto';
        text.style.height = Math.min(text.scrollHeight, 150) + 'px';
      });

      // 图片/附件入口
      pickImage.onclick = () => imageInput.click();
      pickFile.onclick = () => fileInput.click();
      imageInput.onchange = () => {
        addFiles(imageInput.files);
        imageInput.value = '';
      };
      fileInput.onchange = () => {
        addFiles(fileInput.files);
        fileInput.value = '';
      };

      // 粘贴图片或文件
      text.addEventListener('paste', (e) => {
        if (customMode) return;
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        const files = [];
        for (const it of items) {
          if (it.kind !== 'file') continue;
          const f = it.getAsFile();
          if (f) files.push(f);
        }
        if (files.length) {
          e.preventDefault();
          addFiles(files);
        }
      });

      // 拖拽到整个对话卡片
      let dragDepth = 0;
      card.addEventListener('dragenter', (e) => {
        if (!e.dataTransfer) return;
        const types = Array.from(e.dataTransfer.types || []);
        if (!types.includes('Files')) return;
        e.preventDefault();
        dragDepth += 1;
        card.classList.add('is-dragover');
      });
      card.addEventListener('dragover', (e) => {
        if (!e.dataTransfer) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      });
      card.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) card.classList.remove('is-dragover');
      });
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        dragDepth = 0;
        card.classList.remove('is-dragover');
        if (customMode) {
          Toast.info('自定义请求体模式下请直接编辑 JSON');
          return;
        }
        addFiles(e.dataTransfer && e.dataTransfer.files);
      });

      // 自定义请求体开关与编辑
      customSwitchInput.onchange = () => setCustomMode(customSwitchInput.checked);
      customEditor.addEventListener('input', updateCustomHintDebounced);
      root.querySelector('#chat-custom-format').onclick = () => {
        try {
          customEditor.value = JSON.stringify(JSON.parse(customEditor.value), null, 2);
          updateCustomHint();
          Toast.success('已格式化');
        } catch (e) {
          Toast.error('JSON 解析失败：' + e.message);
        }
      };
      root.querySelector('#chat-custom-reset').onclick = () => {
        syncCustomBody();
        Toast.success('已重置为当前对话');
      };

      // 页面切走时只解绑 DOM，不中断请求；后台继续生成并写入历史
      const view = {
        alive: () => log.isConnected,
        setBusy,
        addActions: (msgEl, entry) => addMessageActions(msgEl, entry),
        scroll: () => { log.scrollTop = log.scrollHeight; },
      };
      chatStore.view = view;

      const onLeave = () => {
        if (routeObserver) routeObserver.disconnect();
        if (chatStore.view === view) chatStore.view = null;
        const run = chatStore.run;
        if (run && run.view === view) {
          run.view = null;
          run.bubble = null;
          run.msgEl = null;
          run.thinkBlock = run.thinkBody = run.thinkMeta = run.answerEl = null;
        }
      };
      window.addEventListener('hashchange', onLeave, { once: true });

      restore();
      setCustomMode(customMode);
      if (!isCoarsePointer) setTimeout(() => text.focus(), 120);
    },
  });

  // ======================================================================
  // 令牌管理
  // ======================================================================
  window.LDM.registerPage('tokens', {
    title: '令牌管理',
    desc: '管理 API 密钥',
    async render(root, actions) {
      const tokens = await State.loadTokens(true);

      actions.innerHTML = `<button class="btn btn--primary" id="btn-add-token">${icon('plus', 15)}创建密钥</button>`;
      actions.querySelector('#btn-add-token').onclick = () => openTokenEditor(null);

      const baseUrl = location.origin;

      root.innerHTML = `
        <div class="card mb-18">
          <div class="card__head">
            <div>
              <div class="card__title">如何使用</div>
              <div class="card__sub">网关兼容 OpenAI 协议，任何 OpenAI SDK 只需替换 base_url 与 api_key</div>
            </div>
          </div>
          <div class="card__body">
            <div class="code-block" id="usage-code">curl ${esc(baseUrl)}/v1/chat/completions \\
  -H "Authorization: Bearer ${esc(tokens[0] ? maskKey(tokens[0].key) : 'sk-ldm-...')}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${esc(State.models.find((m) => m.enabled)?.id || 'A/a')}", "messages": [{"role": "user", "content": "你好"}]}'</div>
            <div class="btn-row mt-12">
              <button class="btn btn--sm" id="copy-curl">${icon('copy', 13)}复制示例</button>
              <button class="btn btn--sm" id="copy-base">${icon('link', 13)}复制 Base URL</button>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card__head">
            <div class="card__title">密钥列表</div>
            <div class="card__sub">共 ${tokens.length} 个</div>
          </div>
          <div id="token-list"></div>
        </div>`;

      // 复制的是带真实密钥的版本，页面上显示的仍是掩码
      root.querySelector('#copy-curl').onclick = () => {
        let text = root.querySelector('#usage-code').textContent;
        if (tokens[0]) text = text.replace(maskKey(tokens[0].key), tokens[0].key);
        copyText(text, '示例命令 ');
      };
      root.querySelector('#copy-base').onclick = () => copyText(baseUrl + '/v1', 'Base URL ');

      const listHost = root.querySelector('#token-list');
      if (!tokens.length) {
        listHost.innerHTML = emptyState('还没有创建密钥', '创建一个密钥，就能用它调用所有已启用的模型。',
          `<button class="btn btn--primary" id="e-token">${icon('plus', 15)}创建密钥</button>`, 'tokens');
        listHost.querySelector('#e-token').onclick = () => openTokenEditor(null);
        return;
      }

      listHost.innerHTML = `<div class="table-wrap" style="border:none;border-radius:0">
        <table class="tbl">
          <thead><tr>
            <th>名称</th><th style="min-width:250px">密钥</th><th>状态</th>
            <th style="min-width:140px">用量</th><th>模型权限</th><th>IP 限制</th><th>最后使用</th><th style="width:150px"></th>
          </tr></thead>
          <tbody>${tokens.map((t) => {
            const pct = t.used_pct || 0;
            return `<tr>
              <td>
                <div class="strong">${esc(t.name)}</div>
                ${t.remark ? `<div class="muted fs-12">${esc(t.remark)}</div>` : ''}
              </td>
              <td>
                <div class="flex-center gap-6">
                  <span class="mono" style="font-size:11.5px" data-key-mask>${esc(maskKey(t.key))}</span>
                  <button class="btn btn--ghost btn--sm btn--icon" data-tact="reveal" data-tid="${esc(t.id)}" title="显示 / 隐藏">${icon('eye', 12)}</button>
                  <button class="btn btn--ghost btn--sm btn--icon" data-tact="copy" data-tid="${esc(t.id)}" title="复制密钥">${icon('copy', 12)}</button>
                </div>
              </td>
              <td>${t.expired ? badge('已过期', 'red') : (t.enabled ? statusBadge(true, '启用') : statusBadge(false, '', '禁用'))}</td>
              <td>
                <div class="num fs-12">${fmtNum(t.used_quota)}${t.quota_limit ? ` / ${fmtNum(t.quota_limit)}` : ' <span class="muted">/ 无限制</span>'}</div>
                ${t.quota_limit ? `<div class="rank-item__bar mt-8" style="height:4px"><div class="rank-item__fill" style="width:${pct}%;${pct > 90 ? 'background:var(--red-500)' : ''}"></div></div>` : ''}
              </td>
              <td>${!t.allowed_models || !t.allowed_models.length
                ? '<span class="muted fs-12">全部模型</span>'
                : `<div class="badge-group">${t.allowed_models.slice(0, 2).map((m) => badge(m, 'gray')).join('')}${t.allowed_models.length > 2 ? badge('+' + (t.allowed_models.length - 2), 'gray') : ''}</div>`}</td>
              <td>${!t.allowed_ips || !t.allowed_ips.length
                ? '<span class="muted fs-12">全部 IP</span>'
                : `<div class="badge-group">${t.allowed_ips.slice(0, 2).map((v) => badge(v, 'gray')).join('')}${t.allowed_ips.length > 2 ? badge('+' + (t.allowed_ips.length - 2), 'gray') : ''}</div>`}</td>
              <td class="muted fs-12 nowrap">${esc(relTime(t.last_used_at))}</td>
              <td>
                <div class="row-actions">
                  <button class="btn btn--sm btn--icon" data-tact="toggle" data-tid="${esc(t.id)}" title="${t.enabled ? '禁用' : '启用'}">${icon(t.enabled ? 'pause' : 'play', 13)}</button>
                  <button class="btn btn--sm btn--icon" data-tact="edit" data-tid="${esc(t.id)}" title="编辑">${icon('edit', 13)}</button>
                  <button class="btn btn--sm btn--icon btn--danger" data-tact="del" data-tid="${esc(t.id)}" title="删除">${icon('trash', 13)}</button>
                </div>
              </td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>`;

      listHost.querySelectorAll('[data-tact]').forEach((btn) => {
        btn.onclick = async () => {
          const t = tokens.find((x) => x.id === btn.dataset.tid);
          if (!t) return;
          const act = btn.dataset.tact;
          if (act === 'copy') copyText(t.key, '密钥 ');
          else if (act === 'reveal') {
            const el = btn.parentElement.querySelector('[data-key-mask]');
            const shown = el.dataset.shown === '1';
            el.textContent = shown ? maskKey(t.key) : t.key;
            el.dataset.shown = shown ? '0' : '1';
            btn.title = shown ? '显示 / 隐藏' : '点击隐藏';
          } else if (act === 'edit') openTokenEditor(t);
          else if (act === 'toggle') {
            try {
              await API.put('/api/tokens/' + t.id, { id: t.id, name: t.name, enabled: !t.enabled });
              Toast.success(`密钥「${t.name}」已${t.enabled ? '禁用' : '启用'}`);
              State.invalidate('tokens');
              window.LDM.navigate();
            } catch (e) { Toast.error(e.message); }
          } else if (act === 'del') {
            const ok = await confirmDialog({
              title: '删除密钥',
              message: `确定删除密钥「<b>${esc(t.name)}</b>」吗？使用该密钥的调用会立即失效。`,
              confirmText: '删除', danger: true,
            });
            if (!ok) return;
            try {
              await API.del('/api/tokens/' + t.id);
              Toast.success('密钥已删除');
              State.invalidate('tokens');
              window.LDM.navigate();
            } catch (e) { Toast.error(e.message); }
          }
        };
      });
    },
  });

  async function openTokenEditor(token) {
    const isNew = !token;
    const t = token || { name: '', enabled: true, expires_at: 0, quota_limit: 0, allowed_models: [], allowed_ips: [], remark: '' };
    // 模型权限复用「模型管理 → 添加模型」的选择弹窗（支持搜索、按渠道/提供商分组）
    let allowedSet = new Set(t.allowed_models || []);

    const expiryVal = t.expires_at ? new Date(t.expires_at).toISOString().slice(0, 10) : '';

    const body = `
      <div class="field">
        <label class="field__label">名称<span class="req">*</span></label>
        <input class="input" id="t-name" value="${esc(t.name)}" placeholder="例如：我的应用">
      </div>
      <div class="form-row">
        <div class="field">
          <label class="field__label">过期日期</label>
          <input class="input" id="t-expire" type="date" value="${esc(expiryVal)}">
          <div class="field__hint">留空表示永不过期。</div>
        </div>
        <div class="field">
          <label class="field__label">额度上限（Token 数）</label>
          <input class="input" id="t-quota" type="number" min="0" value="${t.quota_limit || ''}" placeholder="留空表示不限制">
        </div>
      </div>
      <div class="field">
        <label class="field__label">模型权限</label>
        <div class="field__hint" style="margin-top:0;margin-bottom:8px">不勾选表示可以使用全部模型；选中后点击模型名可复制。</div>
        <div id="t-model-summary"></div>
        <button class="btn btn--sm mt-8" id="t-pick-models">${icon('models', 13)}选择模型</button>
      </div>
      <div class="field">
        <label class="field__label">IP 限制</label>
        <textarea class="textarea" id="t-ips" rows="3" spellcheck="false" placeholder="每行一条，例如：&#10;192.168.1.10&#10;10.0.0.0/8&#10;203.0.113.*">${esc((t.allowed_ips || []).join('\n'))}</textarea>
        <div class="field__hint">留空表示不限制来源 IP；支持单个 IP、CIDR 网段和 IPv4 尾部通配（如 192.168.*）。</div>
      </div>
      <div class="field">
        <label class="field__label">备注</label>
        <input class="input" id="t-remark" value="${esc(t.remark || '')}" placeholder="可选">
      </div>
      ${!isNew ? `<div class="field">
        <label class="field__label">密钥</label>
        <div class="input-group">
          <input class="input mono" value="${esc(t.key)}" readonly>
          <button class="btn" data-act="copykey">${icon('copy', 14)}复制</button>
        </div>
      </div>` : ''}
      <div class="field">
        <label class="switch"><input type="checkbox" id="t-enabled" ${t.enabled ? 'checked' : ''}><span class="switch__track"></span><span class="switch__label">启用该密钥</span></label>
      </div>`;

    openModal({
      title: isNew ? '创建 API 密钥' : '编辑密钥',
      body,
      footer: `<div class="spacer"></div>
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn btn--primary" data-act="save">${isNew ? '创建' : '保存'}</button>`,
      onMount(mo) {
        const summaryEl = mo.body.querySelector('#t-model-summary');
        const renderAllowed = () => {
          summaryEl.innerHTML = allowedSet.size
            ? `<div class="badge-group" style="max-height:104px;overflow:auto">${Array.from(allowedSet).map((m) => `<button type="button" class="badge badge--gray badge--click mono" data-copy-model="${esc(m)}" title="点击复制">${esc(m)}</button>`).join('')}</div>`
            : '<span class="muted fs-12">全部模型</span>';
        };
        renderAllowed();
        summaryEl.addEventListener('click', (e) => {
          const el = e.target.closest('[data-copy-model]');
          if (el) copyText(el.dataset.copyModel, '模型名 ');
        });
        mo.body.querySelector('#t-pick-models').onclick = () => {
          if (!window.LDM.openModelPicker) { Toast.warn('模型选择弹窗暂不可用'); return; }
          window.LDM.openModelPicker({
            mode: 'models',
            title: '选择可用模型',
            desc: '从「模型管理」中已启用的模型里选择。不勾选表示可以使用全部模型。',
            top: true,
            preselected: new Set(allowedSet),
            onConfirm(ids) {
              allowedSet = new Set(ids);
              renderAllowed();
            },
          });
        };
        mo.foot.querySelector('[data-act=cancel]').onclick = () => mo.close();
        const copyBtn = mo.foot.querySelector('[data-act=copykey]');
        if (copyBtn) copyBtn.onclick = () => copyText(t.key, '密钥 ');
        mo.foot.querySelector('[data-act=save]').onclick = async () => {
          const name = mo.body.querySelector('#t-name').value.trim();
          if (!name) { Toast.warn('请填写名称'); return; }
          const expireVal2 = mo.body.querySelector('#t-expire').value;
          const payload = {
            id: t.id || '',
            name,
            enabled: mo.body.querySelector('#t-enabled').checked,
            expires_at: expireVal2 ? new Date(expireVal2 + 'T23:59:59').getTime() : 0,
            quota_limit: Number(mo.body.querySelector('#t-quota').value) || 0,
            allowed_models: Array.from(allowedSet),
            allowed_ips: mo.body.querySelector('#t-ips').value.split(/\r?\n/).map((v) => v.trim()).filter(Boolean),
            remark: mo.body.querySelector('#t-remark').value.trim(),
          };
          const btn = mo.foot.querySelector('[data-act=save]');
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner" style="width:13px;height:13px"></span>保存中';
          try {
            const res = await API.post('/api/tokens', payload);
            mo.close();
            if (isNew && res && res.key) {
              copyText(res.key, '新密钥 ');
              Toast.success('密钥已创建，已复制到剪贴板');
            } else {
              Toast.success('密钥已保存');
            }
            State.invalidate('tokens');
            window.LDM.navigate();
          } catch (e) {
            Toast.error(e.message, '保存失败');
            btn.disabled = false;
            btn.textContent = isNew ? '创建' : '保存';
          }
        };
      },
    });
  }

  // ======================================================================
  // 调用日志
  // ======================================================================
  const logState = { limit: 30, offset: 0, status: '', model: '', channel: '', token: '' };
  const LOG_UNIT_KEY = 'ldmapi.logs.unit';
  const logUnit = { on: true };
  try { logUnit.on = localStorage.getItem(LOG_UNIT_KEY) !== '0'; } catch (e) { /* 存储不可用时默认开启 */ }

  window.LDM.registerPage('logs', {
    title: '调用日志',
    desc: '每一次经过网关的请求都会记录在这里',
    async render(root, actions) {
      const [models, channels, tokens] = await Promise.all([
        State.loadModels().catch(() => []),
        State.loadChannels().catch(() => []),
        State.loadTokens().catch(() => []),
      ]);

      actions.innerHTML = `<button class="btn btn--danger" id="btn-clear-logs">${icon('trash', 14)}清空日志</button>`;
      actions.querySelector('#btn-clear-logs').onclick = async () => {
        const ok = await confirmDialog({
          title: '清空日志',
          message: '确定要清空全部调用日志吗？统计数据（看板）不会受影响。<br><br>该操作不可撤销。',
          confirmText: '清空', danger: true,
        });
        if (!ok) return;
        try {
          const res = await API.del('/api/logs');
          Toast.success(`已清空 ${res.removed} 条日志`);
          logState.offset = 0;
          load();
        } catch (e) { Toast.error(e.message); }
      };

      root.innerHTML = `
        <div class="card mb-18">
          <div class="toolbar">
            <select class="select" id="f-model" style="width:auto;min-width:150px">
              <option value="">全部模型</option>
              ${models.map((m) => `<option value="${esc(m.id)}">${esc(m.id)}</option>`).join('')}
            </select>
            <select class="select" id="f-channel" style="width:auto;min-width:130px">
              <option value="">全部渠道</option>
              ${channels.map((c) => `<option value="${esc(c.id)}">${esc(c.id)}${c.name ? '（' + esc(c.name) + '）' : ''}</option>`).join('')}
            </select>
            <select class="select" id="f-token" style="width:auto;min-width:130px">
              <option value="">全部密钥</option>
              ${tokens.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}
            </select>
            <select class="select" id="f-status" style="width:auto;min-width:110px">
              <option value="">全部状态</option>
              <option value="success">成功</option>
              <option value="error">失败</option>
              <option value="retry">有重试</option>
            </select>
            <div class="toolbar__spacer"></div>
            ${switchEl(logUnit.on, '单位', 'id="log-unit" title="开启后 Token 数按 K / M / B 显示，悬停可查看精确值"')}
            <button class="btn btn--sm" id="btn-reload">${icon('refresh', 13)}刷新</button>
          </div>
        </div>
        <div class="card">
          <div id="log-table">${loadingBlock()}</div>
          <div class="flex-center gap-12" style="padding:12px 16px;border-top:1px solid var(--border)">
            <span class="muted fs-12" id="log-total"></span>
            <div class="ml-auto flex gap-8">
              <button class="btn btn--sm" id="page-prev">上一页</button>
              <button class="btn btn--sm" id="page-next">下一页</button>
            </div>
          </div>
        </div>`;

      const q = (sel) => root.querySelector(sel);
      const channelName = {};
      channels.forEach((c) => { channelName[c.id] = c.name; });
      const channelLabel = (id) => id + (channelName[id] ? `（${channelName[id]}）` : '');
      q('#f-model').value = logState.model;
      q('#f-channel').value = logState.channel;
      q('#f-status').value = logState.status;
      q('#f-token').value = logState.token;

      q('#f-model').onchange = (e) => { logState.model = e.target.value; logState.offset = 0; load(); };
      q('#f-channel').onchange = (e) => { logState.channel = e.target.value; logState.offset = 0; load(); };
      q('#f-token').onchange = (e) => { logState.token = e.target.value; logState.offset = 0; load(); };
      q('#f-status').onchange = (e) => { logState.status = e.target.value; logState.offset = 0; load(); };
      q('#btn-reload').onclick = () => load();
      const unitInput = q('#log-unit').querySelector('input');
      unitInput.onchange = () => {
        logUnit.on = unitInput.checked;
        try { localStorage.setItem(LOG_UNIT_KEY, logUnit.on ? '1' : '0'); } catch (e) { /* 忽略配额错误 */ }
        renderTable();
      };
      q('#page-prev').onclick = () => {
        logState.offset = Math.max(0, logState.offset - logState.limit);
        load();
      };
      q('#page-next').onclick = () => {
        logState.offset += logState.limit;
        load();
      };

      // 重试历史分两层：先按渠道聚合（模型 → 渠道），渠道内试过多个 Key 时
      // 再下钻（渠道 → Key）。Key 备注在调度时随日志落库，不反查当前配置。
      function keyLabel(a) {
        if (!a.key_masked) return '—';
        const idx = `#${a.key_index || 1}`;
        return a.key_note ? `${idx} ${a.key_note}` : `${idx}（无备注）`;
      }

      function attemptBadge(a) {
        const ok = a.status_code > 0 && a.status_code < 400 && !a.error;
        const softFail = a.status_code > 0 && a.status_code < 400 && !!a.error;
        return ok ? badge('成功', 'green') : softFail ? badge(String(a.status_code), 'amber') : badge(String(a.status_code || '失败'), 'red');
      }

      function showKeyRetryHistory(l, group) {
        const rows = group.attempts.map((a, i) => `<tr>
            <td class="muted num">${i + 1}</td>
            <td class="mono" style="white-space:nowrap">${esc(a.upstream_model || '—')}</td>
            <td style="white-space:nowrap">${a.key_masked
              ? `<span style="position:relative;display:inline-block">${colorBadge(keyLabel(a), 'badge--xs')}${a.key_affinity ? `<span class="affinity-star affinity-star--sm" title="${KEY_AFFINITY_TITLE}">${AFFINITY_STAR}</span>` : ''}</span>`
              : '<span class="muted">—</span>'}</td>
            <td>${attemptBadge(a)}</td>
            <td class="right num">${esc(fmtDuration(a.latency_ms))}</td>
            <td class="fs-12" style="white-space:pre-wrap;word-break:break-word;min-width:320px">${a.error ? esc(a.error) : '<span class="muted">—</span>'}</td>
          </tr>`).join('');
        openModal({
          title: 'Key 重试信息',
          desc: `模型 <span class="mono">${esc(l.model_id || '—')}</span> · 渠道 <span class="mono">${esc(group.label)}</span> · 上游模型 <span class="mono">${esc(group.upstream)}</span> · 共 ${group.attempts.length} 次尝试`,
          size: 'xl',
          top: true,
          body: `<div class="table-wrap" style="border:none;border-radius:0">
            <table class="tbl">
              <thead><tr>
                <th style="width:40px">#</th><th>上游模型</th><th>Key</th>
                <th>状态码</th><th class="right">耗时</th><th style="width:52%">错误信息</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`,
          footer: `<div class="spacer"></div><button class="btn" data-close>关闭</button>`,
        });
      }

      function showRetryHistory(l) {
        const attempts = l.attempts || [];
        // 按「渠道 + 上游模型」聚合，保持第一次出现的顺序。同一渠道的不同上游
        // 模型分别成行；同一条路由内的多次 Key 尝试才合并，再按不同 Key 的数量下钻。
        const groups = [];
        const byRoute = new Map();
        attempts.forEach((a) => {
          const id = a.channel_id || '';
          const routeKey = id + '\u0000' + (a.upstream_model || '');
          let g = byRoute.get(routeKey);
          if (!g) {
            g = {
              label: id ? `${id}${a.channel_name ? '（' + a.channel_name + '）' : ''}` : '—',
              upstream: a.upstream_model || '—',
              attempts: [],
              keyIds: new Set(),
            };
            byRoute.set(routeKey, g);
            groups.push(g);
          }
          g.attempts.push(a);
          if (a.key_masked) g.keyIds.add(`${a.key_index || 1}|${a.key_masked}`);
        });
        const rows = groups.map((g, i) => {
          const last = g.attempts[g.attempts.length - 1];
          const totalMs = g.attempts.reduce((n, a) => n + (a.latency_ms || 0), 0);
          const canDrill = g.keyIds.size > 1;
          return `<tr>
            <td class="muted num">${i + 1}</td>
            <td class="mono" style="white-space:nowrap">${esc(g.label)}</td>
            <td class="mono fs-12" style="white-space:nowrap">${esc(g.upstream)}</td>
            <td class="num">${g.attempts.length}</td>
            <td>${attemptBadge(last)}</td>
            <td class="right num">${esc(fmtDuration(totalMs))}</td>
            <td class="fs-12" style="white-space:pre-wrap;word-break:break-word;min-width:300px">${last.error ? esc(last.error) : '<span class="muted">—</span>'}</td>
            <td>${canDrill
              ? `<button type="button" class="badge badge--amber badge--click" data-key-retry="${i}" title="查看该渠道模型的 Key 重试明细">${icon('refresh', 11)}Key 重试 ${g.attempts.length - 1}</button>`
              : '<span class="muted">—</span>'}</td>
          </tr>`;
        }).join('');
        const finalOK = logOK(l);
        openModal({
          title: '渠道重试信息',
          desc: `模型 <span class="mono">${esc(l.model_id || '—')}</span> · 共 ${groups.length} 条路由 · ${finalOK ? '最终成功' : '最终失败'}`,
          size: 'xl',
          body: attempts.length ? `<div class="table-wrap" style="border:none;border-radius:0">
            <table class="tbl">
              <thead><tr>
                <th style="width:40px">#</th><th style="min-width:160px">渠道</th><th>上游模型</th>
                <th class="right">尝试</th><th>最终状态</th><th class="right">耗时</th><th style="width:40%">最后错误</th><th>Key 重试</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>` : emptyState('没有尝试明细', '这条日志产生于旧版本，没有记录每次重试的明细。', '', 'refresh'),
          footer: `<div class="spacer"></div><button class="btn" data-close>关闭</button>`,
          onMount(mo) {
            mo.body.querySelectorAll('[data-key-retry]').forEach((btn) => {
              btn.onclick = () => showKeyRetryHistory(l, groups[Number(btn.dataset.keyRetry)]);
            });
          },
        });
      }

      let lastItems = null; // null 表示最近一次加载失败，切换单位时保持当前内容
      // 开启「单位」后把 token 数缩写为 K / M / B，悬停仍显示精确值
      const tok = (n) => (logUnit.on
        ? `<span title="${fmtInt(n)}">${fmtUnit(n)}</span>`
        : fmtInt(n));

      function renderTable() {
        if (lastItems == null) return;
        const host = q('#log-table');
        const items = lastItems;
        if (!items.length) {
          const emptyDesc = logState.status === 'error'
            ? '当前只看失败请求，把状态筛选切回「全部状态」试试。'
            : logState.status === 'success'
              ? '当前只看成功请求，把状态筛选切回「全部状态」试试。'
              : logState.status === 'retry'
                ? '当前只看发生过重试的请求，把状态筛选切回「全部状态」试试。'
                : '发起一次 API 调用后就能在这里看到记录。';
          host.innerHTML = emptyState('没有符合条件的日志', emptyDesc, '', 'logs');
          return;
        }
        host.innerHTML = `<div class="table-wrap table-scroll" style="border:none;border-radius:0">
          <table class="tbl">
            <thead><tr>
              <th>时间</th><th style="min-width:190px">模型</th><th style="min-width:140px">渠道</th><th>密钥</th>
              <th class="right" style="min-width:96px">输入</th>
              <th class="right" style="min-width:130px">输出</th>
              <th class="right" style="min-width:106px">耗时</th>
              <th>状态</th><th>来源 IP</th>
            </tr></thead>
            <tbody>${items.map((l, idx) => `<tr>
              <td class="nowrap muted fs-12">${esc(fmtTime(l.time))}</td>
              <td>
                <div class="flex-center gap-6" style="flex-wrap:wrap">
                  <span style="position:relative;display:inline-block">
                    ${colorBadge(l.model_id)}
                    ${l.affinity ? `<span class="affinity-star" title="${affinityTitle(l)}">${AFFINITY_STAR}</span>` : ''}
                  </span>
                  ${l.stream ? '<span class="badge badge--gray">流式</span>' : ''}
                  ${l.retries ? `<button type="button" class="badge badge--amber badge--click" data-attempts="${idx}" title="点击查看渠道重试历史">${icon('refresh', 11)}重试 ${l.retries}</button>` : ''}
                </div>
              </td>
              <td class="fs-12">
                ${l.channel_id
                  ? `${colorBadge(channelLabel(l.channel_id))}
                     ${l.upstream_model ? `<div class="muted fs-12 mono" style="margin-top:2px">${esc(l.upstream_model)}</div>` : ''}
                     ${l.key_masked ? `<div style="margin-top:2px"><span style="position:relative;display:inline-block">${colorBadge(keyLabel(l), 'badge--xs')}${l.key_affinity ? `<span class="affinity-star affinity-star--sm" title="${KEY_AFFINITY_TITLE}">${AFFINITY_STAR}</span>` : ''}</span></div>` : ''}`
                  : '<span class="muted">未命中渠道</span>'}
              </td>
              <td class="fs-12">${colorBadge(l.token_name)}</td>
              <td class="right num">${tok(l.prompt_tokens)}
                ${l.cached_tokens ? `<div class="muted fs-12">缓存读 ${tok(l.cached_tokens)}</div>` : ''}</td>
              <td class="right num">${tok(l.completion_tokens)}
                ${l.reasoning_tokens
                  ? `<div class="muted fs-12">思考 ${tok(l.reasoning_tokens)}</div>`
                  : (l.reasoning_chars ? `<div class="muted fs-12">思考 ${tok(l.reasoning_chars)} 字</div>` : '')}
                ${l.tokens_per_sec ? `<div class="muted fs-12">${l.tokens_per_sec.toFixed(1)} t/s</div>` : ''}</td>
              <td class="right num">${esc(fmtDuration(l.latency_ms))}
                ${l.first_byte_ms ? `<div class="muted fs-12">首字 ${esc(fmtDuration(l.first_byte_ms))}</div>` : ''}
                <div class="muted fs-12">总token ${tok(l.total_tokens)}</div></td>
              <td>${l.canceled
                ? `<button type="button" class="badge badge--amber badge--click" data-log-error="${idx}" title="${esc(l.error || '点击查看错误详情')}">${esc(l.status_code || 200)}</button>`
                : (logOK(l)
                  ? '<span class="badge badge--green">成功</span>'
                  : `<button type="button" class="badge badge--red badge--click" data-log-error="${idx}" title="${esc(l.error || '点击查看错误详情')}">${esc(l.status_code || '失败')}</button>`)}</td>
              <td class="muted fs-12 mono">${esc(l.ip || '—')}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>`;
        host.querySelectorAll('[data-attempts]').forEach((btn) => {
          btn.onclick = () => showRetryHistory(items[Number(btn.dataset.attempts)]);
        });
        host.querySelectorAll('[data-log-error]').forEach((btn) => {
          btn.onclick = () => showLogError(items[Number(btn.dataset.logError)]);
        });
      }

      async function load() {
        const host = q('#log-table');
        host.innerHTML = loadingBlock();
        const params = new URLSearchParams({
          limit: logState.limit, offset: logState.offset,
        });
        if (logState.model) params.set('model_id', logState.model);
        if (logState.channel) params.set('channel_id', logState.channel);
        if (logState.token) params.set('token_id', logState.token);
        if (logState.status) params.set('status', logState.status);
        try {
          const res = await API.get('/api/logs?' + params.toString());
          const items = res.items || [];
          lastItems = items;
          q('#log-total').textContent = `共 ${fmtInt(res.total)} 条，当前显示第 ${logState.offset + 1} - ${logState.offset + items.length} 条`;
          q('#page-prev').disabled = logState.offset === 0;
          q('#page-next').disabled = logState.offset + items.length >= res.total;
          renderTable();
        } catch (e) {
          lastItems = null;
          host.innerHTML = `<div class="card--pad"><div class="alert alert--warn">${icon('alert', 15)}<div>${esc(e.message)}</div></div></div>`;
        }
      }

      await load();
    },
  });

  // ======================================================================
  // 系统设置
  // ======================================================================
  window.LDM.registerPage('settings', {
    title: '系统设置',
    desc: '站点信息、外观与安全',
    async render(root, actions) {
      const [settings, me] = await Promise.all([
        API.get('/api/settings'),
        API.get('/api/auth/me'),
      ]);
      actions.innerHTML = '';

      const fmtMem = (n) => {
        n = Number(n) || 0;
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
        return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
      };

      const BACKUP_SCOPES = [
        ['channels', '渠道配置', '含明文上游 Key'],
        ['models', '模型配置', '路由与能力参数'],
        ['providers', '提供商', '名称、图标与匹配词'],
        ['tokens', 'API 密钥', '含明文 Key'],
        ['settings', '系统设置', '站点信息与密码哈希'],
        ['logs', '调用日志', '数据量大时较慢'],
        ['stats', '统计数据', '按小时聚合'],
      ];
      const BACKUP_LABELS = Object.fromEntries(BACKUP_SCOPES.map(([key, label]) => [key, label]));

      root.innerHTML = `
        ${me.default_password ? `<div class="alert alert--warn mb-18">${icon('alert', 16)}<div>
          <span class="strong">当前仍在使用默认密码 landamao</span><br>
          网关暴露在网络上时请务必立即修改，否则任何人都能进入控制台。
        </div></div>` : ''}

        <div class="chart-grid" style="grid-template-columns:1fr 1fr">
          <div class="card">
            <div class="card__head">
              <div><div class="card__title">站点信息</div><div class="card__sub">显示在侧边栏与浏览器标题</div></div>
            </div>
            <div class="card__body">
              <div class="field">
                <label class="field__label">站点名称</label>
                <input class="input" id="s-name" value="${esc(settings.site_name || '')}" placeholder="懒大猫 API">
              </div>
              <div class="field">
                <label class="field__label">副标题</label>
                <input class="input" id="s-sub" value="${esc(settings.site_subtitle || '')}" placeholder="模型聚合网关">
              </div>
              <div class="field">
                <label class="field__label">站点图标</label>
                <div class="input-group">
                  <input class="input mono" id="s-logo" value="${esc(settings.logo || '')}"
                         placeholder="留空使用默认图标，也可填图片直链">
                  <span class="brand__logo" id="s-logo-preview" style="width:36px;height:36px" title="预览"></span>
                </div>
                <div class="field__hint">支持任意图片直链（<code>https://…</code>）或 data URI；留空则用内置默认图标。</div>
              </div>
              <div class="field">
                <label class="field__label">外观主题</label>
                <div class="tristate" id="s-theme">
                  <div class="tristate__opt ${Theme.get() === 'light' ? 'is-on' : ''}" data-value="light">浅色</div>
                  <div class="tristate__opt ${Theme.get() === 'dark' ? 'is-on' : ''}" data-value="dark">深色</div>
                </div>
                <div class="field__hint">默认浅色主题（粉色）。此处的选择会立即生效并记住。</div>
              </div>
              <div class="field">
                <label class="field__label">日志保留天数</label>
                <input class="input" id="s-retention" type="number" min="0" value="${settings.log_retention_days || 0}" placeholder="0 表示永久保留">
                <div class="field__hint">超过天数的调用日志与统计数据会被自动清理；0 表示永久保留。</div>
              </div>
              <button class="btn btn--primary mt-8" id="s-save">${icon('check', 14)}保存设置</button>
            </div>
          </div>

          <div class="card">
            <div class="card__head">
              <div><div class="card__title">安全</div><div class="card__sub">管理端登录密码</div></div>
            </div>
            <div class="card__body">
              <div class="field">
                <label class="field__label">当前密码</label>
                <input class="input" id="p-old" type="password" placeholder="输入当前密码">
              </div>
              <div class="field">
                <label class="field__label">新密码</label>
                <input class="input" id="p-new" type="password" placeholder="至少 6 位">
              </div>
              <div class="field">
                <label class="field__label">确认新密码</label>
                <input class="input" id="p-new2" type="password" placeholder="再输入一次">
              </div>
              <button class="btn btn--primary mt-8" id="p-save">${icon('shield', 14)}修改密码</button>
              <div class="sep"></div>
              <button class="btn btn--danger btn--block" id="btn-logout">${icon('logout', 14)}退出登录</button>
            </div>
          </div>
        </div>

        <div class="card mt-16">
          <div class="card__head">
            <div><div class="card__title">备份导出</div><div class="card__sub">写入服务器本地 JSON，不经浏览器下载</div></div>
            <div class="card__actions">
              <label class="backup-check backup-check--all">
                <input type="checkbox" id="backup-all"><span><b>全选</b></span>
              </label>
            </div>
          </div>
          <div class="card__body">
            <div class="backup-scopes" id="backup-scopes">
              ${BACKUP_SCOPES.map(([key, label, hint]) => `
                <label class="backup-check">
                  <input type="checkbox" value="${key}">
                  <span><b>${label}</b><em>${hint}</em></span>
                </label>`).join('')}
            </div>
            <div class="alert alert--warn mt-12">
              ${icon('alert', 15)}
              <div>
                文件写入在运行网关的设备上（数据目录下的 <code>backups</code> 文件夹），
                为确保安全性，<b>无法通过浏览器下载</b>。文件包含明文上游 Key 和 API 密钥，请妥善保管。
                导出期间会暂停所有数据写入，直到导出完成。
              </div>
            </div>
            <div class="btn-row mt-12">
              <button class="btn btn--primary" id="backup-export">${icon('file', 14)}导出备份</button>
              <select class="select" id="backup-indent" aria-label="JSON 缩进" style="width:auto;min-width:132px">
                <option value="0">紧凑（无缩进）</option>
                <option value="2" selected>2 空格缩进</option>
                <option value="4">4 空格缩进</option>
              </select>
              <span class="muted fs-12">远程部署时请通过 SSH / SFTP 到该路径取回文件</span>
            </div>
            <div id="backup-result"></div>
          </div>
        </div>

        <div class="card mt-16">
          <div class="card__head">
            <div><div class="card__title">运行信息</div><div class="card__sub">当前实例状态</div></div>
          </div>
          <div class="card__body">
            <div class="stat-grid stat-grid--4" style="margin-bottom:0">
              <div class="stat">
                <div class="stat__label">版本</div>
                <div class="stat__value" style="font-size:19px">v${esc(me.version)}</div>
              </div>
              <div class="stat">
                <div class="stat__label">运行时间</div>
                <div class="stat__value" style="font-size:19px">${esc(fmtUptime(me.uptime_seconds))}</div>
              </div>
              <div class="stat">
                <div class="stat__label">系统</div>
                <div class="stat__value" style="font-size:19px">${esc(me.system || '—')}</div>
              </div>
              <div class="stat">
                <div class="stat__label">内存占用</div>
                <div class="stat__value" style="font-size:19px">${esc(fmtMem(me.memory_bytes))}</div>
              </div>
            </div>
          </div>
        </div>

        <div class="card mt-16">
          <div class="card__body" style="display:flex;align-items:center;justify-content:center;gap:5px;padding:14px 20px">
            <span class="muted fs-12">设计与开发由</span>
            <a href="https://github.com/landamao" target="_blank" rel="noopener noreferrer" class="strong">懒大猫</a>
          </div>
        </div>`;

      const q = (s) => root.querySelector(s);

      q('#s-theme').querySelectorAll('.tristate__opt').forEach((opt) => {
        opt.onclick = () => {
          q('#s-theme').querySelectorAll('.tristate__opt').forEach((x) => x.classList.remove('is-on'));
          opt.classList.add('is-on');
          Theme.apply(opt.dataset.value);
          const btn = document.getElementById('btn-theme');
          if (btn) {
            btn.innerHTML = `${window.LDM.icon(opt.dataset.value === 'light' ? 'moon' : 'sun', 14)}<span id="theme-label">${opt.dataset.value === 'light' ? '深色模式' : '浅色模式'}</span>`;
          }
          window.dispatchEvent(new CustomEvent('themechange'));
        };
      });

      // 图标预览跟随输入实时更新
      const logoInput = q('#s-logo');
      const logoPreview = q('#s-logo-preview');
      const syncPreview = () => {
        const url = logoInput.value.trim() || 'assets/logo.jpg';
        logoPreview.innerHTML = `<img src="${esc(url)}" alt="">`;
      };
      logoInput.addEventListener('input', debounce(syncPreview, 300));
      syncPreview();

      // 导出范围：全选框跟随子项状态，部分选中时显示为半选。
      const scopeInputs = Array.from(q('#backup-scopes').querySelectorAll('input[type="checkbox"]'));
      const allInput = q('#backup-all');
      const syncAll = () => {
        const checked = scopeInputs.filter((x) => x.checked).length;
        allInput.checked = checked === scopeInputs.length;
        allInput.indeterminate = checked > 0 && checked < scopeInputs.length;
      };
      allInput.onchange = () => {
        scopeInputs.forEach((x) => { x.checked = allInput.checked; });
        syncAll();
      };
      scopeInputs.forEach((x) => { x.onchange = syncAll; });
      syncAll();

      q('#backup-export').onclick = async () => {
        const scopes = scopeInputs.filter((x) => x.checked).map((x) => x.value);
        if (!scopes.length) {
          Toast.warn('请至少选择一个导出范围');
          return;
        }
        const btn = q('#backup-export');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner" style="width:13px;height:13px"></span>导出中';
        try {
          const indent = Number(q('#backup-indent').value) || 0;
          const res = await API.post('/api/backup/export', { scopes, indent });
          const counts = res.counts || {};
          const parts = Object.keys(counts)
            .map((key) => `${BACKUP_LABELS[key] || key} ${fmtInt(counts[key])}`);
          q('#backup-result').innerHTML = `
            <div class="backup-result">
              <div class="backup-result__head">${icon('check', 15)}<span>已导出 ${esc(res.file)}</span></div>
              <div class="backup-result__path mono">${esc(res.path)}</div>
              <div class="backup-result__meta">${fmtMem(res.size)}${parts.length ? ' · ' + esc(parts.join(' · ')) : ''}</div>
              <div class="btn-row mt-8">
                <button class="btn btn--sm" id="backup-copy">${icon('copy', 12)}复制路径</button>
              </div>
            </div>`;
          q('#backup-copy').onclick = () => copyText(res.path, '备份路径');
          Toast.success('备份已写入服务器本地');
        } catch (e) {
          Toast.error(e.message, '导出失败');
        } finally {
          btn.disabled = false;
          btn.innerHTML = window.LDM.icon('file', 14) + '导出备份';
        }
      };

      q('#s-save').onclick = async () => {
        const btn = q('#s-save');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner" style="width:13px;height:13px"></span>保存中';
        try {
          await API.put('/api/settings', {
            site_name: q('#s-name').value.trim(),
            site_subtitle: q('#s-sub').value.trim(),
            logo: q('#s-logo').value.trim(),
            theme: q('#s-theme .tristate__opt.is-on').dataset.value,
            log_retention_days: Number(q('#s-retention').value) || 0,
          });
          Toast.success('设置已保存');
          window.LDM.applyLogo(q('#s-logo').value.trim());
          document.getElementById('brand-name').textContent = q('#s-name').value.trim() || '懒大猫 API';
          document.getElementById('brand-sub').textContent = q('#s-sub').value.trim() || '模型聚合网关';
          document.title = (q('#s-name').value.trim() || '懒大猫 API') + ' · API 网关';
        } catch (e) {
          Toast.error(e.message, '保存失败');
        } finally {
          btn.disabled = false;
          btn.innerHTML = window.LDM.icon('check', 14) + '保存设置';
        }
      };

      q('#p-save').onclick = async () => {
        const oldP = q('#p-old').value;
        const newP = q('#p-new').value;
        const newP2 = q('#p-new2').value;
        if (!oldP || !newP) { Toast.warn('请填写完整的密码'); return; }
        if (newP.length < 6) { Toast.warn('新密码至少 6 位'); return; }
        if (newP !== newP2) { Toast.warn('两次输入的新密码不一致'); return; }
        const btn = q('#p-save');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner" style="width:13px;height:13px"></span>提交中';
        try {
          await API.post('/api/auth/password', { old_password: oldP, new_password: newP });
          Toast.success('密码已修改，请牢记新密码');
          q('#p-old').value = q('#p-new').value = q('#p-new2').value = '';
        } catch (e) {
          Toast.error(e.message, '修改失败');
        } finally {
          btn.disabled = false;
          btn.innerHTML = window.LDM.icon('shield', 14) + '修改密码';
        }
      };

      q('#btn-logout').onclick = async () => {
        const ok = await confirmDialog({ title: '退出登录', message: '确定要退出管理端吗？', confirmText: '退出' });
        if (ok) window.LDM.logout();
      };
    },
  });
})();
