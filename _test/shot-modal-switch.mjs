// 打开渠道编辑弹窗，截其中的开关与下拉，验证居中
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

await page.goto(BASE + '/#/channels', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);

await page.locator('button[data-act="edit"]').first().click();
await page.waitForTimeout(1200);

const count = await page.locator('.modal .switch__track').count();
console.log('弹窗内 switch 数量', count);

const sw = page.locator('.modal .switch').first();
if (await sw.count()) {
  await sw.scrollIntoViewIfNeeded();
  const b = await sw.boundingBox();
  const bb = await page.evaluate(() => {
    const m = document.querySelector('.modal');
    if (!m) return null;
    const r = m.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  console.log('弹窗 box', bb, '开关 box', b);
  await page.screenshot({
    path: `${SHOT}/modal-switch.png`,
    clip: { x: b.x - 10, y: b.y - 10, width: Math.min(b.width + 20, 320), height: b.height + 20 },
  });
  await page.screenshot({ path: `${SHOT}/modal-full.png`, fullPage: false });
  console.log('saved');
}

const data = await page.evaluate(() => {
  const out = [];
  for (const t of document.querySelectorAll('.modal .switch__track')) {
    const cs = getComputedStyle(t);
    const a = getComputedStyle(t, '::after');
    const r = t.getBoundingClientRect();
    const innerH = r.height - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth);
    out.push({
      trackH: +r.height.toFixed(1),
      innerH: +innerH.toFixed(1),
      knobW: a.width, knobH: a.height,
      top: a.top, bottom: a.bottom, margin: a.marginTop + ' / ' + a.marginBottom,
      boxSizing: a.boxSizing,
      left: a.left,
      innerW: +(r.width - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth)).toFixed(1),
    });
  }
  return out;
});
console.log(JSON.stringify(data, null, 2));

await browser.close();
