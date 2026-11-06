// 手机端聊天页顶栏：上加号、下左右展开，垃圾桶不出现
// 前置：LDMAPI_DEV=web LDMAPI_PASSWORD=test1234 ./dist/ldmapi-windows-amd64.exe -port 6821 -data _test/tmp-shots-data
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.91' },
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console error]', m.text()); });

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1500);
}
await page.goto(BASE + '/#/chat', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
await page.screenshot({ path: SHOT + '/chat-phone-bar-1-default.png' });

const geo = () => page.evaluate(() => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      display: cs.display, visibility: cs.visibility, hidden: el.hidden, text: el.textContent.trim(),
    };
  };
  return {
    bar: box('#chat-bar'),
    plus: box('#chat-conv-edge-new'),
    left: box('#chat-conv-open'),
    right: box('#chat-side-open'),
    trash: box('#chat-side-edge-clear'),
    logTop: Math.round(document.querySelector('#chat-log').getBoundingClientRect().top),
    firstMsgTop: (() => {
      const m = document.querySelector('#chat-log .msg');
      return m ? Math.round(m.getBoundingClientRect().top) : null;
    })(),
    layoutTop: Math.round(document.querySelector('#chat-layout').getBoundingClientRect().top),
  };
});

const g0 = await geo();
console.log('[默认]', JSON.stringify(g0));

const rows = [];
if (g0.plus && g0.left && g0.right) {
  rows.push(['三个按钮同一行', Math.abs(g0.plus.y - g0.left.y) <= 1 && Math.abs(g0.left.y - g0.right.y) <= 1]);
  rows.push(['顺序是「> < +」', g0.left.x < g0.right.x && g0.right.x < g0.plus.x]);
  rows.push(['加号在最右', g0.plus.x > g0.right.x && g0.plus.x + g0.plus.w >= g0.right.x + g0.right.w]);
  rows.push(['加号在木牌里', g0.plus.y < g0.layoutTop]);
  rows.push(['整排在靠右', g0.plus.x + g0.plus.w >= g0.bar.x + g0.bar.w - 2]);
  rows.push(['垃圾桶不显示', !g0.trash || g0.trash.display === 'none']);
  rows.push(['第一行消息在顶栏下面', g0.firstMsgTop === null || g0.firstMsgTop >= g0.layoutTop - 1]);
}
rows.forEach(([k, ok]) => console.log((ok ? 'OK  ' : 'FAIL') + ' ' + k));

// 打开左侧对话列表
await page.click('#chat-conv-open');
await page.waitForTimeout(500);
await page.screenshot({ path: SHOT + '/chat-phone-bar-2-conv.png' });
const convOpen = await page.evaluate(() => ({
  convOpen: document.querySelector('#chat-layout').classList.contains('is-conv-open'),
  barVisible: document.querySelector('#chat-bar').getBoundingClientRect().height > 0,
  convTop: Math.round(document.querySelector('#chat-conv').getBoundingClientRect().top),
  layoutTop: Math.round(document.querySelector('#chat-layout').getBoundingClientRect().top),
}));
console.log('[左抽屉]', JSON.stringify(convOpen));

// 再点一下收起
await page.click('#chat-conv-open');
await page.waitForTimeout(400);
console.log('[左抽屉再点一下]', JSON.stringify(await page.evaluate(() => ({
  convOpen: document.querySelector('#chat-layout').classList.contains('is-conv-open'),
}))));

// 打开右侧配置栏（左抽屉会同步收掉）
await page.click('#chat-conv-open');
await page.waitForTimeout(300);
await page.click('#chat-side-open');
await page.waitForTimeout(500);
await page.screenshot({ path: SHOT + '/chat-phone-bar-3-settings.png' });
console.log('[右抽屉]', JSON.stringify(await page.evaluate(() => {
  const l = document.querySelector('#chat-layout');
  const side = document.querySelector('#chat-side').getBoundingClientRect();
  const bar = document.querySelector('#chat-bar').getBoundingClientRect();
  return {
    settingsOpen: l.classList.contains('is-settings-open'),
    convOpen: l.classList.contains('is-conv-open'),
    sideTop: Math.round(side.top),
    barBottom: Math.round(bar.bottom),
    sideCoversBar: side.top < bar.bottom,
  };
})));

// 抽屉开着时点顶栏加号：应当新建对话并把抽屉收起来
await page.click('#chat-conv-open');
await page.waitForTimeout(300);
await page.click('#chat-conv-edge-new');
await page.waitForTimeout(500);
console.log('[抽屉开着点加号]', JSON.stringify(await page.evaluate(() => ({
  convOpen: document.querySelector('#chat-layout').classList.contains('is-conv-open'),
  settingsOpen: document.querySelector('#chat-layout').classList.contains('is-settings-open'),
}))));

