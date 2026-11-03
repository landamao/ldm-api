// 量列表页（模型 / 渠道 / 日志 / 令牌）底部留白：卡片底边到窗口底边差多少
// 依赖：npm i playwright-core（系统 Edge 通道）
// 前置：起网关 LDMAPI_PASSWORD=test1234 -port 6821，LDMAPI_DEV=web
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';
const PAGES = (process.env.LDM_PAGES || 'models,channels,logs,tokens').split(',');
const W = Number(process.env.LDM_W || 1440);
const H = Number(process.env.LDM_H || 900);

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
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
  await page.waitForTimeout(1800);
  const info = await page.evaluate(() => {
    const content = document.querySelector('#content');
    const inner = document.querySelector('#content-inner');
    const cs = getComputedStyle(content);
    const box = (el) => {
      const b = el.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height), w: Math.round(b.width) };
    };
    const cards = [...inner.querySelectorAll(':scope > .card, :scope > * > .card')].map((el) => ({
      cls: el.className, ...box(el),
    }));
    return {
      winH: window.innerHeight,
      content: { ...box(content), padB: cs.paddingBottom, scrollH: content.scrollHeight, clientH: content.clientHeight },
      inner: { ...box(inner), cls: inner.className },
      cards,
      gapBottom: Math.round(window.innerHeight - (cards.length ? cards[cards.length - 1].bottom : inner.getBoundingClientRect().bottom)),
    };
  });
  console.log(`[${name}]`, JSON.stringify(info));
  await page.screenshot({ path: `${SHOT}/gap-${name}.png` });
}

// 令牌页底部圆角特写
await page.goto(BASE + '/#/tokens', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
const card = page.locator('#content-inner .card').last();
if (await card.count()) {
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const b = await card.boundingBox();
  if (b) {
    await page.screenshot({
      path: `${SHOT}/gap-tokens-corner.png`,
      clip: { x: b.x - 20, y: Math.max(0, b.y + b.height - 90), width: 260, height: 130 },
    });
  }
}
await browser.close();
