/* ==========================================================================
   预览页工具层：图标、格式化、Toast、气泡、弹窗、抽屉
   —— 行为与视觉对齐 web/assets/app.js，方便以后整块搬回正式前端。
   ========================================================================== */
(function () {
  'use strict';

  const esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  function fmtNum(n) {
    n = Number(n) || 0;
    const abs = Math.abs(n);
    const fixed = (v) => v.toFixed(2);
    if (abs >= 1e9) return fixed(n / 1e9) + 'B';
    if (abs >= 1e6) {
      return Math.abs(n / 1e6) >= 999.995 ? fixed(n / 1e9) + 'B' : fixed(n / 1e6) + 'M';
    }
    if (abs >= 1e3) {
      return Math.abs(n / 1e3) >= 999.995 ? fixed(n / 1e6) + 'M' : fixed(n / 1e3) + 'K';
    }
    return n.toLocaleString('zh-CN');
  }

  function fmtInt(n) {
    return (Number(n) || 0).toLocaleString('zh-CN');
  }

  function fmtUnit(n) {
    n = Number(n) || 0;
    if (Math.abs(n) < 1000) return String(n);
    const units = ['K', 'M', 'B'];
    let v = n;
    let i = -1;
    do { v /= 1000; i += 1; } while (Math.abs(v) >= 1000 && i < units.length - 1);
    const rounded = Math.round(v * 10) / 10;
    if (Math.abs(rounded) >= 1000 && i < units.length - 1) {
      return Math.round((v / 1000) * 10) / 10 + units[i + 1];
    }
    return rounded + units[i];
  }

  function fmtTime(ms) {
    if (!ms) return '—';
    const d = new Date(Number(ms));
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function fmtTimeShort(ms) {
    if (!ms) return '—';
    const d = new Date(Number(ms));
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function relTime(ms) {
    if (!ms) return '从未使用';
    const diff = Date.now() - Number(ms);
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 2592000000) return Math.floor(diff / 86400000) + ' 天前';
    return fmtTime(ms).slice(0, 10);
  }

  function fmtDuration(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return Math.round(ms) + 'ms';
    return (ms / 1000).toFixed(2) + 's';
  }

  function fmtUptime(sec) {
    sec = Number(sec) || 0;
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d} 天 ${h} 小时`;
    if (h > 0) return `${h} 小时 ${m} 分`;
    return `${m} 分钟`;
  }

  function fmtMem(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function fmtContext(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return String(n);
  }

  async function copyText(text, label) {
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (e) { /* 走兜底 */ }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (e) { /* ignore */ }
    }
    if (ok) {
      Toast.success(label ? label + '已复制' : '已复制到剪贴板');
      return true;
    }
    Toast.error('复制失败，请手动选择文本');
    return false;
  }

  // 任何带 data-copy 的元素点一下就复制（与线上同一套约定）
  document.addEventListener('click', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-copy]') : null;
    if (!el) return;
    e.preventDefault();
    copyText(el.dataset.copy, el.dataset.copyLabel);
  });

  function debounce(fn, wait) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  // ---------- 图标（与线上同一份路径，补了几个新骨架要用的） ----------
  const ICONS = {
    dashboard: '<path d="M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z"/>',
    usage: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    channels: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="1.6"/><circle cx="16" cy="12" r="1.6"/><circle cx="10" cy="18" r="1.6"/>',
    models: '<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5M12 22V12"/>',
    plaza: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
    tokens: '<circle cx="8" cy="14" r="4"/><path d="M11 11l8-8M17 3l3 3M14.5 5.5l3 3"/>',
    logs: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    settings: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1 1.55V21a2 2 0 11-4 0v-.09a1.7 1.7 0 00-1.11-1.55 1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.7 1.7 0 004.6 15a1.7 1.7 0 00-1.55-1H3a2 2 0 110-4h.09A1.7 1.7 0 004.6 8.9a1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06A1.7 1.7 0 009 4.6a1.7 1.7 0 001-1.55V3a2 2 0 114 0v.09a1.7 1.7 0 001 1.55 1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06A1.7 1.7 0 0019.4 9v.09a1.7 1.7 0 001.55 1H21a2 2 0 110 4h-.09a1.7 1.7 0 00-1.55 1z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
    refresh: '<path d="M21 12a9 9 0 11-3-6.7M21 3v6h-6"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    play: '<path d="M6 4l14 8-14 8z"/>',
    pause: '<rect x="7" y="4" width="4" height="16" rx="1"/><rect x="13" y="4" width="4" height="16" rx="1"/>',
    sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>',
    moon: '<path d="M21 13A9 9 0 1111 3a7 7 0 0010 10z"/>',
    logout: '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>',
    alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    down: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    chevronLeft: '<path d="M15 18l-6-6 6-6"/>',
    chevronRight: '<path d="M9 18l6-6-6-6"/>',
    grip: '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
    route: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5V15a3 3 0 003 3h6"/>',
    merge: '<path d="M7 3v5a4 4 0 004 4h6M17 8l-4 4 4 4"/>',
    split: '<path d="M7 21v-5a4 4 0 014-4h6M17 16l-4-4 4-4"/>',
    zap: '<path d="M13 2L3 14h8l-1 8 10-12h-8z"/>',
    chat: '<path d="M21 12a8 8 0 01-8 8H7l-4 3v-6.5A8 8 0 018 4h5a8 8 0 018 8z"/>',
    send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M17.9 17.9A10.4 10.4 0 0112 19c-7 0-11-7-11-7a19.8 19.8 0 015.1-5.9M9.9 4.2A10.6 10.6 0 0112 4c7 0 11 7 11 7a19.9 19.9 0 01-3.2 4.2"/><path d="M9.9 9.9a3 3 0 004.2 4.2M1 1l22 22"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    grid: '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/>',
    server: '<rect x="2" y="3" width="20" height="7" rx="2"/><rect x="2" y="14" width="20" height="7" rx="2"/><path d="M6 6.5h.01M6 17.5h.01"/>',
    box: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/>',
    key: '<circle cx="8" cy="14" r="4"/><path d="M11 11l8-8M17 3l3 3M14.5 5.5l3 3"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
    brain: '<path d="M9 3a3 3 0 00-3 3 3 3 0 00-1 5.8V15a3 3 0 003 3h1a2 2 0 002-2V5a2 2 0 00-2-2z"/><path d="M15 3a3 3 0 013 3 3 3 0 011 5.8V15a3 3 0 01-3 3h-1a2 2 0 01-2-2V5a2 2 0 012-2z"/>',
    wand: '<path d="M15 4V2M15 10V8M12.5 6.5h-2M19.5 6.5h-2M13 4.5l-1.4-1.4M18.4 9.9L17 8.5M3 21l9-9"/>',
    download: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    file: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/>',
    paperclip: '<path d="M21.4 11.6l-8.5 8.5a6 6 0 01-8.5-8.5l8.5-8.5a4 4 0 015.7 5.7l-8.5 8.5a2 2 0 01-2.8-2.8l7.8-7.8"/>',
    code: '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>',
    panelLeft: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    panelRight: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/>',
    layers: '<path d="M12 2L2 7l10 5 10-5z"/><path d="M2 12l10 5 10-5M2 17l10 5 10-5"/>',
    database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
    sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>',
    move: '<path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/>',
    filter: '<path d="M22 3H2l8 9.5V19l4 2v-8.5z"/>',
    link: '<path d="M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7L12 19"/>',
    external: '<path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6M10 14L21 3"/>',
  };

  function icon(name, size) {
    const p = ICONS[name] || ICONS.info;
    const s = size || 16;
    return `<svg class="icon" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  }

  function providerIcon(iconName, size) {
    const s = size || 18;
    const svg = iconName && window.LDM_PROVIDER_ICONS && window.LDM_PROVIDER_ICONS[iconName];
    if (svg) return `<span class="provider-icon" style="width:${s}px;height:${s}px">${svg}</span>`;
    if (iconName && /^(https?:\/\/|data:image\/)/i.test(iconName)) {
      return `<img class="provider-icon" src="${esc(iconName)}" alt="" style="width:${s}px;height:${s}px" loading="lazy">`;
    }
    if (iconName) {
      // 图标库里没有的品牌（google / anthropic 等）会走到文字兜底：
      // 整词塞进方框只会露出「log」「hre」这种残字，改成首个字母。
      const text = String(iconName);
      const label = (text.length <= 2 ? text : text.slice(0, 1)).toUpperCase();
      return `<span class="provider-icon provider-icon--text" style="width:${s}px;height:${s}px;font-size:${Math.max(10, Math.round(s * 0.58))}px">${esc(label)}</span>`;
    }
    return `<span class="provider-icon provider-icon--fallback" style="width:${s}px;height:${s}px">${icon('box', Math.max(9, Math.round(s * 0.66)))}</span>`;
  }

  function providerAvatar(p, size, fallback) {
    const s = size || 34;
    if (!p) {
      return `<div class="model-card__avatar" style="width:${s}px;height:${s}px">${fallback || '🧠'}</div>`;
    }
    return `<div class="model-card__avatar provider-avatar" style="width:${s}px;height:${s}px">${providerIcon(p.icon, Math.round(s * 0.62))}</div>`;
  }

  // ---------- Toast ----------
  const Toast = {
    host: null,
    _host() {
      if (!this.host) {
        this.host = document.createElement('div');
        this.host.className = 'toast-host';
        document.body.appendChild(this.host);
      }
      return this.host;
    },
    show(type, title, msg, timeout) {
      const el = document.createElement('div');
      el.className = 'toast toast--' + type;
      const ic = type === 'success' ? 'check' : type === 'error' || type === 'warn' ? 'alert' : 'info';
      el.innerHTML =
        `<span class="toast__icon">${icon(ic, 16)}</span>` +
        `<div class="toast__body"><div class="toast__title">${esc(title)}</div>` +
        (msg ? `<div class="toast__msg">${esc(msg)}</div>` : '') +
        `</div>` +
        `<button class="toast__act" data-toast-copy aria-label="复制提示内容">${icon('copy', 13)}</button>` +
        `<button class="toast__close" aria-label="关闭">${icon('x', 13)}</button>`;
      this._host().appendChild(el);
      const t = setTimeout(() => {
        el.classList.add('is-out');
        setTimeout(() => el.remove(), 200);
      }, timeout || (type === 'error' ? 6000 : 3000));
      const dismiss = () => {
        clearTimeout(t);
        el.classList.add('is-out');
        setTimeout(() => el.remove(), 200);
      };
      el.querySelector('[data-toast-copy]').addEventListener('click', (e) => {
        e.stopPropagation();
        copyText((title || '') + (msg ? '\n' + msg : ''));
      });
      el.querySelector('.toast__close').addEventListener('click', (e) => {
        e.stopPropagation();
        dismiss();
      });
      el.addEventListener('click', (e) => {
        if (e.target.closest('.toast__close')) return;
        clearTimeout(t);
        el.remove();
      });
    },
    success(msg, title) { this.show('success', title || '操作成功', msg); },
    error(msg, title) { this.show('error', title || '出错了', msg); },
    warn(msg, title) { this.show('warn', title || '提示', msg); },
    info(msg, title) { this.show('info', title || '提示', msg); },
  };

  // ---------- 气泡（data-tip） ----------
  const Tip = (function () {
    let el = null;
    let current = null;

    function ensure() {
      if (!el) {
        el = document.createElement('div');
        el.className = 'chart-tip chart-tip--wrap';
        document.body.appendChild(el);
      }
      return el;
    }

    function place(target) {
      const text = target.getAttribute('data-tip');
      if (!text) return;
      const node = ensure();
      node.textContent = text;
      node.classList.add('is-on');
      const r = target.getBoundingClientRect();
      const nr = node.getBoundingClientRect();
      let left = r.left + r.width / 2 - nr.width / 2;
      left = Math.max(10, Math.min(left, window.innerWidth - nr.width - 10));
      let top = r.top - nr.height - 8;
      if (top < 8) top = r.bottom + 8;
      node.style.left = left + 'px';
      node.style.top = top + 'px';
    }

    function hide() {
      if (el) el.classList.remove('is-on');
      current = null;
    }

    document.addEventListener('mouseover', (e) => {
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (!t || t === current) return;
      current = t;
      place(t);
    });
    document.addEventListener('mouseout', (e) => {
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (!t || t !== current) return;
      hide();
    });
    document.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);

    return { hide, show: place };
  })();

  // ---------- 弹窗 ----------
  let modalZ = 100;
  function openModal(opts) {
    const o = opts || {};
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    modalZ += 10;
    backdrop.style.zIndex = String(modalZ);
    const size = o.size ? ' modal--' + o.size : '';
    backdrop.innerHTML = `
      <div class="modal${size}" role="dialog" aria-modal="true">
        <div class="modal__head">
          <div style="min-width:0">
            <div class="modal__title">${esc(o.title || '')}</div>
            ${o.desc ? `<div class="modal__desc">${esc(o.desc)}</div>` : ''}
          </div>
          <button class="modal__close" aria-label="关闭">${icon('x', 15)}</button>
        </div>
        <div class="modal__body">${o.body || ''}</div>
        ${o.footer == null ? '' : `<div class="modal__foot">${o.footer}</div>`}
      </div>`;
    document.body.appendChild(backdrop);

    const close = () => {
      if (!backdrop.parentNode) return;
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      if (!document.querySelector('.modal-backdrop, .gset-backdrop')) document.body.style.overflow = '';
      if (o.onClose) o.onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    backdrop.querySelector('.modal__close').onclick = close;
    if (o.closable !== false) {
      backdrop.addEventListener('mousedown', (e) => {
        if (e.target === backdrop) close();
      });
      document.addEventListener('keydown', onKey);
    }
    document.body.style.overflow = 'hidden';

    const mo = {
      close,
      el: backdrop.querySelector('.modal'),
      body: backdrop.querySelector('.modal__body'),
      foot: backdrop.querySelector('.modal__foot'),
    };
    if (o.onMount) o.onMount(mo);
    return mo;
  }

  function confirmDialog(opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      const mo = openModal({
        title: o.title || '确认操作',
        size: 'sm',
        body: `<div class="fs-13" style="line-height:1.75;color:var(--text-2)">${o.message || ''}</div>`,
        footer: `<div class="spacer"></div>
          <button class="btn" data-cancel>${esc(o.cancelText || '取消')}</button>
          <button class="btn ${o.danger ? 'btn--danger' : 'btn--primary'}" data-ok>${esc(o.confirmText || '确定')}</button>`,
        onClose: () => finish(false),
      });
      mo.foot.querySelector('[data-cancel]').onclick = () => {
        finish(false);
        mo.close();
      };
      mo.foot.querySelector('[data-ok]').onclick = () => {
        finish(true);
        mo.close();
      };
    });
  }

  function promptDialog(opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      const mo = openModal({
        title: o.title || '请输入',
        size: 'sm',
        body: `<div class="field" style="margin:0">
          ${o.label ? `<label class="field__label">${esc(o.label)}</label>` : ''}
          <input class="input" id="prompt-input" placeholder="${esc(o.placeholder || '')}" value="${esc(o.value || '')}">
          ${o.hint ? `<div class="field__hint">${o.hint}</div>` : ''}
        </div>`,
        footer: `<div class="spacer"></div>
          <button class="btn" data-cancel>取消</button>
          <button class="btn btn--primary" data-ok>${esc(o.confirmText || '确定')}</button>`,
        onClose: () => finish(null),
      });
      const input = mo.body.querySelector('#prompt-input');
      setTimeout(() => input.focus(), 40);
      const submit = () => {
        const v = input.value.trim();
        if (!v && o.required !== false) {
          Toast.warn(o.requiredMsg || '请填写内容');
          input.focus();
          return;
        }
        finish(v);
        mo.close();
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      mo.foot.querySelector('[data-cancel]').onclick = () => {
        finish(null);
        mo.close();
      };
      mo.foot.querySelector('[data-ok]').onclick = submit;
    });
  }

  // 右侧抽屉（设置）
  function openDrawer(opts) {
    const o = opts || {};
    const backdrop = document.createElement('div');
    backdrop.className = 'gset-backdrop';
    backdrop.innerHTML = `
      <aside class="gset" role="dialog" aria-modal="true">
        <div class="gset__head">
          <div style="min-width:0">
            <div class="gset__title">${o.title || ''}</div>
            ${o.desc ? `<div class="gset__desc">${esc(o.desc)}</div>` : ''}
          </div>
          <button class="btn btn--ghost btn--icon gset__close" aria-label="关闭">${icon('x', 17)}</button>
        </div>
        ${o.tabs ? `<div class="gset__tabs">${o.tabs}</div>` : ''}
        <div class="gset__body">${o.body || ''}</div>
      </aside>`;
    document.body.appendChild(backdrop);
    const close = () => {
      if (!backdrop.parentNode) return;
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      if (!document.querySelector('.modal-backdrop, .gset-backdrop')) document.body.style.overflow = '';
      if (o.onClose) o.onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    backdrop.querySelector('.gset__close').onclick = close;
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    const d = { close, el: backdrop.querySelector('.gset'), body: backdrop.querySelector('.gset__body'), tabs: backdrop.querySelector('.gset__tabs') };
    if (o.onMount) o.onMount(d);
    return d;
  }

  // ---------- 复用 UI 片段 ----------
  function badge(text, tone, withDot) {
    return `<span class="badge${tone ? ' badge--' + tone : ''}">${withDot ? '<span class="dot"></span>' : ''}${esc(text)}</span>`;
  }

  function tagHue(text) {
    const s = String(text);
    let hash = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash % 360;
  }

  function colorBadge(text, extraClass) {
    if (!text) return '<span class="muted">—</span>';
    return `<span class="badge badge--tag${extraClass ? ' ' + extraClass : ''}" style="--tag-h:${tagHue(text)}" title="${esc(text)}">${esc(text)}</span>`;
  }

  function copyBadge(text, opts) {
    if (!text) return '<span class="muted">—</span>';
    const o = opts || {};
    const value = o.copy == null ? text : o.copy;
    const cls = 'badge badge--tag badge--click' + (o.cls ? ' ' + o.cls : '');
    return `<button type="button" class="${cls}" style="--tag-h:${tagHue(text)}"`
      + ` data-copy="${esc(value)}" data-copy-label="${esc(o.label || '')}"`
      + `>${esc(text)}</button>`;
  }

  function statusBadge(enabled, onText, offText) {
    return enabled
      ? `<span class="badge badge--green"><span class="dot"></span>${esc(onText || '启用')}</span>`
      : `<span class="badge badge--gray"><span class="dot"></span>${esc(offText || '禁用')}</span>`;
  }

  function emptyState(title, desc, actionHtml, iconName) {
    return `<div class="empty empty--bare">
      <div class="empty__icon">${icon(iconName || 'box', 34)}</div>
      <div class="empty__title">${esc(title)}</div>
      ${desc ? `<div class="empty__desc">${esc(desc)}</div>` : ''}
      ${actionHtml || ''}
    </div>`;
  }

  function loadingBlock(text) {
    return `<div class="loading-block"><span class="spinner"></span>${esc(text || '加载中…')}</div>`;
  }

  function switchEl(checked, label, attrs, extraClass) {
    return `<label class="switch ${extraClass || ''}" ${attrs || ''}>
      <input type="checkbox" ${checked ? 'checked' : ''}>
      <span class="switch__track"></span>
      ${label ? `<span class="switch__label">${esc(label)}</span>` : ''}
    </label>`;
  }

  function capBadges(caps, opts) {
    const o = opts || {};
    const out = [];
    if (caps) {
      if (caps.context_length) out.push(badge('上下文 ' + fmtContext(caps.context_length), 'blue'));
      if (caps.tool_calling === true) out.push(badge('工具调用', 'green'));
      else if (caps.tool_calling === false && o.showNeg) out.push(badge('不支持工具', 'gray'));
      if (caps.thinking === true) out.push(badge('思考', 'violet'));
      else if (caps.thinking === false && o.showNeg) out.push(badge('不支持思考', 'gray'));
      if (caps.vision === true) out.push(badge('图片', 'pink'));
      else if (caps.vision === false && o.showNeg) out.push(badge('不支持图片', 'gray'));
    }
    const blank = !caps || ['context_length', 'max_output', 'tool_calling', 'thinking', 'vision']
      .every((k) => caps[k] == null);
    if (!out.length) {
      if (blank) return '';
      out.push(badge('参数透传', 'gray'));
    }
    return `<div class="badge-group">${out.join('')}</div>`;
  }

  // ---------- 主题 ----------
  const Theme = {
    key: 'ldmapi.theme',
    get() { return localStorage.getItem(this.key) || 'light'; },
    apply(t) {
      document.documentElement.setAttribute('data-theme', t);
      localStorage.setItem(this.key, t);
      window.dispatchEvent(new CustomEvent('themechange'));
    },
    toggle() {
      const next = this.get() === 'light' ? 'dark' : 'light';
      this.apply(next);
      return next;
    },
  };

  window.PV = {
    esc, fmtNum, fmtInt, fmtUnit, fmtTime, fmtTimeShort, relTime, fmtDuration, fmtUptime, fmtMem, fmtContext,
    copyText, debounce, icon, providerIcon, providerAvatar,
    Toast, Tip, openModal, confirmDialog, promptDialog, openDrawer,
    badge, colorBadge, copyBadge, statusBadge, emptyState, loadingBlock, switchEl, capBadges, tagHue,
    Theme,
  };
})();
