// 用 CDP Performance 指标拆解切到看板页的成本：脚本 / 布局 / 样式重算 各占多少
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send('Performance.enable');

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(500);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', 'test1234');
  await page.click('#login-btn');
  await page.waitForTimeout(1200);
}
await page.goto(BASE + '/#/logs', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

const pick = (m) => {
  const o = {};
  for (const x of m.metrics) o[x.name] = x.value;
  return o;
};

for (let r = 0; r < 3; r++) {
  const before = pick(await cdp.send('Performance.getMetrics'));
  await page.evaluate(() => document.querySelector('a[data-page="dashboard"]').click());
  await page.waitForTimeout(2600);
  const after = pick(await cdp.send('Performance.getMetrics'));
  const d = (k) => (after[k] - before[k]);
  console.log(
    `round ${r}: Script ${(d('ScriptDuration') * 1000).toFixed(0)}ms | Layout ${(d('LayoutDuration') * 1000).toFixed(0)}ms (${d('LayoutCount')} 次)` +
    ` | Style ${(d('RecalcStyleDuration') * 1000).toFixed(0)}ms (${d('RecalcStyleCount')} 次)` +
    ` | Task ${(d('TaskDuration') * 1000).toFixed(0)}ms | JS 堆 +${(d('JSHeapUsedSize') / 1048576).toFixed(1)}MB`
  );
  await page.evaluate(() => { location.hash = '#/logs'; });
  await page.waitForTimeout(900);
}

await browser.close();
