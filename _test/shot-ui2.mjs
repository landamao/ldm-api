// 手机 / 桌面各截一张：中间的对话区是不是实底、两侧是不是卡片、手机上顶栏有没有汉堡
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });

const seed = () => {
  const now = Date.now();
  return {
    activeId: 's1',
    sessions: [
      {
        id: 's1', title: '你好', createdAt: now - 60e3, updatedAt: now - 60e3, model: 'test',
        messages: [
          { role: 'user', content: '你好' },
          { role: 'assistant', content: '测试成功', model: 'test', meta: [['模型 test', '输入 2', '输出 6 · 75.9 t/s'], ['首字 73ms · 总耗时 152ms · 总token 8']] },
        ],
      },
      { id: 's2', title: '写个 Go 的限流中间件', createdAt: now - 3600e3, updatedAt: now - 3600e3, model: 'test', messages: [] },
    ],
  };
};

const shot = async (label, opts) => {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  if (await page.locator('#login-pwd').count()) {
    await page.fill('#login-pwd', PWD);
    await page.click('#login-btn');
    await page.waitForTimeout(1300);
  }
  await page.evaluate((data) => localStorage.setItem('ldmapi.chat.sessions', JSON.stringify(data)), seed());
  await page.goto(BASE + '/#/chat', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `${SHOT}/${label}.png`, fullPage: false });
  const info = await page.evaluate(() => {
    const card = document.querySelector('#chat-card');
    const topbar = document.querySelector('.topbar');
    return {
      cardBg: getComputedStyle(card).backgroundColor,
      topbarDisplay: topbar ? getComputedStyle(topbar).display : 'none',
      menuVisible: (() => { const b = document.querySelector('#btn-menu'); if (!b) return 'no-el'; const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })(),
      bodyScroll: document.scrollingElement.scrollHeight - innerHeight,
      convMargin: getComputedStyle(document.querySelector('#chat-conv')).margin,
      convBorder: getComputedStyle(document.querySelector('#chat-conv')).borderTopWidth,
    };
  });
  console.log(label, JSON.stringify(info));
  await ctx.close();
};

await shot('ui2-desktop', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await shot('ui2-mobile', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

await browser.close();
console.log('done');
