/* ==========================================================================
   懒大猫 API · 用量分析（渠道 / 模型两个视图）
   渠道视图：锁定一个渠道，看它下面各上游模型的用量；
   模型视图：锁定一个上游模型（统一小写），看它落在各渠道的分布。
   ========================================================================== */
(function () {
  'use strict';

  const {
    esc, API, Toast, icon, badge, emptyState, loadingBlock, fmtInt, fmtUnit,
  } = window.LDM;
  const { areaChart, donutChart, clearChart, timeLabel, PALETTE } = window.Charts;

  const RANGES = [
    ['today', '今日'],
    ['7d', '近 7 天'],
    ['30d', '近 30 天'],
    ['all', '全部时间'],
  ];

  // 跨导航保留：切走再回来还是上次看的渠道 / 模型 / 区间。
  const state = { tab: 'channel', channel: '', model: '', token: '', range: 'today', tableMode: 'main' };

  let facets = { channels: [], models: [], tokens: [] };
  let loadSeq = 0;

  const fmtMs = (ms) => {
    const v = Number(ms) || 0;
    if (!v) return '—';
    if (v < 1000) return Math.round(v) + 'ms';
    return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 's';
  };
  const pct = (v) => {
    const n = Number(v);
    if (!(n >= 0)) return '—';
    return (n >= 99.95 ? '100' : n.toFixed(1)) + '%';
  };
  const rateColor = (v) => {
    const n = Number(v);
    if (!(n >= 0)) return 'var(--text-3)';
    if (n >= 99) return 'var(--leaf-600)';
    if (n >= 95) return 'var(--sun-500)';
    return 'var(--red-500)';
  };

  // ---------- 筛选状态 ----------

  function channelModels(id) {
    const c = (facets.channels || []).find((x) => x.id === id);
    return (c && c.models) || [];
  }

  // 把状态收敛到当前可选范围：渠道没了就换第一个，模型不在池里就清掉。
  function normalize() {
    const chans = facets.channels || [];
    if (state.channel && !chans.some((c) => c.id === state.channel)) state.channel = '';
    if (state.tab === 'channel') {
      if (!state.channel && chans.length) state.channel = chans[0].id;
      if (state.model && !channelModels(state.channel).includes(state.model)) state.model = '';
    } else {
      const models = facets.models || [];
      if (!models.includes(state.model)) state.model = models[0] || '';
    }
    if (state.token && !(facets.tokens || []).some((t) => t.id === state.token)) state.token = '';
    if (!RANGES.some((r) => r[0] === state.range)) state.range = 'today';
  }

  function channelOptions() {
    const chans = facets.channels || [];
    if (!chans.length) return '<option value="">暂无渠道</option>';
    const head = state.tab === 'model' ? '<option value="">全部渠道</option>' : '';
    return head + chans.map((c) => {
      const label = c.name ? `${c.id}（${c.name}）` : c.id;
      return `<option value="${esc(c.id)}"${state.channel === c.id ? ' selected' : ''}>${esc(label)}${c.enabled ? '' : ' · 已禁用'}</option>`;
    }).join('');
  }

  function modelOptions() {
    const pool = state.tab === 'channel' ? channelModels(state.channel) : (facets.models || []);
    if (!pool.length) return `<option value="">${state.tab === 'channel' ? '该渠道没有模型' : '暂无模型'}</option>`;
    const head = state.tab === 'channel' ? '<option value="">全部模型</option>' : '';
    return head + pool.map((m) => `<option value="${esc(m)}"${state.model === m ? ' selected' : ''}>${esc(m)}</option>`).join('');
  }

  function tokenOptions() {
    const tokens = facets.tokens || [];
    return '<option value="">全部令牌</option>' + tokens.map((t) =>
      `<option value="${esc(t.id)}"${state.token === t.id ? ' selected' : ''}>${esc(t.name || t.id)}${t.enabled ? '' : ' · 已禁用'}</option>`).join('');
  }

  function rangeOptions() {
    return RANGES.map(([k, label]) =>
      `<option value="${k}"${state.range === k ? ' selected' : ''}>${label}</option>`).join('');
  }

  function buildFilters(host) {
    host.innerHTML = `
      <div class="pill-toggle" id="usage-tab" aria-label="统计视图">
        <button type="button" data-tab="channel" class="${state.tab === 'channel' ? 'is-on' : ''}">渠道</button>
        <button type="button" data-tab="model" class="${state.tab === 'model' ? 'is-on' : ''}">模型</button>
      </div>
      <select class="select" id="usage-channel" aria-label="渠道" style="width:auto;min-width:150px">${channelOptions()}</select>
      <select class="select" id="usage-model" aria-label="模型" style="width:auto;min-width:150px">${modelOptions()}</select>
      <select class="select" id="usage-token" aria-label="令牌" style="width:auto;min-width:124px">${tokenOptions()}</select>
      <select class="select" id="usage-range" aria-label="时间范围" style="width:auto;min-width:100px">${rangeOptions()}</select>`;

    host.querySelectorAll('#usage-tab button').forEach((btn) => {
      btn.onclick = () => {
        const next = btn.dataset.tab;
        if (state.tab === next) return;
        state.tab = next;
        // 换了视图，「主维度」的含义也变了（上游模型 ↔ 渠道），明细回到主视角
        state.tableMode = 'main';
        // 两个视图的「锁定对象」不同：切到模型视图默认放开渠道（全部渠道），
        // 切回渠道视图则保留渠道、清掉模型筛选。
        if (next === 'model') {
          state.channel = '';
        } else {
          state.model = '';
        }
        normalize();
        buildFilters(host);
        load(true);
      };
    });

    host.querySelector('#usage-channel').onchange = (e) => {
      state.channel = e.target.value;
      // 只有渠道视图的模型下拉跟着渠道走；模型视图锁的是模型，
      // 换渠道只是收窄范围，不能把选中的模型一起清掉。
      if (state.tab === 'channel') {
        state.model = '';
        buildFilters(host);
      }
      load(true);
    };
    host.querySelector('#usage-model').onchange = (e) => {
      state.model = e.target.value;
      load(true);
    };
    host.querySelector('#usage-token').onchange = (e) => {
      state.token = e.target.value;
      load(true);
    };
    host.querySelector('#usage-range').onchange = (e) => {
      state.range = e.target.value;
      load(true);
    };
  }

  // ---------- 页面骨架 ----------

  function statCard(id, label) {
    return `<div class="stat" id="${id}">
      <div class="stat__label">${label}</div>
      <div class="stat__value" data-v>—</div>
      <div class="stat__foot" data-f></div>
    </div>`;
  }

  function buildSkeleton(root) {
    root.innerHTML = `
      <div id="usage-body">
        <div class="stat-grid stat-grid--4">
          ${statCard('u-req', '调用请求')}
          ${statCard('u-rate', '请求成功率')}
          ${statCard('u-token', 'Token 消耗')}
          ${statCard('u-latency', '平均耗时')}
        </div>

        <div class="chart-grid">
          <div class="card">
            <div class="card__head">
              <div>
                <div class="card__title">调用趋势</div>
                <div class="card__sub" id="u-trend-sub"></div>
              </div>
            </div>
            <div class="card__body">
              <div id="u-trend" class="usage-trend"></div>
              <div class="chart-legend" id="u-legend"></div>
            </div>
          </div>

          <div class="card">
            <div class="card__head">
              <div>
                <div class="card__title" id="u-rank-title">模型分布</div>
                <div class="card__sub" id="u-rank-sub"></div>
              </div>
            </div>
            <div class="card__body"><div id="u-rank"></div></div>
          </div>
        </div>

        <div class="card" id="u-table-card">
          <div class="card__head">
            <div>
              <div class="card__title" id="u-table-title">明细</div>
              <div class="card__sub" id="u-table-sub"></div>
            </div>
            <div class="card__actions">
              <div class="pill-toggle" id="u-table-mode" aria-label="明细视角">
                <button type="button" data-m="main" class="${state.tableMode === 'main' ? 'is-on' : ''}">主维度</button>
                <button type="button" data-m="caller" class="${state.tableMode === 'caller' ? 'is-on' : ''}">按请求模型</button>
              </div>
            </div>
          </div>
          <div class="card__body" id="u-table"></div>
        </div>
      </div>`;
  }

  // ---------- 渲染 ----------

  function paintStat(id, value, foot) {
    const el = document.getElementById(id);
    if (!el) return;
    el.querySelector('[data-v]').innerHTML = value;
    el.querySelector('[data-f]').innerHTML = foot || '';
  }

  function paintStats(data) {
    const s = data.summary || {};
    paintStat('u-req', `${fmtInt(s.requests)}<small>次</small>`,
      s.requests ? `失败 ${fmtInt(s.errors)} 次 · 尝试 ${fmtInt(s.attempts)} 次` : '所选区间没有调用');
    paintStat('u-rate', `<span style="color:${rateColor(s.success_rate)}">${pct(s.success_rate)}</span>`,
      s.attempts ? `尝试成功率 ${pct(s.try_success_rate)} · 失败尝试 ${fmtInt(s.failed_tries)} 次` : '—');
    paintStat('u-token', `${esc(fmtUnit(s.total_tokens))}`,
      `输入 ${esc(fmtUnit(s.prompt_tokens))} · 输出 ${esc(fmtUnit(s.completion_tokens))}`);
    const lat = s.avg_latency_ms || 0;
    paintStat('u-latency', fmtMs(lat),
      s.avg_speed > 0 ? `平均速度 ${s.avg_speed.toFixed(1)} t/s` : '没有可用的速度样本');
  }

  function paintTrend(data) {
    const host = document.getElementById('u-trend');
    const sub = document.getElementById('u-trend-sub');
    const legend = document.getElementById('u-legend');
    if (!host) return;
    clearChart(host);
    const points = data.series || [];
    const start = (data.range && data.range.start) || 0;
    const end = (data.range && data.range.end) || 0;
    const span = Math.max(end - start, 1);
    if (!points.length) {
      host.innerHTML = `<div class="usage-empty">${icon('box', 26)}<span>所选区间没有数据</span></div>`;
      if (legend) legend.innerHTML = '';
      if (sub) sub.textContent = '';
      return;
    }
    const labels = points.map((p) => timeLabel(p.time, span));
    const hasErr = points.some((p) => p.errors > 0);
    const series = [{ name: '请求', values: points.map((p) => p.requests), color: '#4d9e2f' }];
    if (hasErr) series.push({ name: '失败', values: points.map((p) => p.errors), color: '#c9483a' });
    areaChart(host, { labels, series, height: 236, spanMs: span, valueFmt: (v) => fmtInt(v) });
    if (sub) {
      sub.textContent = `${fmtInt(data.summary.requests)} 次请求 · ${fmtInt(data.summary.total_tokens)} Token`;
    }
    if (legend) {
      legend.innerHTML = series.map((s) =>
        `<span class="chart-legend__item"><i class="chart-legend__swatch" style="background:${s.color}"></i>${esc(s.name)}</span>`).join('');
    }
  }

  function paintDonut(data) {
    const host = document.getElementById('u-rank');
    const title = document.getElementById('u-rank-title');
    const sub = document.getElementById('u-rank-sub');
    if (!host) return;
    clearChart(host);
    const isChannel = data.tab === 'channel';
    if (title) title.textContent = isChannel ? '模型分布' : '渠道分布';
    if (sub) sub.textContent = isChannel
      ? '按上游模型拆分 · 只算成功落地'
      : '这个上游模型落在各渠道的比例 · 只算成功落地';
    const rows = (data.rows || []).slice().sort((a, b) => b.requests - a.requests);
    // 饼图看的是「最终承载」，只尝试过、没落地的行不画进来（明细里还能看到）
    const landed = rows.filter((r) => r.requests > 0);
    if (!landed.length) {
      host.innerHTML = `<div class="usage-empty">${icon('box', 26)}<span>所选区间没有成功落地的调用</span></div>`;
      return;
    }
    const items = landed.slice(0, 8).map((r, i) => ({
      name: isChannel ? r.key : (r.name || r.key),
      value: r.requests,
      color: PALETTE[i % PALETTE.length],
    }));
    donutChart(host, { items, size: 158, thickness: 19, centerLabel: '次落地' });
  }

  // 请求模型的类型徽章：自定义模型（编排了路由）和渠道模型（直接绑一个渠道）
  // 是同一份用量里的两种来源，颜色沿用模型管理里的标签。
  function callerTypeBadge(type) {
    if (type === 'custom') return badge('自定义', 'wood');
    if (type === 'channel') return badge('渠道', 'blue');
    return badge('已删除', 'gray');
  }

  function mainTableHtml(data) {
    const isChannel = data.tab === 'channel';
    const rows = data.rows || [];
    const head = `<tr>
      <th>${isChannel ? '上游模型' : '渠道'}</th>
      <th class="right">调用</th>
      <th class="right">尝试</th>
      <th class="right">失败尝试</th>
      <th class="right">成功率</th>
      <th class="right">Token</th>
      <th class="right">平均耗时</th>
    </tr>`;
    const body = rows.map((r) => {
      const name = isChannel ? r.key : (r.name || r.key);
      const keyHint = (!isChannel && r.name && r.name !== r.key)
        ? `<span class="muted fs-11 mono">${esc(r.key)}</span>` : '';
      return `<tr>
        <td>
          <div class="flex-center gap-6" style="min-width:0">
            <span class="mono truncate" style="max-width:260px" title="${esc(name)}">${esc(name)}</span>
            ${keyHint}
          </div>
        </td>
        <td class="right num">${fmtInt(r.requests)}</td>
        <td class="right num">${fmtInt(r.attempts)}</td>
        <td class="right num"${r.failed_tries > 0 ? ' style="color:var(--red-500)"' : ''}>${fmtInt(r.failed_tries)}</td>
        <td class="right num" style="color:${rateColor(r.success_rate)};font-weight:700">${pct(r.success_rate)}</td>
        <td class="right num">${esc(fmtUnit(r.total_tokens))}</td>
        <td class="right num">${fmtMs(r.avg_latency_ms)}</td>
      </tr>`;
    }).join('');
    return `<div class="table-wrap"><table class="tbl"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  }

  // 「按请求模型」视图：同一个上游模型下面，哪些是自定义模型路由过来的、
  // 哪些是渠道模型被直接调用，各自的量和成功率。
  function callerTableHtml(data) {
    const rows = data.callers || [];
    if (!rows.length) return '';
    const head = `<tr>
      <th>请求模型</th>
      <th>类型</th>
      <th class="right">调用</th>
      <th class="right">失败</th>
      <th class="right">成功率</th>
      <th class="right">Token</th>
    </tr>`;
    const body = rows.map((r) => `<tr>
      <td>
        <div class="flex-center gap-6" style="min-width:0">
          <span class="mono truncate" style="max-width:300px" title="${esc(r.model_id)}">${esc(r.model_id)}</span>
        </div>
      </td>
      <td>${callerTypeBadge(r.type)}</td>
      <td class="right num">${fmtInt(r.requests)}</td>
      <td class="right num"${r.errors > 0 ? ' style="color:var(--red-500)"' : ''}>${fmtInt(r.errors)}</td>
      <td class="right num" style="color:${rateColor(r.success_rate)};font-weight:700">${pct(r.success_rate)}</td>
      <td class="right num">${esc(fmtUnit(r.tokens))}</td>
    </tr>`).join('');
    return `<div class="table-wrap"><table class="tbl"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  }

  function paintTable(data) {
    const host = document.getElementById('u-table');
    const title = document.getElementById('u-table-title');
    const sub = document.getElementById('u-table-sub');
    if (!host) return;
    const isChannel = data.tab === 'channel';
    const byCaller = state.tableMode === 'caller';
    if (title) title.textContent = byCaller ? '按请求模型' : (isChannel ? '上游模型明细' : '渠道明细');
    if (sub) {
      sub.textContent = byCaller
        ? '同一批调用里，自定义模型（编排了路由）和渠道模型（直接绑定）各占多少'
        : (isChannel ? '同一个渠道下各上游模型的承载与失败情况' : '同一个模型在各渠道的承载与失败情况');
    }
    const source = byCaller ? (data.callers || []) : (data.rows || []);
    if (!source.length) {
      host.innerHTML = `<div class="usage-empty">${icon('box', 26)}<span>所选条件下没有调用记录</span></div>`;
      return;
    }
    const table = byCaller ? callerTableHtml(data) : mainTableHtml(data);
    const tokens = data.tokens || [];
    const tokenStrip = tokens.length > 1
      ? `<div class="usage-token-strip">
          <span class="muted fs-12">按令牌</span>
          ${tokens.map((t) => `<span class="badge badge--tag">${esc(t.name || t.id)} · ${fmtInt(t.requests)} 次</span>`).join('')}
        </div>`
      : '';
    host.innerHTML = table + tokenStrip;
  }

  function paintError(e) {
    const host = document.getElementById('u-table');
    if (!host) return;
    host.innerHTML = `<div class="alert alert--warn">${icon('alert', 16)}<div>加载失败：${esc((e && e.message) || e || '未知错误')}</div></div>`;
  }

  // 明细视角切换：主维度按钮的文字跟着视图变（渠道视图是「按上游模型」，
  // 模型视图是「按渠道」），右边的「按请求模型」固定。
  function paintTableMode() {
    const host = document.getElementById('u-table-mode');
    if (!host) return;
    const mainBtn = host.querySelector('[data-m="main"]');
    if (mainBtn) mainBtn.textContent = state.tab === 'channel' ? '按上游模型' : '按渠道';
    host.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('is-on', b.dataset.m === state.tableMode);
    });
  }

  function bindTableMode() {
    const host = document.getElementById('u-table-mode');
    if (!host) return;
    host.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        if (state.tableMode === b.dataset.m) return;
        state.tableMode = b.dataset.m;
        if (lastData) paintTable(lastData);
        paintTableMode();
      };
    });
  }

  let lastData = null;

  function paint(data) {
    lastData = data;
    paintStats(data);
    paintTrend(data);
    paintDonut(data);
    paintTable(data);
    paintTableMode();
    const body = document.getElementById('usage-body');
    if (body) {
      body.classList.remove('is-loading');
      body.removeAttribute('aria-busy');
    }
  }

  // ---------- 取数 ----------

  async function load(fresh) {
    const body = document.getElementById('usage-body');
    if (!body) return;
    const my = ++loadSeq;
    const needChannel = state.tab === 'channel' && !state.channel;
    const needModel = state.tab === 'model' && !state.model;
    if (needChannel || needModel) {
      body.innerHTML = emptyState(
        needChannel ? '还没有可查看的渠道' : '还没有可查看的模型',
        needChannel ? '先到渠道管理里添加一个渠道' : '先到渠道管理里填写模型名，或到模型管理里添加模型',
        `<a class="btn btn--primary" href="#/channels">${icon('channels', 14)}去渠道管理</a>`,
        'channels',
      );
      return;
    }
    body.classList.add('is-loading');
    body.setAttribute('aria-busy', 'true');

    const qs = new URLSearchParams({ tab: state.tab, range: state.range });
    if (state.channel) qs.set('channel', state.channel);
    if (state.model) qs.set('model', state.model);
    if (state.token) qs.set('token', state.token);

    try {
      const data = await API.get('/api/usage?' + qs.toString());
      if (my !== loadSeq) return;
      paint(data);
      if (data.truncated) {
        Toast.error('数据量较大，只统计了最近的部分记录');
      }
    } catch (e) {
      if (my !== loadSeq) return;
      body.classList.remove('is-loading');
      body.removeAttribute('aria-busy');
      paintError(e);
      Toast.error(e.message || '加载失败');
    }
  }

  // ---------- 注册页面 ----------

  window.LDM.registerPage('usage', {
    title: '用量分析',
    desc: '按渠道或模型查看调用量、成功率与 Token 消耗',
    async render(root, actions, filters) {
      actions.innerHTML = `<button class="btn" id="btn-refresh">${icon('refresh', 14)}刷新</button>`;
      actions.querySelector('#btn-refresh').onclick = () => load(false);

      root.innerHTML = loadingBlock('加载筛选选项…');
      try {
        facets = await API.get('/api/usage/facets');
      } catch (e) {
        root.innerHTML = emptyState('筛选选项加载失败', (e && e.message) || '请稍后重试', '', 'alert');
        return;
      }
      normalize();
      buildFilters(filters);
      buildSkeleton(root);
      bindTableMode();
      load(true);
    },
  });
})();
