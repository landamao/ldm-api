// 量一下「高级设置」外框和「文本 / JSON」胶囊的位置，确认没有挤在一起。
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

// 挑一个自定义模型打开
const rows = page.locator('tr[data-rowid]');
const n = await rows.count();
let id = '';
for (let i = 0; i < n; i++) {
  id = await rows.nth(i).getAttribute('data-rowid');
  const badge = await rows.nth(i).locator('.badge').first().innerText();
  if (badge.includes('自定义')) break;
}
await rows.filter({ has: page.locator(`[data-mid="${id}"]`) }).locator('[data-mact=edit]').first().click();
await page.waitForTimeout(700);

// 折叠状态先截图：外框应当仍然可见
const box = page.locator('.modal details.advanced-settings');
const style = await box.evaluate((el) => {
  const cs = getComputedStyle(el);
  return {
    borderTop: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor,
    radius: cs.borderTopLeftRadius,
    padding: cs.padding,
    bg: cs.backgroundColor,
    open: el.open,
  };
});
console.log('高级设置外框:', JSON.stringify(style));
console.log('标题箭头存在:', await box.locator('summary').evaluate((el) => getComputedStyle(el, '::before').borderLeftWidth !== '0px'));
await page.screenshot({ path: `${SHOT}/chk-advanced-collapsed.png` });

// 展开后再量胶囊与开关的位置关系
await page.evaluate(() => document.querySelectorAll('.modal details').forEach((d) => { d.open = true; }));
await page.waitForTimeout(250);

// 确保内容返回开着，胶囊才可见
const prefix = (await page.locator('#cm-content-mode').count()) ? 'cm' : 'm';
const sw = page.locator(`#${prefix}-content-enabled`);
if (!(await page.evaluate((s) => document.querySelector(s).checked, `#${prefix}-content-enabled`))) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el.checked = true;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, `#${prefix}-content-enabled`);
  await page.waitForTimeout(200);
}

const rect = await page.evaluate((p) => {
  const pill = document.querySelector(`#${p}-content-mode`).getBoundingClientRect();
  const label = document.querySelector(`#${p}-content-help`).closest('.field__label').getBoundingClientRect();
  const sw = document.querySelector(`#${p}-content-enabled`).closest('.switch').getBoundingClientRect();
  const head = document.querySelector(`#${p}-content-mode`).closest('.field__head').getBoundingClientRect();
  return {
    head: [Math.round(head.left), Math.round(head.right)],
    labelRight: Math.round(label.right),
    pill: [Math.round(pill.left), Math.round(pill.right)],
    switch: [Math.round(sw.left), Math.round(sw.right)],
  };
}, prefix);
console.log('位置:', JSON.stringify(rect), '胶囊在右侧:', rect.pill[0] > rect.head.left + (rect.head.right - rect.head.left) / 2);

// 强制流式请求那行下面不应再有 hint
const hintCount = await page.evaluate((p) => {
  const help = document.querySelector(`#${p}-forcestream-help`);
  const field = help.closest('.field');
  return field.querySelectorAll('.field__hint').length;
}, prefix);
console.log('强制流式字段的说明文字数量:', hintCount, '(应为 0)');

// 问号弹窗里应带上那句说明
await page.click(`#${prefix}-forcestream-help`);
await page.waitForTimeout(500);
const helpText = await page.locator('.modal').last().innerText();
console.log('问号里有换行说明:', helpText.includes('慢上游不吐字、或吐一半卡住'),
  '包含「快速切下一条路由」:', helpText.includes('快速切下一条路由'));
await page.screenshot({ path: `${SHOT}/chk-forcestream-help.png` });
await browser.close();
console.log('done');
