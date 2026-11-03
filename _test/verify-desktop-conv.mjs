// 桌面宽度回归：左侧栏收起 / 展开仍是原来的负 margin 方案，遮罩不出现
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(500);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1100);
}
await page.goto(BASE + '/#/chat', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1100);
const m = () => page.evaluate(() => {
  const el = document.querySelector('#chat-conv');
  const r = el.getBoundingClientRect();
  return {
    left: Math.round(r.left), w: Math.round(r.width),
    marginLeft: getComputedStyle(el).marginLeft,
    scrim: getComputedStyle(document.querySelector('#chat-conv-scrim')).display,
    cls: document.querySelector('.chat-layout').className,
  };
});
console.log('[桌面 初始]', JSON.stringify(await m()));
await page.click('#chat-conv-collapse');
await page.waitForTimeout(400);
console.log('[桌面 收起]', JSON.stringify(await m()));
await page.screenshot({ path: 'D:/code/ldm-api/_test/shots/v2-desktop-collapsed.png' });
await page.click('#chat-conv-open');
await page.waitForTimeout(400);
console.log('[桌面 展开]', JSON.stringify(await m()));
await page.screenshot({ path: 'D:/code/ldm-api/_test/shots/v2-desktop-open.png' });
await browser.close();
