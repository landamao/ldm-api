// 验证「清空对话」按钮：点一下直接清空，不再弹确认框
// 依赖：npm i playwright-core（用系统已装的 Edge 通道跑，不需要另外下浏览器）
// 前置：node mock-slow.mjs 4011 起慢速模拟上游；再起网关 LDMAPI_PASSWORD=test1234 -port 6821
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1200);
}
await page.goto(BASE + '/#/chat', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

// 走「临时测试（直连上游）」发一条真消息，让历史里真的有内容
const pickSelect = async (id, value) => {
  await page.evaluate(([sel, v]) => {
    const el = document.querySelector(sel);
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [id, value]);
};
await pickSelect('#chat-model', '__test__');
await page.waitForTimeout(400);
await page.fill('#chat-test-url', 'http://127.0.0.1:4011/v1');
await page.fill('#chat-test-key', 'sk-test');
await page.click('#chat-test-fetch');
await page.waitForTimeout(1200);
await pickSelect('#chat-test-model-select', 'slow');
await page.waitForTimeout(300);
await page.fill('#chat-text', '测试清空');
await page.click('#chat-send');
await page.waitForTimeout(2500);

const snap = () => page.evaluate(() => ({
  msgs: document.querySelectorAll('#chat-log .msg').length,
  history: JSON.parse(localStorage.getItem('ldmapi.chat') || '[]').length,
  visibleDialogs: [...document.querySelectorAll('body *')].filter((el) => {
    const cs = getComputedStyle(el);
    return (el.className && typeof el.className === 'string' && /modal|dialog|confirm/i.test(el.className))
      && cs.display !== 'none' && cs.visibility !== 'hidden' && el.getBoundingClientRect().height > 0;
  }).length,
  toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()),
}));
console.log('[清空前]', JSON.stringify(await snap()));

// 点「清空对话」——不应该有任何弹窗
await page.click('#chat-clear');
await page.waitForTimeout(500);
console.log('[点击后]', JSON.stringify(await snap()));
await page.screenshot({ path: SHOT + '/10-clear.png' });

// 空对话再点一次，不应报错
await page.click('#chat-clear');
await page.waitForTimeout(400);
console.log('[空对话再点一次]', JSON.stringify(await snap()));

await browser.close();
console.log('done');
