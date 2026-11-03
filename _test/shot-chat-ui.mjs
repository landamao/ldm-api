// 只截图 + 量几何：看输入框芯片（模型下拉箭头 / 流式开关）、左右两栏、窄屏
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1000);
}

// 造几条会话，看列表排列
await page.evaluate(() => {
  const now = Date.now();
  const mk = (id, title, ago) => ({ id, title, createdAt: now - ago, updatedAt: now - ago, model: 'deepseek-chat', messages: [] });
  localStorage.setItem('ldmapi.chat.sessions', JSON.stringify({
    activeId: 's1',
    sessions: [mk('s1', '看看这个报错怎么排查', 60000), mk('s2', '写个 Go 的限流中间件', 3.6e6), mk('s3', '昨天那个 SQL 优化', 9e7)],
  }));
});

await page.goto(BASE + '/#/chat', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
await page.screenshot({ path: SHOT + '/ui-01-desktop.png' });

const geo = await page.evaluate(() => {
  const out = {};
  const trig = document.querySelector('#chat-chip-model__trigger');
  if (trig) {
    const v = trig.querySelector('.ldm-select__value');
    const c = trig.querySelector('.ldm-select__chev');
    const vr = v.getBoundingClientRect();
    const cr = c.getBoundingClientRect();
    const tr = trig.getBoundingClientRect();
    out.chipSelect = {
      triggerW: Math.round(tr.width),
      valueRight: Math.round(vr.right - tr.left),
      chevLeft: Math.round(cr.left - tr.left),
      overlapPx: Math.round(vr.right - cr.left),
      text: v.textContent,
      padRight: getComputedStyle(trig).paddingRight,
    };
  }
  const sw = document.querySelector('.chat-input__chips .switch');
  if (sw) {
    const track = sw.querySelector('.switch__track');
    const knob = getComputedStyle(track, '::after');
    const trackBox = track.getBoundingClientRect();
    const knobOuter = parseFloat(knob.width) + 2 * parseFloat(knob.borderTopWidth);
    const travel = track.clientWidth - knobOuter - 1;
    out.switch = {
      trackW: Math.round(trackBox.width),
      trackH: Math.round(trackBox.height),
      knobW: knob.width, knobH: knob.height, knobTransform: knob.transform,
      knobBoxSizing: knob.boxSizing,
      knobBorder: knob.borderTopWidth,
      knobOuter,
      neededTravel: travel,
    };
  }
  // 右侧参数里的小开关也量一下
  const psw = document.querySelector('.chat-param .switch');
  if (psw) {
    const track = psw.querySelector('.switch__track');
    const knob = getComputedStyle(track, '::after');
    const knobOuter = parseFloat(knob.width) + 2 * parseFloat(knob.borderTopWidth);
    out.paramSwitch = { clientW: track.clientWidth, knobOuter, neededTravel: track.clientWidth - knobOuter - 1, transform: knob.transform };
  }
  const conv = document.querySelector('#chat-conv');
  const side = document.querySelector('#chat-side');
  out.panels = {
    convBg: getComputedStyle(conv).backgroundColor,
    sideBg: getComputedStyle(side).backgroundColor,
    convBodyScrollH: document.querySelector('#chat-conv-list').scrollHeight,
    convBodyClientH: document.querySelector('#chat-conv-list').clientHeight,
    newBtnH: Math.round(document.querySelector('#chat-conv-new').getBoundingClientRect().height),
    firstItemTop: Math.round(document.querySelector('.chat-conv__item').getBoundingClientRect().top
      - document.querySelector('#chat-conv-list').getBoundingClientRect().top),
  };
  return out;
});
console.log('[几何]', JSON.stringify(geo, null, 1));

// 局部放大截图：输入框芯片
const bar = await page.locator('.chat-input__bar').boundingBox();
if (bar) {
  await page.screenshot({
    path: SHOT + '/ui-02-chips.png',
    clip: { x: bar.x - 4, y: bar.y - 4, width: Math.min(bar.width + 8, 520), height: bar.height + 8 },
  });
}
// 单独把流式开关切出来看圆钮有没有贴到右边
const swBox = await page.locator('.chat-input__chips .switch').boundingBox();
if (swBox) {
  await page.screenshot({
    path: SHOT + '/ui-05-switch.png',
    clip: { x: swBox.x - 3, y: swBox.y - 3, width: swBox.width + 6, height: swBox.height + 6 },
  });
}
// 左侧列表
const convBox = await page.locator('#chat-conv').boundingBox();
if (convBox) {
  await page.screenshot({ path: SHOT + '/ui-03-conv.png', clip: convBox });
}

// 窄屏
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(600);
await page.screenshot({ path: SHOT + '/ui-04-mobile.png' });

await browser.close();
console.log('done');
