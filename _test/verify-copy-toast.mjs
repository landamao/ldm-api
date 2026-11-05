// 验证聊天消息下的复制键只弹一个提示、复制的是消息正文。
// 之前这枚按钮带着 data-copy="1"，会被 app.js 的全局委托当成载荷再复制一次 "1"，
// 于是点一下弹两个 toast，剪贴板最后还变成 "1"。
// 依赖：node _test/mock-usage.mjs 4021；网关 LDMAPI_DEV=web
// 跑法：LDM_BASE=http://127.0.0.1:6824 node _test/verify-copy-toast.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6824';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const MOCK = process.env.LDM_MOCK || 'http://127.0.0.1:4021/v1';

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write'],
  extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.77' },
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1000);
}
await page.goto(BASE + '/#/chat', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

const pickSelect = async (sel, value) => {
  await page.evaluate(([s, v]) => {
    const el = document.querySelector(s);
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [sel, value]);
};

await pickSelect('#chat-model', '__test__');
await page.waitForTimeout(300);
await page.fill('#chat-test-url', MOCK);
await page.fill('#chat-test-key', 'sk-test');
await page.click('#chat-test-fetch');
await page.waitForTimeout(1000);
await pickSelect('#chat-test-model-select', 'usage-tool');
await page.waitForTimeout(300);
await page.fill('#chat-text', '你好');
await page.click('#chat-send');
await page.waitForTimeout(5000);

// 清掉发送过程中可能残留的提示，只数复制这一次的
await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));

// 兼容改动前的 data-copy，用来确认这条断言真能抓到「一次两个提示」
const btn = page.locator('.msg__actions [data-msg-copy], .msg__actions [data-copy]').last();
if (!(await btn.count())) {
  console.error('[失败] 没找到消息下的复制键');
  await browser.close();
  process.exit(1);
}
await btn.click();
await page.waitForTimeout(300);

const toasts = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()));
const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
const body = await page.evaluate(() => {
  const bodies = [...document.querySelectorAll('.msg__body')];
  const el = bodies[bodies.length - 1];
  const ans = el && el.querySelector('.msg__answer');
  return ans ? ans.textContent.trim() : '';
});

console.log('[toast]', JSON.stringify(toasts));
console.log('[剪贴板]', JSON.stringify(clip.slice(0, 60)));
console.log('[正文]', JSON.stringify(body.slice(0, 60)));

const fails = [];
if (toasts.length !== 1) fails.push(`应只弹 1 个提示，实际 ${toasts.length} 个：${toasts.join(' / ')}`);
if (clip === '1') fails.push('剪贴板被全局委托覆盖成了 "1"');
if (body && !clip.startsWith(body.slice(0, 10))) fails.push(`剪贴板内容不是这条回复：${clip.slice(0, 30)}`);

await browser.close();
if (fails.length) {
  console.error('[失败]');
  fails.forEach((f) => console.error(' - ' + f));
  process.exit(1);
}
console.log('[通过] 复制键只弹一个提示，剪贴板是回复正文');
