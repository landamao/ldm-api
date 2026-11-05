// 看板环形图 / 排行条：被省略号截断的名字能不能看全名。
// 桌面：悬停被截断的名字 → 冒气泡显示全名；短名字不冒泡；鼠标移开气泡收起。
// 手机：点一下名字冒气泡，点空白处收起。
// 用法：node _test/verify-donut-names.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';

const fails = [];
const ok = (cond, msg) => {
  if (cond) console.log('  ok   ' + msg);
  else { console.log('  FAIL ' + msg); fails.push(msg); }
};

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });

async function login(ctx) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  if (await page.locator('#login-pwd').count()) {
    await page.fill('#login-pwd', PWD);
    await page.click('#login-btn');
    await page.waitForTimeout(1200);
  }
  return page;
}

async function openDash(page) {
  await page.goto(BASE + '/#/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  // 演示库的日志不在「今日」区间，切到全部时间才有数据
  await page.evaluate(() => {
    const el = document.querySelector('#dash-preset');
    if (el) { el.value = 'all'; el.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(2200);
}

// 环形图图例里的名字：谁被截断、谁没有
const readNames = (page) => page.evaluate(() => Array.from(document.querySelectorAll('.donut-legend__name')).map((el) => ({
  name: el.dataset.name,
  text: el.textContent,
  clipped: el.scrollWidth > el.clientWidth + 1,
  marked: el.classList.contains('chart-name--clip'),
  w: Math.round(el.getBoundingClientRect().width),
})));

// ---------- 桌面 ----------
console.log('\n[桌面 1440]');
const dctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.81' },
});
const dpage = await login(dctx);
await openDash(dpage);

const names = await readNames(dpage);
const clipped = names.filter((n) => n.clipped);
const short = names.filter((n) => !n.clipped);
console.log(`  图例 ${names.length} 条，截断 ${clipped.length} 条；名字列宽 ${names.map((n) => n.w).join('/')}`);
ok(names.length > 0, '环形图图例渲染出来了');
ok(clipped.length > 0, '演示数据里有被截断的长名字（否则测不到气泡）');
ok(clipped.every((n) => n.marked), '被截断的名字都挂上了气泡标记');
ok(short.every((n) => !n.marked), '没被截断的名字不挂气泡');

if (clipped.length) {
  const target = clipped[0];
  const el = dpage.locator('.donut-legend__name').filter({ hasText: target.text }).first();
  await el.hover();
  await dpage.waitForTimeout(250);
  const tip = await dpage.evaluate(() => {
    const t = document.querySelector('.chart-tip--name.is-on');
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { text: t.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height };
  });
  ok(!!tip, '悬停被截断的名字弹出气泡');
  ok(tip && tip.text === target.name, `气泡里是全名（${tip && tip.text}）`);
  ok(tip && tip.left >= 0 && tip.right <= 1440 && tip.top >= 0 && tip.bottom <= 900, '气泡完整落在视口里');
  await dpage.screenshot({ path: `${SHOT}/donut-name-tip.png`, clip: { x: 0, y: 160, width: 1440, height: 520 } });

  // 鼠标移开 → 收起
  await dpage.mouse.move(30, 600);
  await dpage.waitForTimeout(300);
  ok(!(await dpage.locator('.chart-tip--name.is-on').count()), '鼠标移开后气泡收起');

  // 滚动时跟着名字走（不直接消失）：手机点开后常有惯性滚动。
  // 这里用键盘聚焦打开气泡再滚——鼠标悬停时滚轮会把鼠标带到别的行上，
  // 浏览器自己就会发 pointerleave，那是正常的收起。
  await dpage.mouse.move(30, 600);
  await dpage.waitForTimeout(200);
  await el.evaluate((node) => node.focus());
  await dpage.waitForTimeout(250);
  const before = await el.evaluate((node) => {
    const t = document.querySelector('.chart-tip--name.is-on');
    return t ? { gap: Math.round(t.getBoundingClientRect().top - node.getBoundingClientRect().bottom), top: Math.round(node.getBoundingClientRect().top) } : null;
  });
  await el.evaluate((node) => {
    let p = node.parentElement;
    while (p && !(p.scrollHeight > p.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
    p = p || document.scrollingElement;
    p.scrollBy(0, 90);
  });
  await dpage.waitForTimeout(400);
  const after = await el.evaluate((node) => {
    const t = document.querySelector('.chart-tip--name.is-on');
    return t ? { gap: Math.round(t.getBoundingClientRect().top - node.getBoundingClientRect().bottom), top: Math.round(node.getBoundingClientRect().top) } : null;
  });
  ok(before && after, '滚动后气泡还在（没有直接收起）');
  ok(before && after && Math.abs(before.top - after.top) >= 60 && after.gap === before.gap, '滚动后气泡仍贴在名字下面（跟着走）');
  await el.evaluate((node) => node.blur());
  await dpage.waitForTimeout(200);
  ok(!(await dpage.locator('.chart-tip--name.is-on').count()), '键盘失焦后气泡收起');

  // 短名字不该冒泡
  if (short.length) {
    await dpage.mouse.move(30, 600);
    await dpage.waitForTimeout(200);
    await dpage.locator('.donut-legend__name').filter({ hasText: short[0].text }).first().hover();
    await dpage.waitForTimeout(200);
    ok(!(await dpage.locator('.chart-tip--name.is-on').count()), '短名字悬停不冒气泡');
  }
}

// 渠道排行条同样能看到全名
const rank = await dpage.evaluate(() => Array.from(document.querySelectorAll('.rank-item__name')).map((el) => ({
  name: el.dataset.name,
  marked: el.classList.contains('chart-name--clip'),
  clipped: el.scrollWidth > el.clientWidth + 1,
})));
ok(rank.length > 0 && rank.every((r) => !!r.name), '排行条的名字也带了 data-name');
ok(rank.filter((r) => r.clipped).every((r) => r.marked), '排行条被截断的名字也挂了气泡');

// ---------- 手机 ----------
console.log('\n[手机 390]');
const mctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.82' },
});
const mpage = await login(mctx);
// 手机上环形图会换行、图例拿到整行宽度，演示库的名字都不够长；
// 这里把一个模型名换成长的，专门测「截断 → 点开看全名」这条路。
const LONG = 'claude-sonnet-4-5-20250929-thinking-preview-2026-extended';
await mpage.route('**/api/stats/breakdown**', async (route) => {
  const res = await route.fetch();
  const body = await res.json();
  for (const key of ['models', 'models_by_tokens']) {
    if (body[key] && body[key][0]) body[key][0].name = LONG;
  }
  await route.fulfill({ response: res, json: body });
});
await openDash(mpage);

const mNames = await readNames(mpage);
ok(mNames.length > 0, '手机上环形图图例也渲染出来了');
ok(mNames.some((n) => n.clipped && n.marked), '手机上被截断的名字也挂了气泡');
if (mNames.length) {
  const first = mpage.locator('.donut-legend__name').first();
  await first.scrollIntoViewIfNeeded();
  await first.tap();
  await mpage.waitForTimeout(300);
  const t1 = await mpage.evaluate(() => {
    const t = document.querySelector('.chart-tip--name.is-on');
    return t ? { text: t.textContent, right: t.getBoundingClientRect().right } : null;
  });
  ok(!!t1, '手机点名字弹出气泡');
  ok(t1 && t1.text === LONG, '手机气泡里是完整长名字');
  ok(t1 && t1.right <= 390, '手机上的气泡没有超出屏幕');
  await mpage.screenshot({ path: `${SHOT}/donut-name-tip-mobile.png`, fullPage: false });

  await mpage.tap('#content', { position: { x: 20, y: 20 } }).catch(() => {});
  await mpage.waitForTimeout(250);
  ok(!(await mpage.locator('.chart-tip--name.is-on').count()), '点空白处气泡收起');
}

await browser.close();
console.log(fails.length ? `\n${fails.length} 项失败` : '\n全部通过');
process.exit(fails.length ? 1 : 0);
