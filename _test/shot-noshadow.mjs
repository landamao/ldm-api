// 去阴影 + 广场平铺回归截图
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1400);
}

const shot = async (hash, name, wait = 1600) => {
  await page.goto(BASE + '/#/' + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${SHOT}/noshadow-${name}.png` });
  console.log('saved', name);
};

await shot('dashboard', 'dash');
await shot('plaza', 'plaza', 2200);
await shot('tokens', 'tokens', 1800);

// 深色主题
await page.click('#btn-theme');
await page.waitForTimeout(600);
await shot('dashboard', 'dash-dark');
await shot('plaza', 'plaza-dark', 2000);

// 检查是否还有计算出来的阴影
const residual = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('*').forEach((el) => {
    const cs = getComputedStyle(el);
    const bs = cs.boxShadow && cs.boxShadow !== 'none' ? cs.boxShadow : '';
    const ts = cs.textShadow && cs.textShadow !== 'none' ? cs.textShadow : '';
    const f = cs.filter && cs.filter.includes('drop-shadow') ? cs.filter : '';
    if (bs || ts || f) out.push({ cls: el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className, bs, ts, f });
  });
  return out.slice(0, 20);
});
console.log('residual shadows:', JSON.stringify(residual, null, 1));

await browser.close();
console.log('done');
