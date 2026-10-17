/* ==========================================================================
   懒大猫 API · 轻量 SVG 图表（零依赖）
   ========================================================================== */
(function () {
  'use strict';

  const { esc, fmtInt, fmtNum } = window.LDM;

  const PALETTE = ['#f33b7c', '#ff7fac', '#88c0d0', '#8b5cf6', '#f59e0b', '#10b981', '#f43f5e', '#5e9fbf'];

  function niceMax(v) {
    if (v <= 0) return 4;
    const exp = Math.floor(Math.log10(v));
    const base = Math.pow(10, exp);
    const n = v / base;
    let m;
    if (n <= 1) m = 1;
    else if (n <= 2) m = 2;
    else if (n <= 2.5) m = 2.5;
    else if (n <= 5) m = 5;
    else m = 10;
    return m * base;
  }

  function fmtAxis(v) {
    if (v >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(Math.round(v));
  }

  function timeLabel(ms, spanMs) {
    const d = new Date(ms);
    const p = (x) => String(x).padStart(2, '0');
    if (spanMs > 36 * 3600 * 1000) return `${d.getMonth() + 1}/${d.getDate()}`;
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
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

  /**
   * 面积折线图
   * opts: { labels:[string], series:[{name,color,values:number[],unit}], height, spanMs, valueFmt }
   */
  function areaChart(container, opts) {
    const { labels = [], series = [], height = 210, spanMs = 86400000 } = opts;
    const valueFmt = opts.valueFmt || ((v) => fmtInt(v));

    function draw() {
      const W = Math.max(container.clientWidth || 600, 320);
      const H = height;
      const padL = 46, padR = 14, padT = 14, padB = 26;
      const iw = W - padL - padR;
      const ih = H - padT - padB;

      let max = 0;
      series.forEach((s) => s.values.forEach((v) => { if (v > max) max = v; }));
      max = niceMax(max);
      const n = labels.length || 1;
      const xAt = (i) => padL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
      const yAt = (v) => padT + ih - (max === 0 ? 0 : (v / max) * ih);

      const parts = [];
      // 网格 + Y 轴
      const ticks = 4;
      for (let i = 0; i <= ticks; i++) {
        const v = (max / ticks) * i;
        const y = yAt(v);
        parts.push(`<line class="grid-line" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"/>`);
        parts.push(`<text class="axis-label" x="${padL - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${esc(fmtAxis(v))}</text>`);
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
          </div>`).join('');
        t.innerHTML = `<div style="opacity:.75;margin-bottom:3px">${esc(fullLabel(i))}</div>${rows}`;
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
          const d = new Date(opts.times[i]);
          const p = (x) => String(x).padStart(2, '0');
          return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:00`;
        }
        return labels[i] || '';
      }
      void spanMs;
    }

    draw();
    observe(container, draw);
  }

  /**
   * 柱状图
   * opts: { labels, values, color, height, valueFmt }
   */
  function barChart(container, opts) {
    const { labels = [], values = [], height = 210, color = '#f33b7c' } = opts;
    const valueFmt = opts.valueFmt || ((v) => fmtInt(v));

    function draw() {
      const W = Math.max(container.clientWidth || 600, 320);
      const H = height;
      const padL = 46, padR = 14, padT = 14, padB = 26;
      const iw = W - padL - padR;
      const ih = H - padT - padB;
      let max = niceMax(Math.max(0, ...values));
      const n = Math.max(values.length, 1);
      const slot = iw / n;
      const bw = Math.max(3, Math.min(slot * 0.62, 30));

      const parts = [];
      const ticks = 4;
      for (let i = 0; i <= ticks; i++) {
        const v = (max / ticks) * i;
        const y = padT + ih - (v / max) * ih;
        parts.push(`<line class="grid-line" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"/>`);
        parts.push(`<text class="axis-label" x="${padL - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${esc(fmtAxis(v))}</text>`);
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
   * opts: { items:[{name,value,color}], size, thickness }
   */
  function donutChart(container, opts) {
    const { items = [], size = 168, thickness = 20 } = opts;
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
        arcs.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${thickness}"
          stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}"
          stroke-dashoffset="${(-offset).toFixed(2)}"
          transform="rotate(-90 ${cx} ${cy})" stroke-linecap="butt"/>`);
        offset += len;
      });
    }
    container.innerHTML = `<div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="flex-shrink:0">
        ${arcs.join('')}
        <text x="${cx}" y="${cy - 4}" text-anchor="middle" style="font-size:20px;font-weight:700;fill:var(--text);font-family:var(--font)">${esc(fmtNum(total))}</text>
        <text x="${cx}" y="${cy + 15}" text-anchor="middle" style="font-size:10.5px;fill:var(--text-3);font-family:var(--font)">总调用</text>
      </svg>
      <div style="flex:1;min-width:150px;display:flex;flex-direction:column;gap:8px">
        ${items.length === 0 ? '<div class="muted fs-12">暂无数据</div>' : items.map((it, i) => `
          <div style="display:flex;align-items:center;gap:8px;font-size:12.5px">
            <span style="width:8px;height:8px;border-radius:3px;background:${it.color || PALETTE[i % PALETTE.length]};flex-shrink:0"></span>
            <span class="truncate" style="max-width:140px;font-family:var(--mono);font-size:11.5px">${esc(it.name)}</span>
            <span style="margin-left:auto;color:var(--text-2);font-variant-numeric:tabular-nums">${esc(fmtInt(it.value))}</span>
            <span class="muted" style="width:42px;text-align:right;font-size:11px">${total ? ((it.value / total) * 100).toFixed(1) + '%' : '0%'}</span>
          </div>`).join('')}
      </div>
    </div>`;
  }

  /** 横向排行条 */
  function rankList(container, items, opts) {
    const o = opts || {};
    if (!items || !items.length) {
      container.innerHTML = '<div class="muted fs-12" style="padding:8px 0">暂无数据</div>';
      return;
    }
    const max = Math.max(...items.map((i) => i.value)) || 1;
    container.innerHTML = `<div class="rank-list">${items.map((it, i) => `
      <div class="rank-item">
        <div class="rank-item__top">
          <span class="rank-item__name truncate" style="max-width:${o.nameWidth || 170}px">${esc(it.name)}</span>
          <span class="rank-item__val">${esc((o.fmt || fmtInt)(it.value))}</span>
        </div>
        <div class="rank-item__bar">
          <div class="rank-item__fill" style="width:${((it.value / max) * 100).toFixed(1)}%;${it.color ? `background:${it.color}` : ''}"></div>
        </div>
      </div>`).join('')}</div>`;
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

  function debounce(fn, wait) {
    let t;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, wait);
    };
  }

  window.Charts = { areaChart, barChart, donutChart, rankList, PALETTE, timeLabel };
})();
