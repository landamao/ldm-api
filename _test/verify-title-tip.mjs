// 统一气泡：全站原生 title 被接管后的回归。
// 桌面：悬停带 title 的元素 → 冒气泡显示同一段文字；原生 title 已摘掉；移开收起。
// 手机：点一下带 title 的元素 → 气泡出现且不出屏；点空白收起。
// 用法：node _test/verify-title-tip.mjs（默认 6821 端口的已跑起来的服务）
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';

const fails = [];
const ok = (cond, msg, extra) => {
  if (cond) console.log('  ok   ' + msg);
  else { console.log('  FAIL ' + msg + (extra ? ' -> ' + extra : '')); fails.push(msg); }
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

const tipOn = (page) => page.evaluate(() => {
  const t = document.querySelector('.chart-tip.is-on');
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return {
    text: (t.textContent || '').trim(),
    cls: t.className,
    pe: getComputedStyle(t).pointerEvents,
    left: Math.round(r.left), right: Math.round(r.right),
    top: Math.round(r.top), bottom: Math.round(r.bottom),
    vw: window.innerWidth, vh: window.innerHeight,
  };
});

// 把目标节点钉在 window 上：属性变了之后 locator 会重新查询，指到别的同名节点上
const pin = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  window.__tipTarget = el;
  const r = el.getBoundingClientRect();
  return { title: el.getAttribute('title'), x: r.x + r.width / 2, y: r.y + r.height / 2 };
}, sel);

const targetTitle = (page) => page.evaluate(() => window.__tipTarget.getAttribute('title'));

// ---------- 桌面 ----------
console.log('\n[桌面 1440]');
const dctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.101' },
});
const dpage = await login(dctx);
await dpage.goto(BASE + '/#/channels', { waitUntil: 'domcontentloaded' });
await dpage.waitForTimeout(1600);

// 渠道名：带 title 的截断文本，不会触发任何操作
const box = await pin(dpage, '.channels-card td span[title]');
ok(!!box && !!box.title, `找到一个带 title 的元素（${box && box.title}）`);
await dpage.mouse.move(box.x, box.y);
await dpage.waitForTimeout(320);
const d1 = await tipOn(dpage);
ok(!!d1, '悬停后弹出气泡');
ok(d1 && d1.text === box.title, `气泡文字就是原 title（${d1 && d1.text}）`);
ok(d1 && d1.left >= 0 && d1.right <= d1.vw && d1.top >= 0 && d1.bottom <= d1.vh, '气泡完整落在视口里');
ok(d1 && d1.pe === 'none', '普通文字气泡不吃鼠标事件', d1 && d1.pe);
ok((await targetTitle(dpage)) === null, '原生 title 已摘掉，不会同时冒原生气泡');
await dpage.screenshot({ path: `${SHOT}/title-tip-desktop.png`, clip: { x: 0, y: 100, width: 1440, height: 420 } });

await dpage.mouse.move(20, 700);
await dpage.waitForTimeout(320);
ok(!(await tipOn(dpage)), '鼠标移开后气泡收起');
ok((await dpage.locator('.chart-tip.is-on').count()) === 0, '收起后节点也摘掉了');

// 长帮助文本：问号按钮
await dpage.goto(BASE + '/#/models', { waitUntil: 'domcontentloaded' });
await dpage.waitForTimeout(1500);
// 长帮助文本：现插一个节点，顺带验证「运行期新加的 DOM 也能被接管」
const LONG = '开启后对话类请求一律以流式请求上游：客户端要流式时正常透传，客户端要非流式时由网关流式收完再按非流式返回。这样超时时间按「两段输出之间的空档」生效，上游迟迟不吐字、或者吐一半卡住，都能快速失败并切到下一条路由。';
await dpage.evaluate((text) => {
  const d = document.createElement('div');
  d.id = 'tip-probe';
  d.textContent = '长文本探测';
  d.title = text;
  d.style.cssText = 'position:fixed;left:620px;top:320px;z-index:9999;padding:6px 10px;background:#fff;border-radius:6px';
  document.body.appendChild(d);
}, LONG);
const hb = await pin(dpage, '#tip-probe');
await dpage.mouse.move(hb.x, hb.y);
await dpage.waitForTimeout(320);
const d2 = await tipOn(dpage);
ok(!!d2, '长帮助文本也能弹气泡（运行期新加的节点同样接管）');
ok(d2 && d2.text === LONG, '长帮助文本内容一致');
ok(d2 && d2.bottom <= d2.vh && d2.top >= 0, '长帮助文本不顶出视口', d2 && `${d2.top}..${d2.bottom}/${d2.vh}`);
ok(d2 && (d2.right - d2.left) <= 340, '长帮助文本按最大宽度折行', d2 && `${d2.right - d2.left}px`);
await dpage.screenshot({ path: `${SHOT}/title-tip-long.png`, clip: { x: 0, y: 100, width: 1440, height: 640 } });

// ---------- 手机 ----------
console.log('\n[手机 390]');
const mctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.102' },
});
const mpage = await login(mctx);
await mpage.goto(BASE + '/#/channels', { waitUntil: 'domcontentloaded' });
await mpage.waitForTimeout(1800);

const mbox = await pin(mpage, '.channels-card td span[title]');
if (mbox) {
  await mpage.touchscreen.tap(mbox.x, mbox.y);
  await mpage.waitForTimeout(320);
  const m1 = await tipOn(mpage);
  ok(!!m1, '手机上点一下弹出气泡');
  ok(m1 && m1.text === mbox.title, `手机上气泡文字正确（${m1 && m1.text}）`);
  ok(m1 && m1.left >= 0 && m1.right <= m1.vw, '手机气泡没有超出屏幕', m1 && `${m1.left}..${m1.right}/${m1.vw}`);
  await mpage.screenshot({ path: `${SHOT}/title-tip-mobile.png` });

  await mpage.locator('#page-title').tap();
  await mpage.waitForTimeout(320);
  ok(!(await tipOn(mpage)), '手机点空白处气泡收起');

  await mpage.touchscreen.tap(mbox.x, mbox.y);
  await mpage.waitForTimeout(320);
  ok(await tipOn(mpage), '手机上再点还能弹出');
  await mpage.touchscreen.tap(mbox.x, mbox.y);
  await mpage.waitForTimeout(320);
  ok(!(await tipOn(mpage)), '手机再点同一个元素收起');
} else {
  ok(false, '手机渠道页没找到带 title 的元素');
}

await browser.close();
console.log(fails.length ? `\n${fails.length} 项失败` : '\n全部通过');
process.exit(fails.length ? 1 : 0);
