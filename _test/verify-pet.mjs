/*
 * 看板娘挂件（pet.js）验证
 * 前置：
 *   LDMAPI_DEV=web LDMAPI_PASSWORD=test1234 ./dist/ldmapi-windows-amd64.exe -port 6821 -data ./_test/tmpdata-pet
 * 挂件走外链（pet.alcy.cc），本机需要能出网，Edge 走 7897 代理。
 */
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PWD || 'test1234';
const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};
const overlap = (a, b) =>
  !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  proxy: { server: 'http://127.0.0.1:7897' },
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const warns = [];
page.on('console', (m) => { if (/ldmapi/.test(m.text())) warns.push(m.text()); });

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#login-pwd', { timeout: 15000 });
await page.waitForTimeout(1500);
check('登录页不显示挂件', (await page.locator('.dsh-pet-root').count()) === 0);

await page.fill('#login-pwd', PWD);
await page.click('#login-btn');
await page.waitForSelector('.shell', { timeout: 20000 });
await page.waitForSelector('.dsh-pet-root', { timeout: 40000 });
await page.waitForTimeout(3000);

const box = await page.evaluate(() => {
  const root = document.querySelector('.dsh-pet-root');
  const v = root.querySelector('video.is-front');
  const r = root.getBoundingClientRect();
  return {
    parent: root.parentElement.tagName,
    z: getComputedStyle(root).zIndex,
    right: Math.round(window.innerWidth - r.right),
    bottom: Math.round(window.innerHeight - r.bottom),
    w: Math.round(r.width),
    videoReady: v && v.readyState >= 2,
    src: v ? decodeURIComponent(v.currentSrc) : '',
  };
});
check('挂在 body 上（不受 #app 层叠上下文限制）', box.parent === 'BODY', box.parent);
check('层级高于弹窗/Toast', Number(box.z) > 400, 'z=' + box.z);
check('右下角贴边', box.right >= 0 && box.right <= 30 && box.bottom <= 16, `right=${box.right} bottom=${box.bottom}`);
check('动画已加载', !!box.videoReady, box.src.split('/').pop());

const bubble = await page.evaluate(() => {
  const el = document.querySelector('.dsh-pet-bubble');
  return el ? { on: el.classList.contains('is-on'), text: el.textContent } : null;
});
check('欢迎气泡出现', !!bubble && bubble.on, bubble && bubble.text);
await page.screenshot({ path: 'shots/pet-dashboard.png' });

// 聊天页：不仅要显示，还不能压住发送按钮
await page.click('a[href="#/chat"]');
await page.waitForTimeout(2500);
check('聊天页显示挂件', (await page.locator('.dsh-pet-root').isVisible()));
await page.waitForSelector('#chat-send', { timeout: 8000 });
const petBox = await page.locator('.dsh-pet-root').boundingBox();
const sendBox = await page.locator('#chat-send').boundingBox();
check('聊天页不压住发送按钮', !overlap(petBox, sendBox),
  `pet=${Math.round(petBox.y)}..${Math.round(petBox.y + petBox.height)} send=${Math.round(sendBox.y)}..${Math.round(sendBox.y + sendBox.height)}`);
await page.screenshot({ path: 'shots/pet-chat.png' });

// 输入区变高（多行输入 / 附件预览）后要跟着重新摆位
await page.evaluate(() => {
  const c = document.querySelector('.chat-compose');
  if (c) c.style.minHeight = Math.round(c.getBoundingClientRect().height + 60) + 'px';
});
await page.waitForTimeout(700);
const petBox2 = await page.locator('.dsh-pet-root').boundingBox();
const sendBox2 = await page.locator('#chat-send').boundingBox();
check('输入框长高后仍不压按钮', !overlap(petBox2, sendBox2),
  `pet=${Math.round(petBox2.y)}..${Math.round(petBox2.y + petBox2.height)} send=${Math.round(sendBox2.y)}..${Math.round(sendBox2.y + sendBox2.height)}`);

// 弹窗：挂件仍可见且在最上层，但鼠标事件穿透，点不到它
await page.click('a[href="#/channels"]');
await page.waitForTimeout(1200);
await page.click('#btn-add-channel');
await page.waitForSelector('.modal-backdrop', { timeout: 8000 });
await page.waitForTimeout(700);
const modal = await page.evaluate(() => {
  const pet = document.querySelector('.dsh-pet-root');
  const r = pet.getBoundingClientRect();
  const pt = { x: Math.round(r.x + r.width * 0.65), y: Math.round(r.y + r.height * 0.5) };
  const el = document.elementFromPoint(pt.x, pt.y);
  return {
    visible: !!pet && getComputedStyle(pet).display !== 'none',
    topAtPet: el ? (el.className || el.tagName) : null,
    hitIsPet: !!(el && el.closest('.dsh-pet-root')),
  };
});
check('弹窗打开时挂件仍可见', modal.visible);
check('弹窗打开时仍可点（不穿透）', modal.hitIsPet, String(modal.topAtPet));

// 弹窗开着也要能拖出去玩
const beforeDrag = await page.locator('.dsh-pet-root').boundingBox();
await page.mouse.move(beforeDrag.x + beforeDrag.width * 0.65, beforeDrag.y + beforeDrag.height * 0.5);
await page.mouse.down();
await page.mouse.move(beforeDrag.x - 120, beforeDrag.y - 80, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(800);
const afterDrag = await page.locator('.dsh-pet-root').boundingBox();
check('弹窗打开时仍能拖拽', Math.abs(afterDrag.x - beforeDrag.x) > 20 || Math.abs(afterDrag.y - beforeDrag.y) > 20,
  `dx=${Math.round(afterDrag.x - beforeDrag.x)} dy=${Math.round(afterDrag.y - beforeDrag.y)}`);
await page.screenshot({ path: 'shots/pet-modal-drag.png' });
await page.keyboard.press('Escape');
await page.waitForTimeout(700);

// 窄屏自动隐藏
await page.setViewportSize({ width: 720, height: 900 });
await page.waitForTimeout(800);
check('窄屏自动隐藏', !(await page.locator('.dsh-pet-root').isVisible()));

if (warns.length) console.log('--- 控制台 warn ---\n' + warns.join('\n'));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} 通过`);
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
