// 列表页顶栏筛选 + 底部状态栏的交互验证
// 前置：起网关 LDMAPI_PASSWORD=test1234 -port 6821（LDMAPI_DEV=web）
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1400);
}

const setSelect = (sel, val) => page.evaluate(([s, v]) => {
  const el = document.querySelector(s);
  el.value = v;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, [sel, val]);

const text = (sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return el ? el.textContent.trim() : null;
}, sel);

const visible = (sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  const st = getComputedStyle(el);
  return st.display !== 'none' && st.visibility !== 'hidden' && el.getClientRects().length > 0;
}, sel);

// ---------- 模型管理 ----------
await page.goto(BASE + '/#/models', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
console.log('[models] 初始', await text('#filter-count'),
  '| 筛选在顶栏=', await page.evaluate(() => !!document.querySelector('#topbar-filters #f-type')),
  '| 搜索在卡片=', await page.evaluate(() => !!document.querySelector('.models-card .toolbar #model-search')),
  '| 多选在卡片=', await page.evaluate(() => !!document.querySelector('.models-card .toolbar #btn-multi')),
  '| 顶栏可见=', await visible('#topbar-filters'));
await setSelect('#f-type', 'custom');
await page.waitForTimeout(500);
console.log('[models] 切自定义后', await text('#filter-count'));
await page.click('#btn-multi');
await page.waitForTimeout(400);
console.log('[models] 多选态', '已选=', await text('#multi-count'),
  '| 启用按钮=', await visible('#m-enable'), '| 多选按钮=', await visible('#btn-multi'));
// 勾两行
await page.evaluate(() => {
  document.querySelectorAll('input[data-msel]').forEach((cb, i) => {
    if (i < 2) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
  });
});
await page.waitForTimeout(300);
console.log('[models] 勾选两行后 已选=', await text('#multi-count'));
await page.screenshot({ path: 'D:/code/ldm-api/_test/shots/p-models-multi.png' });
await page.click('#m-exit');
await page.waitForTimeout(500);
console.log('[models] 退出多选 已选可见=', await visible('#multi-count'), '| 多选按钮=', await visible('#btn-multi'));

// ---------- 渠道管理 ----------
await page.goto(BASE + '/#/channels', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
console.log('[channels] 初始', await text('#channel-filter-count'),
  '| 筛选行在顶栏=', await page.evaluate(() => !!document.querySelector('#topbar-filters #ch-filter-type')));
await setSelect('#ch-filter-status', 'disabled');
await page.waitForTimeout(400);
console.log('[channels] 只看已禁用', await text('#channel-filter-count'));
await page.click('#ch-multi');
await page.waitForTimeout(400);
console.log('[channels] 多选态', '已选=', await text('#channel-multi-count'), '| 删除按钮=', await visible('#ch-del'));
await page.screenshot({ path: 'D:/code/ldm-api/_test/shots/p-channels-multi.png' });
await page.click('#ch-exit');
await page.waitForTimeout(300);

// ---------- 模型广场 ----------
await page.goto(BASE + '/#/plaza', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
console.log('[plaza] 初始', await text('#plaza-count'),
  '| 搜索/筛选在顶栏=', await page.evaluate(() => !!document.querySelector('#topbar-filters #plaza-search') && !!document.querySelector('#topbar-filters #plaza-filter')),
  '| 提供商在卡片=', await page.evaluate(() => !!document.querySelector('.card #plaza-providers') && !document.querySelector('#topbar-filters #plaza-providers')));
await page.evaluate(() => {
  const b = document.querySelectorAll('#plaza-providers .provider-chip')[1];
  if (b) b.click();
});
await page.waitForTimeout(400);
console.log('[plaza] 选提供商后', await text('#plaza-count'));
await page.fill('#plaza-search', 'chat');
await page.waitForTimeout(500);
console.log('[plaza] 搜索 chat', await text('#plaza-count'));

// ---------- 调用日志 ----------
await page.goto(BASE + '/#/logs', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
await setSelect('#f-preset', 'all');
await page.click('#btn-query');
await page.waitForTimeout(1500);
console.log('[logs] 全部时间', await text('#log-total'), '| 下一页可点=', !(await page.evaluate(() => document.querySelector('#page-next').disabled)));
await page.click('#page-next');
await page.waitForTimeout(1200);
console.log('[logs] 翻页后', await text('#log-total'), '| 上一页可点=', !(await page.evaluate(() => document.querySelector('#page-prev').disabled)));
const geo = await page.evaluate(() => {
  const card = document.querySelector('.logs-card').getBoundingClientRect();
  const foot = document.querySelector('.logs-card .table-foot').getBoundingClientRect();
  const wrap = document.querySelector('.logs-card #log-table > .table-wrap');
  const pet = document.querySelector('.dsh-pet-root');
  const pr = pet ? pet.getBoundingClientRect() : null;
  const prev = document.querySelector('#page-prev').getBoundingClientRect();
  return {
    cardBottom: Math.round(card.bottom),
    footBottom: Math.round(foot.bottom),
    tableScrollH: wrap ? wrap.scrollHeight : 0,
    tableClientH: wrap ? wrap.clientHeight : 0,
    prevBtn: Math.round(prev.left),
    petLeft: pr ? Math.round(pr.left) : null,
    prevUnderPet: pr ? prev.right > pr.left && prev.bottom > pr.top : false,
  };
});
console.log('[logs] 几何', JSON.stringify(geo));

console.log('[pageerror]', errs.length ? errs.join(' | ') : 'none');
await browser.close();
