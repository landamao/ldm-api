// 量「编辑文本」大弹窗的头部高度与正文四边边距
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

await page.goto(BASE + '/#/chat', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

// 聊天输入框右上角的「放大编辑」按钮
const btn = page.locator('.chat-input .textarea-expand__btn').first();
console.log('expand btn count =', await page.locator('.chat-input .textarea-expand__btn').count());
await btn.click({ force: true });
await page.waitForTimeout(500);

const geo = await page.evaluate(() => {
  const r = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) };
  };
  const modal = document.querySelector('.modal');
  const head = document.querySelector('.modal__head');
  const body = document.querySelector('.modal__body');
  const ta = document.querySelector('#ldm-expand-editor');
  const foot = document.querySelector('.modal__foot');
  const cs = (el, p) => (el ? getComputedStyle(el)[p] : null);
  const m = r(modal), bd = r(body), t = r(ta);
  return {
    modal: m,
    head: r(head),
    headPadding: head ? getComputedStyle(head).padding : null,
    body: bd,
    bodyPadding: cs(body, 'padding'),
    textarea: t,
    foot: r(foot),
    gaps: bd && t ? {
      top: +(t.y - bd.y).toFixed(1),
      left: +(t.x - bd.x).toFixed(1),
      right: +(bd.x + bd.w - (t.x + t.w)).toFixed(1),
      bottom: +(bd.y + bd.h - (t.y + t.h)).toFixed(1),
    } : null,
    headGapToBody: m && r(head) ? +(r(head).y + r(head).h - m.y).toFixed(1) : null,
    titleH: r(document.querySelector('.modal__title')),
    desc: !!document.querySelector('.modal__desc'),
  };
});
console.log(JSON.stringify(geo, null, 2));

await page.screenshot({ path: SHOT + '/expand-modal-after.png' });
await browser.close();
