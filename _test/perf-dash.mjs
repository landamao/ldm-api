// 数据看板切换性能测量：从调用日志页点进看板，记录长任务、帧间隔和图表出现耗时。
// 用法：node perf-dash.mjs [label]
import { chromium } from 'playwright-core';

const LABEL = process.argv[2] || 'run';
const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(500);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1200);
}

// 先到日志页，保证是「从别的页面切进看板」的场景
await page.goto(BASE + '/#/logs', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

// 注入测量器：长任务 + rAF 帧间隔
await page.evaluate(() => {
  window.__perf = { long: [], frames: [], marks: {} };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__perf.long.push({ start: e.startTime, dur: e.duration });
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { /* 某些 Edge 版本没 longtask */ }
  let last = 0;
  const tick = (t) => {
    if (last) window.__perf.frames.push(t - last);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const origMark = performance.mark.bind(performance);
  performance.mark = (n) => { window.__perf.marks[n] = performance.now(); return origMark(n); };
});

const rounds = [];
for (let r = 0; r < 3; r++) {
  await page.evaluate(() => {
    window.__perf.long.length = 0;
    window.__perf.frames.length = 0;
    window.__perf.marks = {};
  });
  // 点导航进看板
  const t0 = Date.now();
  await page.evaluate(() => {
    window.__perf.marks.click = performance.now();
    document.querySelector('a[data-page="dashboard"]').click();
  });
  // 等到曲线 svg 出现
  await page.waitForFunction(() => {
    const el = document.querySelector('#trend-chart svg');
    if (!el) return false;
    if (!window.__perf.marks.svg) window.__perf.marks.svg = performance.now();
    return true;
  }, null, { timeout: 8000 });
  // 等动画跑完
  await page.waitForTimeout(1800);
  const snap = await page.evaluate(() => ({
    marks: window.__perf.marks,
    long: window.__perf.long.slice(),
    frames: window.__perf.frames.slice(),
  }));
  // 切回日志页，为下一轮准备
  await page.evaluate(() => { location.hash = '#/logs'; });
  await page.waitForTimeout(900);
  rounds.push(snap);
}

console.log('=== ' + LABEL + ' ===');
rounds.forEach((s, i) => {
  const fmt = (v) => (v == null ? '-' : Math.round(v));
  const base = s.marks.click;
  const longAfter = s.long.filter((l) => l.start >= base - 100);
  const longTotal = longAfter.reduce((a, b) => a + b.dur, 0);
  const frames = s.frames;
  const worst = frames.length ? Math.max(...frames) : 0;
  const over33 = frames.filter((f) => f > 33).length;
  console.log(
    `round ${i}: 骨架→svg ${fmt(s.marks.svg - base)}ms | 长任务 ${longAfter.length} 个 共 ${Math.round(longTotal)}ms` +
    ` | 最长任务 ${fmt(Math.max(0, ...longAfter.map((l) => l.dur)))}ms` +
    ` | 帧数 ${frames.length} 最长帧 ${Math.round(worst)}ms 掉帧(>33ms) ${over33}`
  );
  if (longAfter.length) {
    console.log('   longtasks: ' + longAfter.map((l) => `${Math.round(l.start - base)}+${Math.round(l.dur)}ms`).join('  '));
  }
});

await browser.close();
