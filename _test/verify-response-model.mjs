// 日志页「响应模型和请求不一致」标记回归：
// 标记只在两个模型名不同时出现；点一下弹气泡卡片（手机没有悬停），
// 卡片里「请求上游模型 / 响应模型」两枚徽章各自点击复制；桌面悬停也能弹出。
import { chromium } from 'playwright-core';

const BASE = process.env.LDM_BASE || 'http://127.0.0.1:6823';
const PWD = process.env.LDM_PASSWORD || 'test1234';
const SHOT = 'D:/code/ldm-api/_test/shots';

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });

let fails = 0;
const check = (ok, msg, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}${extra ? ' -> ' + extra : ''}`);
  if (!ok) fails++;
};

async function login(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  if (await page.locator('#login-pwd').count()) {
    await page.fill('#login-pwd', PWD);
    await page.click('#login-btn');
    await page.waitForTimeout(1400);
  }
}

const toastText = async (page) => {
  const t = page.locator('.toast').last();
  try {
    await t.waitFor({ state: 'visible', timeout: 1500 });
    return (await t.innerText()).trim();
  } catch { return '(no toast)'; }
};

// ---------- 桌面：点击 / 悬停 / 复制 / 关闭 ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 2 });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  await login(page);
  await page.goto(BASE + '/#/logs', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2400);

  const rows = await page.locator('#log-table tbody tr').count();
  const chips = await page.locator('#log-table .log-model-map').count();
  check(rows > 0, '日志页有记录', String(rows));
  check(chips > 0, '存在响应模型标记', String(chips));
  check(chips < rows, '上游原样回显的记录不出标记', `${chips}/${rows}`);

  const marker = page.locator('#log-table .log-model-map').first();
  const info = await page.evaluate(() => {
    const chip = document.querySelector('#log-table .log-model-map');
    const cell = chip.closest('td');
    const tag = cell.querySelector('.badge--tag');
    return {
      asked: chip.dataset.asked || '',
      got: chip.dataset.got || '',
      upstream: tag ? tag.textContent.trim() : '',
      hasIcon: !!chip.querySelector('svg'),
      isBadge: chip.className.includes('badge--tag'),
      h: +chip.getBoundingClientRect().height.toFixed(1),
      cursor: getComputedStyle(chip).cursor,
      title: chip.getAttribute('title'),
    };
  });
  check(info.asked === info.upstream, '徽章文字就是请求的上游模型', `${info.asked}`);
  check(info.got && info.got !== info.asked, '徽章记下了不同的响应模型', info.got);
  check(info.isBadge, '触发器就是上游模型徽章本身（没有另起小按钮）', info.isBadge && 'badge--tag');
  check(info.hasIcon, '徽章右侧带路由图标');
  check(info.cursor === 'pointer', '徽章可点击', info.cursor);
  check(info.h <= 21, '徽章高度没变', String(info.h));
  check(!info.title, '不再用原生 title 悬停', String(info.title));

  // 桌面：点徽章复制模型名（和 NewAPI 的模型 tag 一致），鼠标移上去气泡已经打开
  await marker.click();
  const clickToast = await toastText(page);
  check(clickToast.includes('上游模型已复制'), '桌面点徽章直接复制模型名', clickToast);
  await page.waitForTimeout(200);
  const clickClip = await page.evaluate(() => navigator.clipboard.readText().catch(() => '(denied)'));
  check(clickClip === info.asked, '桌面点击剪贴板是上游模型', String(clickClip));
  check(await page.locator('.log-pop').count() === 1, '点击时气泡仍开着');
  const pop = await page.evaluate(() => {
    const p = document.querySelector('.log-pop');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    const labels = [...p.querySelectorAll('.log-pop__label')].map((n) => n.textContent.trim());
    const badges = [...p.querySelectorAll('.badge')].map((n) => ({ text: n.textContent.trim(), copy: n.dataset.copy }));
    const row = p.querySelector('.log-pop__row');
    const lb = row && row.querySelector('.log-pop__label').getBoundingClientRect();
    const bd = row && row.querySelector('.badge').getBoundingClientRect();
    return {
      labels, badges,
      hint: p.querySelectorAll('.log-pop__hint').length,
      inline: !!(lb && bd && bd.left >= lb.right && Math.abs((bd.top + bd.bottom) / 2 - (lb.top + lb.bottom) / 2) < 4),
      inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5,
      shadow: getComputedStyle(p).boxShadow,
      expanded: document.querySelector('#log-table .log-model-map').getAttribute('aria-expanded'),
    };
  });
  check(!!pop && pop.labels.join('|') === '请求模型|响应模型', '气泡两行标题正确', pop && pop.labels.join(' / '));
  check(!!pop && pop.inline, '标签和徽章左右同行');
  check(!!pop && pop.hint === 0, '没有多余的说明文字');
  check(!!pop && pop.badges.length === 2 && pop.badges[1].copy === info.got, '气泡里是两枚可复制徽章');
  check(!!pop && pop.inViewport, '气泡在视口内');
  check(!!pop && (pop.shadow === 'none' || pop.shadow === ''), '气泡没有阴影', pop && pop.shadow);
  check(!!pop && pop.expanded === 'true', '标记 aria-expanded 同步');

  await page.screenshot({ path: `${SHOT}/chk-logpop-desktop.png`, clip: { x: 0, y: 0, width: 1500, height: 480 } });

  // 点响应模型徽章复制
  await page.locator('.log-pop .badge').nth(1).click();
  const copyToast = await toastText(page);
  check(copyToast.includes('响应模型已复制'), '点响应模型徽章复制', copyToast);
  await page.waitForTimeout(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => '(denied)'));
  check(clip === info.got, '剪贴板是响应模型', String(clip));
  check(await page.locator('.log-pop').count() === 1, '复制后气泡还开着，方便再复制另一个');

  // 点空白处关闭
  await page.waitForTimeout(2600); // 等复制提示消失，后面点空白别被 toast 挡住
  await page.mouse.click(20, 20);
  await page.waitForTimeout(200);
  check(await page.locator('.log-pop').count() === 0, '点空白处关闭气泡');

  // Esc 关闭
  await marker.click();
  await page.waitForTimeout(150);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check(await page.locator('.log-pop').count() === 0, 'Esc 关闭气泡');

  // 桌面悬停打开、移开关闭（先把鼠标挪开，否则指针一直停在标记上不会触发 pointerover）
  await page.mouse.move(600, 760);
  await page.waitForTimeout(120);
  const box = await marker.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(250);
  check(await page.locator('.log-pop').count() === 1, '桌面悬停也能打开气泡');

  // 鼠标在徽章内部挪动（从文字挪到右侧路由图标）不该让气泡闪掉
  for (const dx of [6, 18, 30, 42, 54, 66, 78]) {
    await page.mouse.move(box.x + dx, box.y + box.height / 2);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(700);
  check(await page.locator('.log-pop').count() === 1, '鼠标在徽章内部移动时气泡不闪掉');

  // 从徽章挪进气泡里也不该收起
  const popBox = await page.evaluate(() => {
    const el = document.querySelector('.log-pop');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (popBox) {
    await page.mouse.move(popBox.x, popBox.y, { steps: 6 });
    await page.waitForTimeout(500);
    check(await page.locator('.log-pop').count() === 1, '鼠标移进气泡里气泡不消失');
  }

  await page.mouse.move(40, 700);
  await page.waitForTimeout(400);
  check(await page.locator('.log-pop').count() === 0, '鼠标移开后悬停气泡自动收起');

  // 和旁边的亲和星（带 title 的邻居）不能互相打架：滑过去再滑回来，卡片还得能弹
  const starGeo = await page.evaluate(() => {
    const wrap = document.querySelector('.log-star-wrap');
    const map = wrap.querySelector('.log-model-map');
    const star = document.createElement('span');
    star.className = 'affinity-star';
    star.title = '模型亲和命中：本次直接复用了上次成功的路由';
    star.textContent = '★';
    star.style.cssText = 'display:inline-block;font-size:14px;line-height:1;color:#d97706';
    wrap.appendChild(star);
    const sr = star.getBoundingClientRect();
    const mr = map.getBoundingClientRect();
    window.__map = map;
    return { sx: sr.x + sr.width / 2, sy: sr.y + sr.height / 2, mx: mr.x + mr.width / 2, my: mr.y + mr.height / 2 };
  });
  await page.mouse.move(starGeo.mx, starGeo.my);
  await page.waitForTimeout(320);
  check(await page.locator('.log-pop').count() === 1, '模型名卡片先打开');
  await page.mouse.move(starGeo.sx, starGeo.sy, { steps: 5 });
  await page.waitForTimeout(320);
  check(await page.locator('.log-pop').count() === 0, '滑到亲和星时卡片收起');
  check(await page.evaluate(() => window.__map.getAttribute('aria-expanded')) === 'false', '被顶掉时 aria-expanded 同步回 false');
  await page.mouse.move(starGeo.mx, starGeo.my, { steps: 5 });
  await page.waitForTimeout(420);
  check(await page.locator('.log-pop').count() === 1, '再滑回模型名卡片还能重新弹出');

  // 看板同一套交互
  await page.goto(BASE + '/#/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600);
  const dashChips = await page.locator('#recent-logs .log-model-map').count();
  check(dashChips > 0, '看板「最近调用」也带标记', String(dashChips));
  if (dashChips) {
    await page.locator('#recent-logs .log-model-map').first().click();
    await page.waitForTimeout(200);
    check(await page.locator('.log-pop').count() === 1, '看板点标记也能弹气泡');
  }
  await ctx.close();
}

// ---------- 手机：只能点，没有悬停 ----------
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  await login(page);
  await page.goto(BASE + '/#/logs', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600);

  const chips = await page.locator('#log-table .log-model-map').count();
  check(chips > 0, '手机上能看到标记', String(chips));
  if (chips) {
    const marker = page.locator('#log-table .log-model-map').first();
    // 手指点（tap）而不是鼠标：没有悬停，点徽章就是展开气泡
    await marker.tap();
    await page.waitForTimeout(250);
    check(await page.locator('.log-pop').count() === 1, '手机点徽章弹出气泡');
    check(await page.locator('.toast').count() === 0, '手机点徽章不直接复制，避免看不到详情');
    const rect = await page.evaluate(() => {
      const p = document.querySelector('.log-pop');
      const r = p.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, vw: innerWidth, vh: innerHeight };
    });
    check(rect.left >= 0 && rect.top >= 0 && rect.right <= rect.vw && rect.bottom <= rect.vh,
      '手机气泡完整落在视口内', JSON.stringify(rect));
    await page.screenshot({ path: `${SHOT}/chk-logpop-mobile.png` });

    await page.locator('.log-pop .badge').nth(1).tap();
    const mToast = await toastText(page);
    check(mToast.includes('响应模型已复制'), '手机点徽章复制', mToast);
    await page.waitForTimeout(200);
    const mClip = await page.evaluate(() => navigator.clipboard.readText().catch(() => '(denied)'));
    const got = await page.evaluate(() => document.querySelector('#log-table .log-model-map').dataset.got);
    check(mClip === got, '手机剪贴板是响应模型', String(mClip));

    await page.tap('body', { position: { x: 10, y: 300 } });
    await page.waitForTimeout(250);
    check(await page.locator('.log-pop').count() === 0, '手机点空白处关闭气泡');
  }
  await ctx.close();
}

console.log(fails ? `\n${fails} 项未通过` : '\n全部通过');
await browser.close();
process.exit(fails ? 1 : 0);
