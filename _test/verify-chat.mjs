// 验证聊天页：配置栏在右边 + 生成过程中可以向上滚动
// 依赖：npm i playwright-core（用系统已装的 Edge 通道跑，不需要另外下浏览器）
// 前置：node mock-slow.mjs 4011 起慢速模拟上游；再起网关 LDMAPI_PASSWORD=test1234 -port 6821
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--no-sandbox'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('[console error]', m.text()); });
page.on('pageerror', (e) => console.log('[page error]', e.message));
page.on('requestfailed', (r) => console.log('[req failed]', r.url(), r.failure() && r.failure().errorText));
page.on('response', async (r) => {
  if (r.status() >= 400) console.log('[http]', r.status(), r.url());
});

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800);

// 登录
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1200);
}

// 打开在线聊天页
await page.goto(BASE + '/#/chat', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.screenshot({ path: SHOT + '/01-chat.png' });

// --- 检查 1：配置栏在右边 ---
const layout = await page.evaluate(() => {
  const side = document.querySelector('#chat-side');
  const main = document.querySelector('.chat-main');
  const s = side.getBoundingClientRect();
  const m = main.getBoundingClientRect();
  return {
    sideLeft: Math.round(s.left), sideRight: Math.round(s.right),
    mainLeft: Math.round(m.left), mainRight: Math.round(m.right),
    sideAfterMain: s.left > m.left,
  };
});
console.log('[布局]', JSON.stringify(layout));

// --- 临时测试模式：直连慢速模拟上游 ---
// 原生 select 被自绘下拉接管了，直接改 value 再派发 change
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
await page.screenshot({ path: SHOT + '/02-testmode.png' });

// 选模型 slow
await pickSelect('#chat-test-model-select', 'slow');
await page.waitForTimeout(400);

// --- 检查 2：生成过程中向上滚动 ---
await page.fill('#chat-text', '请给我一段很长的内容');
await page.click('#chat-send');
await page.waitForTimeout(1200);

// 生成中：等内容撑出滚动条后手动往上滚
const dump = () => page.evaluate(() => {
  const log = document.querySelector('#chat-log');
  const btn = document.querySelector('#chat-to-bottom');
  return {
    scrollTop: Math.round(log.scrollTop),
    scrollHeight: log.scrollHeight,
    clientHeight: log.clientHeight,
    msgs: log.querySelectorAll('.msg').length,
    lastLen: (log.querySelector('.msg:last-child .msg__answer') || {}).textContent?.length || 0,
    btnHidden: btn ? btn.hidden : null,
  };
});
// 等到内容溢出、可以滚动为止
await page.waitForFunction(() => {
  const log = document.querySelector('#chat-log');
  return log && log.scrollHeight > log.clientHeight + 200;
}, { timeout: 20000 });
const before = await dump();
console.log('[溢出后]', JSON.stringify(before));
await page.evaluate(() => { document.querySelector('#chat-log').scrollTop = 0; });
await page.waitForTimeout(300);
console.log('[已手动上滚]', JSON.stringify(await dump()));
await page.waitForTimeout(2500);
const during = await dump();
during.gap = during.scrollHeight - during.scrollTop - during.clientHeight;
console.log('[生成中 · 上滚后]', JSON.stringify(during));
await page.screenshot({ path: SHOT + '/03-scrolled-up.png' });

// 等生成结束，看是否被拽回底部
await page.waitForTimeout(16000);
const after = await dump();
after.gap = after.scrollHeight - after.scrollTop - after.clientHeight;
console.log('[生成结束]', JSON.stringify(after));
await page.screenshot({ path: SHOT + '/04-after-stream.png' });

// 点「回到底部」
if (after.btnHidden === false) {
  await page.click('#chat-to-bottom');
  await page.waitForTimeout(600);
  const back = await page.evaluate(() => {
    const log = document.querySelector('#chat-log');
    return { gap: log.scrollHeight - log.scrollTop - log.clientHeight };
  });
  console.log('[点回到底部后]', JSON.stringify(back));
  await page.screenshot({ path: SHOT + '/05-back-to-bottom.png' });
}

// --- 检查 3：窄屏抽屉从右侧滑入 ---
await page.setViewportSize({ width: 700, height: 900 });
await page.waitForTimeout(600);
await page.screenshot({ path: SHOT + '/06-mobile.png' });

await browser.close();
console.log('done');
