// 回归测试：浅色主题下不应再出现"看着像黑边"的深棕描边。
// 判据：元素任意一边的描边颜色等于 --outline（墨线色），且不是已知的装饰性用途白名单。
// 覆盖 8 个页面 + 添加渠道 / 渠道测试 / 添加模型 / 提供商 四个弹窗。
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';

// 这些位置的墨线是有意的：木头牌面内部的分隔线（深底上不显黑）、开关轨道（形状靠这圈线定义）、
// 图表里的隐藏提示框（页面上看不见）
const ALLOW = [/chart-tip/, /switch__track/, /modal__head/, /drawer__head/];

const rgb = (s) => {
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(',').map((x) => parseFloat(x));
  return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
};
const hex = (s) => {
  const m = s.trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
};
const near = (c, t, tol = 6) => c && t && Math.abs(c.r - t.r) <= tol && Math.abs(c.g - t.g) <= tol && Math.abs(c.b - t.b) <= tol;

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.88' } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1100);
}
await page.evaluate(() => {
  document.documentElement.setAttribute('data-theme', 'light');
  try { localStorage.setItem('ldmapi.theme', 'light'); } catch (e) {}
});

const scan = async () => page.evaluate(() => {
  const ink = getComputedStyle(document.documentElement).getPropertyValue('--outline').trim();
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    // 按边取 [宽度, 颜色, 线型]：描边色里带空格（rgb(74, 49, 32)），不能拼成字符串再 split
    const sides = [
      [cs.borderTopWidth, cs.borderTopColor, cs.borderTopStyle],
      [cs.borderRightWidth, cs.borderRightColor, cs.borderRightStyle],
      [cs.borderBottomWidth, cs.borderBottomColor, cs.borderBottomStyle],
      [cs.borderLeftWidth, cs.borderLeftColor, cs.borderLeftStyle],
    ];
    for (const [w, color, style] of sides) {
      if (!parseFloat(w) || style === 'none' || style === 'hidden') continue;
      out.push({ cls: (el.className || '').toString() + ' ' + (el.id || ''), color });
    }
  }
  return { ink, hits: out };
});

const fails = [];
const check = async (label) => {
  const { ink, hits } = await scan();
  const inkC = hex(ink);
  const bad = hits.filter((h) => near(rgb(h.color), inkC) && !ALLOW.some((re) => re.test(h.cls)));
  if (bad.length) {
    const uniq = [...new Set(bad.map((b) => `${b.cls.trim() || '(无类名)'} ${b.color}`))];
    fails.push(label + ':\n  ' + uniq.join('\n  '));
    console.log('FAIL', label, bad.length, '处墨线描边');
  } else {
    console.log('PASS', label, '没有墨线描边');
  }
};

const pages = ['dashboard', 'channels', 'models', 'logs', 'plaza', 'tokens', 'settings', 'chat'];
for (const p of pages) {
  await page.goto(BASE + '/#/' + p, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  await check(p);
}

// 弹窗逐个查：添加渠道 / 渠道测试 / 添加模型 / 提供商
const openModal = async (hash, action, name, wait = 900) => {
  await page.goto(BASE + '/#/' + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await action();
  await page.waitForTimeout(wait);
  if (!(await page.locator('.modal').count())) {
    fails.push(name + ': 弹窗没打开');
    console.log('FAIL', name, '弹窗没打开');
    return;
  }
  await check(name);
  await page.locator('.modal__close').first().click().catch(() => {});
  await page.waitForTimeout(400);
};

await openModal('channels', () => page.click('#btn-add-channel'), '弹窗-添加渠道');
await openModal('channels', () => page.locator('.channels-card tbody tr').first().locator('button', { hasText: '测试' }).first().click(), '弹窗-渠道测试', 1200);
await openModal('models', () => page.click('#btn-add-model'), '弹窗-添加模型');
await openModal('models', () => page.click('#btn-providers'), '弹窗-提供商', 1200);

await browser.close();

console.log('\n================ 汇总 ================');
if (fails.length) {
  console.log(fails.join('\n\n'));
  console.log('\n仍有看着像黑边的墨线描边，检查上面的元素。');
  process.exit(1);
}
console.log('全部通过：浅色主题下没有墨线描边（开关轨道等装饰性墨线已白名单）');
