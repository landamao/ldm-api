// 量品牌牌匾与导航面板 / 右侧内容的间距
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

const m = await page.evaluate(() => {
  const r = (s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), right: +b.right.toFixed(1), bottom: +b.bottom.toFixed(1) };
  };
  const brand = r('.sidebar__brand');
  const nav = r('.sidebar__nav');
  const topbar = r('.topbar');
  const content = r('.content__inner');
  return {
    brand, nav, topbar, content,
    gapBrandToNav: brand && nav ? +(nav.y - brand.bottom).toFixed(1) : null,
    gapBrandToTopbar: brand && topbar ? +(topbar.x - brand.right).toFixed(1) : null,
    gapBrandToContent: brand && content ? +(content.x - brand.right).toFixed(1) : null,
    gapNavToContent: nav && content ? +(content.x - nav.right).toFixed(1) : null,
  };
});
console.log(JSON.stringify(m, null, 1));
await browser.close();
