// 验证提示条（Toast）的复制键：屏幕上展示的正文可以截断，
// 但复制出去的必须是完整原文（模型测试失败时，上游返回的那段报错）。
// 之前展示和复制共用同一个已经被截断的字符串，复制出来仍然带省略号。
// 依赖：网关已跑起来（LDMAPI_DEV=web 指向 web 目录）
// 跑法：LDM_BASE=http://127.0.0.1:6826 node _test/verify-toast-copy-full.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6826';
const PWD = process.env.LDM_PASSWORD || 'test1234';

const fails = [];
const ok = (cond, msg, extra) => {
  if (cond) console.log('  ok   ' + msg);
  else { console.log('  FAIL ' + msg + (extra ? ' -> ' + extra : '')); fails.push(msg); }
};

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write'],
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

const FULL = '耗时 128 ms\n渠道 demo → 上游模型 gpt-4o\nHTTP 400\n\n' + '上游返回：字段 messages 不合法，'.repeat(60) + '结尾标记';
const SHOWN = '耗时 128 ms\n渠道 demo → 上游模型 gpt-4o\nHTTP 400\n\n' + '上游返回：字段 messages 不合法，'.repeat(20) + '…';

// ---------- 1. 传了 copyBody：展示用截断版，复制用全文 ----------
await page.evaluate(([shown, full]) => {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  window.LDM.Toast.show('error', '「demo/m」测试失败', shown, 60000, full);
}, [SHOWN, FULL]);
await page.waitForTimeout(150);

const shownText = await page.evaluate(() => document.querySelector('.toast__msg')?.textContent || '');
ok(shownText === SHOWN, '提示条正文按传入的截断版展示', shownText.slice(-8));
ok(shownText.endsWith('…'), '展示的正文结尾是省略号（确认测试场景真实）', shownText.slice(-3));

// Windows 的剪贴板会把 \n 规范成 \r\n，比对前统一换行
const readClip = () => page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
const norm = (s) => s.replace(/\r\n/g, '\n');

await page.click('.toast [data-toast-copy]');
await page.waitForTimeout(300);
const clip1 = norm(await readClip());
ok(clip1 === '「demo/m」测试失败\n' + FULL, '复制得到完整原文（标题 + 完整正文）',
  `剪贴板长度 ${clip1.length} / 期望 ${('「demo/m」测试失败\n' + FULL).length}`);
ok(!clip1.endsWith('…'), '复制内容结尾不是省略号', clip1.slice(-8));
ok(clip1.includes('结尾标记'), '复制内容包含上游原文的最后一段');

// ---------- 2. 没传 copyBody：仍按「标题 + 正文」复制（旧行为不变） ----------
await page.evaluate(() => {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  window.LDM.Toast.show('info', '模型已复制', 'gpt-4o-mini', 60000);
});
await page.waitForTimeout(150);
await page.click('.toast [data-toast-copy]');
await page.waitForTimeout(300);
const clip2 = norm(await readClip());
ok(clip2 === '模型已复制\ngpt-4o-mini', '未传 copyBody 时回退到标题 + 正文', JSON.stringify(clip2));

// ---------- 3. 复制键不应该把提示条点掉 ----------
// 复制成功本身会再弹一条「已复制到剪贴板」，所以只认原来那条还在不在
const stillThere = await page.evaluate(() => [...document.querySelectorAll('.toast__title')]
  .some((t) => t.textContent.trim() === '模型已复制'));
ok(stillThere, '点复制键不会顺带关掉提示条', String(stillThere));

await browser.close();
if (fails.length) {
  console.error('[失败]');
  fails.forEach((f) => console.error(' - ' + f));
  process.exit(1);
}
console.log('[通过] 提示条展示截断、复制全文，未传全文时回退旧行为');
