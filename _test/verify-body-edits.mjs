// 渠道「请求体修改」：独立编辑弹窗的增删规则、值类型、条件、取消语义、保存落盘与回显
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';

const fails = [];
const check = (ok, label, extra) => {
  console.log(ok ? '  ok  ' : '  FAIL', label, extra === undefined ? '' : JSON.stringify(extra));
  if (!ok) fails.push(label);
};

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.77' },
});
const page = await ctx.newPage();
page.on('pageerror', (e) => { console.log('[page error]', e.message); fails.push('pageerror: ' + e.message); });

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1300);
}

// 自绘下拉接管了原生 select：改 value 后手动派发 change（元素名限定，避开同 class 的触发器）
async function setSelect(locator, value) {
  await locator.evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

const PANE = '.modal--body-edits';

async function openFirstChannel() {
  await page.goto(BASE + '/#/channels', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.locator('button[data-act=edit]').first().click();
  await page.waitForTimeout(450);
  const details = page.locator('.modal .advanced-settings');
  if (await details.count()) {
    await details.evaluate((el) => { el.open = true; });
    await page.waitForTimeout(200);
  }
}

async function openRulesWindow() {
  await page.click('#f-body-edits-edit');
  await page.waitForSelector(PANE, { timeout: 4000 });
  await page.waitForTimeout(250);
}

async function clearRules() {
  let n = await page.locator(`${PANE} .body-edit`).count();
  while (n > 0) {
    await page.locator(`${PANE} .body-edit .body-edit__del`).first().click();
    n -= 1;
  }
}

// ---- 1) 渠道弹窗里只剩摘要和入口 ----
await openFirstChannel();
check(await page.locator('#f-body-edits-summary').count() === 1, '高级设置里有规则摘要');
check(await page.locator('#f-body-edits-edit').count() === 1, '有「编辑规则」按钮');
check(await page.locator('#f-body-edits').count() === 0, '渠道弹窗里不再内嵌规则编辑器');
check(await page.locator('.body-edit').count() === 0, '规则卡片不在渠道弹窗里');
const helpTip = await page.locator('#f-body-edit-help').getAttribute('data-tip');
check(!!helpTip && helpTip.length > 20, '问号带帮助气泡');

// 先清空历史规则（幂等）
await openRulesWindow();
await clearRules();
await page.click(`${PANE} [data-act=save]`);
await page.waitForTimeout(400);
check(await page.locator(PANE).count() === 0, '保存规则后独立弹窗关闭');
check((await page.locator('#f-body-edits-summary').innerText()).includes('还没有规则'), '摘要显示空状态');

// ---- 2) 独立弹窗：叠层 + Esc 只关最上层 ----
await openRulesWindow();
check(await page.locator('.modal').count() === 2, '规则弹窗叠在渠道弹窗上面');
check((await page.locator(`${PANE} .modal__title`).innerText()).trim() === '请求体修改', '弹窗标题');
check((await page.locator(`${PANE} .body-edits-toolbar`).innerText()).includes('修改规则'), '有规则工具栏');

await page.click('#be-add');
await page.locator(`${PANE} .body-edit__path`).first().fill('temp_probe');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
check(await page.locator(PANE).count() === 0, 'Esc 关掉规则弹窗');
check(await page.locator('.modal').count() === 1, '渠道弹窗还开着');
check((await page.locator('#f-body-edits-summary').innerText()).includes('还没有规则'), '取消后草稿不落地');

// ---- 3) 正式编辑：设置字段（数字 + 条件） ----
await openRulesWindow();
await page.click('#be-add');
await page.waitForTimeout(200);
const card1 = page.locator(`${PANE} .body-edit`).first();
await card1.locator('.body-edit__path').fill('max_tokens');
await setSelect(card1.locator('select.body-edit__type'), 'number');
await card1.locator('.body-edit__value-input').fill('4096');
check(await card1.locator('.body-edit__keep input').isChecked() === false, '默认覆盖客户端已有字段');

// 自绘下拉的箭头要垂直居中、文字不能截断
const modeBox = await page.evaluate(() => {
  const t = document.querySelector('.modal--body-edits .body-edit__mode.ldm-select');
  if (!t) return null;
  const c = t.querySelector('.ldm-select__chev');
  const v = t.querySelector('.ldm-select__value');
  const a = t.getBoundingClientRect();
  const b = c ? c.getBoundingClientRect() : null;
  return {
    centerDiff: b ? +Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2).toFixed(2) : null,
    textOverflow: v ? v.scrollWidth - v.clientWidth : null,
    text: v ? v.textContent : '',
  };
});
console.log('  mode:', JSON.stringify(modeBox));
check(modeBox && modeBox.centerDiff !== null && modeBox.centerDiff <= 0.5, '下拉箭头垂直居中', modeBox);
check(modeBox && modeBox.textOverflow !== null && modeBox.textOverflow <= 1, '「设置字段」文字未被截断', modeBox);

// 「类型 + 值」和覆盖开关之间要留出间距：这层曾经没设 flex，开关直接贴在输入框下沿。
const setGap = await page.evaluate(() => {
  const card = document.querySelector('.modal--body-edits .body-edit');
  const row = card.querySelector('.body-edit__row');
  const keep = card.querySelector('.body-edit__keep');
  const a = row.getBoundingClientRect();
  const b = keep.getBoundingClientRect();
  return +(b.top - a.bottom).toFixed(1);
});
check(setGap >= 8, '值区与覆盖开关之间有间距', setGap);

await card1.locator('.body-edit__cond-toggle').click();
await page.waitForTimeout(150);
await card1.locator('.body-edit__cond-add').click();
await page.waitForTimeout(120);
const cond1 = card1.locator('.body-cond').first();
await cond1.locator('.body-cond__path').fill('model');
await cond1.locator('.body-cond__value-input').fill('gpt-4');
await cond1.locator('.body-cond__miss').check();
check(await cond1.locator('select.body-cond__mode').inputValue() === 'full', '条件默认「等于」');
check(await cond1.locator('select.body-cond__type').inputValue() === 'string', '比对值默认「字符串」');

// 条件按钮和展开后的条件区之间要留间距（曾经因为容器没设 flex 贴在一起）
const condGap = await page.evaluate(() => {
  const card = document.querySelector('.modal--body-edits .body-edit');
  const t = card.querySelector('.body-edit__cond-toggle');
  const b = card.querySelector('.body-edit__cond-body');
  if (!t || !b) return null;
  return +(b.getBoundingClientRect().top - t.getBoundingClientRect().bottom).toFixed(1);
});
check(condGap !== null && condGap >= 6, '条件按钮与条件区之间有间距', condGap);

// 第二条条件：数字类型（字符串 5 和数字 5 在比较时是两回事，必须能选）
await card1.locator('.body-edit__cond-add').click();
await page.waitForTimeout(120);
const cond2 = card1.locator('.body-cond').nth(1);
await cond2.locator('.body-cond__path').fill('temperature');
await setSelect(cond2.locator('select.body-cond__mode'), 'gte');
await setSelect(cond2.locator('select.body-cond__type'), 'number');
await cond2.locator('.body-cond__value-input').fill('0.9');
check((await card1.locator('.body-edit__cond-toggle').innerText()).includes('条件（2）'), '条件按钮显示条数');

// 条件行两个下拉的文字不能被截断（「大于等于」「字符串」都是最长的选项）
const condTrunc = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('.modal--body-edits .body-cond').forEach((row, i) => {
    ['mode', 'type'].forEach((k) => {
      const t = row.querySelector(`.body-cond__${k}.ldm-select`);
      const v = t && t.querySelector('.ldm-select__value');
      if (v) out.push({ row: i + 1, k, over: v.scrollWidth - v.clientWidth, text: v.textContent });
    });
  });
  return out;
});
console.log('  cond selects:', JSON.stringify(condTrunc));
check(condTrunc.length > 0 && condTrunc.every((x) => x.over <= 1), '条件下拉文字未被截断', condTrunc);

