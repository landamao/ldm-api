// 数据看板「模型调用分布」环形图的口径切换行为测试。
// 直接从 pages-more.js 源码里抽出 paintDonut 来跑，测的是真实代码而不是复制品。
// 用法：node --test _test/dashboard-donut.test.mjs
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

const PAINT_DONUT = extractFn('paintDonut');
const MODEL_COLORS_FN = extractFn('dashModelColors');
const MODEL_LIST_FN = extractFn('dashModelList');
const FMT_DASH = extractFn('fmtDash');
const COLORS = SRC.match(/const DASH_MODEL_COLORS = \[[\s\S]*?\];/)[0];

// 三个模型：A / B 正常，C 只有调用没有 Token。
// D 调用次数不多（排不进「调用次数前 12」）但 Token 消耗最高，
// 只能从后端另给的「按 Token 排」列表里看到。
function makeBreakdown() {
  return {
    models: [
      { name: '模型A', value: 18, errors: 1, tokens: 2700 },
      { name: '模型B', value: 12, errors: 2, tokens: 1800 },
      { name: '模型C', value: 0, errors: 0, tokens: 0 },
    ],
    models_by_tokens: [
      { name: '模型D', value: 3, errors: 0, tokens: 9900 },
      { name: '模型A', value: 18, errors: 1, tokens: 2700 },
      { name: '模型B', value: 12, errors: 2, tokens: 1800 },
    ],
    total: 33, errors: 3, tokens_used: 14400,
  };
}

// 跑一次 paintDonut，返回它交给 donutChart 的参数和副标题。
function run(metric, opts = {}) {
  let captured = null;
  const breakdown = opts.breakdown || makeBreakdown();
  const dom = { donutSub: { textContent: '' }, donut: {} };
  const ctx = {
    console,
    dashData: { breakdown },
    dashSel: { kind: opts.kind || 'all', id: opts.id || '' },
    dashDonutMetric: { m: metric },
    dashUnit: { mode: 'none' },
    DASH_MODEL_COLORS: undefined,
    dom,
    fmtDash: undefined,
    donutChart: (_el, o) => { captured = o; },
    dashRangeInfo: () => ({ label: '今日' }),
  };
  vm.createContext(ctx);
  vm.runInContext(`${COLORS}\n${FMT_DASH}\n${MODEL_LIST_FN}\n${MODEL_COLORS_FN}\n${PAINT_DONUT}`, ctx);
  ctx.paintDonut();
  // vm 里造出来的对象原型和主 realm 不同，摊平成主 realm 的普通对象再比较。
  const items = Array.from(captured.items, (i) => ({ name: i.name, value: i.value, color: i.color }));
  return { items, centerLabel: captured.centerLabel, sub: dom.donutSub.textContent };
}

test('请求数口径：环上的值是调用次数，中心标签是「总调用」', () => {
  const { items, centerLabel, sub } = run('requests');
  assert.deepEqual(items.map((i) => i.name), ['模型A', '模型B', '模型C']);
  assert.deepEqual(items.map((i) => i.value), [18, 12, 0]);
  assert.equal(centerLabel, '总调用');
  assert.match(sub, /按调用次数/);
});

test('Token 口径：环上的值是 Token 消耗，中心标签是「总 Token」', () => {
  const { items, centerLabel, sub } = run('tokens');
  assert.deepEqual(items.map((i) => i.name), ['模型D', '模型A', '模型B']);
  assert.deepEqual(items.map((i) => i.value), [9900, 2700, 1800]);
  assert.equal(centerLabel, '总 Token');
  assert.match(sub, /按 Token 消耗/);
});

test('Token 口径用的是「按 Token 排」的模型列表', () => {
  // 模型D 调用次数只有 3 次，排不进「调用次数前 12」，但 Token 消耗最高，不能漏掉
  const { items } = run('tokens');
  assert.ok(items.some((i) => i.name === '模型D'), '调用不多但很耗 Token 的模型要在环里');
});

test('Token 口径下按 Token 数从大到小排', () => {
  const { items } = run('tokens');
  const vals = items.map((i) => i.value);
  assert.deepEqual(vals, [...vals].sort((a, b) => b - a));
});

test('没有 Token 记录的模型不进 Token 口径的环', () => {
  const { items } = run('tokens');
  assert.ok(!items.some((i) => i.name === '模型C'), '模型C 没有 Token 记录，不该显示成一个 0');
});

test('颜色跟着模型走：切口径后同一个模型颜色不变', () => {
  const req = run('requests').items;
  const tok = run('tokens').items;
  const colorOf = (list, name) => (list.find((i) => i.name === name) || {}).color;
  assert.equal(colorOf(tok, '模型A'), colorOf(req, '模型A'), '模型A 的颜色在两种口径下要一致');
  assert.equal(colorOf(tok, '模型B'), colorOf(req, '模型B'));
  assert.ok(colorOf(tok, '模型D'), '只出现在 Token 列表里的模型也要有颜色');
});

test('老数据没有按模型记 Token 时，副标题要说明', () => {
  const breakdown = makeBreakdown();
  breakdown.models = breakdown.models.map((m) => ({ ...m, tokens: 0 }));
  breakdown.models_by_tokens = breakdown.models.map((m) => ({ ...m, tokens: 0 }));
  const { items, sub } = run('tokens', { breakdown });
  assert.equal(items.length, 0);
  assert.match(sub, /历史数据未按模型记录 Token/);
});

test('选中单个模型时，其余模型变灰', () => {
  const { items } = run('requests', { kind: 'model', id: '模型A' });
  const colorOf = (name) => (items.find((i) => i.name === name) || {}).color;
  assert.equal(colorOf('模型A'), '#4d9e2f', '当前模型保持高亮');
  assert.equal(colorOf('模型B'), 'var(--border)', '其余模型变灰');
});
