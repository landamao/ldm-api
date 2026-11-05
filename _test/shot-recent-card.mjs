// 截「最近调用」卡片：滚到该卡片位置
import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:6821';
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', 'test1234');
  await page.click('#login-btn');
  await page.waitForTimeout(1500);
}
await page.goto(BASE + '/#/dashboard', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);

const card = page.locator('.card', { has: page.locator('#recent-logs') }).first();
await card.scrollIntoViewIfNeeded();
await page.waitForTimeout(500);
await card.screenshot({ path: 'D:/code/ldm-api/_test/shots/recent-card.png' });
console.log('card box:', await card.boundingBox());
console.log('sub texts:', await card.locator('.card__sub').count());
await browser.close();
console.log('done');
