// 量令牌页工具条：bar / leads / 计数 / 多选按钮的相对位置
import { chromium } from 'playwright-core';
const BASE = 'http://127.0.0.1:6821';
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
for (const [hash, multi] of [['tokens', '#tk-multi'], ['channels', '#ch-multi'], ['models', '#btn-multi']]) {
  await page.goto(BASE + '/#/' + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(multi, { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(900);
  const dump = async (label) => {
    const m = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const box = (el) => el ? (() => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom) }; })() : null;
      const bar = q('.filter-bar');
      const toggle = q('.filter-chip--toggle:not([style*="display: none"])');
      const leads = q('.filter-bar__leads');
      const cs = bar ? getComputedStyle(bar) : null;
      return {
        bar: box(bar),
        pad: cs ? { t: cs.paddingTop, r: cs.paddingRight, b: cs.paddingBottom, l: cs.paddingLeft, align: cs.alignItems } : null,
        leads: box(leads),
        toggle: box(toggle),
        toggleOffset: toggle && bar ? { top: Math.round(toggle.getBoundingClientRect().top - bar.getBoundingClientRect().top), bottom: Math.round(bar.getBoundingClientRect().bottom - toggle.getBoundingClientRect().bottom) } : null,
        leadsOffset: leads && bar ? { top: Math.round(leads.getBoundingClientRect().top - bar.getBoundingClientRect().top), bottom: Math.round(bar.getBoundingClientRect().bottom - leads.getBoundingClientRect().bottom) } : null,
      };
    });
    console.log(hash, label, JSON.stringify(m));
  };
  await dump('plain');
  const tb = await page.locator('.filter-bar').boundingBox();
  await page.screenshot({ path: `shots/token-bar-${hash}.png`, clip: { x: tb.x - 6, y: tb.y - 6, width: tb.width + 12, height: tb.height + 40 } });
  await page.click(multi);
  await page.waitForTimeout(400);
  await dump('multi');
}
await browser.close();
console.log('done');
