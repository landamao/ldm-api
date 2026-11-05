// 环形图名字气泡截图（白天 / 夜晚各一张）
import { chromium } from 'playwright-core';
const BASE = 'http://127.0.0.1:6821';
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
for (const theme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.9' + (theme === 'light' ? '5' : '6') } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('ldmapi.theme', t), theme);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  if (await page.locator('#login-pwd').count()) { await page.fill('#login-pwd', 'test1234'); await page.click('#login-btn'); await page.waitForTimeout(1200); }
  await page.goto(BASE + '/#/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await page.evaluate(() => { const el = document.querySelector('#dash-preset'); if (el) { el.value = 'all'; el.dispatchEvent(new Event('change', { bubbles: true })); } });
  await page.waitForTimeout(2200);
  const el = page.locator('.donut-legend__name.chart-name--clip').first();
  await el.hover();
  await page.waitForTimeout(300);
  const card = await page.locator('#model-donut').evaluate((n) => { const r = n.closest('.card').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; });
  await page.screenshot({ path: `D:/code/ldm-api/_test/shots/donut-tip-${theme}.png`, clip: { x: card.x - 24, y: card.y - 24, width: card.w + 48, height: card.h + 48 } });
  console.log(theme, 'saved', card);
  await ctx.close();
}
await browser.close();
