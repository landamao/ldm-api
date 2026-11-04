// 量「编辑文本」弹窗右上角关闭按钮：圆圈与 X 图标的几何中心是否重合
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/code/ldm-api';
const SHOT = path.join(ROOT, '_test/shots');
fs.mkdirSync(SHOT, { recursive: true });

const xIcon = `<svg class="icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`;

const html = `<!doctype html><html data-theme="light"><head><meta charset="utf-8">
<link rel="stylesheet" href="file:///${ROOT}/web/assets/app.css">
</head><body>
<div class="modal-backdrop">
  <div class="modal modal--expand" role="dialog">
    <div class="modal__head">
      <div><div class="modal__title">编辑文本</div></div>
      <button class="modal__close" data-close aria-label="关闭">${xIcon}</button>
    </div>
    <div class="modal__body"><textarea class="textarea-expand__editor" style="min-height:320px"></textarea></div>
  </div>
</div>
</body></html>`;

const file = path.join(ROOT, '_test/tmp-close.html');
fs.writeFileSync(file, html);

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 2 });
await page.goto('file:///' + file.replace(/\\/g, '/'));
await page.waitForTimeout(300);

const geo = await page.evaluate(() => {
  const btn = document.querySelector('.modal__close');
  const svg = btn.querySelector('svg');
  const b = btn.getBoundingClientRect();
  const s = svg.getBoundingClientRect();
  const cs = getComputedStyle(btn);
  return {
    btn: { x: b.x, y: b.y, w: b.width, h: b.height, cx: b.x + b.width / 2, cy: b.y + b.height / 2 },
    svg: { x: s.x, y: s.y, w: s.width, h: s.height, cx: s.x + s.width / 2, cy: s.y + s.height / 2 },
    offset: {
      dx: +(s.x + s.width / 2 - (b.x + b.width / 2)).toFixed(2),
      dy: +(s.y + s.height / 2 - (b.y + b.height / 2)).toFixed(2),
    },
    style: {
      display: cs.display, placeItems: cs.placeItems, padding: cs.padding,
      border: cs.borderWidth, width: cs.width, height: cs.height,
      boxSizing: cs.boxSizing, lineHeight: cs.lineHeight, textAlign: cs.textAlign,
      justifyContent: cs.justifyContent, alignItems: cs.alignItems,
    },
  };
});
console.log(JSON.stringify(geo, null, 2));
await page.locator('.modal__head').screenshot({ path: SHOT + '/close-btn.png' });
await browser.close();
