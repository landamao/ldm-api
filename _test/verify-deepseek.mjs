// 桌面端：DeepSeek 式三栏（对话列表 / 对话区 / 模型配置）
// 1) 顶栏已隐藏  2) 左右两栏各自往自己那边收起  3) 对话列表可新建 / 切换 / 删除
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 940 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('  [页面错误]', m.text()); });
page.on('pageerror', (e) => console.log('  [JS 异常]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1200);
}
await page.goto(BASE + '/#/chat', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

const state = () => page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const box = (s) => { const e = q(s); return e ? e.getBoundingClientRect() : null; };
  const layout = q('#chat-layout');
  const cls = layout ? layout.className : '';
  return {
    topbarHidden: !q('.topbar') || getComputedStyle(q('.topbar')).display === 'none',
    convLeft: box('#chat-conv') && Math.round(box('#chat-conv').left),
    convWidth: box('#chat-conv') && Math.round(box('#chat-conv').width),
    sideLeft: box('#chat-side') && Math.round(box('#chat-side').left),
    sideWidth: box('#chat-side') && Math.round(box('#chat-side').width),
    mainLeft: box('.chat-main') && Math.round(box('.chat-main').left),
    mainRight: box('.chat-main') && Math.round(box('.chat-main').right),
    convCollapsed: cls.includes('is-conv-collapsed'),
    sideCollapsed: cls.includes('is-settings-collapsed'),
    convItems: document.querySelectorAll('.chat-conv__item').length,
    convOpenVisible: !q('#chat-conv-open').hidden,
    sideOpenVisible: !q('#chat-side-open').hidden,
    chipModel: !!q('#chat-chip-model'),
    chipStream: !!q('#chat-chip-stream'),
    chatTopGone: !q('#chat-top'),
  };
});

console.log('[初始]', JSON.stringify(await state()));
await page.screenshot({ path: 'D:/code/ldm-api/_test/shots/10-deepseek-layout.png' });

// 收起左侧对话列表 → 应该往左让位
await page.click('#chat-conv-collapse');
await page.waitForTimeout(600);
console.log('[收起左栏]', JSON.stringify(await state()));
await page.screenshot({ path: 'D:/code/ldm-api/_test/shots/11-conv-collapsed.png' });

// 收起右侧模型配置 → 应该往右让位
await page.click('#chat-side-close');
await page.waitForTimeout(600);
console.log('[两侧都收起]', JSON.stringify(await state()));
await page.screenshot({ path: 'D:/code/ldm-api/_test/shots/12-both-collapsed.png' });

// 用边缘把手分别拉回来
await page.click('#chat-conv-open');
await page.waitForTimeout(500);
await page.click('#chat-side-open');
await page.waitForTimeout(600);
console.log('[把手拉回]', JSON.stringify(await state()));
await page.screenshot({ path: 'D:/code/ldm-api/_test/shots/13-both-restored.png' });

// 新建对话 → 左侧列表多一条
const before = await page.locator('.chat-conv__item').count();
await page.click('#chat-conv-new');
await page.waitForTimeout(500);
const after = await page.locator('.chat-conv__item').count();
console.log(`[新建对话] ${before} -> ${after} 条`);

// 发一条消息，看标题是否自动生成
await page.fill('#chat-text', '测试一下对话列表的标题');
await page.press('#chat-text', 'Enter');
await page.waitForTimeout(1200);
const titles = await page.locator('.chat-conv__title').allTextContents();
console.log('[会话标题]', JSON.stringify(titles));
await page.screenshot({ path: 'D:/code/ldm-api/_test/shots/14-conv-list.png' });

// 切到第一条会话，看消息区是否跟着换
if (after >= 2) {
  await page.locator('.chat-conv__item').first().click();
  await page.waitForTimeout(600);
  console.log('[切回第一条]', JSON.stringify(await state()));
}

await browser.close();
