/* ==========================================================================
   气泡里的 Markdown 渲染
   —— 解析用 marked v12（MIT），消毒用 DOMPurify 3.2.6（Apache-2.0 / MPL-2.0）
   两个库都放在 assets 目录里随二进制一起分发，不引 CDN，内网与离线环境照常可用。
   这里只做三件事：套一份适合聊天的解析配置、给代码块加复制工具栏、喂给
   DOMPurify 走一遍白名单（模型输出等同于不可信输入，不能直接塞 innerHTML）。
   ========================================================================== */
(function (root) {
  'use strict';

  const marked = root.marked;
  const DOMPurify = root.DOMPurify;
  if (!marked) return;

  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

  // 代码块自己加一条工具栏：左边语言、右边复制按钮（复制走页面上的事件代理）
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

  // 表格包一层可横向滚动的容器，列多的表不会把气泡撑破
  renderer.table = (header, body) => '<div class="md-table-wrap"><table>'
    + `<thead>${header}</thead><tbody>${body}</tbody>`
    + '</table></div>';

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

  // 白名单只放行 Markdown 会产出的标签；样式统一写在 app.css 里，不接收 style
  const PURIFY = {
    ALLOWED_TAGS: [
      'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'strong', 'em', 'del', 'code', 'pre', 'blockquote',
      'ul', 'ol', 'li', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'span', 'div', 'button', 'input', 'sup', 'sub', 'kbd', 'details', 'summary',
    ],
    ALLOWED_ATTR: [
      'href', 'title', 'src', 'alt', 'class', 'start', 'type', 'value',
      'colspan', 'rowspan', 'align', 'reversed', 'checked', 'disabled',
      'loading', 'target', 'rel', 'data-md-copy',
    ],
    ALLOW_DATA_ATTR: true,
  };

  // 解析失败时退化成纯文本，不能让气泡整个空掉
  const fallback = (src) => '<p class="md-p">' + esc(src).replace(/\n/g, '<br>') + '</p>';

  const render = (text) => {
    const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    if (!src.trim()) return '';
    let html;
    try {
      html = marked.parse(src, { ...OPTIONS, renderer });
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
