// 气泡 Markdown 渲染的封装测试（web/assets/markdown.js）。
// marked / KaTeX / 公式扩展都用真实打包文件，DOMPurify 用桩件：
// 这里测的是「我们怎么配这几个库」，消毒白名单本身由 DOMPurify 保证，浏览器里另有手工验证。
// 用法：node --test _test/markdown.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const ASSETS = path.join(ROOT, 'web/assets');
const read = (f) => fs.readFileSync(path.join(ASSETS, f), 'utf8');

// 在独立上下文里按 index.html 的顺序加载脚本，返回 window
function loadWindow(opts) {
  const withLibs = !opts || opts.libs !== false;
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const calls = [];
  // DOMPurify 桩件：记录调用参数，返回原样（消毒行为不在本测试范围）
  vm.runInContext(`
    window.DOMPurify = {
      addHook: function (name, fn) { window.__hooks.push(name); },
      sanitize: function (html, cfg) { window.__calls.push(cfg); return html; }
    };
  `, sandbox);
  sandbox.__calls = calls;
  sandbox.__hooks = [];

  vm.runInContext(read('marked.min.js'), sandbox);
  if (withLibs) {
    vm.runInContext(read('katex/katex.min.js'), sandbox);
    vm.runInContext(read('marked-katex.js'), sandbox);
  }
  vm.runInContext(read('markdown.js'), sandbox);
  return sandbox;
}

const win = loadWindow();
const md = (t) => win.LDMMD.render(t);

test('基础行内与块级标记', () => {
  assert.match(md('**粗** 和 *斜*'), /<strong>粗<\/strong>/);
  assert.match(md('**粗** 和 *斜*'), /<em>斜<\/em>/);
  assert.match(md('~~删~~'), /<del>删<\/del>/);
  assert.match(md('`code`'), /<code>code<\/code>/);
  assert.match(md('# 标题'), /<h1[^>]*>标题<\/h1>/);
  assert.match(md('> 引用'), /<blockquote>[\s\S]*引用/);
});

test('单个换行按换行显示（breaks）', () => {
  assert.match(md('第一行\n第二行'), /<br\s*\/?>/);
});

test('代码块带语言标签与复制按钮，内容被转义', () => {
  const html = md('```js\nconst a = 1 < 2;\n```');
  assert.match(html, /class="md-code"/);
  assert.match(html, /class="language-js"/);
  assert.match(html, /data-md-copy="1"/);
  assert.match(html, /1 &lt; 2/);
  assert.equal(html.includes('<script'), false);
});

test('表格外包一层可横向滚动的容器', () => {
  const html = md('| a | b |\n| --- | ---: |\n| 1 | 2 |');
  assert.match(html, /<div class="md-table-wrap"><table>/);
  assert.match(html, /<td>1<\/td>/);
});

test('嵌套列表与任务列表', () => {
  const html = md('- 一\n  - 一甲\n- 二');
  assert.equal((html.match(/<ul>/g) || []).length, 2);
  const task = md('- [x] 做完\n- [ ] 没做');
  assert.match(task, /checkbox/);
});

test('外链改新窗口打开（DOMPurify 钩子已注册）', () => {
  assert.ok(win.__hooks.includes('afterSanitizeAttributes'));
});

test('消毒配置用 DOMPurify 自带的 html + MathML 白名单', () => {
  md('| a |\n| --- |\n| 1 |');
  const cfg = win.__calls[win.__calls.length - 1];
  assert.ok(cfg, '应该调用过 DOMPurify.sanitize');
  assert.equal(cfg.USE_PROFILES.html, true);
  assert.equal(cfg.USE_PROFILES.mathMl, true);
  // 大根号是内联 SVG，少了 svg 这一档公式会缺笔画
  assert.equal(cfg.USE_PROFILES.svg, true);
  // 能执行脚本的标签仍然挡掉，样式只让 KaTeX 自己产出
  assert.ok(cfg.FORBID_TAGS.includes('style'));
  assert.ok(cfg.FORBID_TAGS.includes('iframe'));
});

test('空输入返回空串，不产生空段落', () => {
  assert.equal(md(''), '');
  assert.equal(md('   \n  '), '');
  assert.equal(md(null), '');
});

test('行内公式 $...$ 走 KaTeX，中文紧贴也能认', () => {
  const a = md('质能方程$E=mc^2$说明质量就是能量');
  assert.match(a, /<span class="katex">/);
  assert.match(a, /<math /);
  assert.equal(a.includes('$E=mc^2$'), false);
  const b = md('还有 $\\frac{a}{b}=c$ 这种');
  assert.match(b, /<span class="katex">/);
});

test('块级公式 $$...$$ 独立成块', () => {
  const html = md('$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$');
  assert.match(html, /katex-display/);
  assert.match(html, /<math /);
});

test('代码里的 $ 不会被当成公式', () => {
  const fence = md('```bash\necho $HOME $PATH\n```');
  assert.equal(fence.includes('katex'), false);
  assert.match(fence, /\$HOME \$PATH/);
  const inline = md('执行 `echo $HOME` 看看');
  assert.equal(inline.includes('katex'), false);
  assert.match(inline, /<code>echo \$HOME<\/code>/);
});

test('单独的金额 $ 不会被当成公式', () => {
  const html = md('价格 $5 一份');
  assert.equal(html.includes('katex'), false);
  assert.match(html, /\$5 一份/);
});

test('KaTeX 没加载时公式原样显示，不抛异常', () => {
  const bare = loadWindow({ libs: false });
  const html = bare.LDMMD.render('看看 $a+b$ 的结果');
  assert.equal(html.includes('katex'), false);
  assert.match(html, /\$a\+b\$/);
});

test('公式写坏时由 KaTeX 自己兜底，不抛异常', () => {
  const html = md('$\\frac{1}{$');
  assert.equal(typeof html, 'string');
  assert.ok(html.length > 0);
});

test('流式半成品不抛异常', () => {
  for (const src of ['```js\nlet a =', '**半截', '| a | b', '`未闭合', '$$\nx =']) {
    assert.equal(typeof md(src), 'string');
  }
});

test('解析器抛错时退回纯文本', () => {
  const saved = win.marked.parse;
  win.marked.parse = () => { throw new Error('boom'); };
  try {
    const html = md('**粗** <b>x</b>');
    assert.equal(html, '<p class="md-p">**粗** &lt;b&gt;x&lt;/b&gt;</p>');
  } finally {
    win.marked.parse = saved;
  }
});
