/* ==========================================================================
   用量数据：数据看板 / 渠道用量 / 调用日志
   —— 三个视图挂在同一级入口下，用左侧竖排小导航切换（原来它们分散在侧边栏）。
      图表、单位、时间区间、日志表都沿用线上口径与组件。
   ========================================================================== */
(function () {
  'use strict';

  const {
    esc, icon, fmtInt, fmtNum, fmtTime, fmtDuration, fmtUnit, relTime,
    badge, copyBadge, colorBadge, Toast, openModal, switchEl, debounce,
  } = window.PV;
  const D = window.PVDATA;
  const Charts = window.Charts;

  // ---------- 单位 ----------
  const UNITS = [
    ['cn', '中文单位 万/亿'],
    ['en', '英文单位 K/M'],
    ['raw', '完整数字'],
  ];
  function fmtByUnit(n, unit) {
    n = Number(n) || 0;
    if (unit === 'en') return fmtNum(n);
    if (unit === 'raw') return fmtInt(n);
    const abs = Math.abs(n);
    if (abs >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
    if (abs >= 1e4) return (n / 1e4).toFixed(abs >= 1e6 ? 0 : 1) + ' 万';
    return fmtInt(n);
  }

  // ---------- 时间区间 ----------
  const PRESETS = [
    ['today', '今日'],
    ['yesterday', '昨日'],
    ['7d', '近 7 天'],
    ['30d', '近 30 天'],
    ['all', '全部时间'],
    ['custom', '自定义'],
  ];
  const RANGE_LABEL = { today: '今日', yesterday: '昨日', '7d': '近 7 天', '30d': '近 30 天', all: '累计', custom: '区间' };
  const RANGE_COMPARE = { today: '较昨日同期', yesterday: '较前日同期', '7d': '较前 7 天', '30d': '较前 30 天', custom: '较上一周期' };

  function pad(n) { return String(n).padStart(2, '0'); }
  function toLocalInput(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fromLocalInput(v) {
    if (!v) return 0;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : 0;
  }
  function defaultRange(preset) {
    const [s, e] = D.rangeBounds(preset);
    return { start: s, end: e };
  }
  function timeLabel(ms, span) {
    const d = new Date(ms);
    if (span > 36 * 3600000) return `${d.getMonth() + 1}/${d.getDate()}`;
    return `${pad(d.getHours())}:00`;
  }

  let dashState = { preset: 'today', unit: 'cn', metric: 'requests', view: 'all', model: '', start: 0, end: 0 };
  let usageState = { channel: '', preset: 'today', unit: 'cn', metric: 'tokens', start: 0, end: 0 };
  let logState = {
    model: '', channel: '', token: '', status: '', preset: 'today',
    start: 0, end: 0, offset: 0, limit: 30, unit: true,
  };
  (function initRanges() {
    dashState.start = defaultRange('today').start;
    usageState.start = defaultRange('today').start;
    logState.start = defaultRange('today').start;
  })();

  let ui = null;
  let subView = 'board';

  // ---------- 三视图外壳 ----------
  function render(root, sub) {
    subView = ['board', 'channel', 'logs'].includes(sub) ? sub : 'board';
    if (!dashState.start) dashState.start = defaultRange('today').start;
    if (!usageState.start) usageState.start = defaultRange('today').start;
    if (!logState.start) logState.start = defaultRange('today').start;

    root.innerHTML = `
      <div class="usage-shell">
        <aside class="usage-rail">
          <div class="usage-rail__title">用量数据</div>
          <button class="usage-rail__item" data-sub="board">${icon('dashboard', 16)}数据看板</button>
          <button class="usage-rail__item" data-sub="channel">${icon('server', 16)}渠道用量</button>
          <button class="usage-rail__item" data-sub="logs">${icon('logs', 16)}调用日志</button>
          <div class="usage-rail__meta">统计按北京时间自然日聚合，日志保留最近 ${D.settings.log_retention_days} 天。</div>
        </aside>
        <section class="usage-body" id="usage-body"></section>
      </div>`;

    root.querySelectorAll('[data-sub]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.sub === subView);
      btn.onclick = () => {
        if (subView === btn.dataset.sub) return;
        window.PVNavigate('#/usage/' + btn.dataset.sub);
      };
    });

    ui = { body: root.querySelector('#usage-body') };
    if (subView === 'board') renderDashboard();
    else if (subView === 'channel') renderChannelUsage();
    else renderLogs();
  }

  // ---------- 公共片段 ----------
  function rangeControls(idPrefix, state, onChange) {
    return `
      <select class="select" id="${idPrefix}-preset" style="width:118px" aria-label="统计区间">
        ${PRESETS.map(([v, t]) => `<option value="${v}"${state.preset === v ? ' selected' : ''}>${t}</option>`).join('')}
      </select>
      <input class="input" type="datetime-local" id="${idPrefix}-start" style="width:176px" value="${toLocalInput(state.start)}" title="开始时间">
      <input class="input" type="datetime-local" id="${idPrefix}-end" style="width:176px" value="${toLocalInput(state.end)}" title="留空表示到此刻">
      <select class="select" id="${idPrefix}-unit" style="width:136px" aria-label="数字单位">
        ${UNITS.map(([v, t]) => `<option value="${v}"${state.unit === v ? ' selected' : ''}>${t}</option>`).join('')}
      </select>
      <button class="btn btn--sm" id="${idPrefix}-refresh">${icon('refresh', 13)}刷新</button>`;

    const bind = () => {
      const q = (id) => document.getElementById(idPrefix + '-' + id);
      q('preset').onchange = () => {
        state.preset = q('preset').value;
        if (state.preset !== 'custom') {
          const b = defaultRange(state.preset);
          state.start = b.start;
          state.end = b.end;
          q('start').value = toLocalInput(b.start);
          q('end').value = toLocalInput(b.end);
        }
        onChange();
      };
      q('unit').onchange = () => {
        state.unit = q('unit').value;
        onChange();
      };
      const applyTime = () => {
        const s = fromLocalInput(q('start').value);
        const e = fromLocalInput(q('end').value);
        if (s && e && e < s) {
          Toast.warn('结束时间不能早于开始时间');
          q('start').value = toLocalInput(state.start);
          q('end').value = toLocalInput(state.end);
          return;
        }
        state.start = s;
        state.end = e;
        state.preset = !s && !e ? 'all' : 'custom';
        q('preset').value = state.preset;
        onChange();
      };
      q('start').onchange = applyTime;
      q('end').onchange = applyTime;
      q('start').onkeydown = (e) => { if (e.key === 'Enter') applyTime(); };
      q('end').onkeydown = (e) => { if (e.key === 'Enter') applyTime(); };
      q('refresh').onclick = onChange;
    };
    setTimeout(bind, 0);
  }

  function statCard(label, value, unitText, foot, tone) {
    return `<div class="stat">
      <div class="stat__label">${esc(label)}</div>
      <div class="stat__value">${value}${unitText ? `<small>${esc(unitText)}</small>` : ''}</div>
      <div class="stat__foot">${foot || '&nbsp;'}</div>
    </div>`;
  }

  function deltaHtml(cur, prev, label) {
    if (prev == null) return `<span class="muted">${esc(label)}</span>`;
    if (!prev && !cur) return `<span class="muted">${esc(label)} 持平</span>`;
    if (!prev && cur) return `<span class="stat__delta up">新增</span> <span class="muted">${esc(label)}</span>`;
    const pct = ((cur - prev) / prev) * 100;
    const up = pct >= 0;
    return `<span class="stat__delta ${up ? 'up' : 'down'}">${up ? '↑' : '↓'} ${Math.abs(pct).toFixed(1)}%</span> <span class="muted">${esc(label)}</span>`;
  }

  function rateColor(rate) {
    if (rate >= 90) return 'var(--leaf-600)';
    if (rate >= 80) return 'var(--sky-500)';
    if (rate >= 70) return 'var(--sun-500)';
    return 'var(--mushroom-500)';
  }

  // ======================================================================
  // 数据看板
  // ======================================================================
  function renderDashboard() {
    const label = RANGE_LABEL[dashState.preset] || '区间';
    ui.body.innerHTML = `
      <div class="page-head">
        <div class="page-head__titles">
          <div class="page-head__title">${icon('dashboard', 20)}数据看板</div>
          <div class="page-head__desc">请求、Token、成功率与路由分布 · 按北京时间聚合</div>
        </div>
        <div class="page-head__actions">${rangeControls('dash', dashState, loadDashboard)}</div>
      </div>
      <div class="stat-grid stat-grid--4" id="dash-stats"></div>
      <div class="tool-row" style="margin-top:16px">
        <div class="pill-toggle" id="dash-metric">
          <button data-m="requests" class="${dashState.metric === 'requests' ? 'is-on' : ''}">请求数</button>
          <button data-m="tokens" class="${dashState.metric === 'tokens' ? 'is-on' : ''}">Token</button>
        </div>
        <span class="tool-count" id="dash-view-label">全部模型</span>
        <span class="tool-row__spacer"></span>
        <span class="tool-count" id="dash-stamp"></span>
      </div>
      <div class="dash-grid">
        <div class="plain-block">
          <div class="plain-block__head">
            <span class="plain-block__title">调用趋势</span>
            <span class="plain-block__sub" id="dash-trend-sub"></span>
          </div>
          <div class="chart-box" id="dash-trend"></div>
          <div class="dash-legend" id="dash-legend"></div>
        </div>
        <div class="plain-block">
          <div class="plain-block__head">
            <span class="plain-block__title">模型调用分布</span>
            <span class="plain-block__sub" id="dash-donut-sub"></span>
          </div>
          <div class="chart-box" id="dash-donut"></div>
        </div>
      </div>
      <div class="dash-grid">
        <div class="plain-block">
          <div class="plain-block__head">
            <span class="plain-block__title" id="dash-ch-title">渠道调用量</span>
            <span class="plain-block__sub">按渠道 ID 聚合</span>
          </div>
          <div class="chart-box" id="dash-ch-rank"></div>
        </div>
        <div class="plain-block">
          <div class="plain-block__head">
            <span class="plain-block__title" id="dash-key-title">密钥调用量</span>
            <span class="plain-block__sub">按令牌名称聚合</span>
          </div>
          <div class="chart-box" id="dash-key-rank"></div>
        </div>
      </div>
      <div class="dash-logs">
        <div class="plain-block__head">
          <span class="plain-block__title">最近调用</span>
          <span class="plain-block__sub">不随统计区间变化</span>
          <div class="plain-block__actions">
            <button class="btn btn--sm" id="dash-all-logs">查看全部${icon('chevronRight', 12)}</button>
          </div>
        </div>
        <div id="dash-log-table"></div>
      </div>`;

    document.querySelectorAll('#dash-metric button').forEach((btn) => {
      btn.onclick = () => {
        dashState.metric = btn.dataset.m;
        document.querySelectorAll('#dash-metric button').forEach((b) => b.classList.toggle('is-on', b === btn));
        paintDashCharts();
      };
    });
    document.getElementById('dash-all-logs').onclick = () => window.PVNavigate('#/usage/logs');

    loadDashboard();
  }

  function dashQuery() {
    return { range: dashState.preset, start: dashState.start, end: dashState.end };
  }

  function loadDashboard() {
    const { range, start, end } = dashQuery();
    const model = dashState.view === 'model' ? dashState.model : '';
    const overview = D.statsOverview(range, model, start, end);
    const series = D.statsSeries(range, model, start, end);
    const breakdown = D.statsBreakdown(range, start, end);

    const label = RANGE_LABEL[dashState.preset] || '区间';
    const cur = overview.current;
    const prev = overview.previous;
    const compare = RANGE_COMPARE[dashState.preset];

    const noTok = dashState.model && cur.requests > 0 && cur.total_tokens === 0;
    document.getElementById('dash-stats').innerHTML =
      statCard(`${label}请求`, fmtByUnit(cur.requests, dashState.unit), '次',
        prev ? deltaHtml(cur.requests, prev.requests, compare) : `<span class="muted">${overview.start ? '' : '全部记录'}</span>`)
      + statCard(`${label} Token`, noTok ? '—' : fmtByUnit(cur.total_tokens, dashState.unit), '',
        noTok ? '<span class="muted">历史数据未按模型记录 Token</span>'
          : prev ? deltaHtml(cur.total_tokens, prev.total_tokens, compare + ' Token') : '<span class="muted">与上一周期不可比</span>')
      + statCard('成功率', `<span style="color:${rateColor(cur.success_rate)}">${cur.success_rate.toFixed(1)}</span>`, '%',
        cur.errors ? `${fmtInt(cur.errors)} 次失败` : '全部成功')
      + statCard('平均速度', cur.avg_speed ? cur.avg_speed.toFixed(1) : '—', cur.avg_speed ? 't/s' : '',
        cur.avg_speed ? `首字 ${fmtDuration(cur.avg_first_byte)} · 总耗时 ${fmtDuration(cur.avg_speed_latency)}`
          : '<span class="muted">暂无速度样本</span>');

    document.getElementById('dash-stamp').textContent = `区间 ${fmtTime(overview.start || 0).slice(0, 16)} → ${overview.end ? fmtTime(overview.end).slice(0, 16) : '此刻'}`;

    window.__dash = { overview, series, breakdown };
    paintDashCharts();
  }

  function paintDashCharts() {
    const data = window.__dash;
    if (!data) return;
    const { overview, series, breakdown } = data;
    const isTok = dashState.metric === 'tokens';
    const PALETTE = Charts.PALETTE;
    const points = series.points || [];
    const span = (series.step_ms || 3600000) * points.length;
    const labels = points.map((p) => timeLabel(p.time, span));
    const fmt = (v) => fmtByUnit(v, dashState.unit);

    // 图例：各模型 / 总计 / 单模型
    const modelKeys = Object.keys(series.model_series || {}).slice(0, 8);
    const selected = dashState.view === 'model' ? dashState.model : '';
    const legendEl = document.getElementById('dash-legend');
    const legendItems = [
      { key: 'all', name: '各模型' },
      { key: 'total', name: '总计' },
      ...modelKeys.map((id, i) => ({ key: id, name: id, color: PALETTE[i % PALETTE.length] })),
    ];
    legendEl.innerHTML = legendItems.map((it) => {
      const active = dashState.view === 'all' ? it.key === 'all'
        : dashState.view === 'total' ? it.key === 'total'
          : it.key === selected;
      return `<button class="dash-legend__item${active ? ' is-on' : ''}" data-view="${esc(it.key)}">
        ${it.color ? `<span class="dash-legend__dot" style="background:${it.color}"></span>` : ''}
        ${esc(it.name)}
        ${it.key === 'all' ? `<span class="muted">${modelKeys.length} 个</span>` : ''}
      </button>`;
    }).join('');
    legendEl.querySelectorAll('[data-view]').forEach((btn) => {
      btn.onclick = () => {
        const key = btn.dataset.view;
        if (key === 'all') { dashState.view = 'all'; dashState.model = ''; }
        else if (key === 'total') { dashState.view = 'total'; dashState.model = ''; }
        else { dashState.view = 'model'; dashState.model = key; }
        loadDashboard();
      };
    });

    document.getElementById('dash-view-label').textContent = dashState.view === 'model'
      ? `只看 ${dashState.model}` : dashState.view === 'total' ? '全部模型合计' : '各模型';

    // 趋势
    let seriesOut = [];
    const trendChart = document.getElementById('dash-trend');
    const trendSub = document.getElementById('dash-trend-sub');
    if (dashState.view === 'all' && !selected) {
      if (isTok) {
        const keys = modelKeys.length ? modelKeys : [];
        seriesOut = keys.map((id, i) => ({
          name: id, color: PALETTE[i % PALETTE.length],
          values: points.map((p) => (series.model_series[id] ? series.model_series[id].total_tokens[points.indexOf(p)] : 0)),
        }));
        if (!seriesOut.length) {
          seriesOut = [
            { name: '输入 Token', color: PALETTE[0], values: points.map((p) => p.prompt_tokens) },
            { name: '输出 Token', color: PALETTE[1], values: points.map((p) => p.completion_tokens) },
            { name: '总 Token', color: PALETTE[2], values: points.map((p) => p.total_tokens) },
          ];
        }
      } else {
        seriesOut = modelKeys.map((id, i) => ({
          name: id, color: PALETTE[i % PALETTE.length],
          values: points.map((p, idx) => (series.model_series[id] ? series.model_series[id].requests[idx] : 0)),
        }));
        if (!seriesOut.length) {
          seriesOut = [
            { name: '请求数', color: PALETTE[0], values: points.map((p) => p.requests) },
            { name: '成功数', color: PALETTE[1], values: points.map((p) => p.requests - p.errors) },
            { name: '失败数', color: '#c9483a', values: points.map((p) => p.errors) },
          ];
        } else {
          seriesOut.push({ name: '失败数', color: '#c9483a', values: points.map((p) => p.errors), noTotal: true });
        }
      }
      trendSub.textContent = `按${isTok ? ' Token 消耗' : '调用次数'}分模型 · 点图例可只看单个模型`;
    } else if (dashState.view === 'total') {
      seriesOut = isTok
        ? [
          { name: '输入 Token', color: PALETTE[0], values: points.map((p) => p.prompt_tokens) },
          { name: '输出 Token', color: PALETTE[1], values: points.map((p) => p.completion_tokens) },
          { name: '总 Token', color: PALETTE[2], values: points.map((p) => p.total_tokens) },
        ]
        : [
          { name: '请求数', color: PALETTE[0], values: points.map((p) => p.requests) },
          { name: '成功数', color: PALETTE[1], values: points.map((p) => p.requests - p.errors) },
          { name: '失败数', color: '#c9483a', values: points.map((p) => p.errors) },
        ];
      trendSub.textContent = isTok ? '全部模型 · 输入 / 输出 / 总 Token' : '全部模型 · 请求 / 成功 / 失败';
    } else {
      seriesOut = isTok
        ? [
          { name: '输入 Token', color: PALETTE[0], values: points.map((p) => p.prompt_tokens) },
          { name: '输出 Token', color: PALETTE[1], values: points.map((p) => p.completion_tokens) },
          { name: '总 Token', color: PALETTE[2], values: points.map((p) => p.total_tokens) },
        ]
        : [
          { name: '请求数', color: PALETTE[0], values: points.map((p) => p.requests) },
          { name: '成功数', color: PALETTE[1], values: points.map((p) => p.requests - p.errors) },
          { name: '失败数', color: '#c9483a', values: points.map((p) => p.errors) },
        ];
      trendSub.textContent = `${dashState.model} · ${isTok ? 'Token 消耗' : '调用次数'}`;
    }
    Charts.areaChart(trendChart, {
      labels,
      series: seriesOut,
      times: points.map((p) => p.time),
      height: 256,
      spanMs: span,
      valueFmt: fmt,
      axisFmt: (v) => fmtByUnit(v, dashState.unit),
      totalName: isTok ? '总 Token' : '请求数',
    });

    // 环形图
    const dist = isTok ? breakdown.models_by_tokens : breakdown.models;
    const items = dist.filter((m) => (isTok ? m.tokens > 0 : m.value > 0)).map((m) => ({
      name: m.name, value: isTok ? m.tokens : m.value,
    }));
    document.getElementById('dash-donut-sub').textContent = `${RANGE_LABEL[dashState.preset] || '区间'} · 按${isTok ? ' Token 消耗' : '调用次数'}`;
    Charts.donutChart(document.getElementById('dash-donut'), {
      items: items.slice(0, 12),
      size: 190,
      thickness: 20,
      centerLabel: isTok ? '总 Token' : '总调用',
      valueFmt: (v) => fmtByUnit(v, dashState.unit),
    });

    // 排行
    document.getElementById('dash-ch-title').textContent = isTok ? '渠道 Token 消耗' : '渠道调用量';
    document.getElementById('dash-key-title').textContent = isTok ? '密钥 Token 消耗' : '密钥调用量';
    const rankOpts = { fmt: (v) => fmtByUnit(v, dashState.unit), nameWidth: 150 };
    Charts.rankList(document.getElementById('dash-ch-rank'),
      (isTok ? breakdown.channels_by_tokens : breakdown.channels).map((x) => ({ name: x.name, value: isTok ? x.tokens : x.value })),
      rankOpts);
    Charts.rankList(document.getElementById('dash-key-rank'),
      (isTok ? breakdown.keys_by_tokens : breakdown.keys).map((x) => ({ name: x.name, value: isTok ? x.tokens : x.value })),
      rankOpts);

    // 最近调用
    const recent = D.queryLogs({ limit: 8 }).items;
    const recentHost = document.getElementById('dash-log-table');
    recentHost.innerHTML = logTableHtml(recent);
    bindLogTable(recentHost, recent);
  }

  // ======================================================================
  // 渠道用量
  // ======================================================================
  function renderChannelUsage() {
    ui.body.innerHTML = `
      <div class="page-head">
        <div class="page-head__titles">
          <div class="page-head__title">${icon('server', 20)}渠道用量</div>
          <div class="page-head__desc">按最终路由的上游模型统计，同名模型忽略大小写合并</div>
        </div>
        <div class="page-head__actions">
          <select class="select" id="cu-channel" style="width:176px" aria-label="渠道">
            <option value="">全部渠道</option>
            ${D.channels.map((c) => `<option value="${esc(c.id)}">${esc(c.id)}（${esc(c.name)}）</option>`).join('')}
          </select>
          ${rangeControls('cu', usageState, loadChannelUsage)}
        </div>
      </div>
      <div class="stat-grid stat-grid--4" id="cu-stats"></div>
      <div class="usage-metric-line" style="margin-top:16px">
        <div class="pill-toggle" id="cu-metric">
          <button data-m="requests" class="${usageState.metric === 'requests' ? 'is-on' : ''}">请求数</button>
          <button data-m="tokens" class="${usageState.metric === 'tokens' ? 'is-on' : ''}">Token</button>
        </div>
        <span class="usage-scope" id="cu-scope"></span>
      </div>
      <div class="dash-grid">
        <div class="plain-block">
          <div class="plain-block__head">
            <span class="plain-block__title">上游模型用量</span>
            <span class="plain-block__sub" id="cu-bar-sub"></span>
          </div>
          <div class="chart-box" id="cu-bar"></div>
        </div>
        <div class="plain-block">
          <div class="plain-block__head">
            <span class="plain-block__title">上游模型占比</span>
            <span class="plain-block__sub" id="cu-donut-sub"></span>
          </div>
          <div class="chart-box" id="cu-donut"></div>
        </div>
      </div>
      <div class="usage-table">
        <div class="plain-block__head">
          <span class="plain-block__title">上游模型明细</span>
          <span class="plain-block__sub">同名模型忽略大小写合并，按最终路由的上游模型统计</span>
          <div class="plain-block__actions"><span class="tool-count" id="cu-count"></span></div>
        </div>
        <div id="cu-table"></div>
      </div>`;

    const sel = document.getElementById('cu-channel');
    sel.value = usageState.channel;
    sel.onchange = () => {
      usageState.channel = sel.value;
      loadChannelUsage();
    };
    document.querySelectorAll('#cu-metric button').forEach((btn) => {
      btn.onclick = () => {
        usageState.metric = btn.dataset.m;
        document.querySelectorAll('#cu-metric button').forEach((b) => b.classList.toggle('is-on', b === btn));
        paintChannelUsage();
      };
    });
    loadChannelUsage();
  }

  function loadChannelUsage() {
    const { range, start, end } = usageState;
    const data = D.statsChannelUsage(range, usageState.channel, start, end);
    window.__cu = data;
    const label = RANGE_LABEL[usageState.preset] || '区间';
    const s = data.summary;
    const scope = usageState.channel
      ? `${esc(usageState.channel)}（${esc((D.channel(usageState.channel) || {}).name || '')}）`
      : '全部渠道';
    document.getElementById('cu-scope').textContent = scope;

    document.getElementById('cu-stats').innerHTML =
      statCard(`${label}请求`, fmtByUnit(s.requests, usageState.unit), '次', s.errors ? `${fmtInt(s.errors)} 次失败` : '全部成功')
      + statCard(`${label} Token`, fmtByUnit(s.total_tokens, usageState.unit), '', `输入 ${fmtByUnit(s.prompt_tokens, usageState.unit)} · 输出 ${fmtByUnit(s.completion_tokens, usageState.unit)}`)
      + statCard('成功率', `<span style="color:${rateColor(s.success_rate)}">${s.success_rate.toFixed(1)}</span>`, '%', `成功 ${fmtInt(Math.max(0, s.requests - s.errors))} 次`)
      + statCard('上游模型', String(data.models.length), '个', scope);
    paintChannelUsage();
  }

  function paintChannelUsage() {
    const data = window.__cu;
    if (!data) return;
    const isTok = usageState.metric === 'tokens';
    const val = (m) => (isTok ? m.total_tokens : m.requests);
    const list = data.models.filter((m) => val(m) > 0).sort((a, b) => val(b) - val(a));
    const fmt = (v) => fmtByUnit(v, usageState.unit);

    document.getElementById('cu-bar-sub').textContent = `${isTok ? 'Token' : '请求数'}前 12 个模型${list.length > 12 ? `，其余 ${list.length - 12} 个见下方明细` : ''}`;
    Charts.barChart(document.getElementById('cu-bar'), {
      labels: list.slice(0, 12).map((m) => (m.name.length > 11 ? m.name.slice(0, 10) + '…' : m.name)),
      names: list.slice(0, 12).map((m) => m.name),
      values: list.slice(0, 12).map(val),
      height: 280,
      color: '#4d9e2f',
      valueFmt: fmt,
      axisFmt: fmt,
    });

    const top = list.slice(0, 8);
    const rest = list.slice(8);
    const items = top.map((m) => ({ name: m.name, value: val(m) }));
    if (rest.length) items.push({ name: `其他 ${rest.length} 个模型`, value: rest.reduce((a, m) => a + val(m), 0), color: '#8a8f98' });
    document.getElementById('cu-donut-sub').textContent = `${isTok ? 'Token' : '请求数'}占比${rest.length ? '，其余模型合并为“其他”' : ''}`;
    Charts.donutChart(document.getElementById('cu-donut'), {
      items, size: 210, thickness: 24,
      centerLabel: isTok ? '总 Token' : '总调用',
      valueFmt: fmt,
    });

    document.getElementById('cu-count').textContent = `共 ${data.models.length} 个归并模型`;
    const showChannel = !usageState.channel;
    document.getElementById('cu-table').innerHTML = `
      <div class="table-wrap">
        <table class="tbl">
          <thead><tr>
            <th>上游模型</th>
            ${showChannel ? '<th>渠道数</th>' : ''}
            <th>请求数</th>
            <th>成功率</th>
            <th>输入 Token</th>
            <th>输出 Token</th>
            <th>总 Token</th>
          </tr></thead>
          <tbody>${list.length ? list.map((m) => `
            <tr>
              <td>${m.key ? copyBadge(m.name) : '<span class="muted">未记录上游</span>'}</td>
              ${showChannel ? `<td>${m.channel_count}</td>` : ''}
              <td>${fmtInt(m.requests)}${m.errors ? ` <span class="badge badge--red">${m.errors} 失败</span>` : ''}</td>
              <td style="color:${rateColor(m.success_rate)};font-weight:700">${m.success_rate.toFixed(1)}%</td>
              <td>${fmtInt(m.prompt_tokens)}</td>
              <td>${fmtInt(m.completion_tokens)}</td>
              <td class="strong">${fmtInt(m.total_tokens)}</td>
            </tr>`).join('')
            : `<tr><td colspan="${showChannel ? 7 : 6}">${window.PV.emptyState('暂无渠道用量', '当前渠道和时间范围内还没有统计记录。', '', 'usage')}</td></tr>`}
          </tbody>
        </table>
      </div>`;
  }

  // ======================================================================
  // 调用日志
  // ======================================================================
  function renderLogs() {
    const facets = D.logFacets(logState.start, logState.end);
    const chName = (id) => {
      const c = D.channel(id);
      const f = facets.channels.find((x) => x.id === id);
      return c ? c.name : (f ? f.name : '');
    };
    ui.body.innerHTML = `
      <div class="page-head">
        <div class="page-head__titles">
          <div class="page-head__title">${icon('logs', 20)}调用日志</div>
          <div class="page-head__desc">每次请求的模型、渠道、Key、耗时与重试链路 · 后台测试也会记录，但不进统计</div>
        </div>
        <div class="page-head__actions">
          <label class="switch" title="开启后 Token 数按 K / M / B 显示，悬停可查看精确值">
            <input type="checkbox" id="log-unit" ${logState.unit ? 'checked' : ''}>
            <span class="switch__track"></span>
            <span class="switch__label">单位</span>
          </label>
          <button class="btn btn--sm" id="log-refresh">${icon('refresh', 13)}刷新</button>
          <button class="btn btn--sm btn--danger" id="log-clear">${icon('trash', 13)}清空日志</button>
        </div>
      </div>
      <div class="logs-toolbar">
        <select class="select" id="log-model" aria-label="模型">
          <option value="">全部模型</option>
          ${facets.models.map((m) => `<option value="${esc(m.id)}"${logState.model === m.id ? ' selected' : ''}>${esc(m.id)}</option>`).join('')}
        </select>
        <select class="select" id="log-channel" aria-label="渠道">
          <option value="">全部渠道</option>
          ${facets.channels.map((c) => `<option value="${esc(c.id)}"${logState.channel === c.id ? ' selected' : ''}>${esc(c.id)}（${esc(chName(c.id) || c.name)}）</option>`).join('')}
        </select>
        <select class="select" id="log-token" aria-label="令牌">
          <option value="">全部令牌</option>
          ${facets.tokens.map((t) => `<option value="${esc(t.id)}"${logState.token === t.id ? ' selected' : ''}>${esc(t.name || t.id)}</option>`).join('')}
        </select>
        <select class="select" id="log-status" aria-label="状态">
          ${[['', '全部状态'], ['success', '成功'], ['error', '失败'], ['retry', '有重试']]
            .map(([v, t]) => `<option value="${v}"${logState.status === v ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
        <select class="select" id="log-preset" style="width:112px" aria-label="时间范围">
          ${PRESETS.map(([v, t]) => `<option value="${v}"${logState.preset === v ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
        <input class="input" type="datetime-local" id="log-start" style="width:158px" value="${toLocalInput(logState.start)}">
        <input class="input" type="datetime-local" id="log-end" style="width:158px" value="${toLocalInput(logState.end)}" title="留空表示不限结束时间">
        <button class="btn btn--sm btn--primary" id="log-query">查询</button>
      </div>
      <div class="table-wrap table-scroll" id="log-table"></div>
      <div class="logs-pager">
        <span id="log-page-text"></span>
        <span class="tool-count" id="log-total"></span>
        <span class="logs-pager__spacer"></span>
        <button class="btn btn--sm" id="log-prev">${icon('chevronLeft', 12)}上一页</button>
        <button class="btn btn--sm" id="log-next">下一页${icon('chevronRight', 12)}</button>
      </div>`;

    const q = (id) => document.getElementById('log-' + id);
    const dirty = () => { q('query').innerHTML = `查询<span class="logs-toolbar__dirty"></span>`; };
    ['model', 'channel', 'token', 'status'].forEach((k) => {
      q(k).onchange = () => { logState[k] = q(k).value; dirty(); };
    });
    q('preset').onchange = () => {
      logState.preset = q('preset').value;
      if (logState.preset !== 'custom') {
        const b = defaultRange(logState.preset);
        logState.start = b.start;
        logState.end = b.end;
        q('start').value = toLocalInput(b.start);
        q('end').value = toLocalInput(b.end);
      }
      dirty();
    };
    const applyTime = () => {
      const s = fromLocalInput(q('start').value);
      const e = fromLocalInput(q('end').value);
      if (s && e && e < s) { Toast.warn('结束时间不能早于开始时间'); return; }
      // 只有时间输入框真的被改过才切到「自定义」；默认查询不该把「今日」改成自定义
      const changed = q('start').value !== toLocalInput(logState.start)
        || q('end').value !== toLocalInput(logState.end);
      logState.start = s;
      logState.end = e;
      const preset = !s && !e ? 'all' : (changed || logState.preset === 'custom') ? 'custom' : logState.preset;
      logState.preset = preset;
      q('preset').value = preset;
    };
    q('start').onchange = () => { applyTime(); dirty(); };
    q('end').onchange = () => { applyTime(); dirty(); };
    q('start').onkeydown = (e) => { if (e.key === 'Enter') { applyTime(); loadLogs(); } };
    q('end').onkeydown = (e) => { if (e.key === 'Enter') { applyTime(); loadLogs(); } };

    q('query').onclick = () => { applyTime(); logState.offset = 0; loadLogs(); };
    q('refresh').onclick = () => { logState.offset = 0; loadLogs(); };
    q('unit').onchange = () => {
      logState.unit = q('unit').checked;
      loadLogs();
    };
    q('clear').onclick = async () => {
      const ok = await window.PV.confirmDialog({
        title: '清空日志',
        message: '确定要清空全部调用日志吗？统计数据（看板）不会受影响。<br><br>该操作不可撤销。',
        confirmText: '清空',
        danger: true,
      });
      if (!ok) return;
      const n = D.clearLogs();
      D.me.counts.logs = 0;
      Toast.success(`已清空 ${n} 条日志，统计数据不受影响`);
      logState.offset = 0;
      loadLogs();
    };
    q('prev').onclick = () => {
      if (logState.offset <= 0) return;
      logState.offset = Math.max(0, logState.offset - logState.limit);
      loadLogs();
    };
    q('next').onclick = () => {
      const total = Number(q('next').dataset.total || 0);
      if (logState.offset + logState.limit >= total) return;
      logState.offset += logState.limit;
      loadLogs();
    };

    loadLogs();
  }

  function loadLogs() {
    const res = D.queryLogs({
      model_id: logState.model,
      channel_id: logState.channel,
      token_id: logState.token,
      status: logState.status,
      start: logState.start,
      end: logState.end,
      offset: logState.offset,
      limit: logState.limit,
    });
    const host = document.getElementById('log-table');
    host.innerHTML = logTableHtml(res.items);
    bindLogTable(host, res.items);
    const total = res.total;
    document.getElementById('log-total').textContent = `共 ${fmtInt(total)} 条`;
    const from = total ? logState.offset + 1 : 0;
    const to = logState.offset + res.items.length;
    document.getElementById('log-page-text').textContent = total ? `当前显示第 ${from} - ${to} 条` : '共 0 条';
    const prev = document.getElementById('log-prev');
    const next = document.getElementById('log-next');
    prev.disabled = logState.offset <= 0;
    next.dataset.total = String(total);
    next.disabled = logState.offset + logState.limit >= total;
    document.getElementById('log-query').innerHTML = '查询';
  }

  // 日志表（看板与日志页共用）
  function logTableHtml(items) {
    if (!items || !items.length) {
      return window.PV.emptyState('没有符合条件的日志', '发起一次 API 调用后就能在这里看到记录。', '', 'logs');
    }
    const unit = logState.unit;
    const tok = (n, exact) => (unit && n >= 1000
      ? `<span data-tip="${fmtInt(n)}">${fmtUnit(n)}</span>`
      : fmtInt(n));
    return `<table class="tbl">
      <thead><tr>
        <th>时间</th>
        <th>请求模型</th>
        <th>渠道</th>
        <th>上游模型</th>
        <th>令牌</th>
        <th>输入</th>
        <th>输出</th>
        <th>速度</th>
        <th>总计</th>
        <th>耗时</th>
        <th>来源 IP</th>
        <th>状态</th>
      </tr></thead>
      <tbody>${items.map((l, i) => {
        const ok = !l.canceled && !l.as_content && l.status_code > 0 && l.status_code < 400 && !l.error && !l.client_error;
        const soft = l.canceled || l.as_content;
        const status = soft
          ? `<button class="badge badge--amber badge--click" data-log-err="${i}">${l.status_code || 200}</button>`
          : ok
            ? '<span class="badge badge--green">成功</span>'
            : `<button class="badge badge--red badge--click" data-log-err="${i}">${l.status_code || '失败'}</button>`;
        return `<tr>
          <td class="log-time">${fmtTime(l.time)}</td>
          <td>
            <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">
              ${copyBadge(l.model_id, { label: '模型 ID ' })}
              ${l.stream ? '<span class="badge badge--blue badge--xs">流式</span>' : ''}
              ${l.retries ? `<button class="badge badge--amber badge--xs badge--click" data-log-retry="${i}">重试 ${l.retries}</button>` : ''}
            </div>
          </td>
          <td>${l.channel_id
            ? `<div>${copyBadge(l.channel_id + (l.channel_name ? `（${l.channel_name}）` : ''), { copy: l.channel_id, label: '渠道 ID ' })}</div>
               <div class="log-sub">#${l.key_index + 1}${l.key_note ? ' ' + esc(l.key_note) : ''}${l.key_affinity ? ' <span style="color:var(--sun-500)">★</span>' : ''}</div>`
            : '<span class="muted">未命中渠道</span>'}</td>
          <td>${copyBadge(l.upstream_model, { label: '上游模型 ' })}${l.response_model && l.response_model.toLowerCase() !== String(l.upstream_model).toLowerCase()
            ? ` <span class="badge badge--gray badge--xs" data-tip="响应模型：${esc(l.response_model)}">改</span>` : ''}</td>
          <td>${copyBadge(l.token_name || l.token_id, { copy: l.token_name || l.token_id, label: '令牌 ' })}</td>
          <td>${tok(l.prompt_tokens)}${l.cached_tokens ? `<div class="log-sub">缓存读 ${tok(l.cached_tokens)}</div>` : ''}</td>
          <td>${tok(l.completion_tokens)}${l.reasoning_tokens ? `<div class="log-sub">思考 ${tok(l.reasoning_tokens)}</div>` : ''}</td>
          <td>${l.tokens_per_sec ? `${l.tokens_per_sec.toFixed(1)} t/s` : '<span class="muted">—</span>'}</td>
          <td>${tok(l.total_tokens)}</td>
          <td>${fmtDuration(l.latency_ms)}${l.first_byte_ms ? `<div class="log-sub">首字 ${fmtDuration(l.first_byte_ms)}</div>` : ''}</td>
          <td>${copyBadge(l.ip, { label: '来源 IP ' })}</td>
          <td>${status}</td>
        </tr>`;
      }).join('')}
      </tbody>
    </table>`;
  }

  function bindLogTable(host, items) {
    host.querySelectorAll('[data-log-err]').forEach((btn) => {
      btn.onclick = () => {
        const l = items[Number(btn.dataset.logErr)];
        if (!l) return;
        const soft = l.canceled || l.as_content;
        openModal({
          title: '错误信息',
          size: 'lg',
          body: `<div class="fs-13" style="display:flex;flex-direction:column;gap:10px">
            <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
              ${badge('请求模型 ' + l.model_id, 'wood')}
              ${badge(`渠道模型 ${l.channel_id}/${l.upstream_model}`, 'blue')}
              <span class="badge ${soft ? 'badge--amber' : 'badge--red'}">${l.status_code || '失败'}</span>
              ${l.endpoint ? badge(l.endpoint, 'gray') : ''}
            </div>
            <div>
              <div class="strong" style="margin-bottom:4px">${l.as_content ? '返回给调用方的正文' : '错误详情'}</div>
              <pre class="tool-call__code" style="white-space:pre-wrap">${esc(l.client_error || l.error || '—')}</pre>
            </div>
            ${l.error && l.as_content ? `<div><div class="strong" style="margin-bottom:4px">内部原因</div><pre class="tool-call__code" style="white-space:pre-wrap">${esc(l.error)}</pre></div>` : ''}
          </div>`,
          footer: '<div class="spacer"></div><button class="btn" data-close>关闭</button>',
          onMount(mo) {
            mo.foot.querySelector('[data-close]').onclick = () => mo.close();
          },
        });
      };
    });

    host.querySelectorAll('[data-log-retry]').forEach((btn) => {
      btn.onclick = () => {
        const l = items[Number(btn.dataset.logRetry)];
        if (!l) return;
        openModal({
          title: '渠道重试信息',
          size: 'lg',
          body: `<div class="fs-12 muted" style="margin-bottom:10px">模型 ${esc(l.model_id)} · 共 ${l.retries + 1} 条路由 · 最终${l.status_code < 400 && !l.error ? '成功' : '失败'}</div>
            <div class="table-wrap"><table class="tbl">
              <thead><tr><th>#</th><th>渠道</th><th>上游模型</th><th>状态</th><th>耗时</th><th>错误</th></tr></thead>
              <tbody>${[].concat(l.attempts || [], [{
                channel_id: l.channel_id, channel_name: l.channel_name, upstream_model: l.upstream_model,
                status_code: l.status_code, latency_ms: l.latency_ms, error: l.error,
              }]).map((a, i) => `<tr>
                <td>${i + 1}</td>
                <td>${esc(a.channel_id)}${a.channel_name ? `（${esc(a.channel_name)}）` : ''}</td>
                <td class="mono">${esc(a.upstream_model)}</td>
                <td>${a.status_code >= 400 || a.error ? `<span class="badge badge--red">${a.status_code || '失败'}</span>` : '<span class="badge badge--green">成功</span>'}</td>
                <td>${fmtDuration(a.latency_ms)}</td>
                <td class="fs-12 muted">${esc(a.error || '—')}</td>
              </tr>`).join('')}</tbody>
            </table></div>`,
          footer: '<div class="spacer"></div><button class="btn" data-close>关闭</button>',
          onMount(mo) { mo.foot.querySelector('[data-close]').onclick = () => mo.close(); },
        });
      };
    });
  }

  window.PVPages = window.PVPages || {};
  window.PVPages.usage = {
    render,
    destroy() { window.__dash = null; window.__cu = null; },
  };
})();
