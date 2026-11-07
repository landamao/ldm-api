// 回归：渠道里测模型会在调用日志留一条记录，并标成「测试」。
// 前置：服务跑在 $LDM_BASE，演示库里 demo-main 渠道指向可用的 mock 上游。
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6822';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';
const MODEL = process.env.LDM_TEST_MODEL || 'gpt-4o';

let fail = 0;
const check = (ok, msg) => {
  console.log(ok ? '  ok  ' : '  FAIL', msg);
  if (!ok) fail++;
};

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.77' },
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1300);
}

// 1) 渠道页 → 打开测试弹窗 → 点某个模型的「测试」
await page.goto(BASE + '/#/channels', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
const testBtn = page.locator('[data-act="test"][data-id="demo-main"]');
if (!(await testBtn.count())) {
  console.log('找不到 demo-main 的测试按钮，跳过');
  await browser.close();
  process.exit(2);
}
await testBtn.click();
await page.waitForTimeout(600);
const modelTest = page.locator(`[data-mrow="${MODEL}"] [data-tbtn]`);
check(await modelTest.count() > 0, `测试弹窗里有 ${MODEL} 的测试按钮`);
await modelTest.click();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${SHOT}/log-source-dialog.png` });

// 2) 日志页：最新一条应该是刚写进去的测试记录
await page.click('.modal__close, [data-close]').catch(() => {});
await page.waitForTimeout(300);
await page.goto(BASE + '/#/logs', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);

const firstRow = page.locator('.tbl--logs tbody tr').first();
const rowText = (await firstRow.innerText()).replace(/\s+/g, ' ');
check(rowText.includes(MODEL), `最新日志的模型是 ${MODEL}`);
// 模型名旁边不再挂「测试」木牌，和模型管理里的测试一样只看令牌列
check((await firstRow.locator('.badge--wood').count()) === 0, '模型名旁不再有「测试」木牌');
// 令牌列：测试没有真实令牌，统一写「模型测试」
const tokenCell = (await firstRow.locator('td').nth(4).innerText()).trim();
check(tokenCell === '模型测试', `令牌列显示「模型测试」（实际 ${JSON.stringify(tokenCell)}）`);
// 状态列：这一条应当成功
check((await firstRow.locator('.badge--green').count()) >= 1, '状态列显示成功');
await page.screenshot({ path: `${SHOT}/log-source-logs.png` });

await browser.close();
console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
