/*
 * 大肥鱼看板娘（右下角挂件）
 * ---------------------------------------------------------------------------
 * 脚本与素材来自 https://pet.alcy.cc —— dsh-pet 项目：
 *   代码 MIT；「大肥鱼」形象（DeepSeek 社区二创鲸鱼娘）为 CC BY-NC-SA 4.0，
 *   原作者明确禁止任何形式的商业化使用，商用前请自行替换或移除。
 *
 * 这里走外链按需加载：
 *   - 首次 show() 才插入 <script>，不阻塞控制台启动；
 *   - 离线 / 内网 / 被墙导致加载失败时静默跳过，只在控制台留一条 warn；
 *   - 窄屏由挂件自身 minViewport 隐藏（宽 < 768 或高 < 600）。
 *
 * 层级：挂在 document.body 上、z-index 压到 2147482999，比控制台任何东西都高
 * （弹窗遮罩 100/200、Toast 400 都在它下面），弹窗打开也盖不住它。
 * 交互：任何时候都能点、能拖、能右键点播，不做鼠标穿透 —— 弹窗期间照样能拖出去玩。
 */
(function () {
  'use strict';

  var SRC = 'https://pet.alcy.cc/dsh-pet.standalone.js';
  var SIZE = 260;              // 宽度 px，高度按 16:9 自动算
  var Z = 2147482999;          // 比 dsh-pet 自己的右键菜单（…3000）低 1
  var BASE_MX = 16;            // 距右边缘
  var BASE_MY = 8;             // 距底边

  var PHRASES = [
    '要不要试个新模型？',
    '今天的额度还够用吗',
    '渠道记得留一个备用哦',
    '慢一点也没关系～',
    '需要我帮你盯延迟吗',
    '这会儿上游应该没排队吧'
  ];

  var state = 'idle';   // idle | loading | ready | failed
  var want = false;     // 期望显示
  var busy = false;     // init 进行中
  var queue = [];
  var route = '';       // 最近一次布局用的路由名

  function load(fn) {
    if (state === 'ready') { fn(); return; }
    if (state === 'failed') return;
    queue.push(fn);
    if (state === 'loading') return;
    state = 'loading';
    var s = document.createElement('script');
    s.src = SRC;
    s.async = true;
    s.onload = function () {
      state = window.DSHPet && window.DSHPet.init ? 'ready' : 'failed';
      drain();
    };
    s.onerror = function () {
      state = 'failed';
      queue.length = 0;
      if (window.console) console.warn('[ldmapi] 看板娘脚本加载失败（离线或网络受限），已跳过');
    };
    document.head.appendChild(s);
  }

  function drain() {
    var q = queue.slice();
    queue.length = 0;
    q.forEach(function (fn) {
      try { fn(); } catch (e) { if (window.console) console.warn('[ldmapi] 看板娘初始化失败', e); }
    });
  }

  // 聊天页右下角被输入框和右侧的模型配置栏占满，挂件改贴「消息区」的右下角：
  // 右边对齐 .chat-main，底边抬到输入区之上，既不压发送按钮也不压配置项。
  function place() {
    var root = document.querySelector('.dsh-pet-root');
    if (!root) return;
    var mx = BASE_MX;
    var my = BASE_MY;
    if (route === 'chat') {
      var main = document.querySelector('.chat-main');
      var compose = document.querySelector('.chat-compose');
      if (main) {
        mx = Math.max(BASE_MX, Math.round(window.innerWidth - main.getBoundingClientRect().right) + BASE_MX);
      }
      if (compose) my = Math.round(compose.getBoundingClientRect().height) + BASE_MY + 8;
    }
    root.style.setProperty('--dsh-pet-mx', mx + 'px');
    root.style.setProperty('--dsh-pet-my', my + 'px');
  }

  // 聊天页的输入框会随内容长高、右侧配置栏会展开/收起，跟着重新摆位
  function watchChat() {
    if (!window.ResizeObserver) return;
    if (watchChat.ro) watchChat.ro.disconnect();
    var ro = new ResizeObserver(function () { place(); });
    ['.chat-main', '.chat-compose'].forEach(function (sel) {
      var el = document.querySelector(sel);
      if (el) ro.observe(el);
    });
    watchChat.ro = ro;
  }

  function watchResize() {
    if (watchResize.done) return;
    watchResize.done = true;
    window.addEventListener('resize', place);
  }

  function start() {
    if (busy || (window.DSHPet && window.DSHPet.instance)) return;
    busy = true;
    var p;
    try {
      p = window.DSHPet.init({
        size: SIZE,
        corner: 'bottom-right',
        marginX: BASE_MX,
        marginY: BASE_MY,
        zIndex: Z,
        phrases: PHRASES
      });
    } catch (e) {
      busy = false;
      if (window.console) console.warn('[ldmapi] 看板娘初始化失败', e);
      return;
    }
    Promise.resolve(p).then(function () {
      busy = false;
      if (!want) { stop(); return; }
      watchResize();
      place();
      // 首次露面打个招呼，之后按 whisperIntervalSec（默认 300s）自己冒泡
      window.setTimeout(function () {
        if (!want || !window.DSHPet || !window.DSHPet.instance) return;
        try { window.DSHPet.say('我是这儿的看板娘，有事点我～'); } catch (e) { /* ignore */ }
      }, 1200);
    }).catch(function (e) {
      busy = false;
      if (window.console) console.warn('[ldmapi] 看板娘初始化失败：' + ((e && e.message) || e));
    });
  }

  function stop() {
    want = false;
    if (window.DSHPet && window.DSHPet.instance) {
      try { window.DSHPet.destroy(); } catch (e) { /* ignore */ }
    }
  }

  window.LDMPet = {
    show: function () {
      want = true;
      if (state === 'failed') return;
      load(start);
    },
    hide: stop,
    // 路由切换后重新摆位（目前只有聊天页需要抬高）
    layout: function (name) {
      route = name || route;
      place();
      if (route === 'chat') watchChat();
    }
  };
})();
