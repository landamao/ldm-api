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
for (const width of [1200, 1024, 768, 400]) {
  await page.setViewportSize({ width, height: 900 });
  for (const [hash, multi] of [['channels', '#ch-multi'], ['models', '#btn-multi'], ['tokens', '#tk-multi']]) {
    await page.goto(BASE + '/#/' + hash, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(multi, { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(800);
    await page.click(multi).catch(() => {});
    await page.waitForTimeout(500);
    const m = await page.evaluate(() => {
      const bar = document.querySelector('.filter-bar');
      const leads = document.querySelector('.filter-bar__leads');
      const batch = document.querySelector('.filter-bar__batch');
      const r = (el) => (el ? { l: Math.round(el.getBoundingClientRect().left), r: Math.round(el.getBoundingClientRect().right), t: Math.round(el.getBoundingClientRect().top) } : null);
      const inputs = [...document.querySelectorAll('.filter-bar .search')].map((el) => Math.round(el.getBoundingClientRect().width));
      return {
        bar: r(bar), leads: r(leads), batch: r(batch),
        overflow: bar.scrollWidth > bar.clientWidth + 1,
        inputs,
      };
    });
    console.log(width, hash, JSON.stringify(m));
  }
}
await browser.close();
console.log('done');
