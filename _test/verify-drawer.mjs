// 窄屏下检查「模型配置」抽屉是否从右侧滑入
// 依赖：npm i playwright-core（用系统已装的 Edge 通道跑，不需要另外下浏览器）
// 前置：起网关 LDMAPI_PASSWORD=test1234 -port 6821
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 700, height: 900 } });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1200);
}
await page.goto(BASE + '/#/chat', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

// 点顶栏的设置按钮打开抽屉
await page.click('#chat-side-toggle');
await page.waitForTimeout(700);
const box = await page.evaluate(() => {
  const s = document.querySelector('#chat-side').getBoundingClientRect();
  return { left: Math.round(s.left), right: Math.round(s.right), w: Math.round(s.width), winW: window.innerWidth };
});
console.log('[抽屉位置]', JSON.stringify(box));
console.log('[抽屉贴右边]', box.right === box.winW);
await page.screenshot({ path: 'D:/code/ldm-api/_test/shots/07-mobile-drawer.png' });
await browser.close();
