// 桌面端：收起 / 展开右侧配置栏
// 依赖：npm i playwright-core（用系统已装的 Edge 通道跑，不需要另外下浏览器）
// 前置：起网关 LDMAPI_PASSWORD=test1234 -port 6821
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1200);
}
await page.goto(BASE + '/#/chat', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

const state = () => page.evaluate(() => {
  const side = document.querySelector('#chat-side');
  const main = document.querySelector('.chat-main');
  const top = document.querySelector('#chat-top');
  return {
    sideVisible: getComputedStyle(side).display !== 'none',
    mainLeft: Math.round(main.getBoundingClientRect().left),
    mainRight: Math.round(main.getBoundingClientRect().right),
    topVisible: !!top && !top.hidden,
  };
});
console.log('[初始]', JSON.stringify(await state()));
await page.screenshot({ path: 'D:/code/ldm-api/_test/shots/08-desktop-open.png' });

await page.click('#chat-side-close');
await page.waitForTimeout(700);
console.log('[收起后]', JSON.stringify(await state()));
await page.screenshot({ path: 'D:/code/ldm-api/_test/shots/09-desktop-collapsed.png' });

await page.click('#chat-side-toggle');
await page.waitForTimeout(700);
console.log('[展开后]', JSON.stringify(await state()));
await browser.close();
