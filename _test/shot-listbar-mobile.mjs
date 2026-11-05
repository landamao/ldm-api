import { chromium } from 'playwright-core';
const BASE = 'http://127.0.0.1:6821';
const TAG = process.argv[2] || 'before';
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', 'test1234');
  await page.click('#login-btn');
  await page.waitForTimeout(1500);
}
const pages = [['channels', '#ch-multi', '#ch-exit'], ['models', '#btn-multi', '#m-exit'], ['tokens', '#tk-multi', '#tk-exit']];
for (const width of [390, 360]) {
  await page.setViewportSize({ width, height: 844 });
  for (const [hash, multi, exit] of pages) {
    await page.goto(BASE + '/#/' + hash, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(multi, { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(900);
    const dump = async (label) => {
      const m = await page.evaluate(() => {
        const q = (s) => document.querySelector(s);
        const r = (el) => el ? { l: Math.round(el.getBoundingClientRect().left), r: Math.round(el.getBoundingClientRect().right), t: Math.round(el.getBoundingClientRect().top), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null;
        const bar = q('.filter-bar');
        const picks = {};
        for (const s of ['.filter-bar__leads', '.filter-bar__batch', '.filter-chip--toggle:not([style*="display: none"])', '#channel-filter-count', '#filter-count', '#token-count']) {
          const el = q(s);
          if (el && el.offsetParent !== null) picks[s] = r(el);
        }
        return { bar: r(bar), overflow: bar ? bar.scrollWidth > bar.clientWidth + 1 : null, picks };
      });
      console.log(`${TAG} ${width} ${hash} ${label}`, JSON.stringify(m));
    };
    await dump('plain');
    await page.screenshot({ path: `shots/${TAG}-${width}-${hash}-plain.png` });
    await page.click(multi).catch(() => {});
    await page.waitForTimeout(500);
    await dump('multi');
    await page.screenshot({ path: `shots/${TAG}-${width}-${hash}-multi.png` });
    if (exit) await page.click(exit).catch(() => {});
  }
}
await browser.close();
console.log('done');