// 小屏兜底：360×640 下顶栏别把内容挤爆
await page.setViewportSize({ width: 360, height: 640 });
await page.waitForTimeout(500);
await page.screenshot({ path: SHOT + '/chat-phone-bar-5-small.png' });
console.log('[360 宽]', JSON.stringify(await page.evaluate(() => {
  const bar = document.querySelector('#chat-bar').getBoundingClientRect();
  const right = document.querySelector('#chat-side-open').getBoundingClientRect();
  const compose = document.querySelector('.chat-compose').getBoundingClientRect();
  return {
    barRight: Math.round(bar.right),
    btnRight: Math.round(right.right),
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    composeTop: Math.round(compose.top),
  };
})));

// 有内容的会话：顶栏不能压住第一条消息
await page.setViewportSize({ width: 390, height: 844 });
await page.evaluate(() => {
  const now = Date.now();
  localStorage.setItem('ldmapi.chat.sessions', JSON.stringify({
    activeId: 'sdemo',
    sessions: [{
      id: 'sdemo', title: '手机端顶栏改造', createdAt: now, updatedAt: now, model: 'chat-default',
      messages: [
        { role: 'user', content: '手机上把左右抽屉按钮挪到顶栏，顺便加个新建对话的加号' },
        { role: 'assistant', content: '挪好了。顶栏木牌右端现在是两行：上面加号新建对话，下面「> <」分别拉开左侧对话列表和右侧模型配置；垃圾桶清空键在手机上不再出现，清空入口留在配置栏底部。' },
        { role: 'user', content: '抽屉打开的时候顶栏还在吗？' },
        { role: 'assistant', content: '在。两个抽屉都从顶栏下面滑出来，木牌不跟着动，开着抽屉也能直接切到另一边。' },
      ],
    }],
  }));
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
await page.screenshot({ path: SHOT + '/chat-phone-bar-7-with-msgs.png' });
console.log('[有消息]', JSON.stringify(await page.evaluate(() => {
  const bar = document.querySelector('#chat-bar').getBoundingClientRect();
  const first = document.querySelector('#chat-log .msg');
  const log = document.querySelector('#chat-log');
  return {
    barBottom: Math.round(bar.bottom),
    logTop: Math.round(log.getBoundingClientRect().top),
    firstMsgTop: first ? Math.round(first.getBoundingClientRect().top) : null,
  };
})));

// 深色主题
await page.evaluate(() => {
  document.documentElement.setAttribute('data-theme', 'dark');
  try { localStorage.setItem('ldmapi.theme', 'dark'); } catch (e) {}
});
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
await page.screenshot({ path: SHOT + '/chat-phone-bar-6-dark.png' });
await page.evaluate(() => {
  document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem('ldmapi.theme', 'light'); } catch (e) {}
});

// 桌面端回归：把手位置跟以前一样（左上 / 右上贴着卡片顶）
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(700);
// 两侧都收起来，把手该露出来了
await page.click('#chat-side-close');
await page.waitForTimeout(300);
await page.click('#chat-conv-collapse');
await page.waitForTimeout(600);
await page.screenshot({ path: SHOT + '/chat-phone-bar-4-desktop.png' });
console.log('[桌面 · 双栏收起]', JSON.stringify(await page.evaluate(() => {
  const r = (s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      x: Math.round(b.left), y: Math.round(b.top), hidden: el.hidden, display: cs.display, pos: cs.position,
    };
  };
  const card = document.querySelector('#chat-card').getBoundingClientRect();
  return {
    card: { x: Math.round(card.left), y: Math.round(card.top), w: Math.round(card.width) },
    plus: r('#chat-conv-edge-new'), left: r('#chat-conv-open'), right: r('#chat-side-open'), trash: r('#chat-side-edge-clear'),
  };
})));

// 桌面端把手的点击不能被 chat-bar 容器挡住
await page.click('#chat-conv-open');
await page.waitForTimeout(500);
await page.click('#chat-side-open');
await page.waitForTimeout(500);
console.log('[桌面 · 点把手展开]', JSON.stringify(await page.evaluate(() => {
  const l = document.querySelector('#chat-layout');
  return {
    convOpen: !l.classList.contains('is-conv-collapsed'),
    sideOpen: !l.classList.contains('is-settings-collapsed'),
  };
})));

// 桌面 → 手机 再切回来：按钮要跟着搬家，不能两头都留或两头都没有
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
console.log('[桌面→手机]', JSON.stringify(await page.evaluate(() => ({
  inTopbar: !!document.querySelector('#topbar-actions #chat-bar'),
  inCard: !!document.querySelector('#chat-card #chat-bar'),
  count: document.querySelectorAll('#chat-bar').length,
}))));

// 切到别的页面：顶栏里不能留下聊天页的按钮
await page.evaluate(() => { location.hash = '#/dashboard'; });
await page.waitForTimeout(1500);
console.log('[切页后]', JSON.stringify(await page.evaluate(() => ({
  hasBar: !!document.getElementById('chat-bar'),
  actionsChildren: document.getElementById('topbar-actions').children.length,
}))));

await browser.close();
console.log('done');
