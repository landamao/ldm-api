/* ==========================================================================
   懒大猫 API · 渠道管理 + 模型管理
   ========================================================================== */
(function () {
  'use strict';

  const {
    esc, API, State, Toast, openModal, confirmDialog, icon, providerIcon, providerAvatar,
    badge, statusBadge, emptyState, loadingBlock, fmtTime, fmtContext, copyText, debounce, Theme,
  } = window.LDM;

  const CHANNEL_TYPES = [
    { value: 'openai', label: 'OpenAI 兼容', hint: 'OpenAI / DeepSeek / 通义 / 月之暗面 / Ollama / vLLM 等所有兼容 /v1/chat/completions 的服务' },
    { value: 'anthropic', label: 'Anthropic', hint: 'Claude 官方 API，会自动在两种协议之间做转换' },
    { value: 'gemini', label: 'Google Gemini', hint: 'Google AI Studio / Gemini API' },
  ];

  // 状态码规则的默认值，与 internal/store/status.go 中的常量保持一致。
  const DEFAULT_KEY_COOLDOWN_STATUS = '401,403,408,429,500-599';
  const DEFAULT_NO_RETRY_STATUS = '400-428,430-499';
  const NO_RETRY_STATUS_HELP_TEXT = '支持单个状态码或区间，逗号分隔，例如 400-430、429。命中后直接返回上游错误，不再尝试其它路由，也不记录 Key / 路由冷却。留空表示所有状态码都可重试（未配置过的旧数据也按留空处理）；点击「填入模板」填入 400-428,430-499（4xx 中除 429 外都不可重试）。401/403 只要渠道把它算作 Key 故障、且还有其它 Key，仍会先换 Key 重试，不受这里影响。';
  const NO_RETRY_STATUS_HELP_HTML = `
    <div style="margin-bottom:8px">支持单个状态码或区间，逗号分隔，例如 <code>400-430</code>、<code>429</code>。</div>
    <div style="margin-bottom:8px">命中后直接返回上游错误，不再尝试其它路由，也不记录 Key / 路由冷却。</div>
    <div style="margin-bottom:8px">留空表示所有状态码都可重试（未配置过的旧数据也按留空处理）；点击「填入模板」填入 <code>${DEFAULT_NO_RETRY_STATUS}</code>（4xx 中除 429 外都不可重试）。</div>
    <div>401/403 只要渠道把它算作 Key 故障、且还有其它 Key，仍会先换 Key 重试，不受这里影响。</div>`;

  // 每个渠道 / 模型编辑弹窗的「高级设置」展开状态按实体 ID 记在本地。
  // 新建时统一用 __new，避免不同实体的状态互相影响。
  const ADVANCED_KEY_PREFIX = 'ldmapi.advanced.';

  function advancedKey(kind, id) {
    return ADVANCED_KEY_PREFIX + kind + '.' + (id || '__new');
  }

  function bindAdvancedState(scope, kind, id) {
    const details = scope.querySelector('details.advanced-settings');
    if (!details) return;
    try {
      details.open = localStorage.getItem(advancedKey(kind, id)) === '1';
    } catch (e) { /* 存储不可用时默认收起 */ }
    details.addEventListener('toggle', () => {
      try { localStorage.setItem(advancedKey(kind, id), details.open ? '1' : '0'); } catch (e) { /* 忽略配额错误 */ }
    });
  }

  // 长说明统一收进标签旁的问号：悬停看摘要，点击打开完整说明。
  function helpBadgeHtml(text, label) {
    return `<button type="button" class="badge badge--blue badge--click field__help" title="${esc(text)}" aria-label="${esc(label)}">?</button>`;
  }

  function openHelpModal(title, html) {
    openModal({
      title,
      size: 'sm',
      body: `<div class="fs-13" style="line-height:1.8">${html}</div>`,
      footer: `<div class="spacer"></div><button class="btn" data-close>知道了</button>`,
    });
  }

  // 从系统剪贴板粘贴到指定输入框；浏览器不允许读取时给出明确提示。
  async function pasteTextInto(input) {
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
        throw new Error('clipboard unavailable');
      }
      const text = await navigator.clipboard.readText();
      if (!text) {
        Toast.warn('剪贴板是空的');
        input.focus();
        return;
      }
      input.value = text;
      input.focus();
      Toast.success('已从剪贴板粘贴');
    } catch (e) {
      Toast.error('无法读取剪贴板，请手动粘贴（Ctrl+V）');
      input.focus();
    }
  }

  const CHANNEL_HINT_KEY = 'ldmapi.channels.hint.dismissed';
  const CHANNEL_DISABLED_HINT_KEY = 'ldmapi.channels.disabled-warning.dismissed';

  function channelHintDismissed() {
    try { return localStorage.getItem(CHANNEL_HINT_KEY) === '1'; } catch (e) { return false; }
  }

  function dismissChannelHint() {
    try { localStorage.setItem(CHANNEL_HINT_KEY, '1'); } catch (e) { /* 存储不可用时仅本次隐藏 */ }
  }

  function channelDisabledHintDismissed() {
    try { return localStorage.getItem(CHANNEL_DISABLED_HINT_KEY) === '1'; } catch (e) { return false; }
  }

  function dismissChannelDisabledHint() {
    try { localStorage.setItem(CHANNEL_DISABLED_HINT_KEY, '1'); } catch (e) { /* 存储不可用时仅本次隐藏 */ }
  }

  // 渠道被禁用时只做提示，不改变任何配置。传入数组表示批量禁用。
  function showChannelDisabledNotice(ch) {
    if (channelDisabledHintDismissed()) return;
    const label = Array.isArray(ch)
      ? `选中的 <b>${ch.length}</b> 个渠道`
      : `渠道 <code>${esc(ch.id)}</code>${ch.name && ch.name !== ch.id ? `（${esc(ch.name)}）` : ''}`;
    openModal({
      title: '渠道已禁用',
      size: 'sm',
      body: `<div style="font-size:13.5px;line-height:1.7;color:var(--text-2)">
        ${label} 已禁用。<br><br>
        请注意，如果有自定义模型还在引用该渠道的模型，使用该模型时将自动跳过请求这些模型，日志也不会有跳过记录。
      </div>`,
      footer: `<div class="spacer"></div>
        <button class="btn" data-act="never">不再提示</button>
        <button class="btn btn--primary" data-act="ok">我知道了</button>`,
      onMount(mo) {
        mo.foot.querySelector('[data-act=never]').onclick = () => {
          dismissChannelDisabledHint();
          mo.close();
        };
        mo.foot.querySelector('[data-act=ok]').onclick = () => mo.close();
      },
    });
  }

  function typeLabel(t) {
    const f = CHANNEL_TYPES.find((x) => x.value === t);
    return f ? f.label : t || 'OpenAI 兼容';
  }

  function typeTone(t) {
    return t === 'anthropic' ? 'violet' : t === 'gemini' ? 'blue' : 'green';
  }

  // ======================================================================
  // 渠道管理
  // ======================================================================
  const channelListState = {
    type: 'all',     // all | openai | anthropic | gemini
    status: 'all',   // all | enabled | disabled
    usage: 'all',    // all | partial | linked | empty
    keyword: '',
    modelKeyword: '',
    multi: false,
    selected: new Set(),
  };

  // 接入情况：有模型但没全部加入模型管理 / 已全部加入 / 还没有模型
  function channelUsage(c) {
    const total = (c.models || []).length;
    const added = c.added_count || 0;
    if (!total) return 'empty';
    if (added >= total) return 'linked';
    return 'partial';
  }

  function channelRow(c) {
    const names = c.models || [];          // 渠道里填写的上游模型名
    const keyRows = c.key_rows || [];
    const keyCount = keyRows.length;
    const multiKeyOn = c.multi_key_enabled === true;
    const keyTip = `${c.key_mode === 'random' ? '随机' : '顺序'}${c.key_affinity ? ' + 亲和' : ''}`
      + (keyCount ? `\n${keyRows.map((r, i) => `#${i + 1}${r.note ? ` ${r.note}` : ''}`).join('\n')}` : '');
    const multi = channelListState.multi;
    return `<tr class="${multi ? 'is-selectable' : ''}" data-rowid="${esc(c.id)}">
      ${multi ? `<td><input type="checkbox" data-csel data-cid="${esc(c.id)}" aria-label="选择 ${esc(c.id)}"></td>` : ''}
      <td>
        <div class="flex-center gap-8">
          <span class="code" style="font-weight:650">${esc(c.id)}</span>
          ${c.enabled ? '' : badge('已禁用', 'gray')}
        </div>
        ${c.name ? `<div class="muted fs-12" style="margin-top:2px">${esc(c.name)}</div>` : ''}
      </td>
      <td>${badge(typeLabel(c.type), typeTone(c.type))}${multiKeyOn && keyCount > 1
        ? ` <span class="badge badge--gray" title="${esc(keyTip)}">${keyCount} Keys</span>`
        : ''}</td>
      <td><span class="muted fs-12 truncate" style="display:block;max-width:220px" title="${esc(c.base_url)}">${esc(c.base_url || '（默认地址）')}</span></td>
      <td class="num">${names.length}</td>
      <td class="num">
        <span class="strong">${c.added_count || 0}</span>
        <span class="muted">/ ${names.length}</span>
      </td>
      <td>
        <div class="badge-group">
          ${names.slice(0, 4).map((m) => `<span class="badge mono">${esc(m)}</span>`).join('')}
          ${names.length > 4 ? `<span class="badge badge--gray">+${names.length - 4}</span>` : ''}
          ${names.length === 0 ? '<span class="muted fs-12">未配置模型</span>' : ''}
        </div>
      </td>
      ${multi ? '' : `<td>
        <div class="row-actions">
          <button class="btn btn--sm btn--icon" data-act="test" data-id="${esc(c.id)}" title="测试连通性" aria-label="测试连通性">${icon('zap', 13)}</button>
          <button class="btn btn--sm btn--icon" data-act="toggle" data-id="${esc(c.id)}" title="${c.enabled ? '禁用' : '启用'}" aria-label="${c.enabled ? '禁用渠道' : '启用渠道'}">${c.enabled ? icon('pause', 13) : icon('play', 13)}</button>
          <button class="btn btn--sm btn--icon" data-act="edit" data-id="${esc(c.id)}" title="编辑" aria-label="编辑渠道">${icon('edit', 13)}</button>
          <button class="btn btn--sm btn--icon btn--danger" data-act="del" data-id="${esc(c.id)}" title="删除" aria-label="删除渠道">${icon('trash', 13)}</button>
        </div>
      </td>`}
    </tr>`;
  }

  window.LDM.registerPage('channels', {
    title: '渠道管理',
    desc: '配置上游服务商',
    async render(root, actions) {
      const channels = await State.loadChannels(true);

      actions.innerHTML = `
        <button class="btn" id="btn-refresh">${icon('refresh', 14)}刷新</button>
        <button class="btn" id="btn-clear-cooldowns">${icon('refresh', 14)}清除冷却</button>
        <button class="btn btn--primary" id="btn-add-channel">${icon('plus', 15)}添加渠道</button>`;
      actions.querySelector('#btn-refresh').onclick = () => window.LDM.navigate();
      actions.querySelector('#btn-add-channel').onclick = () => openChannelEditor(null);
      actions.querySelector('#btn-clear-cooldowns').onclick = async () => {
        const ok = await confirmDialog({
          title: '清除所有冷却',
          message: `将清空内存中所有路由的失败冷却状态，冷却中的条目会立即恢复可用。<br><br>
            只影响当前进程的运行时状态，不会修改任何配置。`,
          confirmText: '清除冷却',
        });
        if (!ok) return;
        try {
          const res = await API.post('/api/models/clear-cooldowns');
          const n = res && res.cleared ? res.cleared : 0;
          Toast.success(n ? `已清除 ${n} 条路由冷却` : '当前没有处于冷却中的路由');
        } catch (e) { Toast.error(e.message); }
      };

      if (!channels.length) {
        channelListState.multi = false;
        channelListState.selected.clear();
        root.innerHTML = `<div class="card">${emptyState(
          '还没有配置任何渠道',
          '添加第一个上游渠道，填入 Base URL 与 API Key，就能把它的模型接入网关。',
          `<button class="btn btn--primary" id="empty-add">${icon('plus', 15)}添加渠道</button>`,
          'server'
        )}</div>`;
        root.querySelector('#empty-add').onclick = () => openChannelEditor(null);
        return;
      }

      // 多选模式退出后清理残留选择；渠道被删后也把失效 ID 移出选中集
      if (!channelListState.multi) channelListState.selected.clear();
      const alive = new Set(channels.map((c) => c.id));
      [...channelListState.selected].forEach((id) => {
        if (!alive.has(id)) channelListState.selected.delete(id);
      });

      // 筛选区和表头固定，只让表格内容滚动
      root.classList.add('content__inner--fill');

      const typeCounts = {};
      channels.forEach((c) => {
        const t = c.type || 'openai';
        typeCounts[t] = (typeCounts[t] || 0) + 1;
      });
      const statusCounts = { enabled: 0, disabled: 0 };
      channels.forEach((c) => { statusCounts[c.enabled ? 'enabled' : 'disabled'] += 1; });
      const usageCounts = { partial: 0, linked: 0, empty: 0 };
      channels.forEach((c) => { usageCounts[channelUsage(c)] += 1; });

      const typeOptions = [
        ['all', `全部类型（${channels.length}）`],
        ...CHANNEL_TYPES.map((t) => [t.value, `${t.label}（${typeCounts[t.value] || 0}）`]),
      ];
      const statusOptions = [
        ['all', '全部状态'],
        ['enabled', `已启用（${statusCounts.enabled}）`],
        ['disabled', `已禁用（${statusCounts.disabled}）`],
      ];
      const usageOptions = [
        ['all', '全部接入情况'],
        ['partial', `有未接入模型（${usageCounts.partial}）`],
        ['linked', `全部已接入（${usageCounts.linked}）`],
        ['empty', `未配置模型（${usageCounts.empty}）`],
      ];

      const filterSelect = (id, label, key, opts, width) => `
        <select class="select" id="${id}" aria-label="${label}" style="width:${width}">
          ${opts.map(([v, text]) => `<option value="${esc(v)}"${channelListState[key] === v ? ' selected' : ''}>${esc(text)}</option>`).join('')}
        </select>`;

      root.innerHTML = `
        <div class="card channels-card" style="overflow:visible">
          <div class="toolbar" style="border-bottom:none;padding-bottom:5px">
            ${filterSelect('ch-filter-type', '渠道类型', 'type', typeOptions, '170px')}
            ${filterSelect('ch-filter-status', '启用状态', 'status', statusOptions, '145px')}
            ${filterSelect('ch-filter-usage', '接入情况', 'usage', usageOptions, '175px')}
          </div>
          <div class="toolbar" style="padding-top:5px;gap:8px">
            <div class="search" style="flex:0 1 220px;min-width:200px">
              <span class="search__icon">${icon('search', 15)}</span>
              <input class="input" id="channel-search" placeholder="搜索渠道 ID、名称或地址…" value="${esc(channelListState.keyword)}">
            </div>
            <div class="search" style="flex:0 1 170px;min-width:160px">
              <span class="search__icon">${icon('search', 15)}</span>
              <input class="input" id="channel-model-search" placeholder="搜索模型名…" value="${esc(channelListState.modelKeyword)}">
            </div>
            <div class="toolbar__spacer"></div>
            <span class="muted fs-12" id="channel-filter-count" ${channelListState.multi ? 'style="display:none"' : ''}></span>
            <button class="btn btn--sm" id="ch-multi" style="${channelListState.multi ? 'display:none' : ''}">${icon('check', 13)}多选</button>
            <span class="muted fs-12" id="channel-multi-count" style="${channelListState.multi ? '' : 'display:none'}">已选 ${channelListState.selected.size} 个</span>
            <button class="btn btn--sm" id="ch-enable" style="${channelListState.multi ? '' : 'display:none'}">${icon('play', 13)}启用</button>
            <button class="btn btn--sm" id="ch-disable" style="${channelListState.multi ? '' : 'display:none'}">${icon('pause', 13)}禁用</button>
            <button class="btn btn--sm" id="ch-test" style="${channelListState.multi ? '' : 'display:none'}">${icon('zap', 13)}测试</button>
            <button class="btn btn--sm" id="ch-cooldown" style="${channelListState.multi ? '' : 'display:none'}">${icon('refresh', 13)}清除冷却</button>
            <button class="btn btn--sm btn--danger" id="ch-del" style="${channelListState.multi ? '' : 'display:none'}">${icon('trash', 13)}删除</button>
            <button class="btn btn--sm btn--ghost" id="ch-exit" style="${channelListState.multi ? '' : 'display:none'}">${icon('x', 13)}退出多选</button>
          </div>
          <div id="channel-table"></div>
          ${channelHintDismissed() ? '' : `<div class="alert alert--pink mt-16" id="channel-hint" style="margin:0 14px 14px">
            ${icon('info', 15)}<div>
              <span class="strong">这里填的是上游真实的模型名。</span>
              接入到「模型管理」之后，它们会各自获得一个带渠道前缀的 ID，例如渠道
              <code>${esc(channels[0].id)}</code> 的模型 <code>a</code> 对应
              <code>${esc(channels[0].id)}/a</code>，调用时使用那个 ID。
              渠道模型必须先在「模型管理」中手动添加，才会对外开放。
            </div>
            <button class="alert__close" id="btn-dismiss-hint" title="关闭提示" aria-label="关闭提示">${icon('x', 14)}</button>
          </div>`}
        </div>`;

      const renderTable = () => {
        const kw = channelListState.keyword.trim().toLowerCase();
        const modelKw = channelListState.modelKeyword.trim().toLowerCase();
        const list = channels.filter((c) => {
          if (channelListState.type !== 'all' && (c.type || 'openai') !== channelListState.type) return false;
          if (channelListState.status === 'enabled' && !c.enabled) return false;
          if (channelListState.status === 'disabled' && c.enabled) return false;
          if (channelListState.usage !== 'all' && channelUsage(c) !== channelListState.usage) return false;
          if (kw) {
            const hay = [
              c.id, c.name || '', c.base_url || '', c.remark || '',
              typeLabel(c.type),
            ].join(' ').toLowerCase();
            if (!hay.includes(kw)) return false;
          }
          if (modelKw) {
            const hit = (c.models || []).some((m) => m.toLowerCase().includes(modelKw));
            if (!hit) return false;
          }
          return true;
        });

        const host = root.querySelector('#channel-table');
        root.querySelector('#channel-filter-count').textContent = `共 ${list.length} 个渠道`;

        if (!list.length) {
          host.innerHTML = emptyState(
            '没有符合条件的渠道',
            '试试调整筛选条件或清空搜索关键词。',
            '',
            'server'
          );
          return;
        }

        host.innerHTML = `<div class="table-wrap" style="border:none;border-radius:0">
          <table class="tbl">
            <thead><tr>
              ${channelListState.multi ? '<th style="width:34px"><input type="checkbox" id="ch-checkall" aria-label="全选"></th>' : ''}
              <th style="min-width:150px">渠道 ID</th>
              <th>类型</th>
              <th>接口地址</th>
              <th class="right">模型数</th>
              <th class="right">已接入</th>
              <th style="min-width:230px">可用模型</th>
              ${channelListState.multi ? '' : '<th style="width:150px"></th>'}
            </tr></thead>
            <tbody>${list.map(channelRow).join('')}</tbody>
          </table>
        </div>`;

        // 多选模式：行勾选 / 表头全选 / 点击整行切换选中
        if (channelListState.multi) {
          const syncBar = () => {
            root.querySelector('#channel-multi-count').textContent = `已选 ${channelListState.selected.size} 个`;
            const boxes = host.querySelectorAll('input[data-csel]');
            const checked = [...boxes].filter((i) => i.checked);
            const checkall = host.querySelector('#ch-checkall');
            if (checkall) {
              checkall.checked = boxes.length > 0 && checked.length === boxes.length;
              checkall.indeterminate = checked.length > 0 && checked.length < boxes.length;
            }
          };
          host.querySelectorAll('input[data-csel]').forEach((cb) => {
            cb.checked = channelListState.selected.has(cb.dataset.cid);
            cb.closest('tr').classList.toggle('is-selected', cb.checked);
            cb.addEventListener('change', () => {
              if (cb.checked) channelListState.selected.add(cb.dataset.cid);
              else channelListState.selected.delete(cb.dataset.cid);
              cb.closest('tr').classList.toggle('is-selected', cb.checked);
              syncBar();
            });
          });
          // 点击整行切换选中；行内按钮和复选框自身不触发（避免双切）
          host.querySelector('tbody').addEventListener('click', (e) => {
            if (e.target.closest('button, a, input, .badge')) return;
            const tr = e.target.closest('tr[data-rowid]');
            if (!tr) return;
            const cid = tr.dataset.rowid;
            if (channelListState.selected.has(cid)) channelListState.selected.delete(cid);
            else channelListState.selected.add(cid);
            const cb = tr.querySelector('input[data-csel]');
            if (cb) cb.checked = channelListState.selected.has(cid);
            tr.classList.toggle('is-selected', channelListState.selected.has(cid));
            syncBar();
          });
          const checkall = host.querySelector('#ch-checkall');
          if (checkall) checkall.addEventListener('change', () => {
            host.querySelectorAll('input[data-csel]').forEach((cb) => {
              cb.checked = checkall.checked;
              cb.closest('tr').classList.toggle('is-selected', checkall.checked);
              if (checkall.checked) channelListState.selected.add(cb.dataset.cid);
              else channelListState.selected.delete(cb.dataset.cid);
            });
            syncBar();
          });
          syncBar();
        }

        host.querySelectorAll('[data-act]').forEach((btn) => {
          btn.onclick = async () => {
            const id = btn.dataset.id;
            const ch = channels.find((x) => x.id === id) || State.channels.find((x) => x.id === id);
            if (!ch) return;
            if (btn.dataset.act === 'edit') openChannelEditor(ch);
            else if (btn.dataset.act === 'del') await removeChannel(ch);
            else if (btn.dataset.act === 'toggle') await toggleChannel(ch);
            else if (btn.dataset.act === 'test') await testChannel(ch, btn);
          };
        });
      };

      // 下拉筛选：原生 select 由 Select 组件自动增强，直接监听 change 即可
      [['ch-filter-type', 'type'], ['ch-filter-status', 'status'], ['ch-filter-usage', 'usage']]
        .forEach(([id, key]) => {
          const el = root.querySelector('#' + id);
          el.addEventListener('change', () => {
            channelListState[key] = el.value;
            renderTable();
          });
        });
      const searchEl = root.querySelector('#channel-search');
      searchEl.addEventListener('input', debounce(() => {
        channelListState.keyword = searchEl.value;
        renderTable();
      }, 180));
      const modelSearchEl = root.querySelector('#channel-model-search');
      modelSearchEl.addEventListener('input', debounce(() => {
        channelListState.modelKeyword = modelSearchEl.value;
        renderTable();
      }, 180));

      const dismissBtn = root.querySelector('#btn-dismiss-hint');
      if (dismissBtn) {
        dismissBtn.onclick = async () => {
          const ok = await confirmDialog({
            title: '关闭提示',
            message: '关闭后这条提示将不再显示，确定关闭吗？',
            confirmText: '关闭',
          });
          if (!ok) return;
          dismissChannelHint();
          const hint = root.querySelector('#channel-hint');
          if (hint) hint.remove();
        };
      }

      // ---------- 多选模式 ----------
      const applyMulti = () => {
        const set = (id, show) => {
          const el = root.querySelector('#' + id);
          if (el) el.style.display = show ? '' : 'none';
        };
        set('channel-filter-count', !channelListState.multi);
        set('ch-multi', !channelListState.multi);
        set('channel-multi-count', channelListState.multi);
        set('ch-enable', channelListState.multi);
        set('ch-disable', channelListState.multi);
        set('ch-test', channelListState.multi);
        set('ch-cooldown', channelListState.multi);
        set('ch-del', channelListState.multi);
        set('ch-exit', channelListState.multi);
        renderTable();
      };
      root.querySelector('#ch-multi').onclick = () => {
        channelListState.multi = true;
        applyMulti();
      };
      root.querySelector('#ch-exit').onclick = () => {
        channelListState.multi = false;
        channelListState.selected.clear();
        applyMulti();
      };

      const getSelectedChannels = () =>
        channels.filter((c) => channelListState.selected.has(c.id));

      // 批量操作后刷新数据，已删除渠道的选择会被清掉；多选模式保持
      const refreshAfterBatch = async () => {
        State.invalidate('channels');
        State.invalidate('models');
        await State.loadChannels(true);
        const live = new Set(State.channels.map((c) => c.id));
        [...channelListState.selected]
          .filter((id) => !live.has(id))
          .forEach((id) => channelListState.selected.delete(id));
        window.LDM.navigate();
      };

      const batchToggle = async (enabled) => {
        const sel = getSelectedChannels().filter((c) => c.enabled !== enabled);
        if (!sel.length) {
          Toast.info(enabled ? '选中的渠道都已启用' : '选中的渠道都已禁用');
          return;
        }
        try {
          for (const c of sel) {
            await API.put('/api/channels/' + encodeURIComponent(c.id), { id: c.id, enabled });
          }
          Toast.success(`已${enabled ? '启用' : '禁用'} ${sel.length} 个渠道`);
          await refreshAfterBatch();
          if (!enabled) showChannelDisabledNotice(sel);
        } catch (e) { Toast.error(e.message); }
      };
      root.querySelector('#ch-enable').onclick = () => batchToggle(true);
      root.querySelector('#ch-disable').onclick = () => batchToggle(false);

      root.querySelector('#ch-test').onclick = async () => {
        const sel = getSelectedChannels();
        if (!sel.length) { Toast.info('请先勾选渠道'); return; }
        const btn = root.querySelector('#ch-test');
        const old = btn.innerHTML;
        btn.disabled = true;
        let ok = 0;
        let fail = 0;
        for (let i = 0; i < sel.length; i++) {
          btn.innerHTML = `<span class="spinner" style="width:12px;height:12px"></span>${i + 1}/${sel.length}`;
          const c = sel[i];
          const res = await testChannelQuiet(c);
          if (res.ok) {
            ok += 1;
            Toast.success(`${c.id}：${res.message}（${res.latency}ms）`, '渠道可用');
          } else {
            fail += 1;
            Toast.error(`${c.id}：${res.message}`, '渠道不可用');
          }
        }
        btn.disabled = false;
        btn.innerHTML = old;
        if (!fail) Toast.success(`${ok} 个渠道全部正常`, '测试完成');
        else if (!ok) Toast.error(`${fail} 个渠道均不可用`, '测试完成');
        else Toast.warn(`${ok} 个正常，${fail} 个不可用`, '测试完成');
      };

      root.querySelector('#ch-cooldown').onclick = async () => {
        const sel = getSelectedChannels();
        if (!sel.length) { Toast.info('请先勾选渠道'); return; }
        try {
          let cleared = 0;
          for (const c of sel) {
            const res = await API.post('/api/models/clear-cooldowns?channel_id=' + encodeURIComponent(c.id));
            cleared += (res && res.cleared) || 0;
          }
          if (cleared) Toast.success(`已清除 ${cleared} 条冷却`);
          else Toast.info('选中的渠道没有处于冷却中的路由');
        } catch (e) { Toast.error(e.message); }
      };

      root.querySelector('#ch-del').onclick = async () => {
        const sel = getSelectedChannels();
        if (!sel.length) { Toast.info('请先勾选渠道'); return; }
        const refsById = {};
        try {
          const results = await Promise.all(sel.map(async (c) => {
            const res = await API.get(`/api/channels/${encodeURIComponent(c.id)}/refs`);
            return [c.id, (res && res.refs) || []];
          }));
          results.forEach(([id, refs]) => { refsById[id] = refs; });
        } catch (e) {
          Toast.error(e.message, '读取渠道引用失败');
          return;
        }
        const action = await confirmDeleteChannels(sel, refsById);
        if (!action) return;
        let removed = 0;
        let updated = 0;
        const failed = [];
        for (const c of sel) {
          try {
            const query = action === 'remove' ? '?remove_refs=1' : '';
            const res = await API.del('/api/channels/' + encodeURIComponent(c.id) + query);
            removed += ((res && res.removed_models) || []).length;
            updated += ((res && res.updated_models) || []).length;
          } catch (e) { failed.push(c.id); }
        }
        const done = sel.length - failed.length;
        if (done) {
          const extra = action === 'remove'
            ? (removed ? `，移除 ${removed} 个渠道模型` : '') + (updated ? `，清理 ${updated} 个自定义模型路由` : '')
            : '，模型管理里的配置保持不变';
          Toast.success(`已删除 ${done} 个渠道${extra}`);
        }
        if (failed.length) Toast.error(`${failed.length} 个渠道删除失败：${failed.join('、')}`, '部分删除失败');
        await refreshAfterBatch();
      };

      renderTable();
    },
  });

  async function toggleChannel(ch) {
    const disabling = ch.enabled;
    try {
      await API.put('/api/channels/' + encodeURIComponent(ch.id), {
        id: ch.id, enabled: !ch.enabled,
      });
      Toast.success(`渠道 ${ch.id} 已${ch.enabled ? '禁用' : '启用'}`);
      State.invalidate('channels');
      State.invalidate('models');
      window.LDM.navigate();
      if (disabling) showChannelDisabledNotice(ch);
    } catch (e) { Toast.error(e.message); }
  }

  async function removeChannel(ch) {
    let refs = [];
    try {
      const res = await API.get(`/api/channels/${encodeURIComponent(ch.id)}/refs`);
      refs = (res && res.refs) || [];
    } catch (e) {
      Toast.error(e.message, '读取引用失败');
      return;
    }
    if (!refs.length) {
      const ok = await confirmDialog({
        title: '删除渠道',
        message: `确定删除渠道 <b>${esc(ch.id)}</b> 吗？<br><br>模型管理里没有引用它的模型。<br><br>该操作不可撤销。`,
        confirmText: '删除渠道',
        danger: true,
      });
      if (!ok) return;
      await deleteChannelNow(ch, false);
      return;
    }
    const action = await confirmDeleteChannelRefs(ch, refs);
    if (!action) return;
    await deleteChannelNow(ch, action === 'remove');
  }

  async function deleteChannelNow(ch, removeRefs) {
    try {
      const suffix = removeRefs ? '?remove_refs=1' : '';
      const res = await API.del('/api/channels/' + encodeURIComponent(ch.id) + suffix);
      const removed = (res && res.removed_models) || [];
      const updated = (res && res.updated_models) || [];
      if (removeRefs) {
        Toast.success(
          `渠道 ${ch.id} 已删除，移除 ${removed.length} 个渠道模型${updated.length ? `，并清理 ${updated.length} 个自定义模型的路由` : ''}`
        );
      } else {
        Toast.success(`渠道 ${ch.id} 已删除，模型管理里的配置保持不变`);
      }
      State.invalidate('all');
      window.LDM.navigate();
    } catch (e) { Toast.error(e.message); }
  }

  // 删除渠道时如果还有模型/路由引用，让用户选择是否一起移除；
  // 允许点空白处 / Esc 关闭，等同于取消。
  function confirmDeleteChannelRefs(ch, refs) {
    return new Promise((resolve) => {
      const groups = new Map();
      refs.forEach((r) => {
        if (!groups.has(r.upstream)) groups.set(r.upstream, []);
        groups.get(r.upstream).push(r);
      });
      const list = Array.from(groups.entries()).map(([upstream, items]) => `
        <div class="mt-10">
          <div class="mono strong">${esc(upstream)}</div>
          <ul class="fs-12 muted" style="margin:4px 0 0 18px;padding:0">
            ${items.map((r) => `<li>${r.type === 'custom_route'
              ? `自定义模型 <code>${esc(r.model_id)}</code> 中的路由`
              : `渠道模型 <code>${esc(r.model_id)}</code>`}</li>`).join('')}
          </ul>
        </div>`).join('');

      openModal({
        title: '删除渠道',
        size: 'sm',
        body: `<div style="font-size:13.5px;line-height:1.7;color:var(--text-2)">
          确定删除渠道 <code>${esc(ch.id)}</code> 吗？模型管理里仍有以下引用：
          ${list}
          <div class="mt-12">选择「仅删除渠道」会保留这些模型；选择「删除并移除模型」会一并删除渠道模型并清理自定义模型里的相关路由。</div>
          <div class="fs-12 muted mt-6">该操作不可撤销。</div>
        </div>`,
        footer: `<div class="spacer"></div>
          <button class="btn" data-act="cancel">取消</button>
          <button class="btn" data-act="keep">仅删除渠道</button>
          <button class="btn btn--danger" data-act="remove">删除并移除模型</button>`,
        onMount(mo) {
          mo.foot.querySelector('[data-act=cancel]').onclick = () => mo.close('');
          mo.foot.querySelector('[data-act=keep]').onclick = () => mo.close('keep');
          mo.foot.querySelector('[data-act=remove]').onclick = () => mo.close('remove');
        },
        onClose(result) { resolve(result || ''); },
      });
    });
  }

  // 批量删除渠道：先查引用，有引用时让用户选择是否一并移除模型。
  // 无引用时复用普通的确认框，返回值 keep / remove / ''（取消）。
  function confirmDeleteChannels(chs, refsById) {
    return new Promise((resolve) => {
      const withRefs = chs.filter((ch) => (refsById[ch.id] || []).length);
      if (!withRefs.length) {
        confirmDialog({
          title: '删除选中渠道',
          message: `确定删除选中的 <b>${chs.length}</b> 个渠道吗？<br><br>模型管理里没有引用它们的模型。<br><br>该操作不可撤销。`,
          confirmText: `删除（${chs.length}）`,
          danger: true,
        }).then((ok) => resolve(ok ? 'keep' : ''));
        return;
      }

      const totalRefs = withRefs.reduce((n, ch) => n + refsById[ch.id].length, 0);
      const list = withRefs.map((ch) => {
        const n = refsById[ch.id].length;
        return `<li><code>${esc(ch.id)}</code> 有 ${n} 处引用</li>`;
      }).join('');

      openModal({
        title: '删除选中渠道',
        size: 'sm',
        body: `<div style="font-size:13.5px;line-height:1.7;color:var(--text-2)">
          确定删除选中的 <b>${chs.length}</b> 个渠道吗？其中 <b>${withRefs.length}</b> 个渠道仍有
          ${totalRefs} 处模型引用：
          <ul class="fs-12 muted" style="margin:6px 0 0 18px;padding:0">${list}</ul>
          <div class="mt-12">选择「仅删除渠道」会保留这些模型；选择「删除并移除模型」会一并删除渠道模型并清理自定义模型里的相关路由。</div>
          <div class="fs-12 muted mt-6">该操作不可撤销。</div>
        </div>`,
        footer: `<div class="spacer"></div>
          <button class="btn" data-act="cancel">取消</button>
          <button class="btn" data-act="keep">仅删除渠道</button>
          <button class="btn btn--danger" data-act="remove">删除并移除模型</button>`,
        onMount(mo) {
          mo.foot.querySelector('[data-act=cancel]').onclick = () => mo.close('');
          mo.foot.querySelector('[data-act=keep]').onclick = () => mo.close('keep');
          mo.foot.querySelector('[data-act=remove]').onclick = () => mo.close('remove');
        },
        onClose(result) { resolve(result || ''); },
      });
    });
  }

  // 批量测试逐个弹结果，最后统一汇总。
  async function testChannelQuiet(ch) {
    try {
      const res = await API.post(`/api/channels/${encodeURIComponent(ch.id)}/test`);
      return {
        ok: !!(res && res.ok),
        message: (res && res.message) || '',
        latency: (res && res.latency_ms) || 0,
      };
    } catch (e) {
      return { ok: false, message: e.message || '测试失败', latency: 0 };
    }
  }

  async function testChannel(ch, btn) {
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:12px;height:12px"></span>测试中';
    try {
      const res = await API.post(`/api/channels/${encodeURIComponent(ch.id)}/test`);
      if (res.ok) Toast.success(`${ch.id}：${res.message}（${res.latency_ms}ms）`, '渠道可用');
      else Toast.error(`${ch.id}：${res.message}`, '渠道不可用');
    } catch (e) {
      Toast.error(e.message, '测试失败');
    } finally {
      btn.disabled = false;
      btn.innerHTML = old;
    }
  }

  // ---------- 获取模型列表弹窗 ----------
  // 用标签页切换「获取到的模型」和「上游不存在的模型」。
  // 两边都可以勾选/取消，确认后以勾选结果为准：取消勾选已添加的模型即从列表中移除。
  // 模型按名称自动匹配提供商分组，支持展开/折叠。
  async function openFetchedModelsPicker(cfg) {
    const { existing, onConfirm } = cfg;
    const models = Array.from(new Set(cfg.models || []));
    const before = existing instanceof Set ? Array.from(existing) : Array.from(existing || []);
    const beforeSet = new Set(before);
    const fetchedSet = new Set(models);
    const missing = before.filter((m) => !fetchedSet.has(m));

    let providers = [];
    try { providers = await State.loadProviders(); } catch (e) { providers = []; }
    const providerByID = {};
    providers.forEach((p) => { providerByID[p.id] = p; });

    const itemHtml = (m, isOld) => `<label class="pick-item" data-search="${esc(m.toLowerCase())}">
        <input type="checkbox" data-model="${esc(m)}" checked>
        <span class="pick-item__name">${esc(m)}</span>
        <span class="pick-item__meta">${isOld ? badge('已添加', 'green') : ''}</span>
      </label>`;

    // 按模型名自动匹配提供商；未命中的统一放到「未识别提供商」
    const makeGroups = (arr) => {
      const map = new Map();
      arr.forEach((m) => {
        const pid = autoMatchProvider(providers, m);
        if (!map.has(pid)) map.set(pid, []);
        map.get(pid).push(m);
      });
      const order = providers.map((p) => p.id).filter((pid) => map.has(pid));
      if (map.has('')) order.push('');
      return order.map((pid) => {
        const p = providerByID[pid];
        return {
          key: pid || '__none',
          icon: p ? p.icon : '',
          name: p ? p.name : '未识别提供商',
          items: map.get(pid),
        };
      });
    };
    const fetchedGroups = makeGroups(models);
    const missingGroups = makeGroups(missing);
    // 默认全部折叠，先看提供商分组概览
    const collapsed = new Set([
      ...fetchedGroups.map((g) => 'fetched:' + g.key),
      ...missingGroups.map((g) => 'missing:' + g.key),
    ]);

    const groupsHtml = (groups, listKey, isOld) => groups.map((g) => {
      const key = listKey + ':' + g.key;
      return `
      <div class="pick-group${collapsed.has(key) ? ' is-collapsed' : ''}" data-gkey="${esc(g.key)}" data-listkey="${listKey}">
        <div class="pick-group__head">
          <span class="pick-group__arrow">\u25be</span>
          <input type="checkbox" data-group>
          ${g.icon ? providerIcon(g.icon, 14) : ''}
          <span class="pick-group__name${g.key === '__none' ? ' muted' : ''}">${esc(g.name)}</span>
          <span class="pick-group__count">${g.items.length} 个模型</span>
          <span class="pick-group__selected"></span>
        </div>
        <div class="pick-group__body">${g.items.map((m) => itemHtml(m, isOld(m))).join('')}</div>
      </div>`;
    }).join('');

    const body = `
      <div class="tabs mb-12" id="disc-tabs">
        <div class="tab is-active" data-disc-tab="fetched">获取到的模型 <span class="tab__count">${models.length}</span></div>
        <div class="tab" data-disc-tab="missing">上游不存在的模型 <span class="tab__count">${missing.length}</span></div>
      </div>
      <div class="search mb-12">
        <span class="search__icon">${icon('search', 15)}</span>
        <input class="input" id="disc-search" placeholder="搜索模型名，支持模糊匹配…">
      </div>
      <div class="flex-center gap-8 mb-12" style="flex-wrap:wrap">
        <button class="btn btn--sm" data-pick="all">全选</button>
        <button class="btn btn--sm" data-pick="none">清空</button>
        <button class="btn btn--sm" data-pick="expand">展开全部</button>
        <button class="btn btn--sm" data-pick="collapse">折叠全部</button>
        <div class="ml-auto muted fs-12" id="disc-count"></div>
      </div>
      <div class="disc-panel" data-panel="fetched">
        <div class="pick-list disc-list" data-list="fetched">
          ${groupsHtml(fetchedGroups, 'fetched', (m) => beforeSet.has(m))}
        </div>
        <div class="disc-empty" data-empty="fetched" style="display:none">没有匹配的模型</div>
      </div>
      <div class="disc-panel" data-panel="missing" style="display:none">
        ${missing.length
          ? `<div class="pick-list disc-list" data-list="missing">
              ${groupsHtml(missingGroups, 'missing', () => false)}
            </div>
            <div class="disc-empty" data-empty="missing" style="display:none">没有匹配的模型</div>`
          : `<div class="disc-empty">没有手工填写但上游未返回的模型</div>`}
      </div>`;

    openModal({
      title: '获取模型列表',
      desc: `上游返回 ${models.length} 个模型，已按提供商自动分组。勾选要加入或保留的模型；取消勾选已添加的模型会在确认后移除。手工填写但上游未返回的模型在「上游不存在的模型」标签页中。`,
      body,
      size: 'lg',
      footer: `<div class="spacer"></div>
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn btn--primary" data-act="confirm">确定</button>`,
      onMount(mo) {
        const tabsEl = mo.body.querySelector('#disc-tabs');
        const panels = Array.from(mo.body.querySelectorAll('.disc-panel'));
        const countEl = mo.body.querySelector('#disc-count');
        const searchEl = mo.body.querySelector('#disc-search');
        const confirmBtn = mo.foot.querySelector('[data-act=confirm]');
        let active = 'fetched';
        const boxes = () => Array.from(mo.body.querySelectorAll('input[data-model]'));
        const activeBoxes = () => Array.from(
          mo.body.querySelector(`.disc-panel[data-panel="${active}"]`).querySelectorAll('input[data-model]'),
        );
        const activeVisibleBoxes = () => activeBoxes()
          .filter((i) => i.closest('.pick-item').style.display !== 'none');
        const activeGroups = () => Array.from(
          mo.body.querySelectorAll(`.disc-panel[data-panel="${active}"] .pick-group`),
        );

        const refresh = () => {
          const n = boxes().filter((i) => i.checked).length;
          countEl.textContent = n ? `已选择 ${n} 个` : '未选择';
          confirmBtn.textContent = n ? `确定（${n}）` : '确定';

          mo.body.querySelectorAll('.pick-group').forEach((groupEl) => {
            const items = Array.from(groupEl.querySelectorAll('input[data-model]'));
            // 搜索过滤后的条目；折叠不影响分组全选和统计
            const shown = items.filter((i) => i.closest('.pick-item').style.display !== 'none');
            const checked = shown.filter((i) => i.checked);
            const head = groupEl.querySelector('input[data-group]');
            if (head) {
              head.checked = shown.length > 0 && checked.length === shown.length;
              head.indeterminate = checked.length > 0 && checked.length < shown.length;
            }
            const badgeEl = groupEl.querySelector('.pick-group__selected');
            if (badgeEl) badgeEl.textContent = checked.length ? `已选 ${checked.length}` : '';
          });
        };

        tabsEl.addEventListener('click', (e) => {
          const tab = e.target.closest('[data-disc-tab]');
          if (!tab) return;
          active = tab.dataset.discTab;
          tabsEl.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
          panels.forEach((p) => { p.style.display = p.dataset.panel === active ? '' : 'none'; });
        });

        searchEl.addEventListener('input', debounce(() => {
          const kw = searchEl.value.trim().toLowerCase();
          mo.body.querySelectorAll('.disc-list').forEach((list) => {
            let visible = 0;
            list.querySelectorAll('.pick-item').forEach((item) => {
              const hit = !kw || (item.dataset.search || '').includes(kw);
              item.style.display = hit ? '' : 'none';
              if (hit) visible++;
            });
            // 组内没有匹配项时整组隐藏
            list.querySelectorAll('.pick-group').forEach((groupEl) => {
              const n = Array.from(groupEl.querySelectorAll('.pick-item'))
                .filter((it) => it.style.display !== 'none').length;
              groupEl.style.display = n ? '' : 'none';
            });
            const empty = list.parentElement.querySelector(`[data-empty="${list.dataset.list}"]`);
            if (empty) empty.style.display = visible ? 'none' : '';
          });
          refresh();
        }, 150));

        mo.body.addEventListener('click', (e) => {
          const head = e.target.closest('.pick-group__head');
          if (!head) return;
          if (e.target.matches('input[type=checkbox]')) return;
          const groupEl = head.parentElement;
          const key = groupEl.dataset.listkey + ':' + groupEl.dataset.gkey;
          if (collapsed.has(key)) collapsed.delete(key);
          else collapsed.add(key);
          groupEl.classList.toggle('is-collapsed', collapsed.has(key));
        });

        mo.body.addEventListener('change', (e) => {
          if (e.target.matches('input[data-group]')) {
            const groupEl = e.target.closest('.pick-group');
            const on = e.target.checked;
            // 只勾选搜索过滤后仍在的条目；折叠不影响分组全选
            groupEl.querySelectorAll('.pick-item').forEach((it) => {
              if (it.style.display === 'none') return;
              const cb = it.querySelector('input[data-model]');
              if (cb) cb.checked = on;
            });
          }
          refresh();
        });

        mo.body.querySelector('[data-pick=all]').onclick = () => {
          activeVisibleBoxes().forEach((i) => { i.checked = true; });
          refresh();
        };
        mo.body.querySelector('[data-pick=none]').onclick = () => {
          activeBoxes().forEach((i) => { i.checked = false; });
          refresh();
        };
        mo.body.querySelector('[data-pick=expand]').onclick = () => {
          activeGroups().forEach((g) => {
            collapsed.delete(active + ':' + g.dataset.gkey);
            g.classList.remove('is-collapsed');
          });
          refresh();
        };
        mo.body.querySelector('[data-pick=collapse]').onclick = () => {
          activeGroups().forEach((g) => {
            collapsed.add(active + ':' + g.dataset.gkey);
            g.classList.add('is-collapsed');
          });
          refresh();
        };
        mo.foot.querySelector('[data-act=cancel]').onclick = () => mo.close();
        mo.foot.querySelector('[data-act=confirm]').onclick = () => {
          const checkedSet = new Set(boxes().filter((i) => i.checked).map((i) => i.dataset.model));
          // 保持原有顺序：已填写的按原顺序保留，新勾选的按上游顺序追加
          const final = before.filter((m) => checkedSet.has(m));
          models.forEach((m) => {
            if (checkedSet.has(m) && !beforeSet.has(m)) final.push(m);
          });
          mo.close();
          onConfirm(final);
        };
        refresh();
      },
    });
  }

  // ---------- 渠道编辑弹窗 ----------
  function openChannelEditor(ch) {
    const isNew = !ch;
    const data = ch || {
      id: '', name: '', type: 'openai', base_url: '', api_key: '', key_rows: [], append_v1: true,
      multi_key: false,
      key_mode: 'sequential', key_affinity: false, key_cooldown_sec: 300, key_cooldown_reset: false,
      key_cooldown_status: '',
      models: [], enabled: true, remark: '', headers: {},
    };
    const initialKeyRows = data.key_rows || [];
    // 旧数据没有 multi_key_enabled 时按 Key 数量推断，与后端规则保持一致。
    const multiKeyInit = data.multi_key_enabled !== undefined
      ? data.multi_key_enabled === true
      : initialKeyRows.length > 1;
    const keySchedHelpText = '顺序：按配置顺序尝试，未开亲和时从第一个可用 Key 开始。随机：每次请求完整打乱可用 Key 后再依次尝试。Key 亲和：上次成功的 Key 优先：顺序模式从它的位置开始顺延，随机模式先试它、其余打乱。失败冷却：Key 失败后在设定时间内跳过（0 = 不冷却）。全部冷却时重置：所有 Key 都在冷却时清空冷却，再按调度规则重试一遍。';
    const keyCooldownStatusHelpText = `支持单个状态码或区间，逗号分隔，例如 400-430、401,403,429。命中后该 Key 进入失败冷却；未命中的错误不会冷却 Key，但仍按模型的重试规则继续路由，全部 Key 失败后会冷却对应的渠道模型。留空表示任何状态码都不冷却 Key；点击「填入模板」填入 ${DEFAULT_KEY_COOLDOWN_STATUS}。`;

    const body = `
      <div class="form-row">
        <div class="field">
          <label class="field__label">渠道 ID<span class="req">*</span></label>
          <input class="input mono" id="f-id" value="${esc(data.id)}" placeholder="例如 A" ${isNew ? '' : 'disabled'}>
          <div class="field__hint">唯一标识，<b>不能包含 “/”</b>。${isNew ? '它会作为渠道模型的前缀。' : '创建后不可修改。'}</div>
        </div>
        <div class="field">
          <label class="field__label">渠道名称</label>
          <input class="input" id="f-name" value="${esc(data.name || '')}" placeholder="可选，例如 主线路">
        </div>
      </div>

      <div class="field">
        <label class="field__label">渠道类型<span class="req">*</span></label>
        <select class="select" id="f-type">
          ${CHANNEL_TYPES.map((t) => `<option value="${t.value}"${data.type === t.value ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}
        </select>
        <div class="field__hint" id="type-hint"></div>
      </div>

      <div class="field">
        <div class="flex-center gap-8" style="margin-bottom:5px">
          <label class="field__label" style="margin-bottom:0">接口地址（Base URL）<span class="req">*</span></label>
          <label class="switch ml-auto" style="white-space:nowrap">
            <input type="checkbox" id="f-append-v1" ${data.append_v1 !== false ? 'checked' : ''}>
            <span class="switch__track"></span>
            <span class="switch__label">自动补全 /v1</span>
          </label>
        </div>
        <input class="input mono" id="f-base" value="${esc(data.base_url || '')}" placeholder="https://api.openai.com">
        <div class="field__hint" id="base-hint">必填，<b>留空不会回退到官方地址</b>，必须自己填清楚。</div>
      </div>

      <div class="field">
        <div class="flex-center gap-8" style="margin-bottom:6px">
          <label class="field__label" style="margin-bottom:0">API Key<span class="req">*</span></label>
          <label class="switch ml-auto" style="white-space:nowrap">
            <input type="checkbox" id="f-multi-key" ${multiKeyInit ? 'checked' : ''}>
            <span class="switch__track"></span>
            <span class="switch__label">多 Key 模式</span>
          </label>
          <button class="btn btn--sm btn--icon" id="btn-eye" type="button" title="显示/隐藏" aria-label="显示或隐藏密钥">${icon('eye', 15)}</button>
        </div>
        <div class="key-rows${multiKeyInit ? '' : ' key-rows--single'}" id="f-key-rows">
          <div class="key-row key-row--head">
            <span>密钥</span><span>备注</span><span></span>
          </div>
        </div>
        <button class="btn btn--sm mt-8" id="btn-add-key" type="button"${multiKeyInit ? '' : ' hidden'}>${icon('plus', 13)}添加 Key</button>
        <div class="field__hint" id="f-key-hint">${multiKeyInit
          ? '已保存的密钥以掩码显示。<b>只改备注不会重新提交密钥</b>；清空某一行的密钥或删除整行，即删除对应的 Key。'
          : '已保存的密钥以掩码显示；清空密钥即删除该渠道的 Key。'}</div>
      </div>

      <div class="field" id="f-key-sched"${multiKeyInit ? '' : ' hidden'}>
        <div style="margin-bottom:6px">
          <label class="field__label" style="margin-bottom:0">Key 调度
            <button type="button" class="badge badge--blue badge--click field__help"
                    id="f-key-sched-help" title="${esc(keySchedHelpText)}" aria-label="查看 Key 调度规则">?</button>
          </label>
        </div>
        <div class="flex-center gap-12" style="flex-wrap:wrap">
          <select class="select" id="f-key-mode" style="width:110px">
            <option value="sequential"${(data.key_mode || 'sequential') === 'sequential' ? ' selected' : ''}>顺序</option>
            <option value="random"${data.key_mode === 'random' ? ' selected' : ''}>随机</option>
          </select>
          <label class="switch" style="white-space:nowrap">
            <input type="checkbox" id="f-key-affinity" ${data.key_affinity ? 'checked' : ''}>
            <span class="switch__track"></span>
            <span class="switch__label">Key 亲和</span>
          </label>
          <label class="switch" style="white-space:nowrap">
            <input type="checkbox" id="f-key-reset" ${data.key_cooldown_reset ? 'checked' : ''}>
            <span class="switch__track"></span>
            <span class="switch__label">全部冷却时重置</span>
          </label>
          <span class="muted fs-12">失败冷却</span>
          <input class="input" id="f-key-cooldown" type="number" min="0" max="86400"
                 value="${esc(String(data.key_cooldown_sec ?? 300))}" style="width:92px;height:30px;font-size:12.5px">
          <span class="muted fs-12">秒</span>
        </div>
        <div class="field__head" style="margin-top:12px">
          <label class="field__label" style="margin-bottom:0">触发 Key 冷却的状态码
            <button type="button" class="badge badge--blue badge--click field__help"
                    id="f-key-cooldown-status-help" title="${esc(keyCooldownStatusHelpText)}" aria-label="查看状态码规则">?</button>
          </label>
          <button type="button" class="btn btn--ghost btn--sm field__reset"
                  id="f-key-cooldown-status-template" title="填入常用模板">${icon('paste', 11)}填入模板</button>
        </div>
        <input class="input mono" id="f-key-cooldown-status"
               value="${esc(data.key_cooldown_status ?? '')}"
               placeholder="${DEFAULT_KEY_COOLDOWN_STATUS}">
      </div>

      <div class="field">
        <div class="flex-center gap-8" style="margin-bottom:6px">
          <label class="field__label" style="margin-bottom:0">可用模型</label>
          <div class="ml-auto"></div>
          <button class="btn btn--sm" id="btn-discover" type="button">${icon('wand', 13)}获取模型列表</button>
        </div>
        <textarea class="textarea" id="f-models" rows="6" placeholder="每行一个，或用逗号分隔&#10;a&#10;b&#10;c">${esc((data.models || []).join('\n'))}</textarea>
        <div class="field__hint">
          填上游真实的模型名，<b>可以先留空，之后随时回来补</b>。
          这里只记录名字本身，接入到「模型管理」后才会各自获得带渠道前缀的 ID。
        </div>
        <div class="mt-12" id="model-preview"></div>
      </div>

      <details class="mt-16 advanced-settings">
        <summary style="cursor:pointer;font-size:12.5px;font-weight:620;color:var(--text-2)">高级设置</summary>
        <div class="mt-12">
          <div class="form-row">
            <div class="field">
              <label class="field__label">状态</label>
              <div style="height:36px;display:flex;align-items:center">
                <label class="switch"><input type="checkbox" id="f-enabled" ${data.enabled ? 'checked' : ''}><span class="switch__track"></span><span class="switch__label">启用该渠道</span></label>
              </div>
            </div>
          </div>
          <div class="field">
            <label class="field__label">自定义请求头（JSON）</label>
            <textarea class="textarea" id="f-headers" rows="3" placeholder='{"X-Custom": "value"}'>${esc(Object.keys(data.headers || {}).length ? JSON.stringify(data.headers, null, 2) : '')}</textarea>
          </div>
          <div class="field">
            <label class="field__label">备注</label>
            <input class="input" id="f-remark" value="${esc(data.remark || '')}" placeholder="可选">
          </div>
        </div>
      </details>`;

    const footer = `<div class="spacer"></div>
      <button class="btn" data-act="cancel">取消</button>
      <button class="btn btn--primary" data-act="save">${isNew ? '创建渠道' : '保存修改'}</button>`;

    openModal({
      title: isNew ? '添加渠道' : `编辑渠道 · ${data.id}`,
      desc: isNew
        ? '填好接口地址和 API Key 就能直接从上游拉取模型列表；模型可以先不填，之后再补。'
        : '修改渠道配置。删除模型名不会自动改动模型管理，保存时会询问是否一并清理引用。',
      body, footer, size: 'lg',
      onMount(mo) {
        const $ = (sel) => mo.body.querySelector(sel);
        const idEl = $('#f-id');
        const typeEl = $('#f-type');
        const baseEl = $('#f-base');
        const modelsEl = $('#f-models');
        const keyRowsEl = $('#f-key-rows');
        const preview = $('#model-preview');

        $('#f-key-cooldown-status-template').onclick = () => {
          const input = $('#f-key-cooldown-status');
          input.value = DEFAULT_KEY_COOLDOWN_STATUS;
          input.focus();
        };
        $('#f-key-sched-help').onclick = () => {
          openHelpModal('Key 调度规则', `
            <div style="margin-bottom:8px"><b>顺序</b>：按配置顺序尝试，未开亲和时从第一个可用 Key 开始。</div>
            <div style="margin-bottom:8px"><b>随机</b>：每次请求完整打乱可用 Key 后再依次尝试。</div>
            <div style="margin-bottom:8px"><b>Key 亲和</b>：上次成功的 Key 优先。顺序模式从它的位置开始顺延，随机模式先试它、其余打乱。</div>
            <div style="margin-bottom:8px"><b>失败冷却</b>：Key 失败后在设定时间内跳过（0 = 不冷却）。</div>
            <div><b>全部冷却时重置</b>：所有 Key 都在冷却时清空冷却，再按调度规则重试一遍。</div>
          `);
        };
        $('#f-key-cooldown-status-help').onclick = () => {
          openHelpModal('Key 冷却状态码', `
            <div style="margin-bottom:8px">支持单个状态码或区间，逗号分隔，例如 <code>400-430</code>、<code>401,403,429</code>。</div>
            <div style="margin-bottom:8px">命中后该 Key 进入失败冷却；未命中的错误不会冷却 Key，但仍按模型的重试规则继续路由，全部 Key 失败后会冷却对应的渠道模型。</div>
            <div>留空表示任何状态码都不冷却 Key；点击「填入模板」填入 <code>${DEFAULT_KEY_COOLDOWN_STATUS}</code>。</div>
          `);
        };
        bindAdvancedState(mo.body, 'channel', data.id);

        // 两列 Key 表格：密钥一列、备注一列。已保存的 Key 只在用户主动改 Key
        // 时才提交新值，只改备注时请求里只有下标和备注。
        let keysVisible = false;
        const multiKeyEl = $('#f-multi-key');
        const keyHintEl = $('#f-key-hint');

        // 多 Key 模式关闭时只显示第一个 Key：隐藏后续行、删除按钮、添加按钮和 Key 调度。
        // 隐藏行仍会随表单一起提交，保存时不会丢掉其余 Key，重新打开开关可以继续编辑。
        // 单 Key 也保留备注列，方便只配一个 Key 时写备注。
        function applyMultiKeyMode() {
          const on = multiKeyEl.checked;
          keyRowsEl.classList.toggle('key-rows--single', !on);
          $('#btn-add-key').hidden = !on;
          $('#f-key-sched').hidden = !on;
          keyRowsEl.querySelectorAll('[data-key-row]').forEach((el, i) => {
            el.hidden = !on && i > 0;
          });
          keyHintEl.innerHTML = on
            ? '已保存的密钥以掩码显示。<b>只改备注不会重新提交密钥</b>；清空某一行的密钥或删除整行，即删除对应的 Key。'
            : '只使用第一个 Key，其余 Key 保留但不参与调度。清空密钥即删除该 Key。';
        }
        multiKeyEl.onchange = applyMultiKeyMode;

        function applyKeyMask() {
          keyRowsEl.querySelectorAll('.key-field').forEach((el) => {
            el.classList.toggle('key-masked', !keysVisible);
          });
        }

        function appendKeyRow(row) {
          const div = document.createElement('div');
          div.className = 'key-row';
          div.setAttribute('data-key-row', '');
          if (row && row.index !== undefined && row.index !== null) {
            div.dataset.index = String(row.index);
            div.dataset.masked = row.masked || '';
          }
          const idx = document.createElement('span');
          idx.className = 'key-row__index';

          const key = document.createElement('input');
          key.className = 'input mono key-field' + (keysVisible ? '' : ' key-masked');
          key.value = (row && row.masked) || '';
          key.placeholder = 'sk-...';
          key.autocomplete = 'off';
          key.spellcheck = false;
          key.name = 'ldm-upstream-credential';
          key.setAttribute('data-1p-ignore', '');
          key.setAttribute('data-lpignore', 'true');

          const keyWrap = document.createElement('div');
          keyWrap.className = 'key-wrap';
          keyWrap.append(idx, key);

          const note = document.createElement('input');
          note.className = 'input key-note';
          note.value = (row && row.note) || '';
          note.placeholder = '备注（可选）';

          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'btn btn--sm btn--icon btn--danger';
          del.title = '删除该 Key';
          del.setAttribute('aria-label', '删除该 Key');
          del.innerHTML = icon('trash', 13);
          del.dataset.keyDel = '1';

          div.append(keyWrap, note, del);
          keyRowsEl.appendChild(div);
          renumberKeyRows();
        }

        // Key 序号按当前行顺序实时重排：删除中间行后，后面的 # 会跟着前移。
        function renumberKeyRows() {
          keyRowsEl.querySelectorAll('[data-key-row]').forEach((el, i) => {
            const label = el.querySelector('.key-row__index');
            if (label) label.textContent = `#${i + 1}`;
          });
        }

        function renderKeyRows() {
          keyRowsEl.querySelectorAll('[data-key-row]').forEach((el) => el.remove());
          if (initialKeyRows.length) {
            initialKeyRows.forEach((row) => appendKeyRow(row));
          } else {
            appendKeyRow({});
          }
        }

        function collectKeyRows() {
          const rows = [];
          keyRowsEl.querySelectorAll('[data-key-row]').forEach((el) => {
            // 关闭多 Key 模式时隐藏行也提交，避免保存时把其余 Key 删掉。
            const key = (el.querySelector('.key-field').value || '').trim();
            const note = (el.querySelector('.key-note').value || '').trim();
            const idx = el.dataset.index;
            if (idx === undefined) {
              if (key) rows.push({ key, note });
              return;
            }
            const index = Number(idx);
            if (!key) {
              rows.push({ index, remove: true });
            } else if (key === el.dataset.masked) {
              // 密钥未被改动：只提交备注，不把掩码传回后端。
              rows.push({ index, note });
            } else {
              rows.push({ index, key, note });
            }
          });
          return rows;
        }

        renderKeyRows();
        applyMultiKeyMode();
        keyRowsEl.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-key-del]');
          if (!btn) return;
          const row = btn.closest('[data-key-row]');
          if (row) row.remove();
          renumberKeyRows();
          // 全部删完后保留一个空行，方便直接补新 Key。
          if (!keyRowsEl.querySelector('[data-key-row]')) appendKeyRow({});
        });
        $('#btn-add-key').onclick = () => {
          appendKeyRow({});
          const rows = keyRowsEl.querySelectorAll('[data-key-row]');
          const last = rows[rows.length - 1];
          if (last) last.querySelector('.key-field').focus();
        };

        const updateTypeHint = () => {
          const t = CHANNEL_TYPES.find((x) => x.value === typeEl.value);
          $('#type-hint').textContent = t ? t.hint : '';
        };
        updateTypeHint();
        typeEl.onchange = updateTypeHint;

        // 不是 password 类型，所以靠 CSS 遮罩来隐藏；点眼睛只切换密钥列
        $('#btn-eye').onclick = () => {
          keysVisible = !keysVisible;
          applyKeyMask();
          const first = keyRowsEl.querySelector('.key-field');
          if (first) first.focus();
        };

        const renderPreview = () => {
          const cid = (idEl.value || '').trim() || '渠道ID';
          const list = parseModels(modelsEl.value);
          if (!list.length) {
            preview.innerHTML = `<div class="field__hint">还没有填写模型。可以先保存渠道，之后再回来补。</div>`;
            return;
          }
          preview.innerHTML = `<div class="flex-center gap-8" style="margin-bottom:6px">
              <div class="section-title" style="margin-bottom:0">共 ${list.length} 个模型</div>
              <div class="ml-auto muted fs-12">点击模型名可复制</div>
            </div>
            <div class="badge-group">${list.map((m) => `<button type="button" class="badge badge--click mono" data-copy-model="${esc(m)}" title="点击复制">${esc(m)}</button>`).join('')}</div>
            <div class="field__hint" style="margin-top:8px">接入到「模型管理」后，它们会分别以
              ${list.slice(0, 3).map((m) => `<code>${esc(cid)}/${esc(m)}</code>`).join('、')}${list.length > 3 ? ' 等' : ''} 的形式出现。</div>`;
        };
        renderPreview();
        modelsEl.addEventListener('input', renderPreview);
        idEl.addEventListener('input', renderPreview);
        preview.addEventListener('click', (e) => {
          const el = e.target.closest('[data-copy-model]');
          if (el) copyText(el.dataset.copyModel, '模型名 ');
        });

        mo.foot.querySelector('[data-act=cancel]').onclick = () => mo.close();

        const discoverBtn = mo.body.querySelector('#btn-discover');
        discoverBtn.onclick = async () => {
          const base = baseEl.value.trim();
          const keyInputs = [...keyRowsEl.querySelectorAll('.key-field')];
          const keyInput = keyInputs.find((el) => el.value.trim());
          const key = keyInput ? keyInput.value.trim() : '';
          if (!base) {
            Toast.warn('请先填写接口地址');
            baseEl.focus();
            return;
          }
          if (!key) {
            Toast.warn('请先填写 API Key');
            if (keyInputs[0]) keyInputs[0].focus();
            return;
          }
          discoverBtn.disabled = true;
          discoverBtn.innerHTML = '<span class="spinner" style="width:12px;height:12px"></span>获取中…';
          try {
            const res = await API.post('/api/channels/discover', {
              id: (idEl.value || '').trim(),
              type: typeEl.value,
              base_url: base,
              api_key: key,
              append_v1: $('#f-append-v1').checked,
            });
            const list = res.models || [];
            if (!list.length) { Toast.warn('上游没有返回模型列表，请手动填写'); return; }
            const before = parseModels(modelsEl.value);
            await openFetchedModelsPicker({
              models: list,
              existing: before,
              onConfirm(final) {
                const beforeSet = new Set(before);
                const afterSet = new Set(final);
                const added = final.filter((m) => !beforeSet.has(m)).length;
                const removed = before.filter((m) => !afterSet.has(m)).length;
                modelsEl.value = final.join('\n');
                renderPreview();
                const parts = [`当前共 ${final.length} 个模型`];
                if (added) parts.push(`新增 ${added} 个`);
                if (removed) parts.push(`移除 ${removed} 个`);
                Toast.success(parts.join('，'), '模型列表已更新');
              },
            });
          } catch (e) {
            Toast.error(e.message, '获取失败');
          } finally {
            discoverBtn.disabled = false;
            discoverBtn.innerHTML = icon('wand', 13) + '获取模型列表';
          }
        };

        mo.foot.querySelector('[data-act=save]').onclick = async () => {
          const id = (idEl.value || '').trim();
          if (!id) { Toast.warn('请填写渠道 ID'); idEl.focus(); return; }
          if (id.includes('/')) { Toast.warn('渠道 ID 不能包含 “/”'); idEl.focus(); return; }
          const base = baseEl.value.trim();
          if (!base) { Toast.warn('请填写接口地址（Base URL）'); baseEl.focus(); return; }
          if (!base.includes('://')) { Toast.warn('接口地址需要带上 https:// 或 http://'); baseEl.focus(); return; }
          // 模型列表允许为空：可以先建好渠道，之后再回来补模型
          const models = parseModels(modelsEl.value);
          const keys = collectKeyRows();
          if (isNew && !keys.some((r) => !r.remove)) {
            Toast.warn('请填写 API Key');
            const first = keyRowsEl.querySelector('.key-field');
            if (first) first.focus();
            return;
          }
          let headers = {};
          const headersRaw = $('#f-headers').value.trim();
          if (headersRaw) {
            try { headers = JSON.parse(headersRaw); } catch (e) { Toast.warn('自定义请求头不是合法的 JSON'); return; }
          }
          const payload = {
            id, name: $('#f-name').value.trim(), type: typeEl.value,
            base_url: base, key_rows: keys, append_v1: $('#f-append-v1').checked, models,
            multi_key: multiKeyEl.checked,
            key_mode: $('#f-key-mode').value,
            key_affinity: $('#f-key-affinity').checked,
            key_cooldown_sec: Math.max(0, Math.min(86400, Math.round(Number($('#f-key-cooldown').value) || 0))),
            key_cooldown_reset: $('#f-key-reset').checked,
            key_cooldown_status: $('#f-key-cooldown-status').value.trim(),
            enabled: $('#f-enabled').checked,
            headers, remark: $('#f-remark').value.trim(),
          };
          const disabling = payload.enabled === false && !(ch && !ch.enabled);
          const saveBtn = mo.foot.querySelector('[data-act=save]');
          saveBtn.disabled = true;
          saveBtn.innerHTML = '<span class="spinner" style="width:13px;height:13px"></span>保存中';
          try {
            const res = await API.put('/api/channels/' + encodeURIComponent(id), payload);
            // 新建渠道时把本次的展开状态落到真实 ID，之后编辑同一个渠道能直接恢复。
            if (isNew) {
              try {
                const details = mo.body.querySelector('details.advanced-settings');
                localStorage.setItem(advancedKey('channel', id), details && details.open ? '1' : '0');
              } catch (e) { /* 忽略配额错误 */ }
            }
            mo.close();
            const refs = (res && res.refs) || [];
            if (refs.length) {
              const action = await confirmRemovedChannelRefs(id, refs);
              if (action !== 'prune') {
                Toast.success('渠道已保存，模型管理里的引用保持不变');
              }
            } else if (models.length === 0) {
              Toast.success(`渠道 ${id} 已保存。它还没有可用模型，记得之后回来补上`, '渠道已保存');
            } else {
              Toast.success(`渠道 ${id} 已保存，共 ${models.length} 个可用模型`);
            }
            if (disabling) showChannelDisabledNotice({ id, name: payload.name });
            State.invalidate('all');
            window.LDM.navigate();
          } catch (e) {
            Toast.error(e.message, '保存失败');
            saveBtn.disabled = false;
            saveBtn.textContent = isNew ? '创建渠道' : '保存修改';
          }
        };
      },
    });
  }

  // 渠道里删掉模型后，不直接改动模型管理；由用户确认是否清理仍被引用的条目。
  // closable: false 保证点空白处 / Esc 都不会关掉，必须明确选择保留还是移除。
  function confirmRemovedChannelRefs(channelID, refs) {
    return new Promise((resolve) => {
      const groups = new Map();
      refs.forEach((r) => {
        if (!groups.has(r.upstream)) groups.set(r.upstream, []);
        groups.get(r.upstream).push(r);
      });
      const upstreams = Array.from(groups.keys());
      const list = upstreams.map((upstream) => `
        <div class="mt-10">
          <div class="mono strong">${esc(upstream)}</div>
          <ul class="fs-12 muted" style="margin:4px 0 0 18px;padding:0">
            ${groups.get(upstream).map((r) => `<li>${r.type === 'custom_route'
              ? `自定义模型 <code>${esc(r.model_id)}</code> 中的路由`
              : `渠道模型 <code>${esc(r.model_id)}</code>`}</li>`).join('')}
          </ul>
        </div>`).join('');

      openModal({
        title: '渠道模型已被移除',
        size: 'sm',
        closable: false,
        body: `<div style="font-size:13.5px;line-height:1.7;color:var(--text-2)">
          渠道 <code>${esc(channelID)}</code> 的可用模型列表里已经移除了以下模型，但模型管理中仍有引用：
          ${list}
          <div class="mt-12">是否同时从模型管理里移除这些引用？</div>
          <div class="fs-12 muted mt-6">选择「保留引用」不会改动任何模型配置，之后也可以在模型管理里手动删除。</div>
        </div>`,
        footer: `<div class="spacer"></div>
          <button class="btn" data-act="keep">保留引用</button>
          <button class="btn btn--danger" data-act="prune">同时移除</button>`,
        onMount(mo) {
          mo.foot.querySelector('[data-act=keep]').onclick = () => mo.close('keep');
          const pruneBtn = mo.foot.querySelector('[data-act=prune]');
          pruneBtn.onclick = async () => {
            pruneBtn.disabled = true;
            pruneBtn.innerHTML = '<span class="spinner" style="width:13px;height:13px"></span>移除中';
            try {
              const res = await API.post(
                `/api/channels/${encodeURIComponent(channelID)}/prune-refs`,
                { upstreams }
              );
              const removed = (res && res.removed_models) || [];
              const updated = (res && res.updated_models) || [];
              Toast.success(
                `已移除 ${removed.length} 个渠道模型${updated.length ? `，并清理 ${updated.length} 个自定义模型的路由` : ''}`
              );
              mo.close('prune');
            } catch (e) {
              Toast.error(e.message, '移除失败');
              pruneBtn.disabled = false;
              pruneBtn.textContent = '同时移除';
            }
          };
        },
        onClose(result) { resolve(result || 'keep'); },
      });
    });
  }

  function parseModels(text) {
    const out = [];
    const seen = new Set();
    String(text || '').split(/[\n\r,;]+/).forEach((raw) => {
      const v = raw.trim();
      if (!v || seen.has(v)) return;
      seen.add(v);
      out.push(v);
    });
    return out;
  }

  // ======================================================================
  // 模型管理
  // ======================================================================
  const modelState = {
    type: 'all',      // all | custom | channel
    channel: 'all',   // all | 渠道 ID
    provider: 'all',  // all | none | 提供商 ID
    status: 'all',    // all | enabled | disabled | unavailable
    keyword: '',
    multi: false,
    selected: new Set(),
  };

  window.LDM.registerPage('models', {
    title: '模型管理',
    desc: '只有在这里添加过的模型才会对外开放调用',
    async render(root, actions) {
      const [models, channels, providers] = await Promise.all([
        State.loadModels(true),
        State.loadChannels(true),
        State.loadProviders(true),
      ]);
      const providerByID = {};
      providers.forEach((p) => { providerByID[p.id] = p; });

      // 多选模式退出后清理残留选择
      if (!modelState.multi) modelState.selected.clear();

      // 筛选区和表头固定，只让表格内容滚动
      root.classList.add('content__inner--fill');

      actions.innerHTML = `
        <button class="btn" id="btn-providers">${icon('box', 14)}提供商</button>
        <button class="btn" id="btn-clear-cooldowns">${icon('refresh', 14)}清除冷却</button>
        <button class="btn" id="btn-add-custom">${icon('route', 14)}添加自定义模型</button>
        <button class="btn btn--primary" id="btn-add-model">${icon('plus', 15)}添加模型</button>`;
      actions.querySelector('#btn-add-model').onclick = () => openAddModelsDialog();
      actions.querySelector('#btn-add-custom').onclick = () => openCustomModelDialog(null);
      actions.querySelector('#btn-providers').onclick = () => openProvidersDialog();
      actions.querySelector('#btn-clear-cooldowns').onclick = async () => {
        const ok = await confirmDialog({
          title: '清除所有冷却',
          message: `将清空内存中所有路由的失败冷却状态，冷却中的条目会立即恢复可用。<br><br>
            只影响当前进程的运行时状态，不会修改模型配置。`,
          confirmText: '清除冷却',
        });
        if (!ok) return;
        try {
          const res = await API.post('/api/models/clear-cooldowns');
          const n = res && res.cleared ? res.cleared : 0;
          Toast.success(n ? `已清除 ${n} 条路由冷却` : '当前没有处于冷却中的路由');
        } catch (e) { Toast.error(e.message); }
      };

      const customCount = models.filter((m) => m.type === 'custom').length;
      const channelCount = models.filter((m) => m.type === 'channel').length;

      // 模型实际用到的渠道：渠道模型看 channel_id，自定义模型看路由里的 channel_id
      const modelChannels = (m) => {
        const ids = m.type === 'channel' ? [m.channel_id] : (m.routes || []).map((r) => r.channel_id);
        return Array.from(new Set(ids.filter(Boolean)));
      };

      // 渠道下拉跟随类型：全部模型列出所有渠道，自定义/渠道模型只列出该类型实际用到的渠道
      const channelOrder = new Map(channels.map((c, i) => [c.id, i]));
      const channelOptionsFor = (type) => {
        const ids = type === 'all' ? channels.map((c) => c.id) : [];
        models.forEach((m) => {
          if (type !== 'all' && m.type !== type) return;
          modelChannels(m).forEach((cid) => {
            if (!ids.includes(cid)) ids.push(cid);
          });
        });
        ids.sort((a, b) => {
          const ia = channelOrder.has(a) ? channelOrder.get(a) : Number.MAX_SAFE_INTEGER;
          const ib = channelOrder.has(b) ? channelOrder.get(b) : Number.MAX_SAFE_INTEGER;
          return ia - ib || a.localeCompare(b);
        });
        return [
          ['all', '全部渠道'],
          ...ids.map((cid) => {
            const ch = channels.find((c) => c.id === cid);
            const name = ch && ch.name && ch.name !== cid ? `（${ch.name}）` : '';
            return [cid, `${cid}${name}`];
          }),
        ];
      };

      // 提供商计数：provider_id 为空或指向已删除的提供商时归入「未设置」
      const providerCounts = {};
      models.forEach((m) => {
        const pid = m.provider_id && providerByID[m.provider_id] ? m.provider_id : '';
        providerCounts[pid] = (providerCounts[pid] || 0) + 1;
      });
      const providerOptions = [
        ['all', '全部提供商'],
        ['none', `未设置（${providerCounts[''] || 0}）`],
        ...providers
          .filter((p) => providerCounts[p.id])
          .map((p) => [p.id, `${p.name}（${providerCounts[p.id]}）`]),
      ];

      // 状态计数：启用且真正可用才算「可用」，其余启用中的归入「不可用」
      const statusCounts = { enabled: 0, disabled: 0, unavailable: 0 };
      models.forEach((m) => {
        if (!m.enabled) statusCounts.disabled += 1;
        else if (m.channel_ready) statusCounts.enabled += 1;
        else statusCounts.unavailable += 1;
      });
      const statusOptions = [
        ['all', '全部状态'],
        ['enabled', `可用（${statusCounts.enabled}）`],
        ['disabled', `已禁用（${statusCounts.disabled}）`],
        ['unavailable', `不可用（${statusCounts.unavailable}）`],
      ];

      const typeOptions = [
        ['all', `全部模型（${models.length}）`],
        ['custom', `自定义模型（${customCount}）`],
        ['channel', `渠道模型（${channelCount}）`],
      ];

      // 记住的筛选值如果已经不在选项里（渠道/提供商被删），回落到「全部」
      const ensureValue = (key, opts) => {
        if (!opts.some(([v]) => v === modelState[key])) modelState[key] = 'all';
      };
      ensureValue('type', typeOptions);
      let channelOptions = channelOptionsFor(modelState.type);
      ensureValue('channel', channelOptions);
      ensureValue('provider', providerOptions);
      ensureValue('status', statusOptions);

      const filterSelect = (id, label, key, opts, width) => `
        <select class="select" id="${id}" aria-label="${label}" style="width:${width}">
          ${opts.map(([v, text]) => `<option value="${esc(v)}"${modelState[key] === v ? ' selected' : ''}>${esc(text)}</option>`).join('')}
        </select>`;

      root.innerHTML = `
        <div class="card models-card" style="overflow:visible">
          <div class="toolbar" style="border-bottom:none;padding-bottom:5px">
            ${filterSelect('f-type', '模型类型', 'type', typeOptions, '150px')}
            ${filterSelect('f-channel', '渠道', 'channel', channelOptions, '210px')}
            ${filterSelect('f-provider', '提供商', 'provider', providerOptions, '170px')}
            ${filterSelect('f-status', '启用状态', 'status', statusOptions, '145px')}
          </div>
          <div class="toolbar" style="padding-top:5px">
            <div class="search" style="flex:0 1 320px">
              <span class="search__icon">${icon('search', 15)}</span>
              <input class="input" id="model-search" placeholder="搜索模型 ID…" value="${esc(modelState.keyword)}">
            </div>
            <div class="toolbar__spacer"></div>
            <span class="muted fs-12" id="filter-count" ${modelState.multi ? 'style="display:none"' : ''}></span>
            <button class="btn btn--sm" id="btn-multi" style="${modelState.multi ? 'display:none' : ''}">${icon('check', 13)}多选</button>
            <span class="muted fs-12" id="multi-count" style="${modelState.multi ? '' : 'display:none'}">已选 ${modelState.selected.size} 个</span>
            <button class="btn btn--sm" id="m-enable" style="${modelState.multi ? '' : 'display:none'}">${icon('play', 13)}启用</button>
            <button class="btn btn--sm" id="m-disable" style="${modelState.multi ? '' : 'display:none'}">${icon('pause', 13)}禁用</button>
            <button class="btn btn--sm" id="m-provider" style="${modelState.multi ? '' : 'display:none'}">${icon('box', 13)}设置提供商</button>
            <button class="btn btn--sm" id="m-cooldown" style="${modelState.multi ? '' : 'display:none'}">${icon('refresh', 13)}清除冷却</button>
            <button class="btn btn--sm btn--danger" id="m-del" style="${modelState.multi ? '' : 'display:none'}">${icon('trash', 13)}删除</button>
            <button class="btn btn--sm btn--ghost" id="m-exit" style="${modelState.multi ? '' : 'display:none'}">${icon('x', 13)}退出多选</button>
          </div>
          <div id="model-table"></div>
        </div>`;

      const renderTable = () => {
        const kw = modelState.keyword.trim().toLowerCase();
        let list = models.filter((m) => {
          if (modelState.type === 'custom' && m.type !== 'custom') return false;
          if (modelState.type === 'channel' && m.type !== 'channel') return false;
          if (modelState.channel !== 'all' && !modelChannels(m).includes(modelState.channel)) return false;
          if (modelState.provider === 'none') {
            if (m.provider_id && providerByID[m.provider_id]) return false;
          } else if (modelState.provider !== 'all') {
            if (m.provider_id !== modelState.provider) return false;
          }
          if (modelState.status === 'enabled') {
            if (!m.enabled || !m.channel_ready) return false;
          } else if (modelState.status === 'disabled') {
            if (m.enabled) return false;
          } else if (modelState.status === 'unavailable') {
            if (!m.enabled || m.channel_ready) return false;
          }
          if (kw) {
            const hay = (m.id + ' ' + (m.display_name || '') + ' ' + (m.channel_name || '') + ' ' + (m.provider_name || '')).toLowerCase();
            if (!hay.includes(kw)) return false;
          }
          return true;
        });

        const host = root.querySelector('#model-table');
        root.querySelector('#filter-count').textContent = `共 ${list.length} 个模型`;

        if (!list.length) {
          host.innerHTML = emptyState(
            models.length === 0 ? '还没有添加任何模型' : '没有符合条件的模型',
            models.length === 0
              ? '点击右上角「添加模型」，从已配置渠道派生出的渠道模型里批量选择，或者创建自定义模型把多个渠道模型组合成一个入口。'
              : '试试调整筛选条件或清空搜索关键词。',
            models.length === 0
              ? `<div class="btn-row" style="justify-content:center">
                   <button class="btn btn--primary" id="e-add">${icon('plus', 15)}添加模型</button>
                   <button class="btn" id="e-custom">${icon('route', 14)}添加自定义模型</button>
                 </div>`
              : '',
            'models'
          );
          const a = host.querySelector('#e-add');
          const b = host.querySelector('#e-custom');
          if (a) a.onclick = () => openAddModelsDialog();
          if (b) b.onclick = () => openCustomModelDialog(null);
          return;
        }

        host.innerHTML = `<div class="table-wrap" style="border:none;border-radius:0">
          <table class="tbl">
            <thead><tr>
              ${modelState.multi ? '<th style="width:34px"><input type="checkbox" id="m-checkall" aria-label="全选"></th>' : ''}
              <th style="min-width:200px">模型 ID</th>
              <th>类型</th>
              <th>提供商</th>
              <th style="min-width:180px">来源</th>
              <th style="min-width:200px">能力</th>
              <th>状态</th>
              ${modelState.multi ? '' : '<th style="width:150px"></th>'}
            </tr></thead>
            <tbody>${list.map((m) => modelRow(m, channels, providerByID)).join('')}</tbody>
          </table>
        </div>`;

        // 多选模式：行勾选 / 表头全选 / 点击整行切换选中
        if (modelState.multi) {
          const toggleRow = (mid) => {
            if (modelState.selected.has(mid)) modelState.selected.delete(mid);
            else modelState.selected.add(mid);
          };
          const syncBar = () => {
            root.querySelector('#multi-count').textContent = `已选 ${modelState.selected.size} 个`;
            const all = host.querySelectorAll('input[data-msel]');
            const checked = [...all].filter((i) => i.checked);
            const checkall = host.querySelector('#m-checkall');
            if (checkall) {
              checkall.checked = all.length > 0 && checked.length === all.length;
              checkall.indeterminate = checked.length > 0 && checked.length < all.length;
            }
          };
          host.querySelectorAll('input[data-msel]').forEach((cb) => {
            cb.checked = modelState.selected.has(cb.dataset.mid);
            cb.closest('tr').classList.toggle('is-selected', cb.checked);
            cb.addEventListener('change', () => {
              // 复选框自身点击后已切换，这里只同步集合
              if (cb.checked) modelState.selected.add(cb.dataset.mid);
              else modelState.selected.delete(cb.dataset.mid);
              cb.closest('tr').classList.toggle('is-selected', cb.checked);
              syncBar();
            });
          });
          // 点击整行切换选中；行内按钮和复选框自身不触发（避免双切）
          host.querySelector('tbody').addEventListener('click', (e) => {
            if (e.target.closest('button, a, input, .badge')) return;
            const tr = e.target.closest('tr[data-rowid]');
            if (!tr) return;
            const mid = tr.dataset.rowid;
            toggleRow(mid);
            const cb = tr.querySelector('input[data-msel]');
            if (cb) cb.checked = modelState.selected.has(mid);
            tr.classList.toggle('is-selected', modelState.selected.has(mid));
            syncBar();
          });
          const checkall = host.querySelector('#m-checkall');
          if (checkall) checkall.addEventListener('change', () => {
            host.querySelectorAll('input[data-msel]').forEach((cb) => {
              cb.checked = checkall.checked;
              if (checkall.checked) modelState.selected.add(cb.dataset.mid);
              else modelState.selected.delete(cb.dataset.mid);
            });
            syncBar();
          });
          syncBar();
        } else {
          // 普通模式：点击整行打开详情抽屉；多选模式下整行点击用于切换选中，不打开抽屉。
          host.querySelector('tbody').addEventListener('click', (e) => {
            if (e.target.closest('button, a, input, label')) return;
            const tr = e.target.closest('tr[data-rowid]');
            if (!tr) return;
            const m = models.find((x) => x.id === tr.dataset.rowid);
            if (m) openModelDetail(m);
          });
        }

        host.querySelectorAll('[data-mact]').forEach((btn) => {
          btn.onclick = async () => {
            const m = models.find((x) => x.id === btn.dataset.mid);
            if (!m) return;
            const act = btn.dataset.mact;
            if (act === 'edit') {
              if (m.type === 'custom') openCustomModelDialog(m);
              else openChannelModelEditor(m);
            } else if (act === 'test') await testModel(m, btn);
            else if (act === 'toggle') await toggleModel(m);
            else if (act === 'del') await removeModel(m);
            else if (act === 'copy') copyText(m.id, '模型 ID ');
          };
        });
      };

      // 下拉筛选：原生 select 由 Select 组件自动增强，直接监听 change 即可
      const typeEl = root.querySelector('#f-type');
      typeEl.addEventListener('change', () => {
        modelState.type = typeEl.value;
        channelOptions = channelOptionsFor(modelState.type);
        ensureValue('channel', channelOptions);
        const channelEl = root.querySelector('#f-channel');
        channelEl.innerHTML = channelOptions.map(([v, text]) =>
          `<option value="${esc(v)}"${modelState.channel === v ? ' selected' : ''}>${esc(text)}</option>`).join('');
        window.LDM.Select.sync(channelEl);
        renderTable();
      });
      [['f-channel', 'channel'], ['f-provider', 'provider'], ['f-status', 'status']]
        .forEach(([id, key]) => {
          const el = root.querySelector('#' + id);
          el.addEventListener('change', () => {
            modelState[key] = el.value;
            renderTable();
          });
        });
      const searchEl = root.querySelector('#model-search');
      searchEl.addEventListener('input', debounce(() => {
        modelState.keyword = searchEl.value;
        renderTable();
      }, 180));

      // ---------- 多选模式（单条工具栏内切换按钮组） ----------
      const applyMulti = () => {
        const set = (id, show) => {
          const el = root.querySelector('#' + id);
          if (el) el.style.display = show ? '' : 'none';
        };
        set('filter-count', !modelState.multi);
        set('btn-multi', !modelState.multi);
        set('multi-count', modelState.multi);
        set('m-enable', modelState.multi);
        set('m-disable', modelState.multi);
        set('m-provider', modelState.multi);
        set('m-cooldown', modelState.multi);
        set('m-del', modelState.multi);
        set('m-exit', modelState.multi);
        renderTable();
      };
      root.querySelector('#btn-multi').onclick = () => {
        modelState.multi = true;
        applyMulti();
      };
      root.querySelector('#m-exit').onclick = () => {
        modelState.multi = false;
        modelState.selected.clear();
        applyMulti();
      };

      const getSelectedModels = () =>
        models.filter((m) => modelState.selected.has(m.id));

      // 批量操作完成后留在多选模式：刷新数据重渲染，选中集保持
      const refreshAfterBatch = async (msg) => {
        Toast.success(msg);
        State.invalidate('models');
        await State.loadModels(true);
        // 移除已不存在的模型的选择
        const alive = new Set(State.models.map((m) => m.id));
        [...modelState.selected].filter((id) => !alive.has(id)).forEach((id) => modelState.selected.delete(id));
        // 当前页面的 models 引用已随 render 重建，重走导航
        window.LDM.navigate();
      };

      root.querySelector('#m-enable').onclick = async () => {
        const sel = getSelectedModels().filter((m) => !m.enabled);
        if (!sel.length) { Toast.info('选中的模型都已启用'); return; }
        try {
          for (const m of sel) {
            await API.put('/api/models/' + encodeURIComponent(m.id), { enabled: true });
          }
          await refreshAfterBatch(`已启用 ${sel.length} 个模型`);
        } catch (e) { Toast.error(e.message); }
      };
      root.querySelector('#m-disable').onclick = async () => {
        const sel = getSelectedModels().filter((m) => m.enabled);
        if (!sel.length) { Toast.info('选中的模型都已禁用'); return; }
        try {
          for (const m of sel) {
            await API.put('/api/models/' + encodeURIComponent(m.id), { enabled: false });
          }
          await refreshAfterBatch(`已禁用 ${sel.length} 个模型`);
        } catch (e) { Toast.error(e.message); }
      };
      root.querySelector('#m-provider').onclick = async () => {
        const sel = getSelectedModels();
        if (!sel.length) { Toast.info('请先勾选模型'); return; }
        const choice = await chooseProviderDialog({
          title: '设置提供商',
          desc: `将为选中的 ${sel.length} 个模型设置提供商。`,
          providers,
          current: '',
        });
        if (choice === null) return;
        try {
          await API.post('/api/models/batch-provider', {
            ids: sel.map((m) => m.id),
            provider_id: choice === '__auto' ? '' : choice,
            auto: choice === '__auto',
          });
          State.invalidate('models');
          State.invalidate('providers');
          const label = choice === '__auto'
            ? '已按模型名自动识别提供商'
            : choice === '' ? '已清空提供商' : '已更新提供商';
          await refreshAfterBatch(`${label}（${sel.length} 个模型）`);
        } catch (e) { Toast.error(e.message); }
      };
      root.querySelector('#m-cooldown').onclick = async () => {
        const sel = getSelectedModels();
        if (!sel.length) { Toast.info('请先勾选模型'); return; }
        try {
          const res = await API.post('/api/models/clear-cooldowns', { model_ids: sel.map((m) => m.id) });
          const n = res && res.cleared ? res.cleared : 0;
          if (n) Toast.success(`已清除 ${n} 条路由冷却`);
          else Toast.info('选中的模型没有处于冷却中的路由');
        } catch (e) { Toast.error(e.message); }
      };
      root.querySelector('#m-del').onclick = async () => {
        const sel = getSelectedModels();
        if (!sel.length) { Toast.info('请先勾选模型'); return; }
        const ok = await confirmDialog({
          title: '删除选中模型',
          message: `确定删除选中的 <b>${sel.length}</b> 个模型吗？删除后这些模型将无法被调用。<br><br>该操作不可撤销。`,
          confirmText: `删除（${sel.length}）`,
          danger: true,
        });
        if (!ok) return;
        try {
          for (const m of sel) {
            await API.del('/api/models/' + encodeURIComponent(m.id));
          }
          await refreshAfterBatch(`已删除 ${sel.length} 个模型`);
        } catch (e) { Toast.error(e.message); }
      };

      renderTable();
    },
  });

  function modelRow(m, channels, providerByID) {
    const isCustom = m.type === 'custom';
    const provider = providerByID[m.provider_id];
    const statusHtml = (() => {
      if (!m.enabled) return statusBadge(false, '', '已禁用');
      if (m.status === 'channel_disabled') return badge('渠道已禁用', 'red');
      if (m.status === 'channel_missing' || m.status === 'model_missing') return badge('渠道模型不存在', 'red');
      if (m.status === 'ok') return statusBadge(true, '可用');
      return badge('不可用', 'red');
    })();
    let sourceHtml;
    if (isCustom) {
      if (m.routes && m.routes.length) {
        const routeStr = m.routes.map((r) => r.model_id).join(' → ');
        sourceHtml = `<div class="truncate" style="max-width:280px;font-family:var(--mono);font-size:11.5px" title="${esc(routeStr)}">${esc(routeStr)}</div>`;
      } else {
        sourceHtml = '<span class="badge badge--red">未配置路由</span>';
      }
    } else {
      const ch = channels.find((c) => c.id === m.channel_id);
      sourceHtml = `<span class="code">${esc(m.channel_id)}</span>${ch && ch.name ? `<span class="muted fs-12">${esc(ch.name)}</span>` : ''}`;
    }

    // 路由摘要：N 组 / M 条，附带亲和标记
    const groupCount = isCustom && m.routes ? new Set(m.routes.filter((r) => r.group).map((r) => r.group)).size : 0;
    const stratLabel = isCustom && m.routes && m.routes.length
      ? (groupCount ? `${groupCount} 组 ${m.routes.length} 条` : `${m.routes.length} 条顺序`)
      : '';
    const multi = modelState.multi;

    return `<tr class="${multi ? 'is-selectable' : ''}" data-rowid="${esc(m.id)}">
      ${multi ? `<td><input type="checkbox" data-msel data-mid="${esc(m.id)}" aria-label="选择 ${esc(m.id)}"></td>` : ''}
      <td>
        <div class="flex-center gap-8">
          ${providerIcon(provider && provider.icon, 16)}
          <span class="mono strong" style="word-break:break-all">${esc(m.id)}</span>
          <button class="btn btn--ghost btn--sm btn--icon" data-mact="copy" data-mid="${esc(m.id)}" title="复制 ID">${icon('copy', 12)}</button>
        </div>
      </td>
      <td>${isCustom
        ? badge('自定义', 'pink')
        : badge('渠道', 'blue')}
        ${isCustom && stratLabel ? `<div style="margin-top:4px">${badge(stratLabel + '路由', 'gray')}${m.affinity ? ' ' + badge('亲和', 'gray') : ''}</div>` : ''}
      </td>
      <td>${provider
        ? `<span class="provider-tag">${providerIcon(provider.icon, 15)}${esc(provider.name)}</span>`
        : '<span class="muted fs-12">未设置</span>'}</td>
      <td>${sourceHtml}</td>
      <td>
        ${window.LDM.capBadges(m.caps, { showNeg: true })}
      </td>
      <td>${statusHtml}</td>
      ${multi ? '' : `<td>
        <div class="row-actions">
          <button class="btn btn--sm btn--icon" data-mact="test" data-mid="${esc(m.id)}" title="测试模型" aria-label="测试模型">${icon('zap', 13)}</button>
          <button class="btn btn--sm btn--icon" data-mact="toggle" data-mid="${esc(m.id)}" title="${m.enabled ? '禁用' : '启用'}" aria-label="${m.enabled ? '禁用模型' : '启用模型'}">${m.enabled ? icon('pause', 13) : icon('play', 13)}</button>
          <button class="btn btn--sm btn--icon" data-mact="edit" data-mid="${esc(m.id)}" title="编辑" aria-label="编辑模型">${icon('edit', 13)}</button>
          <button class="btn btn--sm btn--icon btn--danger" data-mact="del" data-mid="${esc(m.id)}" title="删除" aria-label="删除模型">${icon('trash', 13)}</button>
        </div>
      </td>`}
    </tr>`;
  }

  // 模型管理里的条目复用模型广场的详情抽屉；统计信息从 /api/plaza 取。
  async function openModelDetail(m) {
    let item = null;
    try {
      const plaza = await API.get('/api/plaza');
      item = (plaza || []).find((x) => x.id === m.id) || null;
    } catch (e) { /* 取不到统计时退回模型管理里的数据 */ }
    if (!item) {
      item = {
        ...m,
        caps: m.caps || {},
        available: m.enabled && m.channel_ready,
        source: m.type === 'channel'
          ? m.channel_id + (m.channel_name ? `（${m.channel_name}）` : '')
          : (m.routes || []).map((r) => r.model_id).join(' → '),
        requests_24h: 0,
        errors_24h: 0,
        success_rate: -1,
      };
    }
    if (window.LDM.openModelDrawer) window.LDM.openModelDrawer(item);
    else Toast.warn('详情面板暂不可用');
  }

  async function toggleModel(m) {
    try {
      await API.put('/api/models/' + encodeURIComponent(m.id), { enabled: !m.enabled });
      Toast.success(`模型 ${m.id} 已${m.enabled ? '禁用' : '启用'}`);
      State.invalidate('models');
      window.LDM.navigate();
    } catch (e) { Toast.error(e.message); }
  }

  async function removeModel(m) {
    const ok = await confirmDialog({
      title: '删除模型',
      message: `确定删除模型 <b>${esc(m.id)}</b> 吗？删除后该模型将无法被调用。<br><br>该操作不可撤销。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await API.del('/api/models/' + encodeURIComponent(m.id));
      Toast.success(`模型 ${m.id} 已删除`);
      State.invalidate('models');
      window.LDM.navigate();
    } catch (e) { Toast.error(e.message); }
  }

  // ---------- 模型测试 ----------
  // 用一次真实的最小调用验证模型是否可用，结果直接展示在 toast 里：
  // 耗时、落到的渠道、Token 用量，以及上游返回的正文。
  async function testModel(m, btn) {
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:12px;height:12px"></span>';
    try {
      const res = await API.post('/api/models/test', { id: m.id });
      const head = `耗时 ${res.latency_ms} ms`;
      const route = res.channel_id
        ? `渠道 ${res.channel_id} → 上游模型 ${res.upstream_model || '—'}`
        : '';
      if (res.ok) {
        const meta = [
          head,
          route,
          res.total_tokens
            ? `Token 用量 ${res.total_tokens}（输入 ${res.prompt_tokens} / 输出 ${res.completion_tokens}）`
            : '',
        ].filter(Boolean).join('\n');
        Toast.show('success', `「${m.id}」测试通过`, `${meta}\n\n上游返回：\n${res.content || '（空响应）'}`, 16000);
      } else {
        const meta = [head, route, `HTTP ${res.status_code}`].filter(Boolean).join('\n');
        Toast.show('error', `「${m.id}」测试失败`, `${meta}\n\n${res.error || '未知错误'}`, 16000);
      }
    } catch (e) {
      Toast.error(e.message, `「${m.id}」测试失败`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = old;
    }
  }

  // ---------- 模型选择弹窗（添加模型 / 自定义模型路由 / 令牌模型权限共用） ----------
  // mode='add'   ：列出全部渠道模型，已添加的置灰；确认后走批量添加。
  // mode='route' ：列出全部渠道模型（含未添加的），当前路由默认勾选；
  //                「已添加」徽章取打开弹窗时的路由草稿快照，本次会话内不随勾选变化；
  //                未添加的渠道模型只作为路由目标，不会加入模型列表；确认后替换路由。
  // mode='models'：列出「模型管理」中已启用的模型，供令牌的模型权限勾选；
  //                自定义模型归到「自定义模型」分组，确认后回传模型 ID 列表。
  // 支持按渠道 / 按提供商两种分组方式，两种视图各自记住折叠状态。
  async function openModelPicker(cfg) {
    const { mode, title, desc, preselected, top, onConfirm } = cfg;
    const isModels = mode === 'models';
    let list;
    let providers = [];
    try {
      if (isModels) {
        let models;
        [models, providers] = await Promise.all([
          API.get('/api/models'),
          State.loadProviders().catch(() => []),
        ]);
        list = (models || []).filter((m) => m.enabled).map((m) => ({
          id: m.id,
          channel_id: m.channel_id || '',
          channel_name: m.channel_name || '',
          upstream: m.upstream || '',
          channel_ready: m.channel_ready !== false,
          provider_id: m.provider_id || '',
          provider_name: m.provider_name || '',
          provider_icon: m.provider_icon || '',
          model_type: m.type,
        }));
      } else {
        [list, providers] = await Promise.all([
          API.get('/api/models/available'),
          State.loadProviders().catch(() => []),
        ]);
      }
    } catch (e) { Toast.error(e.message); return; }

    if (!list.length) {
      openModal({
        title,
        size: 'sm',
        top,
        body: `<div class="alert alert--warn">${icon('alert', 15)}<div>
          ${isModels
            ? '当前没有已启用的模型。<br>请先到「模型管理」添加模型并启用。'
            : mode === 'add'
              ? '当前没有任何渠道模型可用。<br>请先到「渠道管理」添加渠道，并在渠道里填写模型名。'
              : '当前没有任何渠道模型可用。<br>请先到「渠道管理」添加渠道，并在渠道里填写模型名，之后就能直接选作路由目标。'}
        </div></div>`,
        footer: `<div class="spacer"></div><button class="btn btn--primary" data-close>知道了</button>`,
      });
      return;
    }

    const isAdd = mode === 'add';
    const checkedSet = preselected || new Set();
    const chanName = {};
    list.forEach((it) => { if (it.channel_name) chanName[it.channel_id] = it.channel_name; });
    const providerByID = {};
    (providers || []).forEach((p) => { providerByID[p.id] = p; });
    // 渠道模型带了提供商名称但提供商已被删除时，仍用名称兜底显示
    const providerMeta = {};
    list.forEach((it) => {
      if (it.provider_id && !providerByID[it.provider_id] && it.provider_name) {
        providerMeta[it.provider_id] = { name: it.provider_name, icon: it.provider_icon || '' };
      }
    });

    // 按渠道分组，标题用「渠道ID（渠道名）」，渠道 ID 和名称用不同样式区分；
    // 令牌模型权限里还会出现没有渠道的自定义模型，统一归到「自定义模型」并排在最后
    const channelGroups = () => {
      const map = new Map();
      list.forEach((it) => {
        const cid = it.channel_id || '';
        if (!map.has(cid)) map.set(cid, []);
        map.get(cid).push(it);
      });
      const keys = Array.from(map.keys()).sort((a, b) => {
        if (!a) return 1;
        if (!b) return -1;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      return keys.map((cid) => {
        if (!cid) {
          return {
            key: 'c:__custom',
            icon: '',
            nameHtml: '自定义模型',
            items: map.get(cid),
          };
        }
        return {
          key: 'c:' + cid,
          icon: '',
          nameHtml: `<span class="pick-group__id">${esc(cid)}</span>${chanName[cid] ? `（${esc(chanName[cid])}）` : ''}`,
          items: map.get(cid),
        };
      });
    };

    // 按提供商分组：按提供商配置顺序排列，未识别的统一放到最后
    const providerGroups = () => {
      const map = new Map();
      list.forEach((it) => {
        const pid = it.provider_id || '';
        if (!map.has(pid)) map.set(pid, []);
        map.get(pid).push(it);
      });
      const order = (providers || []).map((p) => p.id).filter((pid) => map.has(pid));
      Array.from(map.keys()).forEach((pid) => {
        if (pid && !order.includes(pid)) order.push(pid);
      });
      if (map.has('')) order.push('');
      return order.map((pid) => {
        const p = providerByID[pid] || providerMeta[pid];
        return {
          key: 'p:' + (pid || '__none'),
          icon: p ? (p.icon || '') : '',
          nameHtml: pid
            ? esc((p && p.name) || pid)
            : '<span class="muted">未识别提供商</span>',
          items: map.get(pid),
        };
      });
    };

    const groupBuilders = { channel: channelGroups, provider: providerGroups };
    let groupBy = 'channel';
    const currentGroups = () => groupBuilders[groupBy]();
    // 两种分组、两种模式都默认全部折叠，先看分组概览
    const collapsedState = {
      channel: new Set(channelGroups().map((g) => g.key)),
      provider: new Set(providerGroups().map((g) => g.key)),
    };
    const collapsed = () => collapsedState[groupBy];

    const itemHtml = (it) => {
      const disabled = isAdd && it.added;
      const checked = checkedSet.has(it.id);
      return `<label class="pick-item${disabled ? ' is-disabled' : ''}"
             data-search="${esc((it.id + ' ' + (it.upstream || '') + ' ' + (it.channel_name || '') + ' ' + (it.provider_name || '')).toLowerCase())}">
        <input type="checkbox" data-id="${esc(it.id)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
        ${it.provider_name && groupBy !== 'provider' ? `<span class="pick-item__provider" title="${esc(it.provider_name)}">${providerIcon(it.provider_icon, 14)}</span>` : ''}
        <span class="pick-item__name">${esc(it.id)}</span>
        <span class="pick-item__meta">
          ${!it.channel_ready ? badge(isModels ? '不可用' : '渠道已禁用', 'red') : ''}
          ${isModels
            ? (it.model_type === 'custom' ? badge('自定义', 'pink') : badge('渠道', 'blue'))
            : isAdd
              ? (it.added ? badge('已添加', 'green') : '')
              : (checked ? badge('已添加', 'green') : '')}
        </span>
      </label>`;
    };

    const groupHtml = (g) => `
      <div class="pick-group${collapsed().has(g.key) ? ' is-collapsed' : ''}" data-gkey="${esc(g.key)}">
        <div class="pick-group__head">
          <span class="pick-group__arrow">\u25be</span>
          <input type="checkbox" data-group>
          ${g.icon ? providerIcon(g.icon, 14) : ''}
          <span class="pick-group__name">${g.nameHtml}</span>
          <span class="pick-group__count">${g.items.length} 个模型</span>
          <span class="pick-group__selected"></span>
        </div>
        <div class="pick-group__body">${g.items.map(itemHtml).join('')}</div>
      </div>`;

    const body = `
      <div class="search mb-12">
        <span class="search__icon">${icon('search', 15)}</span>
        <input class="input" id="pick-search" placeholder="搜索模型 ID，支持模糊匹配…">
      </div>
      <div class="flex-center gap-8 mb-12" style="flex-wrap:wrap">
        <div class="pill-toggle" id="pick-groupby">
          <button type="button" data-groupby="channel" class="is-on">按渠道分组</button>
          <button type="button" data-groupby="provider">按提供商分组</button>
        </div>
        <button class="btn btn--sm" data-pick="all">${isAdd ? '全选可添加' : '全选'}</button>
        <button class="btn btn--sm" data-pick="none">清空</button>
        <button class="btn btn--sm" data-pick="expand">展开全部</button>
        <button class="btn btn--sm" data-pick="collapse">折叠全部</button>
        <div class="ml-auto muted fs-12" id="pick-count"></div>
      </div>
      <div class="pick-list" id="pick-list">${currentGroups().map(groupHtml).join('')}</div>`;

    openModal({
      title,
      desc,
      body,
      size: 'lg',
      top,
      footer: `<div class="spacer"></div>
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn btn--primary" data-act="confirm">${isAdd ? '添加' : '完成'}</button>`,
      onMount(mo) {
        const listEl = mo.body.querySelector('#pick-list');
        const countEl = mo.body.querySelector('#pick-count');
        const searchEl = mo.body.querySelector('#pick-search');
        const confirmBtn = mo.foot.querySelector('[data-act=confirm]');

        const selected = () => Array.from(listEl.querySelectorAll('input[data-id]:checked')).map((i) => i.dataset.id);
        const selectedItems = () => selected().map((id) => list.find((it) => it.id === id)).filter(Boolean);
        // 搜索过滤后的条目；折叠只是视图状态，不影响全选和统计口径
        const shownItems = () => Array.from(listEl.querySelectorAll('.pick-item'))
          .filter((it) => it.style.display !== 'none');

        const refresh = () => {
          const sel = selected();
          countEl.textContent = sel.length ? `已选择 ${sel.length} 个` : '未选择';
          if (isAdd) {
            confirmBtn.disabled = sel.length === 0;
            confirmBtn.textContent = sel.length ? `添加（${sel.length}）` : '添加';
          } else {
            confirmBtn.textContent = `完成${sel.length ? `（${sel.length}）` : ''}`;
          }

          listEl.querySelectorAll('.pick-group').forEach((groupEl) => {
            const items = Array.from(groupEl.querySelectorAll('input[data-id]'));
            const shown = items.filter((i) => i.closest('.pick-item').style.display !== 'none');
            const enabled = shown.filter((i) => !i.disabled);
            const checked = enabled.filter((i) => i.checked);
            // 「已全部添加」按该分组的全量条目判断，不受搜索过滤影响
            const allAdded = isAdd && items.length > 0 && items.every((i) => i.disabled);
            const head = groupEl.querySelector('input[data-group]');
            if (head) {
              head.checked = enabled.length > 0 && checked.length === enabled.length;
              head.indeterminate = checked.length > 0 && checked.length < enabled.length;
              // 分组下所有模型都已添加过：整组无可选项，复选框置灰不可勾
              head.disabled = allAdded;
            }
            const badgeEl = groupEl.querySelector('.pick-group__selected');
            if (badgeEl) {
              badgeEl.textContent = allAdded
                ? '已全部添加'
                : (checked.length ? `已选 ${checked.length}` : '');
              badgeEl.classList.toggle('is-done', allAdded);
            }
          });
        };

        // 按关键词过滤；不打乱用户当前的折叠状态，折叠的分组照常被过滤
        const applyFilter = () => {
          const kw = searchEl.value.trim().toLowerCase();
          listEl.querySelectorAll('.pick-group').forEach((groupEl) => {
            let visible = 0;
            groupEl.querySelectorAll('.pick-item').forEach((it) => {
              const hit = !kw || (it.dataset.search || '').includes(kw);
              it.style.display = hit ? '' : 'none';
              if (hit) visible++;
            });
            groupEl.style.display = visible ? '' : 'none';
            groupEl.classList.toggle('is-collapsed', collapsed().has(groupEl.dataset.gkey));
          });
        };

        // 切换分组方式：保留已勾选状态，按新分组重绘
        const renderList = () => {
          const checkedNow = new Set(Array.from(listEl.querySelectorAll('input[data-id]:checked')).map((i) => i.dataset.id));
          listEl.innerHTML = currentGroups().map(groupHtml).join('');
          listEl.querySelectorAll('input[data-id]').forEach((i) => {
            i.checked = checkedNow.has(i.dataset.id) && !i.disabled;
          });
          applyFilter();
          refresh();
        };

        // 点分组标题折叠/展开；点复选框则只切换勾选
        listEl.addEventListener('click', (e) => {
          const head = e.target.closest('.pick-group__head');
          if (!head) return;
          if (e.target.matches('input[type=checkbox]')) return;
          const groupEl = head.parentElement;
          const key = groupEl.dataset.gkey;
          if (collapsed().has(key)) collapsed().delete(key);
          else collapsed().add(key);
          groupEl.classList.toggle('is-collapsed', collapsed().has(key));
        });

        listEl.addEventListener('change', (e) => {
          if (e.target.matches('input[data-group]')) {
            const groupEl = e.target.closest('.pick-group');
            const on = e.target.checked;
            // 只勾选搜索过滤后仍在的条目；折叠不影响分组全选
            groupEl.querySelectorAll('.pick-item').forEach((it) => {
              if (it.style.display === 'none') return;
              const i = it.querySelector('input[data-id]');
              if (i && !i.disabled) i.checked = on;
            });
          }
          refresh();
        });

        searchEl.addEventListener('input', debounce(() => {
          applyFilter();
          refresh();
        }, 150));

        mo.body.querySelectorAll('#pick-groupby button').forEach((btn) => {
          btn.onclick = () => {
            if (btn.dataset.groupby === groupBy) return;
            groupBy = btn.dataset.groupby;
            mo.body.querySelectorAll('#pick-groupby button').forEach((b) => {
              b.classList.toggle('is-on', b === btn);
            });
            renderList();
          };
        });

        mo.body.querySelector('[data-pick=all]').onclick = () => {
          // 只全选搜索过滤后仍在的条目，点它不会误选被过滤掉的内容
          shownItems().forEach((it) => {
            const cb = it.querySelector('input[data-id]');
            if (cb && !cb.disabled) cb.checked = true;
          });
          refresh();
        };
        mo.body.querySelector('[data-pick=none]').onclick = () => {
          listEl.querySelectorAll('input[data-id]').forEach((i) => { i.checked = false; });
          refresh();
        };
        mo.body.querySelector('[data-pick=expand]').onclick = () => {
          collapsed().clear();
          applyFilter();
        };
        mo.body.querySelector('[data-pick=collapse]').onclick = () => {
          currentGroups().forEach((g) => collapsed().add(g.key));
          applyFilter();
        };
        mo.foot.querySelector('[data-act=cancel]').onclick = () => mo.close();

        mo.foot.querySelector('[data-act=confirm]').onclick = () => {
          const ids = selected();
          if (isAdd && !ids.length) return;
          const items = selectedItems();
          mo.close();
          onConfirm(ids, items);
        };
        applyFilter();
        refresh();
      },
    });
  }

  // ---------- 添加模型（批量选择渠道模型） ----------
  async function openAddModelsDialog() {
    await openModelPicker({
      mode: 'add',
      title: '添加模型',
      desc: '从已配置渠道派生出的渠道模型里批量选择，添加后即可被调用。',
      onConfirm: async (ids) => {
        const ok = await confirmDialog({
          title: '确认添加',
          message: `确认添加（<b>${ids.length}</b>）这些模型吗？<br><br>
            <div style="max-height:180px;overflow-y:auto;background:var(--code-bg);border:1px solid var(--border);border-radius:7px;padding:9px 12px;font-family:var(--mono);font-size:11.5px;line-height:1.9">
              ${ids.map((id) => esc(id)).join('<br>')}
            </div>`,
          confirmText: `确认添加（${ids.length}）`,
        });
        if (!ok) return;
        try {
          const res = await API.post('/api/models/batch', { ids });
          const skipped = res.skipped || [];
          if (skipped.length) {
            Toast.warn(`已添加 ${res.added} 个，跳过 ${skipped.length} 个：${skipped.slice(0, 3).join('、')}${skipped.length > 3 ? ' 等' : ''}`, '部分完成');
          } else {
            Toast.success(`成功添加 ${res.added} 个模型`);
          }
          State.invalidate('models');
          window.LDM.navigate();
        } catch (e) { Toast.error(e.message, '添加失败'); }
      },
    });
  }

  // ---------- 提供商选择 ----------
  // 与后端 matchProvider 相同的匹配规则：模型 ID 小写包含关键词即命中，按提供商顺序取第一个。
  function autoMatchProvider(providers, modelID) {
    const hay = String(modelID || '').toLowerCase();
    for (const p of providers || []) {
      for (const raw of p.match || []) {
        const kw = String(raw || '').trim().toLowerCase();
        if (kw && hay.includes(kw)) return p.id;
      }
    }
    return '';
  }

  function providerSelectHtml(providers, selected, id, autoLabel) {
    const isAuto = selected === undefined || selected === null || selected === '__auto';
    const opts = [`<option value="__auto"${isAuto ? ' selected' : ''}>${esc(autoLabel || '自动识别（按模型名）')}</option>`];
    opts.push(`<option value=""${selected === '' ? ' selected' : ''}>不设置提供商</option>`);
    (providers || []).forEach((p) => {
      opts.push(`<option value="${esc(p.id)}"${p.id === selected ? ' selected' : ''}>${esc(p.name)}</option>`);
    });
    return `<select class="select" id="${esc(id)}" style="width:100%">${opts.join('')}</select>`;
  }

  function readProviderSelect(scope, id, providers, modelID) {
    const el = scope.querySelector('#' + id);
    if (!el) return undefined;
    const v = el.value;
    if (v === '__auto') return autoMatchProvider(providers, modelID);
    return v;
  }

  // ---------- 提供商管理 ----------
  // 内置图标名列表（来自 provider-icons.js）
  function builtinProviderIcons() {
    return Object.keys(window.LDM_PROVIDER_ICONS || {});
  }

  function openProvidersDialog() {
    let changed = false;
    let providers = [];

    const modal = openModal({
      title: '提供商管理',
      desc: '提供商用于模型广场分类和模型图标。没有模型的提供商不会出现在广场筛选里。',
      size: 'lg',
      body: `<div class="toolbar" style="padding-top:0">
          <span class="muted fs-12" id="pv-total"></span>
          <div class="toolbar__spacer"></div>
          <button class="btn btn--sm" id="pv-restore">${icon('refresh', 14)}恢复内置提供商</button>
          <button class="btn btn--sm btn--primary" id="pv-add">${icon('plus', 14)}添加提供商</button>
        </div>
        <div id="pv-list"></div>`,
      footer: `<div class="spacer"></div><button class="btn btn--primary" data-close>完成</button>`,
      onClose() {
        if (!changed) return;
        State.invalidate('models');
        State.invalidate('providers');
        window.LDM.navigate();
      },
      onMount(mo) {
        const listEl = mo.body.querySelector('#pv-list');
        const totalEl = mo.body.querySelector('#pv-total');

        const render = () => {
          totalEl.textContent = `共 ${providers.length} 个提供商`;
          if (!providers.length) {
            listEl.innerHTML = emptyState('还没有提供商', '点击右上角「添加提供商」创建一个。', '', 'box');
            return;
          }
          listEl.innerHTML = `<div class="table-wrap" style="border:none">
            <table class="tbl">
              <thead><tr>
                <th style="min-width:150px">提供商</th>
                <th>ID</th>
                <th style="min-width:190px">自动匹配关键词</th>
                <th>模型数</th>
                <th style="width:150px"></th>
              </tr></thead>
              <tbody>${providers.map((p) => `<tr data-pid="${esc(p.id)}">
                <td><div class="provider-tag">${providerIcon(p.icon, 20)}<b>${esc(p.name)}</b>${p.builtin ? ' ' + badge('内置', 'gray') : ''}</div></td>
                <td><code class="mono">${esc(p.id)}</code></td>
                <td class="fs-12 muted">${esc((p.match || []).join('、') || '—')}</td>
                <td>${p.model_count || 0}</td>
                <td><div class="row-actions">
                  <button class="btn btn--sm" data-pedit="${esc(p.id)}">${icon('edit', 13)}编辑</button>
                  <button class="btn btn--sm btn--icon btn--danger" data-pdel="${esc(p.id)}" title="删除">${icon('trash', 13)}</button>
                </div></td>
              </tr>`).join('')}</tbody>
            </table>
          </div>`;
        };

        const reload = async () => {
          try {
            providers = await State.loadProviders(true);
            render();
          } catch (e) { Toast.error(e.message); }
        };

        listEl.addEventListener('click', async (e) => {
          const editBtn = e.target.closest('[data-pedit]');
          if (editBtn) {
            const p = providers.find((x) => x.id === editBtn.dataset.pedit);
            if (p) openProviderEditor(p, async () => { changed = true; await reload(); });
            return;
          }
          const delBtn = e.target.closest('[data-pdel]');
          if (!delBtn) return;
          const p = providers.find((x) => x.id === delBtn.dataset.pdel);
          if (!p) return;
          const ok = await confirmDialog({
            title: '删除提供商',
            message: `确定删除提供商 <b>${esc(p.name)}</b> 吗？${p.model_count ? `<br><br>它的 <b>${p.model_count}</b> 个模型会回到「未设置」状态，不影响正常调用。` : ''}`,
            confirmText: '删除',
            danger: true,
          });
          if (!ok) return;
          try {
            await API.del('/api/providers/' + encodeURIComponent(p.id));
            Toast.success(`提供商 ${p.name} 已删除`);
            changed = true;
            State.invalidate('models');
            await reload();
          } catch (err) { Toast.error(err.message); }
        });

        mo.body.querySelector('#pv-add').onclick = () => {
          openProviderEditor(null, async () => { changed = true; await reload(); });
        };
        mo.body.querySelector('#pv-restore').onclick = async () => {
          try {
            const defs = await API.get('/api/providers/defaults');
            openRestoreProvidersDialog(defs, async (res) => {
              changed = true;
              State.invalidate('models');
              await reload();
              if (res) {
                Toast.success(`已恢复 ${res.added} 个内置提供商${res.reassigned ? `，重新归属 ${res.reassigned} 个模型` : ''}`);
              }
            });
          } catch (e) { Toast.error(e.message); }
        };
        reload();
      },
    });
    void modal;
  }

  // 选择要找回的内置提供商（只列默认项，已存在的置灰）
  function openRestoreProvidersDialog(defs, onRestored) {
    const missing = (defs || []).filter((d) => !d.exists);
    if (!missing.length) {
      Toast.info('内置提供商都在，没有需要找回的项');
      return;
    }
    const body = `
      <div class="field__hint" style="margin-top:0;margin-bottom:10px">
        勾选要找回的内置提供商。已存在的项不会被覆盖，已删除项找回后会重新匹配失去归属的模型。
      </div>
      <div class="restore-list">
        ${defs.map((d) => `<label class="restore-item${d.exists ? ' is-disabled' : ''}">
          <input type="checkbox" data-rid="${esc(d.id)}" ${d.exists ? 'disabled' : ''}>
          ${providerIcon(d.icon, 18)}
          <span class="restore-item__name">${esc(d.name)}</span>
          <code class="restore-item__id">${esc(d.id)}</code>
          ${d.exists ? badge('已存在', 'gray') : badge('已删除', 'red')}
        </label>`).join('')}
      </div>
      <div class="btn-row mt-8">
        <button class="btn btn--sm" data-act="all">全选缺失</button>
        <button class="btn btn--sm" data-act="none">清空选择</button>
      </div>`;

    openModal({
      title: '恢复内置提供商',
      body,
      size: 'md',
      footer: `<div class="spacer"></div>
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn btn--primary" data-act="restore" disabled>恢复选中</button>`,
      onMount(mo) {
        const listEl = mo.body.querySelector('.restore-list');
        const btn = mo.foot.querySelector('[data-act=restore]');
        const checked = () => [...listEl.querySelectorAll('input[data-rid]:checked')].map((i) => i.dataset.rid);
        const sync = () => {
          const n = checked().length;
          btn.disabled = n === 0;
          btn.textContent = n ? `恢复选中（${n}）` : '恢复选中';
        };
        listEl.addEventListener('change', sync);
        mo.body.querySelector('[data-act=all]').onclick = () => {
          listEl.querySelectorAll('input[data-rid]:not(:disabled)').forEach((i) => { i.checked = true; });
          sync();
        };
        mo.body.querySelector('[data-act=none]').onclick = () => {
          listEl.querySelectorAll('input[data-rid]').forEach((i) => { i.checked = false; });
          sync();
        };
        mo.foot.querySelector('[data-act=cancel]').onclick = () => mo.close();
        btn.onclick = async () => {
          const ids = checked();
          if (!ids.length) { Toast.warn('请勾选要找回的提供商'); return; }
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner" style="width:13px;height:13px"></span>恢复中';
          try {
            const res = await API.post('/api/providers/restore-defaults', { ids });
            mo.close();
            if (onRestored) await onRestored(res);
          } catch (e) {
            Toast.error(e.message, '恢复失败');
            btn.disabled = false;
            sync();
          }
        };
        sync();
      },
    });
  }

  function openProviderEditor(p, onSaved) {
    const isNew = !p;
    const icons = builtinProviderIcons();
    const icon = (p && p.icon) || '';
    const body = `
      <div class="form-row">
        <div class="field">
          <label class="field__label">名称<span class="req">*</span></label>
          <input class="input" id="pv-name" value="${esc(p ? p.name : '')}" placeholder="例如：智谱">
        </div>
        <div class="field">
          <label class="field__label">ID${isNew ? '<span class="req">*</span>' : ''}</label>
          <input class="input mono" id="pv-id" value="${esc(p ? p.id : '')}" ${isNew ? '' : 'disabled'} placeholder="例如：zhipu">
          <div class="field__hint">${isNew ? '只能包含小写字母、数字、下划线和短横线；留空则按名称生成。' : '提供商 ID 创建后不可修改。'}</div>
        </div>
      </div>

      <div class="field">
        <label class="field__label">图标</label>
        <div class="provider-icon-picker" id="pv-icons">
          ${icons.map((k) => `<button type="button" class="provider-icon-opt${icon === k ? ' is-on' : ''}" data-icon="${esc(k)}" title="${esc(k)}">${providerIcon(k, 24)}</button>`).join('')}
        </div>
        <input class="input" id="pv-icon" value="${esc(icon)}" placeholder="也可以填 emoji 或图片直链">
        <div class="field__hint">点上方图标选择内置图标；也可以输入 emoji（如 🐱）或 http(s)/data 图片地址。</div>
      </div>

      <div class="field">
        <label class="field__label">自动匹配关键词</label>
        <input class="input" id="pv-match" value="${esc((p && p.match || []).join(', '))}" placeholder="用逗号分隔，例如：glm, 智谱">
        <div class="field__hint">添加模型时，模型 ID 包含任一关键词（不区分大小写）就会自动归入该提供商。多个提供商都命中时，按列表顺序取第一个。</div>
      </div>`;

    openModal({
      title: isNew ? '添加提供商' : `编辑提供商 · ${p.name}`,
      body,
      size: 'md',
      footer: `<div class="spacer"></div>
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn btn--primary" data-act="save">${isNew ? '创建' : '保存'}</button>`,
      onMount(mo) {
        const iconInput = mo.body.querySelector('#pv-icon');
        const picker = mo.body.querySelector('#pv-icons');
        const syncPicker = () => {
          picker.querySelectorAll('[data-icon]').forEach((b) => {
            b.classList.toggle('is-on', b.dataset.icon === iconInput.value.trim());
          });
        };
        picker.addEventListener('click', (e) => {
          const b = e.target.closest('[data-icon]');
          if (!b) return;
          iconInput.value = b.dataset.icon;
          syncPicker();
        });
        iconInput.addEventListener('input', syncPicker);

        mo.foot.querySelector('[data-act=cancel]').onclick = () => mo.close();
        mo.foot.querySelector('[data-act=save]').onclick = async () => {
          const name = mo.body.querySelector('#pv-name').value.trim();
          if (!name) { Toast.warn('请填写提供商名称'); return; }
          const payload = {
            name,
            icon: iconInput.value.trim(),
            match: mo.body.querySelector('#pv-match').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
          };
          if (isNew) payload.id = mo.body.querySelector('#pv-id').value.trim();
          const btn = mo.foot.querySelector('[data-act=save]');
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner" style="width:13px;height:13px"></span>保存中';
          try {
            if (isNew) await API.post('/api/providers', payload);
            else await API.put('/api/providers/' + encodeURIComponent(p.id), payload);
            mo.close();
            Toast.success(isNew ? `提供商 ${name} 已创建` : '提供商已保存');
            State.invalidate('providers');
            State.invalidate('models');
            if (onSaved) await onSaved();
          } catch (e) {
            Toast.error(e.message, '保存失败');
            btn.disabled = false;
            btn.textContent = isNew ? '创建' : '保存';
          }
        };
      },
    });
  }

  // 批量设置提供商时的选择弹窗；返回 '__auto' / '' / 提供商 ID，取消返回 null。
  function chooseProviderDialog(opts) {
    return new Promise((resolve) => {
      let settled = false;
      const providers = opts.providers || [];
      const body = `
        <div class="field">
          <label class="field__label">提供商</label>
          <select class="select" id="batch-provider" style="width:100%">
            <option value="__auto">自动识别（按模型名）</option>
            <option value="">不设置提供商</option>
            ${providers.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}
          </select>
          <div class="field__hint">${esc(opts.desc || '')}</div>
        </div>`;
      const modal = openModal({
        title: opts.title || '设置提供商',
        body,
        size: 'sm',
        footer: `<div class="spacer"></div>
          <button class="btn" data-act="cancel">取消</button>
          <button class="btn btn--primary" data-act="ok">确定</button>`,
        onClose() { if (!settled) { settled = true; resolve(null); } },
        onMount(mo) {
          const sel = mo.body.querySelector('#batch-provider');
          if (opts.current) sel.value = opts.current;
          mo.foot.querySelector('[data-act=cancel]').onclick = () => { settled = true; mo.close(); resolve(null); };
          mo.foot.querySelector('[data-act=ok]').onclick = () => {
            settled = true;
            const v = sel.value;
            mo.close();
            resolve(v);
          };
        },
      });
      void modal;
    });
  }


  function openChannelModelEditor(m) {
    const providers = State.providers || [];
    const body = `
      <div class="field">
        <label class="field__label">模型 ID</label>
        <input class="input mono" value="${esc(m.id)}" disabled>
        <div class="field__hint">渠道模型的 ID 由「渠道 ID / 上游模型名」自动生成，不可修改。</div>
      </div>
      <div class="field">
        <label class="field__label">提供商</label>
        ${providerSelectHtml(providers, m.provider_id || '__auto', 'm-provider-id')}
        <div class="field__hint">模型广场会按提供商分类，并自动使用提供商的图标。「自动识别」按模型名匹配关键词。</div>
      </div>
      <div class="field">
        <label class="field__label">描述</label>
        <input class="input" id="m-desc" value="${esc(m.description || '')}" placeholder="可选">
      </div>
      <div class="field">
        <label class="field__label">超时时间（秒）</label>
        <input class="input" id="m-timeout" type="number" min="1" value="${esc(m.timeout || 300)}">
        <div class="field__hint">非流式限制整次请求；流式只限制首字，首字到达后不再限时。</div>
      </div>
      <details class="mt-16 advanced-settings">
        <summary style="cursor:pointer;font-size:12.5px;font-weight:620;color:var(--text-2)">高级设置</summary>
        <div class="mt-12">
          <div class="field">
            <div class="field__head">
              <label class="field__label">不可重试状态码
                <button type="button" class="badge badge--blue badge--click field__help"
                        id="m-no-retry-help" title="${esc(NO_RETRY_STATUS_HELP_TEXT)}" aria-label="查看不可重试状态码规则">?</button>
              </label>
              <button type="button" class="btn btn--ghost btn--sm field__reset"
                      id="m-no-retry-template" title="填入常用模板">${icon('paste', 11)}填入模板</button>
            </div>
            <input class="input mono" id="m-no-retry"
                   value="${esc(m.no_retry_status ?? '')}"
                   placeholder="${DEFAULT_NO_RETRY_STATUS}">
          </div>
        </div>
      </details>
      ${capsEditorHtml(m.caps || {})}
      <div class="field mt-16">
        <label class="switch"><input type="checkbox" id="m-enabled" ${m.enabled ? 'checked' : ''}><span class="switch__track"></span><span class="switch__label">启用该模型</span></label>
      </div>`;

    openModal({
      title: '编辑渠道模型',
      desc: `模型 <code>${esc(m.id)}</code> 的能力参数只用于展示，网关不会根据这些参数校验或改写请求。`,
      body,
      size: 'lg',
      footer: `<div class="spacer"></div>
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn btn--primary" data-act="save">保存</button>`,
      onMount(mo) {
        bindCapsEditor(mo.body);
        bindAdvancedState(mo.body, 'model', m.id);
        mo.body.querySelector('#m-no-retry-help').onclick = () => {
          openHelpModal('不可重试状态码', NO_RETRY_STATUS_HELP_HTML);
        };
        mo.body.querySelector('#m-no-retry-template').onclick = () => {
          const input = mo.body.querySelector('#m-no-retry');
          input.value = DEFAULT_NO_RETRY_STATUS;
          input.focus();
        };
        mo.foot.querySelector('[data-act=cancel]').onclick = () => mo.close();
        mo.foot.querySelector('[data-act=save]').onclick = async () => {
          let caps;
          try {
            caps = readCapsEditor(mo.body);
          } catch (e) {
            Toast.error(e.message, '能力参数格式有误');
            return;
          }
          const btn = mo.foot.querySelector('[data-act=save]');
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner" style="width:13px;height:13px"></span>保存中';
          try {
            await API.put('/api/models/' + encodeURIComponent(m.id), {
              id: m.id,
              type: 'channel',
              channel_id: m.channel_id,
              upstream: m.upstream,
              caps,
              provider_id: readProviderSelect(mo.body, 'm-provider-id', providers, m.upstream || m.id),
              enabled: mo.body.querySelector('#m-enabled').checked,
              description: mo.body.querySelector('#m-desc').value.trim(),
              timeout: Math.max(1, Math.round(Number(mo.body.querySelector('#m-timeout').value) || 300)),
              no_retry_status: mo.body.querySelector('#m-no-retry').value.trim(),
            });
            mo.close();
            Toast.success('模型配置已保存');
            State.invalidate('models');
            window.LDM.navigate();
          } catch (e) {
            Toast.error(e.message, '保存失败');
            btn.disabled = false;
            btn.textContent = '保存';
          }
        };
      },
    });
  }

  // ---------- 能力参数编辑器 ----------
  // 能力参数只用于模型广场 / 模型列表的展示，网关不会在请求时校验、裁剪或改写。
  // 支持可视化与 JSON 两种编辑方式，JSON 便于复制粘贴和备份。
  const CAPS_KEYS = ['context_length', 'max_output', 'tool_calling', 'thinking', 'vision'];

  function capsEditorHtml(caps) {
    const c = caps || {};
    const tri = (id, label, val, hint) => `
      <div class="field">
        <label class="field__label">${esc(label)}</label>
        <div class="tristate" data-tri="${id}">
          <div class="tristate__opt${val == null ? ' is-on' : ''}" data-value="auto">留空（不声明）</div>
          <div class="tristate__opt${val === true ? ' is-on' : ''}" data-value="yes">支持</div>
          <div class="tristate__opt${val === false ? ' is-on' : ''}" data-value="no">不支持</div>
        </div>
        ${hint ? `<div class="field__hint">${esc(hint)}</div>` : ''}
      </div>`;

    return `<div class="sep"></div>
      <div id="caps-editor">
        <div class="section-title" style="display:flex;align-items:center;gap:10px">
          <span>能力参数</span>
          <div class="pill-toggle" id="caps-mode" style="margin-left:auto">
            <button type="button" data-caps-mode="visual" class="is-on">可视化</button>
            <button type="button" data-caps-mode="json">JSON</button>
          </div>
        </div>
        <div class="field__hint" style="margin:-4px 0 12px">这些参数只用于模型广场和模型列表的展示，网关不会根据它们校验、裁剪或改写请求；留空表示不声明。全部留空时不会做任何能力相关的处理（模型名替换和协议转换仍会正常进行）。</div>
        <div id="caps-visual">
          <div class="form-row">
            <div class="field">
              <label class="field__label">上下文长度（tokens）</label>
              <input class="input" id="c-ctx" type="number" min="0" value="${c.context_length == null ? '' : c.context_length}" placeholder="留空表示不声明">
            </div>
            <div class="field">
              <label class="field__label">最大输出（tokens）</label>
              <input class="input" id="c-max" type="number" min="0" value="${c.max_output == null ? '' : c.max_output}" placeholder="留空表示不声明">
            </div>
          </div>
          ${tri('tool', '工具调用（Function Calling）', c.tool_calling, '仅用于展示，不会据此剥离 tools 字段。')}
          ${tri('think', '思考（Reasoning）', c.thinking, '仅用于展示，不会据此移除 reasoning_effort、thinking 等参数。')}
          ${tri('vision', '图片输入（Vision）', c.vision, '仅用于展示，不会据此过滤消息里的图片内容。')}
        </div>
        <div id="caps-json" style="display:none">
          <textarea class="textarea" id="c-caps-json" spellcheck="false" style="min-height:150px" placeholder='{"context_length":128000,"max_output":8192,"tool_calling":true}'></textarea>
          <div class="btn-row mt-8">
            <button class="btn btn--sm" type="button" data-act="copy-caps-json">${icon('copy', 13)}复制 JSON</button>
            <button class="btn btn--sm" type="button" data-act="paste-caps-json">${icon('paste', 13)}粘贴 JSON</button>
          </div>
          <div class="field__hint">可直接粘贴能力参数对象。支持 context_length、max_output、tool_calling、thinking、vision 五个字段，null 或留空表示不声明。</div>
        </div>
      </div>`;
  }

  const capsSerialize = (caps) => {
    const out = {};
    CAPS_KEYS.forEach((k) => {
      if (caps && caps[k] !== undefined && caps[k] !== null) out[k] = caps[k];
    });
    return JSON.stringify(out, null, 2);
  };

  function capsParseJSON(text) {
    if (!String(text || '').trim()) return {};
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error('JSON 解析失败：' + e.message);
    }
    // 兼容直接粘贴 { "caps": { ... } } 的模型片段
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && parsed.caps && typeof parsed.caps === 'object' && !Array.isArray(parsed.caps)) {
      parsed = parsed.caps;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('需要一个能力参数对象，例如 {"context_length":128000}');
    }
    const out = {};
    Object.keys(parsed).forEach((k) => {
      if (!CAPS_KEYS.includes(k)) throw new Error(`不支持的字段：${k}`);
      const v = parsed[k];
      if (v === null || v === undefined || v === '') return;
      if (k === 'context_length' || k === 'max_output') {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) throw new Error(`${k} 需为非负整数`);
        out[k] = n;
      } else {
        if (typeof v !== 'boolean') throw new Error(`${k} 需为 true / false`);
        out[k] = v;
      }
    });
    return out;
  }

  function readCapsVisual(scope) {
    const num = (id) => {
      const el = scope.querySelector('#' + id);
      if (!el) return null;
      const v = el.value.trim();
      if (v === '') return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) throw new Error('上下文长度和最大输出需为非负整数');
      return n;
    };
    const tri = (id) => {
      const on = scope.querySelector(`[data-tri=${id}] .tristate__opt.is-on`);
      const v = on ? on.dataset.value : 'auto';
      return v === 'auto' ? null : v === 'yes';
    };
    const caps = {};
    const ctx = num('c-ctx'); if (ctx !== null) caps.context_length = ctx;
    const mx = num('c-max'); if (mx !== null) caps.max_output = mx;
    const t = tri('tool'); if (t !== null) caps.tool_calling = t;
    const th = tri('think'); if (th !== null) caps.thinking = th;
    const vi = tri('vision'); if (vi !== null) caps.vision = vi;
    return caps;
  }

  function applyCapsVisual(scope, caps) {
    const set = (id, v) => {
      const el = scope.querySelector('#' + id);
      if (el) el.value = v == null ? '' : v;
    };
    set('c-ctx', caps.context_length);
    set('c-max', caps.max_output);
    [['tool', caps.tool_calling], ['think', caps.thinking], ['vision', caps.vision]].forEach(([id, v]) => {
      const group = scope.querySelector(`[data-tri=${id}]`);
      if (!group) return;
      group.querySelectorAll('.tristate__opt').forEach((opt) => {
        const on = v == null
          ? opt.dataset.value === 'auto'
          : (v ? opt.dataset.value === 'yes' : opt.dataset.value === 'no');
        opt.classList.toggle('is-on', on);
      });
    });
  }

  function readCapsEditor(scope) {
    const editor = scope.querySelector('#caps-editor');
    if (editor) {
      const jsonEl = editor.querySelector('#caps-json');
      if (jsonEl && jsonEl.style.display !== 'none') {
        return capsParseJSON(editor.querySelector('#c-caps-json').value);
      }
    }
    return readCapsVisual(scope);
  }

  function bindCapsEditor(scope) {
    scope.querySelectorAll('.tristate').forEach((group) => {
      group.querySelectorAll('.tristate__opt').forEach((opt) => {
        opt.onclick = () => {
          group.querySelectorAll('.tristate__opt').forEach((x) => x.classList.remove('is-on'));
          opt.classList.add('is-on');
        };
      });
    });

    const editor = scope.querySelector('#caps-editor');
    if (!editor) return;
    const visualEl = editor.querySelector('#caps-visual');
    const jsonEl = editor.querySelector('#caps-json');
    const jsonInput = editor.querySelector('#c-caps-json');
    const modeEl = editor.querySelector('#caps-mode');
    let mode = 'visual';

    const setMode = (next) => {
      if (next === mode) return;
      if (next === 'json') {
        try {
          jsonInput.value = capsSerialize(readCapsVisual(scope));
        } catch (e) {
          Toast.error(e.message, '能力参数格式有误');
          return;
        }
      } else {
        let caps;
        try {
          caps = capsParseJSON(jsonInput.value);
        } catch (e) {
          Toast.error(e.message, 'JSON 格式有误');
          return;
        }
        applyCapsVisual(scope, caps);
      }
      mode = next;
      visualEl.style.display = next === 'visual' ? '' : 'none';
      jsonEl.style.display = next === 'json' ? '' : 'none';
      modeEl.querySelectorAll('[data-caps-mode]').forEach((b) => {
        b.classList.toggle('is-on', b.dataset.capsMode === next);
      });
    };

    modeEl.querySelectorAll('[data-caps-mode]').forEach((b) => {
      b.onclick = () => setMode(b.dataset.capsMode);
    });
    const copyBtn = editor.querySelector('[data-act=copy-caps-json]');
    if (copyBtn) {
      copyBtn.onclick = () => {
        if (mode !== 'json') {
          try {
            jsonInput.value = capsSerialize(readCapsVisual(scope));
          } catch (e) {
            Toast.error(e.message, '能力参数格式有误');
            return;
          }
        }
        copyText(jsonInput.value, '能力参数 JSON ');
      };
    }
    const pasteBtn = editor.querySelector('[data-act=paste-caps-json]');
    if (pasteBtn) {
      pasteBtn.onclick = () => pasteTextInto(jsonInput);
    }
  }

  // ---------- 自定义模型（弹窗1 + 弹窗2 + 分组/权重/拖拽） ----------
  function openCustomModelDialog(existing) {
    const isNew = !existing;
    const m = existing || {
      id: '', type: 'custom', routes: [], affinity: true, cooldown_sec: 300, cooldown_reset: false,
      caps: {}, enabled: true, display_name: '', description: '', tags: [], timeout: 300,
      no_retry_status: '',
    };
    // 本地编辑态
    const draft = {
      routes: (m.routes || []).map((r) => ({
        model_id: r.model_id, channel_id: r.channel_id, upstream: r.upstream, channel_name: r.channel_name,
        weight: r.weight || 0, group: r.group || 0,
      })),
      caps: m.caps || {},
    };

    // 目标路由模型的长说明收进问号：悬停看摘要，点击看完整规则
    const routeHelpText = '普通条目按从上到下的顺序依次尝试；「合并」相邻条目成组后，组内每次按权重随机排序再依次尝试（权重越高越可能靠前，权重全部相等时等概率），全部失败再到后面的条目。按住左侧手柄拖动调整单条位置，按住组头左侧握把拖动调整整组位置；拖出弹窗只会收起当前条目所在的分组（拖回不会自动展开，松手后恢复），不影响其他分组。组外条目用「合并」按钮，组内条目用「分开」按钮。';

    const body = `
      <div class="field">
        <label class="field__label">模型 ID<span class="req">*</span></label>
        <input class="input mono" id="cm-id" value="${esc(m.id)}" placeholder="例如 LDM">
        <div class="field__hint">对外暴露的唯一模型名，调用时 <code>model</code> 填这个值。</div>
      </div>

      <div class="field">
        <div class="field__label" style="display:flex;align-items:center;flex-wrap:wrap;gap:8px">
          <span>目标路由模型<span class="req">*</span><button type="button" class="badge badge--blue badge--click field__help" id="cm-route-help" title="${esc(routeHelpText)}" aria-label="查看路由规则">?</button></span>
          <div class="pill-toggle" id="cm-route-mode" style="margin-left:auto">
            <button type="button" data-route-mode="visual" class="is-on">可视化</button>
            <button type="button" data-route-mode="json">JSON</button>
          </div>
        </div>
        <div id="route-visual">
          <div id="route-host"></div>
          <div class="btn-row mt-8">
            <button class="btn btn--sm" data-act="pick">${icon('plus', 13)}选择渠道模型</button>
          </div>
        </div>
        <div id="route-json" style="display:none">
          <textarea class="textarea" id="cm-route-json" spellcheck="false" style="min-height:180px" placeholder='[{"channel_id":"渠道ID","upstream":"模型名","weight":0,"group":0}]'></textarea>
          <div class="btn-row mt-8">
            <button class="btn btn--sm" data-act="copy-json">${icon('copy', 13)}复制 JSON</button>
            <button class="btn btn--sm" data-act="paste-json">${icon('paste', 13)}粘贴 JSON</button>
          </div>
          <div class="field__hint">可直接复制粘贴复用。channel_id + upstream 定位渠道模型；相同 group 且相邻的条目自动成组；weight 决定组内尝试顺序（按权重随机排序，权重越高越可能靠前，全部相等时等概率）。</div>
        </div>
      </div>

      <div class="field">
        <label class="field__label">调度选项</label>
        <div class="sched-grid">
          <label class="switch"><input type="checkbox" id="cm-affinity" ${m.affinity ? 'checked' : ''}><span class="switch__track"></span><span class="switch__label">模型亲和</span></label>
          <div class="field__hint" style="margin-top:2px">开启后：本轮哪个路由成功了，下一轮请求就优先从它开始（提到最前）。</div>
          <div style="display:flex;align-items:center;gap:10px;margin-top:8px">
            <span class="muted fs-12">失败冷却</span>
            <input class="input" id="cm-cooldown" type="number" min="0" max="86400" value="${m.cooldown_sec ?? 300}" style="width:90px;height:30px;font-size:12.5px">
            <span class="muted fs-12">秒</span>
            <label class="switch" style="margin-left:auto"><input type="checkbox" id="cm-cooldown-reset" ${m.cooldown_reset ? 'checked' : ''}><span class="switch__track"></span><span class="switch__label">全冷却时自动重置</span></label>
          </div>
          <div class="field__hint" style="margin-top:2px">条目失败后在冷却时长内视为不可用直接跳过（0 = 不冷却）。「自动重置」决定全部条目都在冷却中时的行为：关=直接返回不可用；开=清空所有冷却再路由一遍。</div>
        </div>
      </div>

      <div class="field">
        <label class="field__label">超时时间（秒）</label>
        <input class="input" id="cm-timeout" type="number" min="1" value="${esc(m.timeout || 300)}">
        <div class="field__hint">非流式限制整次请求；流式只限制首字，首字到达后不再限时。</div>
      </div>

      <details class="mt-16 advanced-settings">
        <summary style="cursor:pointer;font-size:12.5px;font-weight:620;color:var(--text-2)">高级设置</summary>
        <div class="mt-12">
          <div class="field">
            <div class="field__head">
              <label class="field__label">不可重试状态码
                <button type="button" class="badge badge--blue badge--click field__help"
                        id="cm-no-retry-help" title="${esc(NO_RETRY_STATUS_HELP_TEXT)}" aria-label="查看不可重试状态码规则">?</button>
              </label>
              <button type="button" class="btn btn--ghost btn--sm field__reset"
                      id="cm-no-retry-template" title="填入常用模板">${icon('paste', 11)}填入模板</button>
            </div>
            <input class="input mono" id="cm-no-retry"
                   value="${esc(m.no_retry_status ?? '')}"
                   placeholder="${DEFAULT_NO_RETRY_STATUS}">
          </div>
        </div>
      </details>

      <div class="field">
        <label class="field__label">描述</label>
        <input class="input" id="cm-desc" value="${esc(m.description || '')}" placeholder="可选，会显示在模型广场">
      </div>

      <div class="field">
        <label class="field__label">标签</label>
        <input class="input" id="cm-tags" value="${esc((m.tags || []).join(', '))}" placeholder="用逗号分隔，例如：旗舰, 低延迟">
      </div>

      <div class="field">
        <label class="field__label">提供商</label>
        ${providerSelectHtml(State.providers || [], isNew ? '__auto' : (m.provider_id || ''), 'cm-provider')}
        <div class="field__hint">模型广场会按提供商分类，并自动使用提供商的图标。「自动识别」按模型名匹配关键词。</div>
      </div>

      <div id="caps-host"></div>

      <div class="field mt-16">
        <label class="switch"><input type="checkbox" id="cm-enabled" ${m.enabled ? 'checked' : ''}><span class="switch__track"></span><span class="switch__label">启用该模型</span></label>
      </div>`;

    openModal({
      title: isNew ? '添加自定义模型' : `编辑自定义模型 · ${m.id}`,
      desc: '把多个渠道模型组合成一个统一的模型入口，对外只暴露一个 ID。',
      body,
      size: 'lg',
      footer: `<div class="spacer"></div>
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn btn--primary" data-act="save">${isNew ? '创建模型' : '保存修改'}</button>`,
      onMount(mo) {
        const routeHost = mo.body.querySelector('#route-host');
        const capsHost = mo.body.querySelector('#caps-host');
        bindAdvancedState(mo.body, 'model', m.id);
        mo.body.querySelector('#cm-no-retry-help').onclick = () => {
          openHelpModal('不可重试状态码', NO_RETRY_STATUS_HELP_HTML);
        };
        mo.body.querySelector('#cm-no-retry-template').onclick = () => {
          const input = mo.body.querySelector('#cm-no-retry');
          input.value = DEFAULT_NO_RETRY_STATUS;
          input.focus();
        };
        // 渠道实时状态：路由条目上显示「渠道已禁用」或「渠道模型不存在」徽章
        // （异步加载后重渲染路由列表；加载完成前不显示状态，避免误报）
        const channelState = {};
        let channelStateLoaded = false;

        // 把 routes 切成显示段：连续相同 group 的为一段，group=0 每条独立（组外/普通条目）
        const splitGroups = () => {
          const segs = [];
          for (let i = 0; i < draft.routes.length; i++) {
            const r = draft.routes[i];
            if (!r.group) { segs.push([i]); continue; }
            const last = segs[segs.length - 1];
            if (last && last.length && draft.routes[last[0]].group === r.group) last.push(i);
            else segs.push([i]);
          }
          return segs;
        };
        // 规范化：按连续段重新编号（1..N），只剩一条的组自动解散为普通条目
        const normalizeGroups = () => {
          let next = 0;
          let i = 0;
          while (i < draft.routes.length) {
            const g = draft.routes[i].group;
            if (!g) { i++; continue; }
            let j = i;
            while (j < draft.routes.length && draft.routes[j].group === g) j++;
            if (j - i >= 2) {
              next++;
              for (let k = i; k < j; k++) draft.routes[k].group = next;
            } else {
              draft.routes[i].group = 0;
            }
            i = j;
          }
        };
        const weightSum = (seg) => seg.reduce((s, i) => s + Math.max(0, draft.routes[i].weight || 0), 0);

        // ---------- 路由可视化 / JSON 双向切换 ----------
        const routeModeEl = mo.body.querySelector('#cm-route-mode');
        const routeVisualEl = mo.body.querySelector('#route-visual');
        const routeJsonEl = mo.body.querySelector('#route-json');
        const routeJsonInput = mo.body.querySelector('#cm-route-json');
        let routeMode = 'visual';

        const serializeRoutes = () => JSON.stringify(draft.routes.map((r) => ({
          channel_id: r.channel_id,
          upstream: r.upstream,
          weight: r.weight || 0,
          group: r.group || 0,
        })), null, 2);

        // 接受纯数组，也接受包含 routes 数组的对象；只认配置字段，model_id 仅用于兼容导入
        const parseRoutesJSON = (text) => {
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch (e) {
            throw new Error('JSON 解析失败：' + e.message);
          }
          const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.routes) ? parsed.routes : null);
          if (!arr) throw new Error('需要一个路由数组，或包含 routes 数组的对象');
          const seen = new Set();
          return arr.map((it, idx) => {
            const n = idx + 1;
            if (!it || typeof it !== 'object' || Array.isArray(it)) throw new Error(`第 ${n} 条必须是对象`);
            let channelID = typeof it.channel_id === 'string' ? it.channel_id.trim() : '';
            let upstream = typeof it.upstream === 'string' ? it.upstream.trim() : '';
            if ((!channelID || !upstream) && typeof it.model_id === 'string') {
              const slash = it.model_id.indexOf('/');
              if (slash > 0) {
                if (!channelID) channelID = it.model_id.slice(0, slash).trim();
                if (!upstream) upstream = it.model_id.slice(slash + 1).trim();
              }
            }
            if (!channelID || !upstream) throw new Error(`第 ${n} 条缺少 channel_id 或 upstream`);
            const key = channelID + '/' + upstream;
            if (seen.has(key)) throw new Error(`路由目标重复：${key}`);
            seen.add(key);
            const weight = it.weight === undefined || it.weight === null ? 0 : Number(it.weight);
            if (!Number.isInteger(weight) || weight < 0 || weight > 1000) {
              throw new Error(`第 ${n} 条 weight 需为 0–1000 的整数`);
            }
            const group = it.group === undefined || it.group === null ? 0 : Number(it.group);
            if (!Number.isInteger(group) || group < 0 || group > 1000) {
              throw new Error(`第 ${n} 条 group 需为 0–1000 的整数`);
            }
            return {
              model_id: key,
              channel_id: channelID,
              upstream,
              channel_name: typeof it.channel_name === 'string' ? it.channel_name : '',
              weight,
              group,
            };
          });
        };

        const applyRouteJSON = () => {
          draft.routes = parseRoutesJSON(routeJsonInput.value);
          normalizeGroups();
          renderRoutes();
        };

        const setRouteMode = (mode) => {
          if (mode === routeMode) return;
          if (mode === 'json') {
            routeJsonInput.value = serializeRoutes();
          } else {
            try {
              applyRouteJSON();
            } catch (e) {
              Toast.error(e.message, 'JSON 格式有误');
              return;
            }
          }
          routeMode = mode;
          routeVisualEl.style.display = mode === 'visual' ? '' : 'none';
          routeJsonEl.style.display = mode === 'json' ? '' : 'none';
          routeModeEl.querySelectorAll('[data-route-mode]').forEach((b) => {
            b.classList.toggle('is-on', b.dataset.routeMode === mode);
          });
        };

        // 分组折叠态：key 为组首条目的模型 ID（唯一），重排后依然能对上
        const collapsed = new Set();

        // ---------- 拖拽排序（指针事件，鼠标 / 触屏通用） ----------
        // 拖拽时在列表里插入一个真实占据布局空间的半透明占位块，随指针移动。
        // 单条拖拽隐藏源条目；整组拖拽保留源分组（半透明）以便看清组内模型。
        const DRAG_THRESHOLD = 4;
        const dragState = {
          active: false, started: false, kind: '', idx: -1, group: 0,
          startX: 0, startY: 0, lastX: 0, lastY: 0,
          pointerId: null, ghost: null, placeholder: null,
          sourceEl: null, sourceRect: null, slot: null, tap: null,
          outside: false, savedCollapsed: null,
        };
        let dragRaf = 0;

        const segAt = (i) => splitGroups().find((s) => s.includes(i));
        const sourceElement = () => {
          const rl = routeHost.querySelector('#rl');
          if (!rl) return null;
          return dragState.kind === 'item'
            ? rl.querySelector(`.route-item[data-i="${dragState.idx}"]`)
            : rl.querySelector(`.route-group[data-gstart="${dragState.idx}"]`);
        };

        const moveGhost = (x, y) => {
          if (!dragState.ghost) return;
          dragState.ghost.style.left = (x + 14) + 'px';
          dragState.ghost.style.top = (y + 12) + 'px';
        };

        const startGhost = (x, y) => {
          const ghost = document.createElement('div');
          ghost.className = 'route-drag-ghost';
          if (dragState.kind === 'item') {
            const r = draft.routes[dragState.idx];
            ghost.textContent = r ? r.model_id : '';
          } else {
            const seg = splitGroups().find((s) => s.includes(dragState.idx)) || [];
            const names = seg.map((i) => draft.routes[i].model_id);
            // 模型名可能来自上游，必须用 textContent 写入，不能拼进 innerHTML。
            ghost.innerHTML = icon('box', 12) + '<span></span>';
            ghost.querySelector('span').textContent =
              `整组 · ${names.slice(0, 2).join('、')}${names.length > 2 ? ' 等' : ''}`;
          }
          document.body.appendChild(ghost);
          dragState.ghost = ghost;
          moveGhost(x, y);
        };

        // 创建占位块：
        // - 单条：隐藏源条目，占位块放在源位置，随指针移动；
        // - 整组：保留源分组（半透明，便于看清组内模型），占位块用紧凑高度并显示组内模型名。
        const startPlaceholder = () => {
          const src = sourceElement();
          if (!src) return;
          dragState.sourceEl = src;
          dragState.sourceRect = src.getBoundingClientRect();
          const ph = document.createElement('div');
          ph.className = 'route-placeholder' + (dragState.kind === 'group' ? ' is-group' : '');
          if (dragState.kind === 'item') {
            ph.style.height = dragState.sourceRect.height + 'px';
            const r = draft.routes[dragState.idx];
            ph.textContent = r ? r.model_id : '';
            src.parentElement.insertBefore(ph, src);
            src.style.display = 'none';
            dragState.placeholder = ph;
            dragState.slot = {
              parent: ph.parentElement,
              before: ph.nextElementSibling,
              insideGroup: ph.parentElement.classList.contains('route-group'),
            };
          } else {
            const seg = splitGroups().find((s) => s.includes(dragState.idx)) || [];
            const names = seg.map((i) => draft.routes[i].model_id);
            ph.style.height = Math.min(dragState.sourceRect.height, 48) + 'px';
            ph.textContent = `整组移动 · ${names.slice(0, 3).join('、')}${names.length > 3 ? ' 等' : ''}`;
            ph.title = names.join('、');
            src.classList.add('is-group-dragging');
            dragState.placeholder = ph;
            dragState.slot = null;
          }
        };

        // 计算占位块应插入的位置：parent + before（before 为 null 表示追加到末尾）。
        const computeSlot = (x, y) => {
          const rl = routeHost.querySelector('#rl');
          const ph = dragState.placeholder;
          if (!rl || !ph) return null;

          if (dragState.kind === 'group') {
            // 整组只在最外层单元之间移动，不拆散组
            const units = Array.from(rl.children).filter((el) =>
              el !== ph && el !== dragState.sourceEl && el.offsetParent !== null);
            for (const unit of units) {
              const r = unit.getBoundingClientRect();
              if (y < r.top + r.height / 2) {
                return { parent: rl, before: unit, insideGroup: false };
              }
            }
            return { parent: rl, before: null, insideGroup: false };
          }

          // 单条：按「组头 + 条目行」从上到下找第一个中点位于指针下方的行
          const rows = Array.from(rl.querySelectorAll('.route-group__head, .route-item'))
            .filter((el) => el !== dragState.sourceEl && el.offsetParent !== null);
          for (const row of rows) {
            const r = row.getBoundingClientRect();
            if (y < r.top + r.height / 2) {
              if (row.classList.contains('route-group__head')) {
                return { parent: rl, before: row.closest('.route-group'), insideGroup: false };
              }
              const parent = row.parentElement;
              return { parent, before: row, insideGroup: parent.classList.contains('route-group') };
            }
          }
          // 指针在所有行下方：还在某个展开的分组容器内就放到该组末尾。
          // 收起的分组不再接收条目，避免拖回弹窗时又落进组里。
          const groups = Array.from(rl.querySelectorAll('.route-group'))
            .filter((g) => g !== dragState.sourceEl && g.offsetParent !== null && !g.classList.contains('is-collapsed'));
          for (const g of groups) {
            const r = g.getBoundingClientRect();
            if (y >= r.top && y <= r.bottom) {
              return { parent: g, before: null, insideGroup: true };
            }
          }
          return { parent: rl, before: null, insideGroup: false };
        };

        const movePlaceholder = (slot) => {
          const ph = dragState.placeholder;
          if (!ph || !slot) return;
          if (ph.parentElement !== slot.parent || ph.nextElementSibling !== slot.before) {
            slot.parent.insertBefore(ph, slot.before);
          }
          ph.classList.toggle('is-inside-group', !!slot.insideGroup);
          dragState.slot = slot;
        };

        const updateSlot = (x, y) => {
          const slot = computeSlot(x, y);
          if (slot) movePlaceholder(slot);
        };

        // 拖出编辑弹窗时：把所有分组「收起」（保留组头、隐藏组内条目），
        // 而不是把组员展平成普通条目；拖回弹窗或拖拽结束后恢复原来的折叠状态。
        const restoreCollapsedState = () => {
          if (!dragState.savedCollapsed) return;
          collapsed.clear();
          dragState.savedCollapsed.forEach((k) => collapsed.add(k));
          routeHost.querySelectorAll('.route-group').forEach((g) => {
            g.classList.toggle('is-collapsed', collapsed.has(g.dataset.gkey));
            g.classList.remove('is-drag-collapsed');
          });
          dragState.savedCollapsed = null;
        };

        const enterOutsideMode = () => {
          dragState.outside = true;
          dragState.savedCollapsed = new Set(collapsed);
          const ph = dragState.placeholder;
          if (ph) {
            // 占位块在分组里时先移到组外，保证收起后仍然可见
            const groupEl = ph.parentElement && ph.parentElement.classList.contains('route-group') ? ph.parentElement : null;
            if (groupEl) {
              groupEl.parentElement.insertBefore(ph, groupEl.nextSibling);
              ph.classList.remove('is-inside-group');
              dragState.slot = {
                parent: ph.parentElement,
                before: ph.nextElementSibling,
                insideGroup: false,
              };
            }
          }
          // 只收起源条目所在的分组，其他分组保持原状
          const srcGroup = dragState.sourceEl ? dragState.sourceEl.closest('.route-group') : null;
          if (!srcGroup) return;
          const key = srcGroup.dataset.gkey;
          const wasCollapsed = collapsed.has(key);
          collapsed.add(key);
          srcGroup.classList.add('is-collapsed');
          if (!wasCollapsed) srcGroup.classList.add('is-drag-collapsed');
        };

        // 根据占位块当前所在的 DOM 位置执行插入。
        const applyDrop = () => {
          const rl = routeHost.querySelector('#rl');
          const ph = dragState.placeholder;
          if (!rl || !ph) return false;

          if (dragState.kind === 'item') {
            const item = draft.routes[dragState.idx];
            if (!item) return false;
            // 占位块后面的第一个条目就是插入点；没有则追加到末尾。
            // 这里按 DOM 顺序取全部条目（包含临时收起的分组条目），
            // 否则拖出弹窗、分组收起时会被错误地追加到列表末尾。
            const items = Array.from(rl.querySelectorAll('.route-item'))
              .filter((el) => el !== dragState.sourceEl);
            const nextEl = items.find((el) =>
              (ph.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
            const targetRoute = nextEl ? draft.routes[Number(nextEl.dataset.i)] : null;
            const groupEl = ph.parentElement.classList.contains('route-group') ? ph.parentElement : null;
            const group = groupEl ? (Number(groupEl.dataset.group) || 0) : 0;

            const from = draft.routes.indexOf(item);
            if (from < 0) return false;
            draft.routes.splice(from, 1);
            if (targetRoute && targetRoute !== item) {
              const ti = draft.routes.indexOf(targetRoute);
              if (ti >= 0) draft.routes.splice(ti, 0, item);
              else draft.routes.push(item);
            } else {
              draft.routes.push(item);
            }
            item.group = group;
            return true;
          }

          // 整组拖拽：找到占位块后面的最外层单元，把整组插到它前面
          const moved = draft.routes.filter((r) => r.group === dragState.group);
          if (!moved.length) return false;
          const units = Array.from(rl.children).filter((el) =>
            el !== ph && el !== dragState.sourceEl && el.offsetParent !== null);
          const nextUnit = units.find((el) =>
            (ph.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
          let targetRoute = null;
          if (nextUnit) {
            if (nextUnit.classList.contains('route-group')) {
              targetRoute = draft.routes[Number(nextUnit.dataset.gstart)];
            } else if (nextUnit.classList.contains('route-item')) {
              targetRoute = draft.routes[Number(nextUnit.dataset.i)];
            }
          }
          const rest = draft.routes.filter((r) => !moved.includes(r));
          if (targetRoute && !moved.includes(targetRoute)) {
            const ti = rest.indexOf(targetRoute);
            if (ti >= 0) draft.routes = rest.slice(0, ti).concat(moved, rest.slice(ti));
            else draft.routes = rest.concat(moved);
          } else {
            draft.routes = rest.concat(moved);
          }
          return true;
        };

        const autoScrollTick = () => {
          if (!dragState.active || !dragState.started) { dragRaf = 0; return; }
          const box = mo.body;
          const rect = box.getBoundingClientRect();
          const edge = 36;
          const y = dragState.lastY;
          let dy = 0;
          if (y < rect.top + edge) dy = -Math.max(2, Math.round((rect.top + edge - y) / 3));
          else if (y > rect.bottom - edge) dy = Math.max(2, Math.round((y - (rect.bottom - edge)) / 3));
          if (dy) {
            const before = box.scrollTop;
            box.scrollTop += dy;
            if (box.scrollTop !== before) updateSlot(dragState.lastX, dragState.lastY);
          }
          dragRaf = requestAnimationFrame(autoScrollTick);
        };

        const onDragMove = (e) => {
          if (!dragState.active || e.pointerId !== dragState.pointerId) return;
          dragState.lastX = e.clientX;
          dragState.lastY = e.clientY;
          if (!dragState.started) {
            const dx = e.clientX - dragState.startX;
            const dy = e.clientY - dragState.startY;
            if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
            dragState.started = true;
            startPlaceholder();
            startGhost(e.clientX, e.clientY);
            document.body.classList.add('is-route-dragging');
            dragRaf = requestAnimationFrame(autoScrollTick);
          }
          e.preventDefault();
          moveGhost(e.clientX, e.clientY);
          // 单条拖出编辑弹窗：只收起当前条目所在的分组，其他分组不受影响。
          // 收起后即使拖回弹窗也不自动展开，松手/取消后再恢复原来的折叠状态。
          if (dragState.kind === 'item') {
            const modalBox = mo.el.querySelector('.modal');
            let inside = true;
            if (modalBox) {
              const r = modalBox.getBoundingClientRect();
              inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
            }
            if (!inside && !dragState.outside) enterOutsideMode();
            // 收起后拖回弹窗：继续在收起后的列表里定位，不展开分组
            if (inside) updateSlot(e.clientX, e.clientY);
          } else {
            updateSlot(e.clientX, e.clientY);
          }
        };

        const detachDragListeners = () => {
          document.removeEventListener('pointermove', onDragMove);
          document.removeEventListener('pointerup', onDragEnd);
          document.removeEventListener('pointercancel', onDragCancel);
          window.removeEventListener('blur', onDragCancel);
          if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = 0; }
        };

        const cleanupDrag = () => {
          if (dragState.placeholder) { dragState.placeholder.remove(); dragState.placeholder = null; }
          if (dragState.sourceEl) {
            dragState.sourceEl.style.display = '';
            dragState.sourceEl.classList.remove('is-group-dragging');
            dragState.sourceEl = null;
          }
          if (dragState.ghost) { dragState.ghost.remove(); dragState.ghost = null; }
          document.body.classList.remove('is-route-dragging');
          dragState.slot = null;
          dragState.sourceRect = null;
          dragState.outside = false;
          dragState.savedCollapsed = null;
        };

        const finishDrag = (apply) => {
          if (!dragState.active) return;
          const started = dragState.started;
          const tap = dragState.tap;

          detachDragListeners();
          let moved = false;
          if (started && apply && dragState.slot) moved = applyDrop();
          // 先恢复分组折叠状态，再清理占位块/源条目
          if (dragState.outside) {
            dragState.outside = false;
            restoreCollapsedState();
          }
          cleanupDrag();

          dragState.active = false;
          dragState.started = false;
          dragState.kind = '';
          dragState.idx = -1;
          dragState.group = 0;
          dragState.pointerId = null;
          dragState.tap = null;

          if (started) {
            // 拖拽结束后吞掉落点上的 click，避免误触按钮/折叠
            const swallow = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
            document.addEventListener('click', swallow, true);
            setTimeout(() => document.removeEventListener('click', swallow, true), 0);
          }
          if (moved) { normalizeGroups(); renderRoutes(); return; }
          if (!started && tap) tap();
        };

        const onDragEnd = (e) => {
          if (dragState.pointerId != null && e && e.pointerId !== dragState.pointerId) return;
          finishDrag(true);
        };
        const onDragCancel = () => finishDrag(false);

        const beginDrag = (e, kind, idx, tap) => {
          if (dragState.active) return;
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          if (e.target.closest && e.target.closest('button, input, select, textarea, a')) return;
          e.preventDefault();
          dragState.active = true;
          dragState.started = false;
          dragState.kind = kind;
          dragState.idx = idx;
          dragState.group = kind === 'group' ? ((draft.routes[idx] && draft.routes[idx].group) || 0) : 0;
          dragState.startX = e.clientX;
          dragState.startY = e.clientY;
          dragState.lastX = e.clientX;
          dragState.lastY = e.clientY;
          dragState.pointerId = e.pointerId;
          dragState.ghost = null;
          dragState.placeholder = null;
          dragState.sourceEl = null;
          dragState.sourceRect = null;
          dragState.slot = null;
          dragState.outside = false;
          dragState.savedCollapsed = null;
          dragState.tap = tap || null;
          document.addEventListener('pointermove', onDragMove, { passive: false });
          document.addEventListener('pointerup', onDragEnd);
          document.addEventListener('pointercancel', onDragCancel);
          window.addEventListener('blur', onDragCancel);
        };

        const bindRouteDrag = () => {
          const rl = routeHost.querySelector('#rl');
          if (!rl) return;
          // 只有左侧手柄可以发起单条拖拽，整行不响应，避免误触
          rl.querySelectorAll('.route-item__handle').forEach((handle) => {
            handle.addEventListener('pointerdown', (e) => {
              const row = handle.closest('.route-item');
              if (!row) return;
              beginDrag(e, 'item', Number(row.dataset.i), null);
            });
          });
          // 组头只有左侧握把可以拖动整组
          rl.querySelectorAll('.route-group__grip').forEach((grip) => {
            grip.addEventListener('pointerdown', (e) => {
              const head = grip.closest('.route-group__head');
              if (!head) return;
              beginDrag(e, 'group', Number(head.dataset.gstart), null);
            });
          });
          // 点组头其余位置折叠/展开（按钮和握把除外）
          rl.querySelectorAll('.route-group__head[data-fold]').forEach((head) => {
            head.addEventListener('click', (e) => {
              if (e.target.closest && e.target.closest('button, input, select, textarea, a, .route-group__grip')) return;
              const key = head.dataset.fold;
              if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
              renderRoutes();
            });
          });
        };

        // 弹窗关闭时终止进行中的拖拽，避免遗留 document 监听
        const origClose = mo.close.bind(mo);
        mo.close = (...args) => {
          if (dragState.active) {
            dragState.tap = null;
            finishDrag(false);
          }
          origClose(...args);
        };


        const renderCaps = () => {
          capsHost.innerHTML = capsEditorHtml(draft.caps || {});
          bindCapsEditor(capsHost);
        };

        const renderRoutes = (flat = false) => {
          // 拖拽中不要重渲染，否则会破坏占位块和隐藏的源条目
          if (dragState.active && dragState.started) return;
          if (!draft.routes.length) {
            routeHost.innerHTML = `<div class="route-list" style="display:flex;align-items:center;justify-content:center;padding:18px">
              <span class="muted fs-12">还没有选择路由模型，点击下方「选择渠道模型」添加</span>
            </div>`;
            return;
          }
          const segs = splitGroups();
          // 显示编号：每个单元（普通条目或组）占一个号，组内成员不单独编号
          const segNum = {};
          {
            let num = 0;
            segs.forEach((s, k) => { segNum[k] = ++num; });
          }
          const segOf = (i) => segs.findIndex((s) => s.includes(i));
          const routeBadge = (r) => {
            if (!channelStateLoaded) return '';
            const c = channelState[r.channel_id];
            if (!c) return badge('渠道模型不存在', 'red');
            if (!c.enabled) return badge('渠道已禁用', 'red');
            if (!c.models.has(r.channel_id + '/' + r.upstream)) return badge('渠道模型不存在', 'red');
            return '';
          };
          let html = `<div class="route-list ${flat ? 'is-flat' : ''}" id="rl">`;
          // 组内条目显示权重输入；组外（普通）条目不显示（权重无意义）
          const itemHtml = (i, inGroup, num) => {
            const r = draft.routes[i];
            const sg = segOf(i);
            const segLen = segs[sg].length;
            const pos = segs[sg].indexOf(i);
            // 组内条目的上/下移只在组内换位；组外条目整单元移动
            const upDisabled = inGroup ? (pos <= 0 ? 'disabled' : '') : (sg <= 0 ? 'disabled' : '');
            const downDisabled = inGroup ? (pos >= segLen - 1 ? 'disabled' : '') : (sg >= segs.length - 1 ? 'disabled' : '');
            const moveAttr = inGroup ? (b) => b : (b) => b + '-unit';
            // 拆分按钮：组内成员都显示（把它拆出去变成普通条目）
            const splitUp = inGroup
              ? `<button class="btn btn--ghost btn--sm btn--icon" data-split-up="${i}" title="分开：把这个条目从组里拆出去（变成普通条目）">${icon('unlink', 12)}</button>` : '';
            const splitDown = '';
            // 合并按钮：普通条目才显示；相邻单元无论是普通条目还是组都直接并入
            const mergeUp = !inGroup && sg > 0
              ? `<button class="btn btn--ghost btn--sm btn--icon" data-merge-up="${i}" title="与上面的条目/分组合并为一个组">${icon('link', 12)}</button>` : '';
            const mergeDown = !inGroup && sg < segs.length - 1
              ? `<button class="btn btn--ghost btn--sm btn--icon" data-merge-down="${i}" title="与下面的条目/分组合并为一个组">${icon('link', 12)}</button>` : '';
            return `<div class="route-item ${inGroup ? 'is-grouped' : ''}" data-i="${i}">
              <span class="route-item__handle" title="拖动调整位置">${icon('grip', 14)}</span>
              ${num ? `<span class="route-item__idx">${num}</span>` : ''}
              <span class="route-item__name">${esc(r.model_id)}</span>
              <span class="route-item__meta">
                ${routeBadge(r)}
                ${inGroup ? `<span class="route-item__weight" title="组内权重：按权重随机决定组内尝试顺序，权重越高越可能靠前">
                  <input type="number" class="input route-w-input" data-w="${i}" min="0" max="1000" value="${r.weight || 0}">
                  <span class="muted fs-11">权</span>
                </span>` : ''}
                ${mergeUp}${mergeDown}${splitUp}${splitDown}
                <button class="btn btn--ghost btn--sm btn--icon" ${inGroup ? `data-up="${i}"` : `data-up-unit="${i}"`} title="${inGroup ? '组内上移' : '上移'}" ${upDisabled}>${icon('up', 12)}</button>
                <button class="btn btn--ghost btn--sm btn--icon" ${inGroup ? `data-down="${i}"` : `data-down-unit="${i}"`} title="${inGroup ? '组内下移' : '下移'}" ${downDisabled}>${icon('down', 12)}</button>
                <button class="btn btn--ghost btn--sm btn--icon" data-rm="${i}" title="移除">${icon('x', 12)}</button>
              </span>
            </div>`;
          };
          if (flat) {
            html += draft.routes.map((_, i) => itemHtml(i, false, i + 1)).join('');
          } else {
            html += segs.map((seg, k) => {
              const num = segNum[k];
              if (seg.length === 1) return itemHtml(seg[0], false, num);
              const ws = weightSum(seg);
              const ratio = seg.map((i) => draft.routes[i].weight || 0).join(' ∶ ');
              const gkey = draft.routes[seg[0]].model_id;
              const isFolded = collapsed.has(gkey);
              return `<div class="route-group ${isFolded ? 'is-collapsed' : ''}" data-gkey="${esc(gkey)}" data-gstart="${seg[0]}" data-group="${draft.routes[seg[0]].group}">
                <div class="route-group__head" data-fold="${esc(gkey)}" data-gstart="${seg[0]}" title="${isFolded ? '展开分组' : '收起分组'}">
                  <span class="route-group__grip" title="拖动整组">${icon('grip', 13)}</span>
                  <span class="route-item__idx">${num}</span>
                  <span class="route-group__tag">${icon('box', 12)}${seg.length}个模型</span>
                  <span class="muted fs-11" style="margin-left:auto">组内权重比 ${ws > 0 ? ratio : '均等（随机）'}</span>
                  <button class="btn btn--ghost btn--sm btn--icon" data-up-unit="${seg[0]}" title="整组上移" ${k <= 0 ? 'disabled' : ''}>${icon('up', 12)}</button>
                  <button class="btn btn--ghost btn--sm btn--icon" data-down-unit="${seg[0]}" title="整组下移" ${k >= segs.length - 1 ? 'disabled' : ''}>${icon('down', 12)}</button>
                  ${icon(isFolded ? 'down' : 'up', 13)}
                </div>
                ${isFolded ? '' : seg.map((i) => itemHtml(i, true, '')).join('')}
              </div>`;
            }).join('');
          }
          html += `</div>`;
          routeHost.innerHTML = html;

          const rl = routeHost.querySelector('#rl');
          const rerender = () => { normalizeGroups(); renderRoutes(); };

          rl.querySelectorAll('[data-rm]').forEach((b) => {
            b.onclick = (e) => { e.stopPropagation(); draft.routes.splice(Number(b.dataset.rm), 1); rerender(); };
          });
          // 上移/下移：以单元（普通条目或整组）为单位整体交换，组不会被打散
          const moveUnit = (i, dir) => {
            const sg = segs.findIndex((s) => s.includes(i));
            const tg = sg + dir;
            if (tg < 0 || tg >= segs.length) return;
            const flat2 = [];
            segs.forEach((s, k) => {
              (k === tg ? segs[sg] : k === sg ? segs[tg] : s).forEach((x) => flat2.push(draft.routes[x]));
            });
            draft.routes = flat2;
            rerender();
          };
          // 组内上/下移：只在所在组内换位
          const moveInside = (i, dir) => {
            const sg = segs.findIndex((s) => s.includes(i));
            const seg = segs[sg];
            const pos = seg.indexOf(i);
            const j = pos + dir;
            if (j < 0 || j >= seg.length) return;
            [draft.routes[seg[pos]], draft.routes[seg[j]]] = [draft.routes[seg[j]], draft.routes[seg[pos]]];
            rerender();
          };
          rl.querySelectorAll('[data-up]').forEach((b) => {
            b.onclick = (e) => { e.stopPropagation(); moveInside(Number(b.dataset.up), -1); };
          });
          rl.querySelectorAll('[data-down]').forEach((b) => {
            b.onclick = (e) => { e.stopPropagation(); moveInside(Number(b.dataset.down), 1); };
          });
          // 单元上/下移：普通条目或整组一起移动
          rl.querySelectorAll('[data-up-unit]').forEach((b) => {
            b.onclick = (e) => { e.stopPropagation(); moveUnit(Number(b.dataset.upUnit), -1); };
          });
          rl.querySelectorAll('[data-down-unit]').forEach((b) => {
            b.onclick = (e) => { e.stopPropagation(); moveUnit(Number(b.dataset.downUnit), 1); };
          });
          // 权重输入
          rl.querySelectorAll('[data-w]').forEach((inp) => {
            inp.onchange = () => {
              const v = Math.max(0, Math.min(1000, Math.round(Number(inp.value) || 0)));
              inp.value = v;
              draft.routes[Number(inp.dataset.w)].weight = v;
              rerender(); // 刷新组头权重比
            };
          });
          // 合并：与上/下面那个单元（普通条目或组）合并；对方是组就直接并入它的组
          rl.querySelectorAll('[data-merge-up]').forEach((b) => {
            b.onclick = (e) => {
              e.stopPropagation();
              const i = Number(b.dataset.mergeUp);
              const up = draft.routes[i - 1];
              const g = up.group || Math.max(0, ...draft.routes.map((r) => r.group || 0)) + 1;
              up.group = g;
              draft.routes[i].group = g;
              rerender();
            };
          });
          rl.querySelectorAll('[data-merge-down]').forEach((b) => {
            b.onclick = (e) => {
              e.stopPropagation();
              const i = Number(b.dataset.mergeDown);
              const down = draft.routes[i + 1];
              const g = down.group || Math.max(0, ...draft.routes.map((r) => r.group || 0)) + 1;
              down.group = g;
              draft.routes[i].group = g;
              rerender();
            };
          });
          // 拆分：把自己从组里拆出去变成普通条目（normalizeGroups 会顺带解散剩一条的组）
          rl.querySelectorAll('[data-split-up], [data-split-down]').forEach((b) => {
            b.onclick = (e) => {
              e.stopPropagation();
              draft.routes[Number(b.dataset.splitUp ?? b.dataset.splitDown)].group = 0;
              rerender();
            };
          });

          // 拖拽排序由指针事件控制器统一处理（拖条目 / 拖组头）
          bindRouteDrag();
        };

        renderRoutes();
        renderCaps();

        State.loadChannels().then((chs) => {
          (chs || []).forEach((c) => {
            channelState[c.id] = { enabled: c.enabled, models: new Set(c.channel_models || []) };
          });
          channelStateLoaded = true;
          renderRoutes();
        }).catch(() => {});

        mo.body.querySelector('#cm-route-help').onclick = () => {
          openModal({
            title: '路由规则',
            size: 'sm',
            body: `<div class="fs-13" style="line-height:1.8">
              <div style="margin-bottom:8px"><b>尝试顺序</b>：普通条目按从上到下的顺序依次尝试。</div>
              <div style="margin-bottom:8px"><b>合并分组</b>：相邻条目「合并」成组后，组内每次按权重随机排序再依次尝试（权重越高越可能靠前，权重全部相等时等概率），全部失败再到后面的条目。</div>
              <div style="margin-bottom:8px"><b>拖拽排序</b>：按住左侧手柄拖动调整单条位置；按住组头左侧握把拖动调整整组位置。</div>
              <div style="margin-bottom:8px"><b>拖出弹窗</b>：只会收起当前条目所在的分组（拖回不会自动展开，松手后恢复），不影响其他分组。</div>
              <div><b>合并 / 分开</b>：组外条目用「合并」按钮，组内条目用「分开」按钮。</div>
            </div>`,
            footer: `<div class="spacer"></div><button class="btn" data-close>知道了</button>`,
          });
        };

        routeModeEl.querySelectorAll('[data-route-mode]').forEach((b) => {
          b.onclick = () => setRouteMode(b.dataset.routeMode);
        });
        mo.body.querySelector('[data-act=copy-json]').onclick = () => {
          copyText(routeJsonInput.value, '路由 JSON ');
        };
        mo.body.querySelector('[data-act=paste-json]').onclick = () => {
          pasteTextInto(routeJsonInput);
        };

        mo.body.querySelector('[data-act=pick]').onclick = () => {
          openRoutePicker(draft.routes, (picked) => {
            draft.routes = picked;
            normalizeGroups();
            renderRoutes();
          });
        };

        mo.foot.querySelector('[data-act=cancel]').onclick = () => mo.close();
        mo.foot.querySelector('[data-act=save]').onclick = async () => {
          const newID = (mo.body.querySelector('#cm-id').value || '').trim();
          if (!newID) { Toast.warn('请填写模型 ID'); return; }
          if (newID.includes('/')) { Toast.warn('模型 ID 不能包含 “/”'); return; }
          // JSON 模式下直接保存时，先把 textarea 里的内容解析回草稿
          if (routeMode === 'json') {
            try {
              applyRouteJSON();
            } catch (e) {
              Toast.error(e.message, 'JSON 格式有误');
              return;
            }
          }
          if (!draft.routes.length) { Toast.warn('请至少选择一个目标路由模型'); return; }
          let caps;
          try {
            caps = readCapsEditor(capsHost);
          } catch (e) {
            Toast.error(e.message, '能力参数格式有误');
            return;
          }

          const payload = {
            id: newID,
            type: 'custom',
            provider_id: readProviderSelect(mo.body, 'cm-provider', State.providers || [], newID),
            routes: draft.routes.map((r) => ({ channel_id: r.channel_id, upstream: r.upstream, weight: r.weight || 0, group: r.group || 0 })),
            affinity: mo.body.querySelector('#cm-affinity').checked,
            cooldown_sec: Math.max(0, Math.min(86400, Math.round(Number(mo.body.querySelector('#cm-cooldown').value) || 0))),
            cooldown_reset: mo.body.querySelector('#cm-cooldown-reset').checked,
            no_retry_status: mo.body.querySelector('#cm-no-retry').value.trim(),
            timeout: Math.max(1, Math.round(Number(mo.body.querySelector('#cm-timeout').value) || 300)),
            caps,
            enabled: mo.body.querySelector('#cm-enabled').checked,
            description: mo.body.querySelector('#cm-desc').value.trim(),
            tags: mo.body.querySelector('#cm-tags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
          };

          const btn = mo.foot.querySelector('[data-act=save]');
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner" style="width:13px;height:13px"></span>保存中';
          // URL 里放改名前的 ID，body 里是目标 ID，后端据此完成重命名
          const urlID = isNew ? newID : m.id;
          try {
            await API.put('/api/models/' + encodeURIComponent(urlID), payload);
            // 新建或改名后把展开状态落到新的模型 ID，之后编辑时能直接恢复。
            if (isNew || newID !== m.id) {
              try {
                const details = mo.body.querySelector('details.advanced-settings');
                localStorage.setItem(advancedKey('model', newID), details && details.open ? '1' : '0');
                if (!isNew) localStorage.removeItem(advancedKey('model', m.id));
              } catch (e) { /* 忽略配额错误 */ }
            }
            mo.close();
            const renamed = !isNew && newID !== m.id;
            if (renamed) {
              Toast.success(`模型已重命名：${m.id} → ${newID}`);
            } else {
              Toast.success(`自定义模型 ${newID} 已保存，路由 ${draft.routes.length} 个渠道模型`);
            }
            State.invalidate('models');
            window.LDM.navigate();
          } catch (e) {
            Toast.error(e.message, '保存失败');
            btn.disabled = false;
            btn.textContent = isNew ? '创建模型' : '保存修改';
          }
        };
      },
    });
  }

  // ---------- 弹窗2：选择路由渠道模型（复用模型选择弹窗） ----------
  async function openRoutePicker(currentRoutes, onDone) {
    await openModelPicker({
      mode: 'route',
      title: '选择目标路由模型',
      desc: '从渠道模型中选择，可多选。「已添加」是打开弹窗时的路由快照，不随本次勾选变化；未在「模型管理」中的渠道模型也能直接作为路由目标，不会自动加入模型列表。完成后可在主弹窗里拖动调整顺序。',
      top: true,
      preselected: new Set(currentRoutes.map((r) => r.model_id)),
      onConfirm(ids, items) {
        const byId = {};
        items.forEach((it) => { byId[it.id] = it; });
        // 保留原有顺序，新勾选的追加到末尾
        const kept = currentRoutes.filter((r) => ids.includes(r.model_id));
        const added = ids.filter((id) => !kept.some((r) => r.model_id === id)).map((id) => {
          const info = byId[id] || {};
          const slash = id.indexOf('/');
          return {
            model_id: id,
            channel_id: info.channel_id || id.slice(0, slash),
            upstream: info.upstream || id.slice(slash + 1),
            channel_name: info.channel_name || '',
            weight: 0,
            group: 0,
          };
        });
        onDone(kept.concat(added));
      },
    });
  }

  // 令牌管理等其他页面复用同一个模型选择弹窗
  window.LDM.openModelPicker = openModelPicker;
})();
