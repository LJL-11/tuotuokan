#!/usr/bin/env node
/* 拖拖看 · 本地与 CI 共用的全量校验
 * 零依赖：只用 Node 内置模块。运行 `npm test` 或 `node tools/verify.js`。
 * 覆盖：语法 / 脚本路径与顺序 / DOM 引用 / 契约 JSON 与样例 / 模板数值 /
 *       DSL 编译挂载 / 表达式白名单 / 图谱与数据层 / 占位模块 / 挑战可达性 /
 *       I13 数据层统一与旧数据迁移 / 应用层装配冒烟 / I1 四视图路由。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var ROOT = path.resolve(__dirname, '..');

var total = 0, failed = [];
function ok(name, cond, detail) {
  total++;
  var pass = !!cond;
  console.log((pass ? '  PASS  ' : '  FAIL  ') + name + (!pass && detail ? '  :: ' + detail : ''));
  if (!pass) failed.push(name + (detail ? ' :: ' + detail : ''));
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }
function walk(dir, out) {
  out = out || [];
  var base = path.join(ROOT, dir);
  if (!fs.existsSync(base)) return out;
  fs.readdirSync(base, { withFileTypes: true }).forEach(function (e) {
    var rel = dir ? dir + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (['.git', 'node_modules', '.local', 'dist', 'build'].indexOf(e.name) >= 0) return;
      walk(rel, out);
    } else out.push(rel);
  });
  return out;
}

console.log('=== 1. JavaScript 语法 ===');
var jsFiles = walk('src').concat(walk('tools')).filter(function (f) { return /\.js$/.test(f); });
jsFiles.forEach(function (f) {
  var msg = '';
  try { cp.execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' }); }
  catch (e) { msg = String(e.stderr || e.message).split('\n').slice(0, 3).join(' '); }
  ok('语法 ' + f, !msg, msg);
});

console.log('=== 2. index.html 脚本路径与依赖顺序 ===');
var html = read('index.html');
var srcs = [];
html.replace(/<script[^>]+src="([^"]+)"/g, function (_, s) { srcs.push(s); return _; });
ok('脚本标签数量 >= 8', srcs.length >= 8, '实际 ' + srcs.length);
var missing = srcs.filter(function (s) { return !exists(s); });
ok('所有脚本路径存在', missing.length === 0, missing.join(', '));
function idx(part) { return srcs.map(function (s) { return s.indexOf(part) >= 0; }).indexOf(true); }
ok('加载顺序符合依赖', idx('core/engine.js') >= 0 && idx('core/engine.js') < idx('core/expr.js')
  && idx('core/expr.js') < idx('model/dsl.js')
  && idx('viz/render.js') < idx('model/templates.js')
  && idx('ui/app.js') === srcs.length - 1, srcs.join(' -> '));

console.log('=== 3. DOM 引用完整性 ===');
var ids = {};
html.replace(/id="([^"]+)"/g, function (_, a) { ids[a] = 1; return _; });
var appSrc = read('src/ui/app.js');
var refs = {};
var reDollar = /\$\((['"])([^'"]+)\1\)/g, reGet = /getElementById\((['"])([^'"]+)\1\)/g, m;
while ((m = reDollar.exec(appSrc))) refs[m[2]] = 1;
while ((m = reGet.exec(appSrc))) refs[m[2]] = 1;
var missingIds = Object.keys(refs).filter(function (k) { return !ids[k]; });
ok('app.js 引用的 DOM id 均存在（' + Object.keys(refs).length + ' 个）', missingIds.length === 0, missingIds.join(', '));

console.log('=== 4. 共享契约与可执行样例 ===');
var contractFiles = [
  'contracts/template.schema.json',
  'contracts/learning-trace.schema.json',
  'contracts/examples/spring.json',
  'contracts/examples/trace.json',
  'package.json'
];
var parsed = {};
contractFiles.forEach(function (f) {
  var good = true, err = '';
  try { parsed[f] = JSON.parse(read(f)); } catch (e) { good = false; err = e.message; }
  ok('JSON 可解析 ' + f, good, err);
});
var spring = parsed['contracts/examples/spring.json'] || {};
ok('spring 样例字段完整', !!(spring.id && spring.name && spring.x && spring.params && spring.series && spring.metrics), '');
ok('trace 样例为 v1 且含 events', parsed['contracts/examples/trace.json']
  && parsed['contracts/examples/trace.json'].schema === 'ttk.learning-trace.v1'
  && Array.isArray(parsed['contracts/examples/trace.json'].events), '');
var schema = parsed['contracts/template.schema.json'] || {};
ok('模板 schema 声明了必填字段', Array.isArray(schema.required) && schema.required.indexOf('params') >= 0, '');

console.log('=== 5. 加载运行时模块 ===');
global.window = global;
global.localStorage = { getItem: function () { return null; }, setItem: function () {} };
global.document = { getElementById: function () { return null; } };
global.location = { hash: '' };
var loadError = '';
try {
  srcs.filter(function (s) { return s.indexOf('/ui/app.js') < 0; })
    .forEach(function (s) { require(path.join(ROOT, s)); });
} catch (e) { loadError = e.stack || e.message; }
ok('模块按页面顺序加载无异常', !loadError, loadError);
if (loadError) { finish(); }

var TTK = global.TTK;
ok('全局命名空间导出完整', !!(TTK.math && TTK.Engine && TTK.expr && TTK.dsl
  && TTK.Renderer && TTK.templates && TTK.data && TTK.createGraph && TTK.views && TTK.generator), '');

console.log('=== 6. 模板默认与极值参数数值稳定性 ===');
function issuesOf(r) {
  var out = [];
  if (!r || typeof r !== 'object') return ['compute 返回值不是对象'];
  var panels = (r.chart && r.chart.panels) || [];
  if (!panels.length) out.push('缺少 chart.panels');
  panels.forEach(function (p, i) {
    var ss = p.series || [];
    if (!ss.length) out.push('panel[' + i + '] 无 series');
    ss.forEach(function (s, j) {
      var pts = s.points || [];
      if (!pts.length) out.push('panel[' + i + '].series[' + j + '] 无点');
      for (var k = 0; k < pts.length; k++) {
        var q = pts[k];
        if (!q || !isFinite(q[0]) || !isFinite(q[1])) { out.push('panel[' + i + '].series[' + j + '] 有非法坐标'); break; }
      }
    });
  });
  (r.metrics || []).forEach(function (mt) {
    if (typeof mt.value === 'number' && !isFinite(mt.value)) out.push('指标 ' + mt.label + ' 非有限数');
  });
  if (typeof r.insight !== 'string') out.push('insight 缺失');
  return out.filter(function (v, i, a) { return a.indexOf(v) === i; }).slice(0, 3);
}

var engine = TTK.createEngine();
TTK.templates.forEach(function (t) { engine.register(t); });
ok('内置模板 >= 6', TTK.templates.length >= 6, '实际 ' + TTK.templates.length);
TTK.templates.forEach(function (t) {
  var def = engine.defaults(t), probs = [];
  try { probs = probs.concat(issuesOf(t.compute(def, TTK.math))); }
  catch (e) { probs.push('默认参数抛错: ' + e.message); }
  t.params.forEach(function (d) {
    [d.min, d.max].forEach(function (v) {
      var p = Object.assign({}, def); p[d.key] = v;
      try { probs = probs.concat(issuesOf(t.compute(p, TTK.math))); }
      catch (e) { probs.push('极值 ' + d.key + '=' + v + ' 抛错: ' + e.message); }
    });
  });
  ok('数值稳定 ' + t.id + '（默认 + ' + (t.params.length * 2) + ' 组极值）', probs.length === 0, probs.slice(0, 3).join(' / '));
});

console.log('=== 7. DSL 校验 / 编译 / 挂载 ===');
var dv = TTK.dsl.validate(TTK.dsl.example, []);
ok('dsl.example 通过校验', dv.ok, (dv.errors || []).join('; '));
var dslTpl, dslRun = '';
try {
  dslTpl = TTK.dsl.compile(TTK.dsl.example, dv);
  var e2 = TTK.createEngine(); e2.register(dslTpl); e2.select(dslTpl.id); e2.setParam('k', 6);
  if (!e2.state.spec.chart.panels.length || !e2.state.spec.metrics.length) dslRun = '编译产物产出为空';
  if (!dslTpl.challenges[0].check({ A: 1, k: 6 }, e2.state.spec.m)) dslRun = '挑战 check 在 k=6 未命中';
} catch (e) { dslRun = e.message; }
ok('DSL 编译产物可运行且挑战生效', !dslRun, dslRun);
var sv = TTK.dsl.validate(spring, TTK.templates.map(function (t) { return t.id; }));
ok('契约样例 spring.json 可编译注册', sv.ok, (sv.errors || []).join('; '));
var mountRes = TTK.generator.mount(engine, TTK.generator.generate('测试概念').spec);
ok('generator 降级草稿可安全挂载', mountRes.ok, (mountRes.errors || []).join('; '));
ok('generator 明确标注非 AI 生成', TTK.generator.generate('x').ai === false, '');

console.log('=== 8. 表达式白名单（安全边界） ===');
var evil = ['window.alert(1)', 'p.constructor', 'Math.constructor', 'global.process',
  '0);alert(1);//', '(function(){})()', 'a[0]', 'x = 1', 'Math["sin"]', '__proto__'];
evil.forEach(function (s) { ok('拒绝 ' + JSON.stringify(s), !TTK.expr.validate(s).ok, ''); });
var good = ['Math.sin(p.k * x)', 'p.k >= 5 && p.A < 2', 'M.clamp(p.A, 0, 3)', '2^3^2'];
good.forEach(function (s) { ok('允许 ' + s, TTK.expr.validate(s).ok, ''); });
ok('幂运算右结合 2^3^2 = 512', Math.abs(TTK.expr.eval('2^3^2', TTK.expr.scope({}, TTK.math)) - 512) < 1e-9, '');

console.log('=== 8b. I8：表达式边界与恶意输入 ===');
var X8 = TTK.expr;
var sep8 = String.fromCharCode(0x2028), nbsp8 = String.fromCharCode(0x00a0);
var nul8 = String.fromCharCode(0), lf8 = String.fromCharCode(10);
function scope8(p) { return X8.scope(p || { k: 2, A: 3 }, TTK.math); }
function rejected8(src) { return !X8.validate(src).ok; }
function throws8(src, sc) {
  try { X8.eval(src, sc || scope8()); return false; } catch (e) { return true; }
}
function value8(src, sc) { return X8.eval(src, sc || scope8()); }
function near8(src, expected) {
  var v = value8(src);
  return typeof v === 'number' && Math.abs(v - expected) < 1e-9;
}

// 构造的恶意输入：必须在 validate（编译前）阶段就被拒，绝不进到求值
var evil8 = [
  'Math.random()', 'M.rng(1)', 'Math.sin.call(null, 1)',
  'Math.sin.apply(null, 1)', 'p.k.call(1)', 'p.foo(1)',
  'p.hasOwnProperty(1)', 'm.v0.constructor',
  'p.__defineGetter__("A", 1)', 'p.hasOwnProperty("A")',
  'abs.valueOf()', 'Math.constructor.constructor("return 1")()',
  'globalThis["alert"](1)', 'document.cookie', 'process.exit(1)',
  'new Function("return 1")()', 'eval("1+1")', 'this', 'x++',
  'x = 1', '1;alert(1)', 'p.A[0]', 'Math["sqrt"](4)',
  'p.', 'Math.', 'Math..sin', 'p.A.B', 'x.y', 'p.A + window',
  'p.A' + sep8 + '+1', 'p.A' + nbsp8 + '+1', 'p.A' + nul8 + '+1'
];
evil8.forEach(function (s) {
  var r8 = X8.validate(s);
  ok('I8 拒绝 ' + JSON.stringify(s), !r8.ok, r8.ok ? '危险表达式被放行' : '');
});

// 白名单内的合法公式不能被加固误伤
var good8 = [
  'p.A * Math.cos(Math.sqrt(p.k) * x)', '2 * PI / Math.sqrt(p.k)',
  'M.clamp(p.A, 0, 3)', 'abs(-3)', 'min(2, 3)', 'max(2, 3)',
  'Math.pow(p.k, 2)', 'p.k >= 3 && p.A < 5', 'x > 0 ? p.A : -p.A',
  'm.v0 >= 0', 'p.A' + lf8 + '+ 1'
];
good8.forEach(function (s) {
  var r8 = X8.validate(s);
  ok('I8 允许 ' + JSON.stringify(s), r8.ok, r8.error || '');
});

// 边界：除零、溢出、深嵌套、幂结合性
ok('I8 字面量除零 1/0 编译前拒绝', rejected8('1/0'));
ok('I8 字面量除零 0/0 编译前拒绝', rejected8('0/0'));
ok('I8 取模除零 1%0 编译前拒绝', rejected8('1%0'));
ok('I8 变量式 x/0 编译前拒绝', rejected8('x/0'));
ok('I8 常量折叠后除零 1/(2-2) 编译前拒绝', rejected8('1/(2-2)'));
ok('I8 动态分母为零时求值抛错', throws8('p.k / (p.k - p.k)'));
ok('I8 字面量溢出 1e400 编译前拒绝', rejected8('1e400'));
ok('I8 常量乘法溢出 1e308*1e308 编译前拒绝', rejected8('1e308 * 1e308'));
ok('I8 常量幂溢出 2^1024 编译前拒绝', rejected8('2^1024'));
ok('I8 函数结果 Infinity 求值抛错', throws8('Math.pow(10, 1000)'));
ok('I8 函数结果 NaN 求值抛错', throws8('Math.sqrt(-1)'));
var deepParen8 = new Array(41).join('(') + '1' + new Array(41).join(')');
var deepNot8 = new Array(61).join('!') + '1';
var deepPow8 = new Array(41).join('2^') + '2';
var okParen8 = new Array(31).join('(') + '1' + new Array(31).join(')');
ok('I8 深嵌套 40 层括号编译前拒绝', rejected8(deepParen8));
ok('I8 深嵌套 60 个一元 ! 编译前拒绝', rejected8(deepNot8));
ok('I8 深嵌套 40 连环幂编译前拒绝', rejected8(deepPow8));
ok('I8 30 层括号仍在预算内且值正确', X8.validate(okParen8).ok && value8(okParen8) === 1);
ok('I8 幂右结合 2^3^2 = 512', near8('2^3^2', 512));
ok('I8 幂右结合 2^2^3 = 256', near8('2^2^3', 256));
ok('I8 括号改变结合 (2^3)^2 = 64', near8('(2^3)^2', 64));
ok('I8 一元负号优先级低于幂 -2^2 = -4', near8('-2^2', -4));
ok('I8 括号优先 (-2)^2 = 4', near8('(-2)^2', 4));
ok('I8 负指数 2^-2 = 0.25', near8('2^-2', 0.25));
ok('I8 取模 10%3 = 1', near8('10%3', 1));
ok('I8 比较返回布尔', value8('p.k >= 2') === true);
ok('I8 三元与一元负号', near8('x > 1 ? p.A : -p.A', -3));
ok('I8 裸函数 abs(-3) = 3', near8('abs(-3)', 3));
ok('I8 裸函数 clamp(5,0,3) = 3', near8('clamp(5, 0, 3)', 3));
ok('I8 Math.sqrt(9) = 3', near8('Math.sqrt(9)', 3));
ok('I8 M.clamp(5,0,3) = 3', near8('M.clamp(5, 0, 3)', 3));

// 作用域与输入类型：原型链不可达、非字符串/超长/超量输入一律编译前拒绝
ok('I8 未知参数运行时抛错', throws8('p.zzz'));
ok('I8 原型链属性运行时不可达', throws8('p.hasOwnProperty'));
ok('I8 作用域不暴露宿主 Math 对象', X8.scope({}, TTK.math).Math !== Math);
ok('I8 作用域不暴露 Math.random', typeof X8.scope({}, TTK.math).Math.random === 'undefined');
var badTypes8 = [
  [null, 'null'], [undefined, 'undefined'], [123, 'number'],
  [{}, 'object'], [[], 'array'], [true, 'boolean']
];
badTypes8.forEach(function (pair) { ok('I8 非字符串输入被拒 ' + pair[1], rejected8(pair[0])); });
ok('I8 空表达式被拒', rejected8('') && rejected8('   '));
ok('I8 超长表达式被拒', rejected8(new Array(320).join('1')));
ok('I8 超 token 上限被拒', rejected8(new Array(90).join('1+') + '1'));
ok('I8 括号不匹配被拒', rejected8('(1+2'));
ok('I8 残缺路径被拒', rejected8('Math.'));
var exprSrc8 = read('src/core/expr.js')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');
ok('I8 实现不调用宿主动态求值接口', !/\beval\s*\(/.test(exprSrc8), '');
ok('I8 实现不动态构造函数', !/new\s+Function\s*\(/.test(exprSrc8) && !/\bFunction\s*\(/.test(exprSrc8), '');
var touched8 = 0;
var trap8 = { get A() { touched8++; return 1; } };
X8.validate('p.A');
ok('I8 validate 只编译不读取作用域', touched8 === 0, '读取 ' + touched8 + ' 次');
ok('I8 validate 产物可复用且数值正确', typeof X8.validate('p.A * 2').fn === 'function'
  && X8.validate('p.A * 2').fn(scope8({ A: 4 })) === 8);

console.log('=== 9. 数据层 / 图谱 / 视图骨架 ===');
var graph = TTK.createGraph(engine, TTK.data);
var rec = graph.recommend();
ok('图谱推荐返回按分数降序的建议列表', Array.isArray(rec) && rec.length > 0
  && rec.every(function (x) { return x.tpl && typeof x.score === 'number' && typeof x.reason === 'string'; })
  && rec.every(function (x, i) { return i === 0 || rec[i - 1].score >= x.score; }), '');
ok('图谱边结构合法', graph.edges().every(function (e) { return e.from && e.to; }), '');
var imp = TTK.data.importAll(JSON.stringify(parsed['contracts/examples/trace.json']));
ok('trace 样例可被 importAll 导入', imp.ok && imp.events === 2, JSON.stringify(imp));
ok('views 导出四视图契约', TTK.views.routes().length === 4
  && typeof TTK.views.register === 'function' && typeof TTK.views.go === 'function'
  && typeof TTK.views.start === 'function', '');
ok('未知视图不会假装挂载成功', TTK.views.mount('__unknown__') === false, '');

console.log('=== 10. 引导挑战可达性（固定种子，防回归） ===');
var rand = TTK.math.rng(20261106);
TTK.templates.forEach(function (t) {
  var hits = t.challenges.map(function () { return 0; });
  var N = t.id === 'epidemic' ? 120 : 400;
  for (var k = 0; k < N; k++) {
    var p = {};
    t.params.forEach(function (d) {
      var steps = Math.floor((d.max - d.min) / d.step + 0.5);
      p[d.key] = Number((d.min + Math.floor(rand() * (steps + 1)) * d.step).toFixed(4));
    });
    var r;
    try { r = t.compute(p, TTK.math); } catch (e) { continue; }
    t.challenges.forEach(function (c, i) {
      try { if (c.check(p, r.m)) hits[i]++; } catch (e) { /* 视为未命中 */ }
    });
  }
  ok('挑战可达 ' + t.id + ' [' + hits.join('/') + ']', hits.every(function (h) { return h > 0; }),
    t.challenges.filter(function (c, i) { return !hits[i]; }).map(function (c) { return c.text; }).join(' | '));
});

