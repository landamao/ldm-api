// 全站居中回归检测：把「靠肉眼才能发现的偏移」变成数字
// 用法：先起网关（LDMAPI_DEV=web LDMAPI_PASSWORD=test1234 -port 6821），再 node verify-center.mjs
// 阈值 0.5px：人眼看不出来的量级，但正是这类误差累积起来让组件「看着歪」
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const THRESHOLD = 0.5;

const PAGES = ['dashboard', 'plaza', 'chat', 'channels', 'models', 'tokens', 'logs', 'settings'];

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.77' } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1000);
}

// 登录失败（密码错、被限流）时必须直接失败，否则后面每页都是 0 检出，变成假绿
if (!(await page.locator('.nav__item').count())) {
  console.error('登录失败：没有进入主界面，请检查密码或等待登录限流解除');
  await browser.close();
  process.exit(2);
}

const probe = (THRESHOLD) => {
  // 绝对定位、但必须垂直居中的图标盒（跟随输入框/控件高度居中）；右上角扩大键那种贴边角标不在此列
  const ICON_BOX = '.search__icon, .key-row__index, .ldm-select__chev';
  const problems = [];
  const vis = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const sel = (el) => {
    if (!el) return '?';
    if (el.id) return el.tagName.toLowerCase() + '#' + el.id;
    const c = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
    return el.tagName.toLowerCase() + (c.length ? '.' + c.join('.') : '');
  };
  const px = (v) => parseFloat(v) || 0;

  // A. 伪元素必须吃到 border-box（`*` 不匹配伪元素，这是开关圆点变 19px 的根因）
  for (const el of document.querySelectorAll('*')) {
    if (!vis(el)) continue;
    for (const pseudo of ['::before', '::after']) {
      const cs = getComputedStyle(el, pseudo);
      if (cs.content === 'none' || cs.content === 'normal') continue;
      if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
      const hasBox = (px(cs.width) > 0 || px(cs.height) > 0) && (px(cs.borderTopWidth) > 0 || px(cs.borderLeftWidth) > 0);
      if (!hasBox) continue;
      if (cs.boxSizing !== 'border-box') {
        problems.push({ kind: '伪元素非 border-box', page: location.hash, el: sel(el) + pseudo, detail: cs.boxSizing, diff: null });
      }
    }
  }

  // B. 绝对定位元素：声称居中（top:50%）却真的偏了
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
    const p = el.offsetParent;
    if (!p || !vis(p)) continue;
    const pcs = getComputedStyle(p);
    const pr = p.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const boxTop = pr.top + px(pcs.borderTopWidth);
    const boxBottom = pr.bottom - px(pcs.borderBottomWidth);
    const boxCy = (boxTop + boxBottom) / 2;
    const elCy = (er.top + er.bottom) / 2;
    const diff = +(elCy - boxCy).toFixed(2);
    const saysCentered = cs.top !== 'auto' && Math.abs(px(cs.top) - (boxBottom - boxTop) / 2) < 1 && cs.transform.includes('matrix');
    const pinned = cs.top === '0px' && cs.bottom === '0px';
    if (saysCentered && Math.abs(diff) > THRESHOLD) {
      problems.push({ kind: '绝对定位居中偏移', page: location.hash, el: sel(el), detail: 'top:50% 但中心差', diff });
    }
    if (!pinned && Math.abs(diff) > THRESHOLD && cs.top !== 'auto' && cs.bottom !== 'auto' && !cs.transform.includes('scale')) {
      // 上下都定了但没居中意图的（比如贴边的角标）跳过
    }
  }

  // C. 图标：绝对定位的图标盒要对「包含块」居中；普通宿主则对宿主自己居中
  // 注意别量「图标 vs 它的父元素」——绝对定位的父元素会跟着图标一起走，永远 0 偏差
  for (const svg of document.querySelectorAll('svg')) {
    if (!vis(svg)) continue;
    const host = svg.parentElement;
    if (!host || !vis(host)) continue;
    const hcs = getComputedStyle(host);
    const abs = hcs.position === 'absolute' || hcs.position === 'fixed';
    let ref = host;
    let rcs = hcs;
    if (abs) {
      // 只查这几类「必须垂直居中」的图标盒；右上角扩大键那种贴边定位的角标不参与
      if (!host.matches(ICON_BOX)) continue;
      // 上下都钉 0 的由布局保证居中，不需要查
      if (hcs.top === '0px' && hcs.bottom === '0px') continue;
      ref = host.offsetParent || host.parentElement;
      if (!ref) continue;
      rcs = getComputedStyle(ref);
    } else {
      const isFlex = /flex/.test(hcs.display);
      const isGrid = /grid/.test(hcs.display);
      const centered = (isFlex || isGrid) && (hcs.alignItems === 'center' || hcs.alignItems === 'normal' || hcs.placeItems.includes('center'));
      if (!centered) continue;
    }
    const rr = ref.getBoundingClientRect();
    const boxTop = rr.top + px(rcs.borderTopWidth) + (abs ? 0 : px(rcs.paddingTop));
    const boxBottom = rr.bottom - px(rcs.borderBottomWidth) - (abs ? 0 : px(rcs.paddingBottom));
    const hostCy = (boxTop + boxBottom) / 2;
    const r = svg.getBoundingClientRect();
    const diff = +(((r.top + r.bottom) / 2) - hostCy).toFixed(2);
    if (Math.abs(diff) > THRESHOLD) {
      problems.push({
        kind: '图标未居中', page: location.hash, el: sel(svg) + ' ⊂ ' + sel(host) + ' ⊂ ' + sel(ref),
        detail: `参照高 ${(boxBottom - boxTop).toFixed(1)} / 图标高 ${r.height.toFixed(1)}${abs ? '（绝对定位）' : ''}`, diff,
      });
    }
  }

  // D. 开关专项：圆点必须落在轨道 padding box 里且上下留白相等
  for (const track of document.querySelectorAll('.switch__track')) {
    if (!vis(track)) continue;
    const cs = getComputedStyle(track);
    const acs = getComputedStyle(track, '::after');
    const r = track.getBoundingClientRect();
    const innerH = r.height - px(cs.borderTopWidth) - px(cs.borderBottomWidth);
    const knobH = px(acs.height);
    // top/bottom 都是 0 时由 margin:auto 算中心，天然相等；否则手算上下留白
    if (acs.top === '0px' && acs.bottom === '0px') continue;
    const gapTop = px(acs.top);
    const gapBottom = innerH - gapTop - knobH;
    const diff = +(gapTop - gapBottom).toFixed(2);
    if (Math.abs(diff) > THRESHOLD) {
      problems.push({ kind: '开关圆点未居中', page: location.hash, el: sel(track), detail: `上 ${gapTop.toFixed(1)} / 下 ${gapBottom.toFixed(1)} / 点高 ${knobH}`, diff });
    }
  }

  return problems;
};

