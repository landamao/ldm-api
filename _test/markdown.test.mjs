// 气泡 Markdown 渲染的封装测试（web/assets/markdown.js）。
// marked 用真实打包文件，DOMPurify 用桩件：这里测的是「我们怎么用这两个库」，
// 消毒白名单本身由 DOMPurify 保证，浏览器里另有手工验证。
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
function loadWindow() {
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const sanitizeCalls = [];
  const hooks = [];
  // DOMPurify 桩件：记录调用参数，返回原样（消毒行为不在本测试范围）
  vm.runInContext(`
    window.DOMPurify = {
      addHook: function (name, fn) { window.__hooks.push(name); },
      sanitize: function (html, cfg) { window.__calls.push(cfg); return html; }
    };
  `, sandbox);
  sandbox.__calls = sanitizeCalls;
  sandbox.__hooks = hooks;

  vm.runInContext(read('marked.min.js'), sandbox);
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

test('消毒配置放行 Markdown 会产出的标签', () => {
  md('| a |\n| --- |\n| 1 |');
  const cfg = win.__calls[win.__calls.length - 1];
  assert.ok(cfg, '应该调用过 DOMPurify.sanitize');
  for (const tag of ['table', 'td', 'pre', 'code', 'blockquote', 'li']) {
    assert.ok(cfg.ALLOWED_TAGS.includes(tag), `缺少 ${tag}`);
  }
  // 样式一律走 app.css，不接受内联 style / on* 事件
  assert.equal(cfg.ALLOWED_ATTR.includes('style'), false);
  assert.equal(cfg.ALLOWED_ATTR.includes('onerror'), false);
});

test('空输入返回空串，不产生空段落', () => {
  assert.equal(md(''), '');
  assert.equal(md('   \n  '), '');
  assert.equal(md(null), '');
});

test('流式半成品不抛异常', () => {
  for (const src of ['```js\nlet a =', '**半截', '| a | b', '`未闭合']) {
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
