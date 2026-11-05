// 最终回归：三页非多选态 + 深色多选态
import { chromium } from 'playwright-core';
const BASE = 'http://127.0.0.1:6821';
const SHOT = 'D:/code/ldm-api/_test/shots';
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', 'test1234');
  await page.click('#login-btn');
  await page.waitForTimeout(1500);
}
for (const [hash, name] of [['channels', 'channels'], ['models', 'models'], ['tokens', 'tokens']]) {
  await page.goto(BASE + '/#/' + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `${SHOT}/final-${name}.png`, fullPage: false });
  console.log('saved', name);
}
// 深色多选
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
for (const [hash, multi, name] of [['channels', '#ch-multi', 'channels-dark'], ['models', '#btn-multi', 'models-dark'], ['tokens', '#tk-multi', 'tokens-dark']]) {
  await page.goto(BASE + '/#/' + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(250);
  if (await page.locator(multi).count()) {
    await page.click(multi);
    await page.waitForTimeout(450);
  }
  await page.screenshot({ path: `${SHOT}/final-${name}.png`, fullPage: false });
  console.log('saved', name);
}
await browser.close();
console.log('done');
