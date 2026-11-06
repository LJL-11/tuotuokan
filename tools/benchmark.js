#!/usr/bin/env node
/* 拖拖看 · #I7 重算基准与运行时自检
 * ---------------------------------------------------------------
 * 零依赖，只读：`npm run bench` 或 `node tools/benchmark.js [样本组数]`
 *
 * 1) 逐模板跑参数拖动，输出单次重算的 p95 耗时：
 *    - p95(含缓存)：用户实际感受到的重算耗时
 *    - p95(真实计算)：仅未命中缓存的样本，用来判断 16ms 预算
 * 2) 自检：缓存不改变数值 / 缓存命中与容量 / 插件热插拔 /
 *    超预算告警与降级 / unregister 后图谱边同步消失 / 卸载当前模板后状态可用
 *
 * 故意不挂进 npm run check：机器性能波动不应让 CI 变红。
 * 性能数据只作参考，数值正确性由 npm test 与下方自检保证。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var ROOT = path.resolve(__dirname, '..');

/* ---- 按 index.html 的脚本顺序加载运行时（与 tools/verify.js 同构） ---- */
global.window = global;
global.localStorage = { getItem: function () { return null; }, setItem: function () {} };
global.document = { getElementById: function () { return null; } };
global.location = { hash: '' };
var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var srcs = [];
html.replace(/<script[^>]+src="([^"]+)"/g, function (_, s) { srcs.push(s); return _; });
srcs.filter(function (s) { return s.indexOf('/ui/app.js') < 0; })
  .forEach(function (s) { require(path.join(ROOT, s)); });
var TTK = global.TTK;

var SAMPLES = Math.max(20, parseInt(process.argv[2], 10) || 60);
var total = 0, failures = [];
function ok(name, cond, detail) {
  total++;
  var pass = !!cond;
  console.log((pass ? '  PASS  ' : '  FAIL  ') + name + (!pass && detail ? '  :: ' + detail : ''));
  if (!pass) failures.push(name + (detail ? ' :: ' + detail : ''));
}
function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
function ms(v) { return v.toFixed(2) + 'ms'; }
function pct(a, q) {
  if (!a.length) return 0;
  var s = a.slice().sort(function (x, y) { return x - y; });
  return s[Math.max(0, Math.min(s.length - 1, Math.ceil(q * s.length) - 1))];
}

var engine = TTK.createEngine();
TTK.templates.forEach(function (t) { engine.register(t); });

/* ---- 用插件收集逐次重算耗时：验证插件化能力，也避免侵入引擎 ---- */
var samples = [];
engine.use({
  id: 'bench.monitor',
  afterRecompute: function (ctx) {
    samples.push({ id: ctx.id, costMs: ctx.costMs, hit: ctx.cacheHit });
  }
});

function sampleParams(tpl, rand) {
  var p = {};
  tpl.params.forEach(function (d) {
    var steps = Math.max(1, Math.floor((d.max - d.min) / d.step + 0.5));
    p[d.key] = Number((d.min + Math.floor(rand() * (steps + 1)) * d.step).toFixed(4));
  });
  return p;
}

console.log('=== #I7 重算基准 · 每模板 ' + SAMPLES + ' 组参数 · 预算 ' + engine.budgetMs + 'ms ===');
console.log(pad('模板', 14) + pad('重算次数', 10) + pad('命中', 8) + pad('p95(含缓存)', 14) +
  pad('p95(真实计算)', 16) + pad('最大', 12) + pad('超预算', 8));

