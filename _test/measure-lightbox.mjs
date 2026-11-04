// 量图片灯箱：图片是否超出视口（手机 + 桌面，横图 + 竖长图）
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/code/ldm-api';
const SHOT = path.join(ROOT, '_test/shots');
fs.mkdirSync(SHOT, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });

const imgs = [
  { name: 'wide', w: 1600, h: 1200 },
  { name: 'tall', w: 800, h: 2400 },
];
for (const it of imgs) {
  const file = path.join(ROOT, `_test/tmp-${it.name}.png`);
  if (fs.existsSync(file)) continue;
  const p = await browser.newPage({ viewport: { width: it.w, height: it.h } });
  await p.setContent(`<body style="margin:0;background:linear-gradient(45deg,#2e7d32,#f9a825)"><div style="font:700 ${Math.round(it.w / 16)}px sans-serif;color:#fff;padding:40px">${it.name} ${it.w}x${it.h}</div></body>`);
  await p.screenshot({ path: file });
  await p.close();
}

let fail = 0;
for (const vp of [{ width: 390, height: 844, label: 'ip12' }, { width: 1440, height: 900, label: 'desk' }]) {
  for (const it of imgs) {
    const html = `<!doctype html><html data-theme="light"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="file:///${ROOT}/web/assets/app.css">
</head><body>
<div class="img-lightbox is-open"><img alt="" src="file:///${ROOT}/_test/tmp-${it.name}.png"></div>
</body></html>`;
    const file = path.join(ROOT, `_test/tmp-lightbox-${it.name}.html`);
    fs.writeFileSync(file, html);

    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2 });
    await page.goto('file:///' + file.replace(/\\/g, '/'));
    await page.waitForTimeout(300);
    const geo = await page.evaluate(() => {
      const img = document.querySelector('.img-lightbox img');
      const s = img.getBoundingClientRect();
      return {
        vw: innerWidth, vh: innerHeight,
        img: { w: +s.width.toFixed(1), h: +s.height.toFixed(1) },
        over: {
          right: +(s.x + s.width - innerWidth).toFixed(1),
          bottom: +(s.y + s.height - innerHeight).toFixed(1),
          left: +s.x.toFixed(1), top: +s.y.toFixed(1),
        },
      };
    });
    const bad = geo.over.right > 0 || geo.over.bottom > 0 || geo.over.left < 0 || geo.over.top < 0;
    if (bad) fail++;
    console.log(`${vp.label}/${it.name}:`, JSON.stringify(geo), bad ? ' << 溢出' : ' OK');
    await page.screenshot({ path: `${SHOT}/lightbox-${vp.label}-${it.name}.png` });
    await page.close();
  }
}
console.log(fail ? `FAIL ${fail}` : '所有尺寸都在视口内');
await browser.close();
