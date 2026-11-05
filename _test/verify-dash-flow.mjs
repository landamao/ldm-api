// 看板交互回归：切区间 / 切口径 / 点图例 / 切单位 / 刷新，每步都检查图表真的重画了
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(500);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', 'test1234');
  await page.click('#login-btn');
  await page.waitForTimeout(1200);
}
await page.goto(BASE + '/#/dashboard', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800);

const snap = () => page.evaluate(() => {
  const line = document.querySelector('#trend-chart path.line');
  const arc = document.querySelector('#model-donut circle.donut-arc');
  return {
    lines: document.querySelectorAll('#trend-chart path.line').length,
    dots: document.querySelectorAll('#trend-chart circle.dot').length,
    arcs: document.querySelectorAll('#model-donut circle.donut-arc').length,
    legend: document.querySelectorAll('#model-legend .chart-legend__item').length,
    rank: document.querySelectorAll('#channel-rank .rank-item').length,
    req: (document.querySelector('#card-req .stat__value') || {}).textContent || '',
    sub: (document.querySelector('#trend-sub') || {}).textContent || '',
    lineDash: line ? getComputedStyle(line).strokeDashoffset : '-',
    arcDash: arc ? getComputedStyle(arc).strokeDasharray : '-',
    donutTotal: (document.querySelector('#model-donut .donut-total') || {}).textContent || '',
  };
});

const step = async (name, fn, wait = 1400) => {
  await fn();
  await page.waitForTimeout(wait);
  const s = await snap();
  console.log(`${name.padEnd(16)} lines=${s.lines} dots=${s.dots} arcs=${s.arcs} legend=${s.legend} rank=${s.rank} 值=${s.req.trim()} 环=${s.donutTotal}`);
  console.log(`   曲线 dashoffset=${s.lineDash} 弧 dasharray=${s.arcDash}`);
  return s;
};

await step('初始 今日', async () => {});

await step('切全部时间', async () => {
  await page.evaluate(() => {
    const s = document.querySelector('#dash-preset');
    s.value = 'all'; s.dispatchEvent(new Event('change', { bubbles: true }));
  });
});

await step('点总计', async () => {
  await page.click('#model-legend [data-sel="total"]');
});

await step('点单模型', async () => {
  await page.click('#model-legend .chart-legend__btn[data-sel]:not([data-sel="all"]):not([data-sel="total"])');
}, 1200);

await step('切 Token 口径', async () => {
  await page.click('#metric-toggle button[data-m="tokens"]');
});

await step('切回请求数', async () => {
  await page.click('#metric-toggle button[data-m="requests"]');
});

await step('切中文单位', async () => {
  await page.evaluate(() => {
    const s = document.querySelector('#dash-unit');
    s.value = 'cn'; s.dispatchEvent(new Event('change', { bubbles: true }));
  });
}, 600);

await step('改近7天', async () => {
  await page.evaluate(() => {
    const s = document.querySelector('#dash-preset');
    s.value = '7d'; s.dispatchEvent(new Event('change', { bubbles: true }));
  });
});

await step('点刷新', async () => {
  await page.click('#btn-refresh');
});

// 动画结束后不该残留内联 dash 样式（残留会让曲线只剩一部分）
await page.waitForTimeout(1800);
const rest = await snap();
console.log(`动画收尾后: 曲线 dashoffset=${rest.lineDash} 弧 dasharray=${rest.arcDash}`);
console.log(errors.length ? '页面报错: ' + errors.join(' | ') : '无页面报错');
await browser.close();