// 切换类型时保留已输入的文本
await setSelect(cond2.locator('select.body-cond__type'), 'string');
await page.waitForTimeout(120);
check(await cond2.locator('.body-cond__value-input').inputValue() === '0.9', '条件值类型切换保留文本');
await setSelect(cond2.locator('select.body-cond__type'), 'number');
await page.waitForTimeout(120);

// ---- 4) 再加一条「删除字段」 ----
await page.click('#be-add');
await page.waitForTimeout(150);
const card2 = page.locator(`${PANE} .body-edit`).nth(1);
await setSelect(card2.locator('select.body-edit__mode'), 'delete');
check(await card2.locator('.body-edit__set').isHidden(), '删除模式隐藏值和覆盖开关');
await card2.locator('.body-edit__path').fill('logprobs');
check((await page.locator(`${PANE} .body-edits-toolbar`).innerText()).includes('共 2 条'), '工具栏显示规则条数');

await page.screenshot({ path: `${SHOT}/body-edits-window-1440.png`, fullPage: false });

// ---- 5) 保存规则 → 摘要 ----
await page.click(`${PANE} [data-act=save]`);
await page.waitForTimeout(400);
const summary = (await page.locator('#f-body-edits-summary').innerText()).replace(/\s+/g, ' ').trim();
console.log('  summary:', summary);
check(summary.includes('共 2 条'), '摘要显示规则条数', summary);
check(/设置 max_tokens/.test(summary) && /删除 logprobs/.test(summary), '摘要列出规则内容', summary);

