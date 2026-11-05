// 探测页面上所有"黑边"元素：把描边色接近 --outline 深棕的挑出来
import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:6821';
const PWD = 'test1234';

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.77' }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1100);
}

const probe = async (label) => {
  const rows = await page.evaluate(() => {
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(',').map((x) => parseFloat(x));
      return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
    };
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const sides = [
        ['top', cs.borderTopWidth, cs.borderTopColor, cs.borderTopStyle],
        ['right', cs.borderRightWidth, cs.borderRightColor, cs.borderRightStyle],
        ['bottom', cs.borderBottomWidth, cs.borderBottomColor, cs.borderBottomStyle],
        ['left', cs.borderLeftWidth, cs.borderLeftColor, cs.borderLeftStyle],
      ];
      for (const [s, w, c, st] of sides) {
        const px = parseFloat(w);
        if (!px || st === 'none' || st === 'hidden') continue;
        const col = parse(c);
        if (!col || col.a < 0.5) continue;
        // 亮度 < 100 视为"黑边"
        const lum = 0.299 * col.r + 0.587 * col.g + 0.114 * col.b;
        if (lum > 105) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        out.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().slice(0, 70),
          id: el.id || '',
          side: s,
          w: px,
          color: c,
          lum: Math.round(lum),
          box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          text: (el.textContent || '').trim().slice(0, 24),
        });
      }
    }
    return out;
  });
  console.log('\n===== ' + label + ' (' + rows.length + ') =====');
  for (const r of rows) {
    console.log(`${r.tag}${r.id ? '#' + r.id : ''}.${r.cls} | ${r.side} ${r.w}px ${r.color} lum${r.lum} | ${r.box.join(',')} | ${r.text}`);
  }
};

const pages = ['dashboard', 'channels', 'models', 'logs', 'plaza', 'tokens', 'settings', 'chat'];
for (const p of pages) {
  await page.goto(BASE + '/#/' + p, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await probe(p);
}

await browser.close();
