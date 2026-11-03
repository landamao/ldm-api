// 验证顶栏：配置栏收起时模型下拉 / 流式开关 / 展开设置按钮都在顶栏最右边
// 依赖：npm i playwright-core（用系统已装的 Edge 通道跑，不需要另外下浏览器）
// 前置：起网关 LDMAPI_PASSWORD=test1234 -port 6821
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1200);
}
await page.goto(BASE + '/#/chat', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);

const topState = () => page.evaluate(() => {
  const bar = document.querySelector('#topbar-actions');
  const top = document.querySelector('#chat-top');
  const side = document.querySelector('#chat-side');
  const toggle = document.querySelector('#chat-side-toggle');
  const sel = document.querySelector('#chat-top-model');
  const stream = document.querySelector('#chat-stream-top');
  const winW = window.innerWidth;
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) };
  };
  return {
    topHidden: top ? top.hidden : null,
    barEmptyClass: bar ? bar.classList.contains('is-empty') : null,
    sideVisible: side ? getComputedStyle(side).display !== 'none' : null,
    toggle: box(toggle),
    modelSel: box(sel),
    stream: box(stream),
    winW,
    toggleIsRightmost: toggle ? Math.round(toggle.getBoundingClientRect().right) >= winW - 60 : null,
    // 顶栏里不该再有「刷新模型」
    reloadBtn: !!document.querySelector('#chat-reload'),
  };
});

console.log('[配置栏展开]', JSON.stringify(await topState()));
await page.screenshot({ path: SHOT + '/11-top-open.png' });

// 收起配置栏
await page.click('#chat-side-close');
await page.waitForTimeout(700);
console.log('[配置栏收起]', JSON.stringify(await topState()));
await page.screenshot({ path: SHOT + '/12-top-collapsed.png' });

// 顶栏里的模型下拉能换模型（和侧栏联动）
const before = await page.evaluate(() => document.querySelector('#chat-model').value);
await page.evaluate(() => {
  const sel = document.querySelector('#chat-top-model');
  sel.value = '__test__';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(500);
const after = await page.evaluate(() => ({
  side: document.querySelector('#chat-model').value,
  triggerLabel: (document.querySelector('#chat-top-model__trigger .ldm-select__value') || {}).textContent,
}));
console.log('[顶栏换模型] 侧栏=', before, '→', JSON.stringify(after));

// 顶栏的流式开关能联动
await page.evaluate(() => {
  const input = document.querySelector('#chat-stream-top input');
  input.checked = false;
  input.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(300);
console.log('[顶栏流式开关] 侧栏同步=', await page.evaluate(() => document.querySelector('#chat-stream input').checked));

// 点顶栏的齿轮重新打开配置栏
await page.click('#chat-side-toggle');
await page.waitForTimeout(700);
console.log('[重新展开]', JSON.stringify(await topState()));
await page.screenshot({ path: SHOT + '/13-top-reopened.png' });

// 窄屏
await page.setViewportSize({ width: 700, height: 900 });
await page.waitForTimeout(700);
console.log('[窄屏]', JSON.stringify(await topState()));
await page.screenshot({ path: SHOT + '/14-top-mobile.png' });

await browser.close();
console.log('done');
