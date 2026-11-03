// 验证左侧会话列表：少的时候垂直居中、多的时候正常从顶部开始滚
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
  await page.waitForTimeout(900);
}

const seed = (n) => page.evaluate((count) => {
  const now = Date.now();
  const sessions = [];
  for (let i = 0; i < count; i += 1) {
    sessions.push({ id: 's' + i, title: '会话 ' + (i + 1) + ' 的标题', createdAt: now - i * 3600e3, updatedAt: now - i * 3600e3, model: 'deepseek-chat', messages: [] });
  }
  localStorage.setItem('ldmapi.chat.sessions', JSON.stringify({ activeId: 's0', sessions }));
}, n);

const measure = () => page.evaluate(() => {
  const body = document.querySelector('.chat-conv__body');
  const inner = document.querySelector('#chat-conv-list');
  const first = document.querySelector('.chat-conv__item');
  const b = body.getBoundingClientRect();
  const i = inner.getBoundingClientRect();
  const f = first.getBoundingClientRect();
  return {
    bodyH: Math.round(b.height),
    innerH: Math.round(i.height),
    innerTopGap: Math.round(i.top - b.top),
    firstItemTop: Math.round(f.top),
    overflow: body.scrollHeight - body.clientHeight,
    scrollTop: Math.round(body.scrollTop),
  };
});

await seed(3);
await page.goto(BASE + '/#/chat', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1300);
console.log('[3 条]', JSON.stringify(await measure()));
await page.screenshot({ path: SHOT + '/list-3.png', clip: await page.locator('#chat-conv').boundingBox() });

await seed(30);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1300);
const many = await measure();
console.log('[30 条]', JSON.stringify(many));
await page.evaluate(() => { document.querySelector('.chat-conv__body').scrollTop = 0; });
await page.waitForTimeout(200);
console.log('[30 条 · 回到顶部]', JSON.stringify(await measure()));
await page.screenshot({ path: SHOT + '/list-30.png', clip: await page.locator('#chat-conv').boundingBox() });

await browser.close();
console.log('done');
