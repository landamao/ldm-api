/* ==========================================================================
   懒大猫 API · 前端核心
   ========================================================================== */
(function () {
  'use strict';

  const REPO_URL = 'https://github.com/landamao/ldm-api';

  // 触摸设备（手机 / 平板）：程序化聚焦输入框会直接弹出虚拟键盘，需要主动规避
  const COARSE_POINTER = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

  // ---------- 工具 ----------
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
      // 999.995M 这类值四舍五入后会变成 1000M，需要进位到 B
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

  // 紧凑数值：12345 -> 12.3K，1234567 -> 1.2M，用于日志里的 token 数
  function fmtUnit(n) {
    n = Number(n) || 0;
    if (Math.abs(n) < 1000) return String(n);
    const units = ['K', 'M', 'B'];
    let v = n;
    let i = -1;
    do { v /= 1000; i += 1; } while (Math.abs(v) >= 1000 && i < units.length - 1);
    const rounded = Math.round(v * 10) / 10;
    // 999999 这类值四舍五入后会变成 1000K，需要进位到下一单位
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

  async function copyText(text, label) {
    let ok = false;
    // 优先用异步剪贴板；权限被拒绝或不可用时走 execCommand 兜底
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (e) { /* 继续尝试兜底方案 */ }
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
      } catch (e) { /* 兜底也失败时下面统一提示 */ }
    }
    if (ok) {
      Toast.success(label ? label + '已复制' : '已复制到剪贴板');
      return true;
    }
    Toast.error('复制失败，请手动选择文本');
    return false;
  }

  function debounce(fn, wait) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  // ---------- 站点图标 ----------
  const DEFAULT_LOGO = 'assets/logo.jpg';

  // 设置里填了图标就用它，否则用内置的默认图标
  function applyLogo(logo) {
    const url = String(logo == null ? '' : logo).trim() || DEFAULT_LOGO;
    document.querySelectorAll('.brand__logo, .login-logo').forEach((el) => {
      if (el.dataset.logoUrl === url) return;
      el.dataset.logoUrl = url;
      el.innerHTML = `<img src="${esc(url)}" alt="">`;
    });
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = url;
  }

  // ---------- 图标 ----------
  const ICONS = {
    dashboard: '<path d="M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z"/>',
    channels: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="1.6"/><circle cx="16" cy="12" r="1.6"/><circle cx="10" cy="18" r="1.6"/>',
    models: '<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5M12 22V12"/>',
    plaza: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
    tokens: '<circle cx="8" cy="14" r="4"/><path d="M11 11l8-8M17 3l3 3M14.5 5.5l3 3"/>',
    logs: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
    refresh: '<path d="M21 12a9 9 0 11-3-6.7M21 3v6h-6"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>',
    paste: '<path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
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
    grip: '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
    link: '<path d="M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7L12 19"/>',
    unlink: '<path d="M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7L12 19"/><path d="M3 3l18 18"/>',
    route: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5V15a3 3 0 003 3h6"/>',
    zap: '<path d="M13 2L3 14h8l-1 8 10-12h-8z"/>',
    chat: '<path d="M21 12a8 8 0 01-8 8H7l-4 3v-6.5A8 8 0 018 4h5a8 8 0 018 8z"/>',
    send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
    link: '<path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1"/><path d="M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    server: '<rect x="2" y="3" width="20" height="7" rx="2"/><rect x="2" y="14" width="20" height="7" rx="2"/><path d="M6 6.5h.01M6 17.5h.01"/>',
    box: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/>',
    key: '<circle cx="8" cy="14" r="4"/><path d="M11 11l8-8M17 3l3 3M14.5 5.5l3 3"/>',
    bolt: '<path d="M13 2L3 14h8l-1 8 10-12h-8z"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
    brain: '<path d="M9 3a3 3 0 00-3 3 3 3 0 00-1 5.8V15a3 3 0 003 3h1a2 2 0 002-2V5a2 2 0 00-2-2z"/><path d="M15 3a3 3 0 013 3 3 3 0 011 5.8V15a3 3 0 01-3 3h-1a2 2 0 01-2-2V5a2 2 0 012-2z"/>',
    wand: '<path d="M15 4V2M15 10V8M12.5 6.5h-2M19.5 6.5h-2M13 4.5l-1.4-1.4M18.4 9.9L17 8.5M3 21l9-9"/>',
    download: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    filter: '<path d="M22 3H2l8 9.5V19l4 2v-8.5z"/>',
    file: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/>',
    paperclip: '<path d="M21.4 11.6l-8.5 8.5a6 6 0 01-8.5-8.5l8.5-8.5a4 4 0 015.7 5.7l-8.5 8.5a2 2 0 01-2.8-2.8l7.8-7.8"/>',
    code: '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>',
  };

  function icon(name, size) {
    const p = ICONS[name] || ICONS.info;
    const s = size || 16;
    return `<svg class="icon" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  }

  // GitHub 官方 mark 是填充式路径，不能复用上面的描边图标。
  function githubIcon(size) {
    const s = size || 16;
    return `<svg class="icon" width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>`;
  }

  // 提供商图标：内置图标名 → 官方 SVG；也支持图片直链 / emoji / 文字。
  function providerIcon(iconName, size) {
    const s = size || 18;
    const svg = iconName && window.LDM_PROVIDER_ICONS && window.LDM_PROVIDER_ICONS[iconName];
    if (svg) {
      return `<span class="provider-icon" style="width:${s}px;height:${s}px">${svg}</span>`;
    }
    if (iconName && /^(https?:\/\/|data:image\/)/i.test(iconName)) {
      return `<img class="provider-icon" src="${esc(iconName)}" alt="" style="width:${s}px;height:${s}px" loading="lazy">`;
    }
    if (iconName) {
      return `<span class="provider-icon provider-icon--text" style="width:${s}px;height:${s}px;font-size:${Math.max(9, Math.round(s * 0.7))}px">${esc(iconName)}</span>`;
    }
    return `<span class="provider-icon provider-icon--fallback" style="width:${s}px;height:${s}px">${icon('box', Math.max(9, Math.round(s * 0.66)))}</span>`;
  }

  // 模型卡片/表格里的提供商头像：图标 + 品牌色浅底。
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
      const ic = type === 'success' ? 'check' : type === 'error' ? 'alert' : type === 'warn' ? 'alert' : 'info';
      el.innerHTML =
        `<span class="toast__icon">${icon(ic, 16)}</span>` +
        `<div class="toast__body"><div class="toast__title">${esc(title)}</div>` +
        (msg ? `<div class="toast__msg">${esc(msg)}</div>` : '') +
        `</div>` +
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

  // ---------- API ----------
  const API = {
    async request(method, path, body) {
      const opts = {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
      };
      if (body !== undefined) opts.body = JSON.stringify(body);
      const res = await fetch(path, opts);
      let data = null;
      const text = await res.text();
      if (text) {
        try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
      }
      if (!res.ok) {
        const msg = (data && data.error && data.error.message) || data?.message || `HTTP ${res.status}`;
        const err = new Error(msg);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    },
    get(p) { return this.request('GET', p); },
    post(p, b) { return this.request('POST', p, b); },
    put(p, b) { return this.request('PUT', p, b); },
    del(p, b) { return this.request('DELETE', p, b); },
  };

  // ---------- 下拉框 ----------
  // 原生 select 的选项一多就难找，这里统一换成自绘下拉：
  // 原生 select 继续作为数据源（隐藏），旁边放一个按钮触发器；
  // 选择时回写原生 select 并派发 change，页面里原有的 .value / .onchange 都不用改。
  const Select = (function () {
    let openState = null;

    // 把原生 select 的 option / optgroup 摊平成渲染用的条目
    function collect(native) {
      const items = [];
      let pendingGroup = null;
      const walk = (parent) => {
        Array.from(parent.children).forEach((child) => {
          if (child.tagName === 'OPTGROUP') {
            pendingGroup = child.label || '';
            walk(child);
          } else if (child.tagName === 'OPTION') {
            if (pendingGroup !== null) {
              items.push({ type: 'group', label: pendingGroup });
              pendingGroup = null;
            }
            items.push({
              type: 'option',
              el: child,
              label: (child.textContent || '').replace(/\s+/g, ' ').trim(),
              value: child.value,
              disabled: child.disabled,
            });
          }
        });
      };
      walk(native);
      return items;
    }

    // 原生 select 的值变化后，把显示文字同步到触发器
    function sync(native) {
      const trigger = native.__ldmTrigger;
      if (!trigger) return;
      const valueEl = trigger.querySelector('.ldm-select__value');
      if (!valueEl) return;
      const opt = native.selectedIndex >= 0 ? native.options[native.selectedIndex] : null;
      const raw = opt ? (opt.textContent || '').replace(/\s+/g, ' ').trim() : '';
      const label = raw || '请选择';
      if (valueEl.textContent !== label) valueEl.textContent = label;
      trigger.classList.toggle('is-placeholder', !raw);
      trigger.title = raw;
      trigger.disabled = native.disabled;
      trigger.setAttribute('aria-expanded', openState && openState.native === native ? 'true' : 'false');
      // 页面可能动态改内联样式（宽度等），触发器跟着原生 select 走
      const css = native.style.cssText;
      if (trigger.getAttribute('data-ldm-style') !== css) {
        trigger.setAttribute('data-ldm-style', css);
        trigger.style.cssText = css;
      }
    }

    function enhance(native) {
      if (!native || native.tagName !== 'SELECT' || native.__ldmTrigger) return;
      if (native.multiple || native.size > 1) return;
      if (native.dataset.native === '1' || native.dataset.native === 'true') return;

      const trigger = document.createElement('button');
      trigger.type = 'button';
      const cls = native.className.split(/\s+/).filter((c) => c && c !== 'ldm-select__native');
      trigger.className = cls.concat('ldm-select').join(' ');
      if (native.id) trigger.id = native.id + '__trigger';
      trigger.innerHTML = `<span class="ldm-select__value"></span><span class="ldm-select__chev">${icon('chevron', 14)}</span>`;
      trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-expanded', 'false');
      const ariaLabel = native.getAttribute('aria-label');
      if (ariaLabel) trigger.setAttribute('aria-label', ariaLabel);
      if (native.style.cssText) trigger.style.cssText = native.style.cssText;

      // 原生 select 隐藏后 label 的 for 会指向不可见元素，改指向触发器
      if (native.id) {
        document.querySelectorAll('label[for]').forEach((label) => {
          if (label.htmlFor === native.id) label.htmlFor = trigger.id;
        });
      }

      native.parentNode.insertBefore(trigger, native.nextSibling);
      native.classList.add('ldm-select__native');
      native.tabIndex = -1;
      native.setAttribute('aria-hidden', 'true');
      native.__ldmTrigger = trigger;

      trigger.addEventListener('click', () => {
        if (openState && openState.native === native) close();
        else open(native);
      });
      trigger.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          open(native, { reverse: e.key === 'ArrowUp' });
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (openState && openState.native === native) close();
          else open(native);
        } else if (e.key === 'Escape' && openState && openState.native === native) {
          e.preventDefault();
          e.stopPropagation();
          close();
        } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          // 直接敲字也能打开下拉并带入搜索词
          e.preventDefault();
          open(native, { query: e.key });
        }
      });

      sync(native);
    }

    function open(native, opts) {
      const o = opts || {};
      if (native.disabled) return;
      if (openState) close();
      const trigger = native.__ldmTrigger;
      if (!trigger || !trigger.isConnected) return;

      const pop = document.createElement('div');
      pop.className = 'ldm-pop';
      pop.tabIndex = -1;

      const searchWrap = document.createElement('div');
      searchWrap.className = 'ldm-pop__search-wrap';
      searchWrap.innerHTML = `${icon('search', 14)}<input class="ldm-pop__search" type="text" placeholder="搜索…" autocomplete="off" spellcheck="false" aria-label="搜索选项">`;
      const searchEl = searchWrap.querySelector('input');
      const listEl = document.createElement('div');
      listEl.className = 'ldm-pop__list';
      listEl.setAttribute('role', 'listbox');
      pop.appendChild(searchWrap);
      pop.appendChild(listEl);

      const items = collect(native);
      const optionCount = items.filter((it) => it.type === 'option').length;
      // 选项少的时候没必要放搜索框；超过 5 个才显示。
      // 仍可用 data-search="always" 强制显示、data-search="off" 强制关闭；
      // 在下拉按钮上直接敲字时也会临时显示搜索框。
      const showSearch = native.dataset.search === 'always'
        || (native.dataset.search !== 'off' && (optionCount > 5 || !!o.query));
      if (!showSearch) searchWrap.hidden = true;

      openState = { native, trigger, pop, listEl, searchEl, items, filtered: [], active: -1, showSearch };
      document.body.appendChild(pop);
      if (o.query) searchEl.value = o.query;

      renderList(o.reverse);
      position();

      searchEl.addEventListener('input', () => renderList());
      pop.addEventListener('keydown', onPopKeydown);
      document.addEventListener('mousedown', onDocDown, true);
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onResize);

      trigger.setAttribute('aria-expanded', 'true');
      // 触摸设备不自动聚焦搜索框，避免一打开就弹虚拟键盘
      if (showSearch && !COARSE_POINTER) searchEl.focus();
      else pop.focus();
    }

    function renderList(reverse) {
      if (!openState) return;
      const st = openState;
      const q = (st.searchEl.value || '').trim().toLowerCase();
      st.listEl.innerHTML = '';
      st.filtered = [];
      let pendingGroup = null;

      st.items.forEach((it) => {
        if (it.type === 'group') { pendingGroup = it.label; return; }
        const hay = (it.label + ' ' + it.value).toLowerCase();
        if (q && !hay.includes(q)) return;
        if (pendingGroup) {
          const g = document.createElement('div');
          g.className = 'ldm-pop__group';
          g.textContent = pendingGroup;
          st.listEl.appendChild(g);
          pendingGroup = null;
        }
        const node = document.createElement('button');
        node.type = 'button';
        node.className = 'ldm-opt';
        node.setAttribute('role', 'option');
        node.dataset.idx = String(st.filtered.length);
        const selected = it.el.index === st.native.selectedIndex;
        if (selected) {
          node.classList.add('is-selected');
          node.setAttribute('aria-selected', 'true');
        }
        if (it.disabled) node.disabled = true;
        const label = document.createElement('span');
        label.className = 'ldm-opt__label';
        label.textContent = it.label || it.value || '（空）';
        node.appendChild(label);
        if (selected) {
          const check = document.createElement('span');
          check.className = 'ldm-opt__check';
          check.innerHTML = icon('check', 14);
          node.appendChild(check);
        }
        node.addEventListener('mousemove', () => {
          if (openState !== st) return;
          setActive(Number(node.dataset.idx), false);
        });
        node.addEventListener('click', () => choose(it));
        st.listEl.appendChild(node);
        st.filtered.push(it);
      });

      if (!st.filtered.length) {
        const empty = document.createElement('div');
        empty.className = 'ldm-pop__empty';
        empty.textContent = q ? '没有匹配的选项' : '暂无可选项';
        st.listEl.appendChild(empty);
        st.active = -1;
        return;
      }

      // 初始高亮：当前选中项优先，否则第一项（向上打开时是最后一项）
      const selIdx = st.filtered.findIndex((it) => it.el.index === st.native.selectedIndex);
      const idx = selIdx >= 0 ? selIdx : (reverse ? st.filtered.length - 1 : 0);
      setActive(idx, true);
    }

    function setActive(idx, scroll) {
      if (!openState || !openState.filtered.length) return;
      const st = openState;
      const n = st.filtered.length;
      st.active = ((idx % n) + n) % n;
      const nodes = st.listEl.querySelectorAll('.ldm-opt');
      nodes.forEach((node, i) => node.classList.toggle('is-active', i === st.active));
      if (scroll) {
        const node = nodes[st.active];
        if (node) node.scrollIntoView({ block: 'nearest' });
      }
    }

    function move(delta) {
      if (!openState || !openState.filtered.length) return;
      setActive(openState.active + delta, true);
    }

    function onPopKeydown(e) {
      if (!openState) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        const { trigger } = openState;
        close();
        if (trigger && trigger.isConnected) trigger.focus();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        move(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        move(-1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        setActive(0, true);
      } else if (e.key === 'End') {
        e.preventDefault();
        setActive(openState.filtered.length - 1, true);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const it = openState.filtered[openState.active];
        if (it) choose(it);
      } else if (e.key === 'Tab') {
        // 弹层挂在 body 末尾，交给浏览器跳转会跳到页面末尾，这里先收起并回到触发器
        e.preventDefault();
        const { trigger } = openState;
        close();
        if (trigger && trigger.isConnected) trigger.focus();
      }
    }

    function choose(it) {
      if (!openState || it.disabled) return;
      const st = openState;
      const { native, trigger } = st;
      const changed = native.selectedIndex !== it.el.index;
      native.selectedIndex = it.el.index;
      sync(native);
      close();
      if (changed) native.dispatchEvent(new Event('change'));
      // 页面可能借 change 把焦点移到输入框（例如在线对话），不要抢回来
      const active = document.activeElement;
      if (trigger.isConnected && (!active || active === document.body || active === document.documentElement)) {
        trigger.focus();
      }
    }

    function position() {
      if (!openState) return;
      const { trigger, pop } = openState;
      if (!trigger.isConnected) { close(); return; }
      const r = trigger.getBoundingClientRect();
      if (!r.width && !r.height) { close(); return; }
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const margin = 8;
      const width = Math.min(Math.max(r.width, 200), vw - margin * 2);
      pop.style.width = width + 'px';
      pop.style.maxHeight = '';

      const ph = pop.offsetHeight;
      let left = Math.min(Math.max(margin, r.left), vw - width - margin);
      let top = r.bottom + 6;
      let above = false;
      if (top + ph > vh - margin && r.top - ph - 6 >= margin) {
        top = r.top - ph - 6;
        above = true;
      }
      // 上下空间都不够时贴着空间大的一侧，并限制弹层高度（列表内部滚动）
      if (top + ph > vh - margin) {
        const below = vh - r.bottom - margin - 6;
        const up = r.top - margin - 6;
        if (below >= up) {
          top = r.bottom + 6;
          pop.style.maxHeight = Math.max(120, below) + 'px';
        } else {
          const h = Math.max(120, up);
          top = Math.max(margin, r.top - h - 6);
          pop.style.maxHeight = h + 'px';
          above = true;
        }
      }
      pop.classList.toggle('ldm-pop--above', above);
      pop.style.left = Math.round(left) + 'px';
      pop.style.top = Math.round(top) + 'px';
    }

    function close() {
      if (!openState) return;
      const st = openState;
      openState = null;
      document.removeEventListener('mousedown', onDocDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      st.pop.remove();
      if (st.trigger && st.trigger.isConnected) st.trigger.setAttribute('aria-expanded', 'false');
    }

    function onDocDown(e) {
      if (!openState) return;
      if (openState.pop.contains(e.target) || openState.trigger.contains(e.target)) return;
      close();
    }

    function onScroll(e) {
      if (!openState) return;
      if (e.target && e.target.nodeType === 1 && openState.pop.contains(e.target)) return;
      position();
    }

    function onResize() { position(); }

    // 下拉打开时选项被动态替换（例如参数来源异步加载），重建列表
    function refreshOpen(native) {
      if (!openState || openState.native !== native) return;
      openState.items = collect(native);
      renderList();
      position();
    }

    function enhanceAll(root) {
      if (!root || !root.querySelectorAll) return;
      if (root.tagName === 'SELECT') enhance(root);
      root.querySelectorAll('select').forEach(enhance);
    }

    // 页面和弹窗都是动态渲染的，用 MutationObserver 自动增强新出现的 select
    const queued = new Set();
    let scheduled = false;
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const nodes = Array.from(queued);
        queued.clear();
        nodes.forEach((node) => {
          if (!node.isConnected) return;
          if (node.tagName === 'SELECT') {
            enhance(node);
            sync(node);
            refreshOpen(node);
            return;
          }
          if (node.tagName === 'OPTION' || node.tagName === 'OPTGROUP') {
            const sel = node.closest('select');
            if (sel) { enhance(sel); sync(sel); refreshOpen(sel); }
            return;
          }
          if (node.querySelector && node.querySelector('select')) {
            node.querySelectorAll('select').forEach((sel) => { enhance(sel); sync(sel); });
          }
        });
      });
    }

    function observe() {
      const mo = new MutationObserver((muts) => {
        muts.forEach((m) => {
          m.addedNodes.forEach((n) => {
            if (n.nodeType !== 1) return;
            if (n.tagName === 'SELECT' || n.tagName === 'OPTION' || n.tagName === 'OPTGROUP'
              || (n.querySelector && n.querySelector('select'))) {
              queued.add(n);
            }
          });
          // 当前打开的下拉被移出文档（切页 / 关弹窗）时收起
          if (m.removedNodes.length && openState) {
            const trigger = openState.trigger;
            m.removedNodes.forEach((n) => {
              if (n.nodeType === 1 && n.contains && n.contains(trigger)) close();
            });
          }
        });
        if (queued.size) schedule();
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }

    // 页面代码给原生 select 赋值时不会触发 change，这里补一次触发器同步
    try {
      const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
      if (desc && desc.set) {
        Object.defineProperty(HTMLSelectElement.prototype, 'value', {
          configurable: true,
          enumerable: desc.enumerable,
          get() { return desc.get.call(this); },
          set(v) {
            desc.set.call(this, v);
            if (this.__ldmTrigger) sync(this);
          },
        });
      }
    } catch (e) { /* 极端环境下保持原生行为 */ }

    if (document.body) {
      enhanceAll(document);
      observe();
    } else {
      document.addEventListener('DOMContentLoaded', () => { enhanceAll(document); observe(); }, { once: true });
    }

    return { enhance, enhanceAll, sync, close, isOpen: () => !!openState };
  })();

  // ---------- 模态框 ----------
  let modalStack = [];

  function openModal(opts) {
    const {
      title, desc, body, footer, size, onMount, closable = true, onClose, top = false,
    } = opts;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop' + (top ? ' modal-backdrop--top' : '');
    const sizeCls = size ? ' modal--' + size : '';
    backdrop.innerHTML =
      `<div class="modal${sizeCls}" role="dialog" aria-modal="true">
        <div class="modal__head">
          <div>
            <div class="modal__title">${esc(title || '')}</div>
            ${desc ? `<div class="modal__desc">${desc}</div>` : ''}
          </div>
          ${closable ? `<button class="modal__close" data-close aria-label="关闭">${icon('x', 17)}</button>` : ''}
        </div>
        <div class="modal__body"></div>
        ${footer ? '<div class="modal__foot"></div>' : ''}
      </div>`;

    const bodyEl = backdrop.querySelector('.modal__body');
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (body instanceof Node) bodyEl.appendChild(body);

    if (footer) {
      const footEl = backdrop.querySelector('.modal__foot');
      if (typeof footer === 'string') footEl.innerHTML = footer;
      else if (footer instanceof Node) footEl.appendChild(footer);
    }

    document.body.appendChild(backdrop);

    const api = {
      el: backdrop,
      body: bodyEl,
      foot: backdrop.querySelector('.modal__foot'),
      close(result) {
        const i = modalStack.indexOf(api);
        if (i >= 0) modalStack.splice(i, 1);
        backdrop.remove();
        if (onClose) onClose(result);
        if (modalStack.length === 0) document.body.style.overflow = '';
      },
    };

    if (closable) {
      // 标题栏的 × 和底部按钮都可能带 data-close，全部绑定
      backdrop.querySelectorAll('[data-close]').forEach((el) => {
        el.addEventListener('click', () => api.close());
      });
      backdrop.addEventListener('mousedown', (e) => {
        if (e.target === backdrop) api.close();
      });
    }
    modalStack.push(api);
    document.body.style.overflow = 'hidden';

    if (onMount) onMount(api);
    // 自动聚焦第一个输入框；如果是下拉框，聚焦到自绘触发器。
    // 触摸设备上不聚焦，否则弹窗一打开就弹出虚拟键盘。
    if (!COARSE_POINTER) {
      setTimeout(() => {
        let first = bodyEl.querySelector('input:not([type=checkbox]):not([type=radio]), textarea, select');
        if (first && first.tagName === 'SELECT') {
          Select.enhance(first);
          first = first.__ldmTrigger || first;
        }
        if (first && !first.dataset.nofocus) first.focus();
      }, 60);
    }
    return api;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalStack.length) {
      const top = modalStack[modalStack.length - 1];
      if (top.el.querySelector('[data-close]')) top.close();
    }
  });

  function confirmDialog(opts) {
    const {
      title = '确认操作', message = '', confirmText = '确认', cancelText = '取消', danger = false,
    } = typeof opts === 'string' ? { message: opts } : opts;
    return new Promise((resolve) => {
      let settled = false;
      const m = openModal({
        title,
        size: 'sm',
        body: `<div style="font-size:13.5px;line-height:1.7;color:var(--text-2)">${message}</div>`,
        footer: `<div class="spacer"></div>
          <button class="btn" data-act="cancel">${esc(cancelText)}</button>
          <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-act="ok">${esc(confirmText)}</button>`,
        onClose() { if (!settled) { settled = true; resolve(false); } },
        onMount(mo) {
          mo.foot.querySelector('[data-act=cancel]').onclick = () => { settled = true; mo.close(); resolve(false); };
          mo.foot.querySelector('[data-act=ok]').onclick = () => { settled = true; mo.close(); resolve(true); };
          setTimeout(() => mo.foot.querySelector('[data-act=ok]')?.focus(), 50);
        },
      });
      void m;
    });
  }

  function promptDialog(opts) {
    const {
      title = '请输入', label = '', value = '', placeholder = '', hint = '',
      confirmText = '确定', validate,
    } = opts;
    return new Promise((resolve) => {
      let settled = false;
      const m = openModal({
        title,
        size: 'sm',
        body: `<div class="field">
            ${label ? `<label class="field__label">${esc(label)}</label>` : ''}
            <input class="input" id="prompt-input" value="${esc(value)}" placeholder="${esc(placeholder)}">
            ${hint ? `<div class="field__hint">${esc(hint)}</div>` : ''}
            <div class="field__error" id="prompt-err" style="display:none"></div>
          </div>`,
        footer: `<div class="spacer"></div>
          <button class="btn" data-act="cancel">取消</button>
          <button class="btn btn--primary" data-act="ok">${esc(confirmText)}</button>`,
        onClose() { if (!settled) { settled = true; resolve(null); } },
        onMount(mo) {
          const input = mo.body.querySelector('#prompt-input');
          const errEl = mo.body.querySelector('#prompt-err');
          const submit = () => {
            const v = input.value.trim();
            if (validate) {
              const e = validate(v);
              if (e) {
                errEl.textContent = e;
                errEl.style.display = 'block';
                return;
              }
            }
            settled = true;
            mo.close();
            resolve(v);
          };
          input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
          mo.foot.querySelector('[data-act=cancel]').onclick = () => { settled = true; mo.close(); resolve(null); };
          mo.foot.querySelector('[data-act=ok]').onclick = submit;
        },
      });
      void m;
    });
  }

  // ---------- 复用的 UI 片段 ----------
  function badge(text, tone, withDot) {
    return `<span class="badge${tone ? ' badge--' + tone : ''}">${withDot ? '<span class="dot"></span>' : ''}${esc(text)}</span>`;
  }

  // 名称徽章：色相由字符串哈希决定，同一个模型/密钥在任何地方都是同一种颜色。
  // 这样日志翻页、换筛选条件后颜色不会乱跳，扫一眼就能把同一来源的行串起来。
  // 用 FNV-1a 而不是简单求和：ldm-flash / ldm-free 这类只差后缀的名字才能落到不同颜色。
  function colorBadge(text, extraClass) {
    if (!text) return '<span class="muted">—</span>';
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    const hue = hash % 360;
    return `<span class="badge badge--tag${extraClass ? ' ' + extraClass : ''}" style="--tag-h:${hue}" title="${esc(text)}">${esc(text)}</span>`;
  }

  function statusBadge(enabled, onText, offText) {
    return enabled
      ? `<span class="badge badge--green"><span class="dot"></span>${esc(onText || '启用')}</span>`
      : `<span class="badge badge--gray"><span class="dot"></span>${esc(offText || '禁用')}</span>`;
  }

  function emptyState(title, desc, actionHtml, iconName) {
    return `<div class="empty">
      <div class="empty__icon">${icon(iconName || 'box', 34)}</div>
      <div class="empty__title">${esc(title)}</div>
      ${desc ? `<div class="empty__desc">${esc(desc)}</div>` : ''}
      ${actionHtml || ''}
    </div>`;
  }

  function loadingBlock(text) {
    return `<div class="loading-block"><span class="spinner"></span>${esc(text || '加载中…')}</div>`;
  }

  function switchEl(checked, label, attrs) {
    return `<label class="switch" ${attrs || ''}>
      <input type="checkbox" ${checked ? 'checked' : ''}>
      <span class="switch__track"></span>
      ${label ? `<span class="switch__label">${esc(label)}</span>` : ''}
    </label>`;
  }

  // 能力标签
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
    if (!out.length) out.push(badge('参数透传', 'gray'));
    return `<div class="badge-group">${out.join('')}</div>`;
  }

  function fmtContext(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return String(n);
  }

  // ---------- 主题 ----------
  const Theme = {
    key: 'ldmapi.theme',
    get() {
      return localStorage.getItem(this.key) || 'light';
    },
    apply(t) {
      document.documentElement.setAttribute('data-theme', t);
      localStorage.setItem(this.key, t);
    },
    toggle() {
      const next = this.get() === 'light' ? 'dark' : 'light';
      this.apply(next);
      return next;
    },
  };

  // ---------- 全局状态 ----------
  const State = {
    me: null,
    settings: {},
    channels: [],
    models: [],
    providers: [],
    tokens: [],
    loaded: { channels: false, models: false, providers: false, tokens: false },
    async loadChannels(force) {
      if (this.loaded.channels && !force) return this.channels;
      this.channels = (await API.get('/api/channels')) || [];
      this.loaded.channels = true;
      return this.channels;
    },
    async loadModels(force) {
      if (this.loaded.models && !force) return this.models;
      this.models = (await API.get('/api/models')) || [];
      this.loaded.models = true;
      return this.models;
    },
    async loadProviders(force) {
      if (this.loaded.providers && !force) return this.providers;
      this.providers = (await API.get('/api/providers')) || [];
      this.loaded.providers = true;
      return this.providers;
    },
    async loadTokens(force) {
      if (this.loaded.tokens && !force) return this.tokens;
      this.tokens = (await API.get('/api/tokens')) || [];
      this.loaded.tokens = true;
      return this.tokens;
    },
    invalidate(what) {
      if (what === 'all') { this.loaded = { channels: false, models: false, providers: false, tokens: false }; return; }
      this.loaded[what] = false;
    },
  };

  // ---------- 导出 ----------
  window.LDM = {
    esc, fmtNum, fmtInt, fmtUnit, fmtTime, fmtTimeShort, relTime, fmtDuration, fmtUptime,
    copyText, debounce, icon, providerIcon, providerAvatar, Toast, API, Select, openModal, confirmDialog, promptDialog,
    isCoarsePointer: COARSE_POINTER,
    badge, statusBadge, emptyState, loadingBlock, switchEl, capBadges, fmtContext, colorBadge,
    Theme, State, routeParam, applyLogo,
    registerPage(name, def) { PAGES[name] = def; },
    PAGES: null,
    route: null,
  };

  // ---------- 路由 ----------
  const PAGES = {};
  window.LDM.PAGES = PAGES;

  const NAV = [
    { group: '总览' },
    { id: 'dashboard', name: '数据看板', icon: 'dashboard' },
    { id: 'plaza', name: '模型广场', icon: 'plaza' },
    { id: 'chat', name: '在线对话', icon: 'chat' },
    { group: '配置' },
    { id: 'channels', name: '渠道管理', icon: 'channels' },
    { id: 'models', name: '模型管理', icon: 'models' },
    { group: '接入' },
    { id: 'tokens', name: '令牌管理', icon: 'tokens' },
    { id: 'logs', name: '调用日志', icon: 'logs' },
    { id: 'settings', name: '系统设置', icon: 'settings' },
  ];

  function currentRoute() {
    const hash = location.hash.replace(/^#\/?/, '');
    const name = hash.split('?')[0] || 'dashboard';
    return PAGES[name] ? name : 'dashboard';
  }

  // 读取 hash 上的查询参数，例如 #/chat?model=LDM
  function routeParam(name) {
    const hash = location.hash.replace(/^#\/?/, '');
    const qi = hash.indexOf('?');
    if (qi < 0) return '';
    return new URLSearchParams(hash.slice(qi + 1)).get(name) || '';
  }

  function renderShell() {
    const app = document.getElementById('app');
    app.innerHTML = `
      <div class="shell">
        <aside class="sidebar" id="sidebar">
          <div class="sidebar__brand">
            <div class="brand__logo">🐱</div>
            <div class="brand__text">
              <div class="brand__name" id="brand-name">懒大猫 API</div>
              <div class="brand__sub" id="brand-sub">模型聚合网关</div>
            </div>
            <a class="brand__github" href="${REPO_URL}" target="_blank" rel="noopener noreferrer" title="GitHub 仓库" aria-label="GitHub 仓库">${githubIcon(16)}</a>
          </div>
          <nav class="sidebar__nav" id="nav"></nav>
          <div class="sidebar__foot">
            <button class="btn btn--block btn--sm" id="btn-theme">
              <span id="btn-theme-ic">${icon('moon', 14)}</span><span id="theme-label">深色模式</span>
            </button>
            <button class="btn btn--sm btn--block" id="btn-logout" style="margin-top:6px;color:var(--red-500);border-color:rgba(239,68,68,.25)">
              ${icon('logout', 14)}<span>退出登录</span>
            </button>
          </div>
        </aside>
        <div class="main">
          <header class="topbar">
            <button class="btn btn--ghost btn--icon mobile-toggle" id="btn-menu">${icon('list', 18)}</button>
            <div>
              <div class="topbar__title" id="page-title">数据看板</div>
              <div class="topbar__desc" id="page-desc"></div>
            </div>
            <div class="topbar__spacer"></div>
            <div id="topbar-actions" class="btn-row"></div>
          </header>
          <main class="content" id="content"><div class="content__inner" id="content-inner"></div></main>
        </div>
      </div>`;

    renderNav();
    const setThemeBtn = (t) => {
      document.getElementById('theme-label').textContent = t === 'light' ? '深色模式' : '浅色模式';
      document.getElementById('btn-theme-ic').innerHTML = icon(t === 'light' ? 'moon' : 'sun', 14);
    };
    setThemeBtn(Theme.get());
    document.getElementById('btn-theme').onclick = () => {
      setThemeBtn(Theme.toggle());
      window.dispatchEvent(new CustomEvent('themechange'));
    };
    document.getElementById('btn-logout').onclick = async () => {
      const ok = await confirmDialog({ title: '退出登录', message: '确定要退出管理端吗？', confirmText: '退出', danger: true });
      if (ok) window.LDM.logout();
    };

    document.getElementById('btn-menu').onclick = () => {
      const sb = document.getElementById('sidebar');
      if (sb.classList.contains('is-open')) return;
      sb.classList.add('is-open');
      const scrim = document.createElement('div');
      scrim.className = 'sidebar-scrim';
      const closeMobileNav = () => {
        sb.classList.remove('is-open');
        scrim.remove();
        sb.removeEventListener('click', onNavClick);
      };
      const onNavClick = (e) => {
        if (e.target.closest('.nav__item')) closeMobileNav();
      };
      scrim.onclick = closeMobileNav;
      // 遮罩必须挂在 #app 里：#app 自身是 z-index:1 的层叠上下文，
      // 挂到 body 的话遮罩会盖住整个应用（侧边栏的 z-index 困在里面够不着它）
      document.getElementById('app').appendChild(scrim);
      sb.addEventListener('click', onNavClick);
    };

    window.addEventListener('hashchange', navigate);
    navigate();
  }

  function renderNav() {
    const nav = document.getElementById('nav');
    const cur = currentRoute();
    const counts = {
      channels: State.channels.length,
      models: State.models.length,
      tokens: State.tokens.length,
    };
    nav.innerHTML = NAV.map((item) => {
      if (item.group) return `<div class="nav__group-title">${esc(item.group)}</div>`;
      const c = counts[item.id];
      return `<a class="nav__item${cur === item.id ? ' is-active' : ''}" href="#/${item.id}" data-page="${item.id}">
        ${icon(item.icon, 17)}
        <span>${esc(item.name)}</span>
        ${c ? `<span class="nav__badge">${c}</span>` : ''}
      </a>`;
    }).join('');
  }

  async function navigate() {
    const name = currentRoute();
    const def = PAGES[name];
    renderNav();
    document.getElementById('page-title').textContent = def.title || '';
    document.getElementById('page-desc').textContent = def.desc || '';
    const actions = document.getElementById('topbar-actions');
    actions.innerHTML = '';
    const inner = document.getElementById('content-inner');
    // 对话页需要撑满内容区；切到其它页面时恢复默认高度
    inner.classList.remove('content__inner--fill');
    inner.innerHTML = loadingBlock();
    try {
      await def.render(inner, actions);
    } catch (e) {
      if (e && e.status === 401) { showLogin(); return; }
      inner.innerHTML = `<div class="card card--pad">
        <div class="alert alert--warn">${icon('alert', 16)}<div>
          <div class="strong">页面加载失败</div>
          <div>${esc(e.message || e)}</div>
        </div></div></div>`;
    }
  }

  window.LDM.navigate = navigate;
  window.LDM.renderNav = renderNav;

  // ---------- 登录 ----------
  function showLogin(hint) {
    const app = document.getElementById('app');
    app.innerHTML = `
      <div class="login-page">
        <div class="login-card">
          <div class="login-logo">🐱</div>
          <div class="login-title">懒大猫 API</div>
          <div class="login-sub">一个密钥，调用所有上游模型</div>
          <div class="field">
            <label class="field__label">管理密码</label>
            <input class="input" type="password" id="login-pwd" placeholder="请输入管理密码" autocomplete="current-password">
            <div class="field__error" id="login-err" style="display:none"></div>
          </div>
          <button class="btn btn--primary btn--block" id="login-btn" style="height:40px;margin-top:6px">登录</button>
          ${hint ? `<div class="login-hint">${icon('info', 14)} 首次使用请用默认密码 <code>landamao</code> 登录，登录后请立即在「系统设置」中修改。</div>` : ''}
          <a class="login-github" href="${REPO_URL}" target="_blank" rel="noopener noreferrer">${githubIcon(15)}<span>GitHub</span></a>
        </div>
      </div>`;
    const pwd = document.getElementById('login-pwd');
    const btn = document.getElementById('login-btn');
    const errEl = document.getElementById('login-err');
    const submit = async () => {
      const v = pwd.value;
      if (!v) { errEl.textContent = '请输入密码'; errEl.style.display = 'block'; return; }
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> 登录中…';
      try {
        const res = await API.post('/api/auth/login', { password: v });
        if (res && res.default_password) {
          sessionStorage.setItem('ldmapi.defaultpwd', '1');
        }
        await boot();
      } catch (e) {
        errEl.textContent = e.message || '登录失败';
        errEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = '登录';
      }
    };
    btn.onclick = submit;
    pwd.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    // 登录页也跟随自定义图标（该接口不需要登录）
    API.get('/api/settings')
      .then((st) => applyLogo(st && st.logo))
      .catch(() => applyLogo(''));
    setTimeout(() => pwd.focus(), 80);
  }

  // ---------- 启动 ----------
  async function boot() {
    let me;
    try {
      me = await API.get('/api/auth/me');
    } catch (e) {
      showLogin(true);
      return;
    }
    State.me = me;
    State.settings = me.settings || {};
    const s = State.settings;
    if (s.site_name) {
      document.title = s.site_name + ' · API 网关';
    }
    const hint = me.default_password || sessionStorage.getItem('ldmapi.defaultpwd');
    renderShell();
    if (s.site_name) document.getElementById('brand-name').textContent = s.site_name;
    document.getElementById('brand-sub').textContent = s.site_subtitle || '模型聚合网关';
    applyLogo(State.settings.logo);
    if (hint) {
      setTimeout(() => {
        Toast.warn('首次使用请尽快在「系统设置」中修改管理密码。', '安全提醒');
      }, 900);
    }
    // 预取导航计数
    Promise.all([
      State.loadChannels().catch(() => {}),
      State.loadModels().catch(() => {}),
      State.loadTokens().catch(() => {}),
    ]).then(() => renderNav());
  }

  window.LDM.logout = async function () {
    try { await API.post('/api/auth/logout'); } catch (e) { /* ignore */ }
    location.reload();
  };

  Theme.apply(Theme.get());
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
