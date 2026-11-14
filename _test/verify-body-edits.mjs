// 渠道「请求体修改」：独立弹窗、四种操作（设置 / 修改 / 移动 / 删除）、条件、JSON 视图、保存回显
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
const cardAt = (n) => page.locator(`${PANE} .body-edit`).nth(n);

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
check(await page.locator('#be-mode').count() === 1, '有可视化 / JSON 切换');

await page.click('#be-add');
await cardAt(0).locator('.body-edit__path').fill('temp_probe');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
check(await page.locator(PANE).count() === 0, 'Esc 关掉规则弹窗');
check(await page.locator('.modal').count() === 1, '渠道弹窗还开着');
check((await page.locator('#f-body-edits-summary').innerText()).includes('还没有规则'), '取消后草稿不落地');

// ---- 3) 规则 1：设置字段（数字 + 两条条件） ----
await openRulesWindow();
await page.click('#be-add');
await page.waitForTimeout(200);
const r1 = cardAt(0);
await r1.locator('.body-edit__path').fill('max_tokens');
await setSelect(r1.locator('select.body-edit__type'), 'number');
await r1.locator('.body-edit__value-input').fill('4096');
check(await r1.locator('.body-edit__keep input').isChecked() === false, '默认覆盖客户端已有字段');

// 下拉箭头居中、文案不截断
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

// 「类型 + 值」和覆盖开关之间要留出间距
const setGap = await page.evaluate(() => {
  const card = document.querySelector('.modal--body-edits .body-edit');
  const row = card.querySelector('.body-edit__row');
  const keep = card.querySelector('.body-edit__keep');
  return +(keep.getBoundingClientRect().top - row.getBoundingClientRect().bottom).toFixed(1);
});
check(setGap >= 8, '值区与覆盖开关之间有间距', setGap);

await r1.locator('.body-edit__cond-toggle').click();
await page.waitForTimeout(150);
await r1.locator('.body-edit__cond-add').click();
await page.waitForTimeout(120);
const cond1 = r1.locator('.body-cond').first();
await cond1.locator('.body-cond__path').fill('model');
await cond1.locator('.body-cond__value-input').fill('gpt-4');
await cond1.locator('.body-cond__miss').check();
check(await cond1.locator('select.body-cond__mode').inputValue() === 'full', '条件默认「等于」');
check(await cond1.locator('select.body-cond__type').inputValue() === 'string', '比对值默认「字符串」');

// 条件按钮和展开后的条件区之间要留间距
const condGap = await page.evaluate(() => {
  const card = document.querySelector('.modal--body-edits .body-edit');
  const t = card.querySelector('.body-edit__cond-toggle');
  const b = card.querySelector('.body-edit__cond-body');
  return +(b.getBoundingClientRect().top - t.getBoundingClientRect().bottom).toFixed(1);
});
check(condGap >= 6, '条件按钮与条件区之间有间距', condGap);

// 第二条条件：数字类型
await r1.locator('.body-edit__cond-add').click();
await page.waitForTimeout(120);
const cond2 = r1.locator('.body-cond').nth(1);
await cond2.locator('.body-cond__path').fill('temperature');
await setSelect(cond2.locator('select.body-cond__mode'), 'gte');
await setSelect(cond2.locator('select.body-cond__type'), 'number');
await cond2.locator('.body-cond__value-input').fill('0.9');
check((await r1.locator('.body-edit__cond-toggle').innerText()).includes('条件（2）'), '条件按钮显示条数');

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
check(condTrunc.length > 0 && condTrunc.every((x) => x.over <= 1), '条件下拉文字未被截断', condTrunc);

// ---- 4) 规则 2：修改字段（只有客户端传了才改） ----
await page.click('#be-add');
await page.waitForTimeout(200);
const r2 = cardAt(1);
await setSelect(r2.locator('select.body-edit__mode'), 'patch');
check(await r2.locator('.body-edit__set').isVisible(), '修改字段仍显示值和值类型');
check(await r2.locator('.body-edit__keep').isHidden(), '修改字段不显示「已有同名字段不覆盖」');
await r2.locator('.body-edit__path').fill('temperature');
await setSelect(r2.locator('select.body-edit__type'), 'number');
await r2.locator('.body-edit__value-input').fill('0.2');

