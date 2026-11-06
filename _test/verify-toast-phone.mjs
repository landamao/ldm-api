// 手机端 Toast 宽度回归：短提示不该被拉到整屏宽，长提示最多占满可用宽度
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';
const W = Number(process.env.LDM_W || 390);
const H = Number(process.env.LDM_H || 880);

// 只验手机断点（<=900px）：桌面是右上角 20px、最大 470px 的既有布局
if (W >= 900) {
  console.log('跳过：本脚本只验手机视口（LDM_W < 900）');
  process.exit(0);
}

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.77' },
});
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1400);
}

const measure = async (label, title, msg) => {
  await page.evaluate(([t, m]) => window.LDM.Toast.success(m, t), [title, msg]);
  await page.waitForTimeout(350);
  const box = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.toast')].pop();
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth };
  });
  console.log(label, JSON.stringify(box));
  return box;
};

const short = await measure('short ', '操作成功', '模型已复制');
await page.screenshot({ path: `${SHOT}/toast-phone-short.png` });
await page.waitForTimeout(3200);

const longMsg = '调用失败：upstream returned 429 too many requests, please retry later — model=gpt-4o-mini channel=openrouter-main';
const long = await measure('long  ', '测试连通性失败', longMsg);
await page.screenshot({ path: `${SHOT}/toast-phone-long.png` });

await browser.close();

const gap = 12;
const fails = [];
if (short.w > W - gap * 2) fails.push(`短提示仍被拉满：${short.w}px / 可用 ${W - gap * 2}px`);
if (Math.abs(W - gap - short.right) > 2) fails.push(`短提示没有贴右：right=${short.right}`);
if (long.w > W - gap * 2 + 1) fails.push(`长提示溢出可用宽度：${long.w}px`);
if (long.left < gap - 2) fails.push(`长提示左侧越界：left=${long.left}`);
console.log(fails.length ? 'FAIL: ' + fails.join(' | ') : 'PASS');
process.exit(fails.length ? 1 : 0);
