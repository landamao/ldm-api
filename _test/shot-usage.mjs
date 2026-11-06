// 用量分析页截图：渠道 / 模型两个视图 + 深色 + 手机
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });

async function open(w, h, theme) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.77' },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  if (await page.locator('#login-pwd').count()) {
    await page.fill('#login-pwd', PWD);
    await page.click('#login-btn');
    await page.waitForTimeout(1100);
  }
  if (theme === 'dark') {
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
      try { localStorage.setItem('ldmapi.theme', 'dark'); } catch (e) {}
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
  }
  return { ctx, page };
}

const shot = async (page, name) => {
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `${SHOT}/usage-${name}.png`, fullPage: true });
  console.log('saved', name);
};

{
  const { ctx, page } = await open(1440, 900, 'light');
  await page.goto(BASE + '/#/usage', { waitUntil: 'domcontentloaded' });
  await shot(page, 'channel');
  // 明细切到「按请求模型」，看渠道模型 / 自定义模型的拆分
  await page.click('#u-table-mode button[data-m="caller"]');
  await shot(page, 'caller');
  await page.click('#u-table-mode button[data-m="main"]');
  // 切到模型视图
  await page.click('#usage-tab button[data-tab="model"]');
  await shot(page, 'model');
  await ctx.close();
}

{
  const { ctx, page } = await open(1440, 900, 'dark');
  await page.goto(BASE + '/#/usage', { waitUntil: 'domcontentloaded' });
  await shot(page, 'dark');
  await ctx.close();
}

{
  const { ctx, page } = await open(1200, 820, 'light');
  await page.goto(BASE + '/#/usage', { waitUntil: 'domcontentloaded' });
  await shot(page, 'tablet');
  await ctx.close();
}

{
  const { ctx, page } = await open(390, 844, 'light');
  await page.goto(BASE + '/#/usage', { waitUntil: 'domcontentloaded' });
  await shot(page, 'mobile');
  await ctx.close();
}

await browser.close();
console.log('done');
