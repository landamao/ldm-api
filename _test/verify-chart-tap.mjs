// 手机上的图表数据：没有悬停也要能点出来（折线图 / 柱状图）。
// 用法：node _test/verify-chart-tap.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';

const fails = [];
const ok = (cond, msg, extra) => {
  if (cond) console.log('  ok   ' + msg);
  else { console.log('  FAIL ' + msg + (extra ? ' -> ' + extra : '')); fails.push(msg); }
};

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.111' },
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1400);
}
await page.goto(BASE + '/#/dashboard', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
await page.evaluate(() => {
  const el = document.querySelector('#dash-preset');
  if (el) { el.value = 'all'; el.dispatchEvent(new Event('change', { bubbles: true })); }
});
await page.waitForTimeout(2400);

const scrollTo = async (i) => {
  await page.evaluate((idx) => {
    const s = document.querySelectorAll('svg.chart')[idx];
    if (s) s.scrollIntoView({ block: 'center' });
  }, i);
  await page.waitForTimeout(600);
};
const charts = await page.evaluate(() => Array.from(document.querySelectorAll('svg.chart')).map((s) => {
  const r = s.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bars: s.querySelectorAll('path.line').length };
}));
console.log('  图表数量', charts.length, JSON.stringify(charts.slice(0, 3)));
ok(charts.length > 0, '看板有图表');

const tipState = () => page.evaluate(() => {
  const t = document.querySelector('.chart-tip.is-on');
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return {
    text: (t.textContent || '').replace(/\s+/g, ' ').trim(),
    left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom),
    vw: innerWidth, vh: innerHeight,
  };
});

// 折线图：点曲线区域中间
const lineIdx = charts.findIndex((c) => c.bars > 0);
if (lineIdx >= 0) {
  await scrollTo(lineIdx);
  const c = await page.evaluate((idx) => {
    const r = document.querySelectorAll('svg.chart')[idx].getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }, lineIdx);
  await page.touchscreen.tap(c.x + c.w * 0.55, c.y + c.h * 0.5);
  await page.waitForTimeout(300);
  const t1 = await tipState();
  ok(!!t1, '手机上点折线图弹出数据气泡');
  ok(t1 && /\d/.test(t1.text), `气泡里有数值（${t1 && t1.text.slice(0, 40)}）`);
  ok(t1 && t1.left >= 0 && t1.right <= t1.vw && t1.bottom <= t1.vh, '气泡不超出屏幕', t1 && `${t1.left}..${t1.right}/${t1.vw}`);
  await page.screenshot({ path: 'D:/code/ldm-api/_test/shots/chart-tap-mobile.png' });

  await page.locator('#page-title').tap();
  await page.waitForTimeout(300);
  ok(!(await tipState()), '点图外收起');
} else {
  ok(false, '没找到折线图');
}

// 柱状图：看板下方的模型调用分布
const barIdx = charts.findIndex((c, i) => i !== lineIdx && c.h > 100);
if (barIdx >= 0) {
  const c = charts[barIdx];
  await page.touchscreen.tap(c.x + c.w * 0.4, c.y + c.h * 0.6);
  await page.waitForTimeout(300);
  const t2 = await tipState();
  ok(!!t2, '手机上点柱状图弹出数据气泡');
} else {
  console.log('  skip 这页没有柱状图');
}

await browser.close();
console.log(fails.length ? `\n${fails.length} 项失败` : '\n全部通过');
process.exit(fails.length ? 1 : 0);