// ---- 6) 保存渠道并核对落盘 ----
await page.click('.modal [data-act=save]');
await page.waitForTimeout(1200);
const saved = await page.evaluate(async () => {
  const res = await fetch('/api/channels');
  return res.ok ? res.json() : { error: res.status };
});
const chans = Array.isArray(saved) ? saved : [];
const target = chans.find((c) => Array.isArray(c.body_edits) && c.body_edits.length === 2);
check(!!target, '渠道保存了 2 条请求体修改规则');
if (target) {
  const [a, b] = target.body_edits;
  check(a.mode === 'set' && a.path === 'max_tokens' && a.value_type === 'number' && a.value === 4096,
    '第 1 条规则字段正确', a);
  check(a.keep_origin !== true, '未勾选时不保存 keep_origin');
  check(a.conditions && a.conditions.length === 2 && a.conditions[0].pass_missing_key === true,
    '条件随规则保存', a.conditions);
  check(a.conditions[0].value_type === 'string' && a.conditions[0].value === 'gpt-4',
    '字符串条件的类型与值正确', a.conditions[0]);
  check(a.conditions[1].value_type === 'number' && a.conditions[1].value === 0.9
    && a.conditions[1].mode === 'gte', '数字条件的类型与值正确', a.conditions[1]);
  check(a.logic === 'or', '条件关系默认 or');
  check(b.mode === 'delete' && b.path === 'logprobs', '第 2 条规则是删除字段', b);
}

// ---- 7) 重新打开：摘要 + 规则回显 ----
await openFirstChannel();
check((await page.locator('#f-body-edits-summary').innerText()).includes('共 2 条'), '重开后摘要仍有 2 条');
await openRulesWindow();
check(await page.locator(`${PANE} .body-edit`).count() === 2, '重新打开回显 2 条规则');
const r1 = page.locator(`${PANE} .body-edit`).first();
check(await r1.locator('.body-edit__path').inputValue() === 'max_tokens', '路径回显');
check(await r1.locator('select.body-edit__type').inputValue() === 'number', '值类型回显');
check(await r1.locator('.body-edit__value-input').inputValue() === '4096', '值回显');
check(await r1.locator('.body-cond').count() === 2, '条件回显');
check(await r1.locator('.body-cond').first().locator('.body-cond__miss').isChecked(), '「字段不存在也算满足」回显');
check(await r1.locator('select.body-cond__type').nth(0).inputValue() === 'string', '字符串条件类型回显');
check(await r1.locator('select.body-cond__type').nth(1).inputValue() === 'number', '数字条件类型回显');
check(await r1.locator('.body-cond').nth(1).locator('.body-cond__value-input').inputValue() === '0.9',
  '数字条件值回显');