// ---- 5) 规则 3：移动字段（reasoning_effort → chat_template_kwargs.reasoning_effort） ----
await page.click('#be-add');
await page.waitForTimeout(200);
const r3 = cardAt(2);
await setSelect(r3.locator('select.body-edit__mode'), 'move');
check(await r3.locator('.body-edit__set').isHidden(), '移动模式隐藏值和值类型');
check(await r3.locator('.body-edit__move').isVisible(), '移动模式显示目标路径');
check((await r3.locator('.body-edit__keep .switch__label').innerText()).trim() === '目标已有值不覆盖',
  '移动模式的开关文案');
await r3.locator('.body-edit__path').fill('reasoning_effort');
await r3.locator('.body-edit__target').fill('chat_template_kwargs.reasoning_effort');

// ---- 5.5) 规则 4：删除字段 ----
await page.click('#be-add');
await page.waitForTimeout(200);
const r4 = cardAt(3);
await setSelect(r4.locator('select.body-edit__mode'), 'delete');
check(await r4.locator('.body-edit__set').isHidden(), '删除模式隐藏值和覆盖开关');
check(await r4.locator('.body-edit__move').isHidden(), '删除模式不显示目标路径');
await r4.locator('.body-edit__path').fill('logprobs');
check((await page.locator(`${PANE} .body-edits-toolbar`).innerText()).includes('共 4 条'), '工具栏显示规则条数');

await page.screenshot({ path: `${SHOT}/body-edits-window-1440.png`, fullPage: false });

// ---- 6) 保存规则 → 摘要列出四种操作（超过 3 条折成 +N） ----
await page.click(`${PANE} [data-act=save]`);
await page.waitForTimeout(400);
const summary = (await page.locator('#f-body-edits-summary').innerText()).replace(/\s+/g, ' ').trim();
console.log('  summary:', summary);
check(summary.includes('共 4 条'), '摘要显示规则条数', summary);
check(/设置 max_tokens/.test(summary) && /修改 temperature/.test(summary)
  && /移动 reasoning_effort → chat_template_kwargs\.reasoning_effort/.test(summary),
  '摘要分别标注设置 / 修改 / 移动', summary);
check(/\+1/.test(summary), '第 4 条规则折成 +1', summary);

// ---- 7) 保存渠道并核对落盘 ----
await page.click('.modal [data-act=save]');
await page.waitForTimeout(1200);
const saved = await page.evaluate(async () => {
  const res = await fetch('/api/channels');
  return res.ok ? res.json() : { error: res.status };
});
const chans = Array.isArray(saved) ? saved : [];
const target = chans.find((c) => Array.isArray(c.body_edits) && c.body_edits.length === 4);
check(!!target, '渠道保存了 4 条请求体修改规则');
if (target) {
  const [a, b, c, d] = target.body_edits;
  check(a.mode === 'set' && a.path === 'max_tokens' && a.value_type === 'number' && a.value === 4096,
    '规则 1 是设置字段', a);
  check(a.conditions && a.conditions.length === 2 && a.conditions[0].pass_missing_key === true,
    '条件随规则保存', a.conditions);
  check(a.conditions[0].value_type === 'string' && a.conditions[0].value === 'gpt-4',
    '字符串条件的类型与值正确', a.conditions[0]);
  check(a.conditions[1].value_type === 'number' && a.conditions[1].value === 0.9 && a.conditions[1].mode === 'gte',
    '数字条件的类型与值正确', a.conditions[1]);
  check(a.logic === 'or', '条件关系默认 or');
  check(b.mode === 'patch' && b.path === 'temperature' && b.value_type === 'number' && b.value === 0.2,
    '规则 2 是修改字段', b);
  check(b.keep_origin !== true, '修改字段不保存 keep_origin');
  check(c.mode === 'move' && c.path === 'reasoning_effort'
    && c.target === 'chat_template_kwargs.reasoning_effort', '规则 3 是移动字段', c);
  check(c.value === undefined && c.value_type === undefined, '移动规则不保存值和值类型', c);
  check(c.keep_origin !== true, '移动规则默认覆盖目标已有值', c);
  check(d.mode === 'delete' && d.path === 'logprobs', '规则 4 是删除字段', d);
}

