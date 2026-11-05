// 点击复制回归：日志页名称徽章 / 渠道列表 ID 与模型
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6821';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));

let fails = 0;
const check = (ok, msg, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}${extra ? ' -> ' + extra : ''}`);
  if (!ok) fails++;
};

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
if (await page.locator('#login-pwd').count()) {
  await page.fill('#login-pwd', PWD);
  await page.click('#login-btn');
  await page.waitForTimeout(1400);
}

const toastText = async () => {
  const t = page.locator('.toast').last();
  try {
    await t.waitFor({ state: 'visible', timeout: 1500 });
    return (await t.innerText()).trim();
  } catch { return '(no toast)'; }
};

const styleOf = (sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { cursor: cs.cursor, font: cs.fontFamily.split(',')[0], h: +el.getBoundingClientRect().height.toFixed(1) };
}, sel);

// ---------- 日志页 ----------
await page.goto(BASE + '/#/logs', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2200);
const logBadge = '#log-table tbody button.badge--tag';
const ls = await styleOf(logBadge);
check(!!ls, '日志页存在可复制名称徽章');
check(ls && ls.cursor === 'pointer', '日志页徽章指针为 pointer', ls && ls.cursor);
const modelText = (await page.locator(logBadge).first().innerText()).trim();
await page.locator(logBadge).first().click();
const logToast = await toastText();
check(logToast.includes('已复制'), '点击日志模型徽章弹出复制提示', logToast);
await page.waitForTimeout(300);
const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => '(denied)'));
check(clip === modelText, '剪贴板内容与徽章文本一致', `${clip} vs ${modelText}`);

const row0 = await page.locator('#log-table tbody tr').first().boundingBox();
if (row0) {
  await page.screenshot({ path: `${SHOT}/chk-copy-log-row.png`, clip: { x: row0.x - 8, y: row0.y - 34, width: Math.min(1200, row0.width + 16), height: 96 } });
}

// IP 列也应该是彩色名称徽章，并且可点击复制
const ipBadge = '#log-table tbody td:nth-child(11) button.badge--tag';
const ipCount = await page.locator(ipBadge).count();
check(ipCount > 0, '日志 IP 列渲染为彩色徽章');
if (ipCount) {
  const ipText = (await page.locator(ipBadge).first().innerText()).trim();
  check(/^\d+\.\d+\.\d+\.\d+$/.test(ipText), 'IP 徽章文本是地址', ipText);
  await page.locator(ipBadge).first().click();
  const ipToast = await toastText();
  check(ipToast.includes('已复制'), '点击 IP 徽章弹出复制提示', ipToast);
  await page.waitForTimeout(250);
  const ipClip = await page.evaluate(() => navigator.clipboard.readText().catch(() => '(denied)'));
  check(ipClip === ipText, 'IP 复制内容正确', `${ipClip} vs ${ipText}`);
}

// 悬停不再上浮：徽章 / 普通按钮 / 模型卡；统计卡是唯一例外，仍保留上浮
await page.locator(logBadge).first().hover();
await page.waitForTimeout(250);
const badgeTf = await page.evaluate((s) => getComputedStyle(document.querySelector(s)).transform, logBadge);
check(badgeTf === 'none', '日志徽章悬停不上浮', badgeTf);

await page.locator('#log-table tbody tr').first().hover();
await page.waitForTimeout(150);
const btnTf = await page.evaluate(() => getComputedStyle(document.querySelector('#btn-refresh, .topbar .btn')).transform);
check(btnTf === 'none', '顶栏按钮悬停不上浮', btnTf);

await page.goto(BASE + '/#/dashboard', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
const statSel = '.stat';
if (await page.locator(statSel).count()) {
  await page.locator(statSel).first().hover();
  await page.waitForTimeout(250);
  const statTf = await page.evaluate((s) => {
    const tf = getComputedStyle(document.querySelector(s)).transform;
    return { tf, y: tf === 'none' ? 0 : new DOMMatrix(tf).m42 };
  }, statSel);
  check(statTf.y < -2, '统计卡仍保留悬停上浮', `${statTf.y}px`);
}

await page.goto(BASE + '/#/plaza', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
const cardSel = '.model-card';
if (await page.locator(cardSel).count()) {
  await page.locator(cardSel).first().hover();
  await page.waitForTimeout(250);
  const cardTf = await page.evaluate((s) => getComputedStyle(document.querySelector(s)).transform, cardSel);
  check(cardTf === 'none', '模型卡悬停不上浮', cardTf);
  await page.screenshot({ path: `${SHOT}/chk-plaza-nohover.png` });
}

// 回到渠道页截个整页图
await page.goto(BASE + '/#/channels', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
await page.screenshot({ path: `${SHOT}/chk-copy-channels.png` });

// ---------- 渠道列表 ----------
await page.goto(BASE + '/#/channels', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
const idBtn = '#ch-tbody [data-copy], .channels-card tbody .code--copy';
const idSel = await page.locator('.code--copy').count() ? '.code--copy' : idBtn;
const istyle = await styleOf(idSel);
check(!!istyle, '渠道列表 ID 是复制按钮');
check(istyle && istyle.cursor === 'pointer', '渠道 ID 指针为 pointer', istyle && istyle.cursor);
const idText = (await page.locator(idSel).first().innerText()).trim();
await page.locator(idSel).first().click();
const idToast = await toastText();
check(idToast.includes('已复制'), '点击渠道 ID 弹出复制提示', idToast);
await page.waitForTimeout(250);
const idClip = await page.evaluate(() => navigator.clipboard.readText().catch(() => '(denied)'));
check(idClip === idText, '渠道 ID 复制内容正确', `${idClip} vs ${idText}`);

// 按下时不应该有位移（用户要求去掉 ID 专属的下压效果）
const idBox = await page.locator(idSel).first().boundingBox();
if (idBox) {
  await page.mouse.move(idBox.x + idBox.width / 2, idBox.y + idBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(150);
  const pressTf = await page.evaluate((s) => getComputedStyle(document.querySelector(s)).transform, idSel);
  await page.mouse.up();
  check(pressTf === 'none', '渠道 ID 按下没有下压位移', pressTf);
}

const modelBtn = '.channels-card tbody .badge-group button.badge';
const mstyle = await styleOf(modelBtn);
check(!!mstyle, '渠道列表模型是复制按钮');
check(mstyle && mstyle.cursor === 'pointer', '渠道模型胶囊指针为 pointer', mstyle && mstyle.cursor);
const mText = (await page.locator(modelBtn).first().innerText()).trim();
await page.locator(modelBtn).first().click();
const mToast = await toastText();
check(mToast.includes('已复制'), '点击渠道模型弹出复制提示', mToast);

// 多选模式下行点击不应该被复制按钮带偏
const rowBefore = await page.locator('.channels-card tbody tr.is-selected').count();
await page.locator('#ch-multi').first().click().catch(() => {});
await page.waitForTimeout(300);
await page.locator(modelBtn).first().click().catch(() => {});
await page.waitForTimeout(300);
const rowAfter = await page.locator('.channels-card tbody tr.is-selected').count();
check(rowBefore === rowAfter, '多选模式下点复制按钮不误选行', `${rowBefore} -> ${rowAfter}`);

const chRow = await page.locator('.channels-card tbody tr').first().boundingBox();
if (chRow) {
  await page.screenshot({ path: `${SHOT}/chk-copy-channel-row.png`, clip: { x: chRow.x - 8, y: chRow.y - 40, width: Math.min(1200, chRow.width + 16), height: Math.max(120, chRow.height + 60) } });
}
await page.screenshot({ path: `${SHOT}/chk-copy-channels.png` });

await browser.close();
console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
process.exit(fails ? 1 : 0);
