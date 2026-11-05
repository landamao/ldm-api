// 手机端顶栏汉堡键：确认是平的（无投影/无内高光），并截图对比
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1300);
}
await page.waitForTimeout(800);

const info = await page.evaluate(() => {
  const el = document.querySelector('#btn-menu');
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const tb = document.querySelector('.topbar').getBoundingClientRect();
  return {
    boxShadow: cs.boxShadow,
    background: cs.backgroundColor + ' / ' + cs.backgroundImage,
    border: cs.borderTopWidth + ' ' + cs.borderTopColor,
    size: [Math.round(r.width), Math.round(r.height)],
    btnRect: [Math.round(r.x), Math.round(r.y)],
    topbarRect: [Math.round(tb.x), Math.round(tb.y), Math.round(tb.width), Math.round(tb.height)],
  };
});
console.log('[btn-menu]', JSON.stringify(info, null, 2));

// 截图：顶栏左上角一块，放大看边缘有没有凸起
await page.screenshot({ path: SHOT + '/mb-menu-full.png' });
const tb = info.topbarRect;
await page.screenshot({
  path: SHOT + '/mb-menu-zoom.png',
  clip: { x: tb[0] - 2, y: tb[1] - 2, width: 140, height: 60 },
});

await browser.close();
console.log('done');
