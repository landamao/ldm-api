// 看板「最近调用」必须和调用日志页是同一张表：
// 表头一致、徽章都能点复制、悬停不再冒名称气泡、手机右滑能看到来源 IP。
import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:6821';
const shots = 'D:/code/ldm-api/_test/shots';
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.88' },
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

// 气泡引擎和图表提示共用 .chart-tip 类名：图表提示是常驻节点（没弹时不带 is-on），
// 只有 is-on 才是真弹出来的那一枚。
const tipCount = () => page.evaluate(() => document.querySelectorAll('.chart-tip.is-on').length);

let failed = 0;
const check = (ok, msg, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + msg + (detail ? '  -> ' + detail : ''));
  if (!ok) failed++;
};

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', 'test1234');
  await page.click('#login-btn');
  await page.waitForTimeout(1500);
}

const headText = async (sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.trim()));

// ---------- 日志页 ----------
await page.goto(BASE + '/#/logs', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
const logHead = await headText('.logs-card .tbl--logs thead th');
console.log('日志页表头:', logHead.join(' | '));
check(logHead.length === 12 && logHead.includes('来源 IP') && logHead.includes('令牌'), '日志页 12 列含令牌 / 来源 IP');

const logModel = page.locator('.logs-card .tbl--logs tbody tr').first().locator('button.badge--tag').first();
if (await logModel.count()) {
  await logModel.hover();
  await page.waitForTimeout(400);
  check(await tipCount() === 0, '日志页：模型徽章悬停不冒气泡');
  await logModel.click();
  await page.waitForTimeout(400);
  const toast = (await page.locator('.toast').allTextContents()).join(' ');
  check(/已复制/.test(toast), '日志页：点模型徽章能复制', toast.trim());
}

// ---------- 看板 ----------
await page.goto(BASE + '/#/dashboard', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
await page.locator('#recent-logs').scrollIntoViewIfNeeded();
await page.waitForTimeout(300);

const dashHead = await headText('#recent-logs .tbl--logs thead th');
console.log('看板表头:', dashHead.join(' | '));
check(dashHead.join('|') === logHead.join('|'), '看板表头和日志页逐列一致', dashHead.join('|'));

const dashModel = page.locator('#recent-logs .tbl--logs tbody tr').first().locator('button.badge--tag').first();
check(await dashModel.count() === 1, '看板：模型是 button 徽章（可点）');
await dashModel.hover();
await page.waitForTimeout(400);
check(await tipCount() === 0, '看板：模型徽章悬停不冒气泡');
await dashModel.click();
await page.waitForTimeout(400);
const toast2 = (await page.locator('.toast').allTextContents()).join(' ');
check(/已复制/.test(toast2), '看板：点模型徽章能复制', toast2.trim());

// 渠道 / IP 也必须是可复制的 button，不是只读 span
check(await page.locator('#recent-logs .tbl--logs tbody tr').first().locator('td:nth-child(3) button[data-copy]').count() === 1, '看板：渠道徽章可复制');
check(await page.locator('#recent-logs .tbl--logs tbody tr').first().locator('td:nth-child(11) button[data-copy]').count() === 1, '看板：来源 IP 可复制');

// 重试徽章是按钮（点开重试历史），不再是只读 span
const retryBtn = page.locator('#recent-logs .tbl--logs tbody button[data-attempts]');
if (await retryBtn.count()) {
  await retryBtn.first().click();
  await page.waitForTimeout(500);
  check(await page.locator('.modal, .sheet').count() > 0, '看板：重试徽章点开重试历史弹窗');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

const scrollInfo = await page.$eval('#recent-logs .table-wrap', (el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
console.log('看板表格宽度:', JSON.stringify(scrollInfo));
check(scrollInfo.sw > scrollInfo.cw, '看板表格放不下时自己横向滚动（不再藏列）');

// ---------- 手机 ----------
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(600);
await page.goto(BASE + '/#/dashboard', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
const wrap = page.locator('#recent-logs .table-wrap');
await wrap.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
const ipColVisible = await page.evaluate(() => {
  const w = document.querySelector('#recent-logs .table-wrap');
  if (!w) return { ok: false, why: 'no wrap' };
  w.scrollLeft = w.scrollWidth;
  const cells = document.querySelectorAll('#recent-logs .tbl--logs tbody tr td:nth-child(11)');
  if (!cells.length) return { ok: false, why: 'no ip cell' };
  const r = cells[0].getBoundingClientRect();
  const wr = w.getBoundingClientRect();
  return { ok: r.width > 0 && r.right <= wr.right + 1 && r.left >= wr.left - 1, w: w.scrollWidth, c: w.clientWidth, r: r.left, wr: wr.left };
});
console.log('手机右滑后 IP 位置:', JSON.stringify(ipColVisible));
check(ipColVisible.ok, '手机：右滑能看到来源 IP 列');
await wrap.screenshot({ path: shots + '/recent-logs-mobile.png' });

await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(400);
await page.goto(BASE + '/#/dashboard', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
const card = page.locator('.card', { has: page.locator('#recent-logs') }).first();
await card.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await card.screenshot({ path: shots + '/recent-logs-desktop.png' });

if (errors.length) { console.log('JS 错误:'); errors.forEach((e) => console.log('  ' + e)); failed += errors.length; }
await browser.close();
console.log(failed ? `\n共 ${failed} 项不通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
