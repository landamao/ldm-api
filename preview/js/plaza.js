/* ==========================================================================
   模型广场
   —— 取 new-api 模型广场的「大字标题 + 左侧筛选 + 卡片网格」版式，
      内容严格用本站现有字段：提供商、类型、能力参数、上下文、路由链、
      近 24h / 近 200 次成功率。没有价格体系，所以不出现任何价格/倍率。
   ========================================================================== */
(function () {
  'use strict';

  const {
    esc, icon, fmtInt, fmtContext, providerIcon, providerAvatar,
    badge, copyBadge, capBadges, Toast, openDrawer, debounce, emptyState,
  } = window.PV;
  const D = window.PVDATA;

  const state = {
    q: '',
    provider: 'all',
    type: 'all',
    caps: new Set(),
    tags: new Set(),
    sort: '',
    view: 'grid',
  };

  let ui = null;
  let items = [];

  const CAP_FILTERS = [
    ['tool', '工具调用'],
    ['think', '思考'],
    ['vision', '图片'],
    ['long', '长上下文 200K+'],
  ];

  function filtered() {
    let list = items.filter((m) => m.available);
    const q = state.q.trim().toLowerCase();
    if (q) {
      const hay = [m.id, m.display_name, m.description, m.provider_name, (m.tags || []).join(' ')].join(' ').toLowerCase();
      if (!hay.includes(q)) return [];
    }
    if (state.type !== 'all') list = list.filter((m) => m.type === state.type);
    if (state.provider === '__none') list = list.filter((m) => !m.provider_id || !D.provider(m.provider_id));
    else if (state.provider !== 'all') list = list.filter((m) => m.provider_id === state.provider);
    state.caps.forEach((cap) => {
      list = list.filter((m) => {
        const c = m.caps || {};
        if (cap === 'tool') return c.tool_calling === true;
        if (cap === 'think') return c.thinking === true;
        if (cap === 'vision') return c.vision === true;
        if (cap === 'long') return (c.context_length || 0) >= 200000;
        return true;
      });
    });
    state.tags.forEach((tag) => {
      list = list.filter((m) => (m.tags || []).includes(tag));
    });
    const rate = (m, key) => (m[key] < 0 ? -1 : m[key]);
    const dir = state.sort.endsWith('_asc') ? 1 : -1;
    if (state.sort.startsWith('r24')) {
      list.sort((a, b) => {
        const va = rate(a, 'success_rate');
        const vb = rate(b, 'success_rate');
        if (va < 0 && vb < 0) return b.requests_24h - a.requests_24h;
        if (va < 0) return 1;
        if (vb < 0) return -1;
        return dir * (va - vb) || b.requests_24h - a.requests_24h;
      });
    } else if (state.sort.startsWith('r200')) {
      list.sort((a, b) => {
        const va = rate(a, 'success_rate_200');
        const vb = rate(b, 'success_rate_200');
        if (va < 0 && vb < 0) return b.requests_200 - a.requests_200;
        if (va < 0) return 1;
        if (vb < 0) return -1;
        return dir * (va - vb) || b.requests_200 - a.requests_200;
      });
    } else if (state.sort === 'name') {
      list.sort((a, b) => a.id.localeCompare(b.id));
    }
    return list;
  }

  function providerCounts(list) {
    const map = new Map();
    list.filter((m) => m.available).forEach((m) => {
      const key = m.provider_id && D.provider(m.provider_id) ? m.provider_id : '__none';
      map.set(key, (map.get(key) || 0) + 1);
    });
    return map;
  }

  function tagCounts(list) {
    const map = new Map();
    list.filter((m) => m.available).forEach((m) => {
      new Set(m.tags || []).forEach((t) => map.set(t, (map.get(t) || 0) + 1));
    });
    return map;
  }

  function render(root) {
    items = D.plazaItems();
    const total = items.filter((m) => m.available).length;
    const counts = providerCounts(items);
    const tags = tagCounts(items);

    root.innerHTML = `
      <section class="plaza-hero">
        <h1>模型广场<span class="leaf-dot">.</span></h1>
        <div class="plaza-hero__sub">本站已启用 <b>${total}</b> 个模型</div>
        <div class="plaza-hero__hint">先看能力与上下文，再点开详情看路由；选好直接进对话试。</div>
        <div class="plaza-search">
          <span class="plaza-search__icon">${icon('search', 17)}</span>
          <input class="input" id="plaza-search" placeholder="搜索模型名称、供应商、能力或标签…" value="${esc(state.q)}" autocomplete="off">
          <button class="plaza-search__clear" id="plaza-search-clear" title="清空搜索" ${state.q ? '' : 'hidden'}>${icon('x', 14)}</button>
        </div>
      </section>

      <div class="plaza-layout">
        <aside class="plaza-side">
          <div class="plaza-side__sec">
            <div class="plaza-side__head">提供商</div>
            <button class="plaza-provider${state.provider === 'all' ? ' is-on' : ''}" data-p="all">
              <span class="plaza-provider__name">全部提供商</span>
              <span class="plaza-provider__count">${total}</span>
            </button>
            ${D.providers.filter((p) => counts.get(p.id)).map((p) => `
              <button class="plaza-provider${state.provider === p.id ? ' is-on' : ''}" data-p="${esc(p.id)}">
                ${providerIcon(p.icon, 15)}
                <span class="plaza-provider__name">${esc(p.name)}</span>
                <span class="plaza-provider__count">${counts.get(p.id)}</span>
              </button>`).join('')}
            ${counts.get('__none') ? `
              <button class="plaza-provider${state.provider === '__none' ? ' is-on' : ''}" data-p="__none">
                ${providerIcon('', 15)}
                <span class="plaza-provider__name">未设置</span>
                <span class="plaza-provider__count">${counts.get('__none')}</span>
              </button>` : ''}
          </div>

          <div class="plaza-side__sec">
            <div class="plaza-side__head">类型</div>
            <div class="plaza-side__chips">
              ${[['all', '全部'], ['custom', '自定义'], ['channel', '渠道']].map(([v, t]) => `
                <button class="chip${state.type === v ? ' is-on' : ''}" data-type="${v}">${t}</button>`).join('')}
            </div>
          </div>

          <div class="plaza-side__sec">
            <div class="plaza-side__head">能力</div>
            <div class="plaza-side__chips">
              ${CAP_FILTERS.map(([v, t]) => `
                <button class="chip${state.caps.has(v) ? ' is-on' : ''}" data-cap="${v}">${t}</button>`).join('')}
            </div>
          </div>

          ${tags.size ? `
          <div class="plaza-side__sec">
            <div class="plaza-side__head">标签</div>
            <div class="plaza-side__chips">
              ${[...tags.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `
                <button class="chip${state.tags.has(t) ? ' is-on' : ''}" data-tag="${esc(t)}">${esc(t)}<span class="chip__count">${n}</span></button>`).join('')}
            </div>
          </div>` : ''}

          <div class="plaza-side__sec">
            <button class="chip" id="plaza-clear">${icon('x', 12)}清除筛选</button>
          </div>
        </aside>

        <main>
          <div class="plaza-toolbar">
            <span class="plaza-toolbar__count" id="plaza-count"></span>
            <span class="tool-row__spacer"></span>
            <select class="select" id="plaza-sort" aria-label="排序">
              <option value="">默认排序</option>
              <option value="r24_desc">近 24h 成功率 从高到低</option>
              <option value="r24_asc">近 24h 成功率 从低到高</option>
              <option value="r200_desc">近 200 次成功率 从高到低</option>
              <option value="r200_asc">近 200 次成功率 从低到高</option>
              <option value="name">按模型 ID</option>
            </select>
            <div class="plaza-view-toggle">
              <button data-view="grid" class="${state.view === 'grid' ? 'is-on' : ''}" title="网格">${icon('grid', 14)}</button>
              <button data-view="list" class="${state.view === 'list' ? 'is-on' : ''}" title="列表">${icon('list', 14)}</button>
            </div>
          </div>
          <div id="plaza-grid"></div>
        </main>
      </div>`;

    document.getElementById('plaza-sort').value = state.sort;
    ui = {
      grid: document.getElementById('plaza-grid'),
      count: document.getElementById('plaza-count'),
      search: document.getElementById('plaza-search'),
      clear: document.getElementById('plaza-search-clear'),
    };

    ui.search.addEventListener('input', debounce(() => {
      state.q = ui.search.value;
      ui.clear.hidden = !state.q;
      paint();
    }, 160));
    ui.clear.onclick = () => {
      state.q = '';
      ui.search.value = '';
      ui.clear.hidden = true;
      paint();
      ui.search.focus();
    };
    document.getElementById('plaza-sort').onchange = (e) => {
      state.sort = e.target.value;
      paint();
    };
    root.querySelectorAll('[data-view]').forEach((btn) => {
      btn.onclick = () => {
        state.view = btn.dataset.view;
        root.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('is-on', b === btn));
        paint();
      };
    });
    root.querySelectorAll('[data-p]').forEach((btn) => {
      btn.onclick = () => {
        state.provider = btn.dataset.p;
        render(root);
      };
    });
    root.querySelectorAll('[data-type]').forEach((btn) => {
      btn.onclick = () => {
        state.type = btn.dataset.type;
        render(root);
      };
    });
    root.querySelectorAll('[data-cap]').forEach((btn) => {
      btn.onclick = () => {
        const v = btn.dataset.cap;
        if (state.caps.has(v)) state.caps.delete(v);
        else state.caps.add(v);
        render(root);
      };
    });
    root.querySelectorAll('[data-tag]').forEach((btn) => {
      btn.onclick = () => {
        const v = btn.dataset.tag;
        if (state.tags.has(v)) state.tags.delete(v);
        else state.tags.add(v);
        render(root);
      };
    });
    document.getElementById('plaza-clear').onclick = () => {
      state.q = '';
      state.provider = 'all';
      state.type = 'all';
      state.caps.clear();
      state.tags.clear();
      state.sort = '';
      render(root);
    };

    paint();
  }

  function paint() {
    const list = filtered();
    ui.count.innerHTML = `共 <b>${list.length}</b> 个模型`;
    ui.grid.className = 'plaza-grid' + (state.view === 'list' ? ' plaza-grid--list' : '');

    if (!list.length) {
      const hasAny = items.some((m) => m.available);
      ui.grid.className = '';
      ui.grid.innerHTML = hasAny
        ? `<div class="empty empty--bare">
             <div class="empty__icon">${icon('search', 34)}</div>
             <div class="empty__title">没有匹配的模型</div>
             <div class="empty__desc">换个关键词或筛选条件试试。</div>
             <button class="chip" id="plaza-empty-clear">清除筛选</button>
           </div>`
        : `<div class="empty empty--bare">
             <div class="empty__icon">${icon('plaza', 34)}</div>
             <div class="empty__title">还没有可用的模型</div>
             <div class="empty__desc">先在「模型管理」配置渠道、把模型加进来并启用，广场才会出现。</div>
             <button class="btn btn--primary btn--sm" id="plaza-empty-goto">去模型管理</button>
           </div>`;
      const c = ui.grid.querySelector('#plaza-empty-clear');
      if (c) c.onclick = () => {
        state.caps.clear();
        state.tags.clear();
        state.q = '';
        state.provider = 'all';
        state.type = 'all';
        window.PVNavigate('#/plaza');
      };
      const g = ui.grid.querySelector('#plaza-empty-goto');
      if (g) g.onclick = () => window.PVNavigate('#/models');
      return;
    }

    ui.grid.innerHTML = list.map((m) => cardHtml(m)).join('');
    ui.grid.querySelectorAll('[data-detail]').forEach((el) => {
      el.onclick = (e) => {
        if (e.target.closest('button, a')) return;
        openDetail(el.dataset.detail);
      };
    });
    ui.grid.querySelectorAll('[data-goto]').forEach((btn) => {
      btn.onclick = () => window.PVNavigate('#/home?model=' + encodeURIComponent(btn.dataset.goto));
    });
  }

  function rateColor(rate) {
    if (rate < 0) return 'var(--text-3)';
    if (rate >= 90) return 'var(--leaf-600)';
    if (rate >= 80) return 'var(--sky-500)';
    if (rate >= 70) return 'var(--sun-500)';
    return 'var(--mushroom-500)';
  }

  function cardHtml(m) {
    const p = m.provider_id && D.provider(m.provider_id) ? D.provider(m.provider_id) : null;
    const fallback = m.type === 'custom' ? '🔀' : m.channel_type === 'anthropic' ? '🅰️' : m.channel_type === 'gemini' ? '✨' : '🧠';
    const routes = m.routes || [];
    return `<article class="model-card" data-detail="${esc(m.id)}" tabindex="0" role="button" aria-label="查看 ${esc(m.id)} 详情">
      <div class="model-card__head">
        ${providerAvatar(p, 36, fallback)}
        <div style="min-width:0;flex:1">
          <div class="model-card__name" title="${esc(m.id)}">${esc(m.id)}</div>
          <div class="model-card__sub">
            <span class="model-card__type ${m.type === 'custom' ? 'is-custom' : 'is-channel'}">${m.type === 'custom' ? '自定义' : '渠道'}</span>
            · ${p ? esc(p.name) : '未设置提供商'}
          </div>
        </div>
        ${m.available ? '' : '<span class="badge badge--gray">不可用</span>'}
      </div>
      ${m.description ? `<div class="model-card__desc">${esc(m.description)}</div>` : ''}
      <div class="model-card__caps">
        ${m.status === 'custom_content' ? badge('始终返回内容', 'green') : ''}
        ${capBadges(m.caps, { showNeg: true })}
        ${(m.tags || []).map((t) => `<span class="badge badge--gray badge--tag" style="--tag-h:${window.PV.tagHue(t)}">${esc(t)}</span>`).join('')}
      </div>
      ${routes.length
        ? `<div class="model-card__route" title="${esc(routes.map((r) => r.model_id).join(' → '))}">${routes.map((r) => esc(r.model_id)).join(' → ')}</div>`
        : `<div class="model-card__route">来源：${esc(m.source)}</div>`}
      <div class="model-card__foot">
        <div class="model-card__stats">
          <div class="model-card__stat">近 24h <b>${fmtInt(m.requests_24h)}</b> 次 · 成功率 <span style="color:${rateColor(m.success_rate)};font-weight:750">${m.success_rate < 0 ? '—' : m.success_rate.toFixed(1) + '%'}</span></div>
          <div class="model-card__stat" data-tip="${m.requests_200 ? `最近 ${m.requests_200} 次有记录` : '暂无调用记录'}">近 200 次成功率 ${m.success_rate_200 < 0 ? '—' : m.success_rate_200.toFixed(1) + '%'}</div>
        </div>
        <button class="btn btn--ghost btn--icon" data-copy="${esc(m.id)}" data-copy-label="模型 ID " title="复制模型 ID">${icon('copy', 13)}</button>
        <button class="btn btn--sm btn--primary" data-goto="${esc(m.id)}">${icon('chat', 12)}对话</button>
      </div>
    </article>`;
  }

  // ---------- 详情抽屉 ----------
  function statusText(m) {
    const map = {
      ok: ['可用', 'green'],
      disabled: ['已禁用', 'gray'],
      custom_content: ['始终返回内容', 'green'],
      custom_error: ['始终返回错误', 'red'],
      channel_disabled: ['渠道已禁用', 'red'],
      channel_missing: ['渠道不存在', 'red'],
      model_missing: ['渠道模型不存在', 'red'],
      unavailable: ['不可用', 'red'],
      no_routes: ['未配置路由', 'red'],
    };
    const v = map[m.status] || ['不可用', 'red'];
    return badge(v[0], v[1]);
  }

  function groupRoutes(routes) {
    const out = [];
    routes.forEach((r) => {
      const g = r.group || 0;
      if (g && out.length) {
        const last = out[out.length - 1];
        if (last.type === 'group' && last.group === g) {
          last.items.push(r);
          return;
        }
      }
      if (g) out.push({ type: 'group', group: g, items: [r] });
      else out.push({ type: 'single', items: [r] });
    });
    return out;
  }

  function routeItemHtml(r, idx) {
    const ok = r.status === 'ok';
    return `<div class="route-item" style="margin-bottom:4px">
      <span class="route-item__no">${idx + 1}</span>
      <div class="route-item__main">
        <div class="route-item__name">${esc(r.model_id)}
          ${r.weight ? `<span class="badge badge--gray badge--xs">权重 ${r.weight}</span>` : ''}
        </div>
        <div class="route-item__sub">
          <span class="dot${ok ? '' : ' is-bad'}"></span>
          <span>${esc(r.channel_name || r.channel_id)}</span>
          <span>·</span>
          <span>${ok ? '可用' : r.status === 'channel_disabled' ? '渠道已禁用' : r.status === 'model_missing' ? '渠道模型不存在' : '不可用'}</span>
        </div>
      </div>
    </div>`;
  }

  function openDetail(id) {
    const m = items.find((x) => x.id === id);
    if (!m) return;
    const p = m.provider_id && D.provider(m.provider_id) ? D.provider(m.provider_id) : null;
    const routes = m.routes || [];
    const groups = groupRoutes(routes);

    const body = `
      <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:12px">
        ${providerAvatar(p, 40, m.type === 'custom' ? '🔀' : '🧠')}
        <div style="min-width:0">
          <div class="mono" style="font-size:15px;font-weight:800;word-break:break-all">${esc(m.id)}</div>
          <div class="fs-12 muted" style="margin-top:2px">
            ${m.type === 'custom' ? '自定义模型' : '渠道模型'} · ${p ? esc(p.name) : '未设置提供商'} · ${statusText(m)}
          </div>
        </div>
        <div style="margin-left:auto;display:flex;gap:6px">
          <button class="btn btn--sm" data-act="copy">${icon('copy', 12)}复制 ID</button>
          <button class="btn btn--sm btn--primary" data-act="chat" ${m.available ? '' : 'disabled'}>${icon('chat', 12)}去对话</button>
        </div>
      </div>
      ${m.description ? `<div class="alert alert--pink" style="font-size:12px;line-height:1.7;margin-bottom:12px">${esc(m.description)}</div>` : ''}

      <div class="cm-detail__sec">基本信息</div>
      <div class="cm-detail__grid">
        <div><div class="cm-detail__k">模型 ID</div><div class="cm-detail__v mono">${esc(m.id)}</div></div>
        <div><div class="cm-detail__k">类型</div><div class="cm-detail__v">${m.type === 'custom' ? '自定义模型' : '渠道模型'}</div></div>
        <div><div class="cm-detail__k">状态</div><div class="cm-detail__v">${statusText(m)}</div></div>
        <div><div class="cm-detail__k">提供商</div><div class="cm-detail__v">${p ? providerIcon(p.icon, 13) + ' ' + esc(p.name) : '未设置'}</div></div>
        ${m.type === 'channel'
          ? `<div><div class="cm-detail__k">来源渠道</div><div class="cm-detail__v">${esc(m.source)}</div></div>
             <div><div class="cm-detail__k">上游模型</div><div class="cm-detail__v mono">${esc(m.upstream)}</div></div>`
          : `<div><div class="cm-detail__k">路由</div><div class="cm-detail__v">${routes.length} 条</div></div>
             <div><div class="cm-detail__k">调度</div><div class="cm-detail__v">${m.affinity ? '模型亲和 · ' : ''}冷却 ${m.cooldown_sec == null ? 300 : m.cooldown_sec}s${m.cooldown_reset ? ' · 全冷却重置' : ''}</div></div>`}
      </div>

      <div class="cm-detail__sec">${m.type === 'custom' ? '路由顺序' : '来源'}</div>
      ${m.type === 'custom'
        ? (routes.length
          ? groups.map((g) => g.type === 'group'
            ? `<div class="route-group" style="margin-bottom:6px">
                 <div class="route-group__head" style="cursor:default">
                   <span class="route-group__title">优先级组 ${g.group}</span>
                   <span class="route-group__ratio">${g.items.every((r) => !r.weight) ? '均等（随机）' : '组内权重 ' + g.items.map((r) => r.weight || 0).join(' ∶ ')}</span>
                 </div>
                 <div class="route-group__items">${g.items.map((r, i) => routeItemHtml(r, routes.indexOf(r))).join('')}</div>
               </div>`
            : g.items.map((r) => routeItemHtml(r, routes.indexOf(r))).join('')).join('')
          : '<div class="col-empty">没有配置路由目标；如果开启了自定义内容返回，模型仍可调用。</div>')
        : `<div class="hint-line" style="margin:0">${icon('info', 14)}<div>渠道模型不能单独配路由。要组合多个渠道，请在「模型管理」新建一个自定义模型，把它作为路由目标拖进去。</div></div>`}

      <div class="cm-detail__sec">能力参数</div>
      <div class="cm-detail__grid">
        <div><div class="cm-detail__k">上下文长度</div><div class="cm-detail__v">${m.caps.context_length ? fmtContext(m.caps.context_length) : '未设置'}</div></div>
        <div><div class="cm-detail__k">最大输出</div><div class="cm-detail__v">${m.caps.max_output ? fmtInt(m.caps.max_output) + ' tokens' : '未设置'}</div></div>
        <div><div class="cm-detail__k">工具调用</div><div class="cm-detail__v">${capState(m.caps.tool_calling, m.caps.tool_calling_error)}</div></div>
        <div><div class="cm-detail__k">思考</div><div class="cm-detail__v">${capState(m.caps.thinking, m.caps.thinking_error)}</div></div>
        <div><div class="cm-detail__k">图片输入</div><div class="cm-detail__v">${capState(m.caps.vision, m.caps.vision_error)}</div></div>
      </div>

      <div class="cm-detail__sec">调用情况</div>
      <div class="cm-detail__grid">
        <div><div class="cm-detail__k">近 24 小时</div><div class="cm-detail__v">${fmtInt(m.requests_24h)} 次 · 失败 ${fmtInt(m.errors_24h)} · 成功率 <span style="color:${rateColor(m.success_rate)}">${m.success_rate < 0 ? '—' : m.success_rate.toFixed(1) + '%'}</span></div></div>
        <div><div class="cm-detail__k">近 200 次</div><div class="cm-detail__v">${fmtInt(m.requests_200)} 次 · 失败 ${fmtInt(m.errors_200)} · 成功率 <span style="color:${rateColor(m.success_rate_200)}">${m.success_rate_200 < 0 ? '—' : m.success_rate_200.toFixed(1) + '%'}</span></div></div>
      </div>`;

    const d = openDrawer({
      title: '模型详情',
      desc: '广场只会列出当前可用的模型',
      body,
      tabs: '',
    });
    d.body.querySelector('[data-act="copy"]').onclick = () => window.PV.copyText(m.id, '模型 ID ');
    const chatBtn = d.body.querySelector('[data-act="chat"]');
    if (chatBtn && !chatBtn.disabled) {
      chatBtn.onclick = () => {
        d.close();
        window.PVNavigate('#/home?model=' + encodeURIComponent(m.id));
      };
    }
  }

  function capState(v, err) {
    if (v === true) return badge('支持', 'green');
    if (v === false) return err ? badge('不支持（报错）', 'red') : badge('不支持（自动移除）', 'red');
    return '<span class="muted">未设置</span>';
  }

  window.PVPages = window.PVPages || {};
  window.PVPages.plaza = { render };
})();