const all = [];
for (const name of PAGES) {
  await page.goto(`${BASE}/#/${name}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(name === 'chat' ? 1600 : 1200);
  const iconCount = await page.locator('svg.icon').count();
  if (!iconCount) {
    console.log(`  ⚠ ${name} 没有渲染出任何图标，跳过（可能是加载失败或空数据）`);
    continue;
  }
  const list = await page.evaluate(probe, THRESHOLD);
  const seen = new Set();
  for (const p of list) {
    const key = p.kind + p.el + p.page;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(p);
  }
  console.log(`${name.padEnd(10)} 检出 ${list.length}`);
}

// 弹窗场景：开关、下拉箭头最常见出问题的地方
await page.goto(`${BASE}/#/channels`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1400);
const editBtn = page.locator('button[data-act="edit"]').first();
if (await editBtn.count()) {
  await editBtn.click();
  await page.waitForTimeout(1000);
  const modalList = await page.evaluate(probe, THRESHOLD);
  for (const p of modalList) all.push(p);
  console.log(`channels 弹窗 检出 ${modalList.length}`);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
}

console.log('\n================ 汇总 ================');
if (!all.length) {
  console.log('全部居中检测通过（阈值 ±' + THRESHOLD + 'px）');
} else {
  for (const p of all) {
    console.log(`[${p.kind}] ${p.page} ${p.el}`);
    console.log(`        偏差 ${p.diff > 0 ? '+' : ''}${p.diff}px   ${p.detail}`);
  }
  console.log(`\n共 ${all.length} 处`);
}

await browser.close();
process.exit(all.length ? 1 : 0);
