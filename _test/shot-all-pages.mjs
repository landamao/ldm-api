// 全站 8 页回归截图（居中统一改造后）
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';
const THEME = process.env.LDM_THEME || 'light';
const W = Number(process.env.LDM_W || 1440);
const H = Number(process.env.LDM_H || 900);
const SUFFIX = (THEME === 'dark' ? '-dark' : '') + (W < 900 ? '-m' : '');

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.77' }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1100);
}
if (THEME === 'dark') {
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
    try { localStorage.setItem('ldmapi.theme', 'dark'); } catch (e) {}
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
}

const shot = async (hash, name, wait) => {
  await page.goto(BASE + '/#/' + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${SHOT}/fix${SUFFIX}-${name}.png` });
  console.log('saved', name);
};

await shot('dashboard', 'dashboard', 2000);
await shot('channels', 'channels', 1800);
await shot('models', 'models', 1600);
await shot('logs', 'logs', 2000);
await shot('chat', 'chat', 1800);
await shot('plaza', 'plaza', 1800);
await shot('settings', 'settings', 1500);
await shot('tokens', 'tokens', 1500);

await browser.close();
console.log('done');
