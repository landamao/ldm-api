// 验证：手机端回车只换行、不发送；桌面端回车仍然发送
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });

const run = async (label, opts) => {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  if (await page.locator('#login-pwd').count()) {
    await page.fill('#login-pwd', PWD);
    await page.click('#login-btn');
    await page.waitForTimeout(900);
  }
  await page.goto(BASE + '/#/chat', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);
  await page.click('#chat-text');
  await page.type('#chat-text', '第一行');
  await page.keyboard.press('Enter');
  await page.type('#chat-text', '第二行');
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => ({
    value: document.querySelector('#chat-text').value,
    msgs: document.querySelectorAll('#chat-log .msg').length,
    coarse: matchMedia('(pointer: coarse)').matches,
  }));
  console.log(label, JSON.stringify(r));
  await page.screenshot({ path: `D:/code/ldm-api/_test/shots/${label}.png` });
  await ctx.close();
};

await run('mob-enter', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await run('desk-enter', { viewport: { width: 1440, height: 900 } });

await browser.close();
console.log('done');
