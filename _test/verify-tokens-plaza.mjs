// 验证三项改动：广场顶栏不折行 / 提供商胶囊无阴影 / 令牌多选
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1300);
}

// ---- 1) 模型广场：顶栏应单行 ----
for (const w of [1440, 1280, 1024]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.goto(BASE + '/#/plaza', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);
  const r = await page.evaluate(() => {
    const tb = document.querySelector('.topbar').getBoundingClientRect();
    const f = document.getElementById('topbar-filters');
    const fr = f.getBoundingClientRect();
    const chip = document.querySelector('.provider-chip.is-on');
    const shadow = chip ? getComputedStyle(chip).boxShadow : 'n/a';
    return { topbarH: +tb.height.toFixed(1), filtersH: +fr.height.toFixed(1), onShadow: shadow };
  });
  console.log(`plaza@${w}:`, JSON.stringify(r));
  if (w === 1440) await page.screenshot({ path: `${SHOT}/v2-plaza-1440.png` });
  if (w === 1280) await page.screenshot({ path: `${SHOT}/v2-plaza-1280.png` });
}

// ---- 2) 切到其它页再切回来，确认 nowrap 不泄漏、渠道页仍正常 ----
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(BASE + '/#/channels', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1400);
const ch = await page.evaluate(() => {
  const f = document.getElementById('topbar-filters');
  return { wrap: getComputedStyle(f).flexWrap, inline: f.getAttribute('style') };
});
console.log('channels filters:', JSON.stringify(ch));
await page.screenshot({ path: `${SHOT}/v2-channels.png` });

// ---- 3) 令牌管理：多选 ----
await page.goto(BASE + '/#/tokens', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1400);
const tokenCount = await page.evaluate(() => document.querySelectorAll('#token-list tbody tr').length);
console.log('token rows:', tokenCount);
await page.screenshot({ path: `${SHOT}/v2-tokens-normal.png` });

if (tokenCount > 0) {
  // 进入多选
  await page.click('#tk-multi');
  await page.waitForTimeout(400);
  let st = await page.evaluate(() => ({
    boxes: document.querySelectorAll('input[data-tksel]').length,
    multiCount: document.querySelector('#token-multi-count')?.textContent,
    rowsSelectable: document.querySelectorAll('#token-list tbody tr.is-selectable').length,
    opsCol: !!document.querySelector('#token-list thead th:last-child') && document.querySelector('#token-list thead th:last-child').textContent.trim(),
  }));
  console.log('after tk-multi:', JSON.stringify(st));
  await page.screenshot({ path: `${SHOT}/v2-tokens-multi.png` });

  // 点第一、二行（点名称单元格）
  const rows = page.locator('#token-list tbody tr');
  await rows.nth(0).locator('td').nth(1).click();
  await page.waitForTimeout(200);
  if (tokenCount > 1) await rows.nth(1).locator('td').nth(1).click();
  await page.waitForTimeout(200);
  st = await page.evaluate(() => ({
    multiCount: document.querySelector('#token-multi-count')?.textContent,
    selectedRows: document.querySelectorAll('#token-list tbody tr.is-selected').length,
    checkallIndeterminate: document.querySelector('#tk-checkall')?.indeterminate,
  }));
  console.log('after row clicks:', JSON.stringify(st));

  // 全选
  await page.click('#tk-checkall');
  await page.waitForTimeout(200);
  st = await page.evaluate(() => ({
    multiCount: document.querySelector('#token-multi-count')?.textContent,
    selectedRows: document.querySelectorAll('#token-list tbody tr.is-selected').length,
    checkallChecked: document.querySelector('#tk-checkall')?.checked,
  }));
  console.log('after checkall:', JSON.stringify(st));
  await page.screenshot({ path: `${SHOT}/v2-tokens-selected-all.png` });

  // 取消全选 → 退出多选
  await page.click('#tk-checkall');
  await page.waitForTimeout(150);
  await page.click('#tk-exit');
  await page.waitForTimeout(400);
  st = await page.evaluate(() => ({
    multiBtnVisible: getComputedStyle(document.querySelector('#tk-multi') || document.body).display !== 'none',
    selectedRows: document.querySelectorAll('#token-list tbody tr.is-selected').length,
    opsColBack: [...document.querySelectorAll('#token-list thead th')].map((th) => th.textContent.trim()).join('|'),
  }));
  console.log('after exit:', JSON.stringify(st));
  await page.screenshot({ path: `${SHOT}/v2-tokens-exit.png` });
}

await browser.close();
console.log('done');
