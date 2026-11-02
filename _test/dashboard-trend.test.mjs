// 数据看板「调用趋势」曲线的行为测试。
// 直接从 pages-more.js 源码里抽出 paintTrend 来跑，测的是真实代码而不是复制品。
// 用法：node --test _test/dashboard-trend.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'web/assets/pages-more.js'), 'utf8');

// 按大括号配对抽出函数源码。模板字符串里的 ${} 是配对的，不影响计数。
function extractFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`找不到函数 ${name}`);
  let depth = 0;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) return SRC.slice(start, i + 1);
    }
  }
  throw new Error(`函数 ${name} 大括号不配对`);
}

const PAINT_TREND = extractFn('paintTrend');
const KNOWN_FLAGS = extractFn('knownFlags');
const FMT_DASH = extractFn('fmtDash');
const COLORS = SRC.match(/const DASH_MODEL_COLORS = \[[\s\S]*?\];/)[0];

// 一个模型的 token 序列：有数据的 A / B，和完全没有 token 数据的 C。
function makeData(opts = {}) {
  const noToken = opts.noToken === true;
  return {
    overview: { current: { requests: 30, total_tokens: noToken ? 0 : 450, speed_samples: 1 } },
    series: {
      step_ms: 3600000,
      points: [
        { time: 1, requests: 10, errors: 1, prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        { time: 2, requests: 20, errors: 2, prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
      ],
      model_series: {
        模型A: {
          requests: [6, 12], errors: [0, 1],
          prompt_tokens: [60, 120], completion_tokens: [30, 60], total_tokens: [90, 180],
        },
        模型B: {
          requests: [4, 8], errors: [1, 1],
          prompt_tokens: [40, 80], completion_tokens: [20, 40], total_tokens: [60, 120],
        },
        模型C: {
          requests: [0, 0], errors: [0, 0],
          prompt_tokens: [0, 0], completion_tokens: [0, 0], total_tokens: [0, 0],
        },
      },
    },
    breakdown: {
      models: [
        { name: '模型A', value: 18, errors: 1 },
        { name: '模型B', value: 12, errors: 2 },
        { name: '模型C', value: 0, errors: 0 },
      ],
      total: 30, errors: 3, tokens_used: 450,
    },
  };
}

// vm 里的数组原型和主 realm 不同，deepStrictEqual 会误判「结构相同但不相等」，
// 所以统一先摊平成主 realm 的普通数组再比较。
const names = (opts) => [...opts.series].map((s) => s.name);
const values = (opts, i) => [...opts.series[i].values];

// 跑一次 paintTrend，返回它交给 areaChart 的参数和图下注解。
function run(metric, kind, id, data = makeData()) {
  let captured = null;
  const dom = { trendSub: { textContent: '' }, note: { textContent: '' } };
  const ctx = {
    console,
    dashData: data,
    dashSel: { kind, id },
    dashMetric: { m: metric },
    dashUnit: { mode: 'none' },
    DASH_MODEL_COLORS: undefined,
    dom,
    hideTip: () => {},
    timeLabel: (ms) => String(ms),
    fmtDash: undefined,
    knownFlags: undefined,
    dashRangeInfo: () => ({ label: '今日' }),
    areaChart: (_el, opts) => { captured = opts; },
  };
  vm.createContext(ctx);
  vm.runInContext(`${COLORS}\n${FMT_DASH}\n${KNOWN_FLAGS}\n${PAINT_TREND}`, ctx);
  ctx.paintTrend();
  return { opts: captured, sub: dom.trendSub.textContent, note: dom.note.textContent };
}

test('Token 维度 · 各模型：每个模型一条总 Token 曲线', () => {
  const { opts, sub, note } = run('tokens', 'all', '');
  assert.deepEqual(names(opts), ['模型A', '模型B', '模型C'], '每个模型都要有曲线，和请求数维度一致');
  assert.deepEqual(values(opts, 0), [90, 180], '曲线值是各模型的总 Token');
  assert.deepEqual(values(opts, 1), [60, 120]);
  assert.deepEqual(values(opts, 2), [0, 0], '没有 Token 数据的模型画 0 线');
  assert.equal(opts.totalFrom, null, '各模型视图的总计 = 各曲线之和');
  assert.match(sub, /总 Token/);
  assert.match(note, /1 个模型没有 Token 数据/, '要说明有几个模型缺 Token 数据');
});

test('Token 维度 · 总计：输入 / 输出 / 总 Token 三条线', () => {
  const { opts, sub } = run('tokens', 'total', '');
  assert.deepEqual(names(opts), ['输入 Token', '输出 Token', '总 Token']);
  assert.deepEqual(values(opts, 2), [150, 300]);
  assert.equal(opts.totalFrom, '总 Token', '总计只能取总 Token，否则输入+输出+总会重复相加');
  assert.match(sub, /总 Token/);
});

test('Token 维度 · 单个模型：输入 / 输出 / 总 Token 三条线', () => {
  const { opts, sub } = run('tokens', 'model', '模型A');
  assert.deepEqual(names(opts), ['输入 Token', '输出 Token', '总 Token']);
  assert.equal(opts.totalFrom, '总 Token');
  assert.match(sub, /模型A/);
});

test('Token 维度 · 老数据没有按模型的序列：退回整体构成', () => {
  const data = makeData();
  data.series.model_series = {};
  const { opts, sub } = run('tokens', 'all', '', data);
  assert.deepEqual(names(opts), ['输入 Token', '输出 Token', '总 Token']);
  assert.equal(opts.totalFrom, '总 Token');
  assert.match(sub, /总计/);
});

test('请求数维度 · 各模型：每个模型一条请求数曲线 + 一条总失败数', () => {
  const { opts } = run('requests', 'all', '');
  assert.deepEqual(names(opts), ['模型A', '模型B', '模型C', '失败数']);
  assert.deepEqual(values(opts, 0), [6, 12]);
  assert.equal(opts.series[3].noTotal, true, '失败数不计入总计');
  assert.equal(opts.totalFrom, null);
});

test('请求数维度 · 单个模型：请求数 / 成功数 / 失败数三条线', () => {
  const { opts } = run('requests', 'model', '模型A');
  assert.deepEqual(names(opts), ['请求数', '成功数', '失败数']);
  assert.equal(opts.totalFrom, '请求数');
});

test('Token 维度 · 单个模型没有 Token 记录时给出说明', () => {
  const data = makeData({ noToken: true });
  const { note } = run('tokens', 'model', '模型A', data);
  assert.match(note, /该模型没有 Token 记录/);
});

// ---------------------------------------------------------------------------
// 图例：数字口径要跟着上面的维度切换
// ---------------------------------------------------------------------------

const PAINT_LEGEND = extractFn('paintLegend');

function legend(metric) {
  const data = makeData();
  data.breakdown.models = [
    { name: '模型A', value: 18, errors: 1, tokens: 2700 },
    { name: '模型B', value: 12, errors: 2, tokens: 1800 },
    { name: '模型C', value: 0, errors: 0, tokens: 0 },
  ];
  data.breakdown.tokens_used = 4500;
  const dom = { legend: { innerHTML: '', querySelectorAll: () => [] } };
  const ctx = {
    console,
    dashData: data,
    dashSel: { kind: 'all', id: '' },
    dashMetric: { m: metric },
    dashUnit: { mode: 'none' },
    DASH_MODEL_COLORS: undefined,
    dom,
    esc: (s) => String(s),
    fmtDash: undefined,
  };
  vm.createContext(ctx);
  vm.runInContext(`${COLORS}\n${FMT_DASH}\n${PAINT_LEGEND}`, ctx);
  ctx.paintLegend();
  return dom.legend.innerHTML;
}

test('图例 · 请求数维度：模型后面是调用次数', () => {
  const html = legend('requests');
  assert.match(html, /模型A[\s\S]*?<b>18<\/b>/, '模型A 的数字应是调用次数 18');
  assert.doesNotMatch(html, /<b>2,?700<\/b>/, 'Token 维度才显示 Token 数');
});

test('图例 · Token 维度：模型后面是 Token 消耗', () => {
  const html = legend('tokens');
  assert.match(html, /模型A[\s\S]*?<b>2,?700<\/b>/, '模型A 的数字应是 Token 消耗 2700');
  assert.doesNotMatch(html, /模型A[\s\S]*?<b>18<\/b>/, '请求数维度才显示调用次数');
});

test('图例 · 总计项的数字跟着维度走', () => {
  assert.match(legend('requests'), /总计[\s\S]*?<b>30<\/b>/);
  assert.match(legend('tokens'), /总计[\s\S]*?<b>4,?500<\/b>/);
});
