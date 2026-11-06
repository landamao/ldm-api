// 站点副标题：浏览器标题 + 侧边栏品牌牌匾，留空则不显示
// 前置：LDMAPI_DEV=web LDMAPI_PASSWORD=test1234 ./dist/ldmapi-windows-amd64.exe -port 6821 -data _test/tmp-brand-data
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';
const NAME = '懒大猫 API · 演示环境';
const SUB = '一次生成的全场景示例数据';

const fails = [];
const ok = (cond, msg) => {
  if (!cond) fails.push(msg);
  console.log((cond ? '  ok   ' : '  FAIL ') + msg);
};

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  // 换一个限流 key，否则连跑几次登录就被拦
  extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.77' },
});
const page = await ctx.newPage();
page.on('pageerror', (e) => fails.push('page error: ' + e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1300);
}

// ---- 1. 有副标题：标题 + 牌匾 ----
ok((await page.title()) === `${NAME} · ${SUB}`, `浏览器标题带上副标题：${await page.title()}`);

const stub = await page.evaluate(() => {
  const el = document.getElementById('brand-sub');
  return {
    text: el ? el.textContent.trim() : null,
    visible: !!el && !!el.offsetParent,
    clipped: !!el && el.scrollWidth > el.clientWidth + 1,
    tip: el ? el.getAttribute('data-tip') : null,
    tabIndex: el ? el.tabIndex : null,
    box: el ? el.getBoundingClientRect().height : 0,
  };
});
ok(stub.text === SUB, `牌匾副标题文本：${stub.text}`);
ok(stub.visible && stub.box > 8, `副标题可见且有高度（${stub.box.toFixed(1)}px）`);
ok(stub.clipped, '长副标题确实被省略号截断');
ok(stub.tip === SUB, `截断后挂了完整文本气泡：${stub.tip}`);
ok(stub.tabIndex === 0, '截断后能 Tab 到（tabIndex=0）');

// 站点名称本身太长时也一起挂气泡（同一个牌匾里两行都可能被截断）
const nm = await page.evaluate(() => {
  const el = document.getElementById('brand-name');
  return { clipped: el.scrollWidth > el.clientWidth + 1, tip: el.getAttribute('data-tip') };
});
ok(nm.clipped && nm.tip === NAME, `名称截断也挂气泡：${nm.tip}`);

// 牌匾整体尺寸：加一行小字不该把 logo / GitHub 挤歪
const brand = await page.locator('.sidebar__brand').boundingBox();
await page.screenshot({
  path: `${SHOT}/brand-sub-on.png`,
  clip: { x: brand.x - 6, y: brand.y - 6, width: brand.width + 12, height: brand.height + 12 },
});
console.log('  截图', `${SHOT}/brand-sub-on.png`, `牌匾 ${brand.width}x${brand.height}`);

// ---- 2. 悬停弹出完整副标题 ----
await page.locator('#brand-sub').hover();
await page.waitForTimeout(450);
const tipText = await page.evaluate(() => {
  const el = document.querySelector('.chart-tip.is-on');
  return el ? el.textContent.trim() : null;
});
ok(tipText === SUB, `悬停气泡显示完整副标题：${tipText}`);
if (tipText) {
  await page.screenshot({
    path: `${SHOT}/brand-sub-tip.png`,
    clip: { x: brand.x - 6, y: brand.y - 6, width: brand.width + 300, height: brand.height + 90 },
  });
}
await page.mouse.move(900, 700);

// ---- 3. 设置页清空副标题：不用刷新就消失 ----
await page.goto(BASE + '/#/settings', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
await page.fill('#s-sub', '');
await page.click('#s-save');
await page.waitForTimeout(800);

const blank = await page.evaluate(() => {
  const el = document.getElementById('brand-sub');
  return {
    hidden: el.hidden,
    occupies: !!el.offsetParent,
    title: document.title,
    tip: el.getAttribute('data-tip'),
    clip: el.classList.contains('chart-name--clip'),
  };
});
ok(blank.hidden && !blank.occupies, '留空后整行不占位');
ok(blank.title === NAME, `留空后标题只剩站点名称（不兜底）：${blank.title}`);
ok(!blank.tip && !blank.clip, '留空后气泡痕迹一并清掉');

const brandBlank = await page.locator('.sidebar__brand').boundingBox();
await page.screenshot({
  path: `${SHOT}/brand-sub-off.png`,
  clip: { x: brandBlank.x - 6, y: brandBlank.y - 6, width: brandBlank.width + 12, height: brandBlank.height + 12 },
});
ok(brandBlank.height < brand.height - 6, `留空后牌匾变矮（${brand.height} → ${brandBlank.height}）`);

// ---- 4. 刷新后仍然留空（落库了） ----
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1100);
const afterReload = await page.evaluate(() => ({
  hidden: document.getElementById('brand-sub').hidden,
  title: document.title,
}));
ok(afterReload.hidden, '刷新后副标题仍是空的');

// ---- 5. 填回去：立刻出现，气泡重新挂上 ----
await page.goto(BASE + '/#/settings', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
await page.fill('#s-sub', SUB);
await page.click('#s-save');
await page.waitForTimeout(800);
const back = await page.evaluate(() => {
  const el = document.getElementById('brand-sub');
  return {
    text: el.textContent.trim(),
    visible: !!el.offsetParent,
    tip: el.getAttribute('data-tip'),
    title: document.title,
  };
});
ok(back.visible && back.text === SUB, '填回后立刻显示');
ok(back.title === `${NAME} · ${SUB}`, '填回后标题跟着变');
ok(back.tip === SUB, '填回后气泡重新挂上');

await browser.close();
console.log(fails.length ? `\n失败 ${fails.length} 项：\n- ` + fails.join('\n- ') : '\n全部通过');
process.exit(fails.length ? 1 : 0);
