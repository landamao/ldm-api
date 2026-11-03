// 窄屏抽屉：左右两栏滑出来时的底色（不能透出后面的对话框）
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(900);
}
await page.evaluate(() => {
  const now = Date.now();
  localStorage.setItem('ldmapi.chat.sessions', JSON.stringify({
    activeId: 'a',
    sessions: [
      { id: 'a', title: '看看这个报错怎么排查', createdAt: now - 60e3, updatedAt: now - 60e3, model: '', messages: [] },
      { id: 'b', title: '写个 Go 的限流中间件', createdAt: now - 3600e3, updatedAt: now - 3600e3, model: '', messages: [] },
    ],
  }));
});
await page.goto(BASE + '/#/chat', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1400);

// 打开左侧对话抽屉
await page.click('#chat-conv-open');
await page.waitForTimeout(600);
const left = await page.evaluate(() => {
  const r = document.querySelector('#chat-conv').getBoundingClientRect();
  return { left: Math.round(r.left), w: Math.round(r.width), bg: getComputedStyle(document.querySelector('#chat-conv')).backgroundColor };
});
console.log('[左抽屉]', JSON.stringify(left));
await page.screenshot({ path: SHOT + '/mb-conv-drawer.png' });
await page.click('#chat-conv-collapse');
await page.waitForTimeout(500);

// 打开右侧配置抽屉
await page.click('#chat-side-open');
await page.waitForTimeout(600);
const right = await page.evaluate(() => {
  const r = document.querySelector('#chat-side').getBoundingClientRect();
  return { right: Math.round(r.right), winW: window.innerWidth, bg: getComputedStyle(document.querySelector('#chat-side')).backgroundColor };
});
console.log('[右抽屉]', JSON.stringify(right));
await page.screenshot({ path: SHOT + '/mb-side-drawer.png' });

await browser.close();
console.log('done');
