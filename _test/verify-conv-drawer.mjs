// 验证：① 窄屏（带上一次桌面“已收起”偏好）点把手能完整展开 ② 关闭不再留残边 ③ 抽屉无投影 ④ 遮罩可点关闭
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });

async function openChat(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  if (await page.locator('#login-pwd').count()) {
    await page.fill('#login-pwd', PWD);
    await page.click('#login-btn');
    await page.waitForTimeout(1100);
  }
  await page.goto(BASE + '/#/chat', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1100);
}

const measure = (page) => page.evaluate(() => {
  const el = document.querySelector('#chat-conv');
  const r = el.getBoundingClientRect();
  const c = getComputedStyle(el);
  const at = document.elementFromPoint(8, 400);
  return {
    rect: [Math.round(r.left), Math.round(r.right), Math.round(r.width)],
    win: window.innerWidth,
    shadow: c.boxShadow,
    vis: c.visibility,
    marginLeft: c.marginLeft,
    leftEdgeHit: at ? (at.id || at.className || at.tagName) : null,
    classes: document.querySelector('.chat-layout').className,
  };
});

// ---------- 场景 A：窄屏桌面浏览器，且带着“上次在桌面收起过”的偏好 ----------
const p1 = await browser.newPage({ viewport: { width: 700, height: 900 } });
await p1.addInitScript(() => { try { localStorage.setItem('ldmapi.chat.conv', '0'); } catch (e) {} });
await openChat(p1);
console.log('[A 初始]', JSON.stringify(await measure(p1)));
const handle = p1.locator('#chat-conv-open');
console.log('[A 把手可见]', await handle.isVisible());
await handle.click();
await p1.waitForTimeout(450);
const aOpen = await measure(p1);
console.log('[A 展开]', JSON.stringify(aOpen));
console.log('  → 完整展开?', aOpen.rect[0] === 20 && aOpen.rect[2] === 280);
await p1.screenshot({ path: 'D:/code/ldm-api/_test/shots/v2-conv-open-700.png' });
await p1.click('#chat-conv-scrim', { position: { x: 600, y: 450 } });
await p1.waitForTimeout(400);
const aClosed = await measure(p1);
console.log('[A 关闭]', JSON.stringify(aClosed));
console.log('  → 无残边?', aClosed.rect[1] <= 0 && aClosed.vis === 'hidden');
console.log('  → 左边缘不再是抽屉?', !/chat-conv/.test(String(aClosed.leftEdgeHit)));
await p1.screenshot({ path: 'D:/code/ldm-api/_test/shots/v2-conv-closed-700.png' });

// ---------- 场景 B：手机宽度 ----------
const p2 = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await openChat(p2);
await p2.click('#chat-conv-open');
await p2.waitForTimeout(400);
console.log('[B 展开]', JSON.stringify(await measure(p2)));
await p2.screenshot({ path: 'D:/code/ldm-api/_test/shots/v2-conv-open-390.png' });

// 关闭逐帧（看是否还有“先消失再滑走”）
const frames = p2.evaluate(async () => {
  const el = document.querySelector('#chat-conv');
  const scrim = document.querySelector('#chat-conv-scrim');
  const out = [];
  const t0 = performance.now();
  await new Promise((res) => {
    const tick = () => {
      const r = el.getBoundingClientRect();
      out.push({ t: Math.round(performance.now() - t0), left: Math.round(r.left), vis: getComputedStyle(el).visibility, scrim: getComputedStyle(scrim).opacity });
      if (performance.now() - t0 < 420) requestAnimationFrame(tick); else res();
    };
    requestAnimationFrame(tick);
  });
  return out;
});
await p2.waitForTimeout(50);
await p2.click('#chat-conv-collapse');
console.log('[B 关闭帧]', JSON.stringify(await frames));
await p2.waitForTimeout(400);
console.log('[B 关闭后]', JSON.stringify(await measure(p2)));

await browser.close();
