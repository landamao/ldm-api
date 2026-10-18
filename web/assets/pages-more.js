/* ==========================================================================
   懒大猫 API · 数据看板 / 模型广场 / 令牌 / 日志 / 设置
   ========================================================================== */
(function () {
  'use strict';

  const {
    esc, API, State, Toast, openModal, confirmDialog, promptDialog, icon, providerIcon, providerAvatar,
    badge, statusBadge, emptyState, loadingBlock, fmtTime, fmtInt, fmtNum, fmtDuration,
    fmtUptime, relTime, copyText, debounce, fmtContext, Theme, switchEl, colorBadge,
  } = window.LDM;

  const { areaChart, barChart, donutChart, rankList, timeLabel } = window.Charts;

  // 密钥默认只露头尾，点眼睛才展开——列表一屏能显示很多条，明文摆着太容易泄露
  const maskKey = (k) => {
    if (!k) return '';
    if (k.length <= 16) return k.slice(0, 4) + '••••';
    return k.slice(0, 12) + '••••' + k.slice(-4);
  };

  // 错误详情弹窗：手机端没有 hover，点状态徽章也能看到完整报错。
  function showLogError(l) {
    const status = l.status_code > 0 ? String(l.status_code) : '—';
    const channel = l.channel_id
      ? `${l.channel_id}${l.upstream_model ? ' / ' + l.upstream_model : ''}`
      : '—';
    openModal({
      title: '错误详情',
      desc: `模型 <span class="mono">${esc(l.model_id || '—')}</span> · 状态码 <span class="mono">${esc(status)}</span>`,
      body: `<div class="fs-13" style="white-space:pre-wrap;word-break:break-word;line-height:1.7">${esc(l.error || '没有记录错误信息')}</div>
        <div class="muted fs-12 mt-8">渠道 <span class="mono">${esc(channel)}</span></div>`,
      footer: `<div class="spacer"></div><button class="btn" data-close>关闭</button>`,
    });
  }

  // ======================================================================
  // 数据看板
  // ======================================================================
  const dashRange = { hours: 24 };

  window.LDM.registerPage('dashboard', {
    title: '数据看板',
    desc: '网关调用量、Token 消耗与渠道健康度',
    async render(root, actions) {
      actions.innerHTML = `
        <div class="pill-toggle" id="range-toggle">
          <button data-h="24" class="${dashRange.hours === 24 ? 'is-on' : ''}">24 小时</button>
          <button data-h="168" class="${dashRange.hours === 168 ? 'is-on' : ''}">7 天</button>
          <button data-h="720" class="${dashRange.hours === 720 ? 'is-on' : ''}">30 天</button>
        </div>
        <button class="btn" id="btn-refresh">${icon('refresh', 14)}刷新</button>`;

      actions.querySelector('#btn-refresh').onclick = () => window.LDM.navigate();
      actions.querySelectorAll('#range-toggle button').forEach((b) => {
        b.onclick = () => {
          dashRange.hours = Number(b.dataset.h);
          actions.querySelectorAll('#range-toggle button').forEach((x) => x.classList.toggle('is-on', x === b));
          load();
        };
      });

      root.innerHTML = `<div id="dash-body">${loadingBlock()}</div>`;
      const body = root.querySelector('#dash-body');

      async function load() {
        body.innerHTML = loadingBlock();
        let overview, series, breakdown, logs;
        try {
          [overview, series, breakdown, logs] = await Promise.all([
            API.get('/api/stats/overview'),
            API.get('/api/stats/series?hours=' + dashRange.hours),
            API.get('/api/stats/breakdown?hours=' + dashRange.hours),
            API.get('/api/logs?limit=8'),
          ]);
        } catch (e) {
          body.innerHTML = `<div class="card card--pad"><div class="alert alert--warn">${icon('alert', 16)}<div>${esc(e.message)}</div></div></div>`;
          return;
        }

        const t = overview.today;
        const y = overview.yesterday;
        const delta = (cur, prev) => {
          if (!prev) return cur > 0 ? '<span class="stat__delta up">新增</span>' : '<span class="muted">—</span>';
          const d = ((cur - prev) / prev) * 100;
          const cls = d >= 0 ? 'up' : 'down';
          const arrow = d >= 0 ? '↑' : '↓';
          return `<span class="stat__delta ${cls}">${arrow} ${Math.abs(d).toFixed(1)}%</span> 较昨日`;
        };

        const points = series.points || [];
        const labels = points.map((p) => timeLabel(p.time, series.step_ms * points.length));
        const times = points.map((p) => p.time);

        body.innerHTML = `
          <div class="stat-grid">
            <div class="stat">
              <div class="stat__label">${icon('zap', 13)}今日请求</div>
              <div class="stat__value">${fmtInt(t.requests)}<small>次</small></div>
              <div class="stat__foot">${delta(t.requests, y.requests)}</div>
            </div>
            <div class="stat">
              <div class="stat__label">${icon('bolt', 13)}今日 Token</div>
              <div class="stat__value">${fmtNum(t.total_tokens)}</div>
              <div class="stat__foot">${delta(t.total_tokens, y.total_tokens)}</div>
            </div>
            <div class="stat">
              <div class="stat__label">${icon('check', 13)}成功率</div>
              <div class="stat__value">${t.requests ? t.success_rate.toFixed(1) : '100.0'}<small>%</small></div>
              <div class="stat__foot">${t.errors ? `<span class="stat__delta down">${fmtInt(t.errors)} 次失败</span>` : '全部成功'}</div>
            </div>
            <div class="stat">
              <div class="stat__label">${icon('clock', 13)}平均延迟</div>
              <div class="stat__value">${t.requests ? (t.avg_latency / 1000).toFixed(2) : '0.00'}<small>s</small></div>
              <div class="stat__foot">今日平均响应耗时</div>
            </div>
            <div class="stat">
              <div class="stat__label">${icon('channels', 13)}渠道</div>
              <div class="stat__value">${overview.channels.enabled}<small>/ ${overview.channels.total}</small></div>
              <div class="stat__foot">已启用 / 总数</div>
            </div>
            <div class="stat">
              <div class="stat__label">${icon('models', 13)}模型</div>
              <div class="stat__value">${overview.models.enabled}<small>/ ${overview.models.total}</small></div>
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
                    <button data-m="requests" class="is-on">请求数</button>
                    <button data-m="tokens">Token</button>
                  </div>
                </div>
              </div>
              <div class="card__body"><div id="trend-chart"></div></div>
            </div>

            <div class="card">
              <div class="card__head">
                <div>
                  <div class="card__title">模型调用分布</div>
                  <div class="card__sub">近 ${dashRange.hours === 24 ? '24 小时' : dashRange.hours / 24 + ' 天'}</div>
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
          areaChart(trendHost, { labels, times, series: s, height: 216, spanMs: series.step_ms });
        };
        drawTrend('requests');
        body.querySelectorAll('#metric-toggle button').forEach((b) => {
          b.onclick = () => {
            body.querySelectorAll('#metric-toggle button').forEach((x) => x.classList.toggle('is-on', x === b));
            drawTrend(b.dataset.m);
          };
        });

        donutChart(body.querySelector('#model-donut'), {
          items: (breakdown.models || []).map((x) => ({ name: x.name, value: x.value })),
        });

        rankList(body.querySelector('#channel-rank'), breakdown.channels || [], { nameWidth: 200 });
        rankList(body.querySelector('#token-rank'), breakdown.tokens || [], { nameWidth: 200 });

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
                  <td class="right num">${fmtInt(l.total_tokens)}</td>
                  <td>${l.canceled
                    ? `<button type="button" class="badge badge--amber badge--click" data-recent-error="${idx}" title="${esc(l.error)}">${esc(l.status_code || 200)}</button>`
                    : (l.status_code > 0 && l.status_code < 400 && !l.error
                      ? '<span class="badge badge--green">成功</span>'
                      : (l.error
                        ? `<button type="button" class="badge badge--red badge--click" data-recent-error="${idx}" title="${esc(l.error)}">${esc(l.status_code || '失败')}</button>`
                        : `<span class="badge badge--red">${esc(l.status_code || '失败')}</span>`))}</td>
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

    // 来源：自定义模型展示路由模型列表，有分组时按组显示（与模型配置页一致）；
    // 渠道模型展示所属渠道。
    const routeItemHtml = (r, num, inGroup) => `
      <div class="route-item ${inGroup ? 'is-grouped' : ''}">
        ${num ? `<span class="route-item__idx">${num}</span>` : ''}
        <span class="route-item__name" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.model_id)}</span>
        <span class="route-item__meta">
          ${r.channel_name ? `<span class="muted fs-12" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.channel_name)}</span>` : ''}
          ${r.channel_ready ? badge('可用', 'green') : badge('渠道已禁用', 'red')}
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
        <div class="drawer__body">
          ${m.description ? `<div class="drawer__section"><div class="alert alert--pink">${icon('info', 15)}<div>${esc(m.description)}</div></div></div>` : ''}

          <div class="drawer__section">
            <div class="section-title">基本信息</div>
            <dl class="kv">
              ${row('模型 ID', `<span class="mono">${esc(m.id)}</span>`)}
              ${row('类型', isCustom ? '自定义模型' : '渠道模型')}
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

          <div class="drawer__section">
            <div class="btn-row">
              <button class="btn btn--sm" data-act="copy">${icon('copy', 13)}复制模型 ID</button>
              <button class="btn btn--sm btn--primary" data-act="chat" ${m.available ? '' : 'disabled'}>${icon('chat', 13)}去对话</button>
            </div>
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

  // ======================================================================
  // 在线对话
  // ======================================================================
  function rateColor(r) {
    r = Number(r) || 0;
    if (r >= 99) return 'var(--green-500)';
    if (r >= 90) return 'var(--amber-500)';
    return 'var(--red-500)';
  }

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

      const preset = window.LDM.routeParam('model');
      const initial = usable.some((m) => m.id === preset) ? preset : usable[0].id;

      root.innerHTML = `
        <div class="card" style="display:flex;flex-direction:column;height:calc(100vh - 190px);min-height:440px;overflow:hidden">
          <div class="toolbar">
            <select class="select" id="chat-model" style="width:auto;min-width:240px;max-width:380px">
              ${usable.map((m) => `<option value="${esc(m.id)}"${m.id === initial ? ' selected' : ''}>${esc(m.id)}</option>`).join('')}
            </select>
            <span class="badge badge--pink" id="chat-kind"></span>
            <span class="muted fs-12 truncate" id="chat-route" style="max-width:320px"></span>
            <div class="toolbar__spacer"></div>
            ${switchEl(true, '流式输出', 'id="chat-stream" title="关闭后等完整回复再一次性显示"')}
            <label class="muted fs-12" for="chat-temp">温度</label>
            <input class="input input--sm" id="chat-temp" type="number" min="0" max="2" step="0.1" value="0.7" style="width:76px">
            <button class="btn btn--sm" id="chat-clear">${icon('trash', 13)}清空对话</button>
          </div>
          <div class="chat-log" id="chat-log" style="flex:1"></div>
          <div class="chat-input">
            <textarea class="textarea" id="chat-text" rows="1" placeholder="输入消息，Enter 发送，Shift+Enter 换行"></textarea>
            <button class="btn btn--primary" id="chat-send">${icon('send', 14)}发送</button>
          </div>
        </div>`;

      const modelSel = root.querySelector('#chat-model');
      const kindEl = root.querySelector('#chat-kind');
      const routeEl = root.querySelector('#chat-route');
      const log = root.querySelector('#chat-log');
      const text = root.querySelector('#chat-text');
      const sendBtn = root.querySelector('#chat-send');
      const tempEl = root.querySelector('#chat-temp');
      const streamToggle = root.querySelector('#chat-stream');
      const streamInput = streamToggle.querySelector('input');

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

      let history = [];
      let sending = false;
      // 正在进行的流式请求；点「停止」时用它中断 fetch，服务端会随连接断开取消上游
      let abortCtl = null;

      // 流式输出开关：关闭后等上游一次性返回完整回复再显示；选择记在本地
      const STREAM_KEY = 'ldmapi.chat.stream';
      let streaming = true;
      try { streaming = localStorage.getItem(STREAM_KEY) !== '0'; } catch (e) { /* 存储不可用时默认开启 */ }
      streamInput.checked = streaming;
      streamInput.onchange = () => {
        streaming = streamInput.checked;
        try { localStorage.setItem(STREAM_KEY, streaming ? '1' : '0'); } catch (e) { /* 忽略配额错误 */ }
        text.focus();
      };

      const currentModel = () => usable.find((m) => m.id === modelSel.value) || usable[0];

      // 对话记录按模型分别存在浏览器本地，刷新或下次打开还在
      // 对话只有一份，切换模型不会另起一段：换模型只影响之后发出的消息
      const CHAT_KEY = 'ldmapi.chat';
      const loadHistory = () => {
        try {
          const raw = localStorage.getItem(CHAT_KEY);
          if (!raw) return [];
          const arr = JSON.parse(raw);
          return Array.isArray(arr) ? arr : [];
        } catch (e) {
          return [];
        }
      };
      const persistHistory = () => {
        try {
          if (!history.length) localStorage.removeItem(CHAT_KEY);
          else localStorage.setItem(CHAT_KEY, JSON.stringify(history));
        } catch (e) {
          // 超出 localStorage 配额时静默跳过，不影响对话
        }
      };

      const refreshMeta = () => {
        const m = currentModel();
        kindEl.textContent = m.type === 'custom' ? '自定义模型' : '渠道模型';
        if (m.type === 'custom') {
          routeEl.textContent = '路由：' + (m.routes || []).map((r) => r.model_id).join(' → ');
        } else {
          routeEl.textContent = '来源：' + (m.channel_id || '') + (m.channel_name ? '（' + m.channel_name + '）' : '');
        }
      };

      const addMsg = (role, content, isError, providerIconKey) => {
        const el = document.createElement('div');
        el.className = 'msg msg--' + (role === 'user' ? 'user' : 'assistant') + (isError ? ' msg--error' : '');
        el.innerHTML = avatarHtml(role, providerIconKey)
          + '<div class="msg__body"><div class="msg__bubble"></div></div>';
        el.querySelector('.msg__bubble').textContent = content;
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
        el.className = 'msg msg--' + (m.role === 'user' ? 'user' : 'assistant');
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
        const ans = document.createElement('div');
        ans.className = 'msg__answer';
        ans.textContent = m.content || '';
        bubble.appendChild(ans);
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
        history = [];
        persistHistory();
        log.innerHTML = '';
        refreshMeta();
      };

      // 清掉早期按模型分开存的旧记录，避免残留在本地占空间
      const dropLegacyHistories = () => {
        try {
          for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k && k.startsWith(CHAT_KEY + '.')) localStorage.removeItem(k);
          }
        } catch (e) { /* 存储不可用时忽略 */ }
      };

      // 进入页面时恢复上一次的对话（不生成任何占位消息）
      const restore = () => {
        dropLegacyHistories();
        history = loadHistory();
        log.innerHTML = '';
        refreshMeta();
        if (!history.length) return;
        history.forEach(renderStored);
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
        streamInput.disabled = busy;
        streamToggle.classList.toggle('is-disabled', busy);
        log.querySelectorAll('[data-retry], [data-delete]').forEach((b) => { b.disabled = busy; });
      };

      const stopStream = () => {
        if (!sending || !abortCtl) return;
        abortCtl.abort();
      };

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
        makeBtn('retry', 'refresh', '用当前选中的模型重新生成（会移除这条之后的消息）', () => retryAssistant(entry, msgEl));
        makeBtn('copy', 'copy', '复制这条回复', () => copyText(entry.content || '', '回复内容'));
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
          persistHistory();
          // DOM 里同样移除这条回复和它前面的用户消息
          let prev = msgEl.previousElementSibling;
          while (prev && !prev.classList.contains('msg--user')) prev = prev.previousElementSibling;
          if (prev) prev.remove();
          msgEl.remove();
          Toast.success('这一轮对话已删除');
        });
        body.appendChild(row);
      };

      // 只负责一次流式调用与气泡渲染，历史由调用方维护
      const streamAssistant = async ({ messages, sentModel, bubble }) => {
        // 统计：首字耗时 + 上游返回的用量
        const t0 = Date.now();
        let firstTokenMs = 0;
        let usage = null;

        // 思考内容和正文分开渲染：思考放进可折叠块，正文放下面
        let think = '';
        let answer = '';
        let thinkBlock = null;
        let thinkBody = null;
        let thinkMeta = null;
        let answerEl = null;
        let thinkFolded = false;

        // 用户点「停止」时中断 fetch；已生成的内容保留，按正常回复收尾
        const ctl = new AbortController();
        abortCtl = ctl;
        let stopped = false;
        let failed = null;
        const isAbort = (e) => (e && e.name === 'AbortError') || ctl.signal.aborted;

        const clearPlaceholder = () => {
          if (bubble.querySelector('.typing')) bubble.innerHTML = '';
        };
        const ensureThink = () => {
          if (thinkBlock) return;
          clearPlaceholder();
          const det = document.createElement('details');
          det.className = 'think-block';
          det.open = true;
          det.innerHTML = '<summary>深度思考<span class="think-block__meta"></span></summary>'
            + '<div class="think-block__body"></div>';
          bubble.insertBefore(det, bubble.firstChild);
          thinkBlock = det;
          thinkBody = det.querySelector('.think-block__body');
          thinkMeta = det.querySelector('.think-block__meta');
          thinkMeta.textContent = ' 思考中…';
        };
        const ensureAnswer = () => {
          if (answerEl) return;
          clearPlaceholder();
          answerEl = document.createElement('div');
          answerEl.className = 'msg__answer';
          bubble.appendChild(answerEl);
        };

        try {
          const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            signal: ctl.signal,
            body: JSON.stringify({
              model: sentModel.id,
              // 只发正文，思考内容不参与上下文
              messages: messages.map((m) => ({ role: m.role, content: m.content })),
              stream: streaming,
              temperature: Number(tempEl.value) || 0,
            }),
          });
          if (!res.ok) {
            let msg = `HTTP ${res.status}`;
            try {
              const j = await res.json();
              msg = (j.error && j.error.message) || msg;
            } catch (e) { /* 响应不是 JSON，保留状态码 */ }
            throw new Error(msg);
          }
          if (!streaming) {
            // 非流式：等完整响应，思考与正文一次性渲染
            const j = await res.json();
            usage = j.usage || null;
            const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
            const reasoning = msg.reasoning_content || msg.reasoning || '';
            if (reasoning) {
              ensureThink();
              think = reasoning;
              thinkBody.textContent = think;
              thinkFolded = true;
              thinkBlock.open = false;
              thinkMeta.textContent = ` ${think.length} 字`;
            }
            if (msg.content) {
              ensureAnswer();
              answer = msg.content;
              answerEl.textContent = answer;
            }
            log.scrollTop = log.scrollHeight;
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
                if (isAbort(e)) { stopped = true; break; }
                throw e;
              }
              if (chunk.done) break;
              buf += decoder.decode(chunk.value, { stream: true });
              const lines = buf.split('\n');
              buf = lines.pop();
              for (const line of lines) {
                const t = line.trim();
                if (!t.startsWith('data:')) continue;
                const payload = t.slice(5).trim();
                if (payload === '[DONE]') continue;
                let j;
                try { j = JSON.parse(payload); } catch (e) { continue; }
                if (j.usage) usage = j.usage;
                const d = j.choices && j.choices[0] && j.choices[0].delta;
                if (!d) continue;
                if (!firstTokenMs && (d.reasoning_content || d.content)) {
                  firstTokenMs = Date.now() - t0;
                }
                if (d.reasoning_content) {
                  ensureThink();
                  think += d.reasoning_content;
                  thinkBody.textContent = think;
                  thinkMeta.textContent = ` 思考中…（${think.length} 字）`;
                }
                if (d.content) {
                  ensureAnswer();
                  // 正文开始了就把思考块收起来，想看还能再点开
                  if (thinkBlock && !thinkFolded) {
                    thinkFolded = true;
                    thinkBlock.open = false;
                    thinkMeta.textContent = ` ${think.length} 字`;
                  }
                  answer += d.content;
                  answerEl.textContent = answer;
                }
              }
              log.scrollTop = log.scrollHeight;
            }
          }
        } catch (e) {
          if (isAbort(e)) stopped = true;
          else failed = e;
        } finally {
          abortCtl = null;
        }

        if (failed) {
          bubble.parentElement.classList.add('msg--error');
          bubble.textContent = '调用失败：' + (failed.message || failed);
          setBusy(false);
          log.scrollTop = log.scrollHeight;
          return { ok: false, error: failed };
        }

        if (thinkBlock && !thinkFolded) {
          thinkBlock.open = false;
          thinkMeta.textContent = ` ${think.length} 字`;
        }
        if (!answer && !think) {
          bubble.textContent = stopped ? '（已停止生成）' : '（模型没有返回内容）';
        }

        const totalMs = Date.now() - t0;

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
          const genMs = totalMs - firstTokenMs;
          if (streaming && usage.completion_tokens && genMs > 0) {
            outputParts.push(`${(usage.completion_tokens * 1000 / genMs).toFixed(1)} t/s`);
          }
        }

        // 耗时组：首字、总耗时，总 token 跟在耗时后面
        const timingParts = [];
        if (firstTokenMs) timingParts.push(`首字 ${fmtDuration(firstTokenMs)}`);
        timingParts.push(`总耗时 ${fmtDuration(totalMs)}`);
        if (usage && usage.total_tokens) timingParts.push(`总token ${fmtInt(usage.total_tokens)}`);

        // 对话共用一份历史，所以在每条回复上标明用的是哪个模型
        const metaGroups = [[`模型 ${sentModel.id}`], inputParts, outputParts, timingParts]
          .filter((g) => g.length);
        if (stopped) metaGroups.push(['已停止生成']);
        setMeta(bubble, metaGroups);

        // 只把正文带回下一轮，思考内容与统计信息单独存起来用于回看
        if (answer || think) {
          const entry = { role: 'assistant', content: answer, model: sentModel.id };
          if (think) entry.think = think;
          if (metaGroups.length) entry.meta = metaGroups;
          if (sentModel.provider_icon) entry.provider_icon = sentModel.provider_icon;
          setBusy(false);
          log.scrollTop = log.scrollHeight;
          return { ok: true, entry };
        }
        setBusy(false);
        log.scrollTop = log.scrollHeight;
        return { ok: true, entry: null };
      };

      const retryAssistant = async (entry, msgEl) => {
        if (sending) return;
        const idx = history.indexOf(entry);
        if (idx < 0) return;
        // 用当前选中的模型重试，而不是这条消息生成时的模型
        const sentModel = currentModel();
        // 重试点之后的消息全部丢弃，保证上下文连续
        history = history.slice(0, idx);
        persistHistory();
        const all = [...log.querySelectorAll('.msg')];
        const pos = all.indexOf(msgEl);
        if (pos >= 0) all.slice(pos).forEach((el) => el.remove());

        setBusy(true);
        const bubble = addMsg('assistant', '', false, sentModel.provider_icon);
        bubble.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
        const res = await streamAssistant({ messages: history.slice(), sentModel, bubble });
        if (res.ok && res.entry) {
          history.push(res.entry);
          persistHistory();
          addMessageActions(bubble.closest('.msg'), res.entry);
        }
      };

      const doSend = async () => {
        const v = text.value.trim();
        if (!v || sending) return;
        // 先固定本轮使用的模型，避免流式过程中切换模型导致头像/统计错位
        const sentModel = currentModel();
        text.value = '';
        text.style.height = 'auto';
        addMsg('user', v);
        history.push({ role: 'user', content: v });
        persistHistory();

        setBusy(true);
        const bubble = addMsg('assistant', '', false, sentModel.provider_icon);
        bubble.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
        const res = await streamAssistant({ messages: history.slice(), sentModel, bubble });
        if (res.ok && res.entry) {
          history.push(res.entry);
          persistHistory();
          addMessageActions(bubble.closest('.msg'), res.entry);
        } else if (!res.ok) {
          // 失败时保持原行为：不把这条用户消息留在上下文里
          history.pop();
          persistHistory();
        }
      };

      // 换模型只更新顶部的路由信息，已有的对话原样保留
      modelSel.onchange = () => {
        refreshMeta();
        text.focus();
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

      // 离开页面时中断还在进行的请求，避免后台继续生成
      const onLeave = () => {
        window.removeEventListener('hashchange', onLeave);
        stopStream();
      };
      window.addEventListener('hashchange', onLeave);

      restore();
      setTimeout(() => text.focus(), 120);
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
            <th style="min-width:140px">用量</th><th>模型权限</th><th>最后使用</th><th style="width:150px"></th>
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
    const t = token || { name: '', enabled: true, expires_at: 0, quota_limit: 0, allowed_models: [], remark: '' };
    let models = [];
    try { models = await API.get('/api/models'); } catch (e) { /* ignore */ }
    const enabledModels = models.filter((m) => m.enabled);

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
        <div class="field__hint" style="margin-top:0;margin-bottom:8px">不勾选表示可以使用全部模型。</div>
        <div class="pick-list" style="max-height:220px">
          ${enabledModels.length === 0 ? '<div style="padding:14px;color:var(--text-3);font-size:12.5px">还没有已启用的模型</div>' : enabledModels.map((m) => `
            <label class="pick-item" style="padding-left:13px">
              <input type="checkbox" data-model="${esc(m.id)}" ${(t.allowed_models || []).includes(m.id) ? 'checked' : ''}>
              <span class="pick-item__name">${esc(m.id)}</span>
              <span class="pick-item__meta">${m.type === 'custom' ? badge('自定义', 'pink') : badge('渠道', 'blue')}</span>
            </label>`).join('')}
        </div>
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
        mo.foot.querySelector('[data-act=cancel]').onclick = () => mo.close();
        const copyBtn = mo.foot.querySelector('[data-act=copykey]');
        if (copyBtn) copyBtn.onclick = () => copyText(t.key, '密钥 ');
        mo.foot.querySelector('[data-act=save]').onclick = async () => {
          const name = mo.body.querySelector('#t-name').value.trim();
          if (!name) { Toast.warn('请填写名称'); return; }
          const expireVal2 = mo.body.querySelector('#t-expire').value;
          const allowed = Array.from(mo.body.querySelectorAll('input[data-model]:checked')).map((i) => i.dataset.model);
          const payload = {
            id: t.id || '',
            name,
            enabled: mo.body.querySelector('#t-enabled').checked,
            expires_at: expireVal2 ? new Date(expireVal2 + 'T23:59:59').getTime() : 0,
            quota_limit: Number(mo.body.querySelector('#t-quota').value) || 0,
            allowed_models: allowed,
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
            </select>
            <div class="toolbar__spacer"></div>
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
      q('#page-prev').onclick = () => {
        logState.offset = Math.max(0, logState.offset - logState.limit);
        load();
      };
      q('#page-next').onclick = () => {
        logState.offset += logState.limit;
        load();
      };

      // 重试历史：每次尝试的渠道、状态码、耗时与错误，全部来自日志里的 attempts。
      function showRetryHistory(l) {
        const attempts = l.attempts || [];
        const rows = attempts.map((a, i) => {
          const ok = a.status_code > 0 && a.status_code < 400 && !a.error;
          const softFail = a.status_code > 0 && a.status_code < 400 && !!a.error;
          const channel = a.channel_name
            ? `${a.channel_id}（${a.channel_name}）`
            : (a.channel_id || '—');
          return `<tr>
            <td class="muted num">${i + 1}</td>
            <td class="mono" style="white-space:nowrap">${esc(channel)}</td>
            <td class="mono">${esc(a.upstream_model || '—')}</td>
            <td>${ok ? badge('成功', 'green') : softFail ? badge(String(a.status_code), 'amber') : badge(String(a.status_code || '失败'), 'red')}</td>
            <td class="right num">${esc(fmtDuration(a.latency_ms))}</td>
            <td class="fs-12" style="white-space:pre-wrap;word-break:break-word;max-width:340px">${a.error ? esc(a.error) : '<span class="muted">—</span>'}</td>
          </tr>`;
        }).join('');
        const finalOK = l.status_code > 0 && l.status_code < 400 && !l.error;
        openModal({
          title: '重试历史',
          desc: `模型 <span class="mono">${esc(l.model_id || '—')}</span> · 共 ${attempts.length} 次尝试 · ${finalOK ? '最终成功' : '最终失败'}`,
          size: 'lg',
          body: attempts.length ? `<div class="table-wrap" style="border:none;border-radius:0">
            <table class="tbl">
              <thead><tr>
                <th style="width:40px">#</th><th style="min-width:160px">渠道</th><th>上游模型</th>
                <th>状态码</th><th class="right">耗时</th><th>错误信息</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>` : emptyState('没有尝试明细', '这条日志产生于旧版本，没有记录每次重试的明细。', '', 'refresh'),
          footer: `<div class="spacer"></div><button class="btn" data-close>关闭</button>`,
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
          q('#log-total').textContent = `共 ${fmtInt(res.total)} 条，当前显示第 ${logState.offset + 1} - ${logState.offset + items.length} 条`;
          q('#page-prev').disabled = logState.offset === 0;
          q('#page-next').disabled = logState.offset + items.length >= res.total;
          if (!items.length) {
            const emptyDesc = logState.status === 'error'
              ? '当前只看失败请求，把状态筛选切回「全部状态」试试。'
              : logState.status === 'success'
                ? '当前只看成功请求，把状态筛选切回「全部状态」试试。'
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
                    ${colorBadge(l.model_id)}
                    ${l.stream ? '<span class="badge badge--gray">流式</span>' : ''}
                    ${l.retries ? `<button type="button" class="badge badge--amber badge--click" data-attempts="${idx}" title="点击查看重试历史">${icon('refresh', 11)}重试 ${l.retries}</button>` : ''}
                  </div>
                </td>
                <td class="fs-12">
                  ${l.channel_id
                    ? `${colorBadge(channelLabel(l.channel_id))}
                       ${l.upstream_model ? `<div class="muted fs-12 mono" style="margin-top:2px">${esc(l.upstream_model)}</div>` : ''}`
                    : '<span class="muted">未命中渠道</span>'}
                </td>
                <td class="fs-12">${colorBadge(l.token_name)}</td>
                <td class="right num">${fmtInt(l.prompt_tokens)}
                  ${l.cached_tokens ? `<div class="muted fs-12">缓存读 ${fmtInt(l.cached_tokens)}</div>` : ''}</td>
                <td class="right num">${fmtInt(l.completion_tokens)}
                  ${l.reasoning_tokens
                    ? `<div class="muted fs-12">思考 ${fmtInt(l.reasoning_tokens)}</div>`
                    : (l.reasoning_chars ? `<div class="muted fs-12">思考 ${fmtInt(l.reasoning_chars)} 字</div>` : '')}
                  ${l.tokens_per_sec ? `<div class="muted fs-12">${l.tokens_per_sec.toFixed(1)} t/s</div>` : ''}</td>
                <td class="right num">${esc(fmtDuration(l.latency_ms))}
                  ${l.first_byte_ms ? `<div class="muted fs-12">首字 ${esc(fmtDuration(l.first_byte_ms))}</div>` : ''}
                  <div class="muted fs-12">总token ${fmtInt(l.total_tokens)}</div></td>
                <td>${l.canceled
                  ? `<button type="button" class="badge badge--amber badge--click" data-log-error="${idx}" title="${esc(l.error)}">${esc(l.status_code || 200)}</button>`
                  : (l.status_code > 0 && l.status_code < 400 && !l.error
                    ? '<span class="badge badge--green">成功</span>'
                    : (l.error
                      ? `<button type="button" class="badge badge--red badge--click" data-log-error="${idx}" title="${esc(l.error)}">${esc(l.status_code || '失败')}</button>`
                      : `<span class="badge badge--red">${esc(l.status_code || '失败')}</span>`))}</td>
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
        } catch (e) {
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
            <div><div class="card__title">运行信息</div><div class="card__sub">当前实例状态</div></div>
          </div>
          <div class="card__body">
            <div class="stat-grid stat-grid--4" style="margin-bottom:0">
              <div class="stat">
                <div class="stat__label">版本</div>
                <div class="stat__value" style="font-size:19px">v${esc(me.version)}</div>
              </div>
              <div class="stat">
                <div class="stat__label">已运行</div>
                <div class="stat__value" style="font-size:19px">${esc(fmtUptime(me.uptime_seconds))}</div>
              </div>
              <div class="stat">
                <div class="stat__label">渠道 / 模型 / 密钥</div>
                <div class="stat__value" style="font-size:19px">${me.counts.channels} / ${me.counts.models} / ${me.counts.tokens}</div>
              </div>
              <div class="stat">
                <div class="stat__label">累计日志</div>
                <div class="stat__value" style="font-size:19px">${fmtInt(me.counts.logs)}</div>
              </div>
            </div>
            <div class="alert alert--info mt-16">${icon('info', 15)}<div>
              <span class="strong">API 地址：</span><code>${esc(location.origin)}/v1</code> —— 兼容 OpenAI 协议，
              把任何 OpenAI SDK 的 <code>base_url</code> 指向这里、<code>api_key</code> 换成令牌管理里创建的密钥即可。
            </div></div>
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
