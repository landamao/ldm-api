// 验证「自定义内容返回」的 文本 / JSON 切换页：切换、格式化、保存与回读。
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6823';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1200);
}

await page.goto(BASE + '/#/models', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

const rows = await page.locator('tr[data-rowid]').count();
console.log('模型行数:', rows);

// 优先挑一个自定义模型
let opened = '';
for (let i = 0; i < rows; i++) {
  opened = await page.locator('tr[data-rowid]').nth(i).getAttribute('data-rowid');
  const badge = await page.locator('tr[data-rowid]').nth(i).locator('.badge').first().innerText();
  if (badge.includes('自定义')) break;
}
console.log('编辑模型:', opened);

await page.locator('tr[data-rowid]').filter({ has: page.locator(`[data-mid="${opened}"]`) })
  .locator('[data-mact=edit]').first().click();
await page.waitForTimeout(700);

const prefix = (await page.locator('#cm-content-json').count()) ? 'cm' : 'm';
console.log('弹窗前缀:', prefix);

const modeSel = `#${prefix}-content-mode`;
const switchSel = `#${prefix}-content-enabled`;
const textPaneSel = `#${prefix}-content-text-pane`;
const jsonPaneSel = `#${prefix}-content-json-pane`;
const jsonSel = `#${prefix}-content-json`;
const textSel = `#${prefix}-content-text`;

if (!(await page.locator(jsonSel).count())) throw new Error('没有找到 JSON 输入框');

// 高级设置默认折叠，先展开
await page.evaluate(() => document.querySelectorAll('.modal details').forEach((d) => { d.open = true; }));
await page.waitForTimeout(200);

// 内容返回没开时先打开（原生 checkbox 被自绘开关盖住，直接派发 change）
if (!(await page.evaluate((s) => document.querySelector(s).checked, switchSel))) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el.checked = true;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, switchSel);
  await page.waitForTimeout(200);
}

const activeMode = () => page.evaluate((sel) => {
  const on = document.querySelector(sel + ' [data-content-mode].is-on');
  return on ? on.dataset.contentMode : '';
}, modeSel);

console.log('初始页:', await activeMode(), '文本页可见:', await page.locator(textPaneSel).isVisible());

// 切到 JSON 页
await page.click(`${modeSel} [data-content-mode=json]`);
await page.waitForTimeout(250);
console.log('切到 JSON 后 → 页:', await activeMode(),
  '文本页可见:', await page.locator(textPaneSel).isVisible(),
  'JSON 页可见:', await page.locator(jsonPaneSel).isVisible(),
  '首字输入禁用:', await page.locator(`#${prefix}-content-first-byte`).isDisabled(),
  '速度输入禁用:', await page.locator(`#${prefix}-content-speed`).isDisabled(),
  '延迟输入禁用:', await page.locator(`#${prefix}-content-latency`).isDisabled());

// 填 JSON + 格式化
await page.fill(jsonSel, '{"created":1700000000,"data":[{"url":"https://example.com/cat.png"}]}');
await page.click(`#${prefix}-content-json-format`);
await page.waitForTimeout(300);
const formatted = await page.locator(jsonSel).inputValue();
console.log('格式化后首行:', formatted.split('\n')[0], '行数:', formatted.split('\n').length);

// 切回文本页再切回来，内容应保留
await page.click(`${modeSel} [data-content-mode=text]`);
await page.waitForTimeout(200);
console.log('切回文本 → 文本页可见:', await page.locator(textPaneSel).isVisible(),
  '首字输入禁用:', await page.locator(`#${prefix}-content-first-byte`).isDisabled());
await page.click(`${modeSel} [data-content-mode=json]`);
await page.waitForTimeout(200);
console.log('再切回 JSON，内容保留:', (await page.locator(jsonSel).inputValue()).length === formatted.length);

await page.screenshot({ path: `${SHOT}/chk-content-json-tab.png` });

// 保存后重新打开：仍停在 JSON 页且内容一致
await page.locator('[data-act=save]').last().click();
await page.waitForTimeout(1300);
console.log('保存后弹窗数:', await page.locator('.modal').count());

const row = page.locator('tr[data-rowid]').filter({ has: page.locator(`[data-mid="${opened}"]`) }).first();
await row.locator('[data-mact=edit]').first().click();
await page.waitForTimeout(700);
await page.evaluate(() => document.querySelectorAll('.modal details').forEach((d) => { d.open = true; }));
await page.waitForTimeout(200);
const saved = await page.locator(jsonSel).inputValue();
console.log('回读页:', await activeMode(), 'JSON 长度:', saved.length, '包含 data:', saved.includes('"data"'));

// 切到文本页保存，应清掉 JSON
await page.click(`${modeSel} [data-content-mode=text]`);
await page.fill(textSel, '好的');
await page.locator('[data-act=save]').last().click();
await page.waitForTimeout(1300);
await row.locator('[data-mact=edit]').first().click();
await page.waitForTimeout(700);
await page.evaluate(() => document.querySelectorAll('.modal details').forEach((d) => { d.open = true; }));
await page.waitForTimeout(200);
console.log('文本页保存后 → 回读页:', await activeMode(),
  'JSON 值:', JSON.stringify(await page.locator(jsonSel).inputValue()),
  '文本值:', JSON.stringify(await page.locator(textSel).inputValue()));

await page.screenshot({ path: `${SHOT}/chk-content-json-text.png` });
await browser.close();
console.log('done');
