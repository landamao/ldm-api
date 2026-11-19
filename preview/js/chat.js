/* ==========================================================================
   首页 · 在线聊天
   —— 对齐线上聊天页现有能力：多会话、模型选择、采样参数、流式开关、
      工具调用开关、自定义请求体、附件/图片、思考块、Markdown/KaTeX、
      token 统计、停止生成、重试/复制/删除。
      预览里没有后端，回复由本地按模型能力模拟，其余交互与正式实现一致。
   ========================================================================== */
(function () {
  'use strict';

  const {
    esc, icon, fmtInt, fmtDuration, providerIcon, Toast, Tip, switchEl,
    openModal, confirmDialog, copyText, debounce, Theme,
  } = window.PV;
  const D = window.PVDATA;

  const K = {
    sessions: 'ldmpv.chat.sessions',
    model: 'ldmpv.chat.model',
    params: 'ldmpv.chat.params',
    stream: 'ldmpv.chat.stream',
    tools: 'ldmpv.chat.tools',
    custom: 'ldmpv.chat.custom',
    side: 'ldmpv.chat.side',
    conv: 'ldmpv.chat.conv',
    test: 'ldmpv.chat.test',
  };

  const read = (key, def) => {
    try {
      const v = localStorage.getItem(key);
      return v == null ? def : JSON.parse(v);
    } catch (e) { return def; }
  };
  const write = (key, val) => {
    try {
      localStorage.setItem(key, JSON.stringify(val));
      return true;
    } catch (e) {
      return false; // 配额满时只留内存
    }
  };

  const PARAM_DEFS = [
    { key: 'temperature', label: '温度', type: 'range', min: 0, max: 2, step: 0.1, def: 0.7, on: true, fmt: (v) => Number(v).toFixed(1) },
    { key: 'top_p', label: 'Top P', type: 'range', min: 0, max: 1, step: 0.05, def: 1, on: true, fmt: (v) => Number(v).toFixed(2) },
    { key: 'max_tokens', label: '最大 Token', type: 'number', min: 0, step: 1, def: 4096, on: false, fmt: (v) => fmtInt(v) },
    { key: 'frequency_penalty', label: '频率惩罚', type: 'range', min: -2, max: 2, step: 0.1, def: 0, on: true, fmt: (v) => Number(v).toFixed(1) },
    { key: 'presence_penalty', label: '存在惩罚', type: 'range', min: -2, max: 2, step: 0.1, def: 0, on: true, fmt: (v) => Number(v).toFixed(1) },
    { key: 'seed', label: '种子', type: 'number', min: 0, step: 1, def: '', on: false, fmt: (v) => (v === '' ? '随机' : String(v)) },
  ];

  let sessions;
  let activeId;
  let ui = null;
  let run = null;
  let saveFailed = false;

  function defaultParams() {
    const values = {};
    const enabled = {};
    PARAM_DEFS.forEach((p) => {
      values[p.key] = p.def;
      enabled[p.key] = p.on;
    });
    return { values, enabled };
  }

  let params = read(K.params, null) || defaultParams();

  function uid() {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function newSession(model) {
    return { id: uid(), title: '新对话', createdAt: Date.now(), updatedAt: Date.now(), model: model || '', messages: [] };
  }

  function availableModels() {
    const list = D.modelsView().filter((m) => m.enabled && (m.channel_ready || m.status === 'custom_content'));
    return list;
  }

  function loadStore() {
    const store = read(K.sessions, null);
    if (store && Array.isArray(store.sessions) && store.sessions.length) {
      // 刷新时可能停在「已插入空回复、还没开始吐字」的瞬间：把这种空壳去掉
      store.sessions.forEach((s) => {
        s.messages = (s.messages || []).filter((m) => {
          if (m.role !== 'assistant') return true;
          return !!(m.content || m.error || m.think);
        });
      });
      sessions = store.sessions;
      activeId = sessions.some((s) => s.id === store.activeId) ? store.activeId : sessions[0].id;
      return;
    }
    const first = newSession(read(K.model, '') || (availableModels()[0] || {}).id || '');
    sessions = [first];
    activeId = first.id;
  }

  function saveStore() {
    const ok = write(K.sessions, { activeId, sessions });
    if (!ok && !saveFailed) {
      saveFailed = true;
      Toast.warn('对话内容过大，无法保存到浏览器本地；刷新后附件可能丢失。');
    }
  }

  const current = () => sessions.find((s) => s.id === activeId) || sessions[0];

  function titleOf(s) {
    const first = s.messages.find((m) => m.role === 'user');
    if (!first) return '新对话';
    let text = '';
    if (typeof first.content === 'string') text = first.content;
    else if (Array.isArray(first.content)) {
      text = first.content.filter((p) => p.type === 'text').map((p) => p.text).join(' ');
    }
    text = text.replace(/\s+/g, ' ').trim();
    return text.length > 24 ? text.slice(0, 24) + '…' : text || '新对话';
  }

  function groupOf(ts) {
    const now = new Date();
    const start = new Date(ts);
    const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ts >= d0) return '今天';
    if (ts >= d0 - 86400000) return '昨天';
    if (ts >= d0 - 7 * 86400000) return '近 7 天';
    return '更早';
  }

  function modelIcon(entry) {
    const id = entry && (entry.model || (entry.meta && entry.meta.model));
    const m = id ? D.model(id) : null;
    const p = m && m.provider_id ? D.provider(m.provider_id) : null;
    if (p) return `<div class="msg__avatar msg__avatar--provider" data-tip="${esc(p.name)}">${providerIcon(p.icon, 18)}</div>`;
    return `<div class="msg__avatar">🐱</div>`;
  }

  // ---------- 视图骨架 ----------
  function render(root) {
    const convCollapsed = read(K.conv, false);
    const sideCollapsed = read(K.side, false);
    root.classList.add('gview', 'gview--fill');
    root.innerHTML = `
      <div class="home-chat${convCollapsed ? ' is-conv-collapsed' : ''}${sideCollapsed ? ' is-side-collapsed' : ''}" id="home-chat">
        <aside class="hc-conv">
          <div class="hc-conv__head">
            <button class="btn btn--primary btn--sm" id="hc-new">${icon('plus', 14)}开启新对话</button>
            <button class="btn btn--ghost btn--icon btn--sm" id="hc-collapse" title="收起对话列表">${icon('panelLeft', 15)}</button>
          </div>
          <div class="hc-conv__tools">
            <div class="search">
              <span class="search__icon">${icon('search', 13)}</span>
              <input class="input" id="hc-search" placeholder="搜索对话…">
            </div>
          </div>
          <div class="hc-conv__list" id="hc-conv-list"></div>
          <div class="hc-conv__foot" id="hc-conv-foot"></div>
        </aside>

        <main class="hc-main">
          <div class="hc-main__top">
            <button class="btn btn--ghost btn--icon btn--sm" id="hc-show-conv" title="展开对话列表" hidden>${icon('panelLeft', 15)}</button>
            <span class="hc-main__title" id="hc-title">新对话</span>
            <span class="badge badge--gray" id="hc-msg-count">0 条</span>
            <div class="hc-main__top-actions">
              <button class="btn btn--ghost btn--icon btn--sm" id="hc-show-side" title="展开模型配置" hidden>${icon('sliders', 15)}</button>
            </div>
          </div>
          <div class="chat-main" id="hc-chat-main">
            <div class="chat-log-wrap">
              <div class="chat-log" id="hc-log"></div>
            </div>
            <div class="chat-hello" id="hc-hello">
              你好，有什么我可以帮你的？
              <div class="chat-hello__sub">先在右边选个模型，就可以开始聊天啦</div>
            </div>
            <button class="btn btn--sm hc-scroll-down" id="hc-to-bottom" title="回到底部">${icon('down', 13)}回到底部</button>
            <div class="hc-composer">
              <div class="chat-input">
                <div class="chat-attachments" id="hc-attach-list" hidden></div>
                <textarea class="chat-input__text" id="hc-text" rows="1" placeholder="快使用我吧♡"></textarea>
                <div class="chat-input__bar">
                  <div class="chat-input__chips">
                    <select class="chat-chip chat-chip--model" id="hc-model" aria-label="选择模型"></select>
                    <span class="chat-chip chat-chip--custom" id="hc-chip-custom" hidden ${`data-tip="已开启自定义请求体，请求体在右侧编辑"`}>${icon('code', 13)}自定义请求体</span>
                    <span class="chat-chip" id="hc-chip-stream">${switchEl(read(K.stream, true), '流式')}</span>
                  </div>
                  <div class="chat-input__acts">
                    <button class="btn btn--ghost btn--icon btn--sm" id="hc-attach" title="添加附件">${icon('paperclip', 15)}</button>
                    <button class="btn btn--ghost btn--icon btn--sm" id="hc-image" title="添加图片">${icon('image', 15)}</button>
                    <button class="btn btn--primary btn--icon" id="hc-send" title="发送">${icon('send', 15)}</button>
                  </div>
                </div>
              </div>
              <div class="hc-tip">模型会按顺序重试路由；按 Enter 发送，Shift + Enter 换行</div>
            </div>
          </div>
        </main>

        <aside class="hc-side">
          <div class="hc-side__head" style="display:flex;align-items:center;gap:8px;padding:2px 2px 8px">
            <span style="font-size:12px;font-weight:800">模型配置</span>
            <button class="btn btn--ghost btn--icon btn--sm" id="hc-hide-side" title="收起模型配置" style="margin-left:auto">${icon('panelRight', 15)}</button>
          </div>
          <div class="hc-side__inner">
            <div class="hc-side__sec">
              <div class="hc-side__label">模型</div>
              <select class="select" id="hc-side-model"></select>
              <div class="hc-model-meta" id="hc-model-meta"></div>
              <div id="hc-test-panel" hidden></div>
            </div>
            <div class="hc-side__sec">
              <div class="hc-side__label">生成</div>
              <label class="switch">${''}
                <input type="checkbox" id="hc-stream" ${read(K.stream, true) ? 'checked' : ''}>
                <span class="switch__track"></span>
                <span class="switch__label">流式输出</span>
              </label>
              <label class="switch">
                <input type="checkbox" id="hc-tools" ${read(K.tools, false) ? 'checked' : ''}>
                <span class="switch__track"></span>
                <span class="switch__label">工具调用</span>
              </label>
              <label class="switch" data-tip="开启后自己写完整请求体，模型与参数由 JSON 决定">
                <input type="checkbox" id="hc-custom" ${read(K.custom, false) ? 'checked' : ''}>
                <span class="switch__track"></span>
                <span class="switch__label">自定义请求体</span>
              </label>
            </div>
            <div class="hc-side__sec" id="hc-params">
              <div class="hc-side__label">
                采样参数
                <button class="btn btn--ghost btn--sm" id="hc-params-reset" style="height:20px;padding:0 6px;font-size:10.5px;margin-left:auto">重置</button>
              </div>
              <div id="hc-param-list"></div>
            </div>
            <div class="hc-side__sec" id="hc-custom-panel" hidden>
              <div class="hc-side__label">自定义请求体</div>
              <div class="input-group" style="gap:5px">
                <button class="btn btn--sm" id="hc-json-format">${icon('code', 12)}格式化</button>
                <button class="btn btn--sm" id="hc-json-reset">${icon('refresh', 12)}重置</button>
              </div>
              <textarea class="textarea" id="hc-json" rows="9" spellcheck="false"></textarea>
              <div class="field__hint" id="hc-json-hint"></div>
            </div>
          </div>
          <div class="hc-side__foot">
            <button class="btn btn--sm btn--block" id="hc-clear">${icon('trash', 12)}清空对话</button>
          </div>
        </aside>
      </div>`;

    ui = {
      chat: root.querySelector('#home-chat'),
      convList: root.querySelector('#hc-conv-list'),
      convFoot: root.querySelector('#hc-conv-foot'),
      search: root.querySelector('#hc-search'),
      log: root.querySelector('#hc-log'),
      main: root.querySelector('#hc-chat-main'),
      hello: root.querySelector('#hc-hello'),
      text: root.querySelector('#hc-text'),
      send: root.querySelector('#hc-send'),
      modelSel: root.querySelector('#hc-model'),
      sideModel: root.querySelector('#hc-side-model'),
      modelMeta: root.querySelector('#hc-model-meta'),
      testPanel: root.querySelector('#hc-test-panel'),
      title: root.querySelector('#hc-title'),
      msgCount: root.querySelector('#hc-msg-count'),
      attachList: root.querySelector('#hc-attach-list'),
      paramsHost: root.querySelector('#hc-param-list'),
      json: root.querySelector('#hc-json'),
      customPanel: root.querySelector('#hc-custom-panel'),
      toBottom: root.querySelector('#hc-to-bottom'),
    };

    ui.tempAttachments = [];

    renderModelSelects();
    renderParams();
    bind();
    renderConv();
    renderMessages();
    syncCustomMode();
    updateCollapseUi();
    updateJsonPanel();
  }

  function modelOptionsHtml() {
    const list = availableModels();
    const custom = list.filter((m) => m.type === 'custom');
    const channel = list.filter((m) => m.type !== 'custom');
    const opt = (m) => `<option value="${esc(m.id)}">${esc(m.id)}${m.display_name ? ` · ${esc(m.display_name)}` : ''}</option>`;
    let html = '';
    if (custom.length) html += `<optgroup label="自定义模型（多路由）">${custom.map(opt).join('')}</optgroup>`;
    if (channel.length) html += `<optgroup label="渠道模型">${channel.map(opt).join('')}</optgroup>`;
    html += '<optgroup label="调试"><option value="__test__">临时测试（直连上游）</option></optgroup>';
    return html;
  }

  function renderModelSelects() {
    const s = current();
    const html = modelOptionsHtml();
    ui.modelSel.innerHTML = html;
    ui.sideModel.innerHTML = html;
    const model = s.model || (availableModels()[0] || {}).id || '__test__';
    ui.modelSel.value = model;
    ui.sideModel.value = model;
    renderModelMeta();
  }

  function renderModelMeta() {
    const s = current();
    const id = s.model;
    const m = D.model(id);
    if (id === '__test__') {
      ui.modelMeta.hidden = true;
      ui.testPanel.hidden = false;
      renderTestPanel();
      return;
    }
    ui.testPanel.hidden = true;
    ui.modelMeta.hidden = false;
    const p = m && m.provider_id ? D.provider(m.provider_id) : null;
    const bits = [];
    if (p) bits.push(`<span class="provider-tag">${providerIcon(p.icon, 13)}${esc(p.name)}</span>`);
    if (!m) {
      ui.modelMeta.innerHTML = '模型管理中已没有这个模型，请重新选择';
      return;
    }
    if (m.type === 'custom') {
      bits.push(`<span class="badge badge--wood">自定义</span>`);
      bits.push(`<div style="margin-top:4px">路由：${(m.routes || []).length
        ? m.routes.map((r) => `<code>${esc(r.channel_id + '/' + r.upstream)}</code>`).join(' → ')
        : '<span class="muted">未配置</span>'}</div>`);
    } else {
      const c = D.channel(m.channel_id);
      bits.push(`<span class="badge badge--blue">渠道</span>`);
      bits.push(`<div style="margin-top:4px">来源：<code>${esc(m.channel_id)}</code>${c ? `（${esc(c.name)}）` : ''}</div>`);
    }
    bits.push(`<div style="margin-top:4px">${window.PV.capBadges(m.caps, { showNeg: true }) || '<span class="muted">未设置能力参数</span>'}</div>`);
    ui.modelMeta.innerHTML = bits.join('');
  }

  function renderTestPanel() {
    const saved = read(K.test, { url: '', model: '' });
    ui.testPanel.innerHTML = `
      <div class="field" style="margin-bottom:8px">
        <label class="field__label">API 地址</label>
        <input class="input" id="hc-test-url" placeholder="API 地址，例如 https://api.openai.com/v1" value="${esc(saved.url || '')}">
      </div>
      <div class="field" style="margin-bottom:8px">
        <label class="field__label">API Key</label>
        <div class="input-group">
          <input class="input key-masked" id="hc-test-key" placeholder="API Key（本地模型可留空）" type="text">
          <button class="btn btn--icon btn--sm" id="hc-test-eye" title="显示 Key">${icon('eye', 13)}</button>
        </div>
      </div>
      <div class="field" style="margin-bottom:8px">
        <label class="field__label">模型 ID</label>
        <div class="input-group">
          <input class="input" id="hc-test-model" placeholder="模型 ID" value="${esc(saved.model || '')}">
          <button class="btn btn--sm" id="hc-test-fetch">获取模型</button>
        </div>
        <div class="field__hint" id="hc-test-hint">直接连上游，不经过渠道和模型配置，也不写入调用日志。</div>
      </div>
      <select class="select" id="hc-test-list" hidden></select>`;
    const url = ui.testPanel.querySelector('#hc-test-url');
    const model = ui.testPanel.querySelector('#hc-test-model');
    const key = ui.testPanel.querySelector('#hc-test-key');
    key.value = sessionStorage.getItem(K.test + '.key') || '';
    const persist = () => write(K.test, { url: url.value.trim(), model: model.value.trim() });
    url.addEventListener('change', persist);
    model.addEventListener('change', persist);
    key.addEventListener('input', () => {
      try { sessionStorage.setItem(K.test + '.key', key.value); } catch (e) { /* ignore */ }
    });
    ui.testPanel.querySelector('#hc-test-eye').onclick = (e) => {
      key.classList.toggle('key-masked');
      e.currentTarget.innerHTML = icon(key.classList.contains('key-masked') ? 'eye' : 'eyeOff', 13);
    };
    const hint = ui.testPanel.querySelector('#hc-test-hint');
    ui.testPanel.querySelector('#hc-test-fetch').onclick = async (e) => {
      const btn = e.currentTarget;
      if (!url.value.trim()) { Toast.warn('请填写临时测试的 API 地址'); url.focus(); return; }
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner" style="width:11px;height:11px"></span>';
      try {
        const res = await D.discover('ch-main');
        const sel = ui.testPanel.querySelector('#hc-test-list');
        sel.hidden = false;
        sel.innerHTML = res.models.map((m) => `<option>${esc(m)}</option>`).join('');
        sel.onchange = () => {
          model.value = sel.value;
          persist();
        };
        hint.textContent = `上游返回 ${res.models.length} 个模型 · ${res.latency_ms}ms`;
        Toast.success(`上游返回 ${res.models.length} 个模型`);
      } catch (err) {
        hint.textContent = '获取失败：' + err.message;
      }
      btn.disabled = false;
      btn.textContent = '获取模型';
    };
  }

  // ---------- 会话列表 ----------
  function renderConv() {
    const kw = (ui.search.value || '').trim().toLowerCase();
    const groups = new Map();
    sessions
      .filter((s) => !kw || titleOf(s).toLowerCase().includes(kw))
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .forEach((s) => {
        const g = groupOf(s.updatedAt);
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(s);
      });

    if (!sessions.length) {
      ui.convList.innerHTML = '<div class="col-empty">还没有对话</div>';
    } else if (!groups.size) {
      ui.convList.innerHTML = '<div class="col-empty">没有匹配的对话</div>';
    } else {
      ui.convList.innerHTML = [...groups.entries()].map(([g, list]) => `
        <div class="hc-group">${esc(g)}</div>
        ${list.map((s) => `
          <div class="hc-conv-item${s.id === activeId ? ' is-active' : ''}" data-sid="${esc(s.id)}">
            ${icon('chat', 14)}
            <span class="hc-conv-item__title">${esc(titleOf(s))}</span>
            <button class="hc-conv-item__del" data-del="${esc(s.id)}" title="删除对话" aria-label="删除对话">${icon('trash', 12)}</button>
          </div>`).join('')}
      `).join('');
    }
    ui.convFoot.textContent = `共 ${sessions.length} 个对话 · 仅保存在本机浏览器`;

    ui.convList.querySelectorAll('[data-sid]').forEach((row) => {
      row.onclick = (e) => {
        if (e.target.closest('[data-del]')) return;
        if (run) { Toast.info('正在生成中，等这一条回复结束再切换对话'); return; }
        activeId = row.dataset.sid;
        saveStore();
        renderConv();
        renderMessages();
        renderModelSelects();
        ui.search.value = '';
        updateJsonPanel();
      };
    });
    ui.convList.querySelectorAll('[data-del]').forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        if (run) { Toast.info('正在生成中，等这一条回复结束再删除对话'); return; }
        const id = btn.dataset.del;
        const s = sessions.find((x) => x.id === id);
        const ok = await confirmDialog({ title: '删除对话', message: `确定删除「${esc(titleOf(s))}」吗？`, confirmText: '删除', danger: true });
        if (!ok) return;
        sessions = sessions.filter((x) => x.id !== id);
        if (!sessions.length) sessions = [newSession(current().model)];
        if (!sessions.some((x) => x.id === activeId)) activeId = sessions[0].id;
        saveStore();
        renderConv();
        renderMessages();
      };
    });
  }

  // ---------- 消息 ----------
  function actionsHtml(idx, entry) {
    const acts = [];
    if (entry.role === 'user') {
      acts.push(`<button class="btn btn--ghost btn--icon" data-act="retry" title="重新发送">${icon('refresh', 12)}</button>`);
      acts.push(`<button class="btn btn--ghost btn--icon" data-act="copy" title="复制">${icon('copy', 12)}</button>`);
      acts.push(`<button class="btn btn--ghost btn--icon" data-act="del" title="删除">${icon('trash', 12)}</button>`);
    } else {
      acts.push(`<button class="btn btn--ghost btn--icon" data-act="retry" title="重新生成">${icon('refresh', 12)}</button>`);
      acts.push(`<button class="btn btn--ghost btn--icon" data-act="copy" title="复制回复">${icon('copy', 12)}</button>`);
      acts.push(`<button class="btn btn--ghost btn--icon" data-act="md" title="切换原文 / 渲染">${icon('code', 12)}</button>`);
      acts.push(`<button class="btn btn--ghost btn--icon" data-act="del" title="删除">${icon('trash', 12)}</button>`);
    }
    return `<div class="msg__actions">${acts.join('')}</div>`;
  }

  function metaHtml(m) {
    if (!m.meta) return '';
    const groups = [];
    if (m.meta.model) groups.push([`模型 ${esc(m.meta.model)}`]);
    if (m.meta.input) groups.push([`输入 ${fmtInt(m.meta.input)}`]);
    if (m.meta.output) groups.push([`输出 ${fmtInt(m.meta.output)}`]);
    if (m.meta.reasoning) groups.push([`思考 ${fmtInt(m.meta.reasoning)}`]);
    if (m.meta.tps) groups.push([`${m.meta.tps.toFixed(1)} t/s`]);
    if (m.meta.tools) groups.push([`工具调用 ${m.meta.tools} 次`]);
    if (m.meta.firstByte) groups.push([`首字 ${fmtDuration(m.meta.firstByte)}`]);
    if (m.meta.latency) groups.push([`总耗时 ${fmtDuration(m.meta.latency)}`]);
    if (m.meta.total) groups.push([`总 token ${fmtInt(m.meta.total)}`]);
    if (m.meta.stopped) groups.push(['已停止生成']);
    return `<div class="msg__meta">${groups.map((g) => `<span class="msg__meta-group">${g.join(' · ')}</span>`).join('')}</div>`;
  }

  function userText(m) {
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    return '';
  }

  function userAttachHtml(m) {
    if (!Array.isArray(m.display)) return '';
    const imgs = m.display.filter((p) => p.type === 'image_url');
    const files = m.display.filter((p) => p.type === 'attachment');
    return imgs.map((p) => `<img class="msg__image" src="${esc(p.image_url.url)}" alt="图片">`).join('')
      + files.map((p) => `<span class="msg__file">${icon('file', 13)}<span class="msg__file-name">${esc(p.attachment.name)}</span><span class="msg__file-meta">${window.PV.fmtMem(p.attachment.size || 0)}</span></span>`).join('');
  }

  function renderMessages() {
    const s = current();
    ui.title.textContent = titleOf(s);
    ui.msgCount.textContent = `${s.messages.length} 条`;
    ui.main.classList.toggle('is-empty', !s.messages.length);
    ui.hello.innerHTML = `你好，有什么我可以帮你的？<div class="chat-hello__sub">${s.model === '__test__' ? '临时测试模式：直接连接上游，不写调用日志' : '先在右边选个模型，就可以开始聊天啦'}</div>`;
    ui.log.innerHTML = s.messages.map((m, i) => messageHtml(m, i)).join('');
    bindMessageActions();
    scrollToBottom(true);
  }

  function messageHtml(m, idx) {
    const isUser = m.role === 'user';
    const avatar = isUser
      ? `<div class="msg__avatar msg__avatar--logo"><img src="../web/assets/logo.jpg" alt=""></div>`
      : modelIcon(m);
    const bubbleCls = 'msg__bubble' + (m.error ? ' msg__bubble--error' : '');
    const body = isUser
      ? `<div class="msg__answer" style="white-space:pre-wrap">${esc(userText(m))}</div>${userAttachHtml(m)}`
      : `${m.think ? thinkHtml(m.think, false) : ''}
         <div class="msg__answer msg__answer--md" data-raw="${esc(m.raw || m.content || '')}">${m.content ? window.LDMMD.render(m.content) : ''}</div>
         ${m.error ? `<div class="msg__error-text">${esc(m.error)}</div>` : ''}`;
    return `<div class="msg${isUser ? ' msg--user' : ''}${m.error ? ' msg--error' : ''}" data-idx="${idx}">
      ${avatar}
      <div class="msg__body">
        <div class="${bubbleCls}">${body}</div>
        ${isUser ? '' : metaHtml(m)}
        ${actionsHtml(idx, m)}
      </div>
    </div>`;
  }

  function thinkHtml(text, open) {
    return `<details class="think-block"${open ? ' open' : ''}><summary>深度思考<span class="think-block__meta"> ${text.length} 字</span></summary><div class="think-block__body">${esc(text)}</div></details>`;
  }

  function bindMessageActions() {
    const s = current();
    ui.log.querySelectorAll('.msg__actions [data-act]').forEach((btn) => {
      btn.onclick = async () => {
        if (run) { Toast.info('正在生成中，等这一条回复结束再操作'); return; }
        const msgEl = btn.closest('.msg');
        const idx = Number(msgEl.dataset.idx);
        const m = s.messages[idx];
        const act = btn.dataset.act;
        if (act === 'copy') {
          copyText(m.role === 'user' ? userText(m) : (m.error ? `${m.content}\n${m.error}` : m.content), m.role === 'user' ? '消息内容' : '回复内容');
        } else if (act === 'del') {
          s.messages.splice(idx, 1);
          s.updatedAt = Date.now();
          saveStore();
          renderConv();
          renderMessages();
        } else if (act === 'md') {
          const answer = msgEl.querySelector('.msg__answer--md');
          if (!answer) return;
          const raw = answer.dataset.raw || '';
          const showingRaw = answer.dataset.mode === 'raw';
          if (showingRaw) {
            answer.innerHTML = window.LDMMD.render(raw);
            answer.dataset.mode = '';
            answer.style.whiteSpace = '';
          } else {
            answer.textContent = raw;
            answer.dataset.mode = 'raw';
            answer.style.whiteSpace = 'pre-wrap';
          }
        } else if (act === 'retry') {
          if (m.role === 'user') {
            const rest = s.messages.slice(0, idx + 1);
            s.messages = rest;
            s.updatedAt = Date.now();
            saveStore();
            renderMessages();
            send();
          } else {
            s.messages = s.messages.slice(0, idx);
            s.updatedAt = Date.now();
            saveStore();
            renderMessages();
            send();
          }
        }
      };
    });

    // 代码块复制
    ui.log.querySelectorAll('[data-md-copy]').forEach((btn) => {
      btn.onclick = () => {
        const code = btn.closest('.md-code')?.querySelector('pre code');
        if (code) copyText(code.textContent, '代码');
      };
    });
  }

  // ---------- 参数 ----------
  function renderParams() {
    ui.paramsHost.innerHTML = PARAM_DEFS.map((p) => {
      const val = params.values[p.key];
      const on = params.enabled[p.key];
      const ctl = p.type === 'range'
        ? `<div class="hc-range-row">
             <input type="range" data-pk="${p.key}" min="${p.min}" max="${p.max}" step="${p.step}" value="${esc(val)}">
             <span class="hc-param__value" data-pv="${p.key}">${esc(p.fmt(val))}</span>
           </div>`
        : `<input class="input input--sm" type="number" data-pk="${p.key}" min="${p.min == null ? '' : p.min}" step="${p.step || 1}" value="${esc(val)}" placeholder="留空则随机">`;
      return `<div class="hc-param${on ? '' : ' is-off'}" data-param="${p.key}">
        <div class="hc-param__head">
          <label class="switch">
            <input type="checkbox" data-pen="${p.key}" ${on ? 'checked' : ''}>
            <span class="switch__track" style="width:28px;height:17px"></span>
            <span class="hc-param__name">${esc(p.label)}</span>
          </label>
        </div>
        ${ctl}
      </div>`;
    }).join('');

    ui.paramsHost.querySelectorAll('[data-pk]').forEach((input) => {
      const key = input.dataset.pk;
      const sync = () => {
        const p = PARAM_DEFS.find((x) => x.key === key);
        const v = p.type === 'range' ? Number(input.value) : (input.value === '' ? '' : Number(input.value));
        params.values[key] = v;
        const label = ui.paramsHost.querySelector(`[data-pv="${key}"]`);
        if (label) label.textContent = p.fmt(v);
        write(K.params, params);
        updateJsonPanel();
      };
      input.addEventListener('input', sync);
      input.addEventListener('change', sync);
    });
    ui.paramsHost.querySelectorAll('[data-pen]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const key = cb.dataset.pen;
        params.enabled[key] = cb.checked;
        cb.closest('.hc-param').classList.toggle('is-off', !cb.checked);
        write(K.params, params);
        updateJsonPanel();
      });
    });
  }

  function collectParams() {
    const out = {};
    PARAM_DEFS.forEach((p) => {
      if (!params.enabled[p.key]) return;
      const v = params.values[p.key];
      if (v === '' || v == null) return;
      const n = Number(v);
      if (Number.isFinite(n)) out[p.key] = n;
    });
    return out;
  }

  // ---------- 自定义请求体 ----------
  function buildPayload() {
    const s = current();
    const streaming = read(K.stream, true) && document.getElementById('hc-stream')?.checked !== false;
    const messages = s.messages
      .filter((m) => m.role === 'user' || (m.role === 'assistant' && !m.error))
      .map((m) => ({ role: m.role, content: m.role === 'user' ? (Array.isArray(m.content) ? m.content : userText(m)) : m.content }));
    return Object.assign({ model: s.model, messages, stream: streaming }, collectParams());
  }

  function updateJsonPanel() {
    if (!ui || !read(K.custom, false)) return;
    if (ui.json.dataset.dirty === '1') return;
    ui.json.value = JSON.stringify(buildPayload(), null, 2);
    validateJson();
  }

  function validateJson() {
    const hint = document.getElementById('hc-json-hint');
    if (!hint) return;
    try {
      const data = JSON.parse(ui.json.value);
      if (!data || typeof data !== 'object') throw new Error('必须是 JSON 对象');
      if (typeof data.model !== 'string' || !data.model) throw new Error('缺少 model 字段');
      if (!Array.isArray(data.messages)) throw new Error('缺少 messages 数组');
      hint.style.color = '';
      hint.textContent = `模型 ${data.model} · ${data.stream ? '流式' : '非流式'} · ${data.messages.length} 条消息`;
      return data;
    } catch (e) {
      hint.style.color = 'var(--mushroom-500)';
      hint.textContent = 'JSON 格式错误：' + e.message;
      return null;
    }
  }

  function syncCustomMode() {
    const on = read(K.custom, false);
    ui.customPanel.hidden = !on;
    ui.modelSel.disabled = on;
    document.getElementById('hc-side-model').disabled = on;
    document.querySelector('#hc-chip-stream .switch input').disabled = on;
    document.getElementById('hc-tools').disabled = on;
    document.getElementById('hc-chip-custom').hidden = !on;
    document.getElementById('hc-param-list').style.opacity = on ? '.45' : '';
    document.getElementById('hc-param-list').style.pointerEvents = on ? 'none' : '';
    if (on) updateJsonPanel();
  }

  // ---------- 绑定 ----------
  function bind() {
    const s = () => current();

    ui.search.addEventListener('input', debounce(renderConv, 120));

    document.getElementById('hc-new').onclick = () => {
      if (run) { Toast.info('正在生成中，等这一条回复结束再新建'); return; }
      if (!s().messages.length) { ui.text.focus(); return; }
      const ns = newSession(s().model);
      sessions.unshift(ns);
      activeId = ns.id;
      saveStore();
      renderConv();
      renderMessages();
      renderModelSelects();
      ui.text.focus();
    };

    const collapse = (key, el, on) => {
      const cur = read(key, false);
      write(key, !cur);
      el.classList.toggle(on, !cur);
      updateCollapseUi();
    };
    document.getElementById('hc-collapse').onclick = () => collapse(K.conv, ui.chat, 'is-conv-collapsed');
    document.getElementById('hc-hide-side').onclick = () => collapse(K.side, ui.chat, 'is-side-collapsed');
    document.getElementById('hc-show-conv').onclick = () => {
      ui.chat.classList.remove('is-conv-collapsed');
      write(K.conv, false);
      updateCollapseUi();
    };
    document.getElementById('hc-show-side').onclick = () => {
      ui.chat.classList.remove('is-side-collapsed');
      write(K.side, false);
      updateCollapseUi();
    };

    const onModelChange = (value) => {
      const cur = s();
      cur.model = value;
      write(K.model, value);
      cur.updatedAt = Date.now();
      saveStore();
      renderModelSelects();
      updateJsonPanel();
      renderMessages();
    };
    ui.modelSel.onchange = () => onModelChange(ui.modelSel.value);
    ui.sideModel.onchange = () => onModelChange(ui.sideModel.value);

    const bindSwitch = (id, key, cb) => {
      const el = document.getElementById(id);
      el.addEventListener('change', () => {
        write(key, el.checked);
        if (cb) cb(el.checked);
      });
    };
    bindSwitch('hc-stream', K.stream, (on) => {
      const chip = document.querySelector('#hc-chip-stream .switch input');
      if (chip) chip.checked = on;
      updateJsonPanel();
    });
    document.querySelector('#hc-chip-stream .switch input').addEventListener('change', (e) => {
      write(K.stream, e.target.checked);
      document.getElementById('hc-stream').checked = e.target.checked;
      e.stopPropagation();
      updateJsonPanel();
    });
    bindSwitch('hc-tools', K.tools);
    bindSwitch('hc-custom', K.custom, () => {
      syncCustomMode();
      Toast.info(read(K.custom, false) ? '已开启自定义请求体，右侧可直接编辑 JSON' : '已关闭自定义请求体');
    });

    document.getElementById('hc-params-reset').onclick = () => {
      params = defaultParams();
      write(K.params, params);
      renderParams();
      updateJsonPanel();
      Toast.success('参数已恢复默认');
    };

    document.getElementById('hc-json-format').onclick = () => {
      try {
        ui.json.value = JSON.stringify(JSON.parse(ui.json.value), null, 2);
        ui.json.dataset.dirty = '0';
        validateJson();
        Toast.success('已格式化 JSON');
      } catch (e) {
        Toast.error(e.message, 'JSON 格式有误');
      }
    };
    document.getElementById('hc-json-reset').onclick = () => {
      ui.json.dataset.dirty = '0';
      updateJsonPanel();
    };
    ui.json.addEventListener('input', () => {
      ui.json.dataset.dirty = '1';
      validateJson();
    });

    document.getElementById('hc-clear').onclick = () => {
      if (run) stopRun();
      const cur = s();
      cur.messages = [];
      cur.updatedAt = Date.now();
      saveStore();
      renderConv();
      renderMessages();
      Toast.success('已清空对话');
    };

    ui.text.addEventListener('input', () => {
      ui.text.style.height = 'auto';
      ui.text.style.height = Math.min(150, ui.text.scrollHeight) + 'px';
    });
    ui.text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });
    ui.send.onclick = () => (run ? stopRun() : send());

    // 附件
    document.getElementById('hc-attach').onclick = () => pickFiles(false);
    document.getElementById('hc-image').onclick = () => pickFiles(true);

    ui.log.addEventListener('scroll', () => {
      const nearBottom = ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight < 120;
      ui.toBottom.classList.toggle('is-on', !nearBottom);
    });
    ui.toBottom.onclick = () => scrollToBottom();
  }

  function updateCollapseUi() {
    const convCollapsed = ui.chat.classList.contains('is-conv-collapsed');
    const sideCollapsed = ui.chat.classList.contains('is-side-collapsed');
    document.getElementById('hc-show-conv').hidden = !convCollapsed;
    document.getElementById('hc-show-side').hidden = !sideCollapsed;
  }

  function scrollToBottom(instant) {
    if (!ui) return;
    requestAnimationFrame(() => {
      ui.log.scrollTo({ top: ui.log.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
      ui.toBottom.classList.remove('is-on');
    });
  }

  // ---------- 附件 ----------
  function pickFiles(imagesOnly) {
    if (read(K.custom, false)) { Toast.warn('自定义请求体模式下不能添加图片或附件'); return; }
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (imagesOnly) input.accept = 'image/*';
    input.onchange = () => {
      [...input.files].forEach((f) => {
        if (f.size > 20 * 1024 * 1024) { Toast.error(`${f.name} 超过 20MB`); return; }
        const item = { name: f.name, size: f.size, mime: f.type || 'application/octet-stream', file: f };
        if (f.type.startsWith('image/')) {
          const reader = new FileReader();
          reader.onload = () => {
            item.dataUrl = reader.result;
            ui.tempAttachments.push(item);
            renderAttachChips();
          };
          reader.readAsDataURL(f);
        } else if (f.type.startsWith('text/') || /\.(txt|md|csv|json|ya?ml|html|js|ts|py|go|java)$/i.test(f.name)) {
          const reader = new FileReader();
          reader.onload = () => {
            item.text = String(reader.result).slice(0, 200000);
            ui.tempAttachments.push(item);
            renderAttachChips();
          };
          reader.readAsText(f);
        } else {
          Toast.warn(`${f.name} 不是文本或图片，预览里只展示文件名`);
          ui.tempAttachments.push(item);
          renderAttachChips();
        }
      });
    };
    input.click();
  }

  function renderAttachChips() {
    const list = ui.tempAttachments;
    ui.attachList.hidden = !list.length;
    ui.attachList.innerHTML = list.map((a, i) => `
      <span class="badge badge--gray" style="gap:5px;padding:3px 7px">
        ${a.mime.startsWith('image/') ? icon('image', 11) : icon('file', 11)}
        ${esc(a.name)}
        <button class="mini-act" data-rm-att="${i}" style="width:16px;height:16px" title="移除">${icon('x', 10)}</button>
      </span>`).join('');
    ui.attachList.querySelectorAll('[data-rm-att]').forEach((b) => {
      b.onclick = () => {
        list.splice(Number(b.dataset.rmAtt), 1);
        renderAttachChips();
      };
    });
  }

  function buildUserContent(text, attachments) {
    if (!attachments.length) return text;
    const content = [];
    if (text) content.push({ type: 'text', text });
    const display = [];
    attachments.forEach((a) => {
      if (a.mime.startsWith('image/') && a.dataUrl) {
        content.push({ type: 'image_url', image_url: { url: a.dataUrl } });
        display.push({ type: 'image_url', image_url: { url: a.dataUrl } });
      } else if (a.text != null) {
        content.push({ type: 'text', text: `【附件：${a.name}】\n${a.text}` });
        display.push({ type: 'attachment', attachment: { kind: 'text', name: a.name, mime: a.mime, size: a.size } });
      } else {
        content.push({ type: 'text', text: `【附件：${a.name}】` });
        display.push({ type: 'attachment', attachment: { kind: 'binary', name: a.name, mime: a.mime, size: a.size } });
      }
    });
    return { content, display };
  }

  // ---------- 发送 ----------
  function send() {
    if (run) return;
    const s = current();
    const text = ui.text.value.trim();
    const attachments = ui.tempAttachments || [];
    if (!text && !attachments.length) { ui.text.focus(); return; }

    const custom = read(K.custom, false);
    let rawPayload = null;
    if (custom) {
      rawPayload = validateJson();
      if (!rawPayload) { Toast.error('自定义请求体模式下请先修正 JSON'); return; }
    } else if (s.model === '__test__') {
      const url = document.getElementById('hc-test-url');
      const modelInput = document.getElementById('hc-test-model');
      if (!url || !url.value.trim()) { Toast.warn('请填写临时测试的 API 地址'); url && url.focus(); return; }
      if (!modelInput.value.trim()) { Toast.warn('请填写临时测试的模型 ID'); modelInput.focus(); return; }
    }

    let entry;
    if (attachments.length) {
      const built = buildUserContent(text, attachments);
      entry = { role: 'user', content: built.content, display: built.display };
    } else {
      entry = { role: 'user', content: text };
    }
    s.messages.push(entry);
    s.updatedAt = Date.now();
    ui.text.value = '';
    ui.text.style.height = 'auto';
    ui.tempAttachments = [];
    renderAttachChips();
    saveStore();
    renderConv();
    renderMessages();

    startReply(s, rawPayload);
  }

  function stopRun() {
    if (!run) return;
    run.aborted = true;
    clearTimeout(run.timer);
    const { entry } = run;
    entry.meta = entry.meta || {};
    entry.meta.stopped = true;
    if (!entry.content) {
      entry.content = '（已停止生成）';
      entry.notice = true;
    }
    run = null;
    saveStore();
    renderConv();
    renderMessages();
    setSending(false);
  }

  function setSending(on) {
    ui.send.innerHTML = on ? icon('stop', 15) : icon('send', 15);
    ui.send.classList.toggle('btn--danger', on);
    ui.send.classList.toggle('btn--primary', !on);
    ui.send.title = on ? '停止生成' : '发送';
    ui.text.disabled = on;
  }

  // ---------- 本地模拟回复 ----------
  const CANNED = [
    {
      think: '用户想要一个可以直接跑的示例。先确认接口协议：网关兼容 OpenAI /v1/chat/completions，鉴权走 Bearer。再给一个最小 Python 示例，最后补上流式和错误处理。',
      text: `网关兼容 OpenAI 协议，换掉 \`base_url\` 和 \`api_key\` 就能直接用。

## Python 最小示例

\`\`\`python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8080/v1",
    api_key="sk-ldm-你的密钥",
)

resp = client.chat.completions.create(
    model="LDM",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
\`\`\`

## 常用参数

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| \`temperature\` | 越大越发散 | 0.7 |
| \`max_tokens\` | 最大输出 | 模型默认 |
| \`stream\` | 是否流式 | false |

> 模型名用「模型管理」里的自定义模型 ID；路由、重试、冷却都由网关处理，客户端不用感知。

需要 curl 版本或者流式解析的示例吗？`,
    },
  ];

  function buildReply(prompt, modelId) {
    const low = String(prompt || '').toLowerCase();
    const m = D.model(modelId);
    const canThink = m && m.caps && m.caps.thinking === true;

    if (/几点|时间|现在.*(时间|日期)/.test(prompt)) {
      return {
        think: canThink ? '这是一个需要实时信息的问题，先调用 get_current_time，再把结果整理成自然语言。' : '',
        tool: true,
        text: `现在是 **${new Date().toLocaleString('zh-CN', { hour12: false })}**（服务器本地时间）。\n\n如果你需要别的时区，把时区名告诉我，比如 \`Asia/Tokyo\`、\`America/New_York\`。`,
      };
    }
    if (/你好|hello|hi/i.test(low) && prompt.length < 20) {
      return {
        think: '',
        text: '你好呀，我是接在这个网关后面的模型。可以问我代码、写作、翻译，或者让我帮你看看模型路由配置。',
      };
    }
    if (/路由|模型管理|LDM|重试|冷却/.test(prompt)) {
      return {
        think: canThink ? '问题涉及网关自己的路由逻辑。先说明自定义模型与渠道模型的关系，再解释分组、权重、亲和和冷却，最后给一个具体配置例子。' : '',
        text: `你问的是「模型管理」里的路由系统，可以拆成三层看：

### 1. 渠道模型
渠道里填的是**上游真实模型名**，例如 \`gpt-4o\`。接入模型管理后，它的 ID 是 \`渠道ID/上游模型名\`：

\`\`\`
ch-main/gpt-4o
ch-ds/deepseek-chat
\`\`\`

### 2. 自定义模型
对外只暴露一个名字（例如 \`LDM\`），内部按顺序挂多条路由：

\`\`\`json
{
  "id": "LDM",
  "routes": [
    { "channel_id": "ch-main", "upstream": "gpt-4o", "weight": 70, "group": 1 },
    { "channel_id": "ch-ds", "upstream": "deepseek-chat", "weight": 30, "group": 1 },
    { "channel_id": "ch-claude", "upstream": "claude-sonnet-4-5", "group": 2 }
  ]
}
\`\`\`

- **组内**按 \`weight\` 洗牌，70/30 就是大概七三开；
- **组间**严格按顺序故障转移，第 1 组全挂了才走第 2 组；
- \`group\` 为 0 的条目每条自成一组。

### 3. 运行时状态
| 状态 | 作用 |
| --- | --- |
| 模型亲和 | 上次成功的路由下次优先 |
| 失败冷却 | 失败后一段时间内跳过 |
| 全冷却重置 | 全部冷却时清空再试一轮 |

这些都在内存里，重启进程就清空；「清除冷却」也一样只影响当前进程。`,
      };
    }
    if (/代码|code|函数|python|js/i.test(low)) {
      return {
        think: canThink ? '用户要代码。给一个完整可运行的小例子，再解释关键点，避免堆砌无关内容。' : '',
        text: `给你一个可以直接跑的例子。

\`\`\`javascript
async function chat(prompt) {
  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-ldm-你的密钥',
    },
    body: JSON.stringify({
      model: 'LDM',
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  return data.choices[0].message.content;
}

chat('用一句话解释什么是网关').then(console.log);
\`\`\`

关键点：

1. \`model\` 填模型管理里看到的 ID，不要填上游真实模型名；
2. 网关会自己重试和切路由，客户端按普通 OpenAI 响应处理就行；
3. 需要流式就把 \`stream\` 设为 \`true\`，按 \`data:\` 行解析 SSE。`,
      };
    }
    if (/公式|math|数学|积分|方程/.test(low)) {
      return {
        think: '',
        text: `行内公式：$E = mc^2$，块级公式：

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}
$$

矩阵也可以：

$$
\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}
\\begin{pmatrix} x \\\\ y \\end{pmatrix}
=
\\begin{pmatrix} ax + by \\\\ cx + dy \\end{pmatrix}
$$`,
      };
    }
    if (/写|文案|总结|翻译/.test(prompt)) {
      return {
        think: canThink ? '先判断用户要的是润色还是从零撰写。这里给一个结构清晰的短文，留出可替换的占位。' : '',
        text: `可以，先按「一句话结论 + 三条理由 + 一个行动建议」的结构写：

**结论：** 把常用模型收进一个自定义路由，比在业务里写死渠道更稳。

1. 上游抖动时自动切换，客户端不用改代码；
2. 权重和分组把流量分配变成配置，而不是发版；
3. 冷却与亲和都在网关侧，排障时只看调用日志。

如果你把原文贴过来，我可以按你的语气再改一版。`,
      };
    }
    const canned = CANNED[Math.floor(Math.random() * CANNED.length)];
    return {
      think: canThink ? canned.think : '',
      text: canned.text,
    };
  }

  function startReply(session, rawPayload) {
    const userEntry = [...session.messages].reverse().find((m) => m.role === 'user');
    const prompt = userEntry ? userText(userEntry) : '';
    const reply = buildReply(prompt, session.model);
    const thinking = !!(reply.think && (D.model(session.model)?.caps?.thinking === true || session.model === '__test__'));
    const entry = {
      role: 'assistant',
      content: '',
      think: thinking ? '' : undefined,
      meta: { model: rawPayload ? rawPayload.model : (session.model === '__test__' ? document.getElementById('hc-test-model').value : session.model) },
      error: '',
    };
    session.messages.push(entry);
    session.updatedAt = Date.now();
    saveStore();
    renderConv();
    renderMessages();
    ui.main.classList.remove('is-empty');

    setSending(true);
    const started = performance.now();
    let firstByte = 0;
    let thinkText = thinking ? reply.think : '';
    let answer = reply.text;
    let i = 0;
    let j = 0;
    let phase = thinking ? 'think' : 'answer';
    let lastPaint = 0;

    const msgEl = ui.log.querySelector(`.msg[data-idx="${session.messages.length - 1}"]`);
    const bubble = msgEl.querySelector('.msg__bubble');
    let thinkDet = null;
    let thinkBody = null;
    let answerEl = null;
    let metaEl = null;

    if (thinking) {
      thinkDet = document.createElement('details');
      thinkDet.className = 'think-block';
      thinkDet.open = true;
      thinkDet.innerHTML = '<summary>深度思考<span class="think-block__meta"> 思考中…</span></summary><div class="think-block__body"></div>';
      thinkBody = thinkDet.querySelector('.think-block__body');
      bubble.innerHTML = '';
      bubble.appendChild(thinkDet);
    }

    const ensureAnswer = () => {
      if (answerEl) return;
      if (reply.tool) {
        // 工具调用块：与线上同一个 details 结构，先展开，正文开始后收起
        const det = document.createElement('details');
        det.className = 'tool-block';
        det.open = true;
        const nowText = new Date().toLocaleString('zh-CN', { hour12: false });
        det.innerHTML = '<summary>工具调用<span class="tool-block__meta"> 1 次 · 完成</span></summary>'
          + '<div class="tool-block__body"><div class="tool-call">'
          + '<div class="tool-call__head"><span class="tool-call__name">get_current_time</span><span class="tool-call__state">完成</span></div>'
          + '<div class="tool-call__row"><div class="tool-call__label">参数</div><pre class="tool-call__code">{"timezone":"Asia/Shanghai"}</pre></div>'
          + `<div class="tool-call__row"><div class="tool-call__label">结果</div><pre class="tool-call__code">${esc(nowText)}</pre></div>`
          + '</div></div>';
        bubble.appendChild(det);
        setTimeout(() => { det.open = false; }, 1400);
      }
      answerEl = document.createElement('div');
      answerEl.className = 'msg__answer msg__answer--md';
      bubble.appendChild(answerEl);
      entry.content = '';
    };

    const ensureMeta = () => {
      if (metaEl) return;
      metaEl = document.createElement('div');
      metaEl.className = 'msg__meta';
      msgEl.querySelector('.msg__body').insertBefore(metaEl, msgEl.querySelector('.msg__actions'));
    };

    const paintMeta = () => {
      const total = Math.round((entry.content || '').length / 3.2);
      const input = Math.round(prompt.length / 3.1) + 320;
      const elapsed = performance.now() - started;
      entry.meta.input = input;
      entry.meta.output = total;
      entry.meta.total = input + total;
      entry.meta.latency = elapsed;
      entry.meta.firstByte = firstByte || elapsed;
      entry.meta.reasoning = thinking ? Math.round(thinkText.length / 3.4) : 0;
      entry.meta.tps = total / Math.max(0.35, (elapsed - (firstByte || elapsed)) / 1000);
      entry.meta.tools = reply.tool ? 1 : 0;
      metaEl.innerHTML = metaHtml(entry);
    };

    const finish = (aborted) => {
      if (aborted) return;
      if (thinking && thinkDet && thinkBody) {
        thinkDet.querySelector('.think-block__meta').textContent = ` ${thinkText.length} 字 · ${((performance.now() - started) / 1000).toFixed(1)} 秒`;
        thinkDet.open = false;
      }
      if (answerEl) {
        answerEl.dataset.raw = entry.content;
        answerEl.innerHTML = window.LDMMD.render(entry.content);
        answerEl.querySelectorAll('[data-md-copy]').forEach((btn) => {
          btn.onclick = () => {
            const code = btn.closest('.md-code')?.querySelector('pre code');
            if (code) copyText(code.textContent, '代码');
          };
        });
      }
      ensureMeta();
      paintMeta();
      entry.streaming = false;
      run = null;
      setSending(false);
      saveStore();
      renderConv();
      if (reply.tool) Toast.success('已调用工具 get_current_time');
      scrollToBottom();
    };

    const tick = () => {
      if (!run || run.aborted) return;
      const now = performance.now();
      if (!firstByte) firstByte = now - started;

      if (phase === 'think') {
        thinkText.length;
        i += 4;
        const part = reply.think.slice(0, i);
        thinkBody.textContent = part;
        entry.think = part;
        if (i >= reply.think.length) {
          phase = 'answer';
          thinkDet.querySelector('.think-block__meta').textContent = ` ${reply.think.length} 字 · ${((now - started) / 1000).toFixed(1)} 秒`;
          thinkDet.open = false;
          ensureAnswer();
        }
      } else {
        ensureAnswer();
        j += 3;
        entry.content = answer.slice(0, j);
        if (now - lastPaint > 80) {
          lastPaint = now;
          answerEl.innerHTML = window.LDMMD.render(entry.content);
        }
        if (j >= answer.length) {
          finish(false);
          return;
        }
      }
      if (now - lastPaint > 260) scrollToBottom(true);
      run.timer = setTimeout(tick, 18);
    };

    run = { timer: 0, aborted: false, entry, session };
    run.timer = setTimeout(tick, 220);
  }

  window.PVPages = window.PVPages || {};
  window.PVPages.chat = {
    render(root) {
      loadStore();
      render(root);
      if (!ui.text.value) setTimeout(() => ui.text.focus(), 120);
    },
    destroy() {
      if (run) {
        run.aborted = true;
        clearTimeout(run.timer);
        run = null;
      }
    },
  };
})();