// ---- 8) 重新打开：摘要 + 四种规则回显 ----
await openFirstChannel();
check((await page.locator('#f-body-edits-summary').innerText()).includes('共 4 条'), '重开后摘要仍有 4 条');
await openRulesWindow();
check(await page.locator(`${PANE} .body-edit`).count() === 4, '重新打开回显 4 条规则');
check(await cardAt(0).locator('.body-edit__path').inputValue() === 'max_tokens', '规则 1 路径回显');
check(await cardAt(0).locator('select.body-edit__type').inputValue() === 'number', '规则 1 值类型回显');
check(await cardAt(0).locator('.body-edit__value-input').inputValue() === '4096', '规则 1 值回显');
check(await cardAt(0).locator('.body-cond').count() === 2, '规则 1 条件回显');
check(await cardAt(1).locator('select.body-edit__mode').inputValue() === 'patch', '规则 2 修改模式回显');
check(await cardAt(1).locator('.body-edit__keep').isHidden(), '修改字段重新打开也不显示覆盖开关');
check(await cardAt(1).locator('select.body-edit__type').inputValue() === 'number', '规则 2 值类型回显');
check(await cardAt(2).locator('select.body-edit__mode').inputValue() === 'move', '规则 3 移动模式回显');
check(await cardAt(2).locator('.body-edit__target').inputValue() === 'chat_template_kwargs.reasoning_effort',
  '规则 3 目标路径回显');
check(await cardAt(2).locator('.body-edit__move').isVisible(), '移动模式重新打开仍显示目标路径');
check(await cardAt(2).locator('.body-edit__keep').isVisible(), '移动模式显示「目标已有值不覆盖」');
check(await cardAt(3).locator('select.body-edit__mode').inputValue() === 'delete', '规则 4 删除模式回显');
check(await cardAt(3).locator('.body-edit__set').isHidden(), '删除模式不显示值区');

// ---- 9) JSON 视图：结构完整、往返不丢、坏 JSON 拦下来 ----
await page.click('#be-mode [data-be-mode=json]');
await page.waitForTimeout(300);
const jsonText = await page.locator('#be-json').inputValue();
console.log('  json head:', jsonText.slice(0, 60).replace(/\s+/g, ' '));
check(/"mode": "patch"/.test(jsonText), 'JSON 里能看到修改字段', jsonText.length);
check(/"mode": "move"/.test(jsonText) && /"target": "chat_template_kwargs\.reasoning_effort"/.test(jsonText),
  'JSON 里能看到移动的目标路径');
check(/"conditions"/.test(jsonText) && /"value_type": "number"/.test(jsonText), 'JSON 里带条件与值类型');
check(await page.locator(`${PANE} .body-edit`).count() === 0 || await page.locator('#be-json').isVisible(), 'JSON 模式下展示文本框');

// 清空数组 = 规则清空，切回可视化应看到空状态
await page.fill('#be-json', '[]');
await page.click('#be-mode [data-be-mode=visual]');
await page.waitForTimeout(350);
check(await page.locator(`${PANE} .body-edit`).count() === 0, 'JSON 清空后可视化也清空');
check(await page.locator(`${PANE} .body-edits__empty`).count() === 1, '空状态提示回来');

// 把原来的 JSON 粘回去，四条规则恢复
await page.click('#be-mode [data-be-mode=json]');
await page.fill('#be-json', jsonText);
await page.click('#be-mode [data-be-mode=visual]');
await page.waitForTimeout(350);
check(await page.locator(`${PANE} .body-edit`).count() === 4, 'JSON 粘回后规则恢复');
check(await cardAt(1).locator('select.body-edit__mode').inputValue() === 'patch', '粘回后修改字段仍是 patch');
check(await cardAt(2).locator('select.body-edit__mode').inputValue() === 'move', '粘回后移动字段仍是 move');
check(await cardAt(2).locator('.body-edit__target').inputValue() === 'chat_template_kwargs.reasoning_effort',
  '粘回后目标路径不丢');

// 坏 JSON 停在 JSON 模式并提示
await page.click('#be-mode [data-be-mode=json]');
await page.fill('#be-json', '[{bad}]');
await page.click('#be-mode [data-be-mode=visual]');
await page.waitForTimeout(450);
check(await page.locator('#be-json').isVisible(), '坏 JSON 不会切回可视化');
const jsonToast = await page.locator('.toast').first().innerText().catch(() => '');
check(/JSON/.test(jsonToast), '提示 JSON 格式有误', jsonToast.replace(/\s+/g, ' ').trim());
await page.fill('#be-json', jsonText);
await page.click('#be-mode [data-be-mode=visual]');
await page.waitForTimeout(450);
check(await page.locator(`${PANE} .body-edit`).count() === 4, '修正后能切回可视化');

