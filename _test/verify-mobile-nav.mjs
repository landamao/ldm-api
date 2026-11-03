// 手机端：顶栏汉堡能开主导航；两个抽屉把手都能点开、关掉后完全滑出屏幕
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1300);
}
await page.evaluate(() => {
  const now = Date.now();
  localStorage.setItem('ldmapi.chat.sessions', JSON.stringify({
    activeId: 'a',
    sessions: [
      { id: 'a', title: '看看这个报错怎么排查', createdAt: now - 60e3, updatedAt: now - 60e3, model: '', messages: [{ role: 'user', content: '你好' }] },
      { id: 'b', title: '写个 Go 的限流中间件', createdAt: now - 3600e3, updatedAt: now - 3600e3, model: '', messages: [] },
    ],
  }));
});
await page.goto(BASE + '/#/chat', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);

const tapSel = async (sel) => {
  const box = await page.locator(sel).boundingBox();
  if (!box) return false;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(600);
  return true;
};
const state = () => page.evaluate(() => {
  const r = (s) => Math.round(document.querySelector(s).getBoundingClientRect().left);
  const rr = (s) => Math.round(document.querySelector(s).getBoundingClientRect().right);
  return {
    sidebarOpen: document.querySelector('.sidebar').classList.contains('is-open'),
    convLeft: r('#chat-conv'),
    sideRight: rr('#chat-side'),
    winW: innerWidth,
    layout: document.querySelector('#chat-layout').className,
  };
});

console.log('[初始]', JSON.stringify(await state()));

// 1) 顶栏汉堡 → 主导航
await tapSel('#btn-menu');
console.log('[点汉堡]', JSON.stringify(await state()));
await page.screenshot({ path: SHOT + '/mb-nav.png' });
// 点右侧空白关掉主导航
await page.touchscreen.tap(380, 500);
await page.waitForTimeout(600);
console.log('[关导航]', JSON.stringify(await state()));

// 2) 左把手 → 对话抽屉
await tapSel('#chat-conv-open');
console.log('[点左把手]', JSON.stringify(await state()));
await page.screenshot({ path: SHOT + '/mb-conv2.png' });
await tapSel('#chat-conv-collapse');
console.log('[收起后]', JSON.stringify(await state()));

// 3) 右把手 → 配置抽屉
await tapSel('#chat-side-open');
console.log('[点右把手]', JSON.stringify(await state()));
await page.screenshot({ path: SHOT + '/mb-side2.png' });

await browser.close();
console.log('done');