var rand = TTK.math.rng(20261106);
var budgetHits = 0;
engine.on('budget', function () { budgetHits++; });
TTK.templates.forEach(function (t) {
  engine.select(t.id);
  samples.length = 0;
  var budgetBefore = budgetHits, prev = null;
  for (var i = 0; i < SAMPLES; i++) {
    if (prev && i % 5 === 0) {
      engine.recompute();               // 同参数：必然命中缓存
    } else {
      prev = sampleParams(t, rand);
      t.params.forEach(function (d) { engine.setParam(d.key, prev[d.key]); });
    }
  }
  var all = samples.map(function (s) { return s.costMs; });
  var misses = samples.filter(function (s) { return !s.hit; }).map(function (s) { return s.costMs; });
  var hits = samples.filter(function (s) { return s.hit; }).length;
  console.log(pad(t.id, 14) + pad(samples.length, 10) +
    pad(Math.round(hits / (samples.length || 1) * 100) + '%', 8) +
    pad(ms(pct(all, 0.95)), 14) + pad(ms(pct(misses, 0.95)), 16) +
    pad(ms(Math.max.apply(null, all.concat([0]))), 12) +
    pad(budgetHits - budgetBefore, 8));
});
ok('基准产出了逐次重算样本', samples.length > 0, '实际 ' + samples.length);
ok('p95 分位数可计算', pct([3, 1, 2], 0.95) === 3, '');

/* ---- 自检 1：缓存不改变任何数值 ---- */
console.log('=== 自检：缓存 / 数值 / 插件 / 预算 / 图谱 ===');
var checked = 0, mismatches = [];
TTK.templates.forEach(function (t) {
  engine.select(t.id);
  var def = engine.defaults(t), cases = [def];
  t.params.forEach(function (d) {
    [d.min, d.max, (d.min + d.max) / 2].forEach(function (v) {
      var p = Object.assign({}, def); p[d.key] = v; cases.push(p);
    });
  });
  cases.forEach(function (p) {
    t.params.forEach(function (d) { engine.setParam(d.key, p[d.key]); });
    // 用引擎实际落地的参数（已 clamp / 按 step 取整）反算，命中缓存也必须逐点一致
    var direct = JSON.stringify(t.compute(Object.assign({}, engine.state.params), TTK.math));
    if (direct !== JSON.stringify(engine.state.spec)) mismatches.push(t.id);
    checked++;
  });
});
ok('引擎输出与直接 compute 逐点一致（' + checked + ' 组参数）', mismatches.length === 0,
  mismatches.slice(0, 3).join(', '));

engine.select(TTK.templates[0].id);
engine.clearCache();
engine.recompute();
var firstWasMiss = engine.lastCacheHit === false;
engine.recompute();
ok('同参数重算命中模板级缓存', firstWasMiss && engine.lastCacheHit === true, '');
engine.setCacheLimit(2);
engine.select(TTK.templates[0].id);
var cacheSize = 0;
for (var ci = 1; ci <= 5; ci++) engine.setParam(TTK.templates[0].params[0].key,
  TTK.templates[0].params[0].min + ci * TTK.templates[0].params[0].step);
cacheSize = engine.cacheStats().perTemplate[TTK.templates[0].id].size;
ok('缓存容量受上限约束', cacheSize <= 2, '实际 ' + cacheSize);
engine.setCacheLimit(64);
engine.clearCache();
ok('clearCache 清空所有模板缓存', engine.cacheStats().size === 0, '');

/* ---- 自检 2：插件运行时装卸 ---- */
var probeHits = 0;
engine.use({ id: 'bench.probe', afterRecompute: function () { probeHits++; } });
engine.select(TTK.templates[1].id);
var probeWith = probeHits;
ok('插件可用且收到重算钩子', probeWith > 0, '');
ok('重复插件 id 被拒绝', (function () {
  try { engine.use({ id: 'bench.probe' }); return false; } catch (e) { return true; }
})(), '');
ok('插件可卸载', engine.unuse('bench.probe') === true && engine.plugins().indexOf('bench.probe') < 0, '');
engine.select(TTK.templates[2].id);
ok('卸载后不再收到钩子', probeHits === probeWith, '');

/* ---- 自检 3：超预算告警 + 缓存优先降级 ---- */
function stub(id, prereqs, slow) {
  return {
    id: id, name: id, subject: '基准', icon: '◇', level: '', keywords: [],
    brief: '', concept: '', prerequisites: prereqs || [],
    params: [{ key: 'v', label: 'v', min: 0, max: 10, step: 1, default: 1, unit: '', hint: '' }],
    compute: function (p) {
      if (slow) { var t0 = Date.now(); while (Date.now() - t0 < 22) { /* 模拟昂贵重算 */ } }
      return {
        chart: { panels: [{ title: id, series: [{ name: 'y', points: [[0, p.v], [1, p.v * 2]], color: '#4f46e5' }] }] },
        metrics: [{ label: '值', value: p.v, digits: 2, tone: 'plain', hint: '' }],
        insight: '基准自检模板', m: {}
      };
    },
    challenges: []
  };
}

