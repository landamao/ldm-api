// 用量分析页交互回归：视图切换、渠道联动、模型名小写、区间切换、空状态
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6824';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ok  ' : '  FAIL') + '  ' + msg);
  if (!cond) failed++;
};

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.78' },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1100);
}

const text = (sel) => page.textContent(sel).then((s) => (s || '').replace(/\s+/g, ' ').trim());
const pick = async (sel, value) => {
  await page.evaluate(([s, v]) => {
    const el = document.querySelector(s);
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [sel, value]);
  await page.waitForTimeout(1100);
};

await page.goto(BASE + '/#/usage', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#usage-body', { timeout: 8000 });
await page.waitForTimeout(1400);

// 1. 渠道视图默认有数据
const req1 = await text('#u-req [data-v]');
ok(!/^0/.test(req1), `渠道视图默认有调用量（${req1}）`);
const rows1 = await page.$$eval('#u-table tbody tr', (els) => els.length);
ok(rows1 > 0, `明细表有 ${rows1} 行`);

// 2. 渠道里的模型下拉按该渠道配置
const models = await page.$$eval('#usage-model option', (els) => els.map((e) => e.value));
ok(models[0] === '', '渠道视图的模型下拉第一项是「全部模型」');
ok(models.length > 1, `渠道下拉带出 ${models.length - 1} 个模型`);
ok(models.slice(1).every((m) => m === m.toLowerCase()), '模型名全部小写');
ok(!models.some((m) => m.includes('/')), '模型名不带「渠道/模型」前缀');

// 3. 切到模型视图
await page.click('#usage-tab button[data-tab="model"]');
await page.waitForTimeout(1400);
const firstCh = await page.$eval('#usage-channel option', (e) => e.textContent.trim());
ok(firstCh === '全部渠道', `模型视图的渠道下拉第一项是「全部渠道」（${firstCh}）`);
const modelSel = await page.$eval('#usage-model', (e) => e.value);
ok(!!modelSel, `模型视图默认选中一个模型（${modelSel}）`);
const modelOpts = await page.$$eval('#usage-model option', (els) => els.map((e) => e.value));
ok(!modelOpts.includes(''), '模型视图的模型下拉没有「全部模型」');
const req2 = await text('#u-req [data-v]');
ok(!/^0/.test(req2), `模型视图默认有调用量（${req2}）`);

// 4. 模型视图下按渠道再筛
const chans = await page.$$eval('#usage-channel option', (els) => els.map((e) => e.value).filter(Boolean));
if (chans.length) {
  await pick('#usage-channel', chans[0]);
  const req3 = await text('#u-req [data-v]');
  ok(!/^0/.test(req3), `按渠道筛选后仍有数据（${req3}）`);
  await pick('#usage-channel', '');
}

// 5. 切区间到近 7 天，数据量应不小于今日
const before = Number((await text('#u-req [data-v]')).replace(/[^\d]/g, ''));
await pick('#usage-range', '7d');
const after = Number((await text('#u-req [data-v]')).replace(/[^\d]/g, ''));
ok(after >= before, `近 7 天调用量 ${after} ≥ 今日 ${before}`);

// 6. 令牌筛选：选一个令牌后请求量收窄
const tokens = await page.$$eval('#usage-token option', (els) => els.map((e) => e.value).filter(Boolean));
if (tokens.length > 1) {
  await pick('#usage-token', tokens[0]);
  const narrowed = Number((await text('#u-req [data-v]')).replace(/[^\d]/g, ''));
  ok(narrowed <= after, `令牌筛选生效（${narrowed} ≤ ${after}）`);
  await pick('#usage-token', '');
}

// 7. 切回渠道视图，渠道保留、模型清空
await page.click('#usage-tab button[data-tab="channel"]');
await page.waitForTimeout(1300);
const ch2 = await page.$eval('#usage-channel', (e) => e.value);
ok(!!ch2, `切回渠道视图后仍锁定一个渠道（${ch2}）`);
const model2 = await page.$eval('#usage-model', (e) => e.value);
ok(model2 === '', '切回渠道视图后模型筛选回到「全部模型」');

// 8. 分布是环形图，不是纯文字排行
const arcs = await page.$$eval('#u-rank .donut-arc', (els) => els.length);
ok(arcs > 0, `分布渲染成环形图（${arcs} 段弧）`);

// 9. 明细切到「按请求模型」：出现类型列和徽章，切回来恢复
await page.click('#u-table-mode button[data-m="caller"]');
await page.waitForTimeout(400);
const callerHead = await text('#u-table thead');
ok(/类型/.test(callerHead), `按请求模型视图有类型列（${callerHead.slice(0, 20)}…）`);
const typeBadges = await page.$$eval('#u-table tbody tr td:nth-child(2) .badge', (els) => els.map((e) => e.textContent.trim()));
ok(typeBadges.length > 0, `类型徽章存在（${typeBadges.slice(0, 4).join(' / ')}）`);
ok(typeBadges.every((t) => ['自定义', '渠道', '已删除'].includes(t)), '类型只会是自定义 / 渠道 / 已删除');
await page.click('#u-table-mode button[data-m="main"]');
await page.waitForTimeout(400);
const mainHead = await text('#u-table thead');
ok(!/类型/.test(mainHead), '切回主维度后类型列消失');

// 10. 深色 / 手机截图
await page.screenshot({ path: `${SHOT}/usage-verify.png`, fullPage: true });

ok(errors.length === 0, `页面无 JS 报错${errors.length ? '：' + errors.join(' | ') : ''}`);

await browser.close();
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
