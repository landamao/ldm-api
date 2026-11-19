/* ==========================================================================
   模型管理 · 四列工作台
   —— 左半边：渠道 → 渠道的模型（按渠道天然分组）
      右半边：已添加模型 → 选中模型的路由
      核心交互：把左边的渠道模型直接拖到右边的路由列表里；拖到某个模型上会
      自动展开它的路由，再拖到目标位置松手即可。路由之间也能拖动排序/并组。
   ========================================================================== */
(function () {
  'use strict';

  const {
    esc, icon, fmtInt, fmtContext, providerIcon, providerAvatar,
    badge, copyBadge, capBadges, Toast, Tip, openModal, confirmDialog, promptDialog,
    switchEl, colorBadge, emptyState, debounce,
  } = window.PV;
  const D = window.PVDATA;

  const TYPE_LABEL = { openai: 'OpenAI 兼容', anthropic: 'Anthropic', gemini: 'Google Gemini' };
  const typeTone = (t) => (t === 'anthropic' ? 'violet' : t === 'gemini' ? 'blue' : 'green');
  const CAP_KEYS = ['context_length', 'max_output', 'tool_calling', 'thinking', 'vision', 'tool_calling_error', 'thinking_error', 'vision_error'];

  const st = {
    channelId: D.channels[0] ? D.channels[0].id : '',
    channelSearch: '',
    chmProvider: 'all',
    modelSearch: '',
    modelType: 'all',
    selectedId: (D.models.find((m) => m.type === 'custom') || {}).id || '',
    draft: null,
    dirty: false,
    drafts: new Map(), // 每个自定义模型一份未保存草稿，切走再切回不丢
    collapsedGroups: new Set(),
    editor: null, // 渠道编辑页的草稿
    drag: null,
  };

  let rootEl = null;
  let ui = null;
  let dragHint = null;
  let dragGhost = null;
  let hoverTimer = 0;
  let lastDragPoint = null;

  const clone = (v) => JSON.parse(JSON.stringify(v));
  const selectedModel = () => D.model(st.selectedId);
  const selectedChannel = () => D.channel(st.channelId);

  // ======================================================================
  // 页面入口
  // ======================================================================
  function render(root) {
    rootEl = root;
    root.innerHTML = '<div class="mgmt" id="mgmt"></div>';
    if (st.channelId && !D.channel(st.channelId)) st.channelId = D.channels[0] ? D.channels[0].id : '';
    renderWorkbench();
  }

  function renderWorkbench() {
    const host = document.getElementById('mgmt');
    if (!host) return;
    host.innerHTML = `
      <section class="mgmt__panel mgmt__panel--left">
        <div class="mgmt__head">
          <div class="mgmt__head-title">${icon('channels', 17)}渠道<span class="mgmt__head-count" id="ch-count"></span></div>
          <div class="mgmt__head-actions">
            <button class="btn btn--sm" id="btn-add-channel">${icon('plus', 13)}添加渠道</button>
          </div>
        </div>
        <div class="mgmt__cols mgmt__cols--left">
          <div class="mgmt-col">
            <div class="mgmt-col__head">
              <span class="mgmt-col__title">${icon('server', 14)}渠道</span>
              <span class="mgmt-col__count" id="ch-col-count"></span>
            </div>
            <div class="mgmt-col__tools">
              <div class="search">
                <span class="search__icon">${icon('search', 12)}</span>
                <input class="input" id="ch-search" placeholder="搜索 ID / 名称 / 地址…" value="${esc(st.channelSearch)}">
              </div>
            </div>
            <div class="mgmt-col__body" id="ch-list"></div>
            <div class="mgmt-col__foot">点击渠道，右边会显示它配置的全部上游模型</div>
          </div>

          <div class="mgmt-col">
            <div class="mgmt-col__head">
              <span class="mgmt-col__title">${icon('models', 14)}渠道模型</span>
              <span class="mgmt-col__count" id="chm-col-count"></span>
              <div class="mgmt-col__actions">
                <button class="btn btn--sm" id="btn-discover" title="请求上游拉取模型列表">${icon('refresh', 12)}获取模型列表</button>
                <button class="mini-act" id="btn-add-upstream" title="填写自定义模型名">${icon('plus', 14)}</button>
              </div>
            </div>
            <div class="mgmt-col__tools">
              <select class="select" id="chm-provider" aria-label="按提供商筛选" style="width:100%"></select>
            </div>
            <div class="mgmt-col__body" id="chm-list"></div>
            <div class="mgmt-col__foot" id="chm-foot">按住左侧把手，把模型拖到右边路由列表</div>
          </div>
        </div>
      </section>

      <div class="mgmt__gutter" id="mgmt-gutter" title="拖动调整左右宽度"></div>

      <section class="mgmt__panel mgmt__panel--right">
        <div class="mgmt__head">
          <div class="mgmt__head-title">${icon('models', 17)}模型<span class="mgmt__head-count" id="m-count"></span></div>
          <div class="mgmt__head-actions">
            <button class="btn btn--sm" id="btn-clear-cd">${icon('refresh', 13)}清除冷却</button>
            <button class="btn btn--sm" id="btn-add-models">${icon('plus', 13)}添加模型</button>
            <button class="btn btn--sm btn--primary" id="btn-new-custom">${icon('plus', 13)}自定义模型</button>
          </div>
        </div>
        <div class="mgmt__cols mgmt__cols--right">
          <div class="mgmt-col">
            <div class="mgmt-col__head">
              <span class="mgmt-col__title">${icon('layers', 14)}已添加模型</span>
              <span class="mgmt-col__count" id="m-col-count"></span>
            </div>
            <div class="mgmt-col__tools">
              <div class="search">
                <span class="search__icon">${icon('search', 12)}</span>
                <input class="input" id="m-search" placeholder="搜索模型…" value="${esc(st.modelSearch)}">
              </div>
              <select class="select" id="m-type" aria-label="模型类型" style="width:88px">
                <option value="all">全部</option>
                <option value="custom">自定义</option>
                <option value="channel">渠道</option>
              </select>
            </div>
            <div class="mgmt-col__body" id="m-list"></div>
            <div class="mgmt-col__foot">拖左侧渠道模型到某一行，会展开它的路由</div>
          </div>

          <div class="mgmt-col" id="route-col">
            <div class="route-panel" id="route-panel"></div>
          </div>
        </div>
      </section>`;

    ui = {
      chList: document.getElementById('ch-list'),
      chmList: document.getElementById('chm-list'),
      mList: document.getElementById('m-list'),
      routePanel: document.getElementById('route-panel'),
      chmProvider: document.getElementById('chm-provider'),
    };

    bindWorkbench();
    restoreSplit();
    renderChannelList();
    renderChannelModels();
    renderModelList();
    renderRoutePanel();
  }

  // ======================================================================
  // 渠道列表
  // ======================================================================
  function channelSearchMatch(c, kw) {
    if (!kw) return true;
    return [c.id, c.name || '', c.base_url || '', c.remark || '', TYPE_LABEL[c.type] || '']
      .join(' ').toLowerCase().includes(kw);
  }

  function renderChannelList() {
    const kw = st.channelSearch.trim().toLowerCase();
    const list = D.channels.filter((c) => channelSearchMatch(c, kw));
    document.getElementById('ch-count').textContent = D.channels.length;
    document.getElementById('ch-col-count').textContent = `${list.length} / ${D.channels.length}`;
    ui.chList.innerHTML = list.length ? list.map((c) => {
      const active = c.id === st.channelId;
      return `<div class="ch-row${active ? ' is-active' : ''}${c.enabled ? '' : ' is-off'}" data-cid="${esc(c.id)}">
        <div class="ch-row__top">
          <span class="ch-row__dot"></span>
          <span class="ch-row__name">${esc(c.name || c.id)}</span>
          <span class="ch-row__id">${esc(c.id)}</span>
        </div>
        <div class="ch-row__meta">
          <span>${esc(TYPE_LABEL[c.type] || c.type)}</span>
          <span class="sep">·</span>
          <span title="${esc(c.base_url)}">${esc(c.base_url || '（默认地址）')}</span>
        </div>
        <div class="ch-row__foot">
          <span class="ch-row__models">${c.models.length} 个模型 · 已接入 ${c.added_count}</span>
          ${c.proxy_url ? '<span class="badge badge--blue badge--xs">代理</span>' : ''}
          ${c.multi_key_enabled && c.key_rows.length > 1 ? `<span class="badge badge--gray badge--xs">${c.key_rows.length} Keys</span>` : ''}
          <div class="ch-row__acts">
            <button class="mini-act" data-ch-act="toggle" data-cid="${esc(c.id)}" title="${c.enabled ? '禁用' : '启用'}">${icon(c.enabled ? 'pause' : 'play', 12)}</button>
            <button class="mini-act" data-ch-act="edit" data-cid="${esc(c.id)}" title="编辑">${icon('edit', 12)}</button>
            <button class="mini-act mini-act--danger" data-ch-act="del" data-cid="${esc(c.id)}" title="删除">${icon('trash', 12)}</button>
          </div>
        </div>
      </div>`;
    }).join('') : '<div class="col-empty">没有匹配的渠道</div>';

    ui.chList.querySelectorAll('[data-cid]').forEach((row) => {
      row.onclick = (e) => {
        if (e.target.closest('[data-ch-act]')) return;
        // 切渠道只换左边的「渠道 → 渠道模型」，右边的模型/路由草稿不动：
        // 两边本来就是独立的选择，没理由因为看另一个渠道就丢掉路由修改。
        st.channelId = row.dataset.cid;
        st.chmProvider = 'all';
        renderChannelList();
        renderChannelModels();
      };
    });
    ui.chList.querySelectorAll('[data-ch-act]').forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const c = D.channel(btn.dataset.cid);
        if (!c) return;
        const act = btn.dataset.chAct;
        if (act === 'edit') openChannelEditor(c);
        else if (act === 'toggle') {
          c.enabled = !c.enabled;
          Toast.success(`渠道 ${c.id} 已${c.enabled ? '启用' : '禁用'}`);
          if (!c.enabled) Toast.warn('禁用后，引用它模型的自定义路由会自动跳过，不会写日志');
          renderChannelList();
          renderChannelModels();
          renderModelList();
          renderRoutePanel();
        } else if (act === 'del') deleteChannel(c);
      };
    });
  }

  async function deleteChannel(c) {
    const refs = [];
    D.models.forEach((m) => {
      if (m.type === 'channel' && m.channel_id === c.id) {
        refs.push({ type: 'channel_model', model_id: m.id });
      } else if (m.type === 'custom') {
        (m.routes || []).forEach((r) => {
          if (r.channel_id === c.id) refs.push({ type: 'custom_route', model_id: m.id, upstream: r.upstream });
        });
      }
    });
    if (!refs.length) {
      const ok = await confirmDialog({
        title: '删除渠道',
        message: `确定删除渠道 <b>${esc(c.id)}</b> 吗？<br><br>没有模型引用它。该操作不可撤销。`,
        confirmText: '删除渠道',
        danger: true,
      });
      if (!ok) return;
      removeChannel(c, false);
      return;
    }
    const channelModels = refs.filter((r) => r.type === 'channel_model');
    const customRoutes = refs.filter((r) => r.type === 'custom_route');
    const action = await new Promise((resolve) => {
      const mo = openModal({
        title: '删除渠道',
        size: 'lg',
        body: `<div class="fs-13" style="line-height:1.7;color:var(--text-2)">
          渠道 <b>${esc(c.id)}</b> 还被以下配置引用：
          <div style="margin-top:10px;display:flex;flex-direction:column;gap:5px;max-height:260px;overflow:auto">
            ${channelModels.map((r) => `<div class="cm-ref">${badge('渠道模型', 'blue')}<span class="mono">${esc(r.model_id)}</span></div>`).join('')}
            ${customRoutes.map((r) => `<div class="cm-ref">${badge('自定义路由', 'wood')}<span class="mono">${esc(r.model_id)}</span> → <span class="mono">${esc(r.upstream)}</span></div>`).join('')}
          </div>
          <div style="margin-top:10px">删除渠道时可以选择保留这些配置（之后会显示「渠道不存在」），或一并清理。</div>
        </div>`,
        footer: `<div class="spacer"></div>
          <button class="btn" data-act="cancel">取消</button>
          <button class="btn" data-act="keep">保留配置删除</button>
          <button class="btn btn--danger" data-act="remove">一并清理并删除</button>`,
        onClose: () => resolve(null),
      });
      mo.foot.querySelector('[data-act=cancel]').onclick = () => { mo.close(); resolve(null); };
      mo.foot.querySelector('[data-act=keep]').onclick = () => { mo.close(); resolve('keep'); };
      mo.foot.querySelector('[data-act=remove]').onclick = () => { mo.close(); resolve('remove'); };
    });
    if (!action) return;
    removeChannel(c, action === 'remove');
  }

  function removeChannel(c, removeRefs) {
    let removed = 0;
    let updated = 0;
    if (removeRefs) {
      for (let i = D.models.length - 1; i >= 0; i--) {
        const m = D.models[i];
        if (m.type === 'channel' && m.channel_id === c.id) {
          D.models.splice(i, 1);
          removed += 1;
        }
      }
      D.models.forEach((m) => {
        if (m.type === 'custom' && (m.routes || []).some((r) => r.channel_id === c.id)) {
          m.routes = m.routes.filter((r) => r.channel_id !== c.id);
          updated += 1;
        }
      });
    }
    // 数组必须原地改：D.models / D.channels 的引用被 data.js 里的派生函数和当前页共用
    const ci = D.channels.findIndex((x) => x.id === c.id);
    if (ci >= 0) D.channels.splice(ci, 1);
    if (st.channelId === c.id) st.channelId = D.channels[0] ? D.channels[0].id : '';
    if (removeRefs && !D.model(st.selectedId)) {
      st.selectedId = (D.models.find((m) => m.type === 'custom') || D.models[0] || {}).id || '';
    }
    D.models.forEach((m) => recalcChannelModel(m));
    Toast.success(`渠道 ${c.id} 已删除${removeRefs ? `，移除 ${removed} 个渠道模型、清理 ${updated} 个自定义路由` : '，模型配置保持不变'}`);
    renderChannelList();
    renderChannelModels();
    renderModelList();
    renderRoutePanel();
  }

  // ======================================================================
  // 渠道模型列
  // ======================================================================
  function upstreamProviderId(upstream) {
    return D.matchProvider(upstream);
  }

  function channelModelRow(upstream, added) {
    const pid = upstreamProviderId(upstream) || '';
    const p = D.provider(pid);
    const modelId = st.channelId + '/' + upstream;
    return `<div class="row-item is-draggable${added ? '' : ' is-off'}" draggable="true"
        data-drag-kind="channel-model" data-upstream="${esc(upstream)}" data-model-id="${esc(modelId)}">
      ${added ? '' : `<button class="row-item__add" data-add-up="${esc(upstream)}" title="加入模型管理">${icon('plus', 11)}</button>`}
      ${added ? `<span class="row-item__handle" title="拖动到右侧路由">${icon('grip', 12)}</span>` : ''}
      ${p ? providerIcon(p.icon, 14) : providerIcon('', 14)}
      <div class="row-item__main">
        <div class="row-item__name"><span class="truncate">${esc(upstream)}</span></div>
        <div class="row-item__sub">
          <span>${p ? esc(p.name) : '未识别提供商'}</span>
          <span>·</span>
          <span>${added ? '已接入' : '未接入'}</span>
        </div>
      </div>
      <div class="row-item__acts">
        <button class="mini-act" data-copy="${esc(modelId)}" data-copy-label="模型 ID " title="复制模型 ID">${icon('copy', 11)}</button>
        ${added ? `<button class="mini-act" data-edit-cm="${esc(modelId)}" title="编辑模型设置">${icon('edit', 11)}</button>
                   <button class="mini-act mini-act--danger" data-rm-cm="${esc(modelId)}" title="从模型管理移除">${icon('trash', 11)}</button>` : ''}
      </div>
    </div>`;
  }

  function renderChannelModels() {
    const c = selectedChannel();
    const countEl = document.getElementById('chm-col-count');
    const foot = document.getElementById('chm-foot');
    if (!c) {
      ui.chmList.innerHTML = '<div class="col-empty">先选择一个渠道</div>';
      countEl.textContent = '';
      if (foot) foot.textContent = '';
      return;
    }
    // 提供商筛选下拉：只列当前渠道里实际出现的提供商
    const pids = [...new Set(c.models.map((up) => upstreamProviderId(up) || '__none'))];
    const sel = ui.chmProvider;
    sel.innerHTML = `<option value="all">全部提供商（${c.models.length}）</option>`
      + pids.map((pid) => {
        const p = D.provider(pid);
        return `<option value="${esc(pid)}">${esc(p ? p.name : '未识别')}（${c.models.filter((u) => (upstreamProviderId(u) || '__none') === pid).length}）</option>`;
      }).join('');
    if (!pids.includes(st.chmProvider) && st.chmProvider !== 'all') st.chmProvider = 'all';
    sel.value = st.chmProvider;
    sel.onchange = () => {
      st.chmProvider = sel.value;
      renderChannelModels();
    };

    const models = c.models.filter((u) => st.chmProvider === 'all' || (upstreamProviderId(u) || '__none') === st.chmProvider);
    const addedSet = new Set(D.models.filter((m) => m.type === 'channel' && m.channel_id === c.id).map((m) => m.upstream));
    const added = models.filter((u) => addedSet.has(u));
    const notAdded = models.filter((u) => !addedSet.has(u));

    countEl.textContent = `${c.models.length}`;
    ui.chmList.innerHTML = `
      <div class="col-sub-head">已接入 ${added.length}</div>
      ${added.length ? added.map((u) => channelModelRow(u, true)).join('') : '<div class="col-empty" style="padding:12px">这个渠道还没有模型接入模型管理</div>'}
      <div class="col-sub-head">未接入 ${notAdded.length}</div>
      ${notAdded.length ? notAdded.map((u) => channelModelRow(u, false)).join('') : '<div class="col-empty" style="padding:12px">渠道里的模型都已接入</div>'}
      ${models.length ? '' : '<div class="col-empty">没有符合提供商筛选的模型</div>'}`;

    if (foot) foot.textContent = `渠道 ${c.id} · ${c.models.length} 个上游模型，已接入 ${addedSet.size}`;

    ui.chmList.querySelectorAll('[data-add-up]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        addModelToManagement(c.id, btn.dataset.addUp);
      };
    });
    ui.chmList.querySelectorAll('[data-edit-cm]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        openChannelModelEditor(D.model(btn.dataset.editCm));
      };
    });
    ui.chmList.querySelectorAll('[data-rm-cm]').forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const m = D.model(btn.dataset.rmCm);
        if (!m) return;
        const ok = await confirmDialog({ title: '移除模型', message: `确定把 <b>${esc(m.id)}</b> 从模型管理移除吗？引用它的自定义路由不会被删除，但会变成不可用。`, confirmText: '移除', danger: true });
        if (!ok) return;
        const idx = D.models.findIndex((x) => x.id === m.id);
        if (idx >= 0) D.models.splice(idx, 1);
        if (st.selectedId === m.id) st.selectedId = (D.models.find((x) => x.type === 'custom') || {}).id || '';
        recalcAll();
        Toast.success(`已移除 ${m.id}`);
        renderChannelModels();
        renderModelList();
        renderRoutePanel();
      };
    });
    ui.chmList.querySelectorAll('[data-drag-kind="channel-model"]').forEach((row) => {
      row.addEventListener('dragstart', (e) => startChannelDrag(e, c.id, row.dataset.upstream));
      row.addEventListener('dragend', endDrag);
    });
  }

  function addModelToManagement(channelId, upstream) {
    const id = channelId + '/' + upstream;
    if (D.model(id)) { Toast.info(`${id} 已经在模型管理里`); return; }
    const pid = D.matchProvider(upstream);
    D.models.push({
      id, type: 'channel', channel_id: channelId, upstream, provider_id: pid || '',
      caps: {}, enabled: true, timeout: 300, force_stream: false, no_retry_status: '',
      content_enabled: false, thinking_override_enabled: false, system_prompt_enabled: false,
      error_enabled: false, error_always: false, error_status: 0, error_message: '', error_as_content: false, error_keep_no_retry: true,
      display_name: '', description: '', tags: [], created_at: Date.now(), updated_at: Date.now(),
    });
    recalcAll();
    Toast.success(`已添加 ${id}，现在可以对外调用`, '已接入模型管理');
    renderChannelModels();
    renderModelList();
  }

  // ======================================================================
  // 右侧模型列表
  // ======================================================================
  function modelMatches(m, kw) {
    if (!kw) return true;
    return [m.id, m.display_name || '', m.channel_name || '', m.provider_name || '', m.description || '']
      .join(' ').toLowerCase().includes(kw);
  }

  function statusDot(m) {
    if (!m.enabled) return 'is-off';
    if (m.status === 'ok' || m.status === 'custom_content') return '';
    return 'is-bad';
  }

  function modelRow(m) {
    const isCustom = m.type === 'custom';
    const p = m.provider_id ? D.provider(m.provider_id) : null;
    const active = m.id === st.selectedId;
    const meta = isCustom
      ? `${esc(m.provider_name || '未设置提供商')} · ${(m.routes || []).length} 条路由${m.affinity ? ' · 亲和' : ''}`
      : `${esc(m.channel_name || m.channel_id)} · ${esc(m.provider_name || '未识别')}`;
    return `<div class="m-row${active ? ' is-active' : ''}" data-mid="${esc(m.id)}" data-mtype="${m.type}">
      <span class="m-row__type ${isCustom ? 'is-custom' : 'is-channel'}">${icon(isCustom ? 'route' : 'box', 12)}</span>
      <div class="m-row__main">
        <div class="m-row__id" title="${esc(m.id)}">${esc(m.id)}</div>
        <div class="m-row__meta"><span>${meta}</span></div>
      </div>
      ${isCustom && (m.routes || []).length ? `<span class="m-row__routecount">${m.routes.length}</span>` : ''}
      ${st.drafts.has(m.id) ? '<span class="m-row__draft" title="有未保存的路由修改"></span>' : ''}
      <span class="m-row__status ${statusDot(m)}" title="${esc(m.status)}"></span>
      <div class="m-row__acts">
        <button class="mini-act" data-m-act="toggle" data-mid="${esc(m.id)}" title="${m.enabled ? '禁用' : '启用'}">${icon(m.enabled ? 'pause' : 'play', 11)}</button>
        <button class="mini-act" data-m-act="edit" data-mid="${esc(m.id)}" title="编辑">${icon('edit', 11)}</button>
        <button class="mini-act mini-act--danger" data-m-act="del" data-mid="${esc(m.id)}" title="删除">${icon('trash', 11)}</button>
      </div>
    </div>`;
  }

  function renderModelList() {
    const kw = st.modelSearch.trim().toLowerCase();
    let list = D.modelsView().filter((m) => modelMatches(m, kw));
    if (st.modelType !== 'all') list = list.filter((m) => m.type === st.modelType);
    const custom = list.filter((m) => m.type === 'custom');
    const channel = list.filter((m) => m.type !== 'custom');
    document.getElementById('m-count').textContent = D.models.length;
    document.getElementById('m-col-count').textContent = `${list.length} / ${D.models.length}`;
    document.getElementById('m-search').value = st.modelSearch;
    document.getElementById('m-type').value = st.modelType;

    ui.mList.innerHTML = `
      ${custom.length ? `<div class="col-sub-head">自定义模型 ${custom.length}</div>${custom.map(modelRow).join('')}` : ''}
      ${channel.length ? `<div class="col-sub-head">渠道模型 ${channel.length}</div>${channel.map(modelRow).join('')}` : ''}
      ${list.length ? '' : '<div class="col-empty">没有匹配的模型</div>'}`;

    ui.mList.querySelectorAll('.m-row').forEach((row) => {
      row.onclick = (e) => {
        if (e.target.closest('[data-m-act]')) return;
        selectModel(row.dataset.mid);
      };
      // 拖渠道模型经过自定义模型：自动展开它的路由，松手即加一条
      const m = D.model(row.dataset.mid);
      if (m && m.type === 'custom') {
        row.addEventListener('dragover', (e) => {
          if (!st.drag || st.drag.kind !== 'channel-model') return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          ui.mList.querySelectorAll('.m-row').forEach((r) => r.classList.toggle('is-drop-target', r === row));
          if (st.selectedId !== m.id && !hoverTimer) {
            hoverTimer = setTimeout(() => {
              hoverTimer = 0;
              if (!st.drag) return;
              stashCurrentDraft();
              st.selectedId = m.id;
              loadModelDraft(m);
              // 只换右侧面板，不重建模型列表：正在拖拽的目标节点一旦被替换，
              // dragover / drop 就会断在这一行上。
              ui.mList.querySelectorAll('.m-row').forEach((r) => {
                r.classList.toggle('is-active', r.dataset.mid === m.id);
                r.classList.toggle('is-drop-target', r === row);
              });
              renderRoutePanel();
            }, 180);
          }
        });
        row.addEventListener('dragleave', (e) => {
          if (!row.contains(e.relatedTarget)) row.classList.remove('is-drop-target');
        });
        row.addEventListener('drop', (e) => {
          if (!st.drag || st.drag.kind !== 'channel-model') return;
          e.preventDefault();
          clearHover();
          row.classList.remove('is-drop-target');
          if (st.selectedId !== m.id) {
            stashCurrentDraft();
            st.selectedId = m.id;
            loadModelDraft(m);
          }
          appendRouteFromDrag(st.drag, (st.draft || []).length, 0);
          endDrag();
        });
      }
    });

    ui.mList.querySelectorAll('[data-m-act]').forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const m = D.model(btn.dataset.mid);
        if (!m) return;
        const act = btn.dataset.mAct;
        if (act === 'toggle') {
          m.enabled = !m.enabled;
          m.updated_at = Date.now();
          Toast.success(`模型 ${m.id} 已${m.enabled ? '启用' : '禁用'}`);
          renderModelList();
          renderRoutePanel();
        } else if (act === 'edit') {
          if (m.type === 'custom') selectModel(m.id);
          else openChannelModelEditor(m);
        } else if (act === 'del') {
          const ok = await confirmDialog({ title: '删除模型', message: `确定删除模型 <b>${esc(m.id)}</b> 吗？删除后不可撤销。`, confirmText: '删除', danger: true });
          if (!ok) return;
          const di = D.models.findIndex((x) => x.id === m.id);
          if (di >= 0) D.models.splice(di, 1);
          if (st.selectedId === m.id) st.selectedId = (D.models.find((x) => x.type === 'custom') || D.models[0] || {}).id || '';
          recalcAll();
          Toast.success(`模型 ${m.id} 已删除`);
          renderChannelModels();
          renderModelList();
          renderRoutePanel();
        }
      };
    });
  }

  function selectModel(id) {
    if (st.selectedId === id && !st.dirty) return;
    // 当前草稿先按模型存起来，切到目标模型再取它自己的草稿：
    // 这样切模型/切渠道都不会丢未保存的路由，也不用弹「放弃修改」。
    stashCurrentDraft();
    const m = D.model(id);
    st.selectedId = id;
    loadModelDraft(m);
    renderModelList();
    renderRoutePanel();
  }

  function stashCurrentDraft() {
    const m = selectedModel();
    if (m && m.type === 'custom' && st.draft && st.dirty) {
      st.drafts.set(m.id, { routes: clone(st.draft) });
    }
  }

  function loadModelDraft(m) {
    if (!m || m.type !== 'custom') {
      st.draft = null;
      st.dirty = false;
      return;
    }
    const cached = st.drafts.get(m.id);
    st.draft = clone(cached ? cached.routes : (m.routes || []));
    st.dirty = !!cached;
  }

  // ======================================================================
  // 路由面板
  // ======================================================================
  function groupRuns(routes) {
    const runs = [];
    routes.forEach((r, i) => {
      const g = r.group || 0;
      if (g && runs.length && runs[runs.length - 1].group === g && runs[runs.length - 1].type === 'group') {
        runs[runs.length - 1].items.push(i);
      } else if (g) {
        runs.push({ type: 'group', group: g, items: [i] });
      } else {
        runs.push({ type: 'single', items: [i] });
      }
    });
    return runs;
  }

  function normalizeGroups(routes) {
    // 连续同组重新编号为 1..N；只剩一条的组解散（与线上保存时的处理一致）
    const result = [];
    let groupSeq = 0;
    let i = 0;
    while (i < routes.length) {
      const r = routes[i];
      const g = r.group || 0;
      if (!g) {
        result.push(Object.assign({}, r, { group: 0 }));
        i += 1;
        continue;
      }
      const groupItems = [];
      while (i < routes.length && (routes[i].group || 0) === g) {
        groupItems.push(routes[i]);
        i += 1;
      }
      if (groupItems.length <= 1) {
        groupItems.forEach((x) => result.push(Object.assign({}, x, { group: 0 })));
      } else {
        groupSeq += 1;
        groupItems.forEach((x) => result.push(Object.assign({}, x, { group: groupSeq })));
      }
    }
    return result;
  }

  function allRoutableModels() {
    return D.models.filter((m) => m.type === 'channel');
  }

  function routeRowHtml(r, idx) {
    const stt = D.modelsView().find((m) => m.id === (r.channel_id + '/' + r.upstream));
    const ready = stt ? (stt.status === 'ok') : false;
    const inGroup = (r.group || 0) !== 0;
    return `<div class="route-item" data-route-idx="${idx}" data-group="${r.group || 0}">
      <span class="route-item__no">${idx + 1}</span>
      <span class="route-item__handle" draggable="true" title="拖动排序">${icon('grip', 12)}</span>
      <div class="route-item__main">
        <div class="route-item__name" title="${esc(r.channel_id + '/' + r.upstream)}">${esc(r.channel_id)}/${esc(r.upstream)}
        </div>
        <div class="route-item__sub">
          <span class="dot${ready ? '' : ' is-bad'}"></span>
          <span>${esc((D.channel(r.channel_id) || {}).name || r.channel_id)}</span>
          <span>·</span>
          <span>${ready ? '可用' : stt ? (stt.status === 'channel_disabled' ? '渠道已禁用' : stt.status === 'model_missing' ? '上游模型不存在' : '不可用') : '渠道模型未接入'}</span>
        </div>
      </div>
      ${inGroup ? `<span class="route-item__w" title="组内权重（0 表示均等随机）"><span style="opacity:.7">w</span><input type="number" min="0" max="1000" value="${r.weight || 0}" data-weight="${idx}"></span>` : ''}
      <div class="route-item__acts">
        <button class="mini-act" data-r-act="up" data-idx="${idx}" title="${inGroup ? '组内上移' : '上移'}">${icon('up', 11)}</button>
        <button class="mini-act" data-r-act="down" data-idx="${idx}" title="${inGroup ? '组内下移' : '下移'}">${icon('down', 11)}</button>
        ${inGroup ? `<button class="mini-act" data-r-act="split" data-idx="${idx}" title="移出分组">${icon('split', 11)}</button>`
          : `<button class="mini-act" data-r-act="merge" data-idx="${idx}" title="与上一条合并为一组">${icon('merge', 11)}</button>
             <button class="mini-act" data-r-act="merge-down" data-idx="${idx}" title="与下一条合并为一组">${icon('merge', 11)}</button>`}
        <button class="mini-act mini-act--danger" data-r-act="del" data-idx="${idx}" title="移除这条路由">${icon('x', 11)}</button>
      </div>
    </div>`;
  }

  function routesHtml(routes) {
    const runs = groupRuns(routes);
    let html = '';
    runs.forEach((run) => {
      if (run.type === 'single') {
        html += run.items.map((i) => routeRowHtml(routes[i], i)).join('');
      } else {
        const key = run.group + ':' + (routes[run.items[0]].channel_id + '/' + routes[run.items[0]].upstream);
        const collapsed = st.collapsedGroups.has(key);
        const weights = run.items.map((i) => routes[i].weight || 0);
        const ratio = weights.every((w) => !w) ? '均等（随机）' : weights.join(' ∶ ');
        html += `<div class="route-group${collapsed ? ' is-collapsed' : ''}" data-group="${run.group}" data-gkey="${esc(key)}">
          <div class="route-group__head">
            <span class="route-group__grip" draggable="true" data-group-drag="${run.group}" title="拖动整组">${icon('grip', 12)}</span>
            <span class="route-group__title">优先级组 ${run.group}<span class="route-group__ratio">· ${ratio}</span></span>
            <div class="route-group__acts">
              ${run.items.length > 1 ? `<button class="mini-act" data-g-act="ungroup" data-group="${run.group}" title="解散分组">${icon('unlink', 11)}</button>` : ''}
            </div>
            <span class="route-group__chev">${icon('chevron', 12)}</span>
          </div>
          <div class="route-group__items">${run.items.map((i) => routeRowHtml(routes[i], i)).join('')}</div>
        </div>`;
      }
    });
    return html;
  }

  function renderRoutePanel() {
    const m = selectedModel();
    const host = ui.routePanel;
    if (!m) {
      host.innerHTML = `
        <div class="route-panel">
          <div class="route-panel__head">
            <div class="route-panel__title-row"><span class="route-panel__id">未选择模型</span></div>
            <div class="route-panel__sub">从左边选一个自定义模型，或直接把渠道模型拖进来</div>
          </div>
          <div class="route-list" id="route-list">
            <div class="route-dropzone" id="new-route-drop">
              ${icon('move', 22)}
              <b>把渠道模型拖到这里</b>
              <span>松手后会新建一个自定义模型，再给路由起名字</span>
            </div>
          </div>
        </div>`;
      bindRoutePanel();
      return;
    }

    if (m.type === 'channel') {
      const p = m.provider_id ? D.provider(m.provider_id) : null;
      const refs = D.models.filter((x) => x.type === 'custom' && (x.routes || []).some((r) => r.channel_id === m.channel_id && r.upstream === m.upstream));
      host.innerHTML = `
        <div class="cm-detail">
          <div class="cm-detail__hero">
            ${providerAvatar(p, 38, '🧠')}
            <div style="min-width:0;flex:1">
              <div class="cm-detail__name">${esc(m.id)}</div>
              <div class="cm-detail__sub">渠道模型 · ${esc(m.channel_name || m.channel_id)} → ${esc(m.upstream)}</div>
            </div>
          </div>
          <div class="cm-detail__grid">
            <div><div class="cm-detail__k">状态</div><div class="cm-detail__v">${modelStatusBadge(D.modelsView().find((x) => x.id === m.id) || m)}</div></div>
            <div><div class="cm-detail__k">提供商</div><div class="cm-detail__v">${p ? providerIcon(p.icon, 12) + ' ' + esc(p.name) : '未设置'}</div></div>
            <div><div class="cm-detail__k">上游模型</div><div class="cm-detail__v mono">${esc(m.upstream)}</div></div>
            <div><div class="cm-detail__k">超时</div><div class="cm-detail__v">${m.timeout || 300} 秒</div></div>
            <div><div class="cm-detail__k">最大输出</div><div class="cm-detail__v">${m.caps.max_output ? fmtInt(m.caps.max_output) + ' tokens' : '未设置'}</div></div>
            <div><div class="cm-detail__k">强制流式</div><div class="cm-detail__v">${m.force_stream ? '开启' : '关闭'}</div></div>
          </div>
          <div class="cm-detail__sec">能力参数</div>
          <div>${capBadges(m.caps, { showNeg: true }) || '<span class="muted fs-12">未设置</span>'}</div>
          ${m.description ? `<div class="cm-detail__sec">描述</div><div class="fs-12" style="color:var(--text-2)">${esc(m.description)}</div>` : ''}
          <div class="cm-detail__sec">被这些自定义模型引用</div>
          ${refs.length ? refs.map((r) => `<div class="cm-ref">${icon('route', 12)}<span class="mono">${esc(r.id)}</span><button class="mini-act" data-goto-model="${esc(r.id)}" style="margin-left:auto" title="查看路由">${icon('chevronRight', 11)}</button></div>`).join('')
            : '<div class="fs-12 muted">还没有自定义模型引用它。可以把它拖到右边的自定义模型里，或直接新建一个。</div>'}
          <div class="cm-detail__actions">
            <button class="btn btn--sm btn--primary" id="cm-edit">${icon('edit', 12)}编辑模型设置</button>
            <button class="btn btn--sm" id="cm-test">${icon('zap', 12)}测试连通性</button>
            <button class="btn btn--sm" id="cm-new-route">${icon('route', 12)}新建自定义模型引用它</button>
          </div>
        </div>`;
      host.querySelector('#cm-edit').onclick = () => openChannelModelEditor(m);
      host.querySelector('#cm-test').onclick = () => testModel(m);
      host.querySelector('#cm-new-route').onclick = () => createCustomWithRoute(m);
      host.querySelectorAll('[data-goto-model]').forEach((b) => {
        b.onclick = () => selectModel(b.dataset.gotoModel);
      });
      return;
    }

    // 自定义模型：路由编辑器
    if (!st.draft) st.draft = clone(m.routes || []);
    const routes = st.draft;
    const groups = groupRuns(routes).filter((r) => r.type === 'group').length;
    const p = m.provider_id ? D.provider(m.provider_id) : null;
    const status = D.modelsView().find((x) => x.id === m.id) || m;

    host.innerHTML = `
      <div class="route-panel">
        <div class="route-panel__head">
          <div class="route-panel__title-row">
            ${providerAvatar(p, 30, '🔀')}
            <span class="route-panel__id" id="rp-id" title="点击重命名">${esc(m.id)}</span>
            ${badge('自定义', 'wood')}
            ${modelStatusBadge(status)}
            <div class="route-panel__actions">
              <button class="mini-act" data-rp-act="test" title="测试模型">${icon('zap', 13)}</button>
              <button class="mini-act" data-rp-act="toggle" title="${m.enabled ? '禁用' : '启用'}">${icon(m.enabled ? 'pause' : 'play', 13)}</button>
              <button class="mini-act mini-act--danger" data-rp-act="del" title="删除模型">${icon('trash', 13)}</button>
            </div>
          </div>
          <div class="route-panel__sub">
            <span>${routes.length} 条路由</span><span>·</span><span>${groups} 个优先级组</span>
            ${m.description ? `<span>·</span><span class="truncate" style="max-width:220px" title="${esc(m.description)}">${esc(m.description)}</span>` : ''}
          </div>
        </div>
        <div class="route-panel__sched">
          <label class="switch" data-tip="上次成功的路由，下次优先从它开始">
            <input type="checkbox" id="rp-affinity" ${m.affinity ? 'checked' : ''}>
            <span class="switch__track"></span>
            <span class="switch__label">亲和</span>
          </label>
          <span class="sched-sep"></span>
          <span class="sched-label">冷却
            <input class="input" type="number" min="0" max="86400" id="rp-cooldown" value="${m.cooldown_sec == null ? 300 : m.cooldown_sec}">
            秒
          </span>
          <label class="switch" data-tip="全部路由都在冷却时，清空冷却再走一遍">
            <input type="checkbox" id="rp-reset" ${m.cooldown_reset ? 'checked' : ''}>
            <span class="switch__track"></span>
            <span class="switch__label">全冷却重置</span>
          </label>
          <span class="sched-sep"></span>
          <button class="btn btn--sm" id="rp-clear-cd" style="height:24px;padding:0 8px;font-size:10.5px">${icon('refresh', 11)}清冷却</button>
        </div>
        <div class="route-list" id="route-list">
          <div class="route-list__hint">${icon('move', 11)}拖动左侧渠道模型插入；拖动条目右侧把手可排序</div>
          ${routes.length ? routesHtml(routes) : ''}
          <div class="route-dropzone${routes.length ? ' is-mini' : ''}" id="route-drop-tail">
            ${icon('plus', routes.length ? 14 : 22)}
            <b>${routes.length ? '拖到这里追加一条路由' : '把左侧渠道模型拖进来'}</b>
            ${routes.length ? '' : '<span>也可以点击下面的「选择渠道模型」从列表里挑</span>'}
          </div>
        </div>
        <div class="route-panel__foot">
          <span id="rp-dirty"></span>
          <span class="route-panel__spacer" style="flex:1"></span>
          <button class="btn btn--sm" id="rp-pick">${icon('plus', 11)}选择渠道模型</button>
          <button class="btn btn--sm" id="rp-revert" ${st.dirty ? '' : 'disabled'}>撤销</button>
          <button class="btn btn--sm btn--primary" id="rp-save" ${st.dirty ? '' : 'disabled'}>保存路由</button>
        </div>
      </div>`;

    bindRoutePanel();
  }

  function modelStatusBadge(m) {
    const map = {
      ok: ['可用', 'green'], disabled: ['已禁用', 'gray'], custom_content: ['始终返回内容', 'green'],
      custom_error: ['始终返回错误', 'red'], channel_disabled: ['渠道已禁用', 'red'],
      channel_missing: ['渠道不存在', 'red'], model_missing: ['渠道模型不存在', 'red'],
      no_routes: ['未配置路由', 'red'], unavailable: ['不可用', 'red'],
    };
    const v = map[m.status] || ['不可用', 'red'];
    return badge(v[0], v[1]);
  }

  function bindRoutePanel() {
    const m = selectedModel();
    const host = ui.routePanel;
    const list = host.querySelector('#route-list');

    host.querySelectorAll('[data-goto-model], #cm-edit, #cm-test, #cm-new-route').forEach((b) => {
      // 渠道模型详情的按钮在各自分支里已绑过，这里只兜底一次
      if (b.dataset.bound) return;
      b.dataset.bound = '1';
    });

    if (!m || m.type !== 'custom') {
      if (list) bindTailDrop(list);
      return;
    }

    const routes = st.draft || [];

    // 重命名
    const idEl = host.querySelector('#rp-id');
    if (idEl) {
      idEl.onclick = async () => {
        const next = await promptDialog({ title: '重命名自定义模型', label: '模型 ID', value: m.id, hint: '不能包含斜杠，调用方要用这个 ID。' });
        if (!next || next === m.id) return;
        if (next.includes('/')) { Toast.error('自定义模型 ID 不能包含 /'); return; }
        if (D.model(next)) { Toast.error('模型 ID 已存在'); return; }
        m.id = next;
        m.updated_at = Date.now();
        st.selectedId = next;
        Toast.success(`模型已重命名：${m.id} → ${next}`);
        renderModelList();
        renderRoutePanel();
      };
    }

    // 调度参数
    const affinity = host.querySelector('#rp-affinity');
    const cooldown = host.querySelector('#rp-cooldown');
    const reset = host.querySelector('#rp-reset');
    const markDirty = () => {
      st.dirty = true;
      updateDirty();
    };
    affinity.onchange = () => { m.affinity = affinity.checked; markDirty(); };
    cooldown.onchange = () => {
      const v = Math.max(0, Math.min(86400, Number(cooldown.value) || 0));
      cooldown.value = v;
      m.cooldown_sec = v;
      markDirty();
    };
    reset.onchange = () => { m.cooldown_reset = reset.checked; markDirty(); };
    host.querySelector('#rp-clear-cd').onclick = () => Toast.success('已清除 2 条冷却、1 条亲和', '清除冷却');

    host.querySelectorAll('[data-rp-act]').forEach((btn) => {
      btn.onclick = async () => {
        const act = btn.dataset.rpAct;
        if (act === 'test') testModel(D.modelsView().find((x) => x.id === m.id) || m);
        else if (act === 'toggle') {
          m.enabled = !m.enabled;
          Toast.success(`模型 ${m.id} 已${m.enabled ? '启用' : '禁用'}`);
          renderModelList();
          renderRoutePanel();
        } else if (act === 'del') {
          const ok = await confirmDialog({ title: '删除模型', message: `确定删除自定义模型 <b>${esc(m.id)}</b> 吗？`, confirmText: '删除', danger: true });
          if (!ok) return;
          const di = D.models.findIndex((x) => x.id === m.id);
          if (di >= 0) D.models.splice(di, 1);
          st.selectedId = (D.models.find((x) => x.type === 'custom') || D.models[0] || {}).id || '';
          st.draft = null;
          st.dirty = false;
          Toast.success('模型已删除');
          renderChannelModels();
          renderModelList();
          renderRoutePanel();
        }
      };
    });

    // 分组折叠
    host.querySelectorAll('.route-group__head').forEach((head) => {
      head.onclick = (e) => {
        if (e.target.closest('button, input, [draggable]')) return;
        const g = head.closest('.route-group');
        const key = g.dataset.gkey;
        if (st.collapsedGroups.has(key)) st.collapsedGroups.delete(key);
        else st.collapsedGroups.add(key);
        g.classList.toggle('is-collapsed');
      };
    });

    // 单条操作
    host.querySelectorAll('[data-r-act]').forEach((btn) => {
      btn.onclick = () => {
        const idx = Number(btn.dataset.idx);
        const act = btn.dataset.rAct;
        const arr = st.draft;
        if (act === 'del') {
          arr.splice(idx, 1);
        } else if (act === 'up') {
          moveRoute(idx, -1);
        } else if (act === 'down') {
          moveRoute(idx, 1);
        } else if (act === 'merge') {
          mergeWithNeighbor(idx, -1);
        } else if (act === 'merge-down') {
          mergeWithNeighbor(idx, 1);
        } else if (act === 'split') {
          arr[idx].group = 0;
        }
        normalizeDraft();
        st.dirty = true;
        renderRoutePanel();
      };
    });

    // 权重
    host.querySelectorAll('[data-weight]').forEach((input) => {
      input.onchange = () => {
        const idx = Number(input.dataset.weight);
        const v = Math.max(0, Math.min(1000, Number(input.value) || 0));
        st.draft[idx].weight = v;
        st.dirty = true;
        updateDirty();
        renderRoutePanel();
      };
    });

    // 分组操作
    host.querySelectorAll('[data-g-act="ungroup"]').forEach((btn) => {
      btn.onclick = () => {
        const g = Number(btn.dataset.group);
        st.draft.forEach((r) => { if ((r.group || 0) === g) r.group = 0; });
        normalizeDraft();
        st.dirty = true;
        renderRoutePanel();
      };
    });

    // 路由拖拽排序
    host.querySelectorAll('.route-item__handle').forEach((handle) => {
      handle.addEventListener('dragstart', (e) => {
        const item = handle.closest('.route-item');
        const idx = Number(item.dataset.routeIdx);
        st.drag = { kind: 'route', from: idx };
        item.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', 'route:' + idx);
        showDragHint('拖动排序：松手前有绿色插入线');
      });
      handle.addEventListener('dragend', endDrag);
    });
    host.querySelectorAll('.route-group__grip').forEach((grip) => {
      grip.addEventListener('dragstart', (e) => {
        const group = Number(grip.dataset.groupDrag);
        const indices = st.draft.map((r, i) => ((r.group || 0) === group ? i : -1)).filter((i) => i >= 0);
        st.drag = { kind: 'group', group, indices };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', 'group:' + group);
        const g = grip.closest('.route-group');
        if (g) g.classList.add('is-dragging');
        showDragHint(`拖动整组：共 ${indices.length} 条`);
      });
      grip.addEventListener('dragend', endDrag);
    });

    if (list) bindRouteListDnd(list);

    // 底部按钮
    host.querySelector('#rp-pick').onclick = openRoutePicker;
    host.querySelector('#rp-revert').onclick = () => {
      st.drafts.delete(m.id);
      st.draft = clone(m.routes || []);
      st.dirty = false;
      renderModelList();
      renderRoutePanel();
    };
    host.querySelector('#rp-save').onclick = () => saveRoutes(m);
    updateDirty();
  }

  function updateDirty() {
    const el = document.getElementById('rp-dirty');
    if (!el) return;
    el.innerHTML = st.dirty ? '<span class="route-panel__dirty">有未保存的修改</span>' : '';
    const save = document.getElementById('rp-save');
    const revert = document.getElementById('rp-revert');
    if (save) save.disabled = !st.dirty;
    if (revert) revert.disabled = !st.dirty;
  }

  function normalizeDraft() {
    st.draft = normalizeGroups(st.draft || []);
  }

  function moveRoute(idx, dir) {
    const arr = st.draft;
    if (!arr || idx < 0 || idx >= arr.length) return;
    const r = arr[idx];
    const g = r.group || 0;
    if (g) {
      // 组内只在同组条目之间换位
      const target = idx + dir;
      if (target < 0 || target >= arr.length || (arr[target].group || 0) !== g) return;
      arr.splice(idx, 1);
      arr.splice(target, 0, r);
      return;
    }
    if (dir < 0) {
      if (idx === 0) return;
      // 上移越过上一个「单元」：普通条目是一条，分组是连续同组的一整段
      let start = idx - 1;
      const pg = arr[start].group || 0;
      if (pg) while (start > 0 && (arr[start - 1].group || 0) === pg) start -= 1;
      const [item] = arr.splice(idx, 1);
      arr.splice(start, 0, item);
    } else {
      if (idx === arr.length - 1) return;
      // 下移越过下一个「单元」
      let end = idx + 1;
      const ng = arr[end].group || 0;
      if (ng) while (end < arr.length && (arr[end].group || 0) === ng) end += 1;
      else end += 1;
      const [item] = arr.splice(idx, 1);
      arr.splice(end - 1, 0, item);
    }
  }

  function mergeWithNeighbor(idx, dir) {
    const arr = st.draft;
    const other = idx + dir;
    if (other < 0 || other >= arr.length) {
      Toast.info('这一侧没有可以合并的条目');
      return;
    }
    const own = arr[idx];
    const nb = arr[other];
    let group = own.group || 0;
    if (!group) {
      group = nb.group || 0;
      if (!group) {
        // 两条普通条目合成新组，编号取当前最大组 +1
        const max = arr.reduce((a, r) => Math.max(a, r.group || 0), 0);
        group = max + 1;
      }
      own.group = group;
    }
    if (!nb.group) nb.group = group;
  }

  function saveRoutes(m) {
    const routes = normalizeGroups(st.draft || []);
    if (routes.some((r) => !r.channel_id || !r.upstream)) {
      Toast.error('有路由缺少渠道或上游模型');
      return;
    }
    const seen = new Set();
    for (const r of routes) {
      const key = r.channel_id + '/' + r.upstream;
      if (seen.has(key)) {
        Toast.error(`路由目标重复：${key}`);
        return;
      }
      seen.add(key);
    }
    m.routes = routes;
    m.updated_at = Date.now();
    st.drafts.delete(m.id);
    st.draft = clone(routes);
    st.dirty = false;
    Toast.success(`自定义模型 ${m.id} 已保存，路由 ${routes.length} 条`);
    renderModelList();
    renderChannelModels();
    renderRoutePanel();
  }

  // ---------- 拖拽 ----------
  function showDragHint(text) {
    if (!dragHint) {
      dragHint = document.createElement('div');
      dragHint.className = 'drag-hint';
      document.body.appendChild(dragHint);
    }
    dragHint.innerHTML = `${icon('move', 14)}${esc(text)}`;
    dragHint.classList.add('is-on');
  }
  function hideDragHint() {
    if (dragHint) dragHint.classList.remove('is-on');
  }

  function startChannelDrag(e, channelId, upstream) {
    st.drag = { kind: 'channel-model', channel_id: channelId, upstream, model_id: channelId + '/' + upstream };
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', 'channel-model:' + channelId + '/' + upstream);
    showDragHint('拖到右侧路由列表：经过模型会自动展开它的路由');
    if (!st.draft && selectedModel() && selectedModel().type === 'custom') {
      st.draft = clone(selectedModel().routes || []);
    }
  }

  function endDrag() {
    const wasRoute = st.drag && st.drag.kind !== 'channel-model';
    st.drag = null;
    clearHover();
    hideDragHint();
    if (dragGhost) { dragGhost.remove(); dragGhost = null; }
    document.querySelectorAll('.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
    document.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
    document.querySelectorAll('.route-item.is-drop-before, .route-item.is-drop-after').forEach((el) => {
      el.classList.remove('is-drop-before', 'is-drop-after');
    });
    const list = document.getElementById('route-list');
    if (list) list.classList.remove('is-dragover');
    if (wasRoute && st.draft) {
      normalizeDraft();
      st.dirty = true;
      renderRoutePanel();
    }
  }

  function clearHover() {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; }
  }

  function dropTargetInfo(list, e) {
    const items = [...list.querySelectorAll('.route-item')].filter((el) => !el.classList.contains('is-dragging'));
    for (const item of items) {
      const r = item.getBoundingClientRect();
      if (e.clientY >= r.top && e.clientY <= r.bottom) {
        const idx = Number(item.dataset.routeIdx);
        const group = Number(item.dataset.group || 0);
        return { type: 'item', item, idx: e.clientY < r.top + r.height / 2 ? idx : idx + 1, group };
      }
    }
    // 分组容器内部（例如组头下方空白）
    const groupEl = e.target.closest('.route-group');
    if (groupEl) {
      const group = Number(groupEl.dataset.group || 0);
      const its = [...groupEl.querySelectorAll('.route-item')];
      const last = its.length ? Number(its[its.length - 1].dataset.routeIdx) + 1 : 0;
      return { type: 'group-end', group, idx: last };
    }
    return { type: 'tail', idx: (st.draft || []).length, group: 0 };
  }

  function bindRouteListDnd(list) {
    list.addEventListener('dragover', (e) => {
      if (!st.drag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = st.drag.kind === 'channel-model' ? 'copy' : 'move';
      list.classList.add('is-dragover');
      document.querySelectorAll('.route-item.is-drop-before, .route-item.is-drop-after').forEach((el) => {
        el.classList.remove('is-drop-before', 'is-drop-after');
      });
      const info = dropTargetInfo(list, e);
      if (info.item) info.item.classList.add(e.clientY < info.item.getBoundingClientRect().top + info.item.offsetHeight / 2 ? 'is-drop-before' : 'is-drop-after');
    });
    list.addEventListener('dragleave', (e) => {
      if (!list.contains(e.relatedTarget)) list.classList.remove('is-dragover');
    });
    list.addEventListener('drop', (e) => {
      if (!st.drag) return;
      e.preventDefault();
      const info = dropTargetInfo(list, e);
      const drag = st.drag;
      list.classList.remove('is-dragover');
      if (drag.kind === 'channel-model') {
        if (!selectedModel() || selectedModel().type !== 'custom') {
          createCustomFromDrop(drag);
          return;
        }
        appendRouteFromDrag(drag, info.idx, info.group);
      } else if (drag.kind === 'route') {
        moveRouteTo(drag.from, info.idx, info.group);
      } else if (drag.kind === 'group') {
        const first = drag.indices[0];
        moveRouteTo(first, info.idx, info.group, drag.indices.length);
      }
      st.drag = null;
      hideDragHint();
      document.querySelectorAll('.route-item.is-drop-before, .route-item.is-drop-after').forEach((el) => {
        el.classList.remove('is-drop-before', 'is-drop-after');
      });
      normalizeDraft();
      st.dirty = true;
      renderRoutePanel();
      flashLastRoute();
    });
  }

  function bindTailDrop(list) {
    if (!list || !selectedModel() || selectedModel().type !== 'custom') return;
    bindRouteListDnd(list);
  }

  function appendRouteFromDrag(drag, at, group) {
    const routes = st.draft || [];
    const id = drag.channel_id + '/' + drag.upstream;
    if (routes.some((r) => r.channel_id === drag.channel_id && r.upstream === drag.upstream)) {
      Toast.info(`${id} 已经在这条路由里了`);
      return;
    }
    if (!D.model(id)) addModelToManagement(drag.channel_id, drag.upstream);
    routes.splice(at, 0, { channel_id: drag.channel_id, upstream: drag.upstream, weight: 0, group: group || 0 });
    st.dirty = true;
    renderRoutePanel();
    flashLastRoute();
    Toast.success(`已插入路由 ${id}`);
  }

  function moveRouteTo(from, to, group, count) {
    const arr = st.draft;
    if (from == null || from < 0 || from >= arr.length) return;
    const moving = arr.splice(from, count || 1);
    let insert = to;
    if (insert > from) insert -= (count || 1);
    insert = Math.max(0, Math.min(arr.length, insert));
    moving.forEach((r, i) => {
      r.group = group || 0;
      arr.splice(insert + i, 0, r);
    });
  }

  function flashLastRoute() {
    requestAnimationFrame(() => {
      const items = document.querySelectorAll('#route-list .route-item');
      if (!items.length) return;
      const last = items[items.length - 1];
      last.classList.add('is-flash');
      last.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      setTimeout(() => last.classList.remove('is-flash'), 1000);
    });
  }

  function createCustomFromDrop(drag) {
    promptDialog({
      title: '新建自定义模型',
      label: '模型 ID',
      placeholder: '例如 LDM、fast',
      hint: '调用方使用这个 ID；新建后可以把更多渠道模型拖进它的路由。',
    }).then((id) => {
      if (!id) { endDrag(); return; }
      if (id.includes('/')) { Toast.error('自定义模型 ID 不能包含 /'); endDrag(); return; }
      if (D.model(id)) { Toast.error('模型 ID 已存在'); endDrag(); return; }
      const pid = D.matchProvider(id);
      const m = {
        id, type: 'custom', routes: [{ channel_id: drag.channel_id, upstream: drag.upstream, weight: 0, group: 0 }],
        provider_id: pid || '', caps: {}, enabled: true, affinity: true, cooldown_sec: 300, cooldown_reset: false,
        timeout: 300, force_stream: false, no_retry_status: '',
        content_enabled: false, thinking_override_enabled: false, system_prompt_enabled: false,
        error_enabled: false, error_always: false, error_status: 0, error_message: '', error_as_content: false, error_keep_no_retry: true,
        display_name: '', description: '', tags: [], created_at: Date.now(), updated_at: Date.now(),
      };
      D.models.push(m);
      if (!D.model(drag.channel_id + '/' + drag.upstream)) addModelToManagement(drag.channel_id, drag.upstream);
      st.selectedId = id;
      st.draft = clone(m.routes);
      st.dirty = true;
      Toast.success(`已新建 ${id}，第一条路由指向 ${drag.channel_id}/${drag.upstream}`);
      renderModelList();
      renderChannelModels();
      renderRoutePanel();
      endDrag();
    });
  }

  // ---------- 选择渠道模型（列表方式） ----------
  function openRoutePicker() {
    const m = selectedModel();
    if (!m || m.type !== 'custom') return;
    const picked = new Set((st.draft || []).map((r) => r.channel_id + '/' + r.upstream));
    const groups = new Map();
    D.channels.forEach((c) => {
      c.models.forEach((up) => {
        const key = c.id + '/' + up;
        if (!groups.has(c.id)) groups.set(c.id, { channel: c, models: [] });
        groups.get(c.id).models.push({ key, up, added: !!D.model(key) });
      });
    });
    const keyword = { v: '' };
    const body = `
      <div class="search" style="margin-bottom:10px">
        <span class="search__icon">${icon('search', 14)}</span>
        <input class="input" id="pick-search" placeholder="搜索模型 ID、渠道或提供商…">
      </div>
      <div id="pick-list" style="max-height:460px;overflow:auto"></div>`;

    const mo = openModal({
      title: '选择渠道模型',
      desc: '可以选还没接入模型管理的渠道模型，它们会作为路由目标直接生效',
      size: 'lg',
      body,
      footer: `<span class="fs-12 muted" id="pick-count">已选 ${picked.size} 个</span><div class="spacer"></div>
        <button class="btn" data-close>取消</button>
        <button class="btn btn--primary" data-ok>完成</button>`,
    });

    const paint = () => {
      const kw = keyword.v.trim().toLowerCase();
      const host = mo.body.querySelector('#pick-list');
      host.innerHTML = [...groups.values()].map(({ channel: c, models }) => {
        const list = models.filter((x) => !kw || (x.key + ' ' + c.name + ' ' + c.id).toLowerCase().includes(kw));
        if (!list.length) return '';
        return `<div class="col-sub-head">${esc(c.id)}（${esc(c.name)}）</div>
          ${list.map((x) => `<label class="row-item" style="cursor:pointer">
            <input type="checkbox" ${picked.has(x.key) ? 'checked' : ''} data-pick="${esc(x.key)}" style="margin:0 2px">
            <div class="row-item__main">
              <div class="row-item__name"><span class="truncate">${esc(x.up)}</span></div>
              <div class="row-item__sub"><span>${esc(c.id)}/${esc(x.up)}</span><span>·</span><span>${x.added ? '已接入' : '未接入'}</span></div>
            </div>
          </label>`).join('')}`;
      }).join('') || '<div class="col-empty">没有匹配的模型</div>';
      host.querySelectorAll('[data-pick]').forEach((cb) => {
        cb.onchange = () => {
          if (cb.checked) picked.add(cb.dataset.pick);
          else picked.delete(cb.dataset.pick);
          mo.foot.querySelector('#pick-count').textContent = `已选 ${picked.size} 个`;
        };
      });
    };
    mo.body.querySelector('#pick-search').addEventListener('input', debounce((e) => {
      keyword.v = e.target.value;
      paint();
    }, 140));
    paint();

    mo.foot.querySelector('[data-close]').onclick = () => mo.close();
    mo.foot.querySelector('[data-ok]').onclick = () => {
      const next = [];
      // 保留原顺序，新选的追加到末尾，与线上一致
      (st.draft || []).forEach((r) => {
        if (picked.has(r.channel_id + '/' + r.upstream)) next.push(r);
      });
      picked.forEach((key) => {
        if (next.some((r) => r.channel_id + '/' + r.upstream === key)) return;
        const i = key.indexOf('/');
        const cid = key.slice(0, i);
        const up = key.slice(i + 1);
        if (!D.model(key)) addModelToManagement(cid, up);
        next.push({ channel_id: cid, upstream: up, weight: 0, group: 0 });
      });
      st.draft = next;
      st.dirty = true;
      mo.close();
      renderRoutePanel();
      flashLastRoute();
    };
  }

  // ======================================================================
  // 添加模型（批量从渠道模型里挑）
  // ======================================================================
  function openAddModelsDialog() {
    const candidates = [];
    D.channels.forEach((c) => {
      c.models.forEach((up) => {
        const id = c.id + '/' + up;
        if (!D.model(id)) candidates.push({ id, channel: c, up, pid: D.matchProvider(up) });
      });
    });
    if (!candidates.length) {
      Toast.info('所有渠道模型都已经接入模型管理了');
      return;
    }
    const picked = new Set();
    const mo = openModal({
      title: '添加模型',
      desc: '列出渠道里配置、但还没接入模型管理的上游模型',
      size: 'lg',
      body: `<div style="display:flex;gap:6px;margin-bottom:10px">
          <button class="btn btn--sm" data-all>全选</button>
          <button class="btn btn--sm" data-none>清空</button>
          <span class="tool-count" style="margin-left:auto" id="add-count">已选 0 个</span>
        </div>
        <div id="add-list" style="max-height:440px;overflow:auto"></div>`,
      footer: `<div class="spacer"></div><button class="btn" data-close>取消</button><button class="btn btn--primary" data-ok disabled>添加</button>`,
    });
    const paint = () => {
      const byChannel = new Map();
      candidates.forEach((x) => {
        if (!byChannel.has(x.channel.id)) byChannel.set(x.channel.id, { c: x.channel, list: [] });
        byChannel.get(x.channel.id).list.push(x);
      });
      mo.body.querySelector('#add-list').innerHTML = [...byChannel.values()].map(({ c, list }) => `
        <div class="col-sub-head">${esc(c.id)}（${esc(c.name)}）</div>
        ${list.map((x) => {
          const p = D.provider(x.pid);
          return `<label class="row-item" style="cursor:pointer">
            <input type="checkbox" data-add-pick="${esc(x.id)}" ${picked.has(x.id) ? 'checked' : ''} style="margin:0 2px">
            ${p ? providerIcon(p.icon, 14) : providerIcon('', 14)}
            <div class="row-item__main">
              <div class="row-item__name"><span class="truncate">${esc(x.up)}</span></div>
              <div class="row-item__sub"><span>${esc(x.id)}</span><span>·</span><span>${p ? esc(p.name) : '未识别提供商'}</span></div>
            </div>
          </label>`;
        }).join('')}`).join('');
      bind();
    };
    const sync = () => {
      mo.body.querySelector('#add-count').textContent = `已选 ${picked.size} 个`;
      mo.foot.querySelector('[data-ok]').disabled = !picked.size;
      mo.foot.querySelector('[data-ok]').textContent = picked.size ? `添加（${picked.size}）` : '添加';
    };
    const bind = () => {
      mo.body.querySelectorAll('[data-add-pick]').forEach((cb) => {
        cb.onchange = () => {
          if (cb.checked) picked.add(cb.dataset.addPick);
          else picked.delete(cb.dataset.addPick);
          sync();
        };
      });
    };
    mo.body.querySelector('[data-all]').onclick = () => {
      candidates.forEach((x) => picked.add(x.id));
      paint();
      sync();
    };
    mo.body.querySelector('[data-none]').onclick = () => {
      picked.clear();
      paint();
      sync();
    };
    paint();
    sync();

    mo.foot.querySelector('[data-close]').onclick = () => mo.close();
    mo.foot.querySelector('[data-ok]').onclick = () => {
      picked.forEach((id) => {
        const i = id.indexOf('/');
        addModelToManagement(id.slice(0, i), id.slice(i + 1));
      });
      mo.close();
      Toast.success(`已添加 ${picked.size} 个模型`);
      renderModelList();
      renderChannelModels();
      renderRoutePanel();
    };
  }

  function createCustomModel() {
    promptDialog({
      title: '添加自定义模型',
      label: '模型 ID',
      placeholder: '例如 LDM、fast',
      hint: '对外暴露的模型名，不能包含 /。创建后再拖入渠道模型作为路由。',
    }).then((id) => {
      if (!id) return;
      if (id.includes('/')) { Toast.error('自定义模型 ID 不能包含 /'); return; }
      if (D.model(id)) { Toast.error('模型 ID 已存在'); return; }
      const pid = D.matchProvider(id);
      const m = {
        id, type: 'custom', routes: [], provider_id: pid || '', caps: {}, enabled: true,
        affinity: true, cooldown_sec: 300, cooldown_reset: false, timeout: 300, force_stream: false,
        no_retry_status: '', content_enabled: false, thinking_override_enabled: false, system_prompt_enabled: false,
        error_enabled: false, error_always: false, error_status: 0, error_message: '', error_as_content: false, error_keep_no_retry: true,
        display_name: '', description: '', tags: [], created_at: Date.now(), updated_at: Date.now(),
      };
      D.models.push(m);
      st.selectedId = id;
      st.draft = [];
      st.dirty = false;
      Toast.success(`自定义模型 ${id} 已创建，现在把渠道模型拖进路由`);
      renderModelList();
      renderRoutePanel();
    });
  }

  function createCustomWithRoute(channelModel) {
    promptDialog({
      title: '新建自定义模型',
      label: '模型 ID',
      placeholder: '例如 LDM、fast',
      hint: `创建后第一条路由指向 ${channelModel.id}`,
    }).then((id) => {
      if (!id) return;
      if (id.includes('/')) { Toast.error('自定义模型 ID 不能包含 /'); return; }
      if (D.model(id)) { Toast.error('模型 ID 已存在'); return; }
      const pid = D.matchProvider(id);
      D.models.push({
        id, type: 'custom',
        routes: [{ channel_id: channelModel.channel_id, upstream: channelModel.upstream, weight: 0, group: 0 }],
        provider_id: pid || '', caps: {}, enabled: true, affinity: true, cooldown_sec: 300, cooldown_reset: false,
        timeout: 300, force_stream: false, no_retry_status: '',
        content_enabled: false, thinking_override_enabled: false, system_prompt_enabled: false,
        error_enabled: false, error_always: false, error_status: 0, error_message: '', error_as_content: false, error_keep_no_retry: true,
        display_name: '', description: '', tags: [], created_at: Date.now(), updated_at: Date.now(),
      });
      st.selectedId = id;
      st.draft = [{ channel_id: channelModel.channel_id, upstream: channelModel.upstream, weight: 0, group: 0 }];
      st.dirty = true;
      Toast.success(`已新建 ${id}`);
      renderModelList();
      renderRoutePanel();
    });
  }

  // ======================================================================
  // 渠道模型设置弹窗
  // ======================================================================
  function capsEditorHtml(caps) {
    const tri = (key, label, hint) => {
      const v = caps[key];
      return `<div class="field" style="margin-bottom:8px">
        <label class="field__label">${label}</label>
        <select class="select" data-caps-tri="${key}">
          <option value=""${v == null ? ' selected' : ''}>不设置</option>
          <option value="1"${v === true ? ' selected' : ''}>支持</option>
          <option value="0"${v === false ? ' selected' : ''}>不支持</option>
        </select>
        <div class="field__error" data-caps-err-wrap="${key}" style="${v === false ? '' : 'display:none'};display:${v === false ? 'block' : 'none'}">
          <label class="switch" style="gap:6px"><input type="checkbox" data-caps-err="${key}" ${caps[key + '_error'] ? 'checked' : ''}><span class="switch__track"></span><span class="switch__label" style="font-size:11px">不支持时报错（400）</span></label>
        </div>
      </div>`;
    };
    return `<div class="gset-grid2">
      <div class="field" style="margin-bottom:8px">
        <label class="field__label">上下文长度</label>
        <input class="input" type="number" min="0" data-caps-num="context_length" value="${caps.context_length == null ? '' : caps.context_length}" placeholder="例如 128000">
      </div>
      <div class="field" style="margin-bottom:8px">
        <label class="field__label">最大输出</label>
        <input class="input" type="number" min="0" data-caps-num="max_output" value="${caps.max_output == null ? '' : caps.max_output}" placeholder="例如 8192">
      </div>
    </div>
    ${tri('tool_calling', '工具调用')}${tri('thinking', '思考')}${tri('vision', '图片输入')}`;
  }

  function readCapsEditor(scope) {
    const caps = {};
    scope.querySelectorAll('[data-caps-num]').forEach((input) => {
      if (input.value !== '') caps[input.dataset.capsNum] = Math.max(0, Number(input.value) || 0);
    });
    scope.querySelectorAll('[data-caps-tri]').forEach((sel) => {
      const key = sel.dataset.capsTri;
      if (sel.value === '') return;
      caps[key] = sel.value === '1';
    });
    scope.querySelectorAll('[data-caps-err]').forEach((cb) => {
      caps[cb.dataset.capsErr + '_error'] = cb.checked;
    });
    return caps;
  }

  function bindCapsEditor(scope) {
    scope.querySelectorAll('[data-caps-tri]').forEach((sel) => {
      sel.onchange = () => {
        const wrap = scope.querySelector(`[data-caps-err-wrap="${sel.dataset.capsTri}"]`);
        if (wrap) wrap.style.display = sel.value === '0' ? 'block' : 'none';
      };
    });
  }

  function openChannelModelEditor(m) {
    if (!m) return;
    const p = m.provider_id ? D.provider(m.provider_id) : null;
    const mo = openModal({
      title: '编辑渠道模型',
      desc: m.id,
      size: 'lg',
      body: `<div class="fs-12 muted" style="margin-bottom:10px">渠道模型的 ID 由「渠道 ID / 上游模型名」自动生成，不可修改。</div>
        <div class="gset-grid2">
          <div class="field" style="margin-bottom:10px">
            <label class="field__label">提供商</label>
            <select class="select" id="cm-provider">
              <option value="">不设置提供商</option>
              ${D.providers.map((x) => `<option value="${esc(x.id)}"${m.provider_id === x.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field" style="margin-bottom:10px">
            <label class="field__label">超时时间（秒）</label>
            <input class="input" type="number" min="0" id="cm-timeout" value="${m.timeout || 300}">
          </div>
        </div>
        <div class="field" style="margin-bottom:10px">
          <label class="field__label">描述</label>
          <input class="input" id="cm-desc" placeholder="显示在模型广场" value="${esc(m.description || '')}">
        </div>
        <div class="cm-detail__sec">能力参数</div>
        <div id="cm-caps">${capsEditorHtml(m.caps || {})}</div>
        <details class="advanced-settings" style="margin-top:10px">
          <summary>高级设置</summary>
          <div style="padding-top:8px;display:flex;flex-direction:column;gap:8px">
            <label class="switch"><input type="checkbox" id="cm-force-stream" ${m.force_stream ? 'checked' : ''}><span class="switch__track"></span><span class="switch__label">强制以流式请求上游</span></label>
            <div class="field" style="margin:0">
              <label class="field__label">不可重试状态码</label>
              <input class="input" id="cm-no-retry" placeholder="例如 400-428,430-499（留空表示都可重试）" value="${esc(m.no_retry_status || '')}">
            </div>
            <label class="switch"><input type="checkbox" id="cm-sysprompt-on" ${m.system_prompt_enabled ? 'checked' : ''}><span class="switch__track"></span><span class="switch__label">系统提示词注入（删除请求自带系统提示词）</span></label>
            <textarea class="textarea" id="cm-sysprompt" rows="2" placeholder="注入的系统提示词">${esc(m.system_prompt || '')}</textarea>
            <label class="switch"><input type="checkbox" id="cm-content-on" ${m.content_enabled ? 'checked' : ''}><span class="switch__track"></span><span class="switch__label">自定义内容返回（不请求上游）</span></label>
            <textarea class="textarea" id="cm-content-text" rows="2" placeholder="返回的正文">${esc(m.content_text || '')}</textarea>
            <label class="switch"><input type="checkbox" id="cm-error-on" ${m.error_enabled ? 'checked' : ''}><span class="switch__track"></span><span class="switch__label">错误覆写</span></label>
            <div class="gset-grid2">
              <input class="input" type="number" id="cm-error-status" placeholder="状态码 400-599" value="${m.error_status || ''}">
              <input class="input" id="cm-error-msg" placeholder="错误详情" value="${esc(m.error_message || '')}">
            </div>
            <label class="switch"><input type="checkbox" id="cm-error-as-content" ${m.error_as_content ? 'checked' : ''}><span class="switch__track"></span><span class="switch__label">错误覆写为正文（200 返回）</span></label>
          </div>
        </details>
        <label class="switch" style="margin-top:10px"><input type="checkbox" id="cm-enabled" ${m.enabled ? 'checked' : ''}><span class="switch__track"></span><span class="switch__label">启用该模型</span></label>`,
      footer: `<button class="btn" id="cm-test">${icon('zap', 12)}测试</button><div class="spacer"></div>
        <button class="btn" data-cancel>取消</button><button class="btn btn--primary" data-save>保存</button>`,
    });
    bindCapsEditor(mo.body);
    mo.foot.querySelector('#cm-test').onclick = () => testModel(m);
    mo.foot.querySelector('[data-cancel]').onclick = () => mo.close();
    mo.foot.querySelector('[data-save]').onclick = () => {
      m.provider_id = mo.body.querySelector('#cm-provider').value;
      m.timeout = Math.max(0, Number(mo.body.querySelector('#cm-timeout').value) || 0);
      m.description = mo.body.querySelector('#cm-desc').value.trim();
      m.caps = readCapsEditor(mo.body.querySelector('#cm-caps'));
      m.force_stream = mo.body.querySelector('#cm-force-stream').checked;
      m.no_retry_status = mo.body.querySelector('#cm-no-retry').value.trim();
      m.system_prompt_enabled = mo.body.querySelector('#cm-sysprompt-on').checked;
      m.system_prompt = mo.body.querySelector('#cm-sysprompt').value;
      m.content_enabled = mo.body.querySelector('#cm-content-on').checked;
      m.content_text = mo.body.querySelector('#cm-content-text').value;
      m.error_enabled = mo.body.querySelector('#cm-error-on').checked;
      m.error_status = Number(mo.body.querySelector('#cm-error-status').value) || 0;
      m.error_message = mo.body.querySelector('#cm-error-msg').value;
      m.error_as_content = mo.body.querySelector('#cm-error-as-content').checked;
      if (m.content_enabled) m.error_enabled = false;
      m.enabled = mo.body.querySelector('#cm-enabled').checked;
      m.updated_at = Date.now();
      mo.close();
      Toast.success(`模型 ${m.id} 已保存`);
      renderChannelModels();
      renderModelList();
      renderRoutePanel();
    };
  }

  function testModel(m) {
    Toast.info('测试请求已发出，稍等…', `测试 ${m.id}`);
    setTimeout(() => {
      const lat = 420 + Math.floor(Math.random() * 900);
      Toast.success(`耗时 ${lat}ms · 渠道 ${m.channel_id || '自定义'} → ${m.upstream || (m.routes && m.routes[0] ? m.routes[0].upstream : '自动')} · 输出「你好，我是懒大猫。」`, `「${m.id}」测试通过`);
    }, 700);
  }

  // ======================================================================
  // 渠道编辑页（独立整页，返回工作台）
  // ======================================================================
  function openChannelEditor(c) {
    const isNew = !c;
    const draft = c ? clone(c) : {
      id: '', name: '', type: 'openai', base_url: '', proxy_url: '', enabled: true, remark: '',
      models: [], multi_key_enabled: false, key_mode: 'sequential', key_affinity: false,
      key_rows: [{ index: 0, masked: '', note: '' }], key_cooldown_sec: 300, key_cooldown_reset: false,
      key_cooldown_status: '401,403,429,500-599', append_v1: true, headers: {}, body_edits: [],
      created_at: Date.now(), updated_at: Date.now(),
    };
    draft.key_rows = (draft.key_rows && draft.key_rows.length) ? draft.key_rows : [{ index: 0, masked: '', note: '' }];
    st.editor = { draft, isNew };
    renderChannelEditorPage();
  }

  function renderChannelEditorPage() {
    const host = document.getElementById('mgmt');
    const { draft, isNew } = st.editor;
    host.innerHTML = `
      <div class="gview" style="max-width:1000px;margin:0 auto;width:100%">
        <div class="page-head">
          <div class="page-head__titles">
            <div class="page-head__title">${icon(isNew ? 'plus' : 'edit', 19)}${isNew ? '添加渠道' : '编辑渠道 · ' + esc(draft.id)}</div>
            <div class="page-head__desc">渠道决定上游怎么连；模型是否对外开放，仍由「模型管理」控制</div>
          </div>
          <div class="page-head__actions">
            <button class="btn" id="ce-back">${icon('chevronLeft', 13)}返回</button>
            <button class="btn btn--primary" id="ce-save">${icon('check', 13)}保存渠道</button>
          </div>
        </div>
        <div class="gset-grid2">
          <div class="field">
            <label class="field__label">渠道 ID</label>
            <input class="input" id="ce-id" value="${esc(draft.id)}" placeholder="例如 ch-main" ${isNew ? '' : 'disabled'}>
            ${isNew ? '<div class="field__hint">唯一标识，不能包含 / 与空格；上游模型的完整 ID 会以它开头。</div>' : '<div class="field__hint">创建后不可修改；模型 ID 由它派生。</div>'}
          </div>
          <div class="field">
            <label class="field__label">显示名称</label>
            <input class="input" id="ce-name" value="${esc(draft.name || '')}" placeholder="例如 主力 OpenAI">
          </div>
        </div>
        <div class="gset-grid2">
          <div class="field">
            <label class="field__label">接口类型</label>
            <select class="select" id="ce-type">
              ${[['openai', 'OpenAI 兼容'], ['anthropic', 'Anthropic'], ['gemini', 'Google Gemini']]
                .map(([v, t]) => `<option value="${v}"${draft.type === v ? ' selected' : ''}>${t}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label class="field__label">Base URL</label>
            <input class="input" id="ce-base" value="${esc(draft.base_url || '')}" placeholder="https://api.openai.com/v1">
          </div>
        </div>
        <div class="field">
          <label class="field__label">代理地址</label>
          <input class="input" id="ce-proxy" value="${esc(draft.proxy_url || '')}" placeholder="http://127.0.0.1:7890（留空沿用环境代理）">
        </div>
        <div class="field">
          <label class="field__label">上游模型名</label>
          <textarea class="textarea" id="ce-models" rows="4" placeholder="每行一个上游真实模型名">${esc((draft.models || []).join('\n'))}</textarea>
          <div class="field__hint">这里填上游真实模型名；接入模型管理后，ID 会变成「渠道 ID / 上游模型名」。</div>
        </div>

        <div class="gset__sec-title" style="margin-top:16px">密钥</div>
        <label class="switch" style="margin-bottom:8px">
          <input type="checkbox" id="ce-multi" ${draft.multi_key_enabled ? 'checked' : ''}>
          <span class="switch__track"></span><span class="switch__label">多 Key 模式</span>
        </label>
        <div class="key-rows" id="ce-keys"></div>
        <button class="btn btn--sm" id="ce-add-key" style="margin-top:6px">${icon('plus', 12)}添加 Key</button>
        <div class="gset-grid2" style="margin-top:10px">
          <div class="field">
            <label class="field__label">Key 调度</label>
            <select class="select" id="ce-keymode">
              <option value="sequential"${draft.key_mode !== 'random' ? ' selected' : ''}>顺序</option>
              <option value="random"${draft.key_mode === 'random' ? ' selected' : ''}>随机</option>
            </select>
          </div>
          <div class="field">
            <label class="field__label">Key 失败冷却（秒）</label>
            <input class="input" type="number" min="0" max="86400" id="ce-keycd" value="${draft.key_cooldown_sec == null ? 300 : draft.key_cooldown_sec}">
          </div>
        </div>
        <div class="gset-grid2">
          <label class="switch"><input type="checkbox" id="ce-keyaff" ${draft.key_affinity ? 'checked' : ''}><span class="switch__track"></span><span class="switch__label">Key 亲和</span></label>
          <label class="switch"><input type="checkbox" id="ce-keyreset" ${draft.key_cooldown_reset ? 'checked' : ''}><span class="switch__track"></span><span class="switch__label">全部 Key 冷却时重置</span></label>
        </div>
        <div class="field" style="margin-top:10px">
          <label class="field__label">Key 冷却状态码</label>
          <input class="input" id="ce-keystatus" value="${esc(draft.key_cooldown_status || '')}" placeholder="例如 401,403,429,500-599">
        </div>

        <details class="advanced-settings" style="margin-top:14px">
          <summary>高级设置</summary>
          <div style="padding-top:10px;display:flex;flex-direction:column;gap:10px">
            <label class="switch"><input type="checkbox" id="ce-appendv1" ${draft.append_v1 !== false ? 'checked' : ''}><span class="switch__track"></span><span class="switch__label">自动补全 /v1</span></label>
            <div class="gset-grid2">
              <div class="field" style="margin:0">
                <label class="field__label">权重</label>
                <input class="input" type="number" min="1" id="ce-weight" value="${draft.weight || 1}">
              </div>
              <div class="field" style="margin:0">
                <label class="field__label">备注</label>
                <input class="input" id="ce-remark" value="${esc(draft.remark || '')}">
              </div>
            </div>
            <div class="field" style="margin:0">
              <label class="field__label">附加请求头（JSON）</label>
              <textarea class="textarea" id="ce-headers" rows="3" spellcheck="false">${esc(JSON.stringify(draft.headers || {}, null, 2))}</textarea>
            </div>
            <div class="field" style="margin:0">
              <label class="field__label">请求体修改（JSON 数组）</label>
              <textarea class="textarea" id="ce-bodyedits" rows="3" spellcheck="false">${esc(JSON.stringify(draft.body_edits || [], null, 2))}</textarea>
            </div>
          </div>
        </details>
        <div class="tool-row" style="margin-top:14px">
          <button class="btn btn--sm" id="ce-test">${icon('zap', 12)}测试连通性</button>
          <button class="btn btn--sm" id="ce-discover">${icon('refresh', 12)}获取模型列表</button>
          <span class="tool-row__spacer"></span>
          <label class="switch"><input type="checkbox" id="ce-enabled" ${draft.enabled ? 'checked' : ''}><span class="switch__track"></span><span class="switch__label">启用该渠道</span></label>
        </div>
      </div>`;

    renderKeyRows();
    document.getElementById('ce-back').onclick = async () => {
      const ok = await confirmDialog({ title: '返回模型管理', message: '未保存的修改会丢掉，确定返回吗？', confirmText: '返回' });
      if (!ok) return;
      st.editor = null;
      renderWorkbench();
    };
    document.getElementById('ce-add-key').onclick = () => {
      draft.key_rows.push({ index: -1, masked: '', note: '' });
      renderKeyRows();
    };
    document.getElementById('ce-multi').onchange = (e) => {
      draft.multi_key_enabled = e.target.checked;
    };
    document.getElementById('ce-discover').onclick = () => openDiscoverDialog(draft);
    document.getElementById('ce-test').onclick = () => {
      Toast.info('正在连接上游模型列表…', '测试渠道');
      setTimeout(() => Toast.success(`连接成功，上游返回 ${draft.models.length || 3} 个模型（428ms）`, '渠道可用'), 700);
    };
    document.getElementById('ce-save').onclick = () => saveChannelEditor();
  }

  function renderKeyRows() {
    const { draft } = st.editor;
    const host = document.getElementById('ce-keys');
    const multi = document.getElementById('ce-multi').checked;
    host.innerHTML = draft.key_rows.map((r, i) => `
      <div class="key-row">
        <input class="input" data-key-input="${i}" value="${esc(r.masked || '')}" placeholder="${r.index >= 0 ? '留空沿用原 Key' : '粘贴 API Key'}">
        <input class="input" data-key-note="${i}" value="${esc(r.note || '')}" placeholder="备注（可选）" style="max-width:160px">
        ${multi && draft.key_rows.length > 1 ? `<button class="btn btn--icon btn--sm btn--danger" data-key-rm="${i}" title="删除">${icon('trash', 12)}</button>` : ''}
      </div>`).join('');
    host.querySelectorAll('[data-key-rm]').forEach((btn) => {
      btn.onclick = () => {
        draft.key_rows.splice(Number(btn.dataset.keyRm), 1);
        renderKeyRows();
      };
    });
    host.querySelectorAll('[data-key-input]').forEach((input) => {
      input.oninput = () => { draft.key_rows[Number(input.dataset.keyInput)].masked = input.value; };
    });
    host.querySelectorAll('[data-key-note]').forEach((input) => {
      input.oninput = () => { draft.key_rows[Number(input.dataset.keyNote)].note = input.value; };
    });
  }

  function saveChannelEditor() {
    const { draft, isNew } = st.editor;
    const id = (document.getElementById('ce-id').value || '').trim();
    if (!id) { Toast.error('请填写渠道 ID'); return; }
    if (id.includes('/') || /\s/.test(id)) { Toast.error('渠道 ID 不能包含 / 或空格'); return; }
    if (isNew && D.channel(id)) { Toast.error('渠道 ID 已存在'); return; }
    const base = document.getElementById('ce-base').value.trim();
    if (!base || !/^https?:\/\//i.test(base)) { Toast.error('Base URL 必须以 http:// 或 https:// 开头'); return; }
    let headers;
    let bodyEdits;
    try { headers = JSON.parse(document.getElementById('ce-headers').value || '{}'); }
    catch (e) { Toast.error('附加请求头不是合法 JSON'); return; }
    try { bodyEdits = JSON.parse(document.getElementById('ce-bodyedits').value || '[]'); }
    catch (e) { Toast.error('请求体修改不是合法 JSON'); return; }

    const models = document.getElementById('ce-models').value.split('\n').map((s) => s.trim()).filter(Boolean);
    const multi = document.getElementById('ce-multi').checked;
    const rows = multi ? draft.key_rows.filter((r) => r.masked || r.index >= 0) : draft.key_rows.slice(0, 1);
    Object.assign(draft, {
      id,
      name: document.getElementById('ce-name').value.trim(),
      type: document.getElementById('ce-type').value,
      base_url: base,
      proxy_url: document.getElementById('ce-proxy').value.trim(),
      models,
      multi_key_enabled: multi,
      key_mode: document.getElementById('ce-keymode').value,
      key_affinity: document.getElementById('ce-keyaff').checked,
      key_cooldown_sec: Math.max(0, Math.min(86400, Number(document.getElementById('ce-keycd').value) || 0)),
      key_cooldown_reset: document.getElementById('ce-keyreset').checked,
      key_cooldown_status: document.getElementById('ce-keystatus').value.trim(),
      append_v1: document.getElementById('ce-appendv1').checked,
      weight: Math.max(1, Number(document.getElementById('ce-weight').value) || 1),
      remark: document.getElementById('ce-remark').value.trim(),
      headers,
      body_edits: bodyEdits,
      enabled: document.getElementById('ce-enabled').checked,
      key_rows: rows.map((r, i) => ({ index: r.index, masked: r.masked, note: r.note || '' })),
      updated_at: Date.now(),
      channel_models: models.map((m) => id + '/' + m),
    });

    if (isNew) {
      D.channels.push(draft);
      st.channelId = id;
    } else {
      const old = D.channel(draft.id);
      if (old) Object.assign(old, draft);
      // 渠道里的模型名改过：已接入的渠道模型跟着更新上游名
      D.models.forEach((m) => {
        if (m.type === 'channel' && m.channel_id === id) {
          if (!models.includes(m.upstream)) m.statusHint = 'model_missing';
        }
      });
    }
    st.editor = null;
    recalcAll();
    Toast.success(`渠道 ${id} 已保存`);
    renderWorkbench();
  }

  // 获取模型列表（模拟 POST /api/channels/discover）
  function openDiscoverDialog(draft) {
    Toast.info('正在向上游请求模型列表…');
    D.discover(draft.id || 'ch-main').then((res) => {
      const current = new Set(draft.models || []);
      const picked = new Set(current);
      const mo = openModal({
        title: '获取模型列表',
        desc: res.message + ` · ${res.latency_ms}ms`,
        size: 'lg',
        body: `<div style="display:flex;gap:6px;margin-bottom:10px">
            <button class="btn btn--sm" data-all>全选</button><button class="btn btn--sm" data-none>清空</button>
            <span class="tool-count" style="margin-left:auto" id="dv-count">已选 ${picked.size} 个</span>
          </div>
          <div style="max-height:420px;overflow:auto" id="dv-list">
            ${res.models.map((m) => {
              const pid = D.matchProvider(m);
              const p = D.provider(pid);
              return `<label class="row-item" style="cursor:pointer">
                <input type="checkbox" data-dv="${esc(m)}" ${picked.has(m) ? 'checked' : ''} style="margin:0 2px">
                ${p ? providerIcon(p.icon, 14) : providerIcon('', 14)}
                <div class="row-item__main">
                  <div class="row-item__name"><span class="truncate">${esc(m)}</span></div>
                  <div class="row-item__sub"><span>${p ? esc(p.name) : '未识别提供商'}</span><span>·</span><span>${current.has(m) ? '渠道里已有' : '上游新增'}</span></div>
                </div>
              </label>`;
            }).join('')}
          </div>`,
        footer: `<div class="spacer"></div><button class="btn" data-close>取消</button><button class="btn btn--primary" data-ok>更新模型列表</button>`,
      });
      const sync = () => {
        mo.body.querySelector('#dv-count').textContent = `已选 ${picked.size} 个`;
      };
      const bind = () => {
        mo.body.querySelectorAll('[data-dv]').forEach((cb) => {
          cb.onchange = () => {
            if (cb.checked) picked.add(cb.dataset.dv);
            else picked.delete(cb.dataset.dv);
            sync();
          };
        });
      };
      bind();
      mo.body.querySelector('[data-all]').onclick = () => {
        res.models.forEach((m) => picked.add(m));
        mo.body.querySelectorAll('[data-dv]').forEach((cb) => { cb.checked = true; });
        sync();
      };
      mo.body.querySelector('[data-none]').onclick = () => {
        picked.clear();
        mo.body.querySelectorAll('[data-dv]').forEach((cb) => { cb.checked = false; });
        sync();
      };
      mo.foot.querySelector('[data-close]').onclick = () => mo.close();
      mo.foot.querySelector('[data-ok]').onclick = () => {
        draft.models = res.models.filter((m) => picked.has(m));
        mo.close();
        const ta = document.getElementById('ce-models');
        if (ta) {
          ta.value = draft.models.join('\n');
        } else {
          // 从工作台直接拉列表：保存到渠道并立即刷新左右两列
          recalcAll();
          renderChannelList();
          renderChannelModels();
          renderModelList();
        }
        Toast.success(`当前共 ${draft.models.length} 个模型，新增 ${[...picked].filter((m) => !current.has(m)).length} 个，移除 ${[...current].filter((m) => !picked.has(m)).length} 个`);
      };
    }).catch((e) => Toast.error(e.message, '获取模型列表失败'));
  }

  // ---------- 工具 ----------
  function recalcChannelModel(m) {
    if (m.type === 'channel') {
      const c = D.channel(m.channel_id);
      m.channel_name = c ? c.name : '';
      m.channel_type = c ? c.type : '';
      m.status = !c ? 'channel_missing' : (!c.enabled ? 'channel_disabled' : (!c.models.includes(m.upstream) ? 'model_missing' : (!m.enabled ? 'disabled' : 'ok')));
      m.channel_ready = m.status === 'ok';
    }
  }

  function recalcAll() {
    D.channels.forEach((c) => {
      c.channel_models = c.models.map((m) => c.id + '/' + m);
      c.added_count = D.models.filter((m) => m.type === 'channel' && m.channel_id === c.id).length;
    });
    D.models.forEach(recalcChannelModel);
    D.providers.forEach((p) => {
      p.model_count = D.models.filter((m) => m.provider_id === p.id).length;
    });
  }

  function splitRestore() {
    try {
      const v = Number(localStorage.getItem('ldmpv.mgmt.split'));
      if (v >= 30 && v <= 65) {
        document.querySelector('.mgmt__panel--left').style.flexBasis = v + '%';
      }
    } catch (e) { /* ignore */ }
  }

  function restoreSplit() {
    splitRestore();
    const gutter = document.getElementById('mgmt-gutter');
    if (!gutter) return;
    gutter.onmousedown = (e) => {
      e.preventDefault();
      const wrap = document.getElementById('mgmt');
      const left = wrap.querySelector('.mgmt__panel--left');
      const rect = wrap.getBoundingClientRect();
      gutter.classList.add('is-drag');
      const onMove = (ev) => {
        let pct = ((ev.clientX - rect.left) / rect.width) * 100;
        pct = Math.max(32, Math.min(62, pct));
        left.style.flexBasis = pct + '%';
        try { localStorage.setItem('ldmpv.mgmt.split', String(Math.round(pct))); } catch (err) { /* ignore */ }
      };
      const onUp = () => {
        gutter.classList.remove('is-drag');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
  }

  function bindWorkbench() {
    document.getElementById('btn-add-channel').onclick = () => openChannelEditor(null);
    document.getElementById('btn-add-models').onclick = openAddModelsDialog;
    document.getElementById('btn-new-custom').onclick = createCustomModel;
    document.getElementById('btn-clear-cd').onclick = () => {
      Toast.success('已清除 7 条冷却、4 条亲和', '清除所有冷却');
    };
    document.getElementById('btn-add-upstream').onclick = async () => {
      const c = selectedChannel();
      if (!c) return;
      const name = await promptDialog({
        title: '添加渠道模型',
        label: '上游模型名',
        placeholder: '例如 gpt-4.1-mini',
        hint: '这里填上游真实模型名，保存后会自动接入模型管理。',
      });
      if (!name) return;
      if (c.models.includes(name)) { Toast.info('渠道里已经有这个模型了'); return; }
      c.models.push(name);
      addModelToManagement(c.id, name);
      Toast.success(`已添加 ${c.id}/${name}`);
      renderChannelList();
      renderChannelModels();
    };
    document.getElementById('btn-discover').onclick = () => {
      const c = selectedChannel();
      if (!c) { Toast.warn('先选择一个渠道'); return; }
      openDiscoverDialog(c);
    };
    const chSearch = document.getElementById('ch-search');
    chSearch.addEventListener('input', debounce(() => {
      st.channelSearch = chSearch.value;
      renderChannelList();
    }, 140));
    const mSearch = document.getElementById('m-search');
    mSearch.addEventListener('input', debounce(() => {
      st.modelSearch = mSearch.value;
      renderModelList();
    }, 140));
    document.getElementById('m-type').onchange = (e) => {
      st.modelType = e.target.value;
      renderModelList();
    };
  }

  window.PVPages = window.PVPages || {};
  window.PVPages.models = {
    render,
    destroy() {
      if (hoverTimer) clearTimeout(hoverTimer);
      if (dragHint) { dragHint.remove(); dragHint = null; }
    },
  };
})();
