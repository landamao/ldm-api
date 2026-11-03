// 调用日志页：筛选搬进顶栏后，各宽度下顶栏是否溢出木牌、表格卡是否撑满
// 依赖：npm i playwright-core（系统 Edge 通道）
// 前置：起网关 LDMAPI_PASSWORD=test1234 -port 6821，LDMAPI_DEV=web
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';
const WIDTHS = (process.env.LDM_WIDTHS || '1920,1440,1280,1100,900,420').split(',').map(Number);

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1400);
}
await page.goto(BASE + '/#/logs', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);

for (const w of WIDTHS) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(500);
  const info = await page.evaluate(() => {
    const bar = document.querySelector('.topbar');
    const f = document.getElementById('topbar-filters');
    const act = document.getElementById('topbar-actions');
    const content = document.getElementById('content');
    const cards = [...document.querySelectorAll('#content-inner .card')];
    const box = (el) => { const b = el.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), h: Math.round(b.height) }; };
    const fb = box(f);
    const bb = box(bar);
    return {
      barH: bb.h,
      filtersW: Math.round(f.getBoundingClientRect().width),
      filtersScrollW: f.scrollWidth,
      filtersClipped: f.scrollWidth > f.clientWidth + 1,
      // 筛选块是否戳出木牌右边界
      overflowRight: Math.round(fb.r - bb.r),
      cards: cards.map((c) => ({ cls: c.className, h: Math.round(c.getBoundingClientRect().height) })),
      gapBottom: Math.round(window.innerHeight - (cards.length ? cards[cards.length - 1].getBoundingClientRect().bottom : 0)),
      actionsSameRow: Math.abs(box(act).t - box(document.querySelector('#page-title')).t) < 30,
    };
  });
  console.log(`[${w}]`, JSON.stringify(info));
  await page.screenshot({ path: `${SHOT}/logs-top-${w}.png` });
}

await browser.close();
