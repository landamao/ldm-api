// 校验：toggle 位置固定 + 有空间不换行 + 换行时批量组靠左
import { chromium } from 'playwright-core';
const BASE = 'http://127.0.0.1:6821';
const SHOT = 'D:/code/ldm-api/_test/shots';
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 880 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', 'test1234');
  await page.click('#login-btn');
  await page.waitForTimeout(1500);
}

const pages = [
  ['channels', '#ch-multi', '#ch-exit', '#ch-batch'],
  ['models', '#btn-multi', '#m-exit', '#m-batch'],
  ['tokens', '#tk-multi', '#tk-exit', '#tk-batch'],
];

for (const width of [1440, 1280, 820]) {
  await page.setViewportSize({ width, height: 880 });
  await page.waitForTimeout(400);
  for (const [hash, enter, exit, batch] of pages) {
    await page.goto(BASE + '/#/' + hash, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(enter, { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(900);
    const rect = (sel) => page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), w: Math.round(r.width) };
    }, sel);
    const barBefore = await rect('.filter-bar');
    const before = await rect(enter);
    await page.click(enter);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOT}/listbar3-${width}-${hash}.png`, fullPage: false });
    const after = await rect(exit);
    const b = await rect(batch);
    const barAfter = await rect('.filter-bar');
    console.log(width, hash,
      'toggleDiff', JSON.stringify({ l: after.l - before.l, r: after.r - before.r, t: after.t - before.t }),
      'barH', barBefore.h || barBefore.w ? null : null, 'bar', barBefore.t, '->', barAfter.t,
      'batch', JSON.stringify(b), 'batchOnSecondLine', b.t > before.t);
    await page.click(exit);
    await page.waitForTimeout(400);
  }
}

await browser.close();
console.log('done');
