// 数据看板截图：登录 → 进看板 → 等图表画完 → 截整页上半部分
// 用法：node shot-dash.mjs before|after
import { chromium } from 'playwright-core';

const LABEL = process.argv[2] || 'dash';
const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1300);
}
await page.goto(BASE + '/#/dashboard', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
// 演示库的日志不在「今日」区间里，切成「全部时间」再截
await page.evaluate(() => {
  const el = document.querySelector('#dash-preset');
  if (el) { el.value = 'all'; el.dispatchEvent(new Event('change', { bubbles: true })); }
});
await page.waitForTimeout(2600);
await page.screenshot({ path: `${SHOT}/dash-${LABEL}.png`, fullPage: false });
console.log('saved', `${SHOT}/dash-${LABEL}.png`);
await browser.close();