const r2 = page.locator(`${PANE} .body-edit`).nth(1);
check(await r2.locator('select.body-edit__mode').inputValue() === 'delete', '删除模式回显');
check(await r2.locator('.body-edit__set').isHidden(), '删除模式重新打开也不显示值区');

// ---- 8) 值类型互转不丢内容 ----
await setSelect(r1.locator('select.body-edit__type'), 'json');
await page.waitForTimeout(100);
check(await r1.locator('.body-edit__value-input').inputValue() === '4096', '切到 JSON 时保留原文本');
await setSelect(r1.locator('select.body-edit__type'), 'string');
await page.waitForTimeout(100);
check(await r1.locator('.body-edit__value-input').inputValue() === '4096', '切回字符串仍保留文本');
await setSelect(r1.locator('select.body-edit__type'), 'number');

// ---- 9) 值填错时拦在规则弹窗里 ----
await r1.locator('.body-edit__value-input').fill('abc');
await page.click(`${PANE} [data-act=save]`);
await page.waitForTimeout(500);
check(await page.locator(PANE).count() === 1, '值不是数字时规则弹窗不关闭');
const toastText = await page.locator('.toast').first().innerText().catch(() => '');
check(/不是数字/.test(toastText), '提示「不是数字」', toastText.replace(/\s+/g, ' ').trim());
await r1.locator('.body-edit__value-input').fill('2048');

// ---- 10) 手机视口：独立弹窗里不横向溢出 ----
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
const overflow = await page.evaluate(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return { sw: el.scrollWidth, cw: el.clientWidth };
  };
  return {
    card: pick('.modal--body-edits .body-edit'),
    cond: pick('.modal--body-edits .body-cond'),
    body: pick('.modal--body-edits .modal__body'),
    toolbar: pick('.modal--body-edits .body-edits-toolbar'),
  };
});
console.log('  phone:', JSON.stringify(overflow));
check(overflow.card && overflow.card.sw <= overflow.card.cw + 1, '手机端规则卡片不横向溢出', overflow.card);
check(overflow.cond && overflow.cond.sw <= overflow.cond.cw + 1, '手机端条件行不横向溢出', overflow.cond);
check(overflow.toolbar && overflow.toolbar.sw <= overflow.toolbar.cw + 1, '手机端工具栏不横向溢出', overflow.toolbar);
await page.waitForTimeout(2400); // 等提示条消失，别挡截图
await page.screenshot({ path: `${SHOT}/body-edits-window-390.png`, fullPage: false });

// ---- 11) 清理：清空规则并保存渠道 ----
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(300);
await page.click(`${PANE} [data-act=cancel]`);
await page.waitForTimeout(300);
await openRulesWindow();
await clearRules();
await page.click(`${PANE} [data-act=save]`);
await page.waitForTimeout(400);
check((await page.locator('#f-body-edits-summary').innerText()).includes('还没有规则'), '清空后摘要回到空状态');
await page.click('.modal [data-act=save]');
await page.waitForTimeout(1200);
const after = await page.evaluate(async () => {
  const res = await fetch('/api/channels');
  return res.ok ? res.json() : [];
});
const cleaned = (Array.isArray(after) ? after : []).every((c) => !c.body_edits || c.body_edits.length === 0);
check(cleaned, '清空后不再保存任何规则');

await browser.close();

if (fails.length) {
  console.log('\n失败项：');
  fails.forEach((f) => console.log(' - ' + f));
  process.exit(1);
}
console.log('\n全部通过');
