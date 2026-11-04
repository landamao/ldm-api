// 验证聊天里的图片：自己消息的图不再开新标签页、走灯箱；灯箱不超出屏幕
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6831';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';
fs.mkdirSync(SHOT, { recursive: true });

// 竖长图（手机上最容易撑出屏幕）当作用户上传的图片，缺了就现场生成一张
const TALL = 'D:/code/ldm-api/_test/tmp-tall.png';
if (!fs.existsSync(TALL)) {
  const b0 = await chromium.launch({ channel: 'msedge', headless: true });
  const p0 = await b0.newPage({ viewport: { width: 800, height: 2400 } });
  await p0.setContent('<body style="margin:0;background:linear-gradient(45deg,#2e7d32,#f9a825)"><div style="font:700 50px sans-serif;color:#fff;padding:40px">tall 800x2400</div></body>');
  await p0.screenshot({ path: TALL });
  await b0.close();
}
const png = fs.readFileSync(TALL).toString('base64');
const dataUrl = 'data:image/png;base64,' + png;

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

for (const vp of [{ width: 390, height: 844, label: 'mobile' }, { width: 1440, height: 900, label: 'desktop' }]) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const popups = [];
  page.on('popup', (p) => popups.push(p.url()));
  page.on('pageerror', (e) => console.log('[page error]', e.message));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  if (await page.locator('#login-pwd').count()) {
    await page.fill('#login-pwd', PWD);
    await page.click('#login-btn');
    await page.waitForTimeout(1200);
  }

  // 造一段历史：用户消息带图片 part（data URL），助手消息里放 markdown 图片
  await page.evaluate((img) => {
    const now = Date.now();
    localStorage.setItem('ldmapi.chat.sessions', JSON.stringify({
      activeId: 'st1',
      sessions: [{
        id: 'st1', title: '图片测试', createdAt: now, updatedAt: now, model: '',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: '看这张图' }, { type: 'image_url', image_url: { url: img } }],
            display: [{ type: 'text', text: '看这张图' }, { type: 'image_url', image_url: { url: img } }],
          },
          {
            role: 'assistant',
            content: '这是回复里的图：\n\n![示例](http://127.0.0.1:6831/assets/logo.jpg)',
            display: '这是回复里的图：\n\n![示例](http://127.0.0.1:6831/assets/logo.jpg)',
          },
        ],
      }],
    }));
  }, dataUrl);

  await page.goto(BASE + '/#/chat', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);

  const dom = await page.evaluate(() => ({
    userImg: document.querySelectorAll('.msg--user .msg__image').length,
    linkWrapped: document.querySelectorAll('.msg__image-link, .msg--user a.msg__image').length,
    anchorParent: !!document.querySelector('.msg--user .msg__image')?.closest('a'),
    mdImg: document.querySelectorAll('.msg__answer--md img').length,
  }));
  check(`${vp.label}: 用户图片渲染为 .msg__image`, dom.userImg === 1, JSON.stringify(dom));
  check(`${vp.label}: 用户图片不再被 <a> 包裹`, dom.linkWrapped === 0 && dom.anchorParent === false);
  check(`${vp.label}: 助手 markdown 图片正常`, dom.mdImg >= 1);

  const lightboxState = async () => page.evaluate(() => {
    const lb = document.querySelector('.img-lightbox');
    const img = lb && lb.querySelector('img');
    if (!lb || !lb.classList.contains('is-open') || !img || !img.getBoundingClientRect().width) {
      return { open: false };
    }
    const s = img.getBoundingClientRect();
    return {
      open: true,
      img: { w: +s.width.toFixed(1), h: +s.height.toFixed(1) },
      over: {
        right: +(s.x + s.width - innerWidth).toFixed(1),
        bottom: +(s.y + s.height - innerHeight).toFixed(1),
        left: +s.x.toFixed(1), top: +s.y.toFixed(1),
      },
      locked: getComputedStyle(document.querySelector('.img-lightbox')).touchAction,
    };
  });

  // 点自己消息的图片
  await page.locator('.msg--user .msg__image').first().click();
  await page.waitForTimeout(350);
  let st = await lightboxState();
  check(`${vp.label}: 点自己的图打开灯箱`, st.open === true, JSON.stringify(st));
  const inView = st.open && st.over.right <= 0 && st.over.bottom <= 0 && st.over.left >= 0 && st.over.top >= 0;
  check(`${vp.label}: 灯箱不超出视口（竖长图）`, inView, JSON.stringify(st.over));
  check(`${vp.label}: 灯箱接管手势（touch-action）`, st.open && st.locked === 'none', String(st.locked));
  check(`${vp.label}: 没有弹出新标签页`, popups.length === 0, JSON.stringify(popups));
  await page.screenshot({ path: `${SHOT}/chat-img-${vp.label}-user.png` });

  // 关闭
  await page.mouse.click(Math.round(vp.width / 2), 20);
  await page.waitForTimeout(320);
  check(`${vp.label}: 点空白处可关闭`, (await lightboxState()).open === false);

  // 点助手 markdown 图片
  await page.locator('.msg__answer--md img').first().click();
  await page.waitForTimeout(350);
  st = await lightboxState();
  check(`${vp.label}: 点助手的图打开灯箱`, st.open === true, JSON.stringify(st));
  check(`${vp.label}: 助手图灯箱不超出视口`,
    st.open && st.over.right <= 0 && st.over.bottom <= 0 && st.over.left >= 0 && st.over.top >= 0,
    JSON.stringify(st.over));
  await page.screenshot({ path: `${SHOT}/chat-img-${vp.label}-assistant.png` });

  // 滚轮落在灯箱上时不该穿透去滚消息列表
  const wheelBlocked = await page.evaluate(async () => {
    const log = document.getElementById('chat-log');
    log.scrollTop = 40;
    const before = log.scrollTop;
    const lb = document.querySelector('.img-lightbox');
    const r = lb.getBoundingClientRect();
    lb.dispatchEvent(new WheelEvent('wheel', {
      deltaY: 400, bubbles: true, cancelable: true,
      clientX: r.width / 2, clientY: r.height / 2,
    }));
    await new Promise((res) => setTimeout(res, 120));
    const after = log.scrollTop;
    log.scrollTop = log.scrollHeight;
    return { before, after };
  });
  check(`${vp.label}: 灯箱内滚轮不穿透到消息列表`, wheelBlocked.before === wheelBlocked.after,
    JSON.stringify(wheelBlocked));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(320);
  const afterEsc = await page.evaluate(() => ({
    open: document.querySelector('.img-lightbox').classList.contains('is-open'),
  }));
  check(`${vp.label}: Esc 关闭灯箱`, afterEsc.open === false, JSON.stringify(afterEsc));

  check(`${vp.label}: 全程没有新标签页`, popups.length === 0, JSON.stringify(popups));
  await ctx.close();
}

console.log(fail ? `\nFAIL ${fail} 项` : '\n全部通过');
await browser.close();
process.exit(fail ? 1 : 0);
