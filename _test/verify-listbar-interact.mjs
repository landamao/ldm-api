import { chromium } from 'playwright-core';
const BASE = 'http://127.0.0.1:6821';
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', 'test1234');
  await page.click('#login-btn');
  await page.waitForTimeout(1500);
}
const cases = [
  ['channels', '#ch-multi', '#ch-checkall', '#channel-multi-count', '#ch-exit'],
  ['models', '#btn-multi', '#m-checkall', '#multi-count', '#m-exit'],
  ['tokens', '#tk-multi', '#tk-checkall', '#token-multi-count', '#tk-exit'],
];
for (const [hash, enter, all, counter, exit] of cases) {
  await page.goto(BASE + '/#/' + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(enter, { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(900);
  await page.click(enter);
  await page.waitForTimeout(500);
  const hasAll = await page.locator(all).count();
  if (hasAll) await page.click(all);
  await page.waitForTimeout(300);
  const text = await page.locator(counter).textContent();
  const batchVisible = await page.locator('#ch-batch, #m-batch, #tk-batch').first().isVisible();
  const exitVisible = await page.locator(exit).isVisible();
  await page.click(exit);
  await page.waitForTimeout(400);
  const backToMulti = await page.locator(enter).isVisible();
  console.log(hash, 'checkall:', hasAll, 'counter:', text.trim(), 'batch:', batchVisible, 'exit:', exitVisible, 'back:', backToMulti);
}
await browser.close();
console.log('done');
