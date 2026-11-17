/* ==========================================================================
   懒大猫 API · 渠道用量
   ========================================================================== */
(function () {
  'use strict';

  const {
    esc, API, Toast, icon, emptyState, fmtInt, copyBadge,
  } = window.LDM;
  const { barChart, donutChart, clearChart } = window.Charts;

  const RANGES = {
    today: { pick: '今日', label: '今日' },
    yesterday: { pick: '昨日', label: '昨日' },
    '7d': { pick: '近 7 天', label: '近 7 天' },
    '30d': { pick: '近 30 天', label: '近 30 天' },
    all: { pick: '全部时间', label: '累计' },
    custom: { pick: '自定义', label: '区间' },
  };
  const PRESETS = ['today', 'yesterday', '7d', '30d', 'all', 'custom'];
  const UNIT_KEY = 'ldmapi.dashboard.unit';
  const COLORS = ['#4d9e2f', '#e9a316', '#3f8fbf', '#8a5ac2', '#d9557f', '#7cc243',
    '#5f9e8b', '#b07b3e', '#6b7f9e', '#a05a9b', '#3f9e8f', '#8a8f98'];

  // 只保留本页面的筛选状态；和数据看板互不触发刷新或模型视图切换。
  const state = {
    range: { key: 'today', start: 0, end: 0 },
    channel: '',
    metric: 'tokens',
    unit: 'cn',
  };
  try {
    const saved = localStorage.getItem(UNIT_KEY);
    if (saved === 'en' || saved === 'cn' || saved === 'none') state.unit = saved;
  } catch (e) { /* 存储不可用时用默认单位 */ }

  const pad2 = (n) => String(n).padStart(2, '0');
  const startOfToday = (offsetDays) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime() - (offsetDays || 0) * 86400000;
  };
  function rangeOfPreset(key) {
    if (key === 'today') return { start: startOfToday(0), end: 0 };
    if (key === 'yesterday') return { start: startOfToday(1), end: startOfToday(0) };
    if (key === '7d') return { start: startOfToday(6), end: 0 };
    if (key === '30d') return { start: startOfToday(29), end: 0 };
    if (key === 'all') return { start: 0, end: 0 };
    return null;
  }
  function bounds() {
    if (state.range.key === 'custom') return { start: state.range.start, end: state.range.end };
    return rangeOfPreset(state.range.key) || { start: 0, end: 0 };
  }
  function rangeQuery() {
    const p = new URLSearchParams();
    if (state.range.key === 'all') {
      p.set('range', 'all');
    } else {
      const b = bounds();
      p.set('range', 'custom');
      if (b.start) p.set('start', String(b.start));
      if (b.end) p.set('end', String(b.end));
    }
    if (state.channel) p.set('channel_id', state.channel);
    return p.toString();
  }
  function toLocalInput(ms) {
    if (!ms) return '';
    const d = new Date(Number(ms));
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function fmt(n) {
    n = Number(n) || 0;
    const abs = Math.abs(n);
    if (state.unit === 'none') return n.toLocaleString('zh-CN');
    const fixed = (v) => v.toFixed(2).replace(/\.?0+$/, '');
    if (state.unit === 'en') {
      if (abs >= 1e9) return fixed(n / 1e9) + 'B';
      if (abs >= 1e6) return fixed(n / 1e6) + 'M';
      if (abs >= 1e3) return fixed(n / 1e3) + 'K';
      return n.toLocaleString('zh-CN');
    }
    if (abs >= 1e8) return fixed(n / 1e8) + '亿';
    if (abs >= 1e4) return fixed(n / 1e4) + '万';
    return n.toLocaleString('zh-CN');
  }

  const ph = (w, extra) => `<span class="dash-ph${extra ? ' ' + extra : ''}" style="width:${w}px"></span>`;
  const statPh = (iconName, label, valueWidth, footWidth) => `
    <div class="stat__label">${icon(iconName, 13)}${label}</div>
    <div class="stat__value">${ph(valueWidth, 'dash-ph--value')}</div>
    <div class="stat__foot">${ph(footWidth, 'dash-ph--foot')}</div>`;
  const chartPh = (height) => `<div class="dash-ph-chart" style="height:${height}px">
    <span class="dash-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>统计中…</span>
  </div>`;

  function colorFor(key) {
    const text = String(key || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = ((hash * 31) + text.charCodeAt(i)) >>> 0;
    return COLORS[hash % COLORS.length];
  }
  function shortLabel(name) {
    const chars = Array.from(name || '');
    return chars.length > 11 ? chars.slice(0, 10).join('') + '…' : (name || '');
  }

  window.LDM.registerPage('channel-usage', {
    title: '渠道用量',
    desc: '按渠道查看上游模型的请求与 Token 消耗',
    async render(root, actions, filters) {
      filters.innerHTML = `
        <select class="select" id="usage-channel" aria-label="渠道" style="width:auto;min-width:150px;max-width:220px">
          <option value="">全部渠道</option>
        </select>
        <select class="select" id="usage-preset" aria-label="统计区间" style="width:auto;min-width:96px">
          ${PRESETS.map((k) => `<option value="${k}"${state.range.key === k ? ' selected' : ''}>${RANGES[k].pick}</option>`).join('')}
        </select>
        <input class="input log-time" id="usage-start" type="datetime-local" aria-label="开始时间"
               value="${toLocalInput(bounds().start)}" style="width:auto;min-width:168px">
        <span class="log-range-end">
          <span class="muted fs-12">至</span>
          <input class="input log-time" id="usage-end" type="datetime-local" aria-label="结束时间"
                 title="留空表示到此刻" value="${toLocalInput(bounds().end)}" style="width:auto;min-width:168px">
        </span>`;
      actions.innerHTML = `
        <select class="select" id="usage-unit" aria-label="数字单位" style="width:auto;min-width:128px">
          <option value="en"${state.unit === 'en' ? ' selected' : ''}>英文单位 K/M</option>
          <option value="cn"${state.unit === 'cn' ? ' selected' : ''}>中文单位 万/亿</option>
          <option value="none"${state.unit === 'none' ? ' selected' : ''}>无单位</option>
        </select>
        <button class="btn" id="usage-refresh">${icon('refresh', 14)}刷新</button>`;

      root.innerHTML = `<div id="usage-body"></div>`;
      const body = root.querySelector('#usage-body');
      const channelEl = filters.querySelector('#usage-channel');
      const presetEl = filters.querySelector('#usage-preset');
      const startEl = filters.querySelector('#usage-start');
      const endEl = filters.querySelector('#usage-end');
      let data = null;
      let dom = null;
      let loadSeq = 0;

      buildSkeleton();
      bindControls();
      load();

      function bindControls() {
        channelEl.onchange = () => {
          if (channelEl.value === state.channel) return;
          state.channel = channelEl.value;
          load();
        };
        presetEl.onchange = () => {
          const next = presetEl.value;
          if (next === 'custom') {
            state.range.start = startEl.value ? new Date(startEl.value).getTime() : 0;
            state.range.end = endEl.value ? new Date(endEl.value).getTime() : 0;
          }
          state.range.key = next;
          syncTimeInputs();
          load();
        };
        [startEl, endEl].forEach((el) => {
          const apply = () => {
            const start = startEl.value ? new Date(startEl.value).getTime() : 0;
            const end = endEl.value ? new Date(endEl.value).getTime() : 0;
            if (start && end && end < start) {
              Toast.error('结束时间不能早于开始时间');
              syncTimeInputs();
              return;
            }
            if (!start && !end) {
              state.range = { key: 'all', start: 0, end: 0 };
              presetEl.value = 'all';
            } else {
              state.range = { key: 'custom', start, end };
              presetEl.value = 'custom';
            }
            load();
          };
          el.onchange = apply;
          el.onkeydown = (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); apply(); }
          };
        });
        actions.querySelector('#usage-refresh').onclick = () => load();
        actions.querySelector('#usage-unit').onchange = (e) => {
          state.unit = e.target.value;
          try { localStorage.setItem(UNIT_KEY, state.unit); } catch (err) { /* 忽略配额错误 */ }
          paintData();
        };
        body.querySelectorAll('#usage-metric button').forEach((btn) => {
          btn.onclick = () => {
            if (state.metric === btn.dataset.m) return;
            state.metric = btn.dataset.m;
            paintData();
          };
        });
      }

      function syncTimeInputs() {
        const b = bounds();
        startEl.value = toLocalInput(b.start);
        endEl.value = toLocalInput(b.end);
      }

      function buildSkeleton() {
        const label = (RANGES[state.range.key] || RANGES.today).label;
        body.setAttribute('aria-busy', 'true');
        body.innerHTML = `
          <div class="stat-grid stat-grid--4">
            <div class="stat" id="usage-stat-requests">${statPh('zap', `${label}请求`, 104, 84)}</div>
            <div class="stat" id="usage-stat-tokens">${statPh('bolt', `${label} Token`, 112, 142)}</div>
            <div class="stat" id="usage-stat-rate">${statPh('check', '成功率', 88, 72)}</div>
            <div class="stat" id="usage-stat-models">${statPh('models', '上游模型', 72, 104)}</div>
          </div>

          <div class="usage-metric-row">
            <div class="usage-scope" id="usage-scope">全部渠道</div>
            <div class="pill-toggle" id="usage-metric" aria-label="图表口径">
              <button data-m="requests" class="${state.metric === 'requests' ? 'is-on' : ''}">请求数</button>
              <button data-m="tokens" class="${state.metric === 'tokens' ? 'is-on' : ''}">Token</button>
            </div>
          </div>

          <div class="usage-chart-grid">
            <div class="card">
              <div class="card__head">
                <div>
                  <div class="card__title">上游模型用量</div>
                  <div class="card__sub" id="usage-bar-sub"></div>
                </div>
              </div>
              <div class="card__body"><div id="usage-bar">${chartPh(280)}</div></div>
            </div>
            <div class="card">
              <div class="card__head">
                <div>
                  <div class="card__title">上游模型占比</div>
                  <div class="card__sub" id="usage-pie-sub"></div>
                </div>
              </div>
              <div class="card__body"><div id="usage-pie">${chartPh(280)}</div></div>
            </div>
          </div>

          <div class="card usage-table-card">
            <div class="card__head">
              <div>
                <div class="card__title">上游模型明细</div>
                <div class="card__sub">同名模型忽略大小写合并，按最终路由的上游模型统计</div>
              </div>
              <div class="card__actions"><span class="muted fs-12" id="usage-model-count"></span></div>
            </div>
            <div id="usage-table">${tablePh()}</div>
          </div>`;
        dom = {
          requests: body.querySelector('#usage-stat-requests'),
          tokens: body.querySelector('#usage-stat-tokens'),
          rate: body.querySelector('#usage-stat-rate'),
          models: body.querySelector('#usage-stat-models'),
          scope: body.querySelector('#usage-scope'),
          bar: body.querySelector('#usage-bar'),
          barSub: body.querySelector('#usage-bar-sub'),
          pie: body.querySelector('#usage-pie'),
          pieSub: body.querySelector('#usage-pie-sub'),
          table: body.querySelector('#usage-table'),
          modelCount: body.querySelector('#usage-model-count'),
        };
      }

      function tablePh() {
        const channelHead = state.channel ? '' : '<th class="right">渠道数</th>';
        return `<div class="table-wrap table-wrap--flush"><table class="tbl usage-tbl">
          <thead><tr><th>上游模型</th>${channelHead}<th class="right">请求数</th><th class="right">成功率</th>
            <th class="right">输入 Token</th><th class="right">输出 Token</th><th class="right">总 Token</th></tr></thead>
          <tbody>${[0, 1, 2, 3, 4, 5].map(() => `<tr>
            <td>${ph(110)}</td>${state.channel ? '' : '<td class="right">' + ph(34) + '</td>'}
            <td class="right">${ph(42)}</td><td class="right">${ph(48)}</td>
            <td class="right">${ph(54)}</td><td class="right">${ph(54)}</td><td class="right">${ph(54)}</td>
          </tr>`).join('')}</tbody>
        </table></div>`;
      }

      function paintPlaceholders() {
        window.LDM.tip.hide();
        body.setAttribute('aria-busy', 'true');
        const label = (RANGES[state.range.key] || RANGES.today).label;
        dom.requests.innerHTML = statPh('zap', `${label}请求`, 104, 84);
        dom.tokens.innerHTML = statPh('bolt', `${label} Token`, 112, 142);
        dom.rate.innerHTML = statPh('check', '成功率', 88, 72);
        dom.models.innerHTML = statPh('models', '上游模型', 72, 104);
        dom.scope.textContent = scopeLabel();
        dom.barSub.textContent = '';
        dom.pieSub.textContent = '';
        clearChart(dom.bar);
        clearChart(dom.pie);
        dom.bar.innerHTML = chartPh(280);
        dom.pie.innerHTML = chartPh(280);
        dom.table.innerHTML = tablePh();
        dom.modelCount.textContent = '';
      }

      function clearError() {
        const old = body.querySelector('#usage-load-error');
        if (old) old.remove();
      }

      function showError(e) {
        clearError();
        const el = document.createElement('div');
        el.id = 'usage-load-error';
        el.className = 'alert alert--warn usage-load-error';
        el.innerHTML = `${icon('alert', 16)}<div><div class="strong">渠道用量加载失败</div>
          <div>${esc((e && e.message) || e || '未知错误')}</div></div>
          <button class="btn btn--sm" id="usage-retry">重试</button>`;
        body.insertBefore(el, body.firstChild);
        el.querySelector('#usage-retry').onclick = () => load();
      }

      async function load() {
        const seq = ++loadSeq;
        data = null;
        clearError();
        paintPlaceholders();
        try {
          const result = await API.get('/api/stats/channel-usage?' + rangeQuery());
          if (seq !== loadSeq) return;
          data = result || {};
          paintChannels();
          paintData();
        } catch (e) {
          if (seq !== loadSeq) return;
          showError(e);
        } finally {
          if (seq === loadSeq) body.removeAttribute('aria-busy');
        }
      }

      function paintChannels() {
        const channels = Array.isArray(data.channels) ? data.channels : [];
        const options = ['<option value="">全部渠道</option>'];
        let found = !state.channel;
        channels.forEach((c) => {
          const id = String(c.id || '');
          if (!id) return;
          if (id === state.channel) found = true;
          const label = c.name ? `${id}（${c.name}）` : id;
          options.push(`<option value="${esc(id)}"${id === state.channel ? ' selected' : ''}>${esc(label)}</option>`);
        });
        // 已删除的历史渠道换到一个没有统计的区间时仍保留当前选择，
        // 页面显示零用量，而不是悄悄跳回全部渠道。
        if (!found) {
          options.push(`<option value="${esc(state.channel)}" selected>${esc(state.channel)}</option>`);
        }
        channelEl.innerHTML = options.join('');
        channelEl.value = state.channel;
      }

      function scopeLabel() {
        if (!state.channel) return '全部渠道';
        const option = Array.from(channelEl.options || []).find((o) => o.value === state.channel);
        return option ? option.textContent : state.channel;
      }

      function modelValue(m) {
        return state.metric === 'tokens' ? Number(m.total_tokens) || 0 : Number(m.requests) || 0;
      }
      function sortedModels() {
        const rows = Array.isArray(data && data.models) ? data.models.slice() : [];
        rows.sort((a, b) => modelValue(b) - modelValue(a)
          || (Number(b.total_tokens) || 0) - (Number(a.total_tokens) || 0)
          || String(a.key || '').localeCompare(String(b.key || '')));
        return rows;
      }

      function paintData() {
        if (!data) return;
        body.querySelectorAll('#usage-metric button').forEach((btn) => {
          btn.classList.toggle('is-on', btn.dataset.m === state.metric);
        });
        paintStats();
        paintCharts();
        paintTable();
      }

      function paintStats() {
        const summary = data.summary || {};
        const rows = Array.isArray(data.models) ? data.models : [];
        const label = (RANGES[state.range.key] || RANGES.today).label;
        const requests = Number(summary.requests) || 0;
        const errors = Number(summary.errors) || 0;
        const successRate = Number(summary.success_rate);
        dom.requests.innerHTML = `
          <div class="stat__label">${icon('zap', 13)}${label}请求</div>
          <div class="stat__value">${fmt(requests)}<small>次</small></div>
          <div class="stat__foot">${errors ? `${fmt(errors)} 次失败` : '全部成功'}</div>`;
        dom.tokens.innerHTML = `
          <div class="stat__label">${icon('bolt', 13)}${label} Token</div>
          <div class="stat__value">${fmt(summary.total_tokens)}</div>
          <div class="stat__foot">输入 ${fmt(summary.prompt_tokens)} · 输出 ${fmt(summary.completion_tokens)}</div>`;
        dom.rate.innerHTML = `
          <div class="stat__label">${icon('check', 13)}成功率</div>
          <div class="stat__value">${(Number.isFinite(successRate) ? successRate : 100).toFixed(1)}<small>%</small></div>
          <div class="stat__foot">成功 ${fmt(Math.max(0, requests - errors))} 次</div>`;
        dom.models.innerHTML = `
          <div class="stat__label">${icon('models', 13)}上游模型</div>
          <div class="stat__value">${fmt(rows.length)}<small>个</small></div>
          <div class="stat__foot">${esc(scopeLabel())}</div>`;
        dom.scope.textContent = scopeLabel();
      }

      function paintCharts() {
        window.LDM.tip.hide();
        clearChart(dom.bar);
        clearChart(dom.pie);
        const rows = sortedModels().filter((m) => modelValue(m) > 0);
        const metricName = state.metric === 'tokens' ? 'Token' : '请求数';
        if (!rows.length) {
          const hasRequests = Number(data.summary && data.summary.requests) > 0;
          const message = hasRequests && state.metric === 'tokens' ? '当前范围有调用，但没有 Token 记录' : '当前筛选范围暂无渠道用量';
          dom.bar.innerHTML = `<div class="usage-chart-empty">${icon('box', 24)}<span>${message}</span></div>`;
          dom.pie.innerHTML = `<div class="usage-chart-empty">${icon('box', 24)}<span>${message}</span></div>`;
          dom.barSub.textContent = '';
          dom.pieSub.textContent = '';
          return;
        }

        const barRows = rows.slice(0, 12);
        barChart(dom.bar, {
          labels: barRows.map((m) => shortLabel(m.name)),
          names: barRows.map((m) => m.name),
          values: barRows.map(modelValue),
          height: 280,
          color: '#4d9e2f',
          valueFmt: fmt,
          axisFmt: fmt,
        });
        dom.barSub.textContent = `${metricName}前 ${barRows.length} 个模型${rows.length > barRows.length ? `，其余 ${rows.length - barRows.length} 个见下方明细` : ''}`;

        const pieRows = rows.slice(0, 8);
        const items = pieRows.map((m) => ({
          name: m.name,
          value: modelValue(m),
          color: colorFor(m.key || m.name),
        }));
        const rest = rows.slice(8);
        if (rest.length) {
          items.push({
            name: `其他 ${rest.length} 个模型`,
            value: rest.reduce((sum, m) => sum + modelValue(m), 0),
            color: '#8a8f98',
          });
        }
        donutChart(dom.pie, {
          items,
          size: 210,
          thickness: 24,
          valueFmt: fmt,
          centerLabel: state.metric === 'tokens' ? '总 Token' : '总调用',
        });
        dom.pieSub.textContent = `${metricName}占比${rest.length ? '，其余模型合并为“其他”' : ''}`;
      }

      function paintTable() {
        const rows = sortedModels();
        const allChannels = !state.channel;
        dom.modelCount.textContent = `共 ${rows.length} 个归并模型`;
        if (!rows.length) {
          dom.table.innerHTML = emptyState('暂无渠道用量', '当前渠道和时间范围内还没有统计记录。', '', 'channels');
          return;
        }
        dom.table.innerHTML = `<div class="table-wrap table-wrap--flush"><table class="tbl usage-tbl">
          <thead><tr>
            <th>上游模型</th>${allChannels ? '<th class="right">渠道数</th>' : ''}<th class="right">请求数</th>
            <th class="right">成功率</th><th class="right">输入 Token</th><th class="right">输出 Token</th><th class="right">总 Token</th>
          </tr></thead>
          <tbody>${rows.map((m) => {
            const name = m.key
              ? copyBadge(m.name, { label: '上游模型已复制' })
              : '<span class="muted">未记录上游</span>';
            const requests = Number(m.requests) || 0;
            const errors = Number(m.errors) || 0;
            const rate = Number(m.success_rate);
            return `<tr>
              <td>${name}</td>
              ${allChannels ? `<td class="right">${fmt(m.channel_count)}</td>` : ''}
              <td class="right">${fmt(requests)}${errors ? `<span class="usage-row-error">${fmt(errors)} 失败</span>` : ''}</td>
              <td class="right">${(Number.isFinite(rate) ? rate : 100).toFixed(1)}%</td>
              <td class="right" title="${fmtInt(m.prompt_tokens || 0)}">${fmt(m.prompt_tokens)}</td>
              <td class="right" title="${fmtInt(m.completion_tokens || 0)}">${fmt(m.completion_tokens)}</td>
              <td class="right usage-total" title="${fmtInt(m.total_tokens || 0)}">${fmt(m.total_tokens)}</td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>`;
      }
    },
  });
})();
