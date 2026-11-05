// 开关 / 搜索图标 修复后的高清对照截图
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.77' }, deviceScaleFactor: 4 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1000);
}

for (const name of ['channels', 'models', 'settings', 'tokens', 'logs']) {
  await page.goto(`${BASE}/#/${name}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const has = await page.locator('.switch__track').count();
  console.log(name, 'switch 数量', has);
  if (has) {
    const el = page.locator('.switch__track').first();
    await el.scrollIntoViewIfNeeded();
    const box = await el.boundingBox();
    if (box) {
      const host = page.locator('.switch').first();
      const hb = await host.boundingBox();
      await page.screenshot({
        path: `${SHOT}/switch-${name}.png`,
        clip: { x: hb.x - 8, y: hb.y - 8, width: Math.min(hb.width + 16, 260), height: hb.height + 16 },
      });
      console.log('  saved switch-' + name + '.png');
    }
  }
  const s = page.locator('.filter-bar .search, .chat-conv__search .input').first();
  if (await s.count()) {
    const sb = await s.boundingBox();
    if (sb) {
      await page.screenshot({
        path: `${SHOT}/search-${name}.png`,
        clip: { x: sb.x - 4, y: sb.y - 4, width: Math.min(sb.width + 8, 300), height: sb.height + 8 },
      });
      console.log('  saved search-' + name + '.png');
    }
  }
}

await browser.close();
console.log('done');