console.log('=== 11. I13：数据层统一与旧数据平滑迁移 ===');
var appI13 = read('src/ui/app.js');
ok('app.js 不再直接调用 localStorage', !/localStorage/.test(appI13), '');
ok('app.js 不再自带 save()/load() 存储实现', !/function\s+(save|load)\s*\(/.test(appI13), '');
ok('app.js 写事件统一走 TTK.data', /data\.log\(/.test(appI13)
  && /data\.markChallenge\(/.test(appI13) && /data\.addStuck\(/.test(appI13)
  && !/data\.write\(/.test(appI13), '');
ok('app.js 通过 TTK.createGraph 建图谱', /TTK\.createGraph\(engine,\s*data\)/.test(appI13), '');
ok('卡点推荐来自 graph.recommend() 的降序数组', /var\s+suggestions\s*=\s*graph\.recommend\(\)/.test(appI13)
  && /suggestions\.filter\(/.test(appI13), '');

// 造一个真正可读写的存储桩，重新加载数据层，模拟「老用户带旧数据打开新版页面」
var store = {};
global.localStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem: function (k, v) { store[k] = String(v); },
  removeItem: function (k) { delete store[k]; }
};
store['ttk.trail'] = JSON.stringify([
  { at: 1700000000000, tpl: 'overfit', name: '过拟合', reason: 'param', params: { degree: 9 }, insight: '旧版轨迹' }
]);
store['ttk.progress'] = JSON.stringify({ 'overfit:0': true });
store['ttk.stuck'] = JSON.stringify([{ at: 1700000000001, tpl: 'overfit' }]);
delete require.cache[require.resolve(path.join(ROOT, 'src/learning/data.js'))];
var reloadError = '';
try { require(path.join(ROOT, 'src/learning/data.js')); } catch (e) { reloadError = e.message; }
var D = global.TTK.data;
ok('数据层在旧数据环境下加载无异常', !reloadError, reloadError);
ok('旧轨迹 / 进度 / 卡点被接管且不丢失',
  D.trail().length === 1 && D.trail()[0].insight === '旧版轨迹'
  && D.progress()['overfit:0'] === true && D.stuck().length === 1, '');
ok('迁移报告标明三个旧键来源', D.lastMigration.sources.length === 3,
  D.lastMigration.sources.join(','));
ok('旧键原值保留（可回滚）', !!store['ttk.trail'] && !!store['ttk.progress'] && !!store['ttk.stuck'], '');
ok('v1 键已落盘', !!store['ttk.trail.v1'] && !!store['ttk.progress.v1'] && !!store['ttk.stuck.v1'], '');
ok('migrate 幂等（二次执行不重复写盘）', (function () {
  var snapshot = store['ttk.trail.v1'];
  return D.migrate().sources.length === 0 && store['ttk.trail.v1'] === snapshot;
})(), '');
ok('data.log 补全字段且不丢旧轨迹', (function () {
  var e = D.log({ tpl: 'gradient', reason: 'param', params: { lr: 0.1 } });
  var t = D.trail();
  return t.length === 2 && t[0].insight === '旧版轨迹' && e.at > 0
    && e.name === '' && e.params.lr === 0.1;
})(), '');
ok('markChallenge 首次 true / 重复 false',
  D.markChallenge('gradient', 0) === true && D.markChallenge('gradient', 0) === false, '');
ok('addStuck 追加卡点', D.addStuck('gradient') === 2, '');
var fullTrail = [];
for (var q = 0; q < 300; q++) {
  fullTrail.push({ at: q + 1, tpl: 'overfit', name: '过拟合', reason: 'param', params: {}, insight: '' });
}
store['ttk.trail.v1'] = JSON.stringify(fullTrail);
D.log({ tpl: 'supply', reason: 'select', params: {} });
ok('轨迹上限 300 且保留最新一条', D.trail().length === 300 && D.trail()[299].tpl === 'supply', '');
var exported = JSON.parse(D.exportAll(engine));
ok('导出仍符合 LearningTrace v1', exported.schema === 'ttk.learning-trace.v1'
  && exported.events.length === 300 && Array.isArray(exported.stuck), '');
var g2 = TTK.createGraph(engine, D);
ok('图谱在迁移后的数据上仍给出降序建议', (function () {
  var r = g2.recommend();
  return Array.isArray(r) && r.length >= TTK.templates.length
    && r.every(function (x, i) { return i === 0 || r[i - 1].score >= x.score; });
})(), '');

console.log('=== 12. 应用层装配冒烟（模拟双击 index.html） ===');
// 只验证装配与事件链不抛错、数据确实落到 TTK.data；不模拟像素级 DOM / Canvas 行为。
function El(id) {
  this.id = id; this.innerHTML = ''; this.textContent = ''; this.className = '';
  this.value = ''; this.dataset = {}; this.handlers = {}; this.style = {};
  this.classList = { add: function () {}, remove: function () {}, toggle: function () {} };
}
El.prototype.addEventListener = function (evt, fn) {
  (this.handlers[evt] = this.handlers[evt] || []).push(fn);
};
El.prototype.querySelectorAll = function () { return []; };
El.prototype.querySelector = function () { return null; };
El.prototype.getAttribute = function (k) { return this.dataset[k] || null; };
var els = {};
global.document = {
  getElementById: function (id) { return els[id] || (els[id] = new El(id)); },
  querySelectorAll: function () { return []; },
  addEventListener: function () {},
  activeElement: { tagName: 'BODY' }
};
global.requestAnimationFrame = function (fn) { fn(); return 1; };
global.setTimeout = function (fn) { fn(); return 0; };  // 让轨迹节流立即落地
global.clearTimeout = function () {};
global.scrollTo = function () {};
global.confirm = function () { return true; };
global.location = { hash: '' };
TTK.Renderer = function () { this.draw = function () {}; }; // 跳过 Canvas 2D，只测装配
D.clear();
var appLoadError = '';
try { require(path.join(ROOT, 'src/ui/app.js')); } catch (e) { appLoadError = e.stack || e.message; }
ok('app.js 在模拟 DOM 下完成初始化', !appLoadError, appLoadError);
var appEngine = global.TTK.engine, appGraph = global.TTK.graph;
ok('应用层导出 engine / graph 实例', !!appEngine && !!appGraph
  && typeof appGraph.recommend === 'function', '');
ok('初始化写出首条 select 轨迹', D.trail().length === 1 && D.trail()[0].reason === 'select',
  JSON.stringify(D.trail()).slice(0, 160));
var recommendCalls = 0, originRecommend = appGraph.recommend;
appGraph.recommend = function () { recommendCalls++; return originRecommend.call(appGraph); };
var stuckBefore = D.stuck().length, stuckErr = '';
try { els['stuckBtn'].handlers.click[0](); } catch (e) { stuckErr = e.message; }
ok('「我卡住了」调用 graph.recommend() 且记卡点', !stuckErr
  && recommendCalls === 1 && D.stuck().length === stuckBefore + 1, stuckErr);
var t0 = TTK.templates[0];
appEngine.select(t0.id);
var d0 = t0.params[0];
var paramChanged = appEngine.setParam(d0.key, d0.max) || appEngine.setParam(d0.key, d0.min);
var lastEvent = D.trail()[D.trail().length - 1];
ok('拖参数触发重算并写出 param 轨迹', !!paramChanged && lastEvent.reason === 'param'
  && !!lastEvent.params, JSON.stringify(lastEvent).slice(0, 160));
var switchErr = '';
try { TTK.templates.forEach(function (t) { appEngine.select(t.id); }); }
catch (e) { switchErr = e.message; }
ok('六个沙盒依次切换且渲染链无异常', !switchErr, switchErr);
var clearErr = '';
try { els['clearLog'].handlers.click[0](); } catch (e) { clearErr = e.message; }
ok('清空记录统一走数据层', !clearErr && D.trail().length === 0
  && Object.keys(D.progress()).length === 0 && D.stuck().length === 0, clearErr);

console.log('=== 13. I1：四视图路由与窄屏适配 ===');
var html13 = read('index.html');
var viewIds13 = ['graph', 'sandbox', 'report', 'studio'];
ok('index.html 有四个视图容器', viewIds13.every(function (v) {
  return html13.indexOf('id="view-' + v + '"') >= 0;
}), '');
ok('index.html 有四个导航 tab', (html13.match(/class="view-tab/g) || []).length === 4, '');
var viewsSrc13 = read('src/ui/views.js');
ok('路由层不依赖模块加载 / 本地请求', viewsSrc13.indexOf('import ') < 0
  && viewsSrc13.indexOf('export ') < 0 && viewsSrc13.indexOf('fetch(') < 0, '');
var css13 = read('assets/style.css');
ok('窄屏样式覆盖导航与视图容器', css13.indexOf('.view-nav') >= 0
  && css13.indexOf('overflow-x: auto') >= 0 && css13.indexOf('.view[hidden]') >= 0
  && css13.indexOf('@media (max-width: 560px)') >= 0, '');
var V = global.TTK.views;
ok('四个视图均已注册可挂载', V.routes().length === 4
  && V.routes().every(function (r) { return typeof r.mount === 'function'; }), '');
ok('初始停在沙盒视图', !!V.current() && V.current().id === 'sandbox',
  JSON.stringify(V.current()));
var visited13 = [], goErr13 = '';
try {
  ['graph', 'report', 'studio', 'sandbox'].forEach(function (id) {
    visited13.push(V.go(id) && V.current().id);
  });
} catch (e) { goErr13 = e.message; }
ok('四视图可依次切换', !goErr13 && visited13.join(',') === 'graph,report,studio,sandbox',
  goErr13 || visited13.join(','));
ok('切换同步写 hash', String(global.location.hash).indexOf('#sandbox/') === 0,
  String(global.location.hash));
ok('非当前视图被隐藏', els['view-graph'].hidden === true && els['view-sandbox'].hidden === false,
  String(els['view-graph'].hidden) + '/' + String(els['view-sandbox'].hidden));
global.location.hash = '#report/gradient';
var hashErr13 = '';
try { global.onhashchange(); } catch (e) { hashErr13 = e.message; }
ok('hashchange 恢复视图与概念', !hashErr13 && V.current().id === 'report'
  && TTK.engine.currentId === 'gradient', hashErr13 || String(TTK.engine.currentId));
global.location.hash = '#studio/supply';
delete require.cache[require.resolve(path.join(ROOT, 'src/ui/views.js'))];
require(path.join(ROOT, 'src/ui/views.js'));
var V2 = global.TTK.views;
V2.start();
ok('刷新后停在当前视图', V2.current().id === 'studio' && V2.parseHash().tpl === 'supply',
  JSON.stringify(V2.parseHash()));
V2.go('sandbox');
var t13 = TTK.templates[0], d13 = t13.params[0];
TTK.engine.select(t13.id);
var paramOk13 = TTK.engine.setParam(d13.key, d13.max) || TTK.engine.setParam(d13.key, d13.min);
var last13 = D.trail()[D.trail().length - 1];
ok('四视图切换后拖动 / 指标 / 轨迹仍正常', !!paramOk13 && last13.reason === 'param'
  && TTK.engine.state.spec.metrics.length > 0, JSON.stringify(last13).slice(0, 160));

finish();

function finish() {
  console.log('\n---------------------------------------------');
  if (failed.length) {
    console.log('校验未通过：' + failed.length + ' / ' + total + ' 项失败');
    failed.forEach(function (f) { console.log('  - ' + f); });
    process.exit(1);
  }
  console.log('全部通过：' + total + ' 项检查，0 失败');
  process.exit(0);
}
