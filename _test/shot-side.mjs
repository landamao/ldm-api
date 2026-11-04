import { chromium } from 'playwright-core';
const BASE = 'http://127.0.0.1:6821';
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });

const login = async (page) => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  if (await page.locator('#login-pwd').count()) {
    await page.fill('#login-pwd', 'test1234');
    await page.click('#login-btn');
    await page.waitForTimeout(1300);
  }
  await page.goto(BASE + '/#/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const el = document.querySelector('#dash-preset');
    if (el) { el.value = 'all'; el.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(1800);
};

const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const p1 = await ctx1.newPage();
await login(p1);
await p1.screenshot({ path: 'shots/side-light.png' });
console.log('light ok');

const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const p2 = await ctx2.newPage();
await login(p2);
await p2.click('#btn-theme');
await p2.waitForTimeout(800);
await p2.screenshot({ path: 'shots/side-dark.png' });
console.log('dark ok');

const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const p3 = await ctx3.newPage();
await login(p3);
await p3.click('#btn-menu');
await p3.waitForTimeout(700);
await p3.screenshot({ path: 'shots/side-mobile.png' });
console.log('mobile ok');

await browser.close();