var slow = stub('bench_slow', ['gradient'], true);
engine.register(slow);
var warns = [], budgetEvents = 0, origWarn = console.warn;
console.warn = function (msg) { warns.push(String(msg)); };
engine.on('budget', function () { budgetEvents++; });
engine.select(slow.id);
engine.setParam('v', 2);
engine.setParam('v', 3);
console.warn = origWarn;
ok('超预算模板触发 budget 事件', budgetEvents >= 1, '实际 ' + budgetEvents);
ok('超预算模板输出告警（1 秒内节流）', warns.length >= 1, '实际 ' + warns.length);
ok('超预算模板进入降级名单', engine.stats().degraded.indexOf(slow.id) >= 0, '');
ok('告警文案含耗时与预算', warns.length > 0 && /ms >/.test(warns[0]), warns[0] || '');
engine.setBudget(0);
var beforeClose = budgetEvents;
engine.setParam('v', 4);
ok('setBudget(0) 可关闭预算检查', budgetEvents === beforeClose, '');
engine.setBudget(16);

/* ---- 自检 4：unregister 后图谱边同步消失 ---- */
var graph = TTK.createGraph(engine, TTK.data);
var midId = 'bench_edge_mid', leafId = 'bench_edge_leaf';
engine.register(stub(midId, ['gradient']));
engine.register(stub(leafId, [midId]));
var unregEvents = 0;
engine.on('unregister', function () { unregEvents++; });
var edgesBefore = graph.edges();
var hasBefore = edgesBefore.some(function (e) { return e.from === midId || e.to === midId; });
ok('注册后图谱出现对应先修边', hasBefore, JSON.stringify(edgesBefore.filter(function (e) { return e.to === midId || e.to === leafId; })));
engine.unregister(midId);
var edgesAfter = graph.edges();
ok('unregister 后图谱对应边同步消失',
  !edgesAfter.some(function (e) { return e.from === midId || e.to === midId; }), JSON.stringify(edgesAfter));
ok('unregister 广播事件', unregEvents === 1, '实际 ' + unregEvents);
ok('unregister 清掉该模板缓存', !engine.cacheStats().perTemplate[midId], '');
engine.unregister(leafId);
engine.select(slow.id);
engine.unregister(slow.id);
ok('卸载当前模板后自动切到可用模板', !!engine.currentId && engine.currentId !== slow.id && !!engine.state,
  'currentId=' + engine.currentId);
ok('卸载后 get() 返回空', engine.get(slow.id) === null, '');

/* ---- 自检 5：降级合并重算（异步，参数取最新、数值不变） ---- */
var slow2 = stub('bench_slow2', [], true);
engine.register(slow2);
engine.select(slow2.id);
engine.setParam('v', 2);                 // 制造一次真实超预算，进入降级
var degradedNow = engine.stats().degraded.indexOf(slow2.id) >= 0;
var revBefore = engine.state.revision;
var directBefore = JSON.stringify(slow2.compute(Object.assign({}, engine.state.params), TTK.math));
engine.requestRecompute();
engine.requestRecompute();
engine.requestRecompute();
setTimeout(function () {
  ok('降级模式下合并同一轮多次重算请求', engine.state.revision === revBefore + 1,
    'revision ' + revBefore + ' -> ' + engine.state.revision);
  ok('合并重算不改变数值', JSON.stringify(engine.state.spec) === directBefore, '');
  ok('降级标记来自超预算模板', degradedNow, '');
  engine.unregister(slow2.id);
  finish();
}, 20);

function finish() {
  console.log('\n---------------------------------------------');
  if (failures.length) {
    console.log('自检未通过：' + failures.length + ' / ' + total + ' 项失败');
    failures.forEach(function (f) { console.log('  - ' + f); });
    process.exit(1);
  }
  console.log('基准完成：' + total + ' 项自检通过，0 失败');
  process.exit(0);
}
