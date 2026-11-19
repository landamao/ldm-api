/* ==========================================================================
   预览外壳：顶栏导航 + 路由
   —— 顶栏就是原来的侧边栏导航整体上移；四个一级入口：
      首页 / 用量数据 / 模型广场 / 模型管理，右上角齿轮打开设置。
   ========================================================================== */
(function () {
  'use strict';

  const { esc, icon, Theme } = window.PV;
  const D = window.PVDATA;

  const NAV = [
    { id: 'home', name: '首页', icon: 'chat' },
    { id: 'usage', name: '用量数据', icon: 'usage' },
    { id: 'plaza', name: '模型广场', icon: 'plaza' },
    { id: 'models', name: '模型管理', icon: 'models' },
  ];

  let currentPage = '';
  let currentSub = '';
  const app = document.getElementById('app');
  let mainEl = null;
  let viewEl = null;

  function parseRoute() {
    const raw = location.hash.replace(/^#\/?/, '');
    const parts = raw.split('/').filter(Boolean);
    const page = parts[0] || 'home';
    const sub = parts[1] || '';
    const valid = NAV.some((n) => n.id === page) || page === 'settings';
    return { page: valid ? page : 'home', sub };
  }

  function shellHtml() {
    const s = D.settings;
    return `
      <div class="gapp">
        <header class="gnav">
          <div class="gnav__cluster gnav__cluster--nav">
            <a class="gnav__brand" href="#/home" title="${esc(s.site_name)}">
              <span class="gnav__logo"><img src="../web/assets/logo.jpg" alt=""></span>
              <span class="gnav__brand-text">
                <span class="gnav__brand-name">${esc(s.site_name)}</span>
                <span class="gnav__brand-sub">${esc(s.site_subtitle || '模型聚合网关')} · 界面预览</span>
              </span>
            </a>
            <nav class="gnav__tabs" id="gnav-tabs">
              ${NAV.map((n) => `
                <a class="gnav__tab" href="#/${n.id}" data-nav="${n.id}">
                  ${icon(n.icon, 17)}<span>${esc(n.name)}</span>
                </a>`).join('')}
            </nav>
          </div>
          <div class="gnav__cluster gnav__cluster--end">
            <div class="gnav__end">
              <button class="gnav__icon-btn" id="gnav-theme" title="切换主题">
                <span id="gnav-theme-ic">${icon(Theme.get() === 'light' ? 'moon' : 'sun', 17)}</span>
              </button>
              <span class="gnav__sep"></span>
              <button class="gnav__icon-btn gnav__settings" id="gnav-settings" title="设置">
                ${icon('settings', 19)}<span>设置</span>
              </button>
            </div>
          </div>
        </header>
        <main class="gmain" id="gmain"><div class="gview" id="gview"></div></main>
      </div>`;
  }

  function boot() {
    document.body.classList.add('is-preview');
    app.innerHTML = shellHtml();
    mainEl = document.getElementById('gmain');
    viewEl = document.getElementById('gview');

    document.getElementById('gnav-theme').onclick = () => {
      const t = Theme.toggle();
      document.getElementById('gnav-theme-ic').innerHTML = icon(t === 'light' ? 'moon' : 'sun', 17);
    };
    document.getElementById('gnav-settings').onclick = () => {
      const onSettings = currentPage === 'settings';
      window.PVNavigate(onSettings ? '#/home' : '#/settings/tokens');
    };

    window.addEventListener('hashchange', navigate);
    navigate();
  }

  function renderTabs(page) {
    document.querySelectorAll('[data-nav]').forEach((a) => {
      a.classList.toggle('is-active', a.dataset.nav === page);
    });
    const gear = document.getElementById('gnav-settings');
    if (gear) gear.classList.toggle('is-on', page === 'settings');
  }

  async function navigate() {
    const { page, sub } = parseRoute();
    const changedPage = page !== currentPage;
    if (changedPage && currentPage === 'home' && window.PVPages.chat && window.PVPages.chat.destroy) {
      window.PVPages.chat.destroy();
    }
    if (changedPage && currentPage === 'usage' && window.PVPages.usage && window.PVPages.usage.destroy) {
      window.PVPages.usage.destroy();
    }
    currentPage = page;
    currentSub = sub;
    renderTabs(page);

    viewEl.className = 'gview';
    viewEl.innerHTML = '';
    mainEl.classList.remove('is-static');

    if (page === 'home') {
      viewEl.classList.add('gview--fill');
      mainEl.classList.add('is-static');
      window.PVPages.chat.render(viewEl);
      return;
    }

    if (page === 'usage') {
      viewEl.classList.add('gview--wide');
      window.PVPages.usage.render(viewEl, sub || 'board');
      return;
    }

    if (page === 'plaza') {
      viewEl.classList.add('gview--wide');
      window.PVPages.plaza.render(viewEl);
      return;
    }

    if (page === 'models') {
      viewEl.classList.add('gview--wide');
      viewEl.classList.add('gview--fill');
      mainEl.classList.add('is-static');
      window.PVPages.models.render(viewEl);
      return;
    }

    if (page === 'settings') {
      viewEl.classList.add('gview--wide');
      window.PVPages.settings.render(viewEl, sub || 'tokens');
      return;
    }
  }

  // 页面之间跳转（聊天页的「去对话」等）
  window.PVNavigate = (hash) => {
    if (location.hash === hash) navigate();
    else location.hash = hash;
  };

  boot();
})();
