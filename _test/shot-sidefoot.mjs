import { chromium } from 'playwright-core';
const BASE = 'http://127.0.0.1:6821';
const SHOT = 'D:/code/ldm-api/_test/shots';
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
for (const theme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.83' }, deviceScaleFactor: 3 });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  if (await page.locator('#login-pwd').count()) { await page.fill('#login-pwd', 'test1234'); await page.click('#login-btn'); await page.waitForTimeout(1100); }
  if (theme === 'dark') {
    await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); try { localStorage.setItem('ldmapi.theme', 'dark'); } catch (e) {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
  }
  await page.waitForTimeout(600);
  const b = await page.locator('.sidebar__foot').boundingBox();
  await page.screenshot({ path: `${SHOT}/foot-${theme}.png`, clip: { x: b.x - 4, y: b.y - 4, width: b.width + 8, height: b.height + 8 } });
  await ctx.close();
}
await browser.close();
console.log('done');
