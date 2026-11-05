/* ==========================================================================
   懒大猫 API · 轻量 SVG 图表（零依赖）
   ========================================================================== */
(function () {
  'use strict';

  const { esc, fmtInt, fmtNum } = window.LDM;

  const PALETTE = ['#4d9e2f', '#e9a316', '#3f8fbf', '#8a5ac2', '#d9557f', '#7cc243', '#c9483a', '#5f9e8b'];

  // 坐标轴上限：挑一个刚好装得下数据的「漂亮数」。
  // 上限挑得太高就会出现「数据最高 66、上限却到 100」这种上面一大截全空的情况，
  // 所以步长在 1 / 1.5 / 2 / 2.5 / 3 / 4 / 5 / 6 / 7 / 8 / 9 / 10 里逐档试，
  // 刻度段数在 4 段和 5 段之间挑更贴合的一个，步长为整数的优先。
  function niceScale(v, wantTicks) {
    if (!(v > 0)) return { max: 4, ticks: wantTicks, step: 4 / wantTicks };
    const cands = [];
    for (const ticks of [wantTicks, wantTicks + 1]) {
      const exp = Math.floor(Math.log10(v / ticks));
      const base = Math.pow(10, exp);
      for (const mult of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9, 10]) {
        const step = mult * base;
        const top = step * ticks;
        if (top < v) continue;
        cands.push({ top, ticks, step });
      }
    }
    if (!cands.length) return { max: 4, ticks: wantTicks, step: 4 / wantTicks };
    cands.sort((a, b) => {
      const ai = Number.isInteger(a.step) ? 0 : 1;
      const bi = Number.isInteger(b.step) ? 0 : 1;
      return (ai - bi) || (a.top - b.top) || (a.ticks - b.ticks);
    });
    const best = cands[0];
    // 上限不低于 4，免得数据很少时坐标轴挤成一小截
    if (best.top < 4) return { max: 4, ticks: 4, step: 1 };
    return { max: best.top, ticks: best.ticks, step: best.step };
  }

  function fmtAxis(v) {
    if (v >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(Math.round(v));
  }

  // 看板时间统一按北京时间展示，与后端统计区间一致。
  const BJ_OFFSET = 8 * 3600 * 1000;

  function timeLabel(ms, spanMs) {
    const d = new Date(ms + BJ_OFFSET);
    const p = (x) => String(x).padStart(2, '0');
    if (spanMs > 36 * 3600 * 1000) return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }

  // 全局 tooltip 单例
  let tipEl = null;
  function tip() {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'chart-tip';
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }
  // 图表重绘 / 切换单位时旧 tooltip 不会收到 mouseleave，需要手动收起
  function hideTip() {
    if (tipEl) tipEl.classList.remove('is-on');
  }

  // ---- 名字气泡：省略号截断之后看全名 ----------------------------------
  // 环形图图例、排行条里的名字（模型名、渠道名）宽度不够就被省略号截断，
  // 截断之后全名彻底没地方看。这里给「确实被截断」的那些名字挂一枚气泡：
  // 有鼠标的悬停弹出、键盘 Tab 到就弹出、触屏点一下弹出，点别处 / 切页收起。
  // 气泡挂在 body 上 fixed 定位（表格、卡片都可能裁内容），滚动时跟着名字走——
  // 手机上点完常有惯性滚动，直接收起会像「点了没反应」。
  let nameTipEl = null;
  let nameTipFor = null;
  let nameTipRaf = 0;
  const canHover = !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);

  function nameTip() {
    if (!nameTipEl) {
      nameTipEl = document.createElement('div');
      nameTipEl.className = 'chart-tip chart-tip--name';
      document.body.appendChild(nameTipEl);
    }
    return nameTipEl;
  }

  function hideNameTip() {
    if (!nameTipEl) return;
    nameTipEl.classList.remove('is-on');
    nameTipFor = null;
  }

  function placeNameTip() {
    if (!nameTipFor || !nameTipEl) return;
    const el = nameTipFor;
    if (!el.isConnected) { hideNameTip(); return; }
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    if (r.bottom < 4 || r.top > vh - 4) { hideNameTip(); return; }
    const w = nameTipEl.offsetWidth, h = nameTipEl.offsetHeight;
    const left = Math.min(Math.max(8, r.left), Math.max(8, vw - w - 8));
    let top = r.bottom + 7;
    if (top + h > vh - 8 && r.top - h - 7 >= 8) top = r.top - h - 7;
    nameTipEl.style.left = `${Math.round(left)}px`;
    nameTipEl.style.top = `${Math.round(top)}px`;
  }

  function queuePlaceNameTip() {
    if (!nameTipFor || nameTipRaf) return;
    nameTipRaf = requestAnimationFrame(() => {
      nameTipRaf = 0;
      placeNameTip();
    });
  }

  function showNameTip(el) {
    const name = (el.dataset.name || el.textContent || '').trim();
    if (!name) return;
    const t = nameTip();
    t.textContent = name;
    nameTipFor = el;
    t.classList.add('is-on');
    placeNameTip();
  }

  // 只有真被截断才挂：短名字一悬停就冒气泡反而吵。
  // 判断靠 scrollWidth / clientWidth，所以必须在节点已经进文档之后再调。
  function bindNameTips(root) {
    if (!root) return;
    Array.prototype.forEach.call(root.querySelectorAll('[data-name]'), (el) => {
      if (el.scrollWidth <= el.clientWidth + 1) return;
      el.classList.add('chart-name--clip');
      if (canHover) {
        el.tabIndex = 0;
        el.addEventListener('pointerenter', (e) => {
          if (e.pointerType === 'touch') return;
          showNameTip(el);
        });
        el.addEventListener('pointerleave', (e) => {
          if (e.pointerType === 'touch') return;
          hideNameTip();
        });
        el.addEventListener('focus', () => showNameTip(el));
        el.addEventListener('blur', hideNameTip);
      } else {
        // 没有悬停：点一下弹出，再点一下收起
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          if (nameTipFor === el) hideNameTip();
          else showNameTip(el);
        });
      }
    });
  }

  document.addEventListener('click', (e) => {
    if (!nameTipFor) return;
    if (e.target && e.target.closest && e.target.closest('[data-name]')) return;
    hideNameTip();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideNameTip();
  });
  window.addEventListener('scroll', queuePlaceNameTip, true);
  window.addEventListener('resize', queuePlaceNameTip);
  window.addEventListener('hashchange', hideNameTip);

  // 系统开了「减少动态效果」或页面在后台时不播动画：直接落在终态。
  // 后台标签页里 rAF 不触发，动画会一直停在「没画出来」的样子。
  function motionOff() {
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    return !!reduce || (typeof document !== 'undefined' && document.hidden);
  }

  // 动画统一走 WAAPI：一次启动，之后每帧的事由浏览器自己排，主线程不再参与。
  // 以前是 rAF 里逐帧写 strokeDashoffset —— 切一次看板要重算上百次样式，
  // 曲线多的时候主线程一直在忙，看起来就是页面「卡一下」。
  const EASE = 'cubic-bezier(.34,.12,.22,1)';
  function canAnimate(el) { return typeof el.animate === 'function'; }

  /**
   * 折线从左到右画出来：给每条 path 设置 dasharray，用 dashoffset 从全长收到 0。
   * 面积块同步淡入。多条曲线时按顺序错开一点，层次更清楚。
   */
  function animateLines(svg, dur, stagger) {
    const paths = Array.from(svg.querySelectorAll('path.line'));
    const areas = Array.from(svg.querySelectorAll('path.area'));
    const dots = Array.from(svg.querySelectorAll('circle.dot'))
      .filter((c) => !(c.parentElement && c.parentElement.classList.contains('hover-group')));
    if (!paths.length) return;
    const gap = stagger || 0;
    if (motionOff()) return;
    const lens = paths.map((p) => {
      let len = 0;
      try { len = p.getTotalLength(); } catch (e) { len = 0; }
      return len;
    });
    // 面积块 / 数据点各设一次过渡就够，别放到动画循环里反复写 style
    areas.forEach((a) => { a.style.transition = 'opacity .45s ease-out'; a.style.opacity = '0'; });
    // 数据点跟着曲线走，线画到哪它再亮到哪
    dots.forEach((d) => {
      d.style.opacity = '0';
      d.style.transition = `opacity .35s ease-out ${(dur / 1000) * 0.45}s`;
    });
    requestAnimationFrame(() => {
      areas.forEach((a) => { a.style.opacity = ''; });
      dots.forEach((d) => { d.style.opacity = ''; });
    });

    const anims = [];
    paths.forEach((p, i) => {
      if (!lens[i]) return;
      // 不支持 WAAPI 的浏览器别挂 dash 样式了，曲线直接显示；挂上线也不会动，等一秒才露脸更怪
      if (!canAnimate(p)) return;
      p.style.strokeDasharray = `${lens[i]} ${lens[i]}`;
      p.style.strokeDashoffset = String(lens[i]);
      // 后面的曲线依次晚一点起笔
      anims.push(p.animate(
        [{ strokeDashoffset: String(lens[i]) }, { strokeDashoffset: '0' }],
        { duration: dur, delay: i * gap, easing: EASE, fill: 'both' }
      ));
    });
    // 收尾统一还原样式；定时器还兼作兜底，动画没跑起来时曲线也一定会显示出来
    const finish = () => {
      anims.forEach((a) => { try { a.cancel(); } catch (e) { /* 已结束 */ } });
      paths.forEach((p) => { p.style.strokeDasharray = ''; p.style.strokeDashoffset = ''; });
      areas.forEach((a) => { a.style.transition = ''; a.style.opacity = ''; });
      dots.forEach((d) => { d.style.transition = ''; d.style.opacity = ''; });
    };
    setTimeout(finish, dur + gap * (paths.length - 1) + 400);
  }

  /**
   * 环形图顺时针扫出来：每段弧从自己起点开始由 0 长到该有的长度，按顺序错开起笔；
   * 中心合计数字从 0 跳到合计。
   * 弧的动画同样交给 WAAPI 一次启动，主线程只负责那 0.2s 的数字。
   */
  function animateDonut(svg, dur, stagger, countOpt) {
    const arcs = Array.from(svg.querySelectorAll('circle.donut-arc'));
    if (!arcs.length) return;
    if (motionOff()) return;

    const circ = Number(arcs[0].getAttribute('data-circ')) || 0;
    if (!(circ > 0)) return;
    const gap = stagger || 0;
    // 记下每段弧的终态长度，动画结束后清掉内联样式还原
    const spans = arcs.map((a) => ({
      el: a,
      len: Number(a.getAttribute('data-len')) || 0,
    }));

    // 最后一段收笔的时刻
    const span = dur + gap * Math.max(0, spans.length - 1);
    const anims = [];
    spans.forEach((s, i) => {
      s.el.style.strokeDasharray = `0 ${circ.toFixed(2)}`;
      if (!canAnimate(s.el)) {
        s.el.style.strokeDasharray = `${s.len.toFixed(2)} ${(circ - s.len).toFixed(2)}`;
        return;
      }
      anims.push(s.el.animate([
        { strokeDasharray: `0 ${circ.toFixed(2)}` },
        { strokeDasharray: `${s.len.toFixed(2)} ${(circ - s.len).toFixed(2)}` },
      ], { duration: dur, delay: i * gap, easing: EASE, fill: 'both' }));
    });
    const finish = () => {
      anims.forEach((a) => { try { a.cancel(); } catch (e) { /* 已结束 */ } });
      // 清掉内联样式，让属性上的原始 dasharray 生效
      spans.forEach((s) => { s.el.style.strokeDasharray = ''; });
      if (countOpt && countOpt.text) countOpt.text.textContent = countOpt.fmt(countOpt.total);
    };
    // 收尾兜底：后台标签页里 rAF 会被拖慢，这条保证环和数字一定会落到终态
    setTimeout(finish, span + 600);

    // 数字不跟着整段扫环慢慢数：环一段要 1s，数字一直往上蹦看着太急，
    // 这里让它 0.2s 就落定，之后环继续扫、数字不再变。
    const countDur = Math.min(200, span);
    const start = performance.now();
    const step = (now) => {
      // rAF 的时间戳可能早于 start（帧起点），这里要夹一下，否则数字会先跳到负数
      const t = Math.min(1, Math.max(0, (now - start) / countDur));
      const e = 1 - Math.pow(1 - t, 3); // 缓出，起步快收尾稳
      if (countOpt && countOpt.text) countOpt.text.textContent = countOpt.fmt(Math.round(countOpt.total * e));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /**
   * 面积折线图
   * opts: { labels:[string], series:[{name,color,values:number[],unit}], height, spanMs, valueFmt }
   */
  function areaChart(container, opts) {
    const { labels = [], series = [], height = 210, spanMs = 86400000 } = opts;
    const valueFmt = opts.valueFmt || ((v) => fmtInt(v));
    const axisFmt = opts.axisFmt || fmtAxis;

    function draw(animate) {
      const W = Math.max(container.clientWidth || 600, 320);
      const H = height;
      const padR = 14, padT = 14, padB = 26;

      let max = 0;
      series.forEach((s) => s.values.forEach((v) => { if (v > max) max = v; }));
      const scale = niceScale(max, 4);
      max = scale.max;

      // 坐标轴标签会随单位设置变长（例如 1,000,000），左侧留白按最长标签自动加宽
      const ticks = scale.ticks;
      const tickVals = [];
      for (let i = 0; i <= ticks; i++) tickVals.push((max / ticks) * i);
      const tickTexts = tickVals.map((v) => axisFmt(v));
      const padL = Math.max(46, 12 + Math.max(...tickTexts.map((s) => String(s).length)) * 6);
      const iw = W - padL - padR;
      const ih = H - padT - padB;

      const n = labels.length || 1;
      const xAt = (i) => padL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
      const yAt = (v) => padT + ih - (max === 0 ? 0 : (v / max) * ih);

      const parts = [];
      // 网格 + Y 轴
      for (let i = 0; i <= ticks; i++) {
        const v = tickVals[i];
        const y = yAt(v);
        parts.push(`<line class="grid-line" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"/>`);
        parts.push(`<text class="axis-label" x="${padL - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${esc(tickTexts[i])}</text>`);
      }
      // X 轴刻度
      const step = Math.max(1, Math.ceil(n / 7));
      for (let i = 0; i < n; i += step) {
        parts.push(`<text class="axis-label" x="${xAt(i).toFixed(1)}" y="${H - 7}" text-anchor="middle">${esc(labels[i] || '')}</text>`);
      }

      // 序列
      series.forEach((s, si) => {
        const color = s.color || PALETTE[si % PALETTE.length];
        if (!s.values.length) return;
        const pts = s.values.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`);
        if (series.length === 1) {
          parts.push(`<path class="area" fill="${color}" d="M${padL},${yAt(0).toFixed(1)} L${pts.join(' L')} L${xAt(n - 1).toFixed(1)},${yAt(0).toFixed(1)} Z"/>`);
        }
        parts.push(`<path class="line" stroke="${color}" d="M${pts.join(' L')}"/>`);
        if (n <= 40) {
          s.values.forEach((v, i) => {
            parts.push(`<circle class="dot" cx="${xAt(i).toFixed(1)}" cy="${yAt(v).toFixed(1)}" r="2.6" fill="${color}"/>`);
          });
        }
      });

      parts.push(`<g class="hover-group" style="display:none">
        <line class="hover-line" y1="${padT}" y2="${padT + ih}" x1="0" x2="0"/>
        ${series.map((s, si) => `<circle class="dot" r="4" fill="${s.color || PALETTE[si % PALETTE.length]}" cx="0" cy="0"/>`).join('')}
      </g>`);
      parts.push(`<rect class="hit" x="${padL}" y="${padT}" width="${iw}" height="${ih}" fill="transparent" style="cursor:crosshair"/>`);

      container.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`;

      const svg = container.querySelector('svg');
      const hit = svg.querySelector('.hit');
      const hg = svg.querySelector('.hover-group');
      const hline = hg.querySelector('.hover-line');
      const hdots = Array.from(hg.querySelectorAll('circle'));
      const t = tip();

      // 折线从左往右画出来（尺寸变化重画时不重播）。
      // 时长比早先的 1.15s 收短一档：切页时两条曲线同时起笔，收得慢会显得页面「拖着」
      if (animate) animateLines(svg, 820, 70);

      const idxFromEvent = (e) => {
        const rect = svg.getBoundingClientRect();
        const scale = W / rect.width;
        const x = (e.clientX - rect.left) * scale;
        let best = 0, bestD = Infinity;
        for (let i = 0; i < n; i++) {
          const d = Math.abs(xAt(i) - x);
          if (d < bestD) { bestD = d; best = i; }
        }
        return best;
      };

      hit.addEventListener('mousemove', (e) => {
        const i = idxFromEvent(e);
        const x = xAt(i);
        hg.style.display = '';
        hline.setAttribute('x1', x.toFixed(1));
        hline.setAttribute('x2', x.toFixed(1));
        series.forEach((s, si) => {
          if (hdots[si]) {
            hdots[si].setAttribute('cx', x.toFixed(1));
            hdots[si].setAttribute('cy', yAt(s.values[i] || 0).toFixed(1));
          }
        });
        const rows = series.map((s) =>
          `<div style="display:flex;gap:10px;align-items:center">
            <span style="width:7px;height:7px;border-radius:2px;background:${s.color || PALETTE[0]};display:inline-block"></span>
            <span>${esc(s.name)}</span>
            <b style="margin-left:auto">${esc(valueFmt(s.values[i] || 0))}</b>
          </div>`);
        // 总计行：把参与汇总的序列加起来放在最上面（失败数不计入）。
        // totalFrom 可以指定只算某一条曲线——请求数 / 成功数 / 失败数三条并排时，
        // 求和没有意义，总计应该就是其中的请求数。
        if (opts.totalName) {
          let sum = 0;
          for (const s of series) {
            if (s.noTotal) continue;
            if (opts.totalFrom && s.name !== opts.totalFrom) continue;
            sum += s.values[i] || 0;
          }
          rows.unshift(`<div style="display:flex;gap:10px;align-items:center;margin-bottom:4px;padding-bottom:4px;border-bottom:1px solid rgba(255,255,255,.22)">
            <span>${esc(opts.totalName)}</span>
            <b style="margin-left:auto">${esc(valueFmt(sum))}</b>
          </div>`);
        }
        t.innerHTML = `<div style="opacity:.75;margin-bottom:3px">${esc(fullLabel(i))}</div>${rows.join('')}`;
        t.classList.add('is-on');
        const tw = t.offsetWidth, th = t.offsetHeight;
        let left = e.clientX + 14, top = e.clientY - th - 10;
        if (left + tw > window.innerWidth - 8) left = e.clientX - tw - 14;
        if (top < 8) top = e.clientY + 16;
        t.style.left = left + 'px';
        t.style.top = top + 'px';
      });
      hit.addEventListener('mouseleave', () => {
        hg.style.display = 'none';
        t.classList.remove('is-on');
      });

      function fullLabel(i) {
        if (opts.times && opts.times[i]) {
          const d = new Date(opts.times[i] + BJ_OFFSET);
          const p = (x) => String(x).padStart(2, '0');
          return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:00`;
        }
        return labels[i] || '';
      }
      void spanMs;
    }

    draw(true);
    // 窗口尺寸变化只是重画，不重播动画
    observe(container, () => draw(false));
  }

  /**
   * 柱状图
   * opts: { labels, values, color, height, valueFmt }
   */
  function barChart(container, opts) {
    const { labels = [], values = [], height = 210, color = '#4d9e2f' } = opts;
    const valueFmt = opts.valueFmt || ((v) => fmtInt(v));
    const axisFmt = opts.axisFmt || fmtAxis;

    function draw() {
      const W = Math.max(container.clientWidth || 600, 320);
      const H = height;
      const padR = 14, padT = 14, padB = 26;
      const scale = niceScale(Math.max(0, ...values), 4);
      let max = scale.max;

      const ticks = scale.ticks;
      const tickVals = [];
      for (let i = 0; i <= ticks; i++) tickVals.push((max / ticks) * i);
      const tickTexts = tickVals.map((v) => axisFmt(v));
      const padL = Math.max(46, 12 + Math.max(...tickTexts.map((s) => String(s).length)) * 6);
      const iw = W - padL - padR;
      const ih = H - padT - padB;

      const n = Math.max(values.length, 1);
      const slot = iw / n;
      const bw = Math.max(3, Math.min(slot * 0.62, 30));

      const parts = [];
      for (let i = 0; i <= ticks; i++) {
        const v = tickVals[i];
        const y = padT + ih - (v / max) * ih;
        parts.push(`<line class="grid-line" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"/>`);
        parts.push(`<text class="axis-label" x="${padL - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${esc(tickTexts[i])}</text>`);
      }
      const step = Math.max(1, Math.ceil(n / 7));
      for (let i = 0; i < n; i += step) {
        parts.push(`<text class="axis-label" x="${(padL + slot * (i + 0.5)).toFixed(1)}" y="${H - 7}" text-anchor="middle">${esc(labels[i] || '')}</text>`);
      }
      values.forEach((v, i) => {
        const h = max === 0 ? 0 : (v / max) * ih;
        const x = padL + slot * i + (slot - bw) / 2;
        const y = padT + ih - h;
        parts.push(`<rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, v > 0 ? 2 : 0).toFixed(1)}" fill="${color}" opacity="${v > 0 ? 0.9 : 0.25}"/>`);
        parts.push(`<rect class="hit" data-i="${i}" x="${(padL + slot * i).toFixed(1)}" y="${padT}" width="${slot.toFixed(1)}" height="${ih}" fill="transparent" style="cursor:pointer"/>`);
      });
      container.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`;

      const svg = container.querySelector('svg');
      const t = tip();
      svg.querySelectorAll('.hit').forEach((el) => {
        el.addEventListener('mousemove', (e) => {
          const i = Number(el.dataset.i);
          t.innerHTML = `<div style="opacity:.75;margin-bottom:2px">${esc(labels[i] || '')}</div><b>${esc(valueFmt(values[i] || 0))}</b>`;
          t.classList.add('is-on');
          const tw = t.offsetWidth, th = t.offsetHeight;
          let left = e.clientX + 12, top = e.clientY - th - 8;
          if (left + tw > window.innerWidth - 8) left = e.clientX - tw - 12;
          if (top < 8) top = e.clientY + 14;
          t.style.left = left + 'px';
          t.style.top = top + 'px';
        });
        el.addEventListener('mouseleave', () => t.classList.remove('is-on'));
      });
    }

    draw();
    observe(container, draw);
  }

  /**
   * 环形图
   * opts: { items:[{name,value,color}], size, thickness, valueFmt, centerLabel }
   */
  function donutChart(container, opts) {
    hideNameTip();
    const { items = [], size = 168, thickness = 20 } = opts;
    const valueFmt = opts.valueFmt || null;
    const totalFmt = valueFmt || fmtNum;
    const itemFmt = valueFmt || fmtInt;
    // 中心那个小字说明总数是什么口径：调用次数是「总调用」，Token 消耗是「总 Token」。
    const centerLabel = opts.centerLabel || '总调用';
    const total = items.reduce((a, b) => a + b.value, 0);
    const r = (size - thickness) / 2;
    const cx = size / 2, cy = size / 2;
    const circ = 2 * Math.PI * r;
    let offset = 0;
    const arcs = [];
    if (total === 0) {
      arcs.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border)" stroke-width="${thickness}"/>`);
    } else {
      items.forEach((it, i) => {
        const frac = it.value / total;
        const len = frac * circ;
        const color = it.color || PALETTE[i % PALETTE.length];
        // data-len / data-circ 给扫环动画用：动画时把 dasharray 从 0 长到 len
        arcs.push(`<circle class="donut-arc" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${thickness}"
          data-len="${len.toFixed(2)}" data-circ="${circ.toFixed(2)}"
          stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}"
          stroke-dashoffset="${(-offset).toFixed(2)}"
          transform="rotate(-90 ${cx} ${cy})" stroke-linecap="butt"/>`);
        offset += len;
      });
    }
    container.innerHTML = `<div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="flex-shrink:0">
        ${arcs.join('')}
        <text class="donut-total" x="${cx}" y="${cy - 4}" text-anchor="middle" style="font-size:20px;font-weight:700;fill:var(--text);font-family:var(--font)">${esc(totalFmt(total))}</text>
        <text x="${cx}" y="${cy + 15}" text-anchor="middle" style="font-size:10.5px;fill:var(--text-3);font-family:var(--font)">${esc(centerLabel)}</text>
      </svg>
      <div style="flex:1;min-width:150px;display:flex;flex-direction:column;gap:8px">
        ${items.length === 0 ? '<div class="muted fs-12">暂无数据</div>' : items.map((it, i) => `
          <div style="display:flex;align-items:center;gap:8px;font-size:12.5px">
            <span style="width:8px;height:8px;border-radius:3px;background:${it.color || PALETTE[i % PALETTE.length]};flex-shrink:0"></span>
            <span class="truncate donut-legend__name" data-name="${esc(it.name)}" style="max-width:140px;font-family:var(--mono);font-size:11.5px">${esc(it.name)}</span>
            <span style="margin-left:auto;color:var(--text-2);font-variant-numeric:tabular-nums;white-space:nowrap;flex-shrink:0">${esc(itemFmt(it.value))}</span>
            <span class="muted" style="width:42px;text-align:right;font-size:11px;flex-shrink:0">${total ? ((it.value / total) * 100).toFixed(1) + '%' : '0%'}</span>
          </div>`).join('')}
      </div>
    </div>`;

    bindNameTips(container);

    // 环扫出来（节奏跟折线一致：每段 0.76s 长完，后面的依次晚 60~90ms 起笔；
    // 模型多的时候缩短错开间隔，免得最后一段等太久）
    const svg = container.querySelector('svg');
    if (svg && total > 0) {
      const n = items.length || 1;
      animateDonut(svg, 760, Math.min(90, 560 / n), {
        text: svg.querySelector('.donut-total'),
        total,
        fmt: totalFmt,
      });
    }
  }

  /** 横向排行条 */
  function rankList(container, items, opts) {
    hideNameTip();
    const o = opts || {};
    if (!items || !items.length) {
      container.innerHTML = '<div class="muted fs-12" style="padding:8px 0">暂无数据</div>';
      return;
    }
    const max = Math.max(...items.map((i) => i.value)) || 1;
    container.innerHTML = `<div class="rank-list">${items.map((it, i) => `
      <div class="rank-item">
        <div class="rank-item__top">
          <span class="rank-item__name truncate" data-name="${esc(it.name)}" style="max-width:${o.nameWidth || 170}px">${esc(it.name)}</span>
          <span class="rank-item__val">${esc((o.fmt || fmtInt)(it.value))}</span>
        </div>
        <div class="rank-item__bar">
          <div class="rank-item__fill" style="width:${((it.value / max) * 100).toFixed(1)}%;${it.color ? `background:${it.color}` : ''}"></div>
        </div>
      </div>`).join('')}</div>`;
    bindNameTips(container);
  }

  const observers = new WeakMap();
  function observe(container, draw) {
    if (typeof ResizeObserver === 'undefined') return;
    if (observers.has(container)) observers.get(container).disconnect();
    let lastW = container.clientWidth;
    const ro = new ResizeObserver(debounce(() => {
      if (Math.abs(container.clientWidth - lastW) < 8) return;
      lastW = container.clientWidth;
      draw();
    }, 140));
    ro.observe(container);
    observers.set(container, ro);
  }

  /**
   * 清空图表并停掉尺寸观察器。
   * 看板切区间时会把图表换回占位骨架，观察器留着的话窗口一改大小，
   * 旧区间的曲线会被重新画到占位上。
   */
  function clearChart(container) {
    if (!container) return;
    hideNameTip();
    const ro = observers.get(container);
    if (ro) {
      ro.disconnect();
      observers.delete(container);
    }
    container.innerHTML = '';
  }

  function debounce(fn, wait) {
    let t;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, wait);
    };
  }

  window.Charts = { areaChart, barChart, donutChart, rankList, PALETTE, timeLabel, hideTip, animateLines, animateDonut, niceScale, clearChart };
})();
