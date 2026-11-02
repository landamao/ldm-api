/* ==========================================================================
   气泡里的 Markdown 渲染
   —— 解析用 marked v12（MIT），消毒用 DOMPurify 3.2.6（Apache-2.0 / MPL-2.0），
      公式用 KaTeX 0.16（MIT）+ marked 官方的 marked-katex-extension（MIT）。
   四个库都在 assets 目录里随二进制分发，不引 CDN，内网与离线环境照常可用。
   这里只做配置：给代码块加复制工具栏、给表格加横向滚动容器、套一份适合聊天的
   解析选项，最后过一遍 DOMPurify 白名单。语法解析和公式识别都由库负责。
   ========================================================================== */
(function (root) {
  'use strict';

  const marked = root.marked;
  const DOMPurify = root.DOMPurify;
  const katexExt = root.markedKatex;
  if (!marked) return;

  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

  // 两处排版钩子：代码块带语言标签和复制按钮，表格包一层可横向滚动的容器。
  // 这只是改写 marked 的输出，不是自己解析 Markdown。
  const renderer = new marked.Renderer();
  renderer.code = (code, infostring) => {
    const lang = String(infostring || '').trim().split(/\s+/)[0];
    const cls = lang ? ` class="language-${esc(lang)}"` : '';
    return '<div class="md-code">'
      + '<div class="md-code__bar">'
      + `<span class="md-code__lang">${esc(lang)}</span>`
      + '<button type="button" class="md-code__copy" data-md-copy="1" title="复制代码">复制</button>'
      + '</div>'
      + `<pre><code${cls}>${esc(code)}</code></pre>`
      + '</div>';
  };
  renderer.table = (header, body) => '<div class="md-table-wrap"><table>'
    + `<thead>${header}</thead><tbody>${body}</tbody>`
    + '</table></div>';

  // 公式：$...$ 行内、$$...$$ 独立成块，由 marked-katex-extension 识别并交给 KaTeX。
  // nonStandard 让 $ 紧贴中文也能认出来（模型输出普遍不带空格）。
  // trust 关掉，\href 这类命令不会被放行。KaTeX 没加载就不挂这个扩展，公式原样显示。
  if (katexExt && root.katex) {
    marked.use(katexExt({
      throwOnError: false,
      strict: 'ignore',
      trust: false,
      output: 'htmlAndMathml',
      nonStandard: true,
    }));
  }
  marked.use({ renderer });

  const OPTIONS = {
    gfm: true,
    // 单个换行也当作换行，聊天里比标准 Markdown 的「软换行」更符合直觉
    breaks: true,
    pedantic: false,
    headerIds: false,
    mangle: false,
  };

  // 管理端是 hash 路由，外链在当前页打开会把对话状态丢掉，统一改新窗口
  if (DOMPurify && typeof DOMPurify.addHook === 'function') {
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A' && node.getAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }

  // 用 DOMPurify 自带的 HTML + MathML + SVG 三套白名单：KaTeX 的上下标、间距靠
  // 行内 style 定位，大根号则是一段内联 SVG，少了哪样公式都会散架或缺笔画；
  // 原文里的 HTML 在 marked 那一步已经被转义（html 选项默认关闭），这里再挡掉能执行脚本的标签。
  const PURIFY = {
    USE_PROFILES: { html: true, mathMl: true, svg: true },
    ADD_ATTR: ['target', 'rel', 'data-md-copy', 'loading'],
    FORBID_TAGS: ['style', 'form', 'iframe', 'object', 'embed'],
  };

  // 解析失败时退化成纯文本，不能让气泡整个空掉
  const fallback = (src) => '<p class="md-p">' + esc(src).replace(/\n/g, '<br>') + '</p>';

  const render = (text) => {
    const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    if (!src.trim()) return '';
    let html;
    try {
      html = marked.parse(src, { ...OPTIONS });
    } catch (e) {
      return fallback(src);
    }
    if (!DOMPurify) return html;
    try {
      return DOMPurify.sanitize(html, PURIFY);
    } catch (e) {
      return fallback(src);
    }
  };

  root.LDMMD = { render };
})(window);
