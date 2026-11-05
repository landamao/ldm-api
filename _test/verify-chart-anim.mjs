// 验证动画确实在跑（不是瞬间跳到终态）：动画中途采样 strokeDashoffset / strokeDasharray
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(500);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', 'test1234');
  await page.click('#login-btn');
  await page.waitForTimeout(1200);
}
await page.goto(BASE + '/#/dashboard', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);

// 切到「全部时间」，让曲线有数据
const samples = await page.evaluate(async () => {
  const sel = document.querySelector('#dash-preset');
  sel.value = 'all';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  const out = { line: [], donut: [], totalText: [] };
  const t0 = performance.now();
  while (performance.now() - t0 < 1600) {
    await new Promise((r) => requestAnimationFrame(r));
    const p = document.querySelector('#trend-chart path.line');
    const arc = document.querySelector('#model-donut circle.donut-arc');
    if (p) out.line.push(Number(getComputedStyle(p).strokeDashoffset.replace('px', '')).toFixed(1));
    if (arc) out.donut.push(getComputedStyle(arc).strokeDasharray);
    const tt = document.querySelector('#model-donut .donut-total');
    if (tt) out.totalText.push(tt.textContent);
  }
  return out;
});
const uniq = (a) => Array.from(new Set(a));
console.log('line offset 采样数', samples.line.length, '不同值', uniq(samples.line).length);
console.log('  前 12 个:', samples.line.slice(0, 12).join(' '));
console.log('donut dasharray 采样数', samples.donut.length, '不同值', uniq(samples.donut).length);
console.log('  前 6 个:', samples.donut.slice(0, 6).join(' | '));
console.log('total 数字 不同值', uniq(samples.totalText).length, uniq(samples.totalText).slice(0, 8).join(' '));
await browser.close();
