// 截左上角品牌牌匾区域，确认上下左右间隙
import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:6821';
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', 'test1234');
  await page.click('#login-btn');
  await page.waitForTimeout(1500);
}
await page.screenshot({ path: 'D:/code/ldm-api/_test/shots/brand-gap-top.png', clip: { x: 0, y: 0, width: 320, height: 230 } });
console.log('saved');
await browser.close();