// ---- 10) 值类型互转 + JSON 值的扩大编辑浮在最上面 ----
const s1 = cardAt(0);
await setSelect(s1.locator('select.body-edit__type'), 'json');
await page.waitForTimeout(200);
check(await s1.locator('.body-edit__value-input').inputValue() === '4096', '切到 JSON 时保留原文本');

check(await s1.locator('.textarea-expand__btn').count() === 1, 'JSON 值有多行扩大按钮');
await s1.locator('.textarea-expand__btn').click();
await page.waitForSelector('.modal--expand', { timeout: 4000 });
await page.waitForTimeout(300);
const zorder = await page.evaluate(() => [...document.querySelectorAll('.modal-backdrop')]
  .map((b) => Number(getComputedStyle(b).zIndex) || 0));
console.log('  z-order:', JSON.stringify(zorder));
check(zorder.length === 3, '三层弹窗叠加（渠道 / 规则 / 扩大编辑）', zorder);
check(zorder[2] > zorder[1] && zorder[1] > zorder[0], '后开的弹窗层级更高', zorder);
await page.fill('#ldm-expand-editor', '{"a": 1}');
await page.click('.modal--expand [data-act=ok]');
await page.waitForTimeout(400);
check(await page.locator('.modal--expand').count() === 0, '扩大编辑窗口关闭');
check(await s1.locator('.body-edit__value-input').inputValue() === '{"a": 1}', '扩大编辑的内容回写到值');

await setSelect(s1.locator('select.body-edit__type'), 'string');
await page.waitForTimeout(100);
check(await s1.locator('.body-edit__value-input').inputValue() === '{"a": 1}', '切回字符串仍保留文本');
await setSelect(s1.locator('select.body-edit__type'), 'number');

// ---- 11) 值填错时拦在规则弹窗里 ----
await s1.locator('.body-edit__value-input').fill('abc');
await page.click(`${PANE} [data-act=save]`);
await page.waitForTimeout(500);
check(await page.locator(PANE).count() === 1, '值不是数字时规则弹窗不关闭');
// 提示条会堆叠，前面的「JSON 格式有误」可能还挂着，取全部文本再判断
const toastText = (await page.locator('.toast').allInnerTexts().catch(() => [])).join(' ');
check(/不是数字/.test(toastText), '提示「不是数字」', toastText.replace(/\s+/g, ' ').trim());
await s1.locator('.body-edit__value-input').fill('2048');

// ---- 12) 手机视口：独立弹窗里不横向溢出 ----
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
const overflow = await page.evaluate(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return { sw: el.scrollWidth, cw: el.clientWidth };
  };
  // 第 3 张卡片是移动规则：目标路径那一行在卡片内部，不能拿第一张（隐藏的）来量
  const moveCardEl = document.querySelector('.modal--body-edits .body-edit:nth-child(3)');
  const moveRowEl = moveCardEl && moveCardEl.querySelector('.body-edit__move');
  return {
    card: pick('.modal--body-edits .body-edit'),
    cond: pick('.modal--body-edits .body-cond'),
    moveCard: pick('.modal--body-edits .body-edit:nth-child(3)'),
    moveRow: moveRowEl ? { sw: moveRowEl.scrollWidth, cw: moveRowEl.clientWidth } : null,
    body: pick('.modal--body-edits .modal__body'),
    toolbar: pick('.modal--body-edits .body-edits-toolbar'),
  };
});
console.log('  phone:', JSON.stringify(overflow));
check(overflow.card && overflow.card.sw <= overflow.card.cw + 1, '手机端规则卡片不横向溢出', overflow.card);
check(overflow.cond && overflow.cond.sw <= overflow.cond.cw + 1, '手机端条件行不横向溢出', overflow.cond);
check(overflow.moveCard && overflow.moveCard.sw <= overflow.moveCard.cw + 1, '手机端移动卡片不横向溢出', overflow.moveCard);
check(overflow.moveRow && overflow.moveRow.sw <= overflow.moveRow.cw + 1, '手机端「移动到」一行不横向溢出', overflow.moveRow);
check(overflow.toolbar && overflow.toolbar.sw <= overflow.toolbar.cw + 1, '手机端工具栏不横向溢出', overflow.toolbar);
await page.waitForTimeout(2400); // 等提示条消失，别挡截图
await page.screenshot({ path: `${SHOT}/body-edits-window-390.png`, fullPage: false });

// ---- 13) 清理：清空规则并保存渠道 ----
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
