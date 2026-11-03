// 会话窗口渲染回归：
// ① 切到长会话只先画最后几条（不做整段渲染、没有载入动画）
// ② 滑到顶再补更早的一批，补完可视内容不跳
// ③ 一直往上滑能补全，且不会重复/丢消息
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6828';
const PWD = process.env.LDM_PASSWORD || 'test1234';

const seedFactory = ({ count, pad }) => {
  try {
    const body = (i) => [
      `## 第 ${i + 1} 份报告`,
      '',
      '先说结论：**懒大猫**是这个世界上最不需要理由的存在。',
      '',
      '- 第一条：躺着',
      '- 第二条：还是躺着',
      '',
      '```go',
      'func sleepy(cat string) string {',
      '\treturn cat + " 又在躺"',
      '}',
      '```',
      '',
      '| 项目 | 数值 |',
      '| --- | --- |',
      '| 睡觉 | 18h |',
      '',
      '行内 $E = mc^2$，块级：',
      '',
      '$$',
      '\\int_0^1 x^2 dx = \\frac{1}{3}',
      '$$',
      '',
      '> 摸鱼是一种生活态度。',
      '',
      pad,
    ].join('\n');
    const msgs = [];
    for (let i = 0; i < count; i += 1) {
      msgs.push({ role: 'user', content: `第 ${i + 1} 问：懒大猫今天在干嘛？`, display: `**第 ${i + 1} 问**` });
      msgs.push({ role: 'assistant', content: body(i), display: body(i), meta: [['模型 mock', '输入 1200', '输出 4300']] });
    }
    const now = Date.now();
    localStorage.setItem('ldmapi.chat.sessions', JSON.stringify({
      activeId: 'light',
      sessions: [
        { id: 'light', title: '新对话', createdAt: now, updatedAt: now, model: '', messages: [] },
        { id: 'heavy', title: '长对话测试', createdAt: now - 1000, updatedAt: now - 1000, model: '', messages: msgs },
        { id: 'heavy2', title: '长对话测试B', createdAt: now - 2000, updatedAt: now - 2000, model: '', messages: msgs.slice() },
      ],
    }));
  } catch (e) { /* about:blank 忽略 */ }
};

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });

async function scenario({ label, viewport, count, pad, shot }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: viewport.width < 500 ? 2 : 1 });
  await ctx.addInitScript(seedFactory, { count, pad });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  if (await page.locator('#login-pwd').count()) {
    await page.fill('#login-pwd', PWD);
    await page.click('#login-btn');
    await page.waitForTimeout(1100);
  }
  await page.goto(BASE + '/#/chat', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const narrow = viewport.width < 901;
  if (narrow) {
    await page.click('#chat-conv-open');
    await page.waitForTimeout(400);
  }

  // 点会话，量第一帧到出现内容的表现
  const probe = page.evaluate(async () => {
    const gaps = [];
    const longs = [];
    const t0 = performance.now();
    const obs = new PerformanceObserver((l) => l.getEntries().forEach((e) => longs.push(Math.round(e.duration))));
    obs.observe({ entryTypes: ['longtask'] });
    await new Promise((res) => {
      let last = t0;
      const tick = () => {
        const now = performance.now();
        gaps.push(Math.round(now - last));
        last = now;
        if (now - t0 < 1200) requestAnimationFrame(tick); else res();
      };
      requestAnimationFrame(tick);
    });
    obs.disconnect();
    return { worstFrames: gaps.slice().sort((a, b) => b - a).slice(0, 2), longTasks: longs };
  });
  await page.waitForTimeout(60);
  await page.click('.chat-conv__item:has-text("长对话测试")');
  console.log(label, '切会话', JSON.stringify(await probe));
  await page.waitForTimeout(250);
  const total = count * 2;
  console.log(label, '首屏', JSON.stringify(await page.evaluate(() => {
    const logEl = document.querySelector('#chat-log');
    return {
      msgs: document.querySelectorAll('#chat-log .msg').length,
      bottomGap: Math.round(logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight),
      animated: [...document.querySelectorAll('#chat-log .msg')].filter((el) => getComputedStyle(el).animationName !== 'none').length,
    };
  })));
  if (shot) await page.screenshot({ path: shot });

  // 反复滑到顶，记录每次补了几条、原来顶上那条消息是否还停在原位（= 可视内容有没有跳）
  const rounds = [];
  for (let i = 0; i < 10; i += 1) {
    const before = await page.evaluate(() => {
      const logEl = document.querySelector('#chat-log');
      window.__anchor = logEl.querySelector('.msg');
      return { msgs: logEl.querySelectorAll('.msg').length };
    });
    await page.evaluate(() => { document.querySelector('#chat-log').scrollTop = 0; });
    await page.waitForTimeout(240);
    const after = await page.evaluate(() => {
      const logEl = document.querySelector('#chat-log');
      const anchor = window.__anchor;
      // 补上去之后，原来顶上那条应该仍然贴在消息区顶部（padding-top = 16px）
      const offset = anchor && anchor.isConnected
        ? Math.round(anchor.getBoundingClientRect().top - logEl.getBoundingClientRect().top)
        : null;
      return { msgs: logEl.querySelectorAll('.msg').length, scrollTop: Math.round(logEl.scrollTop), offset };
    });
    rounds.push({ before: before.msgs, after: after.msgs, scrollTop: after.scrollTop, anchorOffset: after.offset });
    if (before.msgs === after.msgs) break;
  }
  console.log(label, '上滑补批', JSON.stringify(rounds));
  const finalCount = await page.evaluate(() => document.querySelectorAll('#chat-log .msg').length);
  console.log(label, `补全 ${finalCount}/${total}`, finalCount === total ? 'OK' : '不完整');

  // 再切一次「有内容的会话 → 有内容的会话」，这才是日常路径（没有空/满布局切换）
  const probe2 = page.evaluate(async () => {
    const gaps = [];
    const longs = [];
    const obs = new PerformanceObserver((l) => l.getEntries().forEach((e) => longs.push(Math.round(e.duration))));
    obs.observe({ entryTypes: ['longtask'] });
    const t0 = performance.now();
    await new Promise((res) => {
      let last = t0;
      const tick = () => {
        const now = performance.now();
        gaps.push(Math.round(now - last));
        last = now;
        if (now - t0 < 900) requestAnimationFrame(tick); else res();
      };
      requestAnimationFrame(tick);
    });
    obs.disconnect();
    return { worstFrames: gaps.slice().sort((a, b) => b - a).slice(0, 2), longTasks: longs };
  });
  await page.waitForTimeout(40);
  await page.click('.chat-conv__item:has-text("长对话测试B")');
  console.log(label, '满→满', JSON.stringify(await probe2));
  await ctx.close();
}

await scenario({ label: '[A 桌面]', viewport: { width: 1280, height: 900 }, count: 18, pad: '', shot: 'D:/code/ldm-api/_test/shots/v4-window-desktop.png' });
await scenario({ label: '[B 手机]', viewport: { width: 390, height: 844 }, count: 30, pad: '懒大猫'.repeat(300), shot: 'D:/code/ldm-api/_test/shots/v4-window-mobile.png' });
await browser.close();
