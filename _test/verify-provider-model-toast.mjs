// 回归：提供商 ID 内部生成（弹窗不再有 ID 输入 / 列表不再有 ID 列）、
// 模型管理模型名徽章（无提供商图标、点一下复制）、Toast 复制按钮
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';

let failed = 0;
const check = (ok, msg) => {
  console.log((ok ? '  ✓ ' : '  ✗ ') + msg);
  if (!ok) failed++;
};

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  permissions: ['clipboard-read', 'clipboard-write'],
  extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.91' },
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1200);
}

// ---------- 模型管理：模型名徽章 ----------
await page.goto(BASE + '/#/models', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${SHOT}/chk-model-name-badge.png` });

const firstRow = page.locator('#model-table tbody tr').first();
const nameCell = firstRow.locator('td').nth(0);
const badgeCount = await nameCell.locator('button.badge--model[data-copy]').count();
check(badgeCount === 1, '模型名是单枚可点击复制的徽章');
check(await nameCell.locator('.provider-icon').count() === 0, '模型名单元格里没有提供商图标');
check(await nameCell.locator('[data-mact=copy]').count() === 0, '模型名右侧不再有单独的复制按钮');
const modelID = await nameCell.locator('button.badge--model').getAttribute('data-copy');
console.log('    第一行模型：' + modelID + '，单元格宽 ' + (await nameCell.boundingBox()).width.toFixed(0) + 'px');
check((await nameCell.boundingBox()).width <= 340, '长模型名没有把列撑宽（≤340px）');

// 点模型名 → 复制 + 弹提示
await nameCell.locator('button.badge--model').click();
await page.waitForTimeout(500);
const toast = page.locator('.toast').last();
check(await toast.count() === 1, '点模型名后弹出提示');
check((await toast.locator('.toast__msg').textContent()).includes('模型 ID 已复制'), '提示文案是「模型 ID 已复制」');
const clip = await page.evaluate(() => navigator.clipboard.readText());
check(clip === modelID, `剪贴板拿到模型 ID（${clip}）`);
await page.screenshot({ path: `${SHOT}/chk-toast-copy.png` });

// ---------- Toast 复制按钮 ----------
const copyBtn = toast.locator('[data-toast-copy]');
check(await copyBtn.count() === 1, '提示条上有复制按钮');
await copyBtn.click();
await page.waitForTimeout(600);
const copied = await page.evaluate(() => navigator.clipboard.readText());
check(copied.includes('模型 ID 已复制'), `复制按钮复制了整条提示正文（${JSON.stringify(copied)}）`);
check(await toast.count() === 1, '点复制按钮不会把原提示关掉');
check((await page.locator('.toast').count()) >= 2, '复制后给了「已复制」反馈');

// 带长正文的提示要能整段复制
await page.evaluate(() => window.LDM.Toast.show('error', '「demo-model」测试失败', '1234ms\n\n上游返回：401 invalid api key', 0));
await page.waitForTimeout(300);
const errToast = page.locator('.toast').last();
await errToast.locator('[data-toast-copy]').click();
await page.waitForTimeout(400);
const longCopy = await page.evaluate(() => navigator.clipboard.readText());
// Windows 剪贴板会把换行统一成 CRLF，比对前先归一
const wantLong = '「demo-model」测试失败\n1234ms\n\n上游返回：401 invalid api key';
check(longCopy.replace(/\r\n/g, '\n') === wantLong, '标题 + 多行正文一起复制：' + JSON.stringify(longCopy));

// 清掉提示，避免挡住后面的截图
await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));

// ---------- 提供商管理 ----------
await page.click('#btn-providers');
await page.waitForTimeout(700);
const pvTable = page.locator('#pv-list table');
check(await pvTable.locator('thead th', { hasText: 'ID' }).count() === 0, '提供商列表不再有 ID 列');
await page.screenshot({ path: `${SHOT}/chk-providers-table.png` });

await page.click('#pv-add');
await page.waitForTimeout(500);
check(await page.locator('#pv-id').count() === 0, '添加提供商弹窗没有 ID 输入框');
await page.screenshot({ path: `${SHOT}/chk-provider-add.png` });

const respP = page.waitForResponse((r) => r.url().endsWith('/api/providers') && r.request().method() === 'POST');
await page.fill('#pv-name', '测试厂商');
await page.click('[data-act=save]');
const resp = await respP;
const created = await resp.json();
console.log('    后端生成的 ID：' + created.id);
check(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(created.id), '后端自动生成了合法 ID');
check(created.id === 'p' || /^p-\d+$/.test(created.id), '中文名用 p / p-N 顺延');
await page.waitForTimeout(900);
check(await page.locator('#pv-list', { hasText: '测试厂商' }).count() === 1, '新提供商出现在列表里');
await page.screenshot({ path: `${SHOT}/chk-provider-created.png` });

// 清理：删掉刚建的提供商
const delBtn = page.locator(`#pv-list [data-pdel="${created.id}"]`);
if (await delBtn.count()) {
  await delBtn.click();
  await page.waitForTimeout(400);
  await page.locator('.modal [data-act=ok], .modal [data-act=confirm], .modal .btn--danger').last().click();
  await page.waitForTimeout(800);
}
await page.screenshot({ path: `${SHOT}/chk-provider-cleaned.png` });

await browser.close();
console.log(failed ? `\n失败 ${failed} 项` : '\n全部通过');
process.exit(failed ? 1 : 0);
