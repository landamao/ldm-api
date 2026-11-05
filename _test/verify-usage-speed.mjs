// 验证在线聊天气泡里的 token / 速度：上游每块都带累积 usage 时不能被逐块累加。
// 依赖：node _test/mock-usage.mjs 4021 起模拟上游；再起网关（LDMAPI_DEV=web 可以直接吃磁盘上的前端）
// 跑法：LDM_BASE=http://127.0.0.1:6822 node _test/verify-usage-speed.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6822';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const MOCK = process.env.LDM_MOCK || 'http://127.0.0.1:4021/v1';

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.77' },
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));

const pickSelect = async (sel, value) => {
  await page.evaluate(([s, v]) => {
    const el = document.querySelector(s);
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [sel, value]);
};

const readMeta = () => page.evaluate(() => {
  const all = [...document.querySelectorAll('.msg__meta')];
  const el = all[all.length - 1];
  if (!el) return '';
  return [...el.querySelectorAll('.msg__meta-group')].map((g) => g.textContent.trim()).join(' | ');
});

const num = (meta, re) => {
  const m = meta.match(re);
  return m ? Number(m[1].replace(/,/g, '')) : NaN;
};

const fails = [];
const check = (cond, msg) => { if (!cond) fails.push(msg); };

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1000);
}
await page.goto(BASE + '/#/chat', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

// 临时测试模式：直连本地模拟上游
await pickSelect('#chat-model', '__test__');
await page.waitForTimeout(300);
await page.fill('#chat-test-url', MOCK);
await page.fill('#chat-test-key', 'sk-test');
await page.click('#chat-test-fetch');
await page.waitForTimeout(1000);

// --- 场景 1：单轮，40 块，每块带累积 usage（339 输入 / 输出累加到 40）---
await pickSelect('#chat-test-model-select', 'usage-echo');
await page.waitForTimeout(300);
await page.fill('#chat-text', '你好');
await page.click('#chat-send');
await page.waitForTimeout(9000);

const m1 = await readMeta();
console.log('[单轮]', m1);
const in1 = num(m1, /输入\s+([\d,]+)/);
const out1 = num(m1, /输出\s+([\d,]+)/);
const tps1 = num(m1, /([\d.]+)\s*t\/s/);
const tot1 = num(m1, /总token\s+([\d,]+)/);
check(in1 === 339, `单轮输入应为 339，实际 ${in1}（逐块累加会变成 339×41=13899）`);
check(out1 === 40, `单轮输出应为 40，实际 ${out1}（逐块累加会变成 Σ1..40=820）`);
check(tot1 === 379, `单轮总 token 应为 379，实际 ${tot1}`);
check(tps1 > 0 && tps1 < 20, `单轮速度应在 0~20 t/s，实际 ${tps1}`);

// --- 场景 2：一轮工具调用 + 一轮正文，跨轮必须相加（339/5 + 400/10）---
await page.evaluate(() => localStorage.setItem('ldmapi.chat.tools', '1'));
// 只改 hash 的 goto 不会重新加载页面，开关读不到新值，必须真的 reload
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
await pickSelect('#chat-model', '__test__');
await page.waitForTimeout(300);
await page.fill('#chat-test-url', MOCK);
await page.fill('#chat-test-key', 'sk-test');
await page.click('#chat-test-fetch');
await page.waitForTimeout(1000);
await pickSelect('#chat-test-model-select', 'usage-tool');
await page.waitForTimeout(300);
await page.fill('#chat-text', '现在几点');
await page.click('#chat-send');
await page.waitForTimeout(6000);

const m2 = await readMeta();
console.log('[工具轮]', m2);
const in2 = num(m2, /输入\s+([\d,]+)/);
const out2 = num(m2, /输出\s+([\d,]+)/);
const tot2 = num(m2, /总token\s+([\d,]+)/);
check(/工具调用\s+1\s*次/.test(m2), `工具轮应显示「工具调用 1 次」，实际：${m2}`);
check(in2 === 739, `工具轮输入应为 339+400=739，实际 ${in2}`);
check(out2 === 15, `工具轮输出应为 5+10=15，实际 ${out2}`);
check(tot2 === 754, `工具轮总 token 应为 754，实际 ${tot2}`);

await browser.close();
if (fails.length) {
  console.error('[失败]');
  fails.forEach((f) => console.error(' - ' + f));
  process.exit(1);
}
console.log('[通过] 轮内取最后一次快照、跨轮相加，速度用首块→末块窗口');
