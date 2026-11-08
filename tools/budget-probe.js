#!/usr/bin/env node
'use strict';
/* #I7 / #I9 重算预算探针（零依赖）
 * 运行：npm run probe:budget [仓库根目录]
 *
 * 用途：
 *  1. 对 SIR（epidemic）做 N 次冷缓存重算，统计 p50/p95/p99/max 与 >16ms 次数，
 *     复现「偶发 18ms 超预算」并量化它到底有多偶发；
 *  2. 输出 Engine.prototype.recompute 函数体的源码指纹，用来和未加 I9 的版本对比，
 *     区分「机器抖动」与「本次改动引入」；
 *  3. 强制把预算调到 1ms，验证超预算降级链路（告警事件 / degraded / 缓存扩容 /
 *     合并重算）确实生效，且降级前后数值一致。
 *
 * 对比示例：
 *   git worktree add --detach /tmp/ttk-head HEAD
 *   node tools/budget-probe.js /tmp/ttk-head
 *   node tools/budget-probe.js
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
var SAMPLES = Number(process.env.TTK_PROBE_N) || 100;
var BUDGET = 16;

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
var engine = TTK.createEngine();
TTK.templates.forEach(function (t) { engine.register(t); });
engine.select('epidemic');
var coldStart = engine.lastCostMs;   // 首次冷启动（JIT 未预热）就是最容易超预算的一次

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  var i = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}
function fingerprint(src) {
  var a = src.indexOf('Engine.prototype.recompute = function');
  var b = src.indexOf('Engine.prototype.requestRecompute', a);
  var body = a >= 0 && b > a ? src.slice(a, b) : '';
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
}
function r2(v) { return Math.round(v * 100) / 100; }

// 1. 冷缓存重算统计：关闭预算计数，避免告警干扰计时
engine.setBudget(0);
var costs = [];
for (var i = 0; i < SAMPLES; i++) {
  engine.recompute({ noCache: true });
  costs.push(engine.lastCostMs);
}
var sorted = costs.slice().sort(function (a, b) { return a - b; });
var over = costs.filter(function (c) { return c > BUDGET; }).length;
var p50 = percentile(sorted, 0.5), p95 = percentile(sorted, 0.95), p99 = percentile(sorted, 0.99);
var max = sorted[sorted.length - 1];

console.log('重算预算探针  root=' + ROOT);
console.log('  模板 epidemic · 冷缓存重算 ' + SAMPLES + ' 次（noCache）');
console.log('  首次冷启动=' + r2(coldStart) + 'ms（JIT 预热前，最容易超预算的一次）');
console.log('  p50=' + r2(p50) + 'ms  p95=' + r2(p95) + 'ms  p99=' + r2(p99) +
  'ms  max=' + r2(max) + 'ms');
console.log('  超过 ' + BUDGET + 'ms：' + over + ' / ' + SAMPLES +
  ' 次（' + r2(over / SAMPLES * 100) + '%）');
console.log('  recompute 源码指纹：' + fingerprint(fs.readFileSync(path.join(ROOT, 'src/core/engine.js'), 'utf8')));

// 2. 强制降级：把预算压到 1ms，几乎所有计算都会超预算
var events = [];
engine.on('budget', function (ctx) { events.push(ctx); });
engine.clearCache('epidemic');
engine.setBudget(1);
var before = JSON.stringify(engine.state.spec);
engine.recompute({ noCache: true });
var st = engine.stats();
var after = JSON.stringify(engine.state.spec);
var okDegrade = events.length === 1 && events[0].id === 'epidemic'
  && st.degraded.indexOf('epidemic') >= 0 && before === after;
console.log('  强制预算 1ms → budget 事件 ' + events.length + ' 条，degraded=' +
  JSON.stringify(st.degraded) + '，数值不变=' + (before === after));

// 3. 合并重算：同一轮多次请求只算一次，参数取最新，数值等价
engine.clearCache('epidemic');
engine.setBudget(1);
var recomputesBefore = engine.stats().recomputes;
engine.requestRecompute();
engine.requestRecompute();
engine.requestRecompute();
setTimeout(function () {
  var merged = engine.stats().recomputes - recomputesBefore;
  var degradedAgain = engine.stats().degraded.indexOf('epidemic') >= 0;
  console.log('  合并重算：3 次请求 → 实际重算 ' + merged + ' 次，degraded=' + degradedAgain);

  var pass = okDegrade && merged === 1 && degradedAgain;
  console.log('\n---------------------------------------------');
  console.log(pass ? '降级链路验收通过（超预算告警 / 缓存优先 / 合并重算 / 数值等价）'
    : '降级链路验收未通过');
  console.log('JSON ' + JSON.stringify({
    root: ROOT, samples: SAMPLES, coldStart: r2(coldStart), p50: r2(p50), p95: r2(p95), p99: r2(p99),
    max: r2(max), over16: over, overRate: r2(over / SAMPLES),
    recomputeHash: fingerprint(fs.readFileSync(path.join(ROOT, 'src/core/engine.js'), 'utf8')),
    degradeOk: okDegrade, mergedRecomputes: merged, templates: TTK.templates.length
  }));
  process.exit(pass ? 0 : 1);
}, 30);
