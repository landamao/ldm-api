// 验证列表页（看板 / 广场 / 模型 / 渠道 / 日志）的顶栏与贴底布局
// 依赖：npm i playwright-core（系统 Edge 通道）
// 前置：起网关 LDMAPI_PASSWORD=test1234 -port 6821，LDMAPI_DEV=web
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';
const PAGES = (process.env.LDM_PAGES || 'dashboard,plaza,models,channels,logs').split(',');
const WIDTH = Number(process.env.LDM_W || 1440);
const HEIGHT = Number(process.env.LDM_H || 900);

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1400);
}

for (const name of PAGES) {
  await page.goto(BASE + '/#/' + name, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  const info = await page.evaluate(() => {
    const bar = document.querySelector('#topbar-actions');
    const inner = document.querySelector('#content-inner');
    const content = document.querySelector('#content');
    const r = (el) => (el ? el.getBoundingClientRect() : null);
    const barBox = r(bar);
    const innerBox = r(inner);
    const contentBox = r(content);
    const kids = [...(inner ? inner.children : [])].map((el) => {
      const b = el.getBoundingClientRect();
      return { cls: el.className, top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) };
    });
    return {
      barRows: bar ? new Set([...bar.children].map((c) => Math.round(c.getBoundingClientRect().top))).size : 0,
      barH: barBox ? Math.round(barBox.height) : 0,
      barClipped: bar ? bar.scrollWidth > bar.clientWidth + 1 : false,
      topbar: (() => { const b = r(document.querySelector('.topbar')); return b ? { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) } : null; })(),
      contentBottom: contentBox ? Math.round(contentBox.bottom) : 0,
      innerBottom: innerBox ? Math.round(innerBox.bottom) : 0,
      docScroll: document.documentElement.scrollHeight - window.innerHeight,
      kids,
      winH: window.innerHeight,
    };
  });
  console.log('[' + name + ']', JSON.stringify(info));
  await page.screenshot({ path: `${SHOT}/pages-${name}-${WIDTH}.png`, fullPage: false });
}

await browser.close();
console.log('done');
