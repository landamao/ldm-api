// 全页面残留阴影检查 + 关键页截图
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';
const PAGES = ['dashboard', 'models', 'channels', 'tokens', 'logs', 'plaza', 'chat', 'settings'];

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1400);
}

const scan = () =>
  page.evaluate(() => {
    const out = [];
    document.querySelectorAll('*').forEach((el) => {
      const cs = getComputedStyle(el);
      const parts = [];
      if (cs.boxShadow && cs.boxShadow !== 'none') parts.push('box:' + cs.boxShadow);
      if (cs.textShadow && cs.textShadow !== 'none') parts.push('text:' + cs.textShadow);
      if (cs.filter && cs.filter.includes('drop-shadow')) parts.push('filter:' + cs.filter);
      if (parts.length) out.push((typeof el.className === 'string' ? el.className : el.tagName) + ' => ' + parts.join(' | '));
    });
    return out;
  });

for (const p of PAGES) {
  await page.goto(BASE + '/#/' + p, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const res = await scan();
  console.log(p, '=>', res.length ? JSON.stringify(res.slice(0, 6), null, 1) : 'clean');
  if (p === 'models' || p === 'logs' || p === 'channels') {
    await page.screenshot({ path: `${SHOT}/noshadow-${p}.png` });
  }
}

await browser.close();
console.log('done');
