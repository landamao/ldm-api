/* ==========================================================================
   懒大猫 API · 数据看板 / 模型广场 / 令牌 / 日志 / 设置
   ========================================================================== */
(function () {
  'use strict';

  const {
    esc, API, State, Toast, openModal, confirmDialog, promptDialog, icon, providerIcon, providerAvatar,
    badge, statusBadge, emptyState, loadingBlock, fmtTime, fmtInt, fmtUnit, fmtNum, fmtDuration,
    fmtUptime, relTime, copyText, debounce, fmtContext, Theme, switchEl, colorBadge, copyBadge, tagHue,
    isCoarsePointer, REPO_URL,
  } = window.LDM;

  const { areaChart, barChart, donutChart, rankList, timeLabel, hideTip, clearChart } = window.Charts;

  // 密钥默认只露头尾，点眼睛才展开——列表一屏能显示很多条，明文摆着太容易泄露
  const maskKey = (k) => {
    if (!k) return '';
    if (k.length <= 16) return k.slice(0, 4) + '••••';
    return k.slice(0, 12) + '••••' + k.slice(-4);
  };

  // 失败判定：上游错误透传时 error 为空，但 client_error 仍有内容，
  // 状态码 >= 400 或客户端取消也属于失败。成功记录不提供错误弹窗入口。
  // 「覆写为正文」的记录调用方实际收到 200 正常回复，按成功算（黄色 200 标识），
  // 内部原因仍可从详情里看到。
  const logOK = (l) => l.as_content === true
    || (!l.canceled && l.status_code > 0 && l.status_code < 400 && !l.error && !l.client_error);

  // 黄色标识：客户端取消与错误覆写「覆写为正文」都是 200 但需要提示的记录。
  const logSoft = (l) => l.canceled || l.as_content;

  // 模型亲和标记：橙色四角星叠在渠道模型徽章右上角（模型列里 → 后面那一枚），
  // 样式对齐 NewAPI 的渠道亲和标。亲和记的是「上次成功的那条路由」，所以标记
  // 要跟着渠道模型走，而不是请求模型。
  const AFFINITY_STAR = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M10.9 2.4l1.9 5.3a2.6 2.6 0 001.5 1.5l5.3 1.9-5.3 1.9a2.6 2.6 0 00-1.5 1.5l-1.9 5.3-1.9-5.3a2.6 2.6 0 00-1.5-1.5L2.2 11.1l5.3-1.9a2.6 2.6 0 001.5-1.5z"/><path d="M19 2l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z"/></svg>`;
  const affinityTitle = (l) => l.retries
    ? '模型亲和命中：优先尝试上次成功的路由，失败后已切换'
    : '模型亲和命中：本次直接复用了上次成功的路由';
  const KEY_AFFINITY_TITLE = 'Key 亲和命中：优先使用了上次成功的 Key';

  // 上游模型徽章：上游回显的模型和请求的渠道模型不一致时（别名解析、日期版本、
  // 自动降级等），徽章右侧带一枚路由图标，整枚徽章就是气泡触发器——和 NewAPI
  // 的做法一致，不另起一个小按钮。桌面鼠标移上去弹气泡、点徽章复制模型名；
  // 手机没有悬停，点徽章直接展开气泡。上游原样回显时不加图标，点击还是复制。
  // plain 传对应列表用的普通徽章（日志页可复制版 / 看板只读版）。
  const upstreamModelBadge = (l, plain) => {
    const asked = (l.upstream_model || '').trim();
    const got = (l.response_model || '').trim();
    if (!got || got === asked) return plain(asked);
    const tip = `请求模型：${asked || '—'} / 响应模型：${got}`;
    return `<button type="button" class="badge badge--tag badge--click log-model-map"`
      + ` style="--tag-h:${tagHue(asked)}"`
      + ` data-asked="${esc(asked)}" data-got="${esc(got)}"`
      + ` aria-haspopup="dialog" aria-expanded="false" aria-label="${esc(tip)}">`
      + `${esc(asked)}${icon('route', 12)}</button>`;
  };

  // 气泡卡片：一次只开一个，定位、跟随滚动、点空白 / Esc 收起都交给统一的
  // 气泡引擎（LDM.tip）——日志表格是横向滚动的容器，气泡必须挂 body fixed，
  // 否则会被单元格裁掉。桌面悬停打开、手机上点徽章打开，行为与看板里
  // 被截断的模型名完全一致。
  const canHover = window.LDM.tip.canHover;

  function openModelMapPop(anchor, byHover) {
    const asked = (anchor.dataset.asked || '').trim();
    const got = (anchor.dataset.got || '').trim();
    if (!got) return;
    anchor.setAttribute('aria-expanded', 'true');
    window.LDM.tip.show(anchor, {
      html: `
        <div class="log-pop__row">
          <span class="log-pop__label">请求模型</span>
          ${copyBadge(asked || '—', { label: '请求模型' })}
        </div>
        <div class="log-pop__row">
          <span class="log-pop__label">响应模型</span>
          ${copyBadge(got, { label: '响应模型' })}
        </div>`,
      className: 'chart-tip--panel log-pop',
      interactive: true,
      pinned: !byHover,
      role: 'dialog',
      ariaLabel: '请求模型与响应模型',
      onHide: (a) => { if (a) a.setAttribute('aria-expanded', 'false'); },
    });
  }

  // 徽章是日志表里动态重建的，事件统一委托在 document 上。
  // 桌面（有鼠标）：点徽章复制模型名，详情看悬停气泡——和 NewAPI 的模型 tag 一致；
  // 手机（没有悬停）：点徽章展开气泡，再去点里面的徽章复制。
  document.addEventListener('click', (e) => {
    const mark = e.target && e.target.closest ? e.target.closest('.log-model-map') : null;
    if (!mark) return;
    e.preventDefault();
    const opened = mark.getAttribute('aria-expanded') === 'true';
    if (canHover) {
      copyText(mark.dataset.asked || '', '上游模型');
      openModelMapPop(mark, false);
    } else if (opened) {
      window.LDM.tip.hide();
    } else {
      openModelMapPop(mark, false);
    }
  });

  document.addEventListener('pointerover', (e) => {
    if (!canHover || !e.target.closest) return;
    const mark = e.target.closest('.log-model-map');
    // 这个徽章的气泡已经开着就别反复重渲染；不能拿 aria-expanded 判断——
    // 气泡被别处的提示顶掉时那个属性不一定同步过
    if (mark && !window.LDM.tip.isOn(mark)) openModelMapPop(mark, true);
  });

  // 「鼠标移开就收」不再在这里做：统一气泡引擎离开锚点后有一段延时收起，
  // 鼠标从徽章挪进气泡（中间隔几像素）时不会被立刻判成离开。
  // 点开的（pinned）照样要等点空白 / Esc 才收。

  // 错误详情弹窗：顶部概要只放请求模型、渠道模型、渠道和状态码，
  // 下面分成「错误详情」和「内部原因」两个独立块。错误详情是调用方实际
  // 收到的内容，内部原因只给后台排查。
  // 黄色 200 的记录（客户端取消 / 错误覆写「覆写为正文」）也走这个弹窗，
  // 前者没有响应体、后者正文是配置文案，内部原因里才是真正发生了什么。
  function showLogError(l) {
    const status = l.status_code > 0 ? String(l.status_code) : '—';
    const statusTone = logSoft(l) ? 'amber' : 'red';
    const channelModel = l.channel_id
      ? `${l.channel_id}/${l.upstream_model || '—'}`
      : '—';
    const channelLabel = l.channel_id
      ? `${l.channel_id}${l.channel_name ? '（' + l.channel_name + '）' : ''}`
      : '未命中渠道';
    const summary = [
      ['请求模型', `<span class="mono">${esc(l.model_id || '—')}</span>`],
      ['渠道模型', `<span class="mono">${esc(channelModel)}</span>`],
      ['渠道', `<span class="mono">${esc(channelLabel)}</span>`],
      ['状态码', `<span class="badge badge--${statusTone}">${esc(status)}</span>`],
      l.endpoint ? ['接口', `<span class="mono">${esc(l.endpoint)}</span>`] : null,
    ].filter(Boolean);

    const block = (text, tone) => {
      const v = (text || '').trim();
      return v
        ? `<div class="log-error__block log-error__block--${tone}">${esc(v)}</div>`
        : '<div class="log-error__block log-error__block--empty">—</div>';
    };

    openModal({
      title: '错误信息',
      size: 'lg',
      body: `<div class="log-error">
        <dl class="kv log-error__summary">
          ${summary.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}
        </dl>
        <div class="log-error__section">
          <div class="log-error__label">${l.as_content ? '返回给调用方的正文' : '错误详情'}</div>
          ${block(l.client_error, statusTone)}
        </div>
        <div class="log-error__section">
          <div class="log-error__label">内部原因</div>
          ${block(l.error, 'internal')}
        </div>
      </div>`,
      footer: `<div class="spacer"></div><button class="btn" data-close>关闭</button>`,
    });
  }

  // ======================================================================
  // 调用日志表：看板「最近调用」和调用日志页共用这一份
  // ======================================================================
  // 两个页面渲染的必须是同一张表——同一批列、同一套可复制徽章、同样的点击行为。
  // 以前各写一份，改了一边就漏另一边：看板的模型 / 渠道 / IP 是只读徽章，
  // 悬停还会多冒一个名称气泡，窄屏又被 CSS 把 IP 列整列藏掉（手机上右滑都看不到）。
  // 现在列、徽章、按钮全部只在这里定义，两边只管传格式化和数据。
  //
  // opts:
  //   num      数字格式化（看板跟页面单位设置走，日志页跟 K/M 开关走）
  //   channel  (l) => 渠道显示名（日志页用当前渠道配置反查，看板用日志里记的名字）
  const LOG_TABLE_HEAD = `<thead><tr>
    <th>时间</th><th>请求模型</th><th>渠道</th><th>上游模型</th><th>令牌</th>
    <th>输入</th><th>输出</th><th>速度</th><th>总计</th><th>耗时</th>
    <th>来源 IP</th><th>状态</th>
  </tr></thead>`;

  // Key 显示：#N 备注，没备注时明说，免得看着像漏了数据。
  function keyLabel(a) {
    if (!a.key_masked) return '—';
    const idx = `#${a.key_index || 1}`;
    return a.key_note ? `${idx} ${a.key_note}` : `${idx}（无备注）`;
  }

  function attemptBadge(a) {
    const ok = a.status_code > 0 && a.status_code < 400 && !a.error;
    const softFail = a.status_code > 0 && a.status_code < 400 && !!a.error;
    return ok ? badge('成功', 'green') : softFail ? badge(String(a.status_code), 'amber') : badge(String(a.status_code || '失败'), 'red');
  }

  function showKeyRetryHistory(l, group) {
    const rows = group.attempts.map((a, i) => `<tr>
        <td class="muted num">${i + 1}</td>
        <td class="mono" style="white-space:nowrap">${esc(a.upstream_model || '—')}</td>
        <td style="white-space:nowrap">${a.key_masked
          ? `<span style="position:relative;display:inline-block">${colorBadge(keyLabel(a), 'badge--xs')}${a.key_affinity ? `<span class="affinity-star affinity-star--sm" title="${KEY_AFFINITY_TITLE}">${AFFINITY_STAR}</span>` : ''}</span>`
          : '<span class="muted">—</span>'}</td>
        <td>${attemptBadge(a)}</td>
        <td class="right num">${esc(fmtDuration(a.latency_ms))}</td>
        <td class="fs-12" style="white-space:pre-wrap;word-break:break-word;min-width:320px">${a.error ? esc(a.error) : '<span class="muted">—</span>'}</td>
      </tr>`).join('');
    openModal({
      title: 'Key 重试信息',
      desc: `模型 <span class="mono">${esc(l.model_id || '—')}</span> · 渠道 <span class="mono">${esc(group.label)}</span> · 上游模型 <span class="mono">${esc(group.upstream)}</span> · 共 ${group.attempts.length} 次尝试`,
      size: 'xl',
      top: true,
      body: `<div class="table-wrap" style="border:none;border-radius:0">
        <table class="tbl">
          <thead><tr>
            <th style="width:40px">#</th><th>上游模型</th><th>Key</th>
            <th>状态码</th><th class="right">耗时</th><th style="width:52%">错误信息</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`,
      footer: `<div class="spacer"></div><button class="btn" data-close>关闭</button>`,
    });
  }

  // 重试历史：按「渠道 + 上游模型」聚合，同一路由内的多次 Key 尝试再下钻。
  function showRetryHistory(l) {
    const attempts = l.attempts || [];
    const groups = [];
    const byRoute = new Map();
    attempts.forEach((a) => {
      const id = a.channel_id || '';
      const routeKey = id + '\u0000' + (a.upstream_model || '');
      let g = byRoute.get(routeKey);
      if (!g) {
        g = {
          label: id ? `${id}${a.channel_name ? '（' + a.channel_name + '）' : ''}` : '—',
          upstream: a.upstream_model || '—',
          attempts: [],
          keyIds: new Set(),
        };
        byRoute.set(routeKey, g);
        groups.push(g);
      }
      g.attempts.push(a);
      if (a.key_masked) g.keyIds.add(`${a.key_index || 1}|${a.key_masked}`);
    });
    const rows = groups.map((g, i) => {
      const last = g.attempts[g.attempts.length - 1];
      const totalMs = g.attempts.reduce((n, a) => n + (a.latency_ms || 0), 0);
      const canDrill = g.keyIds.size > 1;
      return `<tr>
        <td class="muted num">${i + 1}</td>
        <td class="mono" style="white-space:nowrap">${esc(g.label)}</td>
        <td class="mono fs-12" style="white-space:nowrap">${esc(g.upstream)}</td>
        <td class="num">${g.attempts.length}</td>
        <td>${attemptBadge(last)}</td>
        <td class="right num">${esc(fmtDuration(totalMs))}</td>
        <td class="fs-12" style="white-space:pre-wrap;word-break:break-word;min-width:300px">${last.error ? esc(last.error) : '<span class="muted">—</span>'}</td>
        <td>${canDrill
          ? `<button type="button" class="badge badge--amber badge--click" data-key-retry="${i}" title="查看该渠道模型的 Key 重试明细">${icon('refresh', 11)}Key 重试 ${g.attempts.length - 1}</button>`
          : '<span class="muted">—</span>'}</td>
      </tr>`;
    }).join('');
    const finalOK = logOK(l);
    openModal({
      title: '渠道重试信息',
      desc: `模型 <span class="mono">${esc(l.model_id || '—')}</span> · 共 ${groups.length} 条路由 · ${finalOK ? '最终成功' : '最终失败'}`,
      size: 'xl',
      body: attempts.length ? `<div class="table-wrap" style="border:none;border-radius:0">
        <table class="tbl">
          <thead><tr>
            <th style="width:40px">#</th><th style="min-width:160px">渠道</th><th>上游模型</th>
            <th class="right">尝试</th><th>最终状态</th><th class="right">耗时</th><th style="width:40%">最后错误</th><th>Key 重试</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : emptyState('没有尝试明细', '这条日志产生于旧版本，没有记录每次重试的明细。', '', 'refresh'),
      footer: `<div class="spacer"></div><button class="btn" data-close>关闭</button>`,
      onMount(mo) {
        mo.body.querySelectorAll('[data-key-retry]').forEach((btn) => {
          btn.onclick = () => showKeyRetryHistory(l, groups[Number(btn.dataset.keyRetry)]);
        });
      },
    });
  }

  // 一行的渲染。徽章一律用 copyBadge（点一下就复制、有 toast），
  // 不再给 title——只有「不给气泡就看不全」的内容才弹气泡。
  function logRowHtml(l, idx, o) {
    const num = o.num;
    const sub = (html) => `<div class="log-sub">${html}</div>`;
    // 次要指标（缓存读 / 思考 / 首字）在数值下面另起一行，小一号灰字。
    const reasoning = l.reasoning_tokens
      ? `思考 ${num(l.reasoning_tokens)}`
      : (l.reasoning_chars ? `思考 ${num(l.reasoning_chars)} 字` : '');
    // 亲和星标在上游模型上：它代表本次实际走的那条路由（渠道 + 上游模型）。
    const modelStar = l.affinity
      ? `<span class="affinity-star" title="${affinityTitle(l)}">${AFFINITY_STAR}</span>`
      : '';
    return `<tr>
      <td class="nowrap fs-12">${esc(fmtTime(l.time))}</td>
      <td>
        <div class="flex-center gap-6">
          ${copyBadge(l.model_id, { label: '模型' })}
          ${l.stream ? '<span class="badge badge--blue" title="客户端请求了流式输出（请求体里 stream: true）">流式</span>' : ''}
          ${l.retries ? `<button type="button" class="badge badge--amber badge--click" data-attempts="${idx}" title="点击查看渠道重试历史">${icon('refresh', 11)}重试 ${l.retries}</button>` : ''}
        </div>
      </td>
      <td class="fs-12">
        ${l.channel_id
          ? `<div class="log-route">${copyBadge(o.channel(l), { label: '渠道', copy: l.channel_id })}${l.key_masked
            ? `<span class="log-star-wrap">${colorBadge(keyLabel(l), 'badge--xs')}${l.key_affinity ? `<span class="affinity-star affinity-star--sm" title="${KEY_AFFINITY_TITLE}">${AFFINITY_STAR}</span>` : ''}</span>`
            : ''}</div>`
          : '<span class="muted">未命中渠道</span>'}
      </td>
      <td class="fs-12">${l.upstream_model
        ? `<span class="log-star-wrap">${upstreamModelBadge(l, (t) => copyBadge(t, { label: '上游模型' }))}${modelStar}</span>`
        : '<span class="muted">—</span>'}</td>
      <td class="fs-12">${copyBadge(l.token_name, { label: '令牌' })}</td>
      <td class="num">${num(l.prompt_tokens)}${l.usage_estimate ? ' <span class="muted fs-12" title="上游未上报用量，Token 数为网关估算">(估算)</span>' : ''}${l.cached_tokens ? sub(`缓存读 ${num(l.cached_tokens)}`) : ''}</td>
      <td class="num">${num(l.completion_tokens)}${l.output_estimate ? ' <span class="muted fs-12" title="上游未上报输出用量，按响应正文长度估算">(估算)</span>' : ''}${reasoning ? sub(reasoning) : ''}</td>
      <td class="num">${l.tokens_per_sec
        ? `<span title="输出 tokens / 生成耗时，按流式请求上游的记录计算（首块内容到末块内容）">${l.tokens_per_sec.toFixed(1)} t/s</span>`
        : '<span class="muted">—</span>'}</td>
      <td class="num">${num(l.total_tokens)}</td>
      <td class="num">${esc(fmtDuration(l.latency_ms))}${l.first_byte_ms ? sub(`首字 ${esc(fmtDuration(l.first_byte_ms))}`) : ''}</td>
      <td class="fs-12">${copyBadge(l.ip, { label: 'IP ' })}</td>
      <td>${logSoft(l)
        ? `<button type="button" class="badge badge--amber badge--click" data-log-error="${idx}" data-tip="${esc(l.error || '')}">${esc(l.status_code || 200)}</button>`
        : (logOK(l)
          ? '<span class="badge badge--green">成功</span>'
          : `<button type="button" class="badge badge--red badge--click" data-log-error="${idx}" data-tip="${esc(l.error || '')}">${esc(l.status_code || '失败')}</button>`)}</td>
    </tr>`;
  }

  // 整个表（表头 + 行）也在这里出，免得两边列顺序 / 列数各走各的。
  // 外层滚动容器由各页面自己套：日志页要吸顶 + 定高，看板是卡片里的全宽表。
  const logTableHtml = (items, o) => `<table class="tbl tbl--logs">${LOG_TABLE_HEAD}
    <tbody>${items.map((l, i) => logRowHtml(l, i, o)).join('')}</tbody></table>`;

  // 表格渲染完把「重试历史 / 错误详情」两个入口绑上，两个页面都一样。
  function bindLogRows(host, items) {
    host.querySelectorAll('[data-attempts]').forEach((btn) => {
      btn.onclick = () => showRetryHistory(items[Number(btn.dataset.attempts)]);
    });
    host.querySelectorAll('[data-log-error]').forEach((btn) => {
      btn.onclick = () => showLogError(items[Number(btn.dataset.logError)]);
    });
  }

  // ======================================================================
  // 数据看板
  // ======================================================================
  // 看板的时间区间和调用日志保持一致：预设下拉 + 起止时间输入。
  // pick 是下拉里的写法，label 进统计卡标题（「近 7 天请求」），compare 是环比文案。
  const DASH_RANGES = {
    today: { pick: '今日', label: '今日', compare: '较昨日同期' },
    yesterday: { pick: '昨日', label: '昨日', compare: '较前日同期' },
    '7d': { pick: '近 7 天', label: '近 7 天', compare: '较前 7 天' },
    '30d': { pick: '近 30 天', label: '近 30 天', compare: '较前 30 天' },
    // 全部区间从最早一条统计记录开始累计，没有可对比的上一周期
    all: { pick: '全部时间', label: '累计', compare: '' },
    custom: { pick: '自定义', label: '区间', compare: '较上一周期' },
  };
  const DASH_PRESET_KEYS = ['today', 'yesterday', '7d', '30d', 'all', 'custom'];
  // start / end 为毫秒时间戳，只有自定义区间才用到；预设区间每次请求时现算。
  const dashRange = { key: 'today', start: 0, end: 0 };
  const dashRangeInfo = () => DASH_RANGES[dashRange.key] || DASH_RANGES.today;
  // 当前区间的起止毫秒（0 = 该端不限）。预设直接复用调用日志那套换算，
  // 两个页面的「今日」「近 7 天」指的是同一段时间。
  function dashBounds() {
    if (dashRange.key === 'custom') return { start: dashRange.start, end: dashRange.end };
    return rangeOfPreset(dashRange.key) || { start: 0, end: 0 };
  }
  // 统计接口的查询串：预设也换算成 start / end 传，后端按自定义区间算环比。
  function dashRangeQuery() {
    const p = new URLSearchParams();
    if (dashRange.key === 'all') {
      p.set('range', 'all');
      return p;
    }
    const b = dashBounds();
    p.set('range', 'custom');
    if (b.start) p.set('start', String(b.start));
    if (b.end) p.set('end', String(b.end));
    return p;
  }
  // 图表口径开关（顶栏）：请求数 / Token，调用趋势和模型调用分布共用一份。
  const dashMetric = { m: 'requests' };
  // 调用趋势的视图选择：all = 每个模型一条线，total = 总计三条曲线，model = 单个模型三条曲线。
  // 三个视图都在图例里点，不额外占上面的维度切换位。
  const dashSel = { kind: 'all', id: '' };
  // 图例胶囊超过一排时收进「其他 n 个」，点了才展开；选中某个模型或点开后全量显示
  let legendShowAll = false;
  // 各模型的固定配色，和模型调用分布的环形图保持一致。
  // 刻意避开失败数用的红色，免得图例里分不清哪个是失败线。
  const DASH_MODEL_COLORS = ['#4d9e2f', '#e9a316', '#3f8fbf', '#8a5ac2', '#d9557f', '#7cc243',
    '#5f9e8b', '#b07b3e', '#6b7f9e', '#a05a9b', '#3f9e8f', '#8a8f98'];
  // 环形图和趋势图例共用的模型配色：按模型名固定下来，
  // 环形图切到 Token 口径重新排序后颜色不变，同一个模型在两处永远是同一个颜色。
  function dashModelColors(breakdown) {
    const map = new Map();
    const rows = breakdown.models || [];
    rows.forEach((m, i) => map.set(m.name, DASH_MODEL_COLORS[i % DASH_MODEL_COLORS.length]));
    // 只在「按 Token 排」里出现的模型，排在请求数列表后面接着拿颜色。
    const extra = breakdown.models_by_tokens || [];
    extra.forEach((m, i) => {
      if (!map.has(m.name)) {
        map.set(m.name, DASH_MODEL_COLORS[(rows.length + i) % DASH_MODEL_COLORS.length]);
      }
    });
    return map;
  }
  // 图例、环形图、趋势曲线共用的模型清单：
  // 请求数口径用「调用次数前 12」，Token 口径用后端另给的「按 Token 消耗前 12」，
  // 三处显示同一批模型、同一套颜色，切口径时不会各说各话。
  function dashModelList(breakdown, isTok) {
    const rows = breakdown.models || [];
    if (!isTok) return rows;
    const byTok = breakdown.models_by_tokens || [];
    return byTok.length ? byTok : rows;
  }
  const DASH_UNIT_KEY = 'ldmapi.dashboard.unit';
  const dashUnit = { mode: 'cn' };
  try {
    const saved = localStorage.getItem(DASH_UNIT_KEY);
    if (saved === 'en' || saved === 'cn' || saved === 'none') dashUnit.mode = saved;
  } catch (e) { /* 存储不可用时用默认值 */ }

  // 看板数字单位：en = K/M/B，cn = 万/亿，none = 完整数字
  function fmtDash(n) {
    n = Number(n) || 0;
    const abs = Math.abs(n);
    if (dashUnit.mode === 'none') return n.toLocaleString('zh-CN');
    const fixed = (v) => v.toFixed(2).replace(/\.?0+$/, '');
    if (dashUnit.mode === 'en') {
      if (abs >= 1e9) return fixed(n / 1e9) + 'B';
      if (abs >= 1e6) {
        const v = n / 1e6;
        return Math.abs(v) >= 999.995 ? fixed(n / 1e9) + 'B' : fixed(v) + 'M';
      }
      if (abs >= 1e3) {
        const v = n / 1e3;
        return Math.abs(v) >= 999.995 ? fixed(n / 1e6) + 'M' : fixed(v) + 'K';
      }
      return n.toLocaleString('zh-CN');
    }
    if (abs >= 1e8) return fixed(n / 1e8) + '亿';
    if (abs >= 1e4) {
      const v = n / 1e4;
      return Math.abs(v) >= 9999.995 ? fixed(n / 1e8) + '亿' : fixed(v) + '万';
    }
    return n.toLocaleString('zh-CN');
  }

  // 统计还没算完时的占位：值位先留一条浅色骨架，数据回来原地替换，
  // 卡片高度不会跟着跳一下。图表和排行也用同一套，页面先出来再慢慢填。
  const dashPh = (w, extra) => `<span class="dash-ph${extra ? ' ' + extra : ''}" style="width:${w}px"></span>`;
  const dashChartPh = (height) => `<div class="dash-ph-chart" style="height:${height}px">
    <span class="dash-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>统计中…</span>
  </div>`;
  // 统计卡骨架：标签照常写出来（当前区间一眼能看到），数值和脚注先留浅色条。
  // 首屏骨架直接用它填，省掉页面建完再替换一遍的二次重排。
  const dashStatPh = (iconName, label, wValue, wFoot) => `
    <div class="stat__label">${icon(iconName, 13)}${label}</div>
    <div class="stat__value">${dashPh(wValue, 'dash-ph--value')}</div>
    <div class="stat__foot">${dashPh(wFoot, 'dash-ph--foot')}</div>`;
  const dashLegendPh = () => [96, 82, 90, 76]
    .map((w) => `<span class="dash-ph dash-ph--pill" style="width:${w}px"></span>`).join('');
  const dashRankPh = () => `<div class="rank-list">${[0, 1, 2, 3, 4].map((i) => `
    <div class="rank-item">
      <div class="rank-item__top">
        ${dashPh(116 - i * 9)}
        <span class="dash-ph" style="width:40px;margin-left:auto"></span>
      </div>
      <div class="rank-item__bar"></div>
    </div>`).join('')}</div>`;
  // 最近调用：表头先出来，行内容用占位条顶着，日志回来再替换。
  // 列跟调用日志页保持一致，数据没回来时宽度也不跳。
  const dashLogsPh = () => `<div class="table-wrap table-wrap--flush">
    <table class="tbl tbl--logs">
      <thead><tr>
        <th>时间</th><th>请求模型</th><th>渠道</th><th>上游模型</th>
        <th>输入</th><th>输出</th><th>速度</th><th>总计</th><th>耗时</th>
        <th>来源 IP</th><th>状态</th>
      </tr></thead>
      <tbody>${[0, 1, 2, 3, 4, 5, 6, 7].map(() => `<tr>
        <td>${dashPh(112)}</td>
        <td>${dashPh(96)}</td>
        <td>${dashPh(84)}</td>
        <td>${dashPh(88)}</td>
        <td class="right">${dashPh(40)}</td>
        <td class="right">${dashPh(40)}</td>
        <td class="right">${dashPh(44)}</td>
        <td class="right">${dashPh(40)}</td>
        <td class="right">${dashPh(46)}</td>
        <td>${dashPh(88)}</td>
        <td>${dashPh(46)}</td>
      </tr>`).join('')}</tbody>
    </table>
  </div>`;

  // 统计区间按北京时间划自然日，累计起点也按北京时间取日期，跨时区查看时不会差一天
  function dashDay(ms) {
    const d = new Date(ms + 8 * 3600 * 1000);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  }

  window.LDM.registerPage('dashboard', {
    title: '数据看板',
    desc: '网关调用量、Token 消耗与渠道健康度',
    async render(root, actions, filters) {
      // 统计区间是筛选，放左边贴标题；单位和刷新是功能按钮，固定最右
      filters.innerHTML = `
        <select class="select" id="dash-preset" aria-label="统计区间" style="width:auto;min-width:96px">
          ${DASH_PRESET_KEYS.map((k) => `<option value="${k}"${dashRange.key === k ? ' selected' : ''}>${DASH_RANGES[k].pick}</option>`).join('')}
        </select>
        <input class="input log-time" id="dash-start" type="datetime-local" aria-label="开始时间"
               value="${toLocalInput(dashBounds().start)}" style="width:auto;min-width:168px">
        <span class="log-range-end">
          <span class="muted fs-12">至</span>
          <input class="input log-time" id="dash-end" type="datetime-local" aria-label="结束时间"
                 title="留空表示到此刻" value="${toLocalInput(dashBounds().end)}" style="width:auto;min-width:168px">
        </span>`;
      actions.innerHTML = `
        <select class="select" id="dash-unit" aria-label="数字单位" style="width:auto;min-width:128px">
          <option value="en"${dashUnit.mode === 'en' ? ' selected' : ''}>英文单位 K/M</option>
          <option value="cn"${dashUnit.mode === 'cn' ? ' selected' : ''}>中文单位 万/亿</option>
          <option value="none"${dashUnit.mode === 'none' ? ' selected' : ''}>无单位</option>
        </select>
        <button class="btn" id="btn-refresh">${icon('refresh', 14)}刷新</button>`;

      actions.querySelector('#btn-refresh').onclick = () => loadAll();
      actions.querySelector('#dash-unit').onchange = (e) => {
        dashUnit.mode = e.target.value;
        try { localStorage.setItem(DASH_UNIT_KEY, dashUnit.mode); } catch (err) { /* 忽略配额错误 */ }
        paintData();
      };

      // 时间区间：预设下拉和起止输入框是同一份状态，改哪个都能生效。
      const presetEl = filters.querySelector('#dash-preset');
      const startEl = filters.querySelector('#dash-start');
      const endEl = filters.querySelector('#dash-end');
      // 预设切换后把区间换算成具体时间填进输入框，方便看清到底查的是哪一段
      const syncTimeInputs = () => {
        const b = dashBounds();
        startEl.value = toLocalInput(b.start);
        endEl.value = toLocalInput(b.end);
      };
      syncTimeInputs();

      presetEl.onchange = () => {
        const next = presetEl.value;
        // 从预设切到「自定义」时，把输入框里正显示的那段区间留下来当起点，
        // 免得刚看清是哪一段、一切自定义就被清空。
        if (next === 'custom') {
          dashRange.start = startEl.value ? new Date(startEl.value).getTime() : 0;
          dashRange.end = endEl.value ? new Date(endEl.value).getTime() : 0;
        }
        dashRange.key = next;
        syncTimeInputs();
        loadAll();
      };
      [startEl, endEl].forEach((el) => {
        const apply = () => {
          const s = startEl.value ? new Date(startEl.value).getTime() : 0;
          const e = endEl.value ? new Date(endEl.value).getTime() : 0;
          if (s && e && e < s) {
            Toast.error('结束时间不能早于开始时间');
            syncTimeInputs();
            return;
          }
          // 两端都清空 = 起止都不限，等于「全部时间」，下拉跟着切过去。
          // 只清空一端时按自定义区间查：开始空 = 从最早记录算起，结束空 = 到此刻。
          if (!s && !e) {
            dashRange.key = 'all';
            dashRange.start = 0;
            dashRange.end = 0;
            presetEl.value = 'all';
            loadAll();
            return;
          }
          // 手动改时间就落到「自定义」，下拉跟着变
          dashRange.key = 'custom';
          dashRange.start = s;
          dashRange.end = e;
          presetEl.value = 'custom';
          loadAll();
        };
        el.onchange = apply;
        el.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); apply(); } };
      });

      // 页面骨架和取数分开：先把所有卡片、图表占位铺出来，再去拉数据。
      // 以前是等四个接口全回来才建 DOM，统计慢一点整页就停在加载圈上。
      root.innerHTML = `<div id="dash-body"></div>`;
      const body = root.querySelector('#dash-body');
      // 各区块的数据分开存：谁先回来谁先填，不用等最慢的那个接口。
      // 初始为 null，paint* 遇到没数据的区块直接跳过，骨架继续留在页面上。
      const dashData = { overview: null, series: null, breakdown: null, logs: null };
      let dom = null;
      let loadSeq = 0;

      buildSkeleton();
      // 骨架里已经铺好了占位，首屏不用再刷一遍（省一次整块重排）
      loadAll(true);

      // 拉全量数据：首次进入、切区间、刷新
      async function loadAll(fresh) {
        const seq = ++loadSeq;
        const stale = () => seq !== loadSeq;
        // 区间变了，旧数字先清掉回到骨架，避免把上一段的统计当成这一段的
        if (!fresh) resetComputed();
        clearLoadError();
        // 选中某个模型时，统计和序列都按该模型取；「各模型」「总计」都是全局视图。
        const scope = dashSel.kind === 'model' ? '&model=' + encodeURIComponent(dashSel.id) : '';
        // 区间查询串只算一次，几个接口用的是同一段起止时间
        const rangeQS = dashRangeQuery().toString();

        // 三组请求并行：统计卡 / 图表（曲线 + 分布）/ 最近调用。
        // 每组回来就填自己那块，统计卡不用等曲线数据一起到才显示数字。
        const results = await Promise.allSettled([
          API.get('/api/stats/overview?' + rangeQS + scope).then((overview) => {
            if (stale()) return;
            dashData.overview = overview;
            paintStats();
          }),
          Promise.all([
            API.get('/api/stats/series?' + rangeQS + scope),
            API.get('/api/stats/breakdown?' + rangeQS),
          ]).then(([series, breakdown]) => {
            if (stale()) return;
            dashData.series = series;
            dashData.breakdown = breakdown;
            paintTrend();
            paintLegend();
            paintDonut();
            paintRanks();
          }),
          API.get('/api/logs?limit=8').then((logs) => {
            if (stale()) return;
            dashData.logs = logs;
            paintLogs();
          }).catch((e) => {
            if (stale()) return;
            paintLogsError(e);
          }),
        ]);
        if (stale()) return;
        body.removeAttribute('aria-busy');
        // 最近调用失败已经写在卡片里，这里只提示统计和图表两组
        const failed = ['统计卡', '图表'].filter((_, i) => results[i].status === 'rejected');
        if (failed.length) {
          const reason = results.find((r) => r.status === 'rejected').reason;
          showLoadError(failed.join('、') + '加载失败：' + ((reason && reason.message) || reason || '未知错误'));
        }
      }

      // 换视图：只重新拉统计和曲线，分布与日志不变。
      // 页面骨架不动，只重画受影响的几个区域，不会整块闪一下。
      async function loadView() {
        const seq = ++loadSeq;
        try {
          // 「各模型」「总计」都是全局视图，只有单个模型才带 model 参数。
          const scope = dashSel.kind === 'model' ? '&model=' + encodeURIComponent(dashSel.id) : '';
          const rangeQS = dashRangeQuery().toString();
          const [overview, series] = await Promise.all([
            API.get('/api/stats/overview?' + rangeQS + scope),
            API.get('/api/stats/series?' + rangeQS + scope),
          ]);
          if (seq !== loadSeq) return;
          dashData.overview = overview;
          dashData.series = series;
        } catch (e) {
          if (seq !== loadSeq) return;
          Toast.error(e.message || '加载失败');
          return;
        }
        paintStats();
        paintTrend();
        paintLegend();
        paintDonut();
      }

      // 切区间 / 刷新时先回到骨架：旧区间的数字不能留在新区间上，
      // 顺手把数据也清空，单位切换之类的重画不会拿旧值来填新骨架。
      function resetComputed() {
        dashData.overview = null;
        dashData.series = null;
        dashData.breakdown = null;
        paintPlaceholders();
      }

      // 骨架值：统计卡只留标签，数值和脚注先空着；图表、图例、排行给同尺寸占位，
      // 数据回来原地替换，卡片高度不会跳一下。最近调用不随区间变化，保持原样。
      function paintPlaceholders() {
        hideTip();
        body.setAttribute('aria-busy', 'true');
        const label = dashRangeInfo().label;
        dom.req.innerHTML = dashStatPh('zap', `${label}请求`, 104, 84);
        dom.token.innerHTML = dashStatPh('bolt', `${label} Token`, 112, 72);
        dom.rate.innerHTML = dashStatPh('check', '成功率', 88, 64);
        dom.speed.innerHTML = dashStatPh('clock', '平均速度', 96, 150);

        dom.trendSub.textContent = '';
        // 先把旧的曲线和尺寸观察器一起清掉，窗口缩放时旧数据不会画回占位上
        clearChart(dom.trend);
        dom.trend.innerHTML = dashChartPh(256);
        dom.legend.innerHTML = dashLegendPh();
        dom.note.textContent = '';
        dom.donutSub.textContent = '';
        clearChart(dom.donut);
        dom.donut.innerHTML = dashChartPh(196);
        dom.channelRank.innerHTML = dashRankPh();
        dom.tokenRank.innerHTML = dashRankPh();
      }

      function clearLoadError() {
        const el = body.querySelector('#dash-load-error');
        if (el) el.remove();
      }

      // 某一组统计失败：顶部给一条可重试的提示，已经填好的区块不受影响。
      function showLoadError(text) {
        clearLoadError();
        const el = document.createElement('div');
        el.id = 'dash-load-error';
        el.className = 'alert alert--warn dash-load-error';
        el.innerHTML = `${icon('alert', 16)}<div><div class="strong">数据加载失败</div><div>${esc(text)}</div></div>
          <button class="btn btn--sm" id="dash-retry">重试</button>`;
        body.insertBefore(el, body.firstChild);
        el.querySelector('#dash-retry').onclick = () => loadAll();
      }

      function paintLogsError(e) {
        dom.recent.innerHTML = `<div style="padding:10px 0">
          <div class="alert alert--warn">${icon('alert', 16)}<div>最近调用加载失败：${esc((e && e.message) || e || '未知错误')}</div></div>
        </div>`;
      }

      // 骨架只建一次，之后所有操作都只重画局部。
      // 占位内容直接写进骨架里（而不是建完再替换一遍），切页只发生一次大的 DOM 变更。
      function buildSkeleton() {
        // 问候语：页面开头的视觉锚点，字号拉开和卡片的层级差
        const now = new Date();
        const h = now.getHours();
        const hello = h < 5 ? '夜深了' : h < 9 ? '早上好' : h < 12 ? '上午好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
        const week = '日一二三四五六'[now.getDay()];
        const label = dashRangeInfo().label;
        body.setAttribute('aria-busy', 'true');
        body.innerHTML = `
          <div class="dash-hello">
            <div class="dash-hello__hi">${hello}</div>
            <div class="dash-hello__sub">${now.getMonth() + 1} 月 ${now.getDate()} 日 星期${week} · 欢迎回来，站点概况都在这儿</div>
          </div>
          <div class="stat-grid stat-grid--4">
            <div class="stat" id="card-req">${dashStatPh('zap', `${label}请求`, 104, 84)}</div>
            <div class="stat" id="card-token">${dashStatPh('bolt', `${label} Token`, 112, 72)}</div>
            <div class="stat" id="card-rate">${dashStatPh('check', '成功率', 88, 64)}</div>
            <div class="stat" id="card-speed">${dashStatPh('clock', '平均速度', 96, 150)}</div>
          </div>

          <div class="dash-metric-row">
            <div class="pill-toggle" id="metric-toggle" aria-label="图表口径">
              <button data-m="requests" class="${dashMetric.m === 'requests' ? 'is-on' : ''}">请求数</button>
              <button data-m="tokens" class="${dashMetric.m === 'tokens' ? 'is-on' : ''}">Token</button>
            </div>
          </div>

          <div class="chart-grid">
            <div class="card">
              <div class="card__head">
                <div>
                  <div class="card__title">调用趋势</div>
                  <div class="card__sub" id="trend-sub"></div>
                </div>
              </div>
              <div class="card__body">
                <div id="trend-chart">${dashChartPh(256)}</div>
                <div class="chart-legend" id="model-legend">${dashLegendPh()}</div>
                <div class="fs-12 muted" id="trend-note" style="margin-top:6px"></div>
              </div>
            </div>

            <div class="card">
              <div class="card__head">
                <div>
                  <div class="card__title">模型调用分布</div>
                  <div class="card__sub" id="donut-sub"></div>
                </div>
              </div>
              <div class="card__body"><div id="model-donut">${dashChartPh(196)}</div></div>
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
              <div class="card__body"><div id="channel-rank">${dashRankPh()}</div></div>
            </div>
            <div class="card">
              <div class="card__head">
                <div>
                  <div class="card__title">密钥调用量</div>
                  <div class="card__sub">按 API 密钥统计</div>
                </div>
              </div>
              <div class="card__body"><div id="token-rank">${dashRankPh()}</div></div>
            </div>
          </div>

          <div class="card">
            <div class="card__head">
              <div>
                <div class="card__title">最近调用</div>
              </div>
              <div class="card__actions">
                <button class="btn btn--sm" id="go-logs">查看全部${icon('logs', 13)}</button>
              </div>
            </div>
            <div id="recent-logs">${dashLogsPh()}</div>
          </div>`;

        dom = {
          req: body.querySelector('#card-req'),
          token: body.querySelector('#card-token'),
          rate: body.querySelector('#card-rate'),
          speed: body.querySelector('#card-speed'),
          trendSub: body.querySelector('#trend-sub'),
          trend: body.querySelector('#trend-chart'),
          legend: body.querySelector('#model-legend'),
          note: body.querySelector('#trend-note'),
          donutSub: body.querySelector('#donut-sub'),
          donut: body.querySelector('#model-donut'),
          channelRank: body.querySelector('#channel-rank'),
          tokenRank: body.querySelector('#token-rank'),
          recent: body.querySelector('#recent-logs'),
        };
        // 口径开关：切请求数 / Token 时曲线、图例、环形图一起重画，
        // 三处用的是同一份状态，只动其一就会和别处对不上。
        body.querySelectorAll('#metric-toggle button').forEach((b) => {
          b.onclick = () => setMetric(b.dataset.m);
        });
        body.querySelector('#go-logs').onclick = () => { location.hash = '#/logs'; };
      }

      // 切换图表口径（请求数 / Token），开关在两张图表卡片上面，趋势和分布共用。
      // 曲线、图例、环形图必须一起重画：图例里的模型数字、模型清单、
      // 环形的排序都跟着这个口径走，只动一处就会和别处对不上。
      function setMetric(m) {
        dashMetric.m = m;
        body.querySelectorAll('#metric-toggle button').forEach((x) => x.classList.toggle('is-on', x.dataset.m === m));
        paintTrend();
        paintLegend();
        paintDonut();
      }

      // 选中的模型没有 Token / 速度记录时（老数据只记了请求数和失败数），
      // 显示「—」并说明原因，别让 0 看起来像「没用 Token」。
      function knownFlags() {
        const t = dashData.overview.current;
        const scoped = dashSel.kind === 'model';
        return {
          token: !(scoped && t.requests > 0 && t.total_tokens === 0),
          speed: !(scoped && t.requests > 0 && t.speed_samples === 0),
        };
      }

      function paintStats() {
        if (!dashData.overview) return;
        const { overview } = dashData;
        const t = overview.current;
        const y = overview.previous;
        const info = dashRangeInfo();
        const scoped = dashSel.kind === 'model';
        const known = knownFlags();
        const delta = (cur, prev) => {
          // 全部区间没有上一周期可比，脚注改成累计起点，避免出现「新增」这种误导
          if (!info.compare) {
            const from = overview.start ? dashDay(overview.start) : '';
            return `<span class="muted">${from ? from + ' 起' : '全部记录'}</span>`;
          }
          if (!prev) return cur > 0 ? '<span class="stat__delta up">新增</span>' : '<span class="muted">—</span>';
          const d = ((cur - prev) / prev) * 100;
          const cls = d >= 0 ? 'up' : 'down';
          const arrow = d >= 0 ? '↑' : '↓';
          return `<span class="stat__delta ${cls}">${arrow} ${Math.abs(d).toFixed(1)}%</span> ${info.compare}`;
        };

        dom.req.innerHTML = `
          <div class="stat__label">${icon('zap', 13)}${info.label}请求</div>
          <div class="stat__value">${fmtDash(t.requests)}<small>次</small></div>
          <div class="stat__foot">${delta(t.requests, y.requests)}</div>`;
        dom.token.innerHTML = `
          <div class="stat__label">${icon('bolt', 13)}${info.label} Token</div>
          <div class="stat__value">${known.token ? fmtDash(t.total_tokens) : '—'}</div>
          <div class="stat__foot">${known.token
            ? delta(t.total_tokens, y.total_tokens)
            : '历史数据未按模型记录 Token'}</div>`;
        dom.rate.innerHTML = `
          <div class="stat__label">${icon('check', 13)}成功率</div>
          <div class="stat__value" style="color:${rateColor(t.requests ? t.success_rate : 100)}">${t.requests ? t.success_rate.toFixed(1) : '100.0'}<small style="color:inherit">%</small></div>
          <div class="stat__foot">${t.errors ? `${fmtInt(t.errors)} 次失败` : '全部成功'}</div>`;
        dom.speed.innerHTML = `
          <div class="stat__label">${icon('clock', 13)}平均速度</div>
          <div class="stat__value">${known.speed ? `${t.avg_speed.toFixed(1)}<small>t/s</small>` : '—'}</div>
          <div class="stat__foot">${known.speed
            ? `首字 ${fmtDuration(t.avg_first_byte)} · 总耗时 ${fmtDuration(t.avg_speed_latency)}`
            : (scoped ? '历史数据未按模型记录速度' : '暂无速度样本')}</div>`;
      }

      function paintTrend() {
        if (!dashData.series || !dashData.breakdown) return;
        hideTip();
        const { series, breakdown } = dashData;
        const points = series.points || [];
        const labels = points.map((p) => timeLabel(p.time, series.step_ms * points.length));
        const times = points.map((p) => p.time);
        const kind = dashSel.kind;
        const isTok = dashMetric.m === 'tokens';
        // 模型清单跟着上面的维度走：Token 口径用「按 Token 消耗排」的列表，
        // 和图例、环形图是同一批模型、同一套颜色。
        const modelRows = dashModelList(breakdown, isTok);
        const colors = dashModelColors(breakdown);
        const ms = series.model_series || {};
        // 汇总曲线：请求数 / 成功数 / 失败数
        const summary = (pts) => ([
          { name: '请求数', color: '#3f8fbf', values: pts.map((p) => p.requests) },
          { name: '成功数', color: '#4d9e2f', values: pts.map((p) => Math.max(0, p.requests - p.errors)) },
          { name: '失败数', color: '#c9483a', values: pts.map((p) => p.errors) },
        ]);
        // Token 构成：输入 / 输出 / 总。三条同时画在图上时，总计只能取「总 Token」
        // 那一条，否则输入 + 输出 + 总会被重复相加。
        const tokenSummary = (pts) => ([
          { name: '输入 Token', color: '#3f8fbf', values: pts.map((p) => p.prompt_tokens) },
          { name: '输出 Token', color: '#4d9e2f', values: pts.map((p) => p.completion_tokens) },
          { name: '总 Token', color: '#e9a316', values: pts.map((p) => p.total_tokens) },
        ]);
        let s;
        let totalFrom = null;
        let sub;
        if (dashMetric.m === 'tokens') {
          if (kind === 'all') {
            // 各模型：每个模型一条总 Token 曲线，和请求数维度一一对应。
            // 没有 Token 数据的模型照画（值是 0），在图下注明有几个模型缺数据，
            // 免得贴底的 0 线被当成「这段时间没调用」。
            s = [];
            modelRows.forEach((m) => {
              const one = ms[m.name];
              if (!one) return;
              s.push({
                name: m.name,
                color: colors.get(m.name) || DASH_MODEL_COLORS[0],
                values: one.total_tokens,
              });
            });
            if (s.length) {
              sub = '每个模型一条曲线（总 Token），点下面的图例可单独查看';
            } else {
              // 老数据没有按模型记 Token 时退回整体构成
              s = tokenSummary(points);
              totalFrom = '总 Token';
              sub = '总计的输入 / 输出 / 总 Token';
            }
          } else {
            // 总计 / 单个模型：输入、输出、总 Token 三条线。
            s = tokenSummary(points);
            totalFrom = '总 Token';
            sub = kind === 'model'
              ? `当前只看 ${dashSel.id}：输入 / 输出 / 总 Token`
              : '总计的输入 / 输出 / 总 Token';
          }
        } else if (kind === 'model') {
          // 单个模型：请求数 / 成功数 / 失败数三条都是这个模型的。
          s = summary(points);
          totalFrom = '请求数';
          sub = `当前只看 ${dashSel.id}`;
        } else if (kind === 'total') {
          // 总计：请求数 / 成功数 / 失败数。
          s = summary(points);
          totalFrom = '请求数';
          sub = '总计的请求数 / 成功数 / 失败数';
        } else {
          // 各模型：每个模型一条总请求数曲线，另加一条总失败数。
          s = [];
          modelRows.forEach((m) => {
            const one = ms[m.name];
            if (!one) return;
            s.push({
              name: m.name,
              color: colors.get(m.name) || DASH_MODEL_COLORS[0],
              values: one.requests,
            });
          });
          if (s.length) {
            s.push({ name: '失败数', color: '#c9483a', values: points.map((p) => p.errors), noTotal: true });
            sub = '每个模型一条曲线，点下面的图例可单独查看';
          } else {
            // 老数据没有按模型记的曲线时退回整体
            s = summary(points);
            totalFrom = '请求数';
            sub = '总计的请求数 / 成功数 / 失败数';
          }
        }
        // 副标题顺带说清图例里那个数字是什么口径，跟上面的维度保持一致。
        dom.trendSub.textContent = sub
          + (dashMetric.m === 'tokens' ? '（图例里的模型数字为 Token 消耗）' : '（图例里的模型数字为调用次数）');
        areaChart(dom.trend, {
          labels, times, series: s, height: 256, spanMs: series.step_ms,
          valueFmt: fmtDash,
          axisFmt: fmtDash,
          totalName: '总计',
          totalFrom,
        });
        // 选了模型又切到 Token 维度、而这个模型没有 Token 记录时说明一下，
        // 否则图上几条平线会让人以为调用量是 0。
        // 各模型视图同理：缺 Token 数据的模型画不出曲线，要告诉用户少了几个。
        let note = '';
        if (dashMetric.m === 'tokens') {
          if (kind === 'model' && !knownFlags().token) {
            note = '该模型没有 Token 记录（历史数据未按模型统计 Token）';
          } else if (kind === 'all') {
            const noTok = modelRows.filter((m) => {
              const one = ms[m.name];
              return !one || !one.total_tokens.some((v) => v > 0);
            });
            if (noTok.length) {
              note = `${noTok.length} 个模型没有 Token 数据（历史数据未按模型统计 Token），曲线为 0`;
            }
          }
        }
        dom.note.textContent = note;
      }

      // 图例既是曲线说明也是视图开关：「各模型」「总计」和各个模型都能点。
      function paintLegend() {
        if (!dashData.breakdown || !dashData.series) return;
        const { breakdown, series } = dashData;
        const kind = dashSel.kind;
        // 图例数字跟着上面的维度走：请求数维度显示调用次数，Token 维度显示 Token 消耗，
        // 这样图例数字和图上的曲线是同一个口径，不会对不上。
        const isTok = dashMetric.m === 'tokens';
        // 模型清单也跟着口径走：Token 口径用「按 Token 消耗排」的列表，
        // 和环形图、趋势曲线是同一批模型、同一套颜色。
        const modelRows = dashModelList(breakdown, isTok);
        const colors = dashModelColors(breakdown);
        const ms = series.model_series || {};
        const totalReq = breakdown.total || 0;
        const totalErr = breakdown.errors || 0;
        const totalTok = breakdown.tokens_used || 0;
        const failTag = (n) => (n ? `<span class="chart-legend__fail">${fmtDash(n)} 失败</span>` : '');
        const totalVal = isTok ? totalTok : totalReq;
        const items = [
          `<button type="button" class="chart-legend__item chart-legend__btn${kind === 'all' ? ' is-on' : ''}" data-sel="all" data-tip="每个模型一条曲线">
            <span class="chart-legend__swatch" style="background:linear-gradient(135deg,#4d9e2f,#3f8fbf 55%,#8a5ac2)"></span>
            <span class="nowrap">各模型</span>
            <b>${modelRows.length}</b>
          </button>`,
          `<button type="button" class="chart-legend__item chart-legend__btn${kind === 'total' ? ' is-on' : ''}" data-sel="total" data-tip="全部模型：调用 ${fmtDash(totalReq)} 次（成功 ${fmtDash(Math.max(0, totalReq - totalErr))} · 失败 ${fmtDash(totalErr)}）· Token 消耗 ${fmtDash(totalTok)}">
            <span class="chart-legend__swatch" style="background:#3f8fbf"></span>
            <span class="nowrap">总计</span>
            <b>${fmtDash(totalVal)}</b>
            ${failTag(totalErr)}
          </button>`,
        ];
        // 模型太多时只露前 8 颗，剩下的收进「其他 n 个」，免得胶囊拖出三行；
        // 选中某个模型（视图切到 model）或点过「其他」后全量显示
        const effShowAll = legendShowAll || kind === 'model';
        const visibleRows = (!effShowAll && modelRows.length > 9) ? modelRows.slice(0, 8) : modelRows;
        const hiddenCount = modelRows.length - visibleRows.length;
        visibleRows.forEach((m) => {
          const color = colors.get(m.name) || DASH_MODEL_COLORS[0];
          const hasLine = !!ms[m.name];
          const on = kind === 'model' && dashSel.id === m.name;
          const val = isTok ? (m.tokens || 0) : m.value;
          items.push(`<button type="button" class="chart-legend__item chart-legend__btn${on ? ' is-on' : ''}${hasLine ? '' : ' chart-legend__btn--plain'}" data-sel="${esc(m.name)}" data-tip="${esc(m.name)} · 区间内调用 ${fmtDash(m.value)} 次${m.errors ? ` · 失败 ${fmtDash(m.errors)} 次` : ''} · Token 消耗 ${fmtDash(m.tokens || 0)}">
            <span class="chart-legend__swatch" style="background:${color}"></span>
            <span class="truncate chart-legend__name">${esc(m.name)}</span>
            <b>${fmtDash(val)}</b>
            ${failTag(m.errors)}
          </button>`);
        });
        if (hiddenCount > 0) {
          items.push(`<button type="button" class="chart-legend__item chart-legend__more" data-more="1" data-tip="展开其余 ${hiddenCount} 个模型">其他 ${hiddenCount} 个 ▾</button>`);
        }
        dom.legend.innerHTML = items.join('');
        const moreBtn = dom.legend.querySelector('[data-more]');
        if (moreBtn) moreBtn.onclick = () => { legendShowAll = true; paintLegend(); };
        dom.legend.querySelectorAll('[data-sel]').forEach((btn) => {
          btn.onclick = () => {
            const sel = btn.dataset.sel;
            if (sel === 'all') {
              if (dashSel.kind === 'all') return;
              dashSel.kind = 'all';
              dashSel.id = '';
            } else if (sel === 'total') {
              if (dashSel.kind === 'total') return;
              dashSel.kind = 'total';
              dashSel.id = '';
            } else {
              if (dashSel.kind === 'model' && dashSel.id === sel) return;
              dashSel.kind = 'model';
              dashSel.id = sel;
            }
            loadView();
          };
        });
      }

      function paintDonut() {
        if (!dashData.breakdown) return;
        const { breakdown } = dashData;
        const scoped = dashSel.kind === 'model';
        // 请求数口径看调用次数，Token 口径看 Token 消耗（口径开关在顶栏，和趋势共用）。
        const isTok = dashMetric.m === 'tokens';
        // Token 口径用后端另给的一份「按 Token 排」的模型列表，
        // 免得调用不多但特别耗 Token 的模型排在「调用次数前 12」之外被漏掉。
        const src = dashModelList(breakdown, isTok);
        const colors = dashModelColors(breakdown);
        const items = src
          // Token 口径下没有 Token 记录的模型不进环，免得显示成 0 的空档。
          .filter((x) => !isTok || (x.tokens || 0) > 0)
          .map((x) => ({
            name: x.name,
            value: isTok ? (x.tokens || 0) : x.value,
            // 颜色跟着模型走，不跟着名次走：切到 Token 口径重新排序后，
            // 环上的颜色仍要和趋势图例里同一个模型的颜色对得上。
            color: scoped && x.name !== dashSel.id ? 'var(--border)' : colors.get(x.name),
          }));
        // Token 口径按 Token 数从大到小排，环形图更好读。
        if (isTok) items.sort((a, b) => b.value - a.value);
        donutChart(dom.donut, {
          items,
          size: 190,
          valueFmt: fmtDash,
          centerLabel: isTok ? '总 Token' : '总调用',
        });
        // 副标题写清当前口径，别让人对着百分比猜这个环是按什么分的。
        let sub = dashRangeInfo().label + (isTok ? ' · 按 Token 消耗' : ' · 按调用次数');
        const total = items.reduce((a, b) => a + b.value, 0);
        if (isTok && total === 0 && (breakdown.models || []).some((x) => x.value > 0)) {
          sub += '（历史数据未按模型记录 Token）';
        }
        dom.donutSub.textContent = sub;
      }

      function paintRanks() {
        if (!dashData.breakdown) return;
        const { breakdown } = dashData;
        rankList(dom.channelRank, breakdown.channels || [], { nameWidth: 200, fmt: fmtDash });
        rankList(dom.tokenRank, breakdown.tokens || [], { nameWidth: 200, fmt: fmtDash });
      }

      // 渠道格跟调用日志页完全一致：徽章点一下复制渠道 ID，用到多 Key 时下面再补一行 #N 备注。
      const dashChannelLabel = (l) => (l.channel_id || '') + (l.channel_name ? `（${l.channel_name}）` : '');

      function paintLogs() {
        // 重绘会换掉标记节点，气泡跟着收掉，别让它悬在旧位置上
        window.LDM.tip.hide();
        if (!dashData.logs) return;
        const items = (dashData.logs && dashData.logs.items) || [];
        // 表和行都走共用的 logTableHtml：列、徽章、点击行为跟调用日志页是同一份，
        // 不会再出现「看板点了没反应、悬停多一个气泡、手机上 IP 列没了」这种事。
        dom.recent.innerHTML = items.length
          ? `<div class="table-wrap table-wrap--flush">${logTableHtml(items, {
            num: fmtDash,
            channel: dashChannelLabel,
          })}</div>`
          : emptyState('还没有调用记录', '通过 API 调用任意模型后，这里会显示实时统计。', '', 'logs');
        bindLogRows(dom.recent, items);
      }

      // 单位切换只影响数字格式，重画看板上的所有数值区域即可；
      // light 数据还没回来时各 paint 会自动跳过，不会把骨架冲掉。
      function paintData() {
        paintStats();
        paintTrend();
        paintLegend();
        paintDonut();
        paintRanks();
      }
    },
  });

  // ======================================================================
  // 模型广场
  // ======================================================================
  const plazaState = { keyword: '', filter: 'all', provider: 'all', sort: '' };

  window.LDM.registerPage('plaza', {
    title: '模型广场',
    desc: '所有已启用、可被调用的模型',
    async render(root, actions, filters) {
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

      // 类型筛选 / 排序 / 搜索搬到顶栏第二行（搜索框放排序后面）；提供商胶囊留在页面下方
      filters.innerHTML = `
        <div class="pill-toggle" id="plaza-filter">
          <button data-f="all" class="${plazaState.filter === 'all' ? 'is-on' : ''}">全部</button>
          <button data-f="custom" class="${plazaState.filter === 'custom' ? 'is-on' : ''}">自定义模型</button>
          <button data-f="channel" class="${plazaState.filter === 'channel' ? 'is-on' : ''}">渠道模型</button>
        </div>
        <select class="select" id="plaza-sort" style="width:auto;min-width:150px">
          <option value="">默认排序</option>
          <option value="r24_desc">近 24h 成功率 降序</option>
          <option value="r24_asc">近 24h 成功率 升序</option>
          <option value="r200_desc">近 200 次成功率 降序</option>
          <option value="r200_asc">近 200 次成功率 升序</option>
        </select>
        <div class="search" style="flex:0 1 220px;min-width:170px">
          <span class="search__icon">${icon('search', 15)}</span>
          <input class="input" id="plaza-search" placeholder="搜索模型…" value="${esc(plazaState.keyword)}">
        </div>`;

      root.innerHTML = `
        <div class="provider-filter" id="plaza-providers">
            <button class="provider-chip${plazaState.provider === 'all' ? ' is-on' : ''}" data-p="all">全部提供商<span class="provider-chip__count">${availableItems.length}</span></button>
            ${plazaProviders.map((p) => `<button class="provider-chip${plazaState.provider === p.id ? ' is-on' : ''}" data-p="${esc(p.id)}">${providerIcon(p.icon, 15)}<span>${esc(p.name)}</span><span class="provider-chip__count">${providerCounts[p.id]}</span></button>`).join('')}
            ${unassigned ? `<button class="provider-chip${plazaState.provider === '__none' ? ' is-on' : ''}" data-p="__none">${providerIcon('', 15)}<span>未设置</span><span class="provider-chip__count">${unassigned}</span></button>` : ''}
            <span class="muted fs-12" id="plaza-count" style="margin-left:auto"></span>
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
        // 按成功率排序：没有调用记录的模型无论升降序都排在最后
        if (plazaState.sort) {
          const key = plazaState.sort.startsWith('r200') ? 'success_rate_200' : 'success_rate';
          const countKey = key === 'success_rate_200' ? 'requests_200' : 'requests_24h';
          const dir = plazaState.sort.endsWith('_asc') ? 1 : -1;
          list = list.slice().sort((a, b) => {
            const av = a[key] >= 0 ? a[key] : -1;
            const bv = b[key] >= 0 ? b[key] : -1;
            if (av < 0 && bv < 0) return 0;
            if (av < 0) return 1;
            if (bv < 0) return -1;
            if (av !== bv) return (av - bv) * dir;
            // 成功率相同时调用次数多的排前面，两个方向一致
            return (b[countKey] || 0) - (a[countKey] || 0);
          });
        }
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
              ${m.status === 'custom_content' ? badge('始终返回内容', 'green') : ''}
              ${window.LDM.capBadges(m.caps, { showNeg: true })}
              ${(m.tags || []).map((t) => badge(t, 'gray')).join('')}
            </div>
            ${isCustom && m.routes && m.routes.length ? `<div class="fs-12 muted truncate" style="font-family:var(--mono)" title="${esc(m.routes.map((r) => r.model_id).join(' → '))}">
              ${esc(m.routes.map((r) => r.model_id).join(' → '))}</div>` : ''}
            ${!isCustom && m.source ? `<div class="fs-12 muted">来源：${esc(m.source)}</div>` : ''}
            <div class="model-card__foot">
              <div class="model-card__stats">
                <span class="model-card__stat">近 24h <b>${fmtInt(m.requests_24h)}</b> 次 · 成功率
                  ${m.success_rate >= 0
                    ? `<b style="color:${rateColor(m.success_rate)}">${m.success_rate.toFixed(1)}%</b>`
                    : '<b class="muted">—</b>'}
                </span>
                <span class="model-card__stat" title="${m.requests_200 > 0 ? `按最近 ${fmtInt(m.requests_200)} 次调用计算` : '暂无调用记录'}">近 200 次成功率
                  ${m.success_rate_200 >= 0
                    ? `<b style="color:${rateColor(m.success_rate_200)}">${m.success_rate_200.toFixed(1)}%</b>`
                    : '<b class="muted">—</b>'}
                </span>
              </div>
              <div class="flex gap-6">
                <button class="btn btn--sm btn--icon" data-copy="${esc(m.id)}" aria-label="复制模型 ID">${icon('copy', 13)}</button>
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

      const searchEl = filters.querySelector('#plaza-search');
      searchEl.addEventListener('input', debounce(() => {
        plazaState.keyword = searchEl.value;
        renderGrid();
      }, 180));
      filters.querySelectorAll('#plaza-filter button').forEach((b) => {
        b.onclick = () => {
          plazaState.filter = b.dataset.f;
          filters.querySelectorAll('#plaza-filter button').forEach((x) => x.classList.toggle('is-on', x === b));
          renderGrid();
        };
      });
      const sortEl = filters.querySelector('#plaza-sort');
      sortEl.value = plazaState.sort;
      sortEl.onchange = () => {
        plazaState.sort = sortEl.value;
        renderGrid();
      };
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
  // 能力参数三态：支持 / 不支持 / 未设置（未设置时不改写请求，沿用上游行为）
  const capLabel = (v) => (v === true ? '支持' : v === false ? '不支持' : '未设置');
  const capBadge = (v, err) => {
    if (v === true) return badge('支持', 'green');
    if (v === false) return badge(err ? '不支持（报错）' : '不支持', 'red');
    return '<span class="badge badge--gray" title="未设置：请求里不写这个参数，按上游默认处理">未设置</span>';
  };

  function openModelDrawer(m) {
    const isCustom = m.type === 'custom';
    const caps = m.caps || {};
    const prev = document.activeElement;

    const row = (k, v) => `<dt>${esc(k)}</dt><dd>${v}</dd>`;
    const providerHtml = m.provider_name
      ? `<span class="provider-tag">${providerIcon(m.provider_icon, 15)}${esc(m.provider_name)}</span>`
      : '<span class="muted">未设置</span>';
    const statusHtml = (() => {
      if (m.status === 'disabled') return statusBadge(false, '', '已禁用');
      if (m.status === 'custom_content') return badge('始终返回内容', 'green');
      if (m.status === 'channel_disabled') return badge('渠道已禁用', 'red');
      if (m.status === 'channel_missing' || m.status === 'model_missing') return badge('渠道模型不存在', 'red');
      if (m.status === 'not_added') return badge('未接入模型管理', 'red');
      if (m.status === 'ok') return statusBadge(true, '可用');
      return badge('不可用', 'red');
    })();

    // 来源：自定义模型展示路由模型列表，有分组时按组显示（与模型配置页一致）；
    // 渠道模型展示所属渠道。
    const routeStatusBadge = (r) => {
      if (r.status === 'channel_disabled') return badge('渠道已禁用', 'red');
      if (r.status === 'channel_missing' || r.status === 'model_missing') return badge('渠道模型不存在', 'red');
      if (r.status === 'ok') return badge('可用', 'green');
      return r.channel_ready === false ? badge('不可用', 'red') : badge('可用', 'green');
    };
    const routeItemHtml = (r, num, inGroup) => `
      <div class="route-item ${inGroup ? 'is-grouped' : ''}">
        ${num ? `<span class="route-item__idx">${num}</span>` : ''}
        <span class="route-item__name" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.model_id)}</span>
        <span class="route-item__meta">
          ${r.channel_name ? `<span class="muted fs-12" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.channel_name)}</span>` : ''}
          ${routeStatusBadge(r)}
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
      sourceHtml = m.status === 'custom_content'
        ? badge('始终返回内容', 'green')
        : badge('未配置路由目标', 'red');
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
              ${badge(isCustom ? '自定义' : '渠道', isCustom ? 'wood' : 'blue')}
            </div>
          </div>
          <button class="drawer__close" data-close aria-label="关闭">${icon('x', 17)}</button>
        </div>
        <div class="drawer__actions">
          <button class="btn btn--sm" data-act="copy">${icon('copy', 13)}复制模型 ID</button>
          <button class="btn btn--sm btn--primary" data-act="chat" ${m.available ? '' : 'disabled'}>${icon('chat', 13)}去对话</button>
        </div>
        <div class="drawer__body">
          ${m.description ? `<div class="drawer__section"><div class="alert alert--pink">${icon('info', 15)}<div>${esc(m.description)}</div></div></div>` : ''}

          <div class="drawer__section">
            <div class="section-title">基本信息</div>
            <dl class="kv">
              ${row('模型 ID', `<span class="mono">${esc(m.id)}</span>`)}
              ${row('类型', isCustom ? '自定义模型' : '渠道模型')}
              ${row('状态', statusHtml)}
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
              ${row('工具调用', capBadge(caps.tool_calling, caps.tool_calling_error))}
              ${row('思考', capBadge(caps.thinking, caps.thinking_error))}
              ${row('图片输入', capBadge(caps.vision, caps.vision_error))}
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
            <div class="section-title">近 200 次调用</div>
            <dl class="kv">
              ${row('样本数', `<b>${fmtInt(m.requests_200 || 0)}</b> 次`)}
              ${row('失败次数', (m.errors_200 || 0) > 0
                ? `<b style="color:var(--red-500)">${fmtInt(m.errors_200)}</b> 次`
                : '0 次')}
              ${row('成功率', m.success_rate_200 >= 0
                ? `<b style="color:${rateColor(m.success_rate_200)}">${m.success_rate_200.toFixed(1)}%</b>`
                : '<span class="muted">暂无调用记录</span>')}
            </dl>
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

  // 模型管理页复用同一个详情抽屉。
  window.LDM.openModelDrawer = openModelDrawer;

  // ======================================================================
  // 在线聊天
  // ======================================================================
  function rateColor(r) {
    r = Number(r) || 0;
    if (r >= 90) return 'var(--green-500)';
    if (r >= 80) return 'var(--blue-500)';
    if (r >= 70) return 'var(--amber-500)';
    return 'var(--red-500)';
  }

  // 对话状态放在页面外面：切到其它页面时请求继续在后台跑，
  // 回到对话页再把还在进行的流重新挂到新的气泡上。
  const CHAT_KEY = 'ldmapi.chat';                   // 旧版：只有一个数组
  const CHAT_SESSIONS_KEY = 'ldmapi.chat.sessions'; // 现在：多会话
  const CHAT_MODEL_KEY = 'ldmapi.chat.model';
  const chatStore = {
    sessions: [],
    activeId: '',
    loaded: false,
    run: null,
    view: null,
    model: '',
  };
  // 当前会话的消息；切会话时这个引用会跟着换
  Object.defineProperty(chatStore, 'history', {
    get() {
      const s = chatStore.sessions.find((x) => x.id === chatStore.activeId);
      return s ? s.messages : [];
    },
  });
  let chatQuotaWarned = false;

  const chatSessionId = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // 标题取第一条用户消息的前几个字，和 DeepSeek 的习惯一致
  function chatSessionTitle(messages) {
    const first = (messages || []).find((m) => m && m.role === 'user');
    let raw = '';
    if (first) {
      raw = typeof first.content === 'string' ? first.content : '';
      if (!raw && Array.isArray(first.content)) {
        const part = first.content.find((p) => p && p.type === 'text');
        raw = part ? String(part.text || '') : '';
      }
    }
    const t = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    return t.length > 24 ? t.slice(0, 24) + '…' : t;
  }

  function loadChatHistory() {
    try {
      const raw = localStorage.getItem(CHAT_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  // 读取全部会话；旧版只有一份数组，迁移成第一个会话
  function loadChatSessions() {
    let sessions = [];
    let activeId = '';
    try {
      const raw = localStorage.getItem(CHAT_SESSIONS_KEY);
      if (raw) {
        const j = JSON.parse(raw);
        if (j && Array.isArray(j.sessions) && j.sessions.length) {
          sessions = j.sessions
            .filter((s) => s && Array.isArray(s.messages))
            .map((s) => ({
              id: s.id || chatSessionId(),
              title: s.title || chatSessionTitle(s.messages),
              createdAt: s.createdAt || Date.now(),
              updatedAt: s.updatedAt || Date.now(),
              model: s.model || '',
              messages: s.messages,
            }));
          activeId = j.activeId || '';
        }
      }
    } catch (e) { /* 数据损坏就当没有 */ }
    if (!sessions.length) {
      const old = loadChatHistory();
      sessions = [{
        id: chatSessionId(),
        title: chatSessionTitle(old),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: '',
        messages: old,
      }];
    }
    if (!sessions.some((s) => s.id === activeId)) activeId = sessions[0].id;
    return { sessions, activeId };
  }

  function loadChatModel() {
    try {
      return localStorage.getItem(CHAT_MODEL_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function persistChatModel(id) {
    try {
      if (id) localStorage.setItem(CHAT_MODEL_KEY, id);
      else localStorage.removeItem(CHAT_MODEL_KEY);
    } catch (e) { /* 存储不可用时忽略 */ }
  }

  function persistChatSessions() {
    try {
      localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify({
        activeId: chatStore.activeId,
        sessions: chatStore.sessions,
      }));
    } catch (e) {
      // 带图片/附件的对话可能超出 localStorage 配额：内存里继续可用，
      // 只提醒一次，避免每发一条都弹错误
      if (!chatQuotaWarned) {
        chatQuotaWarned = true;
        Toast.error('对话内容过大，无法保存到浏览器本地；刷新后附件可能丢失');
      }
    }
  }

  // 错误条目只用于回看和重试，永远不进入下一次请求的上下文
  function chatContext(list) {
    return (list || [])
      .filter((m) => m && !m.error && m.content != null && m.content !== '')
      .map((m) => ({ role: m.role, content: m.content }));
  }

  // 关标签页/刷新时浏览器会直接掐断请求，把已经生成的部分存下来，回来还能看到
  window.addEventListener('beforeunload', () => {
    const run = chatStore.run;
    if (!run || run.discarded || run.unloadSaved || (!run.answer && !run.think && !run.toolLog.length)) return;
    run.unloadSaved = true;
    const entry = { role: 'assistant', content: run.answer, model: run.sentModel.id, stopped: true };
    const hasParts = run.parts && run.parts.some((p) => p.type === 'tools');
    if (run.think) {
      entry.think = run.think;
      // 没有分段信息时，思考耗时单独存一个数字，刷新后秒数才不会丢
      if (!hasParts) {
        const thinks = run.parts.filter((p) => p && p.type === 'think' && p.text);
        if (thinks.length) {
          entry.think_ms = thinks.reduce((sum, p) => sum + (p.ms != null ? p.ms
            : (p.t0 ? Math.max(0, Date.now() - p.t0) : 0)), 0);
        }
      }
    }
    if (run.toolLog.length) entry.tool_calls = run.toolLog;
    if (hasParts) entry.parts = run.parts;
    entry.meta = [[`模型 ${run.sentModel.id}`], ['页面关闭，已停止生成']];
    if (run.sentModel.provider_icon) entry.provider_icon = run.sentModel.provider_icon;
    chatStore.history.push(entry);
    persistChatSessions();
  });

  window.LDM.registerPage('chat', {
    title: '在线聊天',
    desc: '在线和可用模型聊天',
    async render(root, actions) {
      const all = await State.loadModels(true);
      // 自定义内容返回不依赖路由，即使没有可用渠道也能在在线聊天里选择。
      const usable = all.filter((m) => m.enabled && (m.channel_ready || m.status === 'custom_content'));
      // 「临时测试」不是一个真实模型：选中后直接请求临时填写的上游，
      // 不查渠道和模型配置，后端也不会写调用日志。
      const TEST_MODEL_ID = '__test__';

      // 没有可用模型时也进入页面：临时测试不需要任何渠道或模型配置。
      const preset = window.LDM.routeParam('model') || chatStore.model || loadChatModel();
      const initial = preset === TEST_MODEL_ID
        ? TEST_MODEL_ID
        : (usable.some((m) => m.id === preset) ? preset : (usable.length ? usable[0].id : TEST_MODEL_ID));
      chatStore.model = initial;
      persistChatModel(initial);

      // 顶栏不再放聊天控件：模型下拉、流式开关都下沉到输入框那一行，
      // 对话列表和模型配置各自在左右两侧，收起时往自己那边收。

      // 临时测试的地址与模型记在本地，Key 只放 sessionStorage：
      // 关掉标签页就清掉，避免长期留在浏览器里。
      const TEST_STORE_KEY = 'ldmapi.chat.test';
      const TEST_KEY_STORE = 'ldmapi.chat.test.key';
      const testCfg = { url: '', key: '', model: '' };
      try {
        const saved = JSON.parse(localStorage.getItem(TEST_STORE_KEY) || 'null');
        if (saved && typeof saved === 'object') {
          if (typeof saved.url === 'string') testCfg.url = saved.url;
          if (typeof saved.model === 'string') testCfg.model = saved.model;
        }
        testCfg.key = sessionStorage.getItem(TEST_KEY_STORE) || '';
      } catch (e) { /* 存储不可用时使用空配置 */ }
      const persistTestCfg = () => {
        try {
          localStorage.setItem(TEST_STORE_KEY, JSON.stringify({ url: testCfg.url, model: testCfg.model }));
        } catch (e) { /* 忽略配额错误 */ }
        try {
          if (testCfg.key) sessionStorage.setItem(TEST_KEY_STORE, testCfg.key);
          else sessionStorage.removeItem(TEST_KEY_STORE);
        } catch (e) { /* 忽略配额错误 */ }
      };

      // 采样参数：每一项都能单独开关，关闭后不会出现在请求体里。
      // 默认值与 NewAPI 保持一致，减少迁移时的落差。
      const PARAM_KEY = 'ldmapi.chat.params';
      const paramDefs = [
        { key: 'temperature', label: '温度', min: 0, max: 2, step: 0.1, def: 0.7, on: true },
        { key: 'top_p', label: 'Top P', min: 0, max: 1, step: 0.05, def: 1, on: true },
        { key: 'max_tokens', label: '最大 Token', type: 'number', def: 4096, on: false },
        { key: 'frequency_penalty', label: '频率惩罚', min: -2, max: 2, step: 0.1, def: 0, on: true },
        { key: 'presence_penalty', label: '存在惩罚', min: -2, max: 2, step: 0.1, def: 0, on: true },
        { key: 'seed', label: '种子', type: 'number', def: '', on: false },
      ];
      const paramValues = {};
      const paramEnabled = {};
      paramDefs.forEach((p) => {
        paramValues[p.key] = p.def;
        paramEnabled[p.key] = p.on;
      });
      try {
        const saved = JSON.parse(localStorage.getItem(PARAM_KEY) || 'null');
        if (saved && typeof saved === 'object') {
          paramDefs.forEach((p) => {
            if (saved.values && saved.values[p.key] !== undefined && saved.values[p.key] !== null) {
              paramValues[p.key] = saved.values[p.key];
            }
            if (saved.enabled && typeof saved.enabled[p.key] === 'boolean') {
              paramEnabled[p.key] = saved.enabled[p.key];
            }
          });
        }
      } catch (e) { /* 存储不可用时使用默认值 */ }

      const paramRowHtml = (p) => {
        const value = paramValues[p.key];
        const shown = String(value === '' ? '—' : value);
        const control = p.type === 'number'
          ? `<input class="input input--sm chat-param__num" id="chat-param-${p.key}" type="number" min="0" step="1" value="${esc(String(value))}" placeholder="${p.key === 'seed' ? '留空则随机' : '不限制'}">`
          : `<input class="chat-range" id="chat-param-${p.key}" type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${esc(String(value))}">`;
        return `<div class="chat-param" data-param="${p.key}">
          <div class="chat-param__head">
            <span class="chat-param__label">${p.label}</span>
            <span class="chat-param__value" id="chat-param-${p.key}-value">${esc(shown)}</span>
            <div class="toolbar__spacer"></div>
            ${switchEl(paramEnabled[p.key], '', `id="chat-param-${p.key}-enable" title="开启后发送 ${p.key} 参数"`)}
          </div>
          ${control}
        </div>`;
      };

      root.classList.add('content__inner--fill');
      root.innerHTML = `
        <div class="card chat-card" id="chat-card">
          <!-- 顶栏把手：桌面端只当定位容器（把手各自贴左上 / 右上角），
               手机端整条搬进顶栏木牌右端，排成一行「> < +」 -->
          <div class="chat-bar" id="chat-bar">
            <div class="chat-bar__pair">
              <!-- 侧栏收起后贴边留一个把手，方便再拉出来 -->
              <button class="chat-edge chat-edge--left" id="chat-conv-open" type="button" title="展开对话列表" aria-label="展开对话列表" hidden>${icon('chevronRight', 16)}</button>
              <button class="chat-edge chat-edge--right" id="chat-side-open" type="button" title="展开模型配置" aria-label="展开模型配置" hidden>${icon('chevronLeft', 16)}</button>
            </div>
            <!-- 新建对话：桌面上跟着「展开对话列表」的把手走，排在它右边 -->
            <button class="chat-edge chat-edge--new" id="chat-conv-edge-new" type="button" title="新建对话" aria-label="新建对话" hidden>${icon('plus', 15)}</button>
            <!-- 配置栏收起时，垃圾桶陪在展开把手下面：面板展开时底部本来就有清空按钮；
                 手机端整块不出现，清空入口只留配置栏底部那一个 -->
            <button class="chat-edge chat-edge--sideclear" id="chat-side-edge-clear" type="button" title="清空当前对话" aria-label="清空当前对话" hidden>${icon('trash', 14)}</button>
          </div>
          <div class="chat-layout" id="chat-layout">
            <div class="chat-side-scrim" id="chat-side-scrim"></div>
            <div class="chat-conv-scrim" id="chat-conv-scrim"></div>

            <!-- 左侧：对话列表（往左收） -->
            <aside class="chat-conv" id="chat-conv">
              <div class="chat-conv__head">
                <button class="chat-conv__new" id="chat-conv-new" type="button">${icon('plus', 14)}开启新对话</button>
                <!-- 多选模式下顶替「开启新对话」的位置：已选计数 + 批量删除；退出走第二行多选键的原位 ✕ -->
                <div class="chat-conv__mbar" id="chat-conv-mbar" hidden>
                  <span class="chat-conv__mcount" id="chat-conv-mcount">已选 0 个</span>
                  <button class="btn btn--ghost btn--icon btn--sm" id="chat-conv-del-sel" type="button" title="删除所选对话" aria-label="删除所选对话">${icon('trash', 13)}</button>
                </div>
                <button class="btn btn--ghost btn--icon btn--sm chat-conv__collapse" id="chat-conv-collapse" title="收起对话列表" aria-label="收起对话列表">${icon('chevronLeft', 15)}</button>
              </div>
              <div class="chat-conv__tools">
                <div class="search chat-conv__search">
                  <span class="search__icon">${icon('search', 13)}</span>
                  <input class="input input--sm" id="chat-conv-search" placeholder="搜索对话…" autocomplete="off" spellcheck="false" aria-label="搜索对话">
                </div>
                <button class="btn btn--ghost btn--icon btn--sm chat-conv__multi" id="chat-conv-multi" type="button" title="多选对话" aria-label="多选对话">${icon('check', 14)}</button>
              </div>
              <div class="chat-conv__body">
                <!-- 内层单独一层，会话少的时候靠 margin:auto 垂直居中，多了照常滚动 -->
                <div class="chat-conv__inner" id="chat-conv-list"></div>
              </div>
            </aside>

            <!-- 右侧：模型配置（往右收） -->
            <aside class="chat-side" id="chat-side">
              <div class="chat-side__head">
                ${icon('settings', 15)}
                <span class="chat-side__title">模型配置</span>
                <button class="btn btn--ghost btn--icon btn--sm chat-side__close" id="chat-side-close" title="收起设置" aria-label="收起设置">${icon('chevronRight', 15)}</button>
              </div>
              <div class="chat-side__body">
                <div class="chat-field chat-custom-toggle">
                  <div class="chat-switch-row">
                    <span class="chat-switch-row__label">自定义请求体</span>
                    ${switchEl(false, '', 'id="chat-custom-switch" title="开启后直接发送下方编辑的 JSON"')}
                  </div>
                </div>
                <div class="chat-fields" id="chat-normal-fields">
                  <div class="chat-field">
                    <label class="chat-field__label" for="chat-model">模型</label>
                    <select class="select" id="chat-model">
                      ${usable.map((m) => `<option value="${esc(m.id)}"${m.id === initial ? ' selected' : ''}>${esc(m.id)}</option>`).join('')}
                      <option value="${TEST_MODEL_ID}"${initial === TEST_MODEL_ID ? ' selected' : ''}>临时测试（直连上游）</option>
                    </select>
                    <div class="chat-model-meta" id="chat-model-meta">
                      <span class="badge badge--wood" id="chat-kind"></span>
                      <span class="chat-route-row">
                        <span class="muted fs-12 chat-route-text" id="chat-route"></span>
                        <button class="btn btn--ghost btn--icon btn--sm chat-route-toggle" id="chat-route-toggle" title="展开" aria-label="展开" aria-expanded="false" hidden>${icon('chevron', 12)}</button>
                      </span>
                    </div>
                  </div>
                  <div class="chat-field chat-test" id="chat-test-panel" hidden>
                    <div class="chat-field__head">
                      <div class="chat-field__label">临时测试</div>
                      <span class="badge badge--green">不记录日志</span>
                    </div>
                    <input class="input input--sm" id="chat-test-url" value="${esc(testCfg.url)}" placeholder="API 地址，例如 https://api.openai.com/v1" autocomplete="off" spellcheck="false">
                    <div class="chat-test__key">
                      <input class="input input--sm mono key-field key-masked" id="chat-test-key" value="${esc(testCfg.key)}" placeholder="API Key（本地模型可留空）" autocomplete="off" spellcheck="false" name="ldm-upstream-credential" data-1p-ignore data-lpignore="true">
                      <button class="btn btn--ghost btn--icon btn--sm" id="chat-test-eye" type="button" title="显示 Key">${icon('eye', 13)}</button>
                    </div>
                    <div class="chat-test__row">
                      <button class="btn btn--sm" id="chat-test-fetch" type="button">${icon('refresh', 12)}获取模型</button>
                      <span class="muted fs-12 chat-test__status" id="chat-test-status"></span>
                    </div>
                    <div class="chat-test__model" id="chat-test-model-row">
                      <input class="input input--sm" id="chat-test-model" value="${esc(testCfg.model)}" placeholder="模型 ID，可手动填写" autocomplete="off" spellcheck="false">
                      <select class="select" id="chat-test-model-select" data-anchor="#chat-test-model-row" aria-label="从上游返回的模型里选一个" hidden></select>
                    </div>
                    <div class="muted fs-12" id="chat-test-hint">临时直连上游（OpenAI 兼容），不经过渠道和模型配置，也不写入调用日志。地址与模型保存在本机，Key 只在当前标签页有效。</div>
                  </div>
                  <div class="chat-field">
                    <div class="chat-field__label">生成</div>
                    <div class="chat-switch-row">
                      <span class="chat-switch-row__label">流式输出</span>
                      ${switchEl(true, '', 'id="chat-stream" title="关闭后等完整回复再一次性显示"')}
                    </div>
                    <div class="chat-switch-row">
                      <span class="chat-switch-row__label">工具调用</span>
                      ${switchEl(false, '', 'id="chat-tools" title="开启后向模型提供获取当前时间的工具，用于测试工具调用"')}
                    </div>
                    <div class="muted fs-12">提供 get_current_time 工具</div>
                  </div>
                  <div class="chat-field">
                    <div class="chat-field__head">
                      <div class="chat-field__label">参数</div>
                      <button class="btn btn--ghost btn--sm chat-field__reset" id="chat-params-reset" title="恢复默认参数">${icon('refresh', 12)}重置</button>
                    </div>
                    <div class="chat-params">
                      ${paramDefs.map(paramRowHtml).join('')}
                    </div>
                  </div>
                </div>
                <div class="chat-custom" id="chat-custom" hidden>
                  <div class="chat-custom__head">
                    <span class="chat-custom__title">请求体 JSON</span>
                    <div class="toolbar__spacer"></div>
                    <button class="btn btn--sm" id="chat-custom-format">格式化</button>
                    <button class="btn btn--sm" id="chat-custom-reset">重置</button>
                  </div>
                  <div class="muted fs-12">发送时使用下方 JSON 原文；模型与流式以 JSON 为准，输入框的图片/附件不会自动加入</div>
                  <textarea class="textarea chat-custom__body" id="chat-custom-body" spellcheck="false" placeholder='{"model":"...","messages":[...],"stream":true}'></textarea>
                  <div class="chat-custom__hint muted fs-12" id="chat-custom-hint"></div>
                </div>
              </div>
              <div class="chat-side__foot">
                <button class="btn btn--sm btn--block" id="chat-clear">${icon('trash', 13)}清空对话</button>
              </div>
            </aside>

            <!-- 中间：对话区 -->
            <div class="chat-main" id="chat-main">
              <div class="chat-log-wrap">
                <div class="chat-log" id="chat-log"></div>
                <button class="chat-to-bottom" id="chat-to-bottom" type="button" title="回到底部" aria-label="回到底部" hidden>${icon('down', 18)}</button>
              </div>
              <div class="chat-compose">
                <div class="chat-attachments" id="chat-attachments"></div>
                <!-- 空会话时的问候语，浮在输入框上方 -->
                <div class="chat-hello" id="chat-hello">你好，有什么我可以帮你的？</div>
                <div class="chat-input">
                  <textarea class="textarea chat-input__text" id="chat-text" rows="1" placeholder="快使用我吧♡"></textarea>
                  <div class="chat-input__bar">
                    <div class="chat-input__chips">
                      <select class="chat-chip chat-chip--model" id="chat-chip-model" aria-label="模型">
                        ${usable.map((m) => `<option value="${esc(m.id)}"${m.id === initial ? ' selected' : ''}>${esc(m.id)}</option>`).join('')}
                        <option value="${TEST_MODEL_ID}"${initial === TEST_MODEL_ID ? ' selected' : ''}>临时测试（直连上游）</option>
                      </select>
                      <!-- 自定义请求体模式下顶替模型下拉的提示芯片，点击打开右侧配置栏 -->
                      <button class="chat-chip chat-chip--custom" id="chat-chip-custom" type="button" title="已开启自定义请求体模式：模型与流式由请求体 JSON 决定，点这里打开配置栏" hidden>已开启自定义请求体</button>
                      ${switchEl(true, '流式', 'id="chat-chip-stream" title="关闭后等完整回复再一次性显示"')}
                    </div>
                    <div class="chat-input__acts">
                      <button class="btn btn--ghost btn--icon" id="chat-pick-image" title="添加图片">${icon('image', 16)}</button>
                      <button class="btn btn--ghost btn--icon" id="chat-pick-file" title="添加附件">${icon('paperclip', 16)}</button>
                      <button class="btn btn--primary btn--icon" id="chat-send" title="发送">${icon('send', 15)}</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <input type="file" id="chat-image-input" accept="image/*" multiple hidden>
          <input type="file" id="chat-file-input" multiple hidden>
        </div>`;

      const card = root.querySelector('#chat-card');
      const layout = root.querySelector('#chat-layout');
      // 顶栏那排把手：桌面上挂在卡片里当定位容器，手机上整条搬进顶栏木牌
      const chatBar = root.querySelector('#chat-bar');
      const topbarActions = document.getElementById('topbar-actions');
      // 左侧对话列表
      const convList = root.querySelector('#chat-conv-list');
      const convNew = root.querySelector('#chat-conv-new');
      const convCollapse = root.querySelector('#chat-conv-collapse');
      const convOpen = root.querySelector('#chat-conv-open');
      const convEdgeNew = root.querySelector('#chat-conv-edge-new');
      const convScrim = root.querySelector('#chat-conv-scrim');
      const convAside = root.querySelector('#chat-conv');
      const convSearchInput = root.querySelector('#chat-conv-search');
      const convMultiBtn = root.querySelector('#chat-conv-multi');
      const convMBar = root.querySelector('#chat-conv-mbar');
      const convMCount = root.querySelector('#chat-conv-mcount');
      const convDelSel = root.querySelector('#chat-conv-del-sel');
      // 右侧模型配置
      const sideClose = root.querySelector('#chat-side-close');
      const sideOpen = root.querySelector('#chat-side-open');
      const sideEdgeClear = root.querySelector('#chat-side-edge-clear');
      const sideScrim = root.querySelector('#chat-side-scrim');
      // 模型下拉和流式开关在输入框里有一份，配置栏里也有一份，两边同步
      const chipModelSel = root.querySelector('#chat-chip-model');
      const modelSel = root.querySelector('#chat-model');
      const kindEl = root.querySelector('#chat-kind');
      const modelMeta = root.querySelector('.chat-model-meta');
      const testPanel = root.querySelector('#chat-test-panel');
      const testUrlInput = root.querySelector('#chat-test-url');
      const testKeyInput = root.querySelector('#chat-test-key');
      const testModelInput = root.querySelector('#chat-test-model');
      const testModelSelect = root.querySelector('#chat-test-model-select');
      const testFetchBtn = root.querySelector('#chat-test-fetch');
      const testStatus = root.querySelector('#chat-test-status');
      const testHint = root.querySelector('#chat-test-hint');
      const testEye = root.querySelector('#chat-test-eye');
      const routeEl = root.querySelector('#chat-route');
      const routeToggle = root.querySelector('#chat-route-toggle');
      const log = root.querySelector('#chat-log');
      const hello = root.querySelector('#chat-hello');
      const chatMain = root.querySelector('#chat-main');
      const text = root.querySelector('#chat-text');
      // 触摸屏上用软键盘，回车当换行用，发送只能点按钮
      if (isCoarsePointer) text.placeholder = '快使用我吧♡';
      // 触摸设备上程序化聚焦会弹出虚拟键盘，切模型 / 改开关后不应打断输入
      const focusText = () => { if (!isCoarsePointer) text.focus(); };
      const sendBtn = root.querySelector('#chat-send');
      const streamToggle = root.querySelector('#chat-stream');
      const streamInput = streamToggle.querySelector('input');
      const chipStream = root.querySelector('#chat-chip-stream');
      const chipStreamInput = chipStream.querySelector('input');
      const toolsSwitch = root.querySelector('#chat-tools');
      const toolsInput = toolsSwitch.querySelector('input');
      const customSwitch = root.querySelector('#chat-custom-switch');
      const customSwitchInput = customSwitch.querySelector('input');
      const customPanel = root.querySelector('#chat-custom');
      const normalFields = root.querySelector('#chat-normal-fields');
      const customEditor = root.querySelector('#chat-custom-body');
      const customHint = root.querySelector('#chat-custom-hint');
      const paramsReset = root.querySelector('#chat-params-reset');
      const attWrap = root.querySelector('#chat-attachments');
      const imageInput = root.querySelector('#chat-image-input');
      const fileInput = root.querySelector('#chat-file-input');
      const pickImage = root.querySelector('#chat-pick-image');
      const pickFile = root.querySelector('#chat-pick-file');
      const toBottomBtn = root.querySelector('#chat-to-bottom');
      // 输入框芯片容器；自定义请求体模式下模型/流式芯片会换成模式提示
      const chipsEl = root.querySelector('.chat-input__chips');
      const chipCustomHint = root.querySelector('#chat-chip-custom');

      // ---------- 自动滚动（贴底跟随） ----------
      // 流式输出每来一段就强制滚到底部的话，用户一旦往上翻看历史就会被拽回去。
      // 这里改成「贴底跟随」：离底部超过阈值就暂停自动滚动，用户自己回到底部才恢复。
      const BOTTOM_GAP = 32;   // 距底部 32px 以内仍视为「贴着底部」
      const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight <= BOTTOM_GAP;
      let followBottom = true;
      // 批量重画消息（切会话）期间先别逐条拉到底：每拉一次都会强制同步布局，
      // 几十条叠起来就是 O(n²)，最后统一拉一次就行
      let bulkPainting = false;
      const syncToBottomBtn = () => {
        if (!toBottomBtn || toBottomBtn.hidden === followBottom) return;
        toBottomBtn.hidden = followBottom;
      };
      const scrollToBottom = (force) => {
        if (force) followBottom = true;
        if (!followBottom) return;
        log.scrollTop = log.scrollHeight;
        syncToBottomBtn();
      };
      log.addEventListener('scroll', () => {
        followBottom = nearBottom();
        syncToBottomBtn();
        // 滑到顶附近就把更早的一批补上（补完会把 scrollTop 抬回去，画面不动）
        if (log.scrollTop < 120) loadOlder();
      });
      if (toBottomBtn) {
        // 点「回到底部」：立刻贴底并恢复自动跟随
        toBottomBtn.onclick = () => scrollToBottom(true);
      }

      // 用户消息头像用站点图标；模型回复头像用该模型所属提供商的图标。
      const siteLogo = ((State.settings && State.settings.logo) || 'assets/logo.jpg').trim() || 'assets/logo.jpg';
      // 图片类图标（直链 / data URI）自己就带底色，不用再垫白底板
      const isImageIcon = (key) => /^(https?:\/\/|data:image\/)/i.test(key || '');
      const avatarHtml = (role, providerIconKey) => {
        if (role === 'user') {
          return `<div class="msg__avatar msg__avatar--logo"><img src="${esc(siteLogo)}" alt=""></div>`;
        }
        if (providerIconKey) {
          if (isImageIcon(providerIconKey)) {
            // 26px = 30px 方框去掉左右各 2px 描边，图片正好铺满内容区，形状跟用户头像一致
            return `<div class="msg__avatar msg__avatar--provider msg__avatar--image">${providerIcon(providerIconKey, 26)}</div>`;
          }
          return `<div class="msg__avatar msg__avatar--provider">${providerIcon(providerIconKey, 16)}</div>`;
        }
        return '<div class="msg__avatar">🐱</div>';
      };

      // 会话数据存在页面外的 chatStore 里，切页面和后台请求共用。
      // history 指向当前会话的消息数组；切会话时重新指向并重画消息区。
      let history = chatStore.history;
      if (!chatStore.loaded) {
        chatStore.loaded = true;
        const st = loadChatSessions();
        chatStore.sessions = st.sessions;
        chatStore.activeId = st.activeId;
        history = chatStore.history;
      }
      let sending = false;
      // 暂存的图片/附件，发送后清空
      let staged = [];

      // 流式输出与自定义请求体开关记在本地
      const STREAM_KEY = 'ldmapi.chat.stream';
      const CUSTOM_KEY = 'ldmapi.chat.custom';
      let streaming = true;
      try { streaming = localStorage.getItem(STREAM_KEY) !== '0'; } catch (e) { /* 存储不可用时默认开启 */ }
      let customMode = false;
      try { customMode = localStorage.getItem(CUSTOM_KEY) === '1'; } catch (e) { /* 存储不可用 */ }
      // 流式开关在配置栏和输入框芯片里各有一个，始终同步
      const setStreaming = (on) => {
        streaming = on;
        streamInput.checked = on;
        chipStreamInput.checked = on;
        try { localStorage.setItem(STREAM_KEY, on ? '1' : '0'); } catch (e) { /* 忽略配额错误 */ }
      };
      setStreaming(streaming);
      streamInput.onchange = () => {
        setStreaming(streamInput.checked);
        focusText();
      };
      chipStreamInput.onchange = () => {
        setStreaming(chipStreamInput.checked);
        focusText();
      };

      // 工具调用开关：开启后每次请求都带上获取当前时间的测试工具
      const TOOLS_KEY = 'ldmapi.chat.tools';
      let toolsOn = false;
      try { toolsOn = localStorage.getItem(TOOLS_KEY) === '1'; } catch (e) { /* 存储不可用 */ }
      const setTools = (on) => {
        toolsOn = on;
        toolsInput.checked = on;
        try { localStorage.setItem(TOOLS_KEY, on ? '1' : '0'); } catch (e) { /* 忽略配额错误 */ }
      };
      setTools(toolsOn);
      toolsInput.onchange = () => {
        setTools(toolsInput.checked);
        focusText();
      };

      // ---------- 气泡里的 Markdown ----------
      // 解析交给 assets/markdown.js（marked + DOMPurify + KaTeX，随二进制分发），
      // 这里只管「渲染 / 原文」的状态与节流重绘。
      const mdReady = !!(window.LDMMD && typeof window.LDMMD.render === 'function');

      // 正文段统一从这里出：默认渲染 Markdown，el._md 为 false 时显示原文。
      // 流式输出会反复重画同一段，按 80ms 节流，避免每个 token 都重排一次版。
      const paintText = (el, value, force) => {
        if (!el) return;
        el._raw = value == null ? '' : String(value);
        if (el._md == null) el._md = true;
        if (!el._md || !mdReady) {
          el.classList.remove('msg__answer--md');
          el.textContent = el._raw;
          return;
        }
        el.classList.add('msg__answer--md');
        const draw = () => {
          el._mdAt = Date.now();
          el.innerHTML = window.LDMMD.render(el._raw);
          // 重画会让段落变高，贴底跟随时再拉一次底部，免得视图停在半截
          if (followBottom && !bulkPainting) log.scrollTop = log.scrollHeight;
        };
        if (force || Date.now() - (el._mdAt || 0) >= 80) {
          if (el._mdTimer) {
            clearTimeout(el._mdTimer);
            el._mdTimer = null;
          }
          draw();
          return;
        }
        if (!el._mdTimer) {
          el._mdTimer = setTimeout(() => {
            el._mdTimer = null;
            // 元素已经被移除（切页或清空对话）就不用再画了
            if (el.isConnected) draw();
          }, 80);
        }
      };

      // 切换按钮与旁边的重试 / 复制 / 删除同款样式：只看图标不看文字，
      // 渲染着的时候显示代码图标（看原文），原文时显示眼睛图标（看渲染）
      const syncMdBtn = (body) => {
        const btn = body && body.querySelector('[data-md-toggle]');
        if (!btn) return;
        const el = body.querySelector('.msg__answer');
        const on = !!(el && el._md);
        const title = on ? '查看 Markdown 原文' : '查看渲染后的显示';
        btn.innerHTML = icon(on ? 'code' : 'eye', 12);
        btn.title = title;
        btn.setAttribute('aria-label', title);
      };

      // 单个气泡切换：渲染后的显示 ↔ Markdown 原文
      const setBubbleMd = (body, on) => {
        if (!body) return;
        body.querySelectorAll('.msg__answer').forEach((el) => {
          el._md = on;
          if (el._mdTimer) {
            clearTimeout(el._mdTimer);
            el._mdTimer = null;
          }
          paintText(el, el._raw || '', true);
        });
        syncMdBtn(body);
      };

      // 渲染后的代码块带「复制」按钮，事件代理挂在对话列表上
      log.addEventListener('click', (e) => {
        const btn = e.target.closest && e.target.closest('[data-md-copy]');
        if (!btn) return;
        const box = btn.closest('.md-code');
        const code = box && box.querySelector('code');
        if (code) copyText(code.textContent, '代码');
      });

      // 点气泡里的图片看大图：预览被缩到 320px，灯箱里再看原图。
      // 渲染是整段 innerHTML 重画，所以事件得代理在 log 上，不能绑到 img 本身。
      const lb = document.createElement('div');
      lb.className = 'img-lightbox';
      lb.innerHTML = '<img alt="">';
      // 页面来回切会重复创建，先清掉上一次的，避免灯箱叠在 body 上
      document.querySelectorAll('.img-lightbox').forEach((el) => el.remove());
      const closeLb = () => {
        lb.classList.remove('is-open');
      };
      lb.addEventListener('click', closeLb);
      // body 本身就是 overflow:hidden，真正滚的是消息列表；滚轮落在灯箱上时别穿透过去
      lb.addEventListener('wheel', (e) => {
        if (lb.classList.contains('is-open')) e.preventDefault();
      }, { passive: false });
      document.body.appendChild(lb);
      const lbImg = lb.querySelector('img');
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeLb();
      });
      log.addEventListener('click', (e) => {
        // 正文里的图（含包在链接里的 [![](src)](href)）和自己消息的附件图都走灯箱，
        // 点图看大图而不是跳走 / 开新标签页。
        const img = e.target.closest && e.target.closest('.msg__answer--md img, .msg__image');
        if (!img || !img.src) return;
        e.preventDefault();
        lbImg.src = img.src;
        lb.classList.add('is-open');
      });

      const paramEls = paramDefs.map((p) => ({
        def: p,
        input: root.querySelector('#chat-param-' + p.key),
        enable: root.querySelector('#chat-param-' + p.key + '-enable'),
        value: root.querySelector('#chat-param-' + p.key + '-value'),
      }));

      const persistParams = () => {
        try {
          localStorage.setItem(PARAM_KEY, JSON.stringify({ values: paramValues, enabled: paramEnabled }));
        } catch (e) { /* 忽略配额错误 */ }
      };

      // 只收集开启且填了值的参数，关闭的参数不进入请求体
      const collectParams = () => {
        const out = {};
        paramEls.forEach((row) => {
          const key = row.def.key;
          if (!paramEnabled[key]) return;
          const raw = String(row.input.value).trim();
          if (raw === '') return;
          const num = Number(raw);
          if (!Number.isFinite(num)) return;
          out[key] = num;
        });
        return out;
      };

      // 关闭的参数置灰；发送中或自定义请求体模式下整组禁用
      const syncParamRow = (row) => {
        const on = paramEnabled[row.def.key];
        const locked = sending || customMode;
        const checkbox = row.enable.querySelector('input');
        checkbox.checked = on;
        checkbox.disabled = locked;
        row.enable.classList.toggle('is-disabled', locked);
        row.input.disabled = !on || locked;
        row.input.closest('.chat-param').classList.toggle('is-off', !on || customMode);
        const raw = String(row.input.value).trim();
        row.value.textContent = raw === '' ? '—' : raw;
      };
      const syncAllParams = () => paramEls.forEach(syncParamRow);

      // 桌面端可以收起左右两侧；窄屏下改成抽屉开合
      const SIDE_KEY = 'ldmapi.chat.sidebar';
      const CONV_KEY = 'ldmapi.chat.conv';
      try {
        if (localStorage.getItem(SIDE_KEY) === '0') layout.classList.add('is-settings-collapsed');
        if (localStorage.getItem(CONV_KEY) === '0') layout.classList.add('is-conv-collapsed');
      } catch (e) { /* 存储不可用时保持展开 */ }

      const isTestMode = () => modelSel.value === TEST_MODEL_ID;
      const testModelID = () => (testModelInput.value || testCfg.model || '').trim();
      // 发送时直接读输入框，避免用户粘贴后立刻点发送时拿到旧值
      const testParams = () => (isTestMode() ? {
        base_url: testUrlInput.value.trim(),
        api_key: testKeyInput.value.trim(),
      } : {});
      const ensureTestReady = () => {
        if (!isTestMode()) return true;
        if (!testUrlInput.value.trim()) {
          Toast.error('请填写临时测试的 API 地址');
          testUrlInput.focus();
          return false;
        }
        return true;
      };
      const ensureTestModel = () => {
        if (isTestMode() && !testModelID()) {
          Toast.error('请填写临时测试的模型 ID');
          testModelInput.focus();
          return false;
        }
        return true;
      };

      const currentModel = () => {
        if (isTestMode()) {
          return {
            id: testModelID() || '（未填写模型）',
            provider_icon: '', type: 'test', channel_id: '', channel_name: '',
          };
        }
        return usable.find((m) => m.id === modelSel.value) || usable[0] || { id: '', provider_icon: '', type: '' };
      };

      let routeExpanded = false;
      const setRouteExpanded = (on) => {
        routeExpanded = on;
        routeEl.classList.toggle('is-expanded', on);
        routeToggle.classList.toggle('is-expanded', on);
        modelMeta.classList.toggle('is-route-open', on);
        routeToggle.title = on ? '收起' : '展开';
        routeToggle.setAttribute('aria-label', on ? '收起' : '展开');
        routeToggle.setAttribute('aria-expanded', on ? 'true' : 'false');
        if (!on) requestAnimationFrame(syncRouteToggle);
      };

      // 路由一行显示不下时才出现展开按钮；展开状态下不重新测量
      const syncRouteToggle = () => {
        if (!routeEl.isConnected || routeExpanded) return;
        routeToggle.hidden = routeEl.scrollWidth <= routeEl.clientWidth + 1;
      };

      // 侧栏宽度变化或首次布局完成时都会触发，避免在页面还没排版时测错
      const routeObserver = typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(syncRouteToggle)
        : null;
      if (routeObserver) routeObserver.observe(routeEl);

      const setRouteText = (text) => {
        setRouteExpanded(false);
        routeEl.textContent = text;
        routeToggle.hidden = true;
        syncRouteToggle();
        requestAnimationFrame(syncRouteToggle);
      };

      // 空对话区的提示语：模型已经可用就提示「发条消息开始」，
      // 还得先选模型（临时测试没填地址 / 模型）时才提示「选好模型」
      const syncEmptyHint = () => {
        const ready = isTestMode()
          ? !!(testUrlInput.value.trim() && testModelID())
          : usable.some((m) => m.id === modelSel.value);
        log.classList.toggle('is-ready', ready);
        // 空会话时把输入区整块居中，并换一句问候
        const empty = history.length === 0 && log.childElementCount === 0;
        if (chatMain) chatMain.classList.toggle('is-empty', empty);
        if (hello) {
          hello.textContent = ready ? '你好，有什么我可以帮你的？' : '先在右边选个模型，就可以开始聊天啦';
        }
      };

      const refreshMeta = () => {
        syncEmptyHint();
        const test = isTestMode();
        testPanel.hidden = !test;
        modelMeta.hidden = test;
        if (test) {
          chipModelSel.value = TEST_MODEL_ID;
          testHint.textContent = usable.length
            ? '临时直连上游（OpenAI 兼容），不经过渠道和模型配置，也不写入调用日志。地址与模型保存在本机，Key 只在当前标签页有效。'
            : '当前没有可用的渠道模型，已切换到临时测试（OpenAI 兼容）。地址与模型保存在本机，Key 只在当前标签页有效，不写入调用日志。';
          return;
        }
        const m = currentModel();
        const isCustom = m.type === 'custom';
        kindEl.textContent = isCustom ? '自定义模型' : '渠道模型';
        if (isCustom) {
          const routes = (m.routes || []).map((r) => r.model_id);
          setRouteText('路由：' + (routes.length ? routes.join(' → ') : '未配置'));
        } else {
          setRouteText('来源：' + (m.channel_id || '') + (m.channel_name ? '（' + m.channel_name + '）' : ''));
        }
        chipModelSel.value = m.id;
      };

      routeToggle.onclick = () => setRouteExpanded(!routeExpanded);

      // ---------- 内容渲染 ----------

      const fmtBytes = (n) => {
        n = Number(n) || 0;
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / (1024 * 1024)).toFixed(1) + ' MB';
      };

      // 思考与工具耗时统一按秒显示：不足 1 秒保留两位，10 秒以上取整
      const fmtSeconds = (ms) => {
        const s = Math.max(0, Number(ms) || 0) / 1000;
        if (s < 1) return `${s.toFixed(2)} 秒`;
        if (s < 10) return `${s.toFixed(1)} 秒`;
        return `${Math.round(s)} 秒`;
      };

      // 上游返回的图片 / 附件地址可能被恶意渠道投毒（javascript: 等），
      // 只允许这三种协议进入 href / src；与下载按钮的白名单保持一致。
      const safeUrl = (u) => {
        if (typeof u !== 'string' || !u) return '';
        if (u.startsWith('data:') || u.startsWith('blob:') || /^https?:\/\//i.test(u)) return u;
        return '';
      };

      const appendImage = (box, url) => {
        const src = safeUrl(url);
        if (!src) {
          // 协议不在白名单内的地址不做成链接，退化为纯文本展示
          if (url) {
            const tip = document.createElement('div');
            tip.className = 'muted fs-12';
            tip.textContent = String(url);
            box.appendChild(tip);
          }
          return;
        }
        // 不再包 <a target="_blank">：data: 协议的整张原图塞进新标签页，
        // 手机上直接把浏览器拖崩。统一交给灯箱看大图。
        const img = document.createElement('img');
        img.className = 'msg__image';
        img.src = src;
        img.alt = '图片';
        img.setAttribute('aria-label', '点击查看大图');
        img.loading = 'lazy';
        box.appendChild(img);
      };

      // 精确判断文本 MIME。不能用 contains('xml')：docx 的
      // application/vnd.openxmlformats-... 里就带 xml，会被误判成文本。
      const isTextMime = (mime) => {
        const m = (mime || '').toLowerCase();
        return m.startsWith('text/')
          || m === 'application/json'
          || m === 'application/xml'
          || m === 'application/x-yaml'
          || m === 'application/yaml'
          || m === 'application/javascript'
          || m === 'application/x-javascript'
          || m === 'application/x-sh'
          || m === 'application/x-python'
          || m === 'application/x-httpd-php'
          || m.endsWith('+json')
          || m.endsWith('+xml');
      };

      // 附件统一显示成一张卡片；点击打开右侧抽屉预览。
      const attachmentKind = (att) => {
        if (att.kind === 'image') return 'image';
        if (att.kind === 'text' || att.text != null) return 'text';
        const mime = (att.mime || '').toLowerCase();
        if (mime === 'application/pdf' || /\.pdf$/i.test(att.name || '')) return 'pdf';
        if (mime.startsWith('image/')) return 'image';
        if (BINARY_EXT.test(att.name || '')) return 'other';
        if (att.kind === 'file') return isTextMime(mime) ? 'text' : 'other';
        if (isTextMime(mime) || TEXT_EXT.test(att.name || '')) return 'text';
        return 'other';
      };

      const attachmentLabel = (kind) => (
        kind === 'text' ? '文本' : kind === 'image' ? '图片' : kind === 'pdf' ? 'PDF' : '二进制'
      );

      const dataUrlToBlob = (data) => {
        if (typeof data !== 'string' || !data.startsWith('data:')) return null;
        const comma = data.indexOf(',');
        if (comma < 0) return null;
        const meta = data.slice(5, comma);
        const payload = data.slice(comma + 1);
        const mime = meta.split(';')[0] || 'application/octet-stream';
        try {
          if (/;base64/i.test(meta)) {
            const bin = atob(payload);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return new Blob([bytes], { type: mime });
          }
          return new Blob([decodeURIComponent(payload)], { type: mime });
        } catch (e) {
          return null;
        }
      };

      // 把 data URL 里的文本解码出来，供抽屉预览（自定义请求体里可能直接带文件）
      const dataUrlText = (data) => {
        if (typeof data !== 'string' || !data.startsWith('data:')) return '';
        const comma = data.indexOf(',');
        if (comma < 0) return '';
        const meta = data.slice(5, comma);
        const payload = data.slice(comma + 1);
        try {
          if (/;base64/i.test(meta)) {
            const bin = atob(payload);
            const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
            return new TextDecoder().decode(bytes);
          }
          return decodeURIComponent(payload);
        } catch (e) {
          return '';
        }
      };

      const openAttachmentDrawer = (att) => {
        const name = att.name || '附件';
        const mime = att.mime || '';
        const kind = attachmentKind(att);
        const sizeText = att.size ? fmtBytes(att.size) : '—';
        const prev = document.activeElement;

        const backdrop = document.createElement('div');
        backdrop.className = 'drawer-backdrop';
        backdrop.innerHTML = `
          <aside class="drawer" role="dialog" aria-modal="true">
            <div class="drawer__head">
              <div style="min-width:0">
                <div class="model-card__title-row">
                  <span style="font-size:16px;font-weight:700;word-break:break-all">${esc(name)}</span>
                  ${badge(attachmentLabel(kind), kind === 'text' ? 'blue' : kind === 'image' ? 'pink' : kind === 'pdf' ? 'amber' : 'gray')}
                </div>
              </div>
              <button class="drawer__close" data-close aria-label="关闭">${icon('x', 17)}</button>
            </div>
            <div class="drawer__actions" id="att-actions"></div>
            <div class="drawer__body">
              <div class="drawer__section">
                <div class="section-title">附件信息</div>
                <dl class="kv">
                  <dt>文件名</dt><dd>${esc(name)}</dd>
                  <dt>大小</dt><dd>${sizeText}</dd>
                  <dt>类型</dt><dd>${esc(mime || attachmentLabel(kind))}</dd>
                </dl>
              </div>
              <div class="drawer__section">
                <div class="section-title">预览</div>
                <div id="att-preview"></div>
              </div>
            </div>
          </aside>`;

        const preview = backdrop.querySelector('#att-preview');
        const tempUrls = [];
        let pdfHref = '';
        if (kind === 'text') {
          let text = att.text;
          if (text == null) text = dataUrlText(att.data || '');
          if (text) {
            const pre = document.createElement('pre');
            pre.className = 'attachment-preview';
            const limit = 200000;
            pre.textContent = text.length > limit
              ? text.slice(0, limit) + '\n\n…（内容过长，仅显示前 200000 个字符，下载后可查看完整内容）'
              : text;
            preview.appendChild(pre);
          } else {
            preview.innerHTML = '<div class="attachment-unsupported">'
              + `${icon('file', 30)}`
              + '<div class="attachment-unsupported__title">该附件没有可预览的文本</div>'
              + '</div>';
          }
        } else if (kind === 'image' && safeUrl(att.data)) {
          const img = document.createElement('img');
          img.className = 'attachment-preview__image';
          img.src = safeUrl(att.data);
          img.alt = name;
          preview.appendChild(img);
        } else if (kind === 'pdf' && att.data) {
          // 浏览器内置 PDF 阅读器可以直接显示 Blob URL；
          // 比 data URL 可靠，也不会受远程地址的 X-Frame-Options 影响。
          pdfHref = safeUrl(att.data);
          if (String(pdfHref).startsWith('data:')) {
            const blob = dataUrlToBlob(pdfHref);
            if (blob) {
              pdfHref = URL.createObjectURL(blob);
              tempUrls.push(pdfHref);
            }
          }
          if (pdfHref) {
            const frame = document.createElement('iframe');
            frame.className = 'attachment-pdf';
            frame.src = pdfHref;
            frame.title = name;
            preview.appendChild(frame);
            const note = document.createElement('div');
            note.className = 'muted fs-12 mt-8';
            note.textContent = '如果预览空白，说明当前浏览器不支持内嵌 PDF，请下载后查看。';
            preview.appendChild(note);
          } else {
            preview.innerHTML = '<div class="attachment-unsupported">'
              + `${icon('file', 30)}`
              + '<div class="attachment-unsupported__title">PDF 解析失败</div>'
              + '<div class="muted fs-12">请下载后查看。</div>'
              + '</div>';
          }
        } else {
          preview.innerHTML = '<div class="attachment-unsupported">'
            + `${icon('file', 30)}`
            + '<div class="attachment-unsupported__title">该格式暂不支持在线预览</div>'
            + '<div class="muted fs-12">Word、压缩包等二进制文件请下载后查看。</div>'
            + '</div>';
        }

        const actions = backdrop.querySelector('#att-actions');
        let href = att.data || '';
        if (!href && att.text != null) {
          const url = URL.createObjectURL(new Blob([att.text], { type: att.mime || 'text/plain' }));
          tempUrls.push(url);
          href = url;
        }
        if (href && safeUrl(href)) {
          const download = document.createElement('a');
          download.className = 'btn btn--sm btn--primary';
          download.href = href;
          download.download = name;
          download.target = '_blank';
          download.rel = 'noopener';
          download.innerHTML = icon('download', 13) + '下载附件';
          actions.appendChild(download);
        }
        if (kind === 'image' && safeUrl(att.data)) {
          const open = document.createElement('a');
          open.className = 'btn btn--sm';
          open.href = safeUrl(att.data);
          open.target = '_blank';
          open.rel = 'noopener';
          open.innerHTML = icon('eye', 13) + '新标签页打开';
          actions.appendChild(open);
        }
        if (kind === 'pdf' && pdfHref) {
          const open = document.createElement('a');
          open.className = 'btn btn--sm';
          open.href = pdfHref;
          open.target = '_blank';
          open.rel = 'noopener';
          open.innerHTML = icon('eye', 13) + '新标签页打开';
          actions.appendChild(open);
        }

        const close = () => {
          backdrop.remove();
          document.removeEventListener('keydown', onKey);
          document.body.style.overflow = '';
          if (tempUrls.length) {
            setTimeout(() => tempUrls.forEach((u) => URL.revokeObjectURL(u)), 1000);
          }
          if (prev && prev.focus) prev.focus();
        };
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
        backdrop.querySelector('[data-close]').onclick = close;
        document.addEventListener('keydown', onKey);
        document.body.appendChild(backdrop);
        document.body.style.overflow = 'hidden';
      };

      const appendAttachment = (box, att) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'msg__file';
        chip.title = '查看附件';
        const ic = document.createElement('span');
        ic.className = 'msg__file-icon';
        ic.innerHTML = icon('file', 15);
        chip.appendChild(ic);
        const nm = document.createElement('span');
        nm.className = 'msg__file-name';
        nm.textContent = att.name || '附件';
        chip.appendChild(nm);
        const meta = document.createElement('span');
        meta.className = 'msg__file-meta';
        meta.textContent = att.size ? fmtBytes(att.size) : (att.mime || '附件');
        chip.appendChild(meta);
        chip.onclick = () => openAttachmentDrawer(att);
        box.appendChild(chip);
      };

      const appendTextPart = (box, t) => {
        if (!t) return;
        const el = document.createElement('div');
        el.className = 'msg__answer';
        box.appendChild(el);
        // 原文同时存在 el._raw 上，切换「原文 / 渲染」时不用再回查历史
        paintText(el, t, true);
      };

      // 深度思考折叠块：多轮工具调用时每轮各一块，按输出顺序插在气泡里。
      // ms 是这一轮从开始思考到结束思考的耗时，旧记录没有这个字段时只显示字数。
      const thinkBlockEl = (text, open, ms) => {
        const det = document.createElement('details');
        det.className = 'think-block';
        det.open = !!open;
        det.innerHTML = '<summary>深度思考<span class="think-block__meta"></span></summary>'
          + '<div class="think-block__body"></div>';
        const meta = text
          ? ` ${text.length} 字${ms != null ? ` · ${fmtSeconds(ms)}` : ''}`
          : ' 思考中…';
        det.querySelector('.think-block__meta').textContent = meta;
        det.querySelector('.think-block__body').textContent = text || '';
        return det;
      };

      // 把字符串或 OpenAI 多模态 content 数组渲染到气泡里
      const renderContent = (box, content, clear) => {
        if (clear !== false) box.innerHTML = '';
        if (content == null || content === '') return;
        if (typeof content === 'string') {
          appendTextPart(box, content);
          return;
        }
        if (!Array.isArray(content)) {
          appendTextPart(box, String(content));
          return;
        }
        for (const pv of content) {
          if (typeof pv === 'string') {
            appendTextPart(box, pv);
            continue;
          }
          if (!pv || typeof pv !== 'object') continue;
          const type = pv.type;
          if (type === 'text' || type === 'input_text') {
            appendTextPart(box, pv.text != null ? pv.text : pv.content);
          } else if (type === 'image_url' || type === 'input_image' || type === 'image') {
            let url = '';
            if (typeof pv.image_url === 'string') url = pv.image_url;
            else if (pv.image_url && pv.image_url.url) url = pv.image_url.url;
            else if (pv.url) url = pv.url;
            else if (pv.source && pv.source.type === 'base64' && pv.source.data) {
              url = `data:${pv.source.media_type || 'image/png'};base64,${pv.source.data}`;
            } else if (pv.source && pv.source.url) url = pv.source.url;
            if (url) appendImage(box, url);
          } else if (type === 'attachment') {
            const a = pv.attachment || pv;
            appendAttachment(box, {
              kind: a.kind || (a.text != null ? 'text' : 'file'),
              name: a.name || a.filename || '附件',
              mime: a.mime || a.mime_type || '',
              size: a.size,
              text: a.text,
              data: a.data || a.file_data || a.url || '',
            });
          } else if (type === 'file' || type === 'input_file' || type === 'document') {
            const f = pv.file && typeof pv.file === 'object' ? pv.file : pv;
            const name = f.filename || f.name || pv.filename || pv.title || '附件';
            let data = f.file_data || f.data || f.file_url || f.url || '';
            let mime = f.mime_type || pv.media_type || '';
            let text = null;
            if (!data && pv.source && typeof pv.source === 'object') {
              const src = pv.source;
              if (src.type === 'base64' && src.data) {
                data = `data:${src.media_type || 'application/octet-stream'};base64,${src.data}`;
                mime = mime || src.media_type || '';
              } else if (src.type === 'url' && src.url) {
                data = src.url;
              } else if (src.type === 'text' && src.data) {
                text = src.data;
                mime = mime || 'text/plain';
              }
            }
            if (text == null && isTextMime(mime) && !BINARY_EXT.test(name) && data) {
              text = dataUrlText(data);
            }
            appendAttachment(box, {
              kind: text != null ? 'text' : (mime.startsWith('image/') ? 'image' : 'file'),
              name,
              mime,
              data,
              text,
              size: data ? Math.round(String(data).length * 0.75) : (text ? new Blob([text]).size : 0),
            });
          }
        }
      };

      const flattenText = (content) => {
        if (typeof content === 'string') return content;
        if (!Array.isArray(content)) return content == null ? '' : String(content);
        return content
          .map((p) => {
            if (p && typeof p === 'object') {
              if (p.text != null) return p.text;
              if (p.content != null) return p.content;
              return '';
            }
            return String(p == null ? '' : p);
          })
          .filter(Boolean)
          .join('\n');
      };

      const lastUserContent = (messages) => {
        if (!Array.isArray(messages)) return '';
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m && m.role === 'user' && m.content != null) return m.content;
        }
        return '';
      };

      // 工具卡片：流式输出工具调用时先建出来，参数随分片实时刷新；
      // 执行完补上结果并收起。返回 { el, sync }，sync 就地更新已有节点，
      // 避免每个分片重建整张卡片导致闪烁。
      const toolCardEl = (calls, opts) => {
        const list = calls || [];
        const state = { done: !!(opts && opts.done) };
        const det = document.createElement('details');
        det.className = 'tool-block';
        det.open = !state.done;
        det.innerHTML = '<summary>工具调用<span class="tool-block__meta"></span></summary>'
          + '<div class="tool-block__body"></div>';
        const meta = det.querySelector('.tool-block__meta');
        const body = det.querySelector('.tool-block__body');
        const sections = [];

        const addSection = () => {
          const sec = document.createElement('div');
          sec.className = 'tool-call';
          const head = document.createElement('div');
          head.className = 'tool-call__head';
          const name = document.createElement('span');
          name.className = 'tool-call__name';
          const st = document.createElement('span');
          st.className = 'tool-call__state';
          head.appendChild(name);
          head.appendChild(st);
          sec.appendChild(head);
          const addRow = (label) => {
            const row = document.createElement('div');
            row.className = 'tool-call__row';
            const lab = document.createElement('div');
            lab.className = 'tool-call__label';
            lab.textContent = label;
            const pre = document.createElement('pre');
            pre.className = 'tool-call__code';
            row.appendChild(lab);
            row.appendChild(pre);
            sec.appendChild(row);
            return { row, pre };
          };
          const args = addRow('参数');
          const result = addRow('结果');
          result.row.hidden = true;
          body.appendChild(sec);
          sections.push({ name, st, argsPre: args.pre, resRow: result.row, resPre: result.pre });
        };

        const sync = (next) => {
          if (next) Object.assign(state, next);
          while (sections.length < list.length) addSection();
          list.forEach((call, i) => {
            const c = call || {};
            const s = sections[i];
            s.name.textContent = c.name || '未知工具';
            s.argsPre.textContent = c.args || '{}';
            const hasResult = c.result != null;
            s.resRow.hidden = !hasResult;
            if (hasResult) s.resPre.textContent = c.result;
            const failed = !!c.error;
            const time = typeof c.ms === 'number' ? ` · ${fmtSeconds(c.ms)}` : '';
            s.st.textContent = failed
              ? `失败${time}`
              : (hasResult ? `完成${time}` : (state.done ? '未执行' : '调用中'));
            s.st.className = 'tool-call__state' + (failed ? ' is-error' : '');
          });
          const failedCount = list.filter((c) => c && c.error).length;
          meta.textContent = state.done
            ? ` ${list.length} 次${failedCount ? ` · ${failedCount} 个失败` : ''}`
            : ` ${list.length} 次 · 调用中…`;
        };
        sync();
        return { el: det, sync };
      };

      const toolWrapEl = (calls) => {
        const wrap = document.createElement('div');
        wrap.className = 'tool-wrap';
        if (calls && calls.length) wrap.appendChild(toolCardEl(calls, { done: true }).el);
        return wrap;
      };

      const addMsg = (role, content, isError, providerIconKey) => {
        const el = document.createElement('div');
        el.className = 'msg msg--' + (role === 'user' ? 'user' : 'assistant') + (isError ? ' msg--error' : '');
        el.innerHTML = avatarHtml(role, providerIconKey)
          + '<div class="msg__body"><div class="msg__bubble"></div></div>';
        renderContent(el.querySelector('.msg__bubble'), content);
        log.appendChild(el);
        // 新消息总是把视口带到底部（用户自己发的那条 + 紧随其后的回复占位）
        scrollToBottom(true);
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

      // 按存下来的数据结构重建一条消息（含思考折叠块）。只建元素、不挂载：
      // 首屏只接最后几条，更早的等往上滑时再插到前面。
      const buildStored = (m) => {
        const el = document.createElement('div');
        el.className = 'msg msg--' + (m.role === 'user' ? 'user' : 'assistant') + (m.error ? ' msg--error' : '');
        // 历史消息不播上浮动画（几十条一起播会闪），并记住自己对应哪条数据
        el.classList.add('msg--bulk');
        el._msg = m;
        el.innerHTML = avatarHtml(m.role, m.role === 'user' ? '' : storedProviderIcon(m))
          + '<div class="msg__body"><div class="msg__bubble"></div></div>';
        const bubble = el.querySelector('.msg__bubble');
        const parts = m.role === 'assistant' && Array.isArray(m.parts) && m.parts.length ? m.parts : null;
        // 新记录把思考也存进 parts；旧记录只有顶层 think 字段，没有分段信息
        const partsHaveThink = !!(parts && parts.some((p) => p && p.type === 'think'));
        if (m.role === 'assistant' && m.think && !partsHaveThink) {
          // 旧记录没存耗时（think_ms 是后加的），只有字数
          bubble.appendChild(thinkBlockEl(m.think, false, m.think_ms));
        }
        const contentEl = document.createElement('div');
        contentEl.className = 'msg__content';
        bubble.appendChild(contentEl);
        if (parts) {
          // 新记录按思考 / 正文 / 工具调用的实际输出顺序回放
          parts.forEach((part) => {
            if (!part) return;
            if (part.type === 'think') contentEl.appendChild(thinkBlockEl(part.text || '', false, part.ms));
            else if (part.type === 'text') appendTextPart(contentEl, part.text);
            else if (part.type === 'tools') contentEl.appendChild(toolWrapEl(part.calls));
          });
        } else {
          // 旧记录没有分段信息：工具块在前，正文在后。
          // renderContent 默认会清空容器，这里必须保留已插入的工具块。
          if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
            contentEl.appendChild(toolWrapEl(m.tool_calls));
          }
          renderContent(contentEl, m.display || m.content || '', false);
        }
        if (m.error) {
          const errEl = document.createElement('div');
          errEl.className = 'msg__error-text';
          errEl.textContent = m.error;
          contentEl.appendChild(errEl);
        }
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
        // 用户消息和 AI 回复都挂同一排操作按钮
        if (m.role === 'user' || m.role === 'assistant') addMessageActions(el, m);
        return el;
      };

      const reset = () => {
        // 清空时如果还有后台请求，先停掉并丢弃它的结果，避免往空历史里追加
        const run = chatStore.run;
        if (run) {
          run.discarded = true;
          run.view = null;
          run.bubble = null;
          run.msgEl = null;
          run.thinkBlock = run.thinkBody = run.thinkMeta = run.answerEl = null;
          run.toolCard = null;
          if (run.thinkTimer) {
            clearInterval(run.thinkTimer);
            run.thinkTimer = null;
          }
          run.ctl.abort();
          chatStore.run = null;
        }
        history.splice(0, history.length);
        staged = [];
        renderStaged();
        saveSessions();
        log.innerHTML = '';
        setBusy(false);
        if (customMode) syncCustomBody();
        refreshMeta();
      };

      // ---------- 会话窗口渲染 ----------
      // 长对话不再整段铺开：切会话时只画最后几条，更早的等用户往上滑再补。
      // 补的时候把 scrollTop 按新增高度抬回去，画面不会跳。
      const TAIL_COUNT = 8;   // 切会话先画几条
      const OLDER_STEP = 8;   // 每次往上滑再补几条
      let olderBusy = false;

      // 当前窗口的第一条在 history 里的下标（按元素上挂的消息对象反查，
      // 这样删/重试把 history 改短了也不会错位）
      const renderedFrom = () => {
        const first = log.querySelector('.msg');
        if (!first) return history.length;
        const at = first._msg ? history.indexOf(first._msg) : -1;
        return at >= 0 ? at : 0;
      };

      // 首屏：只画最后几条并贴在底部
      const paintTail = () => {
        const total = history.length;
        const from = Math.max(0, total - TAIL_COUNT);
        const frag = document.createDocumentFragment();
        for (let i = from; i < total; i += 1) frag.appendChild(buildStored(history[i]));
        log.appendChild(frag);
        log.scrollTop = log.scrollHeight;
      };

      // 往上补一批更早的：插在最前面，再把 scrollTop 抬回新增的高度
      const loadOlder = () => {
        if (olderBusy) return;
        const to = renderedFrom();
        if (to <= 0) return;
        olderBusy = true;
        bulkPainting = true;
        try {
          const from = Math.max(0, to - OLDER_STEP);
          const prevHeight = log.scrollHeight;
          const prevTop = log.scrollTop;
          const frag = document.createDocumentFragment();
          for (let i = from; i < to; i += 1) frag.appendChild(buildStored(history[i]));
          log.insertBefore(frag, log.firstChild);
          // 顶上多了几条，把滚动位置同步抬起来，用户看到的还是同一屏
          log.scrollTop = prevTop + (log.scrollHeight - prevHeight);
          followBottom = nearBottom();
          syncToBottomBtn();
        } finally {
          bulkPainting = false;
          olderBusy = false;
        }
      };

      // 消息都很短时，最后几条撑不满一屏就滚不动 —— 自动再补，直到能滚或补完
      const fillViewport = () => {
        let guard = 0;
        while (renderedFrom() > 0 && log.scrollHeight <= log.clientHeight + 8 && guard < 40) {
          loadOlder();
          guard += 1;
        }
      };

      // 进入页面时恢复上一次的对话（不生成任何占位消息）
      const restore = () => {
        log.innerHTML = '';
        refreshMeta();
        // 先把消息区显示出来（空会话才会藏起来），否则消息没地方放
        syncEmptyHint();
        bulkPainting = true;
        try {
          paintTail();
        } finally {
          bulkPainting = false;
        }
        fillViewport();
        // 后台请求还在跑：重建一个气泡，把流重新接上来
        const run = chatStore.run;
        if (run) {
          if (run.sentModel.type === 'test') {
            chatStore.model = TEST_MODEL_ID;
            persistChatModel(TEST_MODEL_ID);
            modelSel.value = TEST_MODEL_ID;
            chipModelSel.value = TEST_MODEL_ID;
            refreshMeta();
          } else if (usable.some((m) => m.id === run.sentModel.id)) {
            chatStore.model = run.sentModel.id;
            persistChatModel(run.sentModel.id);
            modelSel.value = run.sentModel.id;
            chipModelSel.value = run.sentModel.id;
            refreshMeta();
          }
          const bubble = addMsg('assistant', '', false, run.sentModel.provider_icon);
          run.attach(bubble, view);
          setBusy(true);
        }
        // 回到聊天页时先落在最后一条上
        scrollToBottom(true);
        syncEmptyHint();
      };

      // ---------- 对话列表 ----------

      // 会话按「今天 / 昨天 / 近 7 天 / 更早」分组，和 DeepSeek 的习惯一致
      const convGroupOf = (ts) => {
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const day = 86400000;
        if (ts >= startOfToday) return '今天';
        if (ts >= startOfToday - day) return '昨天';
        if (ts >= startOfToday - 7 * day) return '近 7 天';
        return '更早';
      };

      const activeSession = () => chatStore.sessions.find((x) => x.id === chatStore.activeId) || null;

      // ---------- 搜索与多选 ----------

      // 搜索只按标题过滤，大小写不敏感；清空输入框就恢复完整列表
      let convSearchKw = '';
      convSearchInput.addEventListener('input', () => {
        convSearchKw = convSearchInput.value.trim().toLowerCase();
        renderConvList();
      });

      // 多选状态：进入后列表项变成勾选框，点条目是选中/取消而不是切换会话
      const convMulti = { on: false, picked: new Set() };
      const syncMultiBar = () => {
        const on = convMulti.on;
        convAside.classList.toggle('is-multi', on);
        // 「开启新对话」原位换成已选计数 + 删除的操作条，搜索框不动；
        // 多选键不挪窝：进多选后原地图标变 ✕，再点就是退出
        convNew.hidden = on;
        convMBar.hidden = !on;
        convMultiBtn.innerHTML = icon(on ? 'x' : 'check', 14);
        convMultiBtn.title = on ? '退出多选' : '多选对话';
        convMultiBtn.setAttribute('aria-label', on ? '退出多选' : '多选对话');
        convMCount.textContent = `已选 ${convMulti.picked.size} 个`;
      };
      const exitConvMulti = () => {
        convMulti.on = false;
        convMulti.picked.clear();
        syncMultiBar();
        renderConvList();
      };
      convMultiBtn.onclick = () => {
        if (convMulti.on) {
          exitConvMulti();
          return;
        }
        convMulti.on = true;
        syncMultiBar();
        renderConvList();
      };
      convDelSel.onclick = () => {
        // 一个都没勾也允许点：弹提示比按钮死在那儿更好懂
        if (!convMulti.picked.size) {
          Toast.info('先勾选要删除的对话');
          return;
        }
        const ids = [...convMulti.picked];
        ids.forEach(removeSession);
        if (ids.length) Toast.success(`已删除 ${ids.length} 个对话`);
        exitConvMulti();
      };

      // 重画左侧列表：按时间分组，当前会话高亮
      const renderConvList = () => {
        if (!convList) return;
        convList.innerHTML = '';
        const groups = [];
        const order = ['今天', '昨天', '近 7 天', '更早'];
        const sorted = chatStore.sessions.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        // 搜索命中才算数；分组里一条都没有就整组不出现
        const hit = (s) => !convSearchKw
          || (s.title || '新对话').toLowerCase().includes(convSearchKw);
        sorted.forEach((s) => {
          if (!hit(s)) return;
          const g = convGroupOf(s.updatedAt || s.createdAt || Date.now());
          let bucket = groups.find((x) => x.name === g);
          if (!bucket) {
            bucket = { name: g, items: [] };
            // 分组按「今天 → 昨天 → 近 7 天 → 更早」的顺序插入
            const idx = order.indexOf(g);
            let at = groups.length;
            for (let i = 0; i < groups.length; i += 1) {
              if (order.indexOf(groups[i].name) > idx) { at = i; break; }
            }
            groups.splice(at, 0, bucket);
          }
          bucket.items.push(s);
        });
        groups.forEach((g) => {
          const head = document.createElement('div');
          head.className = 'chat-conv__group';
          head.textContent = g.name;
          convList.appendChild(head);
          g.items.forEach((s) => {
            const item = document.createElement('div');
            item.className = 'chat-conv__item' + (s.id === chatStore.activeId ? ' is-active' : '');
            if (convMulti.on && convMulti.picked.has(s.id)) item.classList.add('is-picked');
            // 多选模式下条目前面是勾选框，点条目是选中而不是切换；
            // 单个删除键只在普通模式出现，多选的删除走顶上的批量键
            if (convMulti.on) {
              const pick = document.createElement('span');
              pick.className = 'chat-conv__pick';
              pick.innerHTML = icon('check', 10);
              item.appendChild(pick);
              item.onclick = () => {
                if (convMulti.picked.has(s.id)) convMulti.picked.delete(s.id);
                else convMulti.picked.add(s.id);
                syncMultiBar();
                renderConvList();
              };
            }
            const title = document.createElement('span');
            title.className = 'chat-conv__title';
            title.textContent = s.title || '新对话';
            title.title = s.title || '新对话';
            item.appendChild(title);
            if (!convMulti.on) {
              const del = document.createElement('button');
              del.className = 'chat-conv__del';
              del.type = 'button';
              del.title = '删除对话';
              del.innerHTML = icon('trash', 12);
              del.onclick = (e) => {
                e.stopPropagation();
                removeSession(s.id);
              };
              item.appendChild(del);
              item.onclick = () => switchSession(s.id);
            }
            convList.appendChild(item);
          });
        });
        if (!convList.children.length) {
          const empty = document.createElement('div');
          empty.className = 'chat-conv__empty';
          // 有会话但被搜索滤光，跟「一条会话都没有」文案区分开
          empty.textContent = convSearchKw && chatStore.sessions.length ? '没有匹配的对话' : '还没有对话';
          convList.appendChild(empty);
        }
      };

      // 会话标题和更新时间跟着消息走：标题取第一条用户消息
      const touchSession = () => {
        const s = activeSession();
        if (!s) return;
        const t = chatSessionTitle(s.messages);
        if (t) s.title = t;
        s.updatedAt = Date.now();
        s.model = modelSel.value;
      };
      // 消息有变动：更新会话元信息 → 落盘 → 重画左侧列表
      const saveSessions = () => {
        touchSession();
        persistChatSessions();
        renderConvList();
      };

      // 切换会话：先把当前会话的消息存回它自己，再换 activeId 重画消息区
      const switchSession = (id) => {
        if (id === chatStore.activeId) return;
        if (chatStore.run) {
          Toast.info('正在生成中，等这一条回复结束再切换');
          return;
        }
        const target = chatStore.sessions.find((x) => x.id === id);
        if (!target) return;
        chatStore.activeId = id;
        history = chatStore.history;
        // 每个会话记住自己用的模型，切换回来时恢复
        if (target.model) {
          const m = usable.find((x) => x.id === target.model);
          if (m) {
            modelSel.value = target.model;
            chipModelSel.value = target.model;
            chatStore.model = target.model;
            persistChatModel(target.model);
          }
        }
        persistChatSessions();
        renderConvList();
        restore();
        focusText();
      };

      // 新建一条空会话并切过去；当前本来就是空会话就不再重复建
      const createSession = () => {
        if (chatStore.run) {
          Toast.info('正在生成中，等这一条回复结束再新建');
          return;
        }
        const cur = activeSession();
        // 已经停在一条没有消息的会话上了，不用再建一条
        if (cur && !cur.messages.length) {
          focusText();
          return;
        }
        const s = {
          id: chatSessionId(),
          title: '',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          model: modelSel.value,
          messages: [],
        };
        chatStore.sessions.unshift(s);
        chatStore.activeId = s.id;
        history = chatStore.history;
        persistChatSessions();
        renderConvList();
        restore();
        focusText();
      };

      // 删除一条会话；删掉当前会话时退到相邻的一条
      const removeSession = (id) => {
        if (chatStore.run) {
          Toast.info('正在生成中，等这一条回复结束再删除');
          return;
        }
        const idx = chatStore.sessions.findIndex((x) => x.id === id);
        if (idx < 0) return;
        const wasActive = id === chatStore.activeId;
        chatStore.sessions.splice(idx, 1);
        if (!chatStore.sessions.length) {
          // 至少留一个空会话
          chatStore.sessions.push({
            id: chatSessionId(), title: '', createdAt: Date.now(), updatedAt: Date.now(),
            model: modelSel.value, messages: [],
          });
        }
        if (wasActive) {
          const next = chatStore.sessions[Math.min(idx, chatStore.sessions.length - 1)];
          chatStore.activeId = next.id;
          history = chatStore.history;
          if (next.model && usable.some((x) => x.id === next.model)) {
            modelSel.value = next.model;
            chipModelSel.value = next.model;
          }
          restore();
        }
        persistChatSessions();
        renderConvList();
      };

      // 生成过程中发送按钮变成停止按钮，点击中断流式请求
      // 下拉触发器是全局组件生成的另一个按钮，它的 disabled 只在给 select 赋值时
      // 顺带同步（全局 sync）；setCustomMode / setBusy 改 disabled 后不会有赋值，
      // 触发器会停在旧状态——「关掉自定义请求体后模型选择点不动」就是这条脱节
      const syncChipModelTrigger = () => {
        const trig = chipModelSel.__ldmTrigger;
        if (trig) trig.disabled = chipModelSel.disabled;
      };
      const setBusy = (busy) => {
        sending = busy;
        sendBtn.disabled = false;
        sendBtn.classList.toggle('btn--primary', !busy);
        sendBtn.classList.toggle('btn--danger', busy);
        // 发送按钮是圆形图标键，文字放 tooltip 里
        sendBtn.innerHTML = busy ? icon('stop', 15) : icon('send', 15);
        sendBtn.title = busy ? '停止生成' : '发送';
        streamInput.disabled = busy || customMode;
        streamToggle.classList.toggle('is-disabled', busy || customMode);
        chipStreamInput.disabled = busy || customMode;
        chipStream.classList.toggle('is-disabled', busy || customMode);
        toolsInput.disabled = busy || customMode;
        toolsSwitch.classList.toggle('is-disabled', busy || customMode);
        modelSel.disabled = busy || customMode;
        chipModelSel.disabled = busy || customMode;
        syncChipModelTrigger();
        paramsReset.disabled = busy || customMode;
        syncAllParams();
        customSwitchInput.disabled = busy;
        customSwitch.classList.toggle('is-disabled', busy);
        customEditor.disabled = busy;
        chipCustomHint.disabled = busy;
        pickImage.disabled = busy || customMode;
        pickFile.disabled = busy || customMode;
        [testUrlInput, testKeyInput, testModelInput, testModelSelect, testFetchBtn].forEach((el) => { el.disabled = busy; });
        // 下拉触发器是全局组件生成的另一个按钮，禁用要单独同步
        if (testModelSelect.__ldmTrigger) testModelSelect.__ldmTrigger.disabled = busy;
        log.querySelectorAll('[data-retry], [data-delete]').forEach((b) => { b.disabled = busy; });
      };

      const stopStream = () => {
        const run = chatStore.run;
        if (!run) return;
        run.ctl.abort();
      };

      const typingHtml = '<span class="typing"><span></span><span></span><span></span></span>';

      // 用户消息里的文字：display 才是界面上看到的样子，优先用它
      const userCopyText = (entry) => {
        const shown = flattenText(entry.display);
        return shown || flattenText(entry.content);
      };

      // 自定义请求体模式下编辑器里的 JSON 才是唯一事实来源，
      // 本地历史和它的 messages 按「第几条 user / assistant」一一对应。
      // 这里换算出这条消息在 messages 里的下标，拿不到返回 -1。
      const customMsgIdx = (entry) => {
        const idx = history.indexOf(entry);
        if (idx < 0) return -1;
        let payload;
        try { payload = JSON.parse(customEditor.value); } catch (e) { return -1; }
        if (!payload || !Array.isArray(payload.messages)) return -1;
        let nth = 0;
        for (let i = 0; i < idx; i += 1) {
          const m = history[i];
          if (m && (m.role === 'user' || m.role === 'assistant')) nth += 1;
        }
        const slots = [];
        payload.messages.forEach((m, i) => {
          if (m && typeof m === 'object' && (m.role === 'user' || m.role === 'assistant')) slots.push(i);
        });
        return slots[nth] == null ? -1 : slots[nth];
      };

      // 就地改编辑器里的 messages：delete 只删这一条，truncate 只保留到这一条
      const editCustomMessages = (entry, mode) => {
        const pos = customMsgIdx(entry);
        if (pos < 0) return false;
        try {
          const payload = JSON.parse(customEditor.value);
          if (mode === 'delete') payload.messages.splice(pos, 1);
          else payload.messages.splice(pos + 1);
          customEditor.value = JSON.stringify(payload, null, 2);
          updateCustomHint();
          return true;
        } catch (e) {
          return false;
        }
      };

      // 只删这一条消息，同一轮里的其它消息原样保留（气泡当场消失就是反馈，不弹 Toast）
      const deleteOneMessage = (msgEl, entry) => {
        const idx = history.indexOf(entry);
        if (idx >= 0) {
          // 自定义模式要先按当前历史算出位置，再动 history
          if (customMode) editCustomMessages(entry, 'delete');
          history.splice(idx, 1);
          saveSessions();
        }
        msgEl.remove();
      };

      // 重试用户消息：保留这条提问和它之前的历史，丢掉后面的回复再发一遍
      const retryUser = async (entry, msgEl) => {
        if (sending || chatStore.run) return;
        if (!ensureTestReady()) return;
        const idx = history.indexOf(entry);
        if (idx < 0) return;
        if (customMode) {
          if (!editCustomMessages(entry, 'truncate')) {
            Toast.info('自定义请求体模式下请先修正 JSON 再重试');
            return;
          }
        } else if (!ensureTestModel()) {
          return;
        }
        history.splice(idx + 1);
        saveSessions();
        const all = [...log.querySelectorAll('.msg')];
        const pos = all.indexOf(msgEl);
        if (pos >= 0) all.slice(pos + 1).forEach((el) => el.remove());
        if (customMode) await doSendCustom(true);
        else await startRun({ messages: chatContext(history), sentModel: currentModel() });
      };

      // 每条消息下面都挂同一排操作按钮：重试 / 复制 / Markdown / 删除（纯图标）
      const addMessageActions = (msgEl, entry) => {
        const body = msgEl && msgEl.querySelector('.msg__body');
        if (!body || body.querySelector('.msg__actions')) return;
        const isUser = entry && entry.role === 'user';
        const row = document.createElement('div');
        row.className = 'msg__actions';
        const makeBtn = (act, iconName, title, onclick) => {
          const btn = document.createElement('button');
          btn.className = 'btn btn--ghost btn--sm btn--icon';
          // data-copy 是全局复制的「载荷」约定（app.js 在 document 上委托），
          // 这里的复制键自己绑了 onclick，再带 data-copy 会被当成待复制文本
          // 复制一次 "1"，于是点一下弹两个提示、剪贴板还被覆盖。
          if (act === 'copy') btn.dataset.msgCopy = '1';
          else btn.dataset[act] = '1';
          btn.title = title;
          btn.setAttribute('aria-label', title);
          btn.innerHTML = icon(iconName, 12);
          btn.onclick = onclick;
          row.appendChild(btn);
          return btn;
        };
        if (isUser) {
          makeBtn('retry', 'refresh', '重新发送这条消息（会移除它之后的回复）', () => retryUser(entry, msgEl));
        } else {
          makeBtn('retry', 'refresh', entry.error
            ? '重新生成这条回复（会移除这条之后的消息）'
            : '用当前选中的模型重新生成（会移除这条之后的消息）', () => retryAssistant(entry, msgEl));
        }
        const copySource = isUser
          ? userCopyText(entry)
          : (entry.error
            ? ((entry.content ? entry.content + '\n\n' : '') + entry.error)
            : (entry.content || ''));
        makeBtn('copy', 'copy', isUser ? '复制这条消息' : (entry.error ? '复制错误信息' : '复制这条回复'),
          () => copyText(copySource, isUser ? '消息内容' : (entry.error ? '错误信息' : '回复内容')));
        // 这条消息单独切换：渲染后的显示 ↔ Markdown 原文
        if (body.querySelector('.msg__answer')) {
          const mdBtn = document.createElement('button');
          mdBtn.className = 'btn btn--ghost btn--sm btn--icon';
          mdBtn.dataset.mdToggle = '1';
          mdBtn.onclick = () => {
            const cur = body.querySelector('.msg__answer');
            setBubbleMd(body, !(cur && cur._md));
          };
          row.appendChild(mdBtn);
        }
        makeBtn('delete', 'trash', '删除这条消息', () => deleteOneMessage(msgEl, entry));
        body.appendChild(row);
        syncMdBtn(body);
      };

      // ---------- 附件 ----------

      const MAX_FILE_BYTES = 20 * 1024 * 1024;
      const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
      const TEXT_MAX_BYTES = 2 * 1024 * 1024;
      const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|log|xml|ya?ml|html?|css|js|jsx|ts|tsx|py|go|java|c|h|cpp|hpp|cs|php|rb|rs|swift|kt|sql|sh|bash|zsh|ps1|ini|toml|conf|env|tex|srt|vtt)$/i;
      const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)$/i;
      // 即使 MIME 被识别成 text/plain，这些扩展名也按二进制处理，避免把正文读成乱码
      const BINARY_EXT = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|gz|tgz|bz2|xz|tar|png|jpe?g|gif|webp|bmp|svg|avif|heic|heif|mp3|wav|flac|ogg|m4a|mp4|mov|avi|mkv|webm|exe|dll|so|dylib|bin|iso|apk|ipa|woff2?|ttf|otf|eot)$/i;

      const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
      const stagedBytes = () => staged.reduce((n, a) => n + (a.size || 0), 0);
      const isImageFile = (f) => (f.type || '').startsWith('image/') || IMAGE_EXT.test(f.name || '');
      const isTextFile = (f) => {
        if (BINARY_EXT.test(f.name || '')) return false;
        return isTextMime(f.type) || TEXT_EXT.test(f.name || '');
      };
      const readDataURL = (f) => new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ''));
        r.onerror = () => reject(r.error || new Error('读取失败'));
        r.readAsDataURL(f);
      });
      const readText = (f) => new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ''));
        r.onerror = () => reject(r.error || new Error('读取失败'));
        r.readAsText(f);
      });
      const loadImage = (src) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片解码失败'));
        img.src = src;
      });

      // 图片先在浏览器里压到最长边 1600px，避免一次对话就把 localStorage 撑爆
      const compressImage = async (f) => {
        const original = await readDataURL(f);
        if (f.type === 'image/gif' || f.type === 'image/svg+xml') {
          return { data: original, size: f.size };
        }
        try {
          const img = await loadImage(original);
          const max = 1600;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          if (scale === 1 && f.size <= 700 * 1024) return { data: original, size: f.size };
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) return { data: original, size: f.size };
          const keepPng = f.type === 'image/png' && f.size <= 900 * 1024;
          if (!keepPng) {
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, w, h);
          }
          ctx.drawImage(img, 0, 0, w, h);
          const out = canvas.toDataURL(keepPng ? 'image/png' : 'image/jpeg', 0.86);
          return { data: out, size: Math.round(out.length * 0.75) };
        } catch (e) {
          return { data: original, size: f.size };
        }
      };

      const addFiles = async (files) => {
        const list = Array.from(files || []);
        if (!list.length) return;
        for (const f of list) {
          if (!f || !f.size) continue;
          if (f.size > MAX_FILE_BYTES) {
            Toast.error(`${f.name || '文件'} 超过 20MB，已跳过`);
            continue;
          }
          if (stagedBytes() + f.size > MAX_TOTAL_BYTES) {
            Toast.error('附件总大小超过 30MB，已停止添加');
            break;
          }
          try {
            if (isImageFile(f)) {
              const img = await compressImage(f);
              staged.push({
                id: uid(), kind: 'image', name: f.name || '图片', size: img.size,
                mime: f.type || 'image/png', data: img.data,
              });
            } else if (isTextFile(f)) {
              if (f.size > TEXT_MAX_BYTES) {
                Toast.error(`${f.name || '文本文件'} 超过 2MB，已跳过`);
                continue;
              }
              const content = await readText(f);
              staged.push({
                id: uid(), kind: 'text', name: f.name || '文本', size: f.size,
                mime: f.type || 'text/plain', text: content,
              });
            } else {
              const data = await readDataURL(f);
              staged.push({
                id: uid(), kind: 'file', name: f.name || '附件', size: f.size,
                mime: f.type || 'application/octet-stream', data,
              });
            }
          } catch (e) {
            Toast.error(`读取 ${f.name || '文件'} 失败`);
          }
        }
        renderStaged();
        focusText();
      };

      const renderStaged = () => {
        attWrap.innerHTML = '';
        staged.forEach((a) => {
          const el = document.createElement('div');
          el.className = 'chat-attachment';
          if (a.kind === 'image') {
            const img = document.createElement('img');
            img.className = 'chat-attachment__thumb';
            img.src = a.data;
            img.alt = '';
            el.appendChild(img);
          } else {
            const ic = document.createElement('span');
            ic.className = 'chat-attachment__icon';
            ic.innerHTML = icon('file', 15);
            el.appendChild(ic);
          }
          const name = document.createElement('span');
          name.className = 'chat-attachment__name';
          name.title = a.name;
          name.textContent = a.name;
          el.appendChild(name);
          const size = document.createElement('span');
          size.className = 'chat-attachment__size';
          size.textContent = fmtBytes(a.size);
          el.appendChild(size);
          const rm = document.createElement('button');
          rm.type = 'button';
          rm.className = 'chat-attachment__remove';
          rm.title = '移除';
          rm.innerHTML = icon('x', 12);
          rm.onclick = () => {
            staged = staged.filter((x) => x.id !== a.id);
            renderStaged();
          };
          el.appendChild(rm);
          attWrap.appendChild(el);
        });
        attWrap.classList.toggle('is-disabled', customMode);
      };

      // 把输入文字与暂存附件组装成 OpenAI 多模态 content
      const buildContent = (t) => {
        const parts = [];
        if (t) parts.push({ type: 'text', text: t });
        for (const a of staged) {
          if (a.kind === 'image') {
            parts.push({ type: 'image_url', image_url: { url: a.data } });
          } else if (a.kind === 'text') {
            parts.push({ type: 'text', text: `【附件：${a.name}】\n${a.text}` });
          } else {
            parts.push({ type: 'file', file: { filename: a.name, file_data: a.data } });
          }
        }
        if (!parts.length) return '';
        if (parts.length === 1 && parts[0].type === 'text' && !staged.length) return t;
        return parts;
      };

      // 界面展示用：附件只显示卡片，不把正文铺在气泡里。
      // history 里的 content 用于请求，display 用于回看。
      const buildDisplay = (t) => {
        const parts = [];
        if (t) parts.push({ type: 'text', text: t });
        for (const a of staged) {
          if (a.kind === 'image') {
            parts.push({ type: 'image_url', image_url: { url: a.data } });
          } else {
            parts.push({
              type: 'attachment',
              attachment: {
                kind: a.kind, name: a.name, mime: a.mime, size: a.size,
                text: a.kind === 'text' ? a.text : undefined,
                data: a.kind === 'file' ? a.data : undefined,
              },
            });
          }
        }
        if (!parts.length) return '';
        if (parts.length === 1 && parts[0].type === 'text' && !staged.length) return t;
        return parts;
      };

      // ---------- 自定义请求体 ----------

      const buildPayload = () => {
        const m = currentModel();
        return {
          model: m.id,
          messages: chatContext(history),
          stream: streaming,
          ...collectParams(),
        };
      };

      const syncCustomBody = () => {
        customEditor.value = JSON.stringify(buildPayload(), null, 2);
        updateCustomHint();
      };

      const updateCustomHint = () => {
        const raw = customEditor.value.trim();
        if (!raw) {
          customHint.textContent = '开启后会自动填入当前对话的请求体';
          customHint.classList.remove('is-error');
          return;
        }
        try {
          const p = JSON.parse(raw);
          const n = Array.isArray(p.messages) ? p.messages.length : 0;
          const model = typeof p.model === 'string' && p.model ? p.model : '未指定模型';
          customHint.textContent = `模型 ${model} · ${p.stream === true ? '流式' : '非流式'} · ${n} 条消息`;
          customHint.classList.remove('is-error');
        } catch (e) {
          customHint.textContent = 'JSON 格式错误：' + e.message;
          customHint.classList.add('is-error');
        }
      };
      const updateCustomHintDebounced = debounce(updateCustomHint, 150);

      const setCustomMode = (on) => {
        customMode = on;
        customSwitchInput.checked = on;
        customPanel.hidden = !on;
        // 自定义请求体模式下模型、流式与采样参数都由 JSON 决定，整组隐藏
        normalFields.hidden = on;
        try { localStorage.setItem(CUSTOM_KEY, on ? '1' : '0'); } catch (e) { /* 忽略 */ }
        if (on) {
          if (!customEditor.value.trim()) syncCustomBody();
          updateCustomHint();
        }
        modelSel.disabled = on || sending;
        chipModelSel.disabled = on || sending;
        syncChipModelTrigger();
        paramsReset.disabled = on || sending;
        syncAllParams();
        streamInput.disabled = on || sending;
        streamToggle.classList.toggle('is-disabled', on || sending);
        chipStreamInput.disabled = on || sending;
        chipStream.classList.toggle('is-disabled', on || sending);
        toolsInput.disabled = on || sending;
        toolsSwitch.classList.toggle('is-disabled', on || sending);
        // 输入框里的模型下拉和流式开关被 JSON 接管：换成「已开启自定义请求体」提示，
        // 点一下打开右侧配置栏（自定义面板在那里），免得右栏收起时不知道去哪改
        chipsEl.classList.toggle('is-custom', on);
        chipCustomHint.hidden = !on;
        chipCustomHint.disabled = sending;
        chipStream.title = on
          ? '已开启自定义请求体模式：流式由请求体 JSON 的 stream 字段决定'
          : '关闭后等完整回复再一次性显示';
        customEditor.disabled = sending;
        pickImage.disabled = on || sending;
        pickFile.disabled = on || sending;
        attWrap.classList.toggle('is-disabled', on);
        if (!on) focusText();
      };

      // ---------- 请求 ----------

      // 测试工具：给模型一个获取当前时间的函数。模型发起调用后由浏览器执行，
      // 再把结果作为 tool 消息回传，完整走一遍工具调用往返。
      const CHAT_TOOLS = [{
        type: 'function',
        function: {
          name: 'get_current_time',
          description: '获取当前的日期和时间。用户询问现在几点、今天几号或需要当前时间时调用。',
          parameters: {
            type: 'object',
            properties: {
              timezone: {
                type: 'string',
                description: 'IANA 时区名称，例如 Asia/Shanghai；留空使用浏览器本地时区',
              },
            },
          },
        },
      }];

      const runChatTool = (name, argText) => {
        if (name !== 'get_current_time') {
          return { ok: false, result: JSON.stringify({ error: '未知工具：' + (name || '未命名') }) };
        }
        let args = {};
        if (argText) {
          try {
            args = JSON.parse(argText);
          } catch (e) {
            return { ok: false, result: JSON.stringify({ error: '工具参数不是合法 JSON：' + e.message }) };
          }
        }
        const tz = args && typeof args.timezone === 'string' ? args.timezone.trim() : '';
        const now = new Date();
        const opts = { hour12: false };
        if (tz) opts.timeZone = tz;
        try {
          return {
            ok: true,
            result: JSON.stringify({
              timezone: tz || Intl.DateTimeFormat().resolvedOptions().timeZone || '本地时区',
              local_time: now.toLocaleString('zh-CN', opts),
              weekday: now.toLocaleDateString('zh-CN', { ...opts, weekday: 'long' }),
              iso: now.toISOString(),
              unix: Math.floor(now.getTime() / 1000),
            }, null, 2),
          };
        } catch (e) {
          return { ok: false, result: JSON.stringify({ error: '时区无效：' + tz }) };
        }
      };

      // 同一轮里上游可能反复下发 usage（硅基流动等把累积用量塞进每个分块），
      // 只取最后一次的快照：逐块相加会把 267 token 加出三万多，速度直接上千。
      const snapshotUsage = (base, u) => {
        if (!u) return base;
        const out = { ...u };
        if (!base) return out;
        // 个别上游只在首块给出缓存/思考字段，后续快照里没有时沿用上一份
        if (!out.prompt_tokens_details && base.prompt_tokens_details) {
          out.prompt_tokens_details = base.prompt_tokens_details;
        }
        if (out.prompt_cache_hit_tokens == null && base.prompt_cache_hit_tokens != null) {
          out.prompt_cache_hit_tokens = base.prompt_cache_hit_tokens;
        }
        if (!out.completion_tokens_details && base.completion_tokens_details) {
          out.completion_tokens_details = base.completion_tokens_details;
        }
        return out;
      };

      // 多轮工具调用会把用量拆到多次响应里，展示时按轮累加
      const mergeUsage = (base, u) => {
        if (!u) return base;
        if (!base) return { ...u };
        const sum = (a, b) => (Number(a) || 0) + (Number(b) || 0);
        const out = { ...base };
        ['prompt_tokens', 'completion_tokens', 'total_tokens'].forEach((k) => {
          if (u[k] != null) out[k] = sum(base[k], u[k]);
        });
        const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens)
          || u.prompt_cache_hit_tokens || 0;
        if (cached) {
          const prev = (out.prompt_tokens_details && out.prompt_tokens_details.cached_tokens)
            || out.prompt_cache_hit_tokens || 0;
          out.prompt_tokens_details = out.prompt_tokens_details || {};
          out.prompt_tokens_details.cached_tokens = sum(prev, cached);
          delete out.prompt_cache_hit_tokens;
        }
        const reasoning = u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens;
        if (reasoning) {
          const prev = out.completion_tokens_details && out.completion_tokens_details.reasoning_tokens;
          out.completion_tokens_details = out.completion_tokens_details || {};
          out.completion_tokens_details.reasoning_tokens = sum(prev, reasoning);
        }
        return out;
      };

      // 最多连续执行几轮工具调用，防止模型在工具之间反复循环
      const MAX_TOOL_ROUNDS = 3;

      // 只负责一次流式调用与气泡渲染，历史由调用方维护。
      // run 放在 chatStore 里，页面切走再回来时可以重新 attach 到新气泡。
      const streamAssistant = async (run, bubble, view) => {
        const sentModel = run.sentModel;
        const customBody = run.customBody;
        // 实际是否流式以响应头为准：自定义请求体可能不带 stream 字段，
        // 上游此时按非流式返回 JSON；普通模式也可能遇到上游不支持流式直接回 JSON。
        let useStream = customBody ? customBody.stream === true : streaming;
        const t0 = run.t0;
        const isAbort = (e) => (e && e.name === 'AbortError') || run.ctl.signal.aborted;
        const scrollLog = () => {
          const v = run.view;
          if (v && v.alive()) v.scroll();
        };

        const clearPlaceholder = () => {
          const b = run.bubble;
          if (!b) return;
          b.querySelectorAll('.typing').forEach((el) => el.remove());
        };
        // 每轮思考各建一个折叠块，按输出顺序接在上一段内容后面；
        // 本轮正文开始或本轮结束时自动收起，想看还能再点开。
        const newThinkBlock = () => {
          const b = run.bubble;
          if (!b) return;
          clearPlaceholder();
          const det = thinkBlockEl('', true);
          b.appendChild(det);
          run.thinkBlock = det;
          run.thinkBody = det.querySelector('.think-block__body');
          run.thinkMeta = det.querySelector('.think-block__meta');
        };
        const stopThinkTimer = () => {
          if (run.thinkTimer) {
            clearInterval(run.thinkTimer);
            run.thinkTimer = null;
          }
        };
        // 思考中实时刷新耗时，正文或工具调用开始后停止
        const startThinkTimer = () => {
          stopThinkTimer();
          if (!run.bubble || !run.curThink) return;
          run.thinkTimer = setInterval(() => {
            if (!run.curThink) { stopThinkTimer(); return; }
            paintThinkMeta(true);
          }, 100);
        };
        const paintThinkMeta = (thinking) => {
          if (!run.bubble || !run.curThink || !run.thinkMeta) return;
          const part = run.curThink;
          const ms = part.ms != null ? part.ms : (part.t0 ? Date.now() - part.t0 : 0);
          run.thinkMeta.textContent = thinking
            ? ` 思考中… ${part.text.length} 字 · ${fmtSeconds(ms)}`
            : ` ${part.text.length} 字 · ${fmtSeconds(ms)}`;
        };
        const paintThink = (thinking) => {
          if (!run.bubble || !run.curThink) return;
          if (run.thinkBody) run.thinkBody.textContent = run.curThink.text;
          paintThinkMeta(thinking);
        };
        const foldThink = () => {
          if (!run.curThink) return;
          stopThinkTimer();
          // 记下这一轮从开始思考到结束思考用了多久
          if (run.curThink.ms == null && run.curThink.t0) {
            run.curThink.ms = Math.max(0, Date.now() - run.curThink.t0);
          }
          paintThink(false);
          if (run.thinkBlock) run.thinkBlock.open = false;
          run.curThink = null;
          run.thinkBlock = run.thinkBody = run.thinkMeta = null;
        };
        const addThink = (chunk) => {
          if (!chunk) return;
          run.think += chunk;
          if (!run.curThink) {
            run.curThink = { type: 'think', text: '', t0: Date.now() };
            run.parts.push(run.curThink);
            // 思考可能夹在正文之间，后面的正文要另起一段
            run.answerEl = null;
            run.curText = null;
            newThinkBlock();
            startThinkTimer();
          }
          run.curThink.text += chunk;
          paintThink(true);
        };
        // 正文按轮次分段：每轮正文一个元素，工具块插在两段正文之间，
        // 这样「正文 + 工具调用 + 后续正文」的显示顺序和模型输出顺序一致。
        const ensureAnswer = () => {
          const b = run.bubble;
          if (!b) return null;
          clearPlaceholder();
          if (run.answerEl && b.contains(run.answerEl)) return run.answerEl;
          run.answerEl = document.createElement('div');
          run.answerEl.className = 'msg__answer';
          run.answerEl._md = true;
          b.appendChild(run.answerEl);
          return run.answerEl;
        };
        const addContent = (chunk) => {
          if (!chunk) return;
          run.roundText += chunk;
          run.answer += chunk;
          if (!run.curText) {
            run.curText = { type: 'text', text: '' };
            run.parts.push(run.curText);
          }
          run.curText.text += chunk;
          paintAnswer();
        };
        const paintAnswer = () => {
          // 正文开始了就把这一轮的思考块收起来，想看还能再点开
          foldThink();
          if (!run.bubble || !run.curText) return;
          const el = ensureAnswer();
          if (el) paintText(el, run.curText.text);
        };
        const paintFailure = (message) => {
          const b = run.bubble;
          if (!b) return;
          foldThink();
          if (run.answer) paintAnswer();
          clearPlaceholder();
          if (!run.think && !run.answer && !run.parts.length) b.innerHTML = '';
          const errEl = document.createElement('div');
          errEl.className = 'msg__error-text';
          errEl.textContent = message;
          b.appendChild(errEl);
          const msg = b.closest('.msg');
          if (msg) msg.classList.add('msg--error');
        };

        // 页面切走再回来时，按时间线把思考块、正文段与工具块重新画到新的气泡上
        run.attach = (b, v) => {
          run.bubble = b;
          run.msgEl = b.closest('.msg');
          run.view = v || null;
          run.thinkBlock = run.thinkBody = run.thinkMeta = null;
          run.answerEl = null;
          run.curText = null;
          b.innerHTML = '';
          run.parts.forEach((part) => {
            if (!part) return;
            if (part.type === 'think') {
              const det = thinkBlockEl(part.text || '', part === run.curThink, part.ms);
              b.appendChild(det);
              run.answerEl = null;
              run.curText = null;
              if (part === run.curThink) {
                run.thinkBlock = det;
                run.thinkBody = det.querySelector('.think-block__body');
                run.thinkMeta = det.querySelector('.think-block__meta');
                paintThinkMeta(true);
                startThinkTimer();
              }
            } else if (part.type === 'text') {
              const el = document.createElement('div');
              el.className = 'msg__answer';
              el._md = true;
              b.appendChild(el);
              paintText(el, part.text, true);
              run.answerEl = el;
              run.curText = part;
            } else if (part.type === 'tools') {
              const live = part === run.toolPart && run.toolStreaming;
              const card = toolCardEl(part.calls, { done: !live });
              const wrap = document.createElement('div');
              wrap.className = 'tool-wrap';
              wrap.appendChild(card.el);
              b.appendChild(wrap);
              if (live) run.toolCard = card;
              run.answerEl = null;
              run.curText = null;
            }
          });
          if (!run.think && !run.answer && !run.parts.length) b.innerHTML = typingHtml;
        };
        run.attach(bubble, view);

        try {
          // 第一轮使用历史快照；模型调用工具后，把 assistant 的 tool_calls
          // 与执行结果追加进消息，再请求下一轮，直到模型给出正文。
          let messages = run.messages.slice();
          let toolRounds = 0;
          for (;;) {
            const roundCalls = [];
            run.roundText = '';
            run.toolPart = null;
            run.toolCard = null;
            run.toolStreaming = false;
            // 工具调用一开始输出就建卡片，参数随分片实时刷新
            const ensureToolCard = () => {
              if (run.toolPart) return;
              run.toolPart = { type: 'tools', calls: roundCalls };
              run.parts.push(run.toolPart);
              // 开始输出工具调用：本轮思考结束，之后的正文另起一段
              foldThink();
              run.answerEl = null;
              run.curText = null;
              run.toolStreaming = true;
              if (!run.bubble) return;
              clearPlaceholder();
              const card = toolCardEl(roundCalls, { done: false });
              const wrap = document.createElement('div');
              wrap.className = 'tool-wrap';
              wrap.appendChild(card.el);
              run.bubble.appendChild(wrap);
              run.toolCard = card;
            };
            const payload = customBody
              ? { raw: customBody, ...testParams() }
              : {
                  model: sentModel.id,
                  // 只发正文，思考内容和错误提示都不参与上下文
                  messages,
                  stream: streaming,
                  ...collectParams(),
                  ...testParams(),
                  ...(run.tools ? { tools: CHAT_TOOLS } : {}),
                };
            const res = await fetch('/api/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              signal: run.ctl.signal,
              body: JSON.stringify(payload),
            });
            if (!res.ok) {
              let msg = `HTTP ${res.status}`;
              try {
                const j = await res.json();
                msg = (j.error && j.error.message) || msg;
              } catch (e) { /* 响应不是 JSON，保留状态码 */ }
              throw new Error(msg);
            }
            // 请求体里的 stream 只代表意愿，真正决定解析方式的是上游实际返回的类型
            useStream = (res.headers.get('content-type') || '').toLowerCase().includes('text/event-stream');
            if (!useStream) {
              // 非流式：等完整响应，思考与正文一次性渲染
              const j = await res.json();
              run.roundUsage = snapshotUsage(run.roundUsage, j.usage);
              const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
              const reasoning = msg.reasoning_content || msg.reasoning || '';
              if (reasoning) addThink(reasoning);
              const content = flattenText(msg.content);
              if (content) addContent(content);
              if (Array.isArray(msg.tool_calls)) {
                msg.tool_calls.forEach((tc, i) => {
                  const fn = (tc && tc.function) || {};
                  roundCalls.push({
                    index: i,
                    id: (tc && tc.id) || '',
                    name: fn.name || '',
                    args: typeof fn.arguments === 'string'
                      ? fn.arguments
                      : (fn.arguments == null ? '' : JSON.stringify(fn.arguments)),
                  });
                });
              }
              // 非流式一次性拿到完整参数，也先建卡片再执行
              if (run.tools && roundCalls.length) ensureToolCard();
              scrollLog();
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
                  if (isAbort(e)) { run.stopped = true; break; }
                  throw e;
                }
                if (chunk.done) break;
                buf += decoder.decode(chunk.value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop();
                for (const line of lines) {
                  const t = line.trim();
                  if (!t.startsWith('data:')) continue;
                  const data = t.slice(5).trim();
                  if (data === '[DONE]') continue;
                  let j;
                  try { j = JSON.parse(data); } catch (e) { continue; }
                  if (j.usage) run.roundUsage = snapshotUsage(run.roundUsage, j.usage);
                  const d = j.choices && j.choices[0] && j.choices[0].delta;
                  if (!d) continue;
                  if (d.reasoning_content || d.content || d.tool_calls) {
                    const now = Date.now();
                    if (!run.firstTokenMs) run.firstTokenMs = now - t0;
                    if (!run.roundFirstAt) run.roundFirstAt = now;
                    run.roundLastAt = now;
                  }
                  if (d.reasoning_content) addThink(d.reasoning_content);
                  if (d.content) addContent(d.content);
                  if (Array.isArray(d.tool_calls)) {
                    for (const tc of d.tool_calls) {
                      // 标准实现每个分片都带 index；个别上游不带时按「属于上一个调用」处理，
                      // 避免把同一次调用的参数碎片拆成多个工具
                      const idx = Number.isInteger(tc && tc.index)
                        ? tc.index
                        : (roundCalls.length ? roundCalls[roundCalls.length - 1].index : 0);
                      let slot = roundCalls.find((x) => x.index === idx);
                      if (!slot) {
                        slot = { index: idx, id: '', name: '', args: '' };
                        roundCalls.push(slot);
                      }
                      if (tc.id) slot.id = tc.id;
                      const fn = tc.function || {};
                      // 名字通常只在第一块里出现，直接覆盖避免重复拼接
                      if (fn.name) slot.name = fn.name;
                      if (fn.arguments != null) {
                        slot.args += typeof fn.arguments === 'string'
                          ? fn.arguments
                          : JSON.stringify(fn.arguments);
                      }
                    }
                    // 参数是分片到达的，每来一片就刷新卡片上的参数文本
                    if (run.tools && roundCalls.length) {
                      ensureToolCard();
                      if (run.toolCard) run.toolCard.sync();
                    }
                  }
                }
                scrollLog();
              }
            }

            // 本轮收尾：用量并进总计（同一轮重复下发的 usage 只算最后一份），
            // 生成窗口也只累积本轮的吐字区间，下一轮重新计时。
            run.usage = mergeUsage(run.usage, run.roundUsage);
            run.roundUsage = null;
            if (run.roundLastAt > run.roundFirstAt) {
              run.genMs += run.roundLastAt - run.roundFirstAt;
            }
            run.roundFirstAt = 0;
            run.roundLastAt = 0;

            if (run.stopped || run.failed) break;
            // 没开工具、没有工具调用，或者已经达到轮数上限：结束本次生成
            if (!run.tools || !roundCalls.length) break;
            if (toolRounds >= MAX_TOOL_ROUNDS) break;

            // 执行工具：结果写回卡片并就地刷新，然后收起卡片
            const executed = roundCalls.map((c) => {
              const started = performance.now();
              const r = runChatTool(c.name, c.args);
              const ms = Math.max(0, Math.round(performance.now() - started));
              if (!c.id) c.id = 'call_' + uid();
              c.result = r.result;
              c.error = !r.ok;
              c.done = true;
              c.ms = ms;
              return {
                id: c.id,
                name: c.name,
                args: c.args,
                result: r.result,
                error: !r.ok,
                ms,
              };
            });
            run.toolLog.push(...executed);
            // 卡片在流式输出时已经插进气泡，这里只补结果并收起
            if (run.toolCard) {
              run.toolCard.sync({ done: true });
              run.toolCard.el.open = false;
            }
            run.toolPart = null;
            run.toolCard = null;
            run.toolStreaming = false;
            run.answerEl = null;
            run.curText = null;
            scrollLog();
            toolRounds += 1;
            messages = messages.concat([
              {
                role: 'assistant',
                content: run.roundText || null,
                tool_calls: executed.map((c) => ({
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: c.args || '{}' },
                })),
              },
              ...executed.map((c) => ({ role: 'tool', tool_call_id: c.id, content: c.result })),
            ]);
            // 等下一轮响应期间保持输入中的动画
            if (run.bubble) {
              clearPlaceholder();
              run.bubble.insertAdjacentHTML('beforeend', typingHtml);
            }
          }
        } catch (e) {
          if (isAbort(e)) run.stopped = true;
          else run.failed = e;
        }
        // 流式中断或达到轮数上限时，没执行的工具调用标记为未执行并收起
        if (run.toolCard) {
          run.toolCard.sync({ done: true });
          run.toolCard.el.open = false;
          run.toolCard = null;
        }
        run.toolStreaming = false;
        run.toolPart = null;
        // 无论成功、报错还是停止，都不应该再留着加载动画
        clearPlaceholder();
        // 只有出现过工具调用时才额外保存分段顺序，普通回复继续用 content
        const entryParts = run.parts.some((p) => p.type === 'tools') ? run.parts : null;
        // 没有工具调用时 parts 不落盘（正文已经在 content 里，再存一份太占空间），
        // 但思考耗时只存在 parts 上，得单独存一个数字，否则刷新后秒数就没了
        const thinkMsOf = () => {
          if (entryParts) return null;
          const thinks = run.parts.filter((p) => p && p.type === 'think' && p.text);
          if (!thinks.length) return null;
          return thinks.reduce((sum, p) => sum + (p.ms != null ? p.ms
            : (p.t0 ? Math.max(0, Date.now() - p.t0) : 0)), 0);
        };

        if (run.failed) {
          const errorText = '调用失败：' + (run.failed.message || run.failed);
          paintFailure(errorText);
          const entry = {
            role: 'assistant',
            content: run.answer,
            display: run.answer,
            error: errorText,
            model: sentModel.id,
          };
          if (run.think) {
            entry.think = run.think;
            const ms = thinkMsOf();
            if (ms != null) entry.think_ms = ms;
          }
          if (run.toolLog.length) entry.tool_calls = run.toolLog;
          if (entryParts) entry.parts = entryParts;
          if (customBody) entry.custom = true;
          if (sentModel.provider_icon) entry.provider_icon = sentModel.provider_icon;
          entry.meta = [[`模型 ${sentModel.id}`], ['调用失败'], [`总耗时 ${fmtDuration(Date.now() - t0)}`]];
          if (run.bubble) setMeta(run.bubble, entry.meta);
          return { ok: false, entry };
        }

        // 生成结束：最后一轮还在展开的思考块也收起来
        foldThink();
        if (!run.answer && !run.think && run.bubble) {
          if (run.toolLog.length) {
            // 气泡里已经有工具调用块，只补一行提示，不能整块覆盖
            const note = document.createElement('div');
            note.className = 'muted fs-12';
            note.textContent = run.stopped ? '（已停止生成）' : '（模型只调用了工具，没有返回正文）';
            run.bubble.appendChild(note);
          } else {
            run.bubble.textContent = run.stopped ? '（已停止生成）' : '（模型没有返回内容）';
            // 空气泡不是正常回复，用琥珀色和真正的回答区分开
            const msg = run.msgEl || run.bubble.closest('.msg');
            if (msg) msg.classList.add('msg--notice');
          }
        }

        const totalMs = Date.now() - t0;
        // 异常中断时本轮还挂着一份没并进总计的用量，展示时一并算上
        const usage = mergeUsage(run.usage, run.roundUsage);

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
          // 分母用真实吐字窗口（首块→末块），和网关日志的算法一致：
          // 「总耗时 - 首字」会把收尾的 usage 块、[DONE]、断开连接也算进去。
          // 窗口太短（上游一次性吐完）时不给速度，避免几万 t/s 这种没意义的数。
          const genMs = run.roundLastAt > run.roundFirstAt
            ? run.genMs + (run.roundLastAt - run.roundFirstAt)
            : run.genMs;
          if (useStream && usage.completion_tokens && genMs >= 50) {
            outputParts.push(`${(usage.completion_tokens * 1000 / genMs).toFixed(1)} t/s`);
          }
        }

        // 耗时组：首字、总耗时，总 token 跟在耗时后面
        const timingParts = [];
        if (run.firstTokenMs) timingParts.push(`首字 ${fmtDuration(run.firstTokenMs)}`);
        timingParts.push(`总耗时 ${fmtDuration(totalMs)}`);
        if (usage && usage.total_tokens) timingParts.push(`总token ${fmtInt(usage.total_tokens)}`);

        // 对话共用一份历史，所以在每条回复上标明用的是哪个模型
        const toolParts = run.toolLog.length ? [`工具调用 ${run.toolLog.length} 次`] : [];
        const metaGroups = [[`模型 ${sentModel.id}`], inputParts, outputParts, toolParts, timingParts]
          .filter((g) => g.length);
        if (run.stopped) metaGroups.push(['已停止生成']);
        if (run.bubble) setMeta(run.bubble, metaGroups);

        // 只把正文带回下一轮，思考内容、工具调用与统计信息单独存起来用于回看
        if (run.answer || run.think || run.toolLog.length) {
          const entry = { role: 'assistant', content: run.answer, model: sentModel.id };
          if (run.think) {
            entry.think = run.think;
            const ms = thinkMsOf();
            if (ms != null) entry.think_ms = ms;
          }
          if (run.toolLog.length) entry.tool_calls = run.toolLog;
          if (entryParts) entry.parts = entryParts;
          if (metaGroups.length) entry.meta = metaGroups;
          if (sentModel.provider_icon) entry.provider_icon = sentModel.provider_icon;
          if (customBody) entry.custom = true;
          return { ok: true, entry };
        }
        return { ok: true, entry: null };
      };

      const finishRun = (run, res) => {
        if (res && res.entry && !run.discarded && !run.unloadSaved) {
          // 自定义请求体模式下编辑器里的 JSON 是下一次请求的唯一来源，
          // 回复必须写回它的 messages，否则下一轮会用旧请求体覆盖本地历史。
          if (res.ok && run.customBody && res.entry.content) {
            const msgs = run.customBody.messages;
            if (Array.isArray(msgs)) {
              msgs.push({ role: 'assistant', content: res.entry.content });
              // 页面切走时编辑器已经不在文档里，回来会按历史重新生成
              if (customEditor.isConnected) {
                customEditor.value = JSON.stringify(run.customBody, null, 2);
                updateCustomHint();
              }
            }
          }
          history.push(res.entry);
          saveSessions();
        }
        if (chatStore.run === run) chatStore.run = null;
        const v = run.view;
        if (v && v.alive()) {
          if (res && res.entry && run.msgEl) v.addActions(run.msgEl, res.entry);
          v.setBusy(false);
          v.scroll();
        }
      };

      // 新建一次请求：历史快照、气泡和 run 都交给 chatStore，
      // 页面切走时只解绑 DOM，不取消 fetch。
      const startRun = async ({ messages, sentModel, customBody }) => {
        if (chatStore.run) return null;
        const run = {
          messages, sentModel, customBody,
          tools: !customBody && toolsOn,
          ctl: new AbortController(),
          t0: Date.now(), firstTokenMs: 0, usage: null,
          // 用量按「轮」收集：轮内取最后一次快照，轮与轮之间才相加；
          // genMs 只累加每轮真正在吐字的窗口，工具执行和中途等待不算进速度。
          roundUsage: null, roundFirstAt: 0, roundLastAt: 0, genMs: 0,
          think: '', answer: '', curThink: null, thinkTimer: null,
          // parts 是气泡的时间线：思考段、正文段与工具调用段按输出顺序排列
          parts: [], curText: null, roundText: '',
          toolLog: [], toolPart: null, toolCard: null, toolStreaming: false,
          stopped: false, failed: null,
          bubble: null, msgEl: null, view: null,
          thinkBlock: null, thinkBody: null, thinkMeta: null, answerEl: null,
          entry: null, discarded: false, unloadSaved: false,
        };
        chatStore.run = run;
        if (sentModel.type === 'test') {
          chatStore.model = TEST_MODEL_ID;
          persistChatModel(TEST_MODEL_ID);
          modelSel.value = TEST_MODEL_ID;
          chipModelSel.value = TEST_MODEL_ID;
          refreshMeta();
        } else if (usable.some((m) => m.id === sentModel.id)) {
          chatStore.model = sentModel.id;
          persistChatModel(sentModel.id);
          modelSel.value = sentModel.id;
          chipModelSel.value = sentModel.id;
          refreshMeta();
        }
        setBusy(true);
        const bubble = addMsg('assistant', '', false, sentModel.provider_icon);
        bubble.innerHTML = typingHtml;
        // 「正在输入」占位把气泡撑高了一点，贴底时再拉一次
        scrollToBottom(true);
        const res = await streamAssistant(run, bubble, view);
        finishRun(run, res);
        return res;
      };

      const retryAssistant = async (entry, msgEl) => {
        if (sending || chatStore.run) return;
        if (!ensureTestReady()) return;
        if (customMode) {
          if (!entry.custom) {
            Toast.info('自定义请求体模式下请直接编辑 JSON 后发送');
            return;
          }
          // 自定义请求体：移除这条错误，再用编辑器里的 JSON 重发
          const idx = history.indexOf(entry);
          if (idx >= 0) history.splice(idx);
          saveSessions();
          const all = [...log.querySelectorAll('.msg')];
          const pos = all.indexOf(msgEl);
          if (pos >= 0) all.slice(pos).forEach((el) => el.remove());
          await doSendCustom(true);
          return;
        }
        const idx = history.indexOf(entry);
        if (idx < 0) return;
        if (!ensureTestModel()) return;
        // 用当前选中的模型重试，而不是这条消息生成时的模型
        const sentModel = currentModel();
        // 重试点之后的消息全部丢弃，保证上下文连续
        history.splice(idx);
        saveSessions();
        const all = [...log.querySelectorAll('.msg')];
        const pos = all.indexOf(msgEl);
        if (pos >= 0) all.slice(pos).forEach((el) => el.remove());
        await startRun({ messages: chatContext(history), sentModel });
      };

      const doSend = async () => {
        if (customMode) {
          await doSendCustom(false);
          return;
        }
        const v = text.value.trim();
        if ((!v && !staged.length) || sending || chatStore.run) return;
        if (!ensureTestReady() || !ensureTestModel()) return;
        // 先固定本轮使用的模型，避免流式过程中切换模型导致头像/统计错位
        const sentModel = currentModel();
        const content = buildContent(v);
        const display = buildDisplay(v);
        text.value = '';
        text.style.height = 'auto';
        const bubble = addMsg('user', display);
        const entry = { role: 'user', content, display };
        history.push(entry);
        saveSessions();
        addMessageActions(bubble.closest('.msg'), entry);
        staged = [];
        renderStaged();
        await startRun({ messages: chatContext(history), sentModel });
      };

      // 自定义模式：编辑器里的 JSON 是唯一事实来源；输入框有文字时追加成一条 user 消息
      const doSendCustom = async (retry) => {
        if (sending || chatStore.run) return;
        if (!ensureTestReady()) return;
        let payload;
        try {
          payload = JSON.parse(customEditor.value);
        } catch (e) {
          Toast.error('自定义请求体 JSON 解析失败：' + e.message);
          return;
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          Toast.error('自定义请求体必须是一个 JSON 对象');
          return;
        }
        if (typeof payload.model !== 'string' || !payload.model) {
          Toast.error('自定义请求体缺少 model 字段');
          return;
        }
        if (!Array.isArray(payload.messages)) {
          Toast.error('自定义请求体缺少 messages 数组');
          return;
        }
        const typed = text.value.trim();
        if (typed) {
          payload.messages.push({ role: 'user', content: typed });
          customEditor.value = JSON.stringify(payload, null, 2);
          updateCustomHint();
        }
        const sentModel = isTestMode()
          ? { id: payload.model, provider_icon: '', type: 'test' }
          : (usable.find((m) => m.id === payload.model)
            || { id: payload.model, provider_icon: '', type: 'custom' });
        const shown = typed || lastUserContent(payload.messages) || '（自定义请求体）';
        text.value = '';
        text.style.height = 'auto';
        // 重试时不重复插入用户气泡，除非用户又输入了新内容
        const bubble = (!retry || typed) ? addMsg('user', shown) : null;
        // 让本地历史与请求体保持一致，切回普通模式后可以接着聊
        history.splice(0, history.length, ...payload.messages
          .filter((m) => m && typeof m === 'object' && (m.role === 'user' || m.role === 'assistant'))
          .map((m) => ({ role: m.role, content: m.content })));
        saveSessions();
        if (bubble) {
          // 刚插进去的气泡对应请求体里最后一条用户消息
          const lastUser = [...history].reverse().find((m) => m && m.role === 'user');
          if (lastUser) addMessageActions(bubble.closest('.msg'), lastUser);
        }
        await startRun({
          messages: chatContext(history), sentModel, customBody: payload,
        });
      };

      // ---------- 事件 ----------

      // 桌面端收起 / 展开设置栏；窄屏下改为抽屉开合
      const isNarrow = () => window.matchMedia('(max-width: 900px)').matches;
      // 右侧模型配置栏：桌面端往右收起，窄屏从右边滑出
      const setSideOpen = (on) => {
        if (isNarrow()) {
          layout.classList.toggle('is-settings-open', on);
          // 两个抽屉同时开只会叠成一团，开一边就把另一边收掉
          if (on) layout.classList.remove('is-conv-open');
        } else {
          layout.classList.toggle('is-settings-collapsed', !on);
          try { localStorage.setItem(SIDE_KEY, on ? '1' : '0'); } catch (e) { /* 忽略配额错误 */ }
        }
        syncEdges();
      };
      // 左侧对话列表：桌面端往左收起，窄屏从左边滑出
      const setConvOpen = (on) => {
        if (isNarrow()) {
          layout.classList.toggle('is-conv-open', on);
          if (on) layout.classList.remove('is-settings-open');
        } else {
          layout.classList.toggle('is-conv-collapsed', !on);
          try { localStorage.setItem(CONV_KEY, on ? '1' : '0'); } catch (e) { /* 忽略配额错误 */ }
        }
        syncEdges();
      };
      // 侧栏收起后，边缘留一个把手把面板再拉出来
      const syncEdges = () => {
        // 手机顶栏才是这排按钮的家：整条 chat-bar 挂进顶栏操作区；
        // 桌面上顶栏是藏起来的，挂回卡片里继续当定位容器
        if (isNarrow()) {
          if (chatBar.parentElement !== topbarActions) topbarActions.appendChild(chatBar);
        } else if (chatBar.parentElement !== card) {
          card.insertBefore(chatBar, layout);
        }
        // 手机顶栏的三个按钮常驻（左右展开随时可点，加号随时新建），
        // 位置由 CSS 排成两行；垃圾桶清空键手机上整块不出现
        if (isNarrow()) {
          convOpen.hidden = false;
          convEdgeNew.hidden = false;
          sideOpen.hidden = false;
          sideEdgeClear.hidden = true;
          return;
        }
        const convClosed = layout.classList.contains('is-conv-collapsed');
        const sideClosed = layout.classList.contains('is-settings-collapsed');
        convOpen.hidden = !convClosed;
        convEdgeNew.hidden = !convClosed;
        sideOpen.hidden = !sideClosed;
        // 配置栏收起时才在右边缘显示垃圾桶；展开时底部有清空按钮
        sideEdgeClear.hidden = !sideClosed;
      };
      // 窄屏下顶栏的把手是开关：面板已经开着就再点一下收起
      const toggleConvOpen = () => setConvOpen(isNarrow() ? !layout.classList.contains('is-conv-open') : true);
      const toggleSideOpen = () => setSideOpen(isNarrow() ? !layout.classList.contains('is-settings-open') : true);
      sideClose.onclick = () => setSideOpen(false);
      sideOpen.onclick = toggleSideOpen;
      sideScrim.onclick = () => setSideOpen(false);
      convCollapse.onclick = () => setConvOpen(false);
      convOpen.onclick = toggleConvOpen;
      // 收起状态边缘的新建按钮：直接开新对话，不用先把列表拉出来
      convEdgeNew.onclick = () => {
        if (convMulti.on) exitConvMulti();
        createSession();
        // 手机上新对话要能立刻看见，抽屉开着先收起
        if (isNarrow()) setConvOpen(false);
      };
      convScrim.onclick = () => setConvOpen(false);
      // 桌面 / 窄屏来回切换时，把手的显隐要跟着走
      window.addEventListener('resize', syncEdges);

      // 参数值变更与单项开关
      paramEls.forEach((row) => {
        row.input.addEventListener('input', () => {
          const raw = String(row.input.value).trim();
          paramValues[row.def.key] = raw === '' ? '' : Number(raw);
          row.value.textContent = raw === '' ? '—' : raw;
          persistParams();
        });
        row.enable.querySelector('input').onchange = () => {
          paramEnabled[row.def.key] = row.enable.querySelector('input').checked;
          syncParamRow(row);
          persistParams();
          focusText();
        };
      });

      // 恢复默认值与默认开关状态，并同步到本地存储
      paramsReset.onclick = () => {
        paramDefs.forEach((p) => {
          paramValues[p.key] = p.def;
          paramEnabled[p.key] = p.on;
          const row = paramEls.find((r) => r.def.key === p.key);
          if (row) row.input.value = String(p.def);
        });
        syncAllParams();
        persistParams();
        Toast.success('参数已恢复默认');
        focusText();
      };

      // 换模型只更新左侧的路由信息，已有的对话原样保留
      modelSel.onchange = () => {
        chipModelSel.value = modelSel.value;
        chatStore.model = modelSel.value;
        persistChatModel(modelSel.value);
        refreshMeta();
        focusText();
      };
      // 收起设置栏后，顶部下拉框也能直接换模型
      chipModelSel.onchange = () => {
        modelSel.value = chipModelSel.value;
        chatStore.model = modelSel.value;
        persistChatModel(modelSel.value);
        refreshMeta();
        focusText();
      };
      // 自定义请求体模式下点「已开启自定义请求体」提示芯片或流式开关，
      // 打开右侧配置栏，让自定义面板露出来
      chipsEl.addEventListener('click', (e) => {
        if (!customMode || sending) return;
        const hit = e.target.closest && (e.target.closest('#chat-chip-custom') || e.target.closest('#chat-chip-stream'));
        if (hit) setSideOpen(true);
      });

      // ---------- 临时测试 ----------

      testUrlInput.addEventListener('input', () => {
        testCfg.url = testUrlInput.value.trim();
        persistTestCfg();
        syncEmptyHint();
      });
      testKeyInput.addEventListener('input', () => {
        testCfg.key = testKeyInput.value;
        persistTestCfg();
      });
      testModelInput.addEventListener('input', () => {
        testCfg.model = testModelInput.value.trim();
        persistTestCfg();
        syncEmptyHint();
        // 手改输入框时下拉里的勾选跟着走，列表里没有就取消勾选
        const opts = Array.prototype.slice.call(testModelSelect.options);
        testModelSelect.selectedIndex = opts.findIndex((o) => o.value === testCfg.model);
      });

      // 上游返回模型列表后，在输入框右边挂一个下拉按钮（原生 select 被全局的
      // 自定义下拉接管了，触发器只留一个箭头）；输入框始终可以手动编辑。
      const showModelList = (models) => {
        const list = Array.from(new Set(models || []));
        if (!list.length) {
          testModelSelect.hidden = true;
          return;
        }
        testModelSelect.innerHTML = list
          .map((id) => `<option value="${esc(id)}">${esc(id)}</option>`)
          .join('');
        // 输入框里填的正好在列表里就选中它，否则不预选（避免下拉里打着一个对不上的勾）
        const cur = testModelInput.value.trim();
        testModelSelect.selectedIndex = cur && list.includes(cur) ? list.indexOf(cur) : -1;
        testModelSelect.hidden = false;
      };

      testModelSelect.addEventListener('change', () => {
        const picked = testModelSelect.value;
        if (!picked) return;
        // 选中即回填输入框，之后想改随时可以直接编辑
        testModelInput.value = picked;
        testCfg.model = picked;
        persistTestCfg();
        syncEmptyHint();
      });
      testEye.onclick = () => {
        // 和渠道的 Key 输入一致：用文本遮罩隐藏，不用 password 类型，
        // 避免浏览器把它当成登录密码并提示保存。
        const masked = testKeyInput.classList.toggle('key-masked');
        testEye.title = masked ? '显示 Key' : '隐藏 Key';
      };

      // 复用渠道的「探测」接口拉模型列表：同样不需要先保存渠道。
      const fetchTestModels = async () => {
        let url = testUrlInput.value.trim();
        if (!url) {
          Toast.error('请先填写 API 地址');
          testUrlInput.focus();
          return;
        }
        if (!url.includes('://')) url = 'https://' + url;
        // 用户可能直接填了完整端点，拉列表时回到基础地址
        const base = url.replace(/\/chat\/completions\/?$/i, '').replace(/\/+$/, '');
        // 地址末尾已经带版本段（/v1、/api/v3、/v1beta）时，不再自动补 /v1
        const appendV1 = !/\/v\d+[a-z0-9]*$/i.test(base);
        testFetchBtn.disabled = true;
        testStatus.textContent = '获取中…';
        try {
          const j = await API.post('/api/channels/discover', {
            type: 'openai',
            base_url: base,
            api_key: testKeyInput.value.trim(),
            append_v1: appendV1,
          });
          const models = (j && j.models) || [];
          if (models.length) {
            // 列表铺到右边的下拉按钮里，选中哪条就回填到左边的输入框
            showModelList(models);
            testStatus.textContent = `上游返回 ${models.length} 个模型`;
            Toast.success(`已获取 ${models.length} 个模型`);
          } else {
            // 没有列表就把下拉按钮收起来，输入框照常手填
            testModelSelect.hidden = true;
            testStatus.textContent = '上游没有返回模型，请手动填写';
            Toast.info('上游没有返回模型，请手动填写模型 ID');
          }
        } catch (e) {
          testStatus.textContent = '';
          Toast.error(e.message);
        } finally {
          testFetchBtn.disabled = sending;
        }
      };
      testFetchBtn.onclick = fetchTestModels;

      sendBtn.onclick = () => {
        if (sending) stopStream();
        else doSend();
      };
      // 左侧列表：新建对话（多选模式下先退出多选再建）
      convNew.onclick = () => {
        if (convMulti.on) exitConvMulti();
        createSession();
      };
      // 清空对话：点一下直接清，不再二次确认（配置栏底部按钮共用；
      // 配置栏收起时右边缘的垃圾桶也是这个动作，输入框里原来的清空芯片已移除）
      const clearChat = () => {
        const had = history.length;
        reset();
        if (had) Toast.success('已清空对话');
      };
      root.querySelector('#chat-side-edge-clear').onclick = clearChat;
      root.querySelector('#chat-clear').onclick = clearChat;
      text.addEventListener('keydown', (e) => {
        // 手机 / 平板上回车只是换行，必须点发送按钮才发出去
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
        if (isCoarsePointer) return;
        e.preventDefault();
        doSend();
      });
      text.addEventListener('input', () => {
        text.style.height = 'auto';
        text.style.height = Math.min(text.scrollHeight, 150) + 'px';
      });

      // 图片/附件入口
      pickImage.onclick = () => imageInput.click();
      pickFile.onclick = () => fileInput.click();
      imageInput.onchange = () => {
        addFiles(imageInput.files);
        imageInput.value = '';
      };
      fileInput.onchange = () => {
        addFiles(fileInput.files);
        fileInput.value = '';
      };

      // 粘贴图片或文件
      text.addEventListener('paste', (e) => {
        if (customMode) return;
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        const files = [];
        for (const it of items) {
          if (it.kind !== 'file') continue;
          const f = it.getAsFile();
          if (f) files.push(f);
        }
        if (files.length) {
          e.preventDefault();
          addFiles(files);
        }
      });

      // 拖拽到整个对话卡片
      let dragDepth = 0;
      card.addEventListener('dragenter', (e) => {
        if (!e.dataTransfer) return;
        const types = Array.from(e.dataTransfer.types || []);
        if (!types.includes('Files')) return;
        e.preventDefault();
        dragDepth += 1;
        card.classList.add('is-dragover');
      });
      card.addEventListener('dragover', (e) => {
        if (!e.dataTransfer) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      });
      card.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) card.classList.remove('is-dragover');
      });
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        dragDepth = 0;
        card.classList.remove('is-dragover');
        if (customMode) {
          Toast.info('自定义请求体模式下请直接编辑 JSON');
          return;
        }
        addFiles(e.dataTransfer && e.dataTransfer.files);
      });

      // 自定义请求体开关与编辑
      customSwitchInput.onchange = () => setCustomMode(customSwitchInput.checked);
      customEditor.addEventListener('input', updateCustomHintDebounced);
      root.querySelector('#chat-custom-format').onclick = () => {
        try {
          customEditor.value = JSON.stringify(JSON.parse(customEditor.value), null, 2);
          updateCustomHint();
          Toast.success('已格式化');
        } catch (e) {
          Toast.error('JSON 解析失败：' + e.message);
        }
      };
      root.querySelector('#chat-custom-reset').onclick = () => {
        syncCustomBody();
        Toast.success('已重置为当前对话');
      };

      // 页面切走时只解绑 DOM，不中断请求；后台继续生成并写入历史
      const view = {
        alive: () => log.isConnected,
        setBusy,
        addActions: (msgEl, entry) => addMessageActions(msgEl, entry),
        // 生成过程中的滚动只做「贴底跟随」：用户往上翻看时不再往回拽
        scroll: () => { scrollToBottom(false); },
      };
      chatStore.view = view;

      const onLeave = () => {
        if (routeObserver) routeObserver.disconnect();
        window.removeEventListener('resize', syncEdges);
        // 挂在顶栏里的那排把手不是本页的 DOM，切页时要自己收走
        if (chatBar.parentElement && chatBar.parentElement !== card) chatBar.remove();
        if (chatStore.view === view) chatStore.view = null;
        const run = chatStore.run;
        if (run && run.view === view) {
          run.view = null;
          run.bubble = null;
          run.msgEl = null;
          run.thinkBlock = run.thinkBody = run.thinkMeta = run.answerEl = null;
          run.toolCard = null;
          if (run.thinkTimer) {
            clearInterval(run.thinkTimer);
            run.thinkTimer = null;
          }
        }
      };
      window.addEventListener('hashchange', onLeave, { once: true });

      restore();
      setCustomMode(customMode);
      renderConvList();
      syncEdges();
      if (!isCoarsePointer) setTimeout(() => text.focus(), 120);
    },
  });

  // ======================================================================
  // 令牌管理
  // ======================================================================
  // 多选状态跨导航保留（与渠道 / 模型管理一致）
  const tokenListState = { multi: false, selected: new Set() };

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
        <div class="card tokens-card">
          ${tokens.length ? `
          <div class="filter-bar">
            <div class="filter-bar__leads">
              <span class="muted fs-12" id="token-count"></span>
            </div>
            <div class="filter-bar__batch" id="tk-batch" style="${tokenListState.multi ? '' : 'display:none'}">
              <span class="muted fs-12" id="token-multi-count">已选 ${tokenListState.selected.size} 个</span>
              <button class="filter-chip" id="tk-enable">${icon('play', 13)}启用</button>
              <button class="filter-chip" id="tk-disable">${icon('pause', 13)}禁用</button>
              <button class="filter-chip filter-chip--danger" id="tk-del">${icon('trash', 13)}删除</button>
            </div>
            <button class="filter-chip filter-chip--toggle" id="tk-multi" style="${tokenListState.multi ? 'display:none' : ''}">${icon('check', 13)}多选</button>
            <button class="filter-chip filter-chip--toggle filter-chip--ghost" id="tk-exit" style="${tokenListState.multi ? '' : 'display:none'}">${icon('x', 13)}退出多选</button>
          </div>` : ''}
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
      const countEl = root.querySelector('#token-count');

      const renderList = () => {
        if (!tokens.length) {
          if (countEl) countEl.textContent = '';
          listHost.innerHTML = emptyState('还没有创建密钥', '创建一个密钥，就能用它调用所有已启用的模型。',
            `<button class="btn btn--primary" id="e-token">${icon('plus', 15)}创建密钥</button>`, 'tokens');
          listHost.querySelector('#e-token').onclick = () => openTokenEditor(null);
          return;
        }
        const multi = tokenListState.multi;
        if (countEl) countEl.textContent = `共 ${tokens.length} 个`;

        listHost.innerHTML = `<div class="table-wrap table-wrap--flush">
        <table class="tbl">
          <thead><tr>
            ${multi ? '<th style="width:34px"><input type="checkbox" id="tk-checkall" aria-label="全选"></th>' : ''}
            <th>名称</th><th style="min-width:250px">密钥</th><th>状态</th>
            <th style="min-width:140px">用量</th><th>模型权限</th><th>IP 限制</th><th>最后使用</th>
            ${multi ? '' : '<th style="width:150px">操作</th>'}
          </tr></thead>
          <tbody>${tokens.map((t) => {
            const pct = t.used_pct || 0;
            return `<tr class="${multi ? 'is-selectable' : ''}" data-trowid="${esc(t.id)}">
              ${multi ? `<td><input type="checkbox" data-tksel data-tid="${esc(t.id)}" aria-label="选择 ${esc(t.name)}"></td>` : ''}
              <td>
                <div class="strong">${esc(t.name)}</div>
                ${t.remark ? `<div class="muted fs-12">${esc(t.remark)}</div>` : ''}
              </td>
              <td>
                <div class="flex-center gap-6">
                  <span class="mono" style="font-size:11.5px" data-key-mask>${esc(maskKey(t.key))}</span>
                  <button class="btn btn--ghost btn--sm btn--icon" data-tact="reveal" data-tid="${esc(t.id)}" title="显示 / 隐藏">${icon('eye', 12)}</button>
                  <button class="btn btn--ghost btn--sm btn--icon" data-tact="copy" data-tid="${esc(t.id)}" aria-label="复制密钥">${icon('copy', 12)}</button>
                </div>
              </td>
              <td>${t.expired ? badge('已过期', 'red') : (t.enabled ? statusBadge(true, '启用') : statusBadge(false, '', '禁用'))}</td>
              <td>
                <div class="num fs-12">${fmtNum(t.used_quota)}${t.quota_limit ? ` / ${fmtNum(t.quota_limit)}` : ' <span class="muted">/ 无限制</span>'}</div>
                ${t.quota_limit ? `<div class="rank-item__bar mt-8" style="height:6px"><div class="rank-item__fill" style="width:${pct}%;${pct > 90 ? 'background:var(--red-500)' : ''}"></div></div>` : ''}
              </td>
              <td>${!t.allowed_models || !t.allowed_models.length
                ? '<span class="muted fs-12">全部模型</span>'
                : `<div class="badge-group">${t.allowed_models.slice(0, 2).map((m) => badge(m, 'gray')).join('')}${t.allowed_models.length > 2 ? badge('+' + (t.allowed_models.length - 2), 'gray') : ''}</div>`}</td>
              <td>${!t.allowed_ips || !t.allowed_ips.length
                ? '<span class="muted fs-12">全部 IP</span>'
                : `<div class="badge-group">${t.allowed_ips.slice(0, 2).map((v) => badge(v, 'gray')).join('')}${t.allowed_ips.length > 2 ? badge('+' + (t.allowed_ips.length - 2), 'gray') : ''}</div>`}</td>
              <td class="muted fs-12 nowrap">${esc(relTime(t.last_used_at))}</td>
              ${multi ? '' : `<td>
                <div class="row-actions">
                  <button class="btn btn--sm btn--icon" data-tact="toggle" data-tid="${esc(t.id)}" title="${t.enabled ? '禁用' : '启用'}">${icon(t.enabled ? 'pause' : 'play', 13)}</button>
                  <button class="btn btn--sm btn--icon" data-tact="edit" data-tid="${esc(t.id)}" title="编辑">${icon('edit', 13)}</button>
                  <button class="btn btn--sm btn--icon btn--danger" data-tact="del" data-tid="${esc(t.id)}" title="删除">${icon('trash', 13)}</button>
                </div>
              </td>`}
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>`;

        // 多选模式：行勾选 / 表头全选 / 点击整行切换选中
        if (multi) {
          const syncBar = () => {
            const mc = root.querySelector('#token-multi-count');
            if (mc) mc.textContent = `已选 ${tokenListState.selected.size} 个`;
            const boxes = listHost.querySelectorAll('input[data-tksel]');
            const checked = [...boxes].filter((i) => i.checked);
            const checkall = listHost.querySelector('#tk-checkall');
            if (checkall) {
              checkall.checked = boxes.length > 0 && checked.length === boxes.length;
              checkall.indeterminate = checked.length > 0 && checked.length < boxes.length;
            }
          };
          listHost.querySelectorAll('input[data-tksel]').forEach((cb) => {
            cb.checked = tokenListState.selected.has(cb.dataset.tid);
            cb.closest('tr').classList.toggle('is-selected', cb.checked);
            cb.addEventListener('change', () => {
              if (cb.checked) tokenListState.selected.add(cb.dataset.tid);
              else tokenListState.selected.delete(cb.dataset.tid);
              cb.closest('tr').classList.toggle('is-selected', cb.checked);
              syncBar();
            });
          });
          // 点击整行切换选中；行内按钮和复选框自身不触发（避免双切）
          listHost.querySelector('tbody').addEventListener('click', (e) => {
            if (e.target.closest('button, a, input, .badge')) return;
            const tr = e.target.closest('tr[data-trowid]');
            if (!tr) return;
            const tid = tr.dataset.trowid;
            if (tokenListState.selected.has(tid)) tokenListState.selected.delete(tid);
            else tokenListState.selected.add(tid);
            const cb = tr.querySelector('input[data-tksel]');
            if (cb) cb.checked = tokenListState.selected.has(tid);
            tr.classList.toggle('is-selected', tokenListState.selected.has(tid));
            syncBar();
          });
          const checkall = listHost.querySelector('#tk-checkall');
          if (checkall) checkall.addEventListener('change', () => {
            listHost.querySelectorAll('input[data-tksel]').forEach((cb) => {
              cb.checked = checkall.checked;
              cb.closest('tr').classList.toggle('is-selected', checkall.checked);
              if (checkall.checked) tokenListState.selected.add(cb.dataset.tid);
              else tokenListState.selected.delete(cb.dataset.tid);
            });
            syncBar();
          });
          syncBar();
        }

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
      };

      renderList();

      // ---------- 多选模式（工具栏内切换按钮组，与渠道管理一致） ----------
      const applyMulti = () => {
        const set = (id, show) => {
          const el = root.querySelector('#' + id);
          if (el) el.style.display = show ? '' : 'none';
        };
        set('token-count', !tokenListState.multi);
        set('tk-batch', tokenListState.multi);
        set('tk-multi', !tokenListState.multi);
        set('tk-exit', tokenListState.multi);
        renderList();
      };
      const multiBtn = root.querySelector('#tk-multi');
      if (multiBtn) multiBtn.onclick = () => { tokenListState.multi = true; applyMulti(); };
      const exitBtn = root.querySelector('#tk-exit');
      if (exitBtn) exitBtn.onclick = () => {
        tokenListState.multi = false;
        tokenListState.selected.clear();
        applyMulti();
      };

      const getSelectedTokens = () => tokens.filter((t) => tokenListState.selected.has(t.id));
      // 批量操作后刷新数据，已删除密钥的选择会被清掉；多选模式保持
      const refreshAfterBatch = async () => {
        State.invalidate('tokens');
        await State.loadTokens(true);
        const live = new Set(State.tokens.map((t) => t.id));
        [...tokenListState.selected]
          .filter((id) => !live.has(id))
          .forEach((id) => tokenListState.selected.delete(id));
        window.LDM.navigate();
      };

      const batchToggle = async (enabled) => {
        const sel = getSelectedTokens().filter((t) => t.enabled !== enabled);
        if (!sel.length) {
          Toast.info(enabled ? '选中的密钥都已启用' : '选中的密钥都已禁用');
          return;
        }
        try {
          for (const t of sel) {
            await API.put('/api/tokens/' + t.id, { id: t.id, name: t.name, enabled });
          }
          Toast.success(`已${enabled ? '启用' : '禁用'} ${sel.length} 个密钥`);
          await refreshAfterBatch();
        } catch (e) { Toast.error(e.message); }
      };
      const enableBtn = root.querySelector('#tk-enable');
      if (enableBtn) enableBtn.onclick = () => batchToggle(true);
      const disableBtn = root.querySelector('#tk-disable');
      if (disableBtn) disableBtn.onclick = () => batchToggle(false);

      const delBtn = root.querySelector('#tk-del');
      if (delBtn) delBtn.onclick = async () => {
        const sel = getSelectedTokens();
        if (!sel.length) { Toast.info('请先勾选密钥'); return; }
        const ok = await confirmDialog({
          title: '删除密钥',
          message: `确定删除选中的 <b>${sel.length}</b> 个密钥吗？使用这些密钥的调用会立即失效。<br><br>该操作不可撤销。`,
          confirmText: `删除（${sel.length}）`, danger: true,
        });
        if (!ok) return;
        try {
          for (const t of sel) {
            await API.del('/api/tokens/' + t.id);
          }
          Toast.success(`已删除 ${sel.length} 个密钥`);
          await refreshAfterBatch();
        } catch (e) { Toast.error(e.message); }
      };
    },
  });

  // 与渠道管理的模型列表一致：换行、逗号、分号都能分隔，去空去重
  function parseModelNames(text) {
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

  async function openTokenEditor(token) {
    const isNew = !token;
    const t = token || { name: '', enabled: true, expires_at: 0, quota_limit: 0, allowed_models: [], allowed_ips: [], remark: '' };

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
        <div class="flex-center gap-8" style="margin-bottom:6px">
          <label class="field__label" style="margin-bottom:0">模型权限</label>
          <div class="ml-auto"></div>
          <button class="btn btn--sm" id="t-pick-models" type="button">${icon('models', 13)}选择模型</button>
        </div>
        <textarea class="textarea" id="t-models" rows="4" spellcheck="false" placeholder="每行一个，或用逗号分隔；留空表示可以使用全部模型&#10;gpt-4o&#10;claude-sonnet-4">${esc((t.allowed_models || []).join('\n'))}</textarea>
        <div class="field__hint">留空表示可以使用全部模型；可使用<code>*</code>通配符（如 <code>*deepseek*</code>、<code>deepseek*</code>、<code>*l*d*m*</code>）。也可以点「选择模型」勾选</div>
        <div class="mt-12" id="t-model-preview"></div>
      </div>
      <div class="field">
        <label class="field__label">IP 限制</label>
        <textarea class="textarea" id="t-ips" rows="3" spellcheck="false" placeholder="每行一条，例如：&#10;192.168.1.10&#10;10.0.0.0/8&#10;203.0.113.*">${esc((t.allowed_ips || []).join('\n'))}</textarea>
        <div class="field__hint">留空表示不限制来源 IP；支持单个 IP、CIDR 网段和 IPv4 尾部通配（如 192.168.*）。</div>
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
        const modelsEl = mo.body.querySelector('#t-models');
        const previewEl = mo.body.querySelector('#t-model-preview');
        const renderPreview = () => {
          const list = parseModelNames(modelsEl.value);
          previewEl.innerHTML = list.length
            ? `<div class="flex-center gap-8" style="margin-bottom:6px">
                 <div class="section-title" style="margin-bottom:0">共 ${list.length} 个模型</div>
                 <div class="ml-auto muted fs-12">点击模型名可复制</div>
               </div>
               <div class="badge-group">${list.map((m) => `<button type="button" class="badge badge--gray badge--click mono" data-copy-model="${esc(m)}">${esc(m)}</button>`).join('')}</div>`
            : '<span class="muted fs-12">全部模型</span>';
        };
        renderPreview();
        modelsEl.addEventListener('input', renderPreview);
        previewEl.addEventListener('click', (e) => {
          const el = e.target.closest('[data-copy-model]');
          if (el) copyText(el.dataset.copyModel, '模型名 ');
        });
        mo.body.querySelector('#t-pick-models').onclick = () => {
          if (!window.LDM.openModelPicker) { Toast.warn('模型选择弹窗暂不可用'); return; }
          window.LDM.openModelPicker({
            mode: 'models',
            title: '选择可用模型',
            desc: '从「模型管理」中已启用的模型里选择，结果会合并到手动填写的模型名里。不勾选表示可以使用全部模型。',
            top: true,
            preselected: new Set(parseModelNames(modelsEl.value)),
            onConfirm(ids, items, all) {
              // 手动填写但不在选择弹窗列表里的模型名（例如通配符 *）原样保留
              const known = new Set((all || []).map((it) => it.id));
              const manual = parseModelNames(modelsEl.value).filter((m) => !known.has(m));
              const merged = manual.concat(ids.filter((id) => !manual.includes(id)));
              modelsEl.value = merged.join('\n');
              renderPreview();
            },
          });
        };
        mo.foot.querySelector('[data-act=cancel]').onclick = () => mo.close();
        const copyBtn = mo.foot.querySelector('[data-act=copykey]');
        if (copyBtn) copyBtn.onclick = () => copyText(t.key, '密钥 ');
        mo.foot.querySelector('[data-act=save]').onclick = async () => {
          const name = mo.body.querySelector('#t-name').value.trim();
          if (!name) { Toast.warn('请填写名称'); return; }
          const expireVal2 = mo.body.querySelector('#t-expire').value;
          const payload = {
            id: t.id || '',
            name,
            enabled: mo.body.querySelector('#t-enabled').checked,
            expires_at: expireVal2 ? new Date(expireVal2 + 'T23:59:59').getTime() : 0,
            quota_limit: Number(mo.body.querySelector('#t-quota').value) || 0,
            allowed_models: parseModelNames(modelsEl.value),
            allowed_ips: mo.body.querySelector('#t-ips').value.split(/\r?\n/).map((v) => v.trim()).filter(Boolean),
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
  const LOG_UNIT_KEY = 'ldmapi.logs.unit';
  const logUnit = { on: true };
  try { logUnit.on = localStorage.getItem(LOG_UNIT_KEY) !== '0'; } catch (e) { /* 存储不可用时默认开启 */ }

  // 时间筛选预设。默认「今日 00:00 → 不限」，和看板的自然日口径一致；
  // 结束时间一律留空，靠后端“不传 end = 不限”保证切回页面时总能看到最新日志。
  const LOG_RANGES = [
    { key: 'today', label: '今日' },
    { key: 'yesterday', label: '昨日' },
    { key: '7d', label: '近 7 天' },
    { key: '30d', label: '近 30 天' },
    { key: 'all', label: '全部时间' },
    { key: 'custom', label: '自定义' },
  ];
  const pad2 = (n) => String(n).padStart(2, '0');
  const startOfToday = (offsetDays) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime() - (offsetDays || 0) * 86400000;
  };
  // 毫秒时间戳 → <input type="datetime-local"> 需要的本地时间字符串
  const toLocalInput = (ms) => {
    if (!ms) return '';
    const d = new Date(Number(ms));
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };
  // start / end 为 0 表示该端不限时间。
  // 今日 / 近 7 天 / 近 30 天的 end 一律留空：若写死成点击那一刻的时间戳，
  // 之后产生的日志就会被挡在区间外，切回页面时看不到最新记录。
  function rangeOfPreset(key) {
    if (key === 'today') return { start: startOfToday(0), end: 0 };
    if (key === 'yesterday') return { start: startOfToday(1), end: startOfToday(0) };
    if (key === '7d') return { start: startOfToday(6), end: 0 };
    if (key === '30d') return { start: startOfToday(29), end: 0 };
    if (key === 'all') return { start: 0, end: 0 };
    return null;
  }

  // 上一次「查询」真正生效的筛选条件；未点查询前下拉和时间的改动都只是草稿。
  // end 默认 0（空），表示不限结束时间，永远包含最新日志。
  const logState = {
    limit: 30, offset: 0, status: '', model: '', channel: '', token: '',
    start: startOfToday(0), end: 0, preset: 'today',
  };

  window.LDM.registerPage('logs', {
    title: '调用日志',
    desc: '每一次经过网关的请求都会记录在这里',
    async render(root, actions, filters) {
      const [models, channels, tokens] = await Promise.all([
        State.loadModels().catch(() => []),
        State.loadChannels().catch(() => []),
        State.loadTokens().catch(() => []),
      ]);

      // 单位开关与刷新放在页头，和「清空日志」同排；筛选控件全在顶栏木牌上
      actions.innerHTML = `
        ${switchEl(logUnit.on, '单位', 'id="log-unit" title="开启后 Token 数按 K / M / B 显示，悬停可查看精确值"')}
        <button class="btn btn--sm" id="btn-reload">${icon('refresh', 13)}刷新</button>
        <button class="btn btn--danger" id="btn-clear-logs">${icon('trash', 14)}清空日志</button>`;
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
          await runQuery();
        } catch (e) { Toast.error(e.message); }
      };

      // 筛选全部搬到顶栏木牌的第二行，页面上不再单独占一张筛选卡，
      // 省下来的高度全给表格。字段和「查询」按钮都还在这里，行为不变。
      filters.innerHTML = `
        <select class="select" id="f-model" style="width:auto;min-width:150px;max-width:208px">
          <option value="">全部模型</option>
        </select>
        <select class="select" id="f-channel" style="width:auto;min-width:118px;max-width:176px">
          <option value="">全部渠道</option>
        </select>
        <select class="select" id="f-token" style="width:auto;min-width:118px;max-width:176px">
          <option value="">全部令牌</option>
        </select>
        <select class="select" id="f-status" style="width:auto;min-width:104px">
          <option value="">全部状态</option>
          <option value="success">成功</option>
          <option value="error">失败</option>
          <option value="retry">有重试</option>
        </select>
        <span class="toolbar__sep"></span>
        <select class="select" id="f-preset" aria-label="时间范围" style="width:auto;min-width:96px">
          ${LOG_RANGES.map((r) => `<option value="${r.key}"${logState.preset === r.key ? ' selected' : ''}>${r.label}</option>`).join('')}
        </select>
        <input class="input log-time" id="f-start" type="datetime-local" aria-label="开始时间"
               value="${toLocalInput(logState.start)}" style="width:auto;min-width:158px">
        <span class="log-range-end">
          <span class="muted fs-12">至</span>
          <input class="input log-time" id="f-end" type="datetime-local" aria-label="结束时间"
                 title="留空表示不限结束时间，始终显示到最新一条"
                 value="${toLocalInput(logState.end)}" style="width:auto;min-width:158px">
        </span>
        <button class="btn btn--primary btn--sm" id="btn-query" title="按当前筛选条件查询">${icon('search', 13)}查询</button>`;

      // 分页栏贴底：表格卡撑满内容区
      root.classList.add('content__inner--fill');
      root.innerHTML = `
        <div class="logs-page">
          <div class="card logs-card">
            <div id="log-table">${loadingBlock()}</div>
            <div class="table-foot" style="padding:10px 16px">
              <span class="muted fs-12" id="log-total"></span>
              <button class="btn btn--sm" id="page-prev">上一页</button>
              <button class="btn btn--sm" id="page-next">下一页</button>
              <span class="table-foot__spacer"></span>
            </div>
          </div>
        </div>`;

      const q = (sel) => root.querySelector(sel) || filters.querySelector(sel) || actions.querySelector(sel);
      const channelName = {};
      channels.forEach((c) => { channelName[c.id] = c.name; });
      const tokenName = {};
      tokens.forEach((t) => { tokenName[t.id] = t.name; });
      const modelIDs = new Set(models.map((m) => m.id));
      const channelLabel = (id) => id + (channelName[id] ? `（${channelName[id]}）` : '');
      q('#f-status').value = logState.status;

      // ---- 筛选草稿 → 「查询」才真正生效 ----
      // 改动未生效时只在「查询」按钮右上角点一个小圆点（绝对定位，不占布局），
      // 免得提示文字把同一行的控件挤到下一行。
      let dirty = false;
      function markDirty(on) {
        dirty = on !== false;
        const btn = q('#btn-query');
        btn.classList.toggle('is-dirty', dirty);
        btn.title = dirty ? '筛选已修改，点此查询生效' : '按当前筛选条件查询';
      }

      // 下拉选项只列当前时间区间内实际出现过的取值：配置里删掉的历史模型
      // 只要区间内还有日志也照样可选，没有日志的配置项则不占位置。
      function fillSelect(sel, allLabel, items, labelOf) {
        const cur = sel.value;
        sel.innerHTML = `<option value="">${allLabel}</option>`
          + items.map((it) => `<option value="${esc(it.id)}">${esc(labelOf(it))}</option>`).join('');
        const keep = cur && items.some((it) => it.id === cur);
        sel.value = keep ? cur : '';
        return sel.value;
      }

      function facetQuery() {
        const params = new URLSearchParams();
        if (logState.start) params.set('start', logState.start);
        if (logState.end) params.set('end', logState.end);
        const qs = params.toString();
        return '/api/logs/facets' + (qs ? '?' + qs : '');
      }

      function syncFilterState() {
        logState.model = q('#f-model').value;
        logState.channel = q('#f-channel').value;
        logState.token = q('#f-token').value;
        logState.status = q('#f-status').value;
      }

      async function refreshFacets() {
        let facets = null;
        try { facets = await API.get(facetQuery()); } catch (e) { /* 拉不到就保留原选项 */ }
        if (facets) {
          fillSelect(q('#f-model'), '全部模型', facets.models || [],
            (m) => m.id + (modelIDs.has(m.id) ? '' : '（历史）'));
          fillSelect(q('#f-channel'), '全部渠道', facets.channels || [], (c) => {
            const name = c.name || channelName[c.id];
            return name ? `${c.id}（${name}）` : c.id;
          });
          fillSelect(q('#f-token'), '全部令牌', facets.tokens || [],
            (t) => t.name || tokenName[t.id] || t.id);
        }
        syncFilterState();
      }

      function readRange() {
        const startEl = q('#f-start').value;
        const endEl = q('#f-end').value;
        const start = startEl ? new Date(startEl).getTime() : 0;
        const end = endEl ? new Date(endEl).getTime() : 0;
        return { start: start || 0, end: end || 0 };
      }

      let querying = false;
      async function runQuery() {
        if (querying) return;
        const { start, end } = readRange();
        if (start && end && end < start) {
          Toast.error('结束时间不能早于开始时间');
          return;
        }
        querying = true;
        const btn = q('#btn-query');
        btn.disabled = true;
        try {
          logState.start = start;
          logState.end = end;
          logState.preset = q('#f-preset').value;
          logState.status = q('#f-status').value;
          logState.offset = 0;
          markDirty(false);
          await refreshFacets();
          await load();
        } finally {
          querying = false;
          btn.disabled = false;
        }
      }

      q('#btn-query').onclick = () => runQuery();
      q('#f-model').onchange = () => markDirty();
      q('#f-channel').onchange = () => markDirty();
      q('#f-token').onchange = () => markDirty();
      q('#f-status').onchange = () => markDirty();
      q('#f-preset').onchange = (e) => {
        const r = rangeOfPreset(e.target.value);
        if (!r) { markDirty(); return; } // 自定义：等用户改时间输入框
        q('#f-start').value = toLocalInput(r.start);
        q('#f-end').value = toLocalInput(r.end);
        markDirty();
      };
      ['#f-start', '#f-end'].forEach((sel) => {
        const el = q(sel);
        el.onchange = () => {
          q('#f-preset').value = 'custom';
          markDirty();
        };
        el.onkeydown = (e) => {
          if (e.key === 'Enter') { e.preventDefault(); runQuery(); }
        };
      });
      q('#btn-reload').onclick = () => runQuery();
      const unitInput = q('#log-unit').querySelector('input');
      unitInput.onchange = () => {
        logUnit.on = unitInput.checked;
        try { localStorage.setItem(LOG_UNIT_KEY, logUnit.on ? '1' : '0'); } catch (e) { /* 忽略配额错误 */ }
        renderTable();
      };
      // 筛选改过没点查询就翻页时，先按新条件查第一页，避免翻出来的是旧条件的结果
      const turnPage = (dir) => {
        if (dirty) { runQuery(); return; }
        const next = logState.offset + dir * logState.limit;
        logState.offset = Math.max(0, next);
        load();
      };
      q('#page-prev').onclick = () => turnPage(-1);
      q('#page-next').onclick = () => turnPage(1);

      // 重试历史和 Key 下钻的两个弹窗已提到模块顶部（showRetryHistory /
      // showKeyRetryHistory），看板里点重试徽章走的是同一份实现。

      let lastItems = null; // null 表示最近一次加载失败，切换单位时保持当前内容
      // 开启「单位」后把 token 数缩写为 K / M / B，悬停仍显示精确值。
      // 「(估算)」标记在共用的 logRowHtml 里跟着数值一起出，这里只管格式。
      const tok = (n) => (logUnit.on
        ? `<span title="${fmtInt(n)}">${fmtUnit(n)}</span>`
        : fmtInt(n));

      function renderTable() {
        // 重绘会换掉标记节点，气泡跟着收掉，别让它悬在旧位置上
        window.LDM.tip.hide();
        if (lastItems == null) return;
        const host = q('#log-table');
        const items = lastItems;
        if (!items.length) {
          const emptyDesc = logState.status === 'error'
            ? '当前只看失败请求，把状态筛选切回「全部状态」试试。'
            : logState.status === 'success'
              ? '当前只看成功请求，把状态筛选切回「全部状态」试试。'
              : logState.status === 'retry'
                ? '当前只看发生过重试的请求，把状态筛选切回「全部状态」试试。'
                : '发起一次 API 调用后就能在这里看到记录。';
          host.innerHTML = emptyState('没有符合条件的日志', emptyDesc, '', 'logs');
          return;
        }
        // 表和行都走共用的 logTableHtml：和看板「最近调用」是同一张表、同一套徽章，
        // 点模型 / 渠道 / 令牌 / IP 都能直接复制，重试徽章点开也是同一份重试历史。
        host.innerHTML = `<div class="table-wrap table-scroll table-wrap--flush">${logTableHtml(items, {
          num: tok,
          channel: (l) => channelLabel(l.channel_id),
        })}</div>`;
        bindLogRows(host, items);
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
        if (logState.start) params.set('start', logState.start);
        if (logState.end) params.set('end', logState.end);
        try {
          const res = await API.get('/api/logs?' + params.toString());
          const items = res.items || [];
          lastItems = items;
          const total = res.total || 0;
          q('#log-total').textContent = total
            ? `共 ${fmtInt(total)} 条，当前显示第 ${logState.offset + 1} - ${logState.offset + items.length} 条`
            : '共 0 条';
          q('#page-prev').disabled = logState.offset === 0;
          q('#page-next').disabled = logState.offset + items.length >= res.total;
          renderTable();
        } catch (e) {
          lastItems = null;
          host.innerHTML = `<div class="card--pad"><div class="alert alert--warn">${icon('alert', 15)}<div>${esc(e.message)}</div></div></div>`;
        }
      }

      await runQuery();
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

      const fmtMem = (n) => {
        n = Number(n) || 0;
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
        return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
      };

      const BACKUP_SCOPES = [
        ['channels', '渠道配置', '含明文上游 Key'],
        ['models', '模型配置', '路由与能力参数'],
        ['providers', '提供商', '名称、图标与匹配词'],
        ['tokens', 'API 密钥', '含明文 Key'],
        ['settings', '系统设置', '站点信息与密码哈希'],
        ['logs', '调用日志', '数据量大时较慢'],
        ['stats', '统计数据', '按小时聚合'],
      ];
      const BACKUP_LABELS = Object.fromEntries(BACKUP_SCOPES.map(([key, label]) => [key, label]));

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
                <div class="field__hint">留空则不显示，浏览器标题也只留站点名称。</div>
              </div>
              <div class="field">
                <label class="field__label">站点图标</label>
                <div class="input-group">
                  <input class="input mono" id="s-logo" value="${esc(settings.logo || '')}"
                         placeholder="留空使用默认图标，也可填图片直链">
                  <span class="brand__logo" id="s-logo-preview" style="width:36px;height:36px" aria-label="预览"></span>
                </div>
                <div class="field__hint">支持任意图片直链（<code>https://…</code>）或 data URI；留空则用内置默认图标。</div>
              </div>
              <div class="field">
                <label class="field__label">外观主题</label>
                <div class="tristate" id="s-theme">
                  <div class="tristate__opt ${Theme.get() === 'light' ? 'is-on' : ''}" data-value="light">浅色</div>
                  <div class="tristate__opt ${Theme.get() === 'dark' ? 'is-on' : ''}" data-value="dark">深色</div>
                </div>
                <div class="field__hint">默认浅色主题（林间木色）。此处的选择会立即生效并记住。</div>
              </div>
              <div class="field">
                <label class="field__label">日志保留天数</label>
                <input class="input" id="s-retention" type="number" min="0" value="${settings.log_retention_days || 0}" placeholder="0 表示永久保留">
                <div class="field__hint">超过天数的调用日志与统计数据会被自动清理；0 表示永久保留。</div>
              </div>
              <div class="field">
                <label class="field__label">API 跨域白名单</label>
                <input class="input mono" id="s-cors" value="${esc(settings.allow_origins || '')}"
                       placeholder="留空允许所有来源访问 /v1 接口">
                <div class="field__hint">限制浏览器跨域调用 <code>/v1</code> 接口的来源，多个用逗号分隔，例如 <code>https://a.com, https://b.com</code>；<code>*</code> 或留空表示不限制。不影响 curl 等非浏览器调用。</div>
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
            <div><div class="card__title">备份导出</div><div class="card__sub">写入服务器本地 JSON，不经浏览器下载</div></div>
            <div class="card__actions">
              <label class="backup-check backup-check--all">
                <input type="checkbox" id="backup-all"><span><b>全选</b></span>
              </label>
            </div>
          </div>
          <div class="card__body">
            <div class="backup-scopes" id="backup-scopes">
              ${BACKUP_SCOPES.map(([key, label, hint]) => `
                <label class="backup-check">
                  <input type="checkbox" value="${key}">
                  <span><b>${label}</b><em>${hint}</em></span>
                </label>`).join('')}
            </div>
            <div class="alert alert--warn mt-12">
              ${icon('alert', 15)}
              <div>
                文件写入在运行网关的设备上（数据目录下的 <code>backups</code> 文件夹），
                为确保安全性，<b>无法通过浏览器下载</b>。文件包含明文上游 Key 和 API 密钥，请妥善保管。
                导出期间会暂停所有数据写入，直到导出完成。
              </div>
            </div>
            <div class="btn-row mt-12">
              <button class="btn btn--primary" id="backup-export">${icon('file', 14)}导出备份</button>
              <select class="select" id="backup-indent" aria-label="JSON 缩进" style="width:auto;min-width:132px">
                <option value="0">紧凑（无缩进）</option>
                <option value="2" selected>2 空格缩进</option>
                <option value="4">4 空格缩进</option>
              </select>
              <span class="muted fs-12">远程部署时请通过 SSH / SFTP 到该路径取回文件</span>
            </div>
            <div id="backup-result"></div>
          </div>
        </div>

        <div class="card mt-16">
          <div class="card__head">
            <div><div class="card__title">运行信息</div><div class="card__sub">当前实例状态</div></div>
          </div>
          <div class="card__body">
            <div class="stat-grid stat-grid--4" style="margin-bottom:0">
              <a class="stat stat--link" href="${esc(REPO_URL)}/releases" target="_blank" rel="noopener noreferrer" title="在 GitHub 查看发布记录">
                <div class="stat__label">版本</div>
                <div class="stat__value" style="font-size:19px">v${esc(me.version)}</div>
              </a>
              <div class="stat">
                <div class="stat__label">运行时间</div>
                <div class="stat__value" style="font-size:19px">${esc(fmtUptime(me.uptime_seconds))}</div>
              </div>
              <div class="stat">
                <div class="stat__label">系统</div>
                <div class="stat__value" style="font-size:19px">${esc(me.system || '—')}</div>
              </div>
              <div class="stat">
                <div class="stat__label">内存占用</div>
                <div class="stat__value" style="font-size:19px">${esc(fmtMem(me.memory_bytes))}${Number(me.memory_total_bytes) > 0 ? ` <small>/ ${esc(fmtMem(me.memory_total_bytes))}</small>` : ''}</div>
              </div>
            </div>
          </div>
        </div>

        <div class="card mt-16">
          <div class="card__body" style="display:flex;align-items:center;justify-content:center;gap:5px;padding:14px 20px">
            <span class="muted fs-12">设计与开发由</span>
            <a href="https://github.com/landamao" target="_blank" rel="noopener noreferrer" class="strong">懒大猫</a>
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

      // 导出范围：全选框跟随子项状态，部分选中时显示为半选。
      const scopeInputs = Array.from(q('#backup-scopes').querySelectorAll('input[type="checkbox"]'));
      const allInput = q('#backup-all');
      const syncAll = () => {
        const checked = scopeInputs.filter((x) => x.checked).length;
        allInput.checked = checked === scopeInputs.length;
        allInput.indeterminate = checked > 0 && checked < scopeInputs.length;
      };
      allInput.onchange = () => {
        scopeInputs.forEach((x) => { x.checked = allInput.checked; });
        syncAll();
      };
      scopeInputs.forEach((x) => { x.onchange = syncAll; });
      syncAll();

      q('#backup-export').onclick = async () => {
        const scopes = scopeInputs.filter((x) => x.checked).map((x) => x.value);
        if (!scopes.length) {
          Toast.warn('请至少选择一个导出范围');
          return;
        }
        const btn = q('#backup-export');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner" style="width:13px;height:13px"></span>导出中';
        try {
          const indent = Number(q('#backup-indent').value) || 0;
          const res = await API.post('/api/backup/export', { scopes, indent });
          const counts = res.counts || {};
          const parts = Object.keys(counts)
            .map((key) => `${BACKUP_LABELS[key] || key} ${fmtInt(counts[key])}`);
          q('#backup-result').innerHTML = `
            <div class="backup-result">
              <div class="backup-result__head">${icon('check', 15)}<span>已导出 ${esc(res.file)}</span></div>
              <div class="backup-result__path mono">${esc(res.path)}</div>
              <div class="backup-result__meta">${fmtMem(res.size)}${parts.length ? ' · ' + esc(parts.join(' · ')) : ''}</div>
              <div class="btn-row mt-8">
                <button class="btn btn--sm" id="backup-copy">${icon('copy', 12)}复制路径</button>
              </div>
            </div>`;
          q('#backup-copy').onclick = () => copyText(res.path, '备份路径');
          Toast.success('备份已写入服务器本地');
        } catch (e) {
          Toast.error(e.message, '导出失败');
        } finally {
          btn.disabled = false;
          btn.innerHTML = window.LDM.icon('file', 14) + '导出备份';
        }
      };

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
            allow_origins: q('#s-cors').value.trim(),
          });
          Toast.success('设置已保存');
          window.LDM.applyLogo(q('#s-logo').value.trim());
          // 牌匾和浏览器标题立刻跟着变，不用刷新
          window.LDM.applyBrand(q('#s-name').value.trim(), q('#s-sub').value.trim());
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
