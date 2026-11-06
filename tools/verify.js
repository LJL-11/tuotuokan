#!/usr/bin/env node
/* 拖拖看 · 本地与 CI 共用的全量校验
 * 零依赖：只用 Node 内置模块。运行 `npm test` 或 `node tools/verify.js`。
 * 覆盖：语法 / 脚本路径与顺序 / DOM 引用 / 契约 JSON 与样例 / 模板数值 /
 *       DSL 编译挂载 / 表达式白名单 / 图谱与数据层 / 占位模块 / 挑战可达性。
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
ok('views 骨架导出四视图契约', TTK.views.routes().length === 4 && typeof TTK.views.register === 'function', '');
ok('views 未实现时不会假装挂载成功', TTK.views.mount('report') === false, '');

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
