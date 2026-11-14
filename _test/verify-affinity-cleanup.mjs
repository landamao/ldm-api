// 系统设置 · 亲和自动清理：控件存在、保存落盘、立即清理可点、两栏布局正常
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';

const fails = [];
const check = (ok, label, extra) => {
  console.log(ok ? '  ok  ' : '  FAIL', label, extra === undefined ? '' : JSON.stringify(extra));
  if (!ok) fails.push(label);
};

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.77' },
});
const page = await ctx.newPage();
page.on('pageerror', (e) => { console.log('[page error]', e.message); fails.push('pageerror: ' + e.message); });

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1300);
}

await page.goto(BASE + '/#/settings', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

// ---- 1) 控件与初始状态 ----
for (const sel of ['#s-affinity-hours', '#s-affinity-channel', '#s-affinity-model', '#s-affinity-save', '#s-affinity-clear', '#s-affinity-meta']) {
  check(await page.locator(sel).count() === 1, '存在 ' + sel);
}
const meta = (await page.locator('#s-affinity-meta').innerText()).trim();
console.log('  meta:', meta);
check(/条亲和/.test(meta), 'meta 显示亲和条数');

// 右列两张卡应为上下排列、间距 14px
const layout = await page.evaluate(() => {
  const side = document.querySelector('.settings-side');
  const cards = side ? Array.from(side.querySelectorAll(':scope > .card')) : [];
  const r = cards.map((c) => c.getBoundingClientRect());
  const grid = document.querySelector('.chart-grid');
  const gr = grid ? grid.getBoundingClientRect() : null;
  return {
    cards: cards.length,
    gap: r.length === 2 ? +(r[1].top - r[0].bottom).toFixed(1) : null,
    sameWidth: r.length === 2 ? Math.abs(r[0].width - r[1].width) < 0.5 : null,
    sideRight: r.length ? +r[0].right.toFixed(1) : null,
    gridRight: gr ? +gr.right.toFixed(1) : null,
    hoursW: +document.querySelector('#s-affinity-hours').getBoundingClientRect().width.toFixed(1),
  };
});
console.log('  layout:', JSON.stringify(layout));
check(layout.cards === 2, '右列有两张卡');
check(layout.gap === 14, '两卡间距 14px', layout.gap);
check(layout.sideRight === layout.gridRight, '右列与栅格右边界对齐');
const colsWide = await page.evaluate(() => getComputedStyle(document.querySelector('.settings-grid')).gridTemplateColumns.split(' ').length);
check(colsWide === 2, '宽屏设置页两列', colsWide);

await page.screenshot({ path: `${SHOT}/affinity-settings-1440.png`, fullPage: true });

// ---- 2) 保存：间隔 1 小时 + 两种范围 ----
await page.fill('#s-affinity-hours', '1');
for (const sel of ['#s-affinity-channel', '#s-affinity-model']) {
  if (!(await page.isChecked(sel))) await page.click(`label:has(${sel}) .switch__track`);
}
await page.click('#s-affinity-save');
await page.waitForTimeout(900);
const saved = await page.evaluate(async () => {
  const res = await fetch('/api/settings', { headers: { 'Content-Type': 'application/json' } });
  return res.ok ? res.json() : { error: res.status };
});
console.log('  saved:', JSON.stringify({
  hours: saved.affinity_cleanup_hours,
  ch: saved.affinity_clean_channel,
  model: saved.affinity_clean_model,
}));
check(saved.affinity_cleanup_hours === 1, '间隔落盘为 1', saved.affinity_cleanup_hours);
check(saved.affinity_clean_channel === true && saved.affinity_clean_model === true, '范围落盘为渠道 + 模型');
check(await page.locator('.toast--success').count() > 0, '保存后有成功提示');

// ---- 3) 立即清理：不造亲和时也应给出反馈 ----
await page.click('#s-affinity-clear');
await page.waitForTimeout(800);
const toastText = (await page.locator('.toast').last().innerText()).trim();
console.log('  clear toast:', JSON.stringify(toastText));
check(/亲和/.test(toastText), '立即清理有结果提示');

// ---- 4) 窄屏：右列应落到单列、控件不溢出 ----
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(600);
const narrow = await page.evaluate(() => {
  const side = document.querySelector('.settings-side');
  const cards = Array.from(side.querySelectorAll(':scope > .card'));
  const r = cards.map((c) => c.getBoundingClientRect());
  const sw = document.documentElement.scrollWidth;
  const cols = getComputedStyle(document.querySelector('.settings-grid')).gridTemplateColumns.split(' ').length;
  return {
    cols,
    stacked: r.length === 2 ? Math.abs(r[0].left - r[1].left) < 0.5 && r[1].top > r[0].bottom : null,
    gap: r.length === 2 ? +(r[1].top - r[0].bottom).toFixed(1) : null,
    scrollW: sw,
    viewW: window.innerWidth,
    hoursW: +document.querySelector('#s-affinity-hours').getBoundingClientRect().width.toFixed(1),
  };
});
console.log('  narrow:', JSON.stringify(narrow));
check(narrow.cols === 1, '窄屏栅格变单列', narrow.cols);
check(narrow.stacked === true, '窄屏两卡上下排列');
check(narrow.scrollW <= narrow.viewW + 1, '窄屏无横向滚动', { scrollW: narrow.scrollW, viewW: narrow.viewW });
// 等提示消失再截，内容区是独立滚动容器，滚到清理卡再拍。
await page.waitForTimeout(3200);
await page.locator('#s-affinity-clear').scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOT}/affinity-settings-mobile.png` });

await browser.close();
if (fails.length) {
  console.log('\n失败项：', fails.join(' / '));
  process.exit(1);
}
console.log('\n全部通过');
