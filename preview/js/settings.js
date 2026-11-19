/* ==========================================================================
   设置抽屉（右上角齿轮）
   —— 令牌管理 + 现有系统设置全部收进来：
      站点信息、主题、日志保留、CORS、允许直接调用渠道模型、
      亲和自动清理、备份导出、修改密码、运行信息。
   ========================================================================== */
(function () {
  'use strict';

  const {
    esc, icon, fmtInt, fmtNum, fmtTime, relTime, fmtUptime, fmtMem, copyText,
    badge, statusBadge, switchEl, Toast, openModal, confirmDialog, Theme, Tip,
  } = window.PV;
  const D = window.PVDATA;

  const BACKUP_SCOPES = [
    ['channels', '渠道配置', '含明文上游 Key'],
    ['models', '模型配置', '路由与能力参数'],
    ['providers', '提供商', '名称、图标与匹配词'],
    ['tokens', 'API 密钥', '含明文 Key'],
    ['settings', '系统设置', '站点信息与密码哈希'],
    ['logs', '调用日志', '数据量大时较慢'],
    ['stats', '统计数据', '按小时聚合'],
  ];

  const revealed = new Set();
  let tab = 'tokens';
  let panelHost = null;

  const TABS = [
    ['tokens', '令牌管理'],
    ['site', '站点信息'],
    ['security', '安全'],
    ['data', '数据与运行'],
  ];

  function maskKey(k) {
    if (!k) return '';
    if (k.length <= 16) return k.slice(0, 4) + '••••';
    return k.slice(0, 12) + '••••' + k.slice(-4);
  }

  function nowStr() {
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  // ======================================================================
  // 设置页（整页，不用抽屉）
  // ======================================================================
  function render(root, sub) {
    tab = TABS.some(([k]) => k === sub) ? sub : 'tokens';
    root.innerHTML = `
      <div class="usage-shell">
        <aside class="usage-rail">
          <div class="usage-rail__title">设置</div>
          ${TABS.map(([k, t]) => `<button class="usage-rail__item${tab === k ? ' is-active' : ''}" data-tab="${k}">
            ${icon(k === 'tokens' ? 'tokens' : k === 'site' ? 'settings' : k === 'security' ? 'shield' : 'database', 16)}${t}
          </button>`).join('')}
          <div class="usage-rail__meta">令牌、站点、安全与数据都在这一页；修改后立即生效的设置会同步到顶栏。</div>
        </aside>
        <section class="usage-body" id="gset-panel"></section>
      </div>`;
    root.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.onclick = () => {
        if (tab === btn.dataset.tab) return;
        window.PVNavigate('#/settings/' + btn.dataset.tab);
      };
    });
    panelHost = document.getElementById('gset-panel');
    renderPanel();
  }

  function renderPanel() {
    if (!panelHost) return;
    panelHost.dataset.tab = tab;
    if (tab === 'tokens') panelHost.innerHTML = tokensHtml();
    else if (tab === 'site') panelHost.innerHTML = siteHtml();
    else if (tab === 'security') panelHost.innerHTML = securityHtml();
    else panelHost.innerHTML = dataHtml();
    bindPanel(panelHost);
    Tip.hide();
  }

  // ======================================================================
  // 令牌管理
  // ======================================================================
  function tokensHtml() {
    const list = D.tokens;
    return `
      <div class="page-head">
        <div class="page-head__titles">
          <div class="page-head__title">${icon('tokens', 20)}令牌管理</div>
          <div class="page-head__desc">一个密钥调用全部已启用模型；额度、模型权限和 IP 限制按令牌生效</div>
        </div>
        <div class="page-head__actions">
          <button class="btn btn--sm btn--primary" id="tk-create">${icon('plus', 13)}创建密钥</button>
        </div>
      </div>

      <div class="gset__sec">
        <div class="gset__sec-title">API 密钥（${list.length}）</div>
        ${list.length ? list.map((t) => {
          const shown = revealed.has(t.id);
          const pct = t.quota_limit ? Math.min(100, Math.round((t.used_quota / t.quota_limit) * 100)) : 0;
          return `<div class="tk-row" data-tid="${esc(t.id)}">
            <div class="tk-row__main">
              <div class="tk-row__name">
                ${esc(t.name)}
                ${t.expired ? badge('已过期', 'red') : t.enabled ? badge('启用', 'green') : badge('禁用', 'gray')}
                ${t.remark ? `<span class="muted fs-11" style="font-weight:500">${esc(t.remark)}</span>` : ''}
              </div>
              <div class="tk-row__key">
                <span>${esc(shown ? t.key : maskKey(t.key))}</span>
                <button class="mini-act" data-tk-eye="${esc(t.id)}" title="${shown ? '隐藏' : '显示完整 Key'}">${icon(shown ? 'eyeOff' : 'eye', 11)}</button>
                <button class="mini-act" data-tk-copy="${esc(t.id)}" title="复制 Key">${icon('copy', 11)}</button>
              </div>
              <div class="tk-row__usage">
                <span>${fmtInt(t.used_quota)}${t.quota_limit ? ` / ${fmtInt(t.quota_limit)}` : ' / 无限制'}</span>
                ${t.quota_limit ? `<span class="tk-bar"><span class="tk-bar__fill${pct > 90 ? ' is-high' : ''}" style="width:${pct}%"></span></span>` : ''}
                <span>·</span>
                <span>${t.allowed_models.length ? `${t.allowed_models.length} 个模型权限` : '全部模型'}</span>
                <span>·</span>
                <span>${t.allowed_ips.length ? `${t.allowed_ips.length} 条 IP 限制` : '全部 IP'}</span>
                <span>·</span>
                <span>${relTime(t.last_used_at)}</span>
              </div>
            </div>
            <div class="tk-row__acts">
              <button class="mini-act" data-tk-toggle="${esc(t.id)}" title="${t.enabled ? '禁用' : '启用'}">${icon(t.enabled ? 'pause' : 'play', 12)}</button>
              <button class="mini-act" data-tk-edit="${esc(t.id)}" title="编辑">${icon('edit', 12)}</button>
              <button class="mini-act mini-act--danger" data-tk-del="${esc(t.id)}" title="删除">${icon('trash', 12)}</button>
            </div>
          </div>`;
        }).join('') : `<div class="col-empty">还没有创建密钥。创建一个，就能用它调用所有已启用的模型。</div>`}
      </div>

      <div class="gset__sec">
        <div class="gset__sec-title">接入方式</div>
        <div class="fs-12 muted" style="margin-bottom:6px">网关兼容 OpenAI 协议，任何 OpenAI SDK 只需替换 base_url 与 api_key。</div>
        <pre class="tool-call__code" style="white-space:pre-wrap;font-size:10.5px">curl ${location.origin || 'http://127.0.0.1:8080'}/v1/chat/completions \\
  -H "Authorization: Bearer ${esc(D.tokens[0] ? maskKey(D.tokens[0].key) : 'sk-ldm-...')}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"LDM","messages":[{"role":"user","content":"你好"}]}'</pre>
        <div style="display:flex;gap:6px;margin-top:8px">
          <button class="btn btn--sm" id="tk-copy-curl">${icon('copy', 11)}复制示例</button>
          <button class="btn btn--sm" id="tk-copy-base">${icon('link', 11)}复制 Base URL</button>
        </div>
      </div>`;
  }

  // ======================================================================
  // 站点信息
  // ======================================================================
  function siteHtml() {
    const s = D.settings;
    return `
      <div class="page-head">
        <div class="page-head__titles">
          <div class="page-head__title">${icon('settings', 20)}站点信息</div>
          <div class="page-head__desc">显示在顶栏与浏览器标题；外观主题立即生效</div>
        </div>
        <div class="page-head__actions">
          <button class="btn btn--sm btn--primary" id="s-save">${icon('check', 13)}保存设置</button>
        </div>
      </div>

      <div class="gset__sec">
        <div class="gset__sec-title">站点信息</div>
        <div class="field">
          <label class="field__label">站点名称</label>
          <input class="input" id="s-name" placeholder="懒大猫 API" value="${esc(s.site_name || '')}">
        </div>
        <div class="field">
          <label class="field__label">副标题</label>
          <input class="input" id="s-sub" placeholder="模型聚合网关" value="${esc(s.site_subtitle || '')}">
        </div>
        <div class="field">
          <label class="field__label">站点图标</label>
          <div class="input-group">
            <input class="input" id="s-logo" placeholder="图片直链或 data:image/..." value="${esc(s.logo || '')}">
            <img id="s-logo-preview" src="${esc(s.logo || '../web/assets/logo.jpg')}" alt="" style="width:38px;height:38px;border-radius:10px;border:2px solid var(--card-line);object-fit:cover">
          </div>
          <div class="field__hint">留空使用内置图标；支持任意图片直链。</div>
        </div>
        <div class="field">
          <label class="field__label">外观主题</label>
          <div class="pill-toggle" id="s-theme">
            <button data-theme="light" class="${Theme.get() === 'light' ? 'is-on' : ''}">浅色</button>
            <button data-theme="dark" class="${Theme.get() === 'dark' ? 'is-on' : ''}">深色</button>
          </div>
        </div>
      </div>

      <div class="gset__sec">
        <div class="gset__sec-title">运行限制</div>
        <div class="gset-row">
          <div class="gset-row__main">
            <div class="gset-row__label">日志保留天数</div>
            <div class="gset-row__desc">0 表示永久保留；超过天数的日志与统计会被清理</div>
          </div>
          <div class="gset-row__ctl"><input class="input" type="number" min="0" id="s-retention" value="${s.log_retention_days || 0}"></div>
        </div>
        <div class="gset-row">
          <div class="gset-row__main">
            <div class="gset-row__label">API 跨域白名单</div>
            <div class="gset-row__desc">逗号分隔；留空或 * 表示不限制 /v1 浏览器跨域</div>
          </div>
          <div class="gset-row__ctl" style="flex:1"><input class="input" id="s-cors" style="width:100%" placeholder="https://example.com" value="${esc(s.allow_origins || '')}"></div>
        </div>
        <div class="gset-row">
          <div class="gset-row__main">
            <div class="gset-row__label">允许直接调用渠道模型</div>
            <div class="gset-row__desc">开启后可直接用「渠道ID/模型ID」调用渠道里配置的模型，无需先加入模型管理</div>
          </div>
          <div class="gset-row__ctl">${switchEl(!!s.allow_unlisted_channel_models, '', 'id="s-unlisted"')}</div>
        </div>
      </div>

      <div class="gset__sec">
        <div class="gset__sec-title">亲和自动清理</div>
        <div class="gset-row">
          <div class="gset-row__main">
            <div class="gset-row__label">清理间隔（小时）</div>
            <div class="gset-row__desc">0 表示不自动清理；定时清空「上次成功优先」的偏好，不动失败冷却</div>
          </div>
          <div class="gset-row__ctl"><input class="input" type="number" min="0" max="8760" id="s-aff-hours" value="${s.affinity_cleanup_hours || 0}"></div>
        </div>
        <div class="gset-row">
          <div class="gset-row__main"><div class="gset-row__label">渠道 Key 亲和</div></div>
          <div class="gset-row__ctl">${switchEl(!!s.affinity_clean_channel, '', 'id="s-aff-ch"')}</div>
        </div>
        <div class="gset-row">
          <div class="gset-row__main"><div class="gset-row__label">模型路由亲和</div></div>
          <div class="gset-row__ctl">${switchEl(!!s.affinity_clean_model, '', 'id="s-aff-md"')}</div>
        </div>
        <div class="gset-row">
          <div class="gset-row__main">
            <div class="gset-row__desc" id="s-aff-meta"></div>
          </div>
          <div class="gset-row__ctl">
            <button class="btn btn--sm" id="s-aff-clear">${icon('trash', 11)}立即清理</button>
          </div>
        </div>
      </div>`;
  }

  // ======================================================================
  // 安全
  // ======================================================================
  function securityHtml() {
    const me = D.me;
    return `
      <div class="page-head">
        <div class="page-head__titles">
          <div class="page-head__title">${icon('shield', 20)}安全</div>
          <div class="page-head__desc">管理端密码与会话</div>
        </div>
      </div>

      <div class="gset__sec">
        <div class="gset__sec-title">管理端密码</div>
        ${me.default_password ? '<div class="alert alert--warn" style="margin-bottom:10px">当前仍在使用默认密码，请立即修改。</div>' : ''}
        <div class="field">
          <label class="field__label">当前密码</label>
          <input class="input" type="password" id="p-old" placeholder="输入当前密码" autocomplete="current-password">
        </div>
        <div class="field">
          <label class="field__label">新密码</label>
          <input class="input" type="password" id="p-new" placeholder="至少 6 位" autocomplete="new-password">
        </div>
        <div class="field">
          <label class="field__label">确认新密码</label>
          <input class="input" type="password" id="p-new2" placeholder="再输入一次" autocomplete="new-password">
        </div>
        <div class="fs-11 muted" style="margin-bottom:10px">修改成功后所有已登录会话（包括当前浏览器）会立即失效，下次请求需要重新登录。</div>
        <button class="btn btn--primary btn--sm" id="p-save">${icon('shield', 12)}修改密码</button>
      </div>

      <div class="gset__sec">
        <div class="gset__sec-title">会话</div>
        <div class="gset-row">
          <div class="gset-row__main">
            <div class="gset-row__label">当前登录</div>
            <div class="gset-row__desc">管理员 · 会话 Cookie 有效期 7 天</div>
          </div>
          <div class="gset-row__ctl">
            <button class="btn btn--sm btn--danger" id="p-logout">${icon('logout', 12)}退出登录</button>
          </div>
        </div>
      </div>`;
  }

  // ======================================================================
  // 数据与运行
  // ======================================================================
  function dataHtml() {
    const me = D.me;
    return `
      <div class="page-head">
        <div class="page-head__titles">
          <div class="page-head__title">${icon('database', 20)}数据与运行</div>
          <div class="page-head__desc">备份写入服务器本地，不经浏览器下载</div>
        </div>
      </div>

      <div class="gset__sec">
        <div class="gset__sec-title">备份导出
          <label class="switch" style="margin-left:auto;gap:5px"><input type="checkbox" id="bk-all"><span class="switch__track"></span><span class="switch__label" style="font-size:11px">全选</span></label>
        </div>
        <div class="fs-11 muted" style="margin-bottom:8px;line-height:1.6">
          文件写入运行网关设备的数据目录下 backups 文件夹，不能通过浏览器下载。备份包含明文上游 Key 与 API 密钥，导出期间会暂停所有数据写入。
        </div>
        <div id="bk-scopes" style="display:flex;flex-direction:column;gap:2px">
          ${BACKUP_SCOPES.map(([v, name, desc]) => `
            <label class="gset-row" style="cursor:pointer;border-bottom:0;padding:5px 0">
              <input type="checkbox" data-bk="${v}" style="margin:0 2px">
              <div class="gset-row__main">
                <div class="gset-row__label">${esc(name)}</div>
                <div class="gset-row__desc">${esc(desc)}</div>
              </div>
            </label>`).join('')}
        </div>
        <div class="gset-row">
          <div class="gset-row__main"><div class="gset-row__label">JSON 缩进</div></div>
          <div class="gset-row__ctl">
            <select class="select" id="bk-indent" style="width:150px">
              <option value="0">紧凑（无缩进）</option>
              <option value="2" selected>2 空格缩进</option>
              <option value="4">4 空格缩进</option>
            </select>
            <button class="btn btn--sm btn--primary" id="bk-export">${icon('download', 11)}导出备份</button>
          </div>
        </div>
        <div id="bk-result"></div>
      </div>

      <div class="gset__sec">
        <div class="gset__sec-title">运行信息</div>
        <div class="gset-stats">
          <div class="gset-stat"><div class="gset-stat__k">版本</div><div class="gset-stat__v">v${esc(me.version)}</div></div>
          <div class="gset-stat"><div class="gset-stat__k">运行时间</div><div class="gset-stat__v">${fmtUptime(me.uptime_seconds)}</div></div>
          <div class="gset-stat"><div class="gset-stat__k">系统</div><div class="gset-stat__v" style="font-size:11.5px">${esc(me.system)}</div></div>
          <div class="gset-stat"><div class="gset-stat__k">内存占用</div><div class="gset-stat__v">${fmtMem(me.memory_bytes)}</div></div>
        </div>
        <div class="fs-11 muted" style="margin-top:8px">
          渠道 ${D.channels.length} · 模型 ${D.models.length} · 令牌 ${D.tokens.length} · 内置提供商 ${D.providers.length}
        </div>
      </div>`;
  }

  // ======================================================================
  // 事件绑定
  // ======================================================================
  function bindPanel(host) {
    if (tab === 'tokens') bindTokens(host);
    else if (tab === 'site') bindSite(host);
    else if (tab === 'security') bindSecurity(host);
    else bindData(host);
    Tip.hide();
  }

  function bindTokens(host) {
    host.querySelector('#tk-create').onclick = () => openTokenEditor(null);
    host.querySelectorAll('[data-tk-eye]').forEach((btn) => {
      btn.onclick = () => {
        const id = btn.dataset.tkEye;
        if (revealed.has(id)) revealed.delete(id);
        else revealed.add(id);
        renderPanel();
      };
    });
    host.querySelectorAll('[data-tk-copy]').forEach((btn) => {
      btn.onclick = () => {
        const t = D.tokens.find((x) => x.id === btn.dataset.tkCopy);
        if (t) copyText(t.key, '密钥 ');
      };
    });
    host.querySelectorAll('[data-tk-toggle]').forEach((btn) => {
      btn.onclick = () => {
        const t = D.tokens.find((x) => x.id === btn.dataset.tkToggle);
        if (!t) return;
        t.enabled = !t.enabled;
        t.updated_at = Date.now();
        Toast.success(`密钥「${t.name}」已${t.enabled ? '启用' : '禁用'}`);
        renderPanel();
      };
    });
    host.querySelectorAll('[data-tk-edit]').forEach((btn) => {
      btn.onclick = () => openTokenEditor(D.tokens.find((x) => x.id === btn.dataset.tkEdit));
    });
    host.querySelectorAll('[data-tk-del]').forEach((btn) => {
      btn.onclick = async () => {
        const t = D.tokens.find((x) => x.id === btn.dataset.tkDel);
        if (!t) return;
        const ok = await confirmDialog({
          title: '删除密钥',
          message: `确定删除密钥「${esc(t.name)}」吗？使用该密钥的调用会立即失效。`,
          confirmText: '删除',
          danger: true,
        });
        if (!ok) return;
        const i = D.tokens.indexOf(t);
        if (i >= 0) D.tokens.splice(i, 1);
        Toast.success('密钥已删除');
        renderPanel();
      };
    });
    const curl = host.querySelector('#tk-copy-curl');
    if (curl) {
      curl.onclick = () => {
        const code = host.querySelector('pre').textContent;
        const first = D.tokens[0];
        copyText(first ? code.replace(maskKey(first.key), first.key) : code, '示例命令');
      };
    }
    const base = host.querySelector('#tk-copy-base');
    if (base) base.onclick = () => copyText((location.origin || 'http://127.0.0.1:8080') + '/v1', 'Base URL ');
  }

  // ---------- 令牌编辑 ----------
  function openTokenEditor(t) {
    const isNew = !t;
    const draft = t ? Object.assign({}, t) : {
      name: '', key: '', enabled: true, expires_at: 0, quota_limit: 0,
      allowed_models: [], allowed_ips: [], remark: '',
    };
    const dateVal = draft.expires_at ? new Date(draft.expires_at).toISOString().slice(0, 10) : '';
    const mo = openModal({
      title: isNew ? '创建密钥' : '编辑密钥',
      size: 'lg',
      body: `
        <div class="gset-grid2">
          <div class="field">
            <label class="field__label">名称</label>
            <input class="input" id="t-name" placeholder="例如：我的应用" value="${esc(draft.name || '')}">
          </div>
          <div class="field">
            <label class="field__label">过期日期</label>
            <input class="input" type="date" id="t-expire" value="${dateVal}">
            <div class="field__hint">留空表示永不过期</div>
          </div>
        </div>
        <div class="field">
          <label class="field__label">密钥</label>
          <div class="input-group">
            <input class="input key-masked" id="t-key" placeholder="${isNew ? '留空自动生成' : '请填写密钥'}" value="${esc(isNew ? '' : draft.key)}">
            <button class="btn btn--icon btn--sm" id="t-key-eye" title="显示 / 隐藏">${icon('eye', 13)}</button>
            <button class="btn btn--icon btn--sm" id="t-key-copy" title="复制">${icon('copy', 13)}</button>
          </div>
          <div class="field__hint">${isNew ? '留空会在保存时自动生成 sk-ldm- 开头的密钥。' : '保存后旧密钥立即失效，请及时更新调用方配置。'}</div>
        </div>
        <div class="field">
          <label class="field__label">额度上限（Token 数）</label>
          <input class="input" type="number" min="0" id="t-quota" placeholder="留空表示不限制" value="${draft.quota_limit || ''}">
        </div>
        <div class="field">
          <label class="field__label">模型权限</label>
          <textarea class="textarea" id="t-models" rows="3" placeholder="留空表示全部模型；每行一个，支持 * 通配">${esc((draft.allowed_models || []).join('\n'))}</textarea>
          <div class="field__hint">支持 <code>*deepseek*</code>、<code>gpt*</code> 这类通配；也可以点下拉直接挑。
            <button class="btn btn--sm" id="t-pick" style="height:22px;padding:0 7px;font-size:10.5px;margin-left:4px">选择模型</button>
          </div>
        </div>
        <div class="field">
          <label class="field__label">IP 限制</label>
          <textarea class="textarea" id="t-ips" rows="2" placeholder="留空表示不限制；每行一条，支持 CIDR">${esc((draft.allowed_ips || []).join('\n'))}</textarea>
        </div>
        <div class="field">
          <label class="field__label">备注</label>
          <input class="input" id="t-remark" placeholder="可选" value="${esc(draft.remark || '')}">
        </div>
        <label class="switch"><input type="checkbox" id="t-enabled" ${draft.enabled ? 'checked' : ''}><span class="switch__track"></span><span class="switch__label">启用该密钥</span></label>`,
      footer: `<div class="spacer"></div><button class="btn" data-cancel>取消</button><button class="btn btn--primary" data-save>${isNew ? '创建' : '保存'}</button>`,
    });
    const eye = mo.body.querySelector('#t-key-eye');
    eye.onclick = () => {
      const input = mo.body.querySelector('#t-key');
      input.classList.toggle('key-masked');
      eye.innerHTML = icon(input.classList.contains('key-masked') ? 'eye' : 'eyeOff', 13);
    };
    mo.body.querySelector('#t-key-copy').onclick = () => {
      const v = mo.body.querySelector('#t-key').value;
      if (!v) Toast.info(isNew ? '留空将在保存后自动生成密钥' : '请填写密钥');
      else copyText(v, '密钥 ');
    };
    mo.body.querySelector('#t-pick').onclick = () => {
      pickModels(mo.body.querySelector('#t-models').value).then((picked) => {
        if (picked == null) return;
        mo.body.querySelector('#t-models').value = picked.join('\n');
      });
    };
    mo.foot.querySelector('[data-cancel]').onclick = () => mo.close();
    mo.foot.querySelector('[data-save]').onclick = () => {
      const name = mo.body.querySelector('#t-name').value.trim();
      if (!name) { Toast.warn('请填写名称'); return; }
      const keyInput = mo.body.querySelector('#t-key').value.trim();
      if (!isNew && !keyInput) { Toast.warn('请填写密钥'); return; }
      const expire = mo.body.querySelector('#t-expire').value;
      const expires = expire ? new Date(expire + 'T23:59:59').getTime() : 0;
      const allowed_models = mo.body.querySelector('#t-models').value.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
      const allowed_ips = mo.body.querySelector('#t-ips').value.split('\n').map((s) => s.trim()).filter(Boolean);
      const quota = Number(mo.body.querySelector('#t-quota').value) || 0;
      const enabled = mo.body.querySelector('#t-enabled').checked;
      const remark = mo.body.querySelector('#t-remark').value.trim();

      let key = keyInput;
      if (isNew && !key) {
        let hex = '';
        for (let i = 0; i < 40; i++) hex += '0123456789abcdef'[Math.floor(Math.random() * 16)];
        key = 'sk-ldm-' + hex;
      }
      if (isNew) {
        D.tokens.unshift({
          id: 'tk_' + Math.random().toString(16).slice(2, 10), name, key, enabled,
          expires_at: expires, quota_limit: quota, used_quota: 0,
          allowed_models, allowed_ips, remark, created_at: Date.now(), updated_at: Date.now(),
          last_used_at: 0, expired: false, used_pct: 0,
        });
        Toast.success('密钥已创建，已复制到剪贴板', '创建成功');
        copyText(key, '新密钥 ');
        D.me.counts.tokens = D.tokens.length;
      } else {
        Object.assign(t, {
          name, key, enabled, expires_at: expires, quota_limit: quota,
          allowed_models, allowed_ips, remark, updated_at: Date.now(),
        });
        Toast.success('密钥已保存');
      }
      mo.close();
      renderPanel();
    };
  }

  function pickModels(raw) {
    return new Promise((resolve) => {
      const preset = new Set(String(raw || '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean));
      const models = D.modelsView();
      const custom = models.filter((m) => m.type === 'custom');
      const channel = models.filter((m) => m.type !== 'custom');
      const mo = openModal({
        title: '选择可用模型',
        desc: '勾选后写入模型权限；手填的通配符会保留',
        size: 'lg',
        body: `<div style="max-height:420px;overflow:auto">
          ${custom.length ? `<div class="col-sub-head">自定义模型</div>${custom.map((m) => `
            <label class="row-item" style="cursor:pointer"><input type="checkbox" data-pm="${esc(m.id)}" ${preset.has(m.id) ? 'checked' : ''} style="margin:0 2px">
              <div class="row-item__main"><div class="row-item__name"><span>${esc(m.id)}</span></div></div></label>`).join('')}` : ''}
          ${channel.length ? `<div class="col-sub-head">渠道模型</div>${channel.map((m) => `
            <label class="row-item" style="cursor:pointer"><input type="checkbox" data-pm="${esc(m.id)}" ${preset.has(m.id) ? 'checked' : ''} style="margin:0 2px">
              <div class="row-item__main"><div class="row-item__name"><span>${esc(m.id)}</span></div></div></label>`).join('')}` : ''}
        </div>`,
        footer: `<div class="spacer"></div><button class="btn" data-cancel>取消</button><button class="btn btn--primary" data-ok>确定</button>`,
      });
      mo.foot.querySelector('[data-cancel]').onclick = () => { mo.close(); resolve(null); };
      mo.foot.querySelector('[data-ok]').onclick = () => {
        const picked = [];
        mo.body.querySelectorAll('[data-pm]').forEach((cb) => { if (cb.checked) picked.push(cb.dataset.pm); });
        // 保留手填但不在列表里的名称（例如通配符）
        preset.forEach((p) => {
          if (!models.some((m) => m.id === p)) picked.push(p);
        });
        mo.close();
        resolve(picked);
      };
    });
  }

  // ---------- 站点 ----------
  function bindSite(host) {
    const s = D.settings;
    const logo = host.querySelector('#s-logo');
    const preview = host.querySelector('#s-logo-preview');
    let t = 0;
    logo.oninput = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        preview.src = logo.value.trim() || '../web/assets/logo.jpg';
      }, 300);
    };
    host.querySelectorAll('#s-theme button').forEach((btn) => {
      btn.onclick = () => {
        host.querySelectorAll('#s-theme button').forEach((b) => b.classList.toggle('is-on', b === btn));
        Theme.apply(btn.dataset.theme);
      };
    });
    host.querySelector('#s-aff-meta').textContent =
      `当前 ${s.affinity_model_count + s.affinity_channel_count} 条亲和（渠道 ${s.affinity_channel_count} / 模型 ${s.affinity_model_count}） · 上次自动清理：${s.affinity_cleanup_at ? fmtTime(s.affinity_cleanup_at) : '从未'}`;

    host.querySelector('#s-aff-clear').onclick = () => {
      const ch = host.querySelector('#s-aff-ch').querySelector('input').checked;
      const md = host.querySelector('#s-aff-md').querySelector('input').checked;
      if (!ch && !md) { Toast.warn('请至少勾选一种清理范围'); return; }
      const n = (ch ? s.affinity_channel_count : 0) + (md ? s.affinity_model_count : 0);
      if (ch) s.affinity_channel_count = 0;
      if (md) s.affinity_model_count = 0;
      Toast.success(n ? `已清理 ${n} 条亲和` : '当前没有可清理的亲和记录');
      renderPanel();
    };

    host.querySelector('#s-save').onclick = () => {
      const logoVal = logo.value.trim();
      s.site_name = host.querySelector('#s-name').value.trim() || '懒大猫 API';
      s.site_subtitle = host.querySelector('#s-sub').value.trim();
      s.logo = logoVal;
      s.theme = Theme.get();
      s.log_retention_days = Math.max(0, Number(host.querySelector('#s-retention').value) || 0);
      s.allow_origins = host.querySelector('#s-cors').value.trim();
      s.allow_unlisted_channel_models = host.querySelector('#s-unlisted').querySelector('input').checked;
      s.affinity_cleanup_hours = Math.max(0, Math.min(8760, Number(host.querySelector('#s-aff-hours').value) || 0));
      s.affinity_clean_channel = host.querySelector('#s-aff-ch').querySelector('input').checked;
      s.affinity_clean_model = host.querySelector('#s-aff-md').querySelector('input').checked;

      // 顶栏牌匾 / 标题 / 图标立刻跟着改
      const nameEl = document.querySelector('.gnav__brand-name');
      const subEl = document.querySelector('.gnav__brand-sub');
      if (nameEl) nameEl.textContent = s.site_name;
      if (subEl) subEl.textContent = `${s.site_subtitle || '模型聚合网关'} · 界面预览`;
      document.title = s.site_subtitle ? `${s.site_name} · ${s.site_subtitle}` : s.site_name;
      document.querySelectorAll('.gnav__logo img').forEach((img) => { img.src = logoVal || '../web/assets/logo.jpg'; });
      let link = document.querySelector('link[rel="icon"]');
      if (link) link.href = logoVal || '../web/assets/logo.jpg';
      Toast.success('设置已保存');
    };
  }

  // ---------- 安全 ----------
  function bindSecurity(host) {
    host.querySelector('#p-save').onclick = () => {
      const oldP = host.querySelector('#p-old').value;
      const p1 = host.querySelector('#p-new').value;
      const p2 = host.querySelector('#p-new2').value;
      if (!oldP || !p1) { Toast.warn('请填写完整的密码'); return; }
      if (p1.length < 6) { Toast.warn('新密码至少 6 位'); return; }
      if (p1 !== p2) { Toast.warn('两次输入的新密码不一致'); return; }
      Toast.success('密码已修改，请牢记新密码');
      host.querySelectorAll('input[type=password]').forEach((i) => { i.value = ''; });
    };
    host.querySelector('#p-logout').onclick = async () => {
      const ok = await confirmDialog({ title: '退出登录', message: '确定要退出管理端吗？', confirmText: '退出', danger: true });
      if (!ok) return;
      Toast.info('预览页面不实际退出登录');
    };
  }

  // ---------- 数据 ----------
  function bindData(host) {
    const all = host.querySelector('#bk-all');
    const boxes = [...host.querySelectorAll('[data-bk]')];
    const syncAll = () => {
      const n = boxes.filter((b) => b.checked).length;
      all.checked = n === boxes.length && n > 0;
      all.indeterminate = n > 0 && n < boxes.length;
    };
    boxes.forEach((b) => { b.onchange = syncAll; });
    all.onchange = () => {
      boxes.forEach((b) => { b.checked = all.checked; });
      all.indeterminate = false;
    };

    host.querySelector('#bk-export').onclick = () => {
      const scopes = boxes.filter((b) => b.checked).map((b) => b.dataset.bk);
      if (!scopes.length) { Toast.warn('请至少选择一个导出范围'); return; }
      const indent = Number(host.querySelector('#bk-indent').value);
      const btn = host.querySelector('#bk-export');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner" style="width:11px;height:11px"></span>导出中';
      setTimeout(() => {
        const file = `ldmapi-backup-${nowStr()}-${Math.random().toString(16).slice(2, 8)}.json`;
        const counts = {
          channels: scopes.includes('channels') ? D.channels.length : undefined,
          models: scopes.includes('models') ? D.models.length : undefined,
          providers: scopes.includes('providers') ? D.providers.length : undefined,
          tokens: scopes.includes('tokens') ? D.tokens.length : undefined,
          settings: scopes.includes('settings') ? 1 : undefined,
          logs: scopes.includes('logs') ? D.me.counts.logs : undefined,
          stats: scopes.includes('stats') ? 336 : undefined,
        };
        const size = 28 * 1024 + Math.floor(Math.random() * 120 * 1024);
        const path = `D:\\code\\ldm-api\\data\\backups\\${file}`;
        host.querySelector('#bk-result').innerHTML = `
          <div class="hint-line" style="margin:10px 0 0;flex-direction:column;align-items:stretch;gap:4px">
            <div class="strong">已导出 ${esc(file)}</div>
            <div class="mono" style="font-size:10px;word-break:break-all">${esc(path)}</div>
            <div class="fs-11 muted">${fmtMem(size)} · ${Object.entries(counts).filter(([, v]) => v != null).map(([k, v]) => {
              const name = (BACKUP_SCOPES.find(([x]) => x === k) || [])[1] || k;
              return `${name} ${v}`;
            }).join(' · ')}</div>
            <button class="btn btn--sm" id="bk-copy" style="align-self:flex-start;margin-top:4px">${icon('copy', 11)}复制路径</button>
          </div>`;
        host.querySelector('#bk-copy').onclick = () => copyText(path, '备份路径');
        btn.disabled = false;
        btn.innerHTML = `${icon('download', 11)}导出备份`;
        Toast.success('备份已写入服务器本地');
      }, 650);
    };
  }

  window.PVPages = window.PVPages || {};
  window.PVPages.settings = {
    render,
    open() { window.PVNavigate('#/settings/tokens'); },
  };
})();
