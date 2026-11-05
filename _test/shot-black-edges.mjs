// 指定区域截图：顶栏+品牌、列表操作按钮、日志分页、令牌复制按钮、广场卡片按钮
import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:6821';
const PWD = 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';
const TAG = process.env.TAG || 'before';

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.77' }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1100);
}

const clipShot = async (name, sel, pad = 10) => {
  const box = await page.locator(sel).first().boundingBox();
  if (!box) { console.log('miss', name, sel); return; }
  await page.screenshot({
    path: `${SHOT}/${TAG}-${name}.png`,
    clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 },
  });
  console.log('saved', name);
};

await page.goto(BASE + '/#/dashboard', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
// 顶栏 + 品牌块一起裁
await page.screenshot({ path: `${SHOT}/${TAG}-top.png`, clip: { x: 0, y: 0, width: 1440, height: 120 } });
console.log('saved top');

await page.goto(BASE + '/#/channels', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
await clipShot('channels-ops', '.channels-card tbody tr:first-child');
await page.screenshot({ path: `${SHOT}/${TAG}-channels-topbar.png`, clip: { x: 900, y: 0, width: 540, height: 90 } });
// 测试弹窗
await page.locator('.channels-card tbody tr:first-child button', { hasText: '测试' }).first().click();
await page.waitForTimeout(900);
if (await page.locator('.modal').count()) {
  await page.screenshot({ path: `${SHOT}/${TAG}-modal-test.png` });
  console.log('saved modal-test');
  await page.locator('.modal__close').first().click().catch(() => {});
  await page.waitForTimeout(400);
}
// 添加渠道弹窗
await page.click('#btn-add-channel');
await page.waitForTimeout(800);
if (await page.locator('.modal').count()) {
  await page.screenshot({ path: `${SHOT}/${TAG}-modal-channel.png` });
  console.log('saved modal-channel');
  await page.locator('.modal__close').first().click().catch(() => {});
  await page.waitForTimeout(400);
}

await page.goto(BASE + '/#/models', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await clipShot('models-ops', '.models-card tbody tr:first-child');
await page.click('#btn-add-model').catch(() => {});
await page.waitForTimeout(800);
if (await page.locator('.modal').count()) {
  await page.screenshot({ path: `${SHOT}/${TAG}-modal-model.png` });
  console.log('saved modal-model');
  await page.locator('.modal__close').first().click().catch(() => {});
  await page.waitForTimeout(400);
}
await page.click('#btn-providers').catch(() => {});
await page.waitForTimeout(900);
if (await page.locator('.modal').count()) {
  await page.screenshot({ path: `${SHOT}/${TAG}-modal-providers.png` });
  console.log('saved modal-providers');
  await page.locator('.modal__close').first().click().catch(() => {});
  await page.waitForTimeout(400);
}

await page.goto(BASE + '/#/logs', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
await clipShot('logs-foot', '.table-foot');

await page.goto(BASE + '/#/tokens', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await clipShot('tokens-copy', '#copy-curl');
await clipShot('tokens-ops', '.tokens-card tbody tr:first-child');

await page.goto(BASE + '/#/plaza', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
const card = page.locator('.plaza-card, .model-card, article').first();
await clipShot('plaza-card', '.plaza-grid > *:first-child');

await browser.close();
console.log('done');
