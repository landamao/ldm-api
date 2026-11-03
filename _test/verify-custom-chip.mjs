// 验证：开启自定义请求体后，输入框里的模型下拉/流式开关显示成模式提示，
// 且点击提示芯片能打开右侧配置栏；关闭后恢复原样。
// 前置：网关 LDMAPI_PASSWORD=test1234 -port 6831（LDMAPI_DEV=web 直接读 web/ 前端）
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6831';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
let failed = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed++;
};
page.on('pageerror', (e) => { console.log('[page error]', e.message); failed++; });

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1200);
}
await page.goto(BASE + '/#/chat', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

// 先把右侧配置栏收起来，模拟用户抱怨的场景（右栏关闭，看不到自定义开关）
await page.evaluate(() => {
  const layout = document.querySelector('#chat-layout');
  layout.classList.add('is-settings-collapsed');
});

// --- 普通模式基线 ---
const normal = await page.evaluate(() => ({
  chipsCustom: document.querySelector('.chat-input__chips').classList.contains('is-custom'),
  hintHidden: document.querySelector('#chat-chip-custom').hidden,
  modelShown: !!(document.querySelector('#chat-chip-model__trigger') || document.querySelector('#chat-chip-model')).offsetParent !== null
    || getComputedStyle(document.querySelector('.chat-chatip--model, .chat-chip--model')).display !== 'none',
  streamTrackShown: getComputedStyle(document.querySelector('#chat-chip-stream .switch__track')).display !== 'none',
}));
check('普通模式：芯片容器无 is-custom', !normal.chipsCustom);
check('普通模式：提示芯片隐藏', normal.hintHidden);
check('普通模式：流式滑轨可见', normal.streamTrackShown);
await page.screenshot({ path: SHOT + '/cc-1-normal.png' });

// --- 开启自定义请求体 ---
await page.evaluate(() => {
  const input = document.querySelector('#chat-custom-switch input');
  input.checked = true;
  input.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(400);

const custom = await page.evaluate(() => {
  const chips = document.querySelector('.chat-input__chips');
  const hint = document.querySelector('#chat-chip-custom');
  const modelChip = document.querySelector('.chat-chip--model');
  const track = document.querySelector('#chat-chip-stream .switch__track');
  const hintStyle = getComputedStyle(hint);
  return {
    chipsCustom: chips.classList.contains('is-custom'),
    hintVisible: !hint.hidden && hintStyle.display !== 'none',
    hintText: hint.textContent.trim(),
    modelGone: getComputedStyle(modelChip).display === 'none',
    triggerGone: (() => {
      const t = document.querySelector('#chat-chip-model__trigger');
      return !t || getComputedStyle(t).display === 'none';
    })(),
    streamTrackGone: getComputedStyle(track).display === 'none',
    streamLabel: getComputedStyle(document.querySelector('#chat-chip-stream .switch__label'), '::before').content,
  };
});
check('自定义模式：芯片容器带 is-custom', custom.chipsCustom);
check('自定义模式：模型下拉芯片隐藏', custom.modelGone && custom.triggerGone);
check('自定义模式：流式滑轨隐藏', custom.streamTrackGone);
check('自定义模式：提示胶囊显示「已开启自定义请求体」', custom.hintVisible && custom.hintText === '已开启自定义请求体', custom.hintText);
check('自定义模式：流式文字换成「自定义请求体」', custom.streamLabel.includes('自定义请求体'), custom.streamLabel);
await page.screenshot({ path: SHOT + '/cc-2-custom-collapsed.png' });

// --- 右栏收起时点提示芯片 → 右栏展开、自定义面板可见 ---
await page.click('#chat-chip-custom');
await page.waitForTimeout(600);
const opened = await page.evaluate(() => {
  const layout = document.querySelector('#chat-layout');
  const panel = document.querySelector('#chat-custom');
  const r = panel.getBoundingClientRect();
  return {
    collapsed: layout.classList.contains('is-settings-collapsed'),
    panelVisible: !panel.hidden && r.width > 0 && r.right <= innerWidth && r.left >= 0,
  };
});
check('点提示芯片：右栏展开', !opened.collapsed);
check('点提示芯片：自定义面板可见', opened.panelVisible);
await page.screenshot({ path: SHOT + '/cc-3-side-opened.png' });

// --- 点流式芯片也能打开右栏 ---
await page.evaluate(() => {
  document.querySelector('#chat-layout').classList.add('is-settings-collapsed');
});
await page.click('#chat-chip-stream', { force: true });
await page.waitForTimeout(600);
const opened2 = await page.evaluate(() => !document.querySelector('#chat-layout').classList.contains('is-settings-collapsed'));
check('点流式芯片：右栏展开', opened2);

// --- 复现「关闭后模型选择点不了」：发送期间 startRun 会给 select 赋值，
// 触发全局 sync 把触发器 disabled 设成 true；关闭自定义后触发器必须恢复可点 ---
await page.evaluate(() => {
  const sel = document.querySelector('#chat-chip-model');
  sel.value = sel.value; // 模拟发送期间 startRun 的赋值 → 全局 sync 同步 trigger.disabled
});
const stuck = await page.evaluate(() => document.querySelector('#chat-chip-model__trigger').disabled);
check('复现脱节：发送中赋值后触发器被禁用', stuck === true, 'trigger.disabled=' + stuck);
await page.click('#chat-chip-custom');
await page.waitForTimeout(300);
await page.evaluate(() => {
  const input = document.querySelector('#chat-custom-switch input');
  input.checked = false;
  input.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(400);
const fixed = await page.evaluate(() => {
  const trig = document.querySelector('#chat-chip-model__trigger');
  return {
    trigDisabled: trig.disabled,
    trigClickable: trig.offsetParent !== null,
  };
});
check('关闭后：触发器恢复可点（不再卡在禁用态）', fixed.trigDisabled === false, 'trigger.disabled=' + fixed.trigDisabled);

// --- 关闭自定义请求体 → 恢复 ---
await page.evaluate(() => {
  const input = document.querySelector('#chat-custom-switch input');
  input.checked = false;
  input.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(400);
const back = await page.evaluate(() => ({
  chipsCustom: document.querySelector('.chat-input__chips').classList.contains('is-custom'),
  hintGone: document.querySelector('#chat-chip-custom').hidden,
  modelBack: (() => {
    // .chat-chip--model 第一个匹配是原生 select（被自绘下拉接管后本就 display:none），
    // 恢复与否要看触发器按钮
    const t = document.querySelector('#chat-chip-model__trigger');
    return t && getComputedStyle(t).display !== 'none';
  })(),
  trackBack: getComputedStyle(document.querySelector('#chat-chip-stream .switch__track')).display !== 'none',
}));
check('关闭后：is-custom 移除', !back.chipsCustom);
check('关闭后：提示胶囊隐藏', back.hintGone);
check('关闭后：模型芯片恢复', back.modelBack);
check('关闭后：流式滑轨恢复', back.trackBack);
await page.screenshot({ path: SHOT + '/cc-4-restored.png' });

await browser.close();
console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
