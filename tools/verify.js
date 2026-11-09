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
  'contracts/compute-result.schema.json',
  'contracts/examples/spring.json',
  'contracts/examples/trace.json',
  'contracts/examples/compute-result.json',
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
var crSchema = parsed['contracts/compute-result.schema.json'] || {};
ok('ComputeResult schema 声明 v1 与四个顶层字段', /v1/.test(crSchema.title || '')
  && ['chart', 'metrics', 'insight', 'm'].every(function (k) {
    return (crSchema.required || []).indexOf(k) >= 0;
  }), '');

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
ok('内置模板 >= 10', TTK.templates.length >= 10, '实际 ' + TTK.templates.length);
var byId6 = {};
TTK.templates.forEach(function (t) { byId6[t.id] = t; });
['bayes', 'compound', 'decay', 'logistic'].forEach(function (id) {
  ok('新模板已注册 ' + id, !!byId6[id] && Array.isArray(byId6[id].prerequisites) && byId6[id].challenges.length >= 1, '');
});
ok('新模板覆盖统计 / 金融 / 生态', ['统计学', '金融学', '生态学'].every(function (s) {
  return TTK.templates.some(function (t) { return t.subject === s; });
}), '');
ok('每个模板都声明先修数组', TTK.templates.every(function (t) { return Array.isArray(t.prerequisites); }), '');
ok('衰变先修单摆、传染病先修逻辑斯谛',
  byId6.decay.prerequisites.indexOf('oscillation') >= 0
  && byId6.epidemic.prerequisites.indexOf('logistic') >= 0, '');
ok('复利和逻辑斯谛先修衰变，过拟合可回溯贝叶斯',
  byId6.compound.prerequisites.indexOf('decay') >= 0
  && byId6.logistic.prerequisites.indexOf('decay') >= 0
  && byId6.overfit.prerequisites.indexOf('bayes') >= 0, '');
['bayes', 'compound', 'decay', 'logistic'].forEach(function (id) {
  var spec6 = byId6[id].compute(engine.defaults(byId6[id]), TTK.math);
  var panels6 = spec6.chart && spec6.chart.panels ? spec6.chart.panels.length : 0;
  ok(id + ' 含双面板、指标和两个挑战', panels6 >= 2
    && (spec6.metrics || []).length >= 1 && byId6[id].challenges.length >= 2,
    'panels=' + panels6 + ' metrics=' + ((spec6.metrics || []).length));
});
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
var draftJson = '';
try { draftJson = JSON.stringify(mountRes.spec); } catch (e) { draftJson = ''; }
ok('本地草稿可序列化且不落盘', mountRes.persist === false && mountRes.spec && mountRes.spec.source === 'local-draft'
  && draftJson.indexOf('local-draft') >= 0 && typeof mountRes.spec.compute !== 'function', draftJson.slice(0, 120));
var llmSpec = resonanceSpec();
llmSpec.source = 'llm';
var llmMount = TTK.generator.mount(TTK.createEngine(), llmSpec);
var llmJson = '';
try { llmJson = JSON.stringify(llmMount.spec); } catch (e2) { llmJson = ''; }
ok('校验通过的模型模板可落盘且不含函数', llmMount.ok && llmMount.persist === true
  && llmMount.spec && llmMount.spec.source === 'llm' && llmJson.indexOf('function') < 0,
  (llmMount.errors || []).join('; '));
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

console.log('=== 8c. I9：模拟骨架（时间步进 / 播放暂停 / 调速 / 静态兼容） ===');
var S9 = TTK.sim;
ok('模拟运行时导出完整', !!S9 && ['register', 'unregister', 'registered', 'mount',
  'supported', 'bindControls', 'setRenderer', 'onDeactivate', 'attach', 'play',
  'pause', 'toggle', 'stop', 'reset', 'setSpeed', 'step', 'advance', 'state', 'spec']
  .every(function (k) { return typeof S9[k] === 'function'; }), '');
ok('未 mount 时引擎不预置任何模板特判', S9.registered().length === 0, S9.registered().join(','));
var mounted9 = S9.mount(engine);
ok('mount 从模板 sim 元数据发现单摆与 SIR', mounted9.length === 2
  && mounted9.indexOf('oscillation') >= 0 && mounted9.indexOf('epidemic') >= 0,
  mounted9.join(','));
ok('带 sim 元数据的模板恰为单摆与 SIR', TTK.templates.filter(function (t) {
  return !!t.sim;
}).map(function (t) { return t.id; }).join(',') === 'oscillation,epidemic', '');
ok('supported 只认模板能力，不认模板名', S9.supported('oscillation', engine) === true
  && S9.supported('epidemic', engine) === true && S9.supported('overfit', engine) === false, '');
var simSrcHead9 = read('src/core/engine.js').split('模拟运行时（#I9）')[1] || '';
ok('引擎不含内置 ODE 映射表或模板 id 特判', !/SIM_BUILTINS/.test(read('src/core/engine.js'))
  && !/['"](oscillation|epidemic|overfit)['"]/.test(simSrcHead9), '');
ok('模拟控件静态声明在 index.html', /id="simBar"/.test(html)
  && /id="simPlayBtn"/.test(html) && /id="simSpeed"/.test(html)
  && /id="simResetBtn"/.test(html) && /id="simLabel"/.test(html), '');
ok('app.js 用 mount / bindControls / setRenderer 正规接入', /sim\.mount\(engine\)/.test(appSrc)
  && /sim\.bindControls\(/.test(appSrc) && /sim\.setRenderer\(renderer\)/.test(appSrc), '');
var staticBefore9 = TTK.templates.map(function (t) {
  return JSON.stringify(t.compute(engine.defaults(t), TTK.math));
}).join('|');
var revBefore9 = engine.revision, stateBefore9 = engine.state;
var trailBefore9 = TTK.data.trail().length;
ok('attach 不支持动态模拟的模板返回 false', S9.attach('overfit', engine) === false, '');
ok('attach 单摆成功', S9.attach('oscillation', engine) === true, '');
var s90 = S9.state();
ok('初始状态 t=0 / 步数 0 / 未播放', s90.active && !s90.playing && s90.t === 0
  && s90.steps === 0 && s90.total === 1401 && s90.dt === 0.01, JSON.stringify(s90));
ok('初始积分状态等于模板初始条件', Math.abs(s90.y[0] -
  engine.defaults(engine.get('oscillation')).theta0 * Math.PI / 180) < 1e-12 && s90.y[1] === 0, '');
var oscStatic9 = engine.get('oscillation').compute(engine.defaults(engine.get('oscillation')), TTK.math);
ok('帧 spec 顶层字段与静态 ComputeResult 一致', Object.keys(S9.spec()).sort().join(',')
  === Object.keys(oscStatic9).sort().join(','), Object.keys(S9.spec()).join(','));
ok('首帧 spec 坐标合法', issuesOf(S9.spec()).length === 0, issuesOf(S9.spec()).join(';'));
ok('首帧时间序列只揭示 1 个点', S9.spec().chart.panels[0].series[2].points.length === 1, '');
S9.step(500);
var s9500 = S9.state();
ok('固定步进 500 步后 t=5s', Math.abs(s9500.t - 5) < 1e-9 && s9500.steps === 500,
  't=' + s9500.t + ' steps=' + s9500.steps);
ok('单摆积分与静态曲线逐点一致', Math.abs(s9500.y[0] * 180 / Math.PI -
  oscStatic9.chart.panels[0].series[2].points[500][1]) < 1e-9, '');
ok('相图同步按帧揭示', S9.spec().chart.panels[1].series[0].points.length === 501, '');
ok('帧 spec 带当前状态标记', S9.spec().chart.panels[0].markers.some(function (m) {
  return m.label === '当前摆角';
}), '');
S9.setSpeed(1); S9.play();
ok('play 进入播放态', S9.state().playing === true, '');
S9.advance(1000);
ok('1× 速度 1000ms 推进 1 秒', Math.abs(S9.state().t - 6) < 1e-9, '实际 ' + S9.state().t);
S9.pause();
var paused9 = JSON.stringify(S9.state());
S9.advance(5000);
ok('暂停时状态不漂移', JSON.stringify(S9.state()) === paused9, '');
ok('pause 后为暂停态', S9.state().playing === false, '');
S9.reset(); S9.setSpeed(2); S9.play(); S9.advance(1000);
ok('2× 速度 1000ms 推进 2 秒', Math.abs(S9.state().t - 2) < 1e-9, '实际 ' + S9.state().t);
ok('非法速度被拒且不影响当前速度', S9.setSpeed(0) === false && S9.setSpeed(-3) === false
  && S9.state().speed === 2, '');
ok('速度超上限被钳制', S9.setSpeed(100) === true && S9.state().speed === 8, '');
ok('速度低于下限被钳制', S9.setSpeed(0.01) === true && S9.state().speed === 0.25, '');
S9.reset();
ok('reset 回到 t=0 且状态归位', S9.state().t === 0 && S9.state().steps === 0
  && Math.abs(S9.state().y[1]) < 1e-12, '');
S9.step(1e9);
ok('步进越界被钳制在总时长内', S9.state().steps === 1400
  && Math.abs(S9.state().t - 14) < 1e-9 && S9.state().progress === 1, JSON.stringify(S9.state()));
ok('播完后自动停止', S9.state().playing === false, '');
ok('SIR 沙盒可 attach', S9.attach('epidemic', engine) === true, '');
S9.step(300);
var sirStatic9 = engine.get('epidemic').compute(engine.defaults(engine.get('epidemic')), TTK.math);
ok('SIR 积分与静态曲线逐点一致', Math.abs(S9.state().y[1] -
  sirStatic9.chart.panels[0].series[1].points[300][1]) < 1e-9, '');
ok('与时间无关的 R0 扫描曲线原样保留', S9.spec().chart.panels[1].series[0].points.length === 32, '');
ok('SIR 帧 spec 坐标合法', issuesOf(S9.spec()).length === 0, issuesOf(S9.spec()).join(';'));
S9.register('__i9_probe__', {
  dt: 0.1, duration: function () { return 1; },
  state0: function () { return [0]; }, deriv: function (t, s) { return [1]; }
});
ok('ODE 沙盒可运行时注册 / 卸载', S9.registered().indexOf('__i9_probe__') >= 0
  && S9.unregister('__i9_probe__') === true && S9.registered().indexOf('__i9_probe__') < 0, '');
var simSrc9 = read('src/core/engine.js').split('模拟运行时（#I9）')[1] || '';
ok('模拟运行时不引入随机数', !/Math\.random\s*\(/.test(simSrc9), '');
ok('模拟运行时不广播 change 事件', !/emit\s*\(\s*['"]change['"]/.test(simSrc9), '');
ok('未新增 script 标签（随 engine.js 加载）', !/sim\.js/.test(html), '');
ok('模拟过程不触发引擎重算（revision / state 不变）', engine.revision === revBefore9
  && engine.state === stateBefore9, '');
ok('模拟过程不写学习轨迹', TTK.data.trail().length === trailBefore9, '');
ok('10 个静态模板数值一个不变', TTK.templates.map(function (t) {
  return JSON.stringify(t.compute(engine.defaults(t), TTK.math));
}).join('|') === staticBefore9, '');
S9.stop();
ok('stop 后不再播放且状态冻结', S9.state().active === false && S9.state().playing === false, '');
ok('未 attach 时 play 不启动', S9.play() === false, '');

// 控件由 UI 层静态声明，运行时只做状态同步；这里用轻量 DOM 桩验证显隐与文案
var bar9 = { hidden: null }, btn9 = {}, speed9 = {}, reset9 = {}, label9 = {};
S9.bindControls({ bar: bar9, btn: btn9, speed: speed9, resetBtn: reset9, label: label9 });
ok('未选中可模拟概念时控制条隐藏', bar9.hidden === true && btn9.disabled === true, '');
S9.attach('oscillation', engine);
ok('可模拟概念下控制条显示且按钮可用', bar9.hidden === false && btn9.disabled === false, '');
ok('状态标签单位来自模板元数据（单摆 s）', /t=0\.00s/.test(label9.textContent), label9.textContent);
S9.play(); S9.advance(100);
ok('播放时按钮文案切换为暂停', btn9.textContent === '暂停', btn9.textContent);
S9.pause();
ok('暂停后按钮文案恢复播放', btn9.textContent === '播放模拟', btn9.textContent);
S9.attach('epidemic', engine);
ok('状态标签单位来自模板元数据（SIR 天）', /t=0\.00天/.test(label9.textContent), label9.textContent);
S9.stop();
S9.bindControls(null);

// ComputeResult 契约四处同步后的形状校验（schema / 样例 / dsl.js / docs/01）
var crSampleV = TTK.dsl.validateResult(parsed['contracts/examples/compute-result.json']);
ok('compute-result 样例通过 validateResult', crSampleV.ok, crSampleV.errors.join('；'));
var crBadV = TTK.dsl.validateResult({
  chart: { panels: [{ series: [{ name: 'x', points: [[0, NaN]] }] }] },
  metrics: [{ label: '坏值', value: Infinity }], insight: '', m: {}
});
ok('validateResult 能拦下 NaN 坐标与无穷指标', crBadV.ok === false, '');
ok('10 个模板的 compute 输出都符合 ComputeResult 契约', TTK.templates.every(function (t) {
  return TTK.dsl.validateResult(t.compute(engine.defaults(t), TTK.math)).ok;
}), '');
S9.attach('oscillation', engine);
var frameV = TTK.dsl.validateResult(S9.spec());
ok('模拟帧复用 ComputeResult 形状且未新增字段', frameV.ok
  && Object.keys(S9.spec()).sort().join(',') === 'chart,insight,m,metrics', frameV.errors.join('；'));
S9.stop();

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
ok('全部内置沙盒依次切换且渲染链无异常', !switchErr, switchErr);
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

runI4(function () { runLeadViews(); runLeadRepay(); finish(); });

function pngWithText(text) {
  function utf8(value) {
    var raw = unescape(encodeURIComponent(value));
    var out = [];
    var i;
    for (i = 0; i < raw.length; i++) out.push(raw.charCodeAt(i));
    return out;
  }
  function chunk(type, data) {
    var len = data.length;
    var head = [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255];
    var kind = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
    return head.concat(kind, data, [0, 0, 0, 0]);
  }
  var payload = utf8('Comment').concat([0, 0, 0, 0, 0], utf8(text));
  var sig = [137, 80, 78, 71, 13, 10, 26, 10];
  return sig.concat(chunk('iTXt', payload), chunk('IEND', []));
}

function resonanceSpec() {
  return {
    id: 'damped_resonance',
    name: '阻尼共振',
    subject: '物理学',
    brief: '驱动力频率靠近固有频率时，振幅为什么会冲高？',
    concept: '稳态振幅在驱动频率接近固有频率时最大，阻尼越大，峰越矮、越宽。',
    keywords: ['阻尼共振', '共振'],
    prerequisites: ['oscillation'],
    x: { min: 0, max: 3, label: '频率比', yLabel: '振幅', samples: 80 },
    params: [
      { key: 'g', label: '阻尼比', min: 0.05, max: 0.8, step: 0.05, default: 0.2, unit: '', hint: '越大峰越矮' }
    ],
    series: [
      { name: '稳态振幅', expr: '1 / Math.sqrt((1 - x * x) * (1 - x * x) + 4 * p.g * p.g * x * x)', color: '#4f46e5' }
    ],
    metrics: [{ label: '阻尼比', expr: 'p.g', unit: '' }],
    insight: '把阻尼比调小，曲线在频率比等于 1 附近会冲得更高。',
    challenges: [{ text: '把阻尼比调到 0.1 以下', expr: 'p.g <= 0.1' }]
  };
}

function runI4(done) {
  console.log('=== 14. I4：LLM 生成、校验、重试与断网降级 ===');
  function restore() { TTK.generator.configure({ endpoint: '' }); }
  try {
    var genSrc = read('src/model/generator.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    ok('生成器不把模型文本当代码执行', !/\beval\s*\(/.test(genSrc) && !/new\s+Function\s*\(/.test(genSrc), '');
    ok('输入框走 generator，草稿文案不谎称 AI',
      /TTK\.generator\.generate\(/.test(appSrc) && /本地草稿/.test(appSrc) && /不是 AI 生成/.test(appSrc), '');

    var fetched = 0;
    var prevFetch = global.fetch;
    global.fetch = function () { fetched += 1; return Promise.reject(new Error('不应发出')); };
    var offline = TTK.generator.generate('阻尼共振');
    var offlineOk = offline && offline.ai === false && offline.source === 'local-draft' && fetched === 0;
    var offlineCompiled = false, offlineErr = '';
    try {
      var ov = TTK.dsl.validate(offline.spec, []);
      offlineCompiled = !!(ov.ok && TTK.dsl.compile(offline.spec, ov));
    } catch (e) { offlineErr = e.message; }
    ok('未配置代理时阻尼共振是可编译本地草稿且不发请求', offlineOk && offlineCompiled, offlineErr);
    global.fetch = prevFetch;

    var known = TTK.generator.recognize('过拟合');
    var damp = TTK.generator.recognize('阻尼');
    var longTail = TTK.generator.recognize('阻尼共振');
    ok('已收录概念仍能识别', known.ok && known.conceptId === 'overfit' && known.level === 'supported'
      && damp.ok && damp.conceptId === 'oscillation' && damp.level === 'supported',
      JSON.stringify({ known: known.conceptId, damp: damp.conceptId, level: known.level }));
    ok('阻尼共振不被短关键词吞掉', longTail.ok === false && longTail.level === 'supported' && longTail.message && !longTail.conceptId, longTail.message || '');

    var mediaCalls = 0;
    TTK.generator.configure({
      endpoint: 'https://proxy.local/generate',
      transport: function () { mediaCalls += 1; return resonanceSpec(); }
    });
    var named = TTK.generator.recognize({ image: { name: '贝叶斯.png' } });
    var missed = TTK.generator.recognize({ text: '完全未知xyz', image: { name: 'unknown-diagram.png' } });
    ok('图片文件名可在本机匹配且不上传', named.ok && named.conceptId === 'bayes' && named.level === 'fallback'
      && named.message.indexOf('没有上传') >= 0 && mediaCalls === 0, named.message || '');
    ok('认不出的图片给出明确提示且不上传', missed.ok === false && missed.unsupported === true
      && missed.message && mediaCalls === 0, missed.message || '');
    ok('关键词降级仍调用 findByQuery', /findByQuery\(/.test(genSrc), '');
    var phrase = TTK.generator.recognize('我想了解过拟合');
    var bothWords = TTK.generator.recognize('振动周期');
    var asked = TTK.generator.recognize('过拟合是什么');
    ok('原有关键词问法仍能匹配', phrase.ok && phrase.conceptId === 'overfit' && phrase.source === 'keyword-fallback'
      && bothWords.ok && bothWords.conceptId === 'oscillation'
      && asked.ok && asked.conceptId === 'overfit',
      JSON.stringify({ phrase: phrase.conceptId, both: bothWords.conceptId, asked: asked.conceptId }));
    var svgShot = TTK.generator.recognize({
      image: { name: '截图.svg', body: '<svg xmlns="http://www.w3.org/2000/svg"><text>过拟合</text></svg>' }
    });
    ok('图片里的文字能产出概念且不上传', svgShot.ok && svgShot.conceptId === 'overfit'
      && svgShot.source === 'image-text' && svgShot.level === 'fallback'
      && svgShot.message.indexOf('没有上传') >= 0 && mediaCalls === 0,
      svgShot.message || '');
    var paragraph = TTK.generator.recognize({
      image: { name: '板书.png', text: '课本这一段在讲贝叶斯更新，先验会被新证据挪动。' }
    });
    ok('课本段落图片能产出已收录概念', paragraph.ok && paragraph.conceptId === 'bayes' && mediaCalls === 0,
      paragraph.message || '');
    var described = TTK.generator.recognize({
      image: { name: '截图.png', text: '今天的板书写着一个尚未收录的新概念' }
    });
    ok('画面有字但未收录时给出概念描述', described.ok === false && !described.conceptId
      && described.concept.indexOf('尚未收录') >= 0 && described.message && described.unsupported === false
      && mediaCalls === 0, described.message || '');
    var pngBytes = pngWithText('今天的板书写着放射性衰变');
    var fromPng = TTK.generator.recognize({ image: { name: '截图.png', bytes: pngBytes } });
    ok('图片文件里的文字能产出概念且不上传', fromPng.ok && fromPng.conceptId === 'decay' && mediaCalls === 0,
      fromPng.message || '');
    var quiet = TTK.generator.recognize({ audio: { name: 'lecture.wav' } });
    ok('听不懂的语音给出明确提示且不上传', quiet.ok === false && !quiet.conceptId && !quiet.concept
      && quiet.level === 'unsupported' && quiet.unsupported === true
      && quiet.message.indexOf('没有上传') >= 0 && quiet.message.indexOf('文件名') >= 0 && mediaCalls === 0, quiet.message || '');
    var blankShot = TTK.generator.recognize({ image: { name: '截图.png' } });
    ok('完全认不出不编造概念且不上传', blankShot.ok === false && blankShot.level === 'unsupported'
      && !blankShot.conceptId && !blankShot.concept && blankShot.message && mediaCalls === 0, blankShot.concept || blankShot.message || '');
    ok('选择图片前界面已说明不会上传', /id="askPrivacy"/.test(html) && /不会上传/.test(html)
      && html.indexOf('id="askPrivacy"') < html.indexOf('id="mediaBtn"'), '');

    var secret = 'do-not-send-this';
    var calls = 0;
    var seenBody = '';
    TTK.generator.configure({
      endpoint: 'https://proxy.local/generate',
      model: 'demo',
      apiKey: secret,
      token: secret,
      transport: function (req) {
        calls += 1;
        seenBody = req.body || '';
        if (calls === 1) return { id: 'bad', name: '坏' };
        return { choices: [{ message: { content: '```json\n' + JSON.stringify(resonanceSpec()) + '\n```' } }] };
      }
    });
    var pub = TTK.generator.config();
    ok('configure 只留下端点与模型名', pub.enabled === true && pub.model === 'demo' && !pub.apiKey && !pub.token, JSON.stringify(pub));

    TTK.generator.generate('阻尼共振', { ids: ['oscillation'] }).then(function (res) {
      var compiled = null, compileErr = '';
      try { compiled = TTK.dsl.compile(res.spec); }
      catch (e) { compileErr = e.message; }
      var numeric = compiled ? issuesOf(compiled.compute(TTK.engine.defaults(compiled), TTK.math)) : ['未编译'];
      ok('校验失败会重试一次，阻尼共振产出可编译 JSON',
        res.ai === true && res.attempts === 2 && calls === 2 && compiled && numeric.length === 0,
        JSON.stringify({ ai: res.ai, attempts: res.attempts, calls: calls, reason: res.reason, id: res.spec && res.spec.id, errors: res.errors, compileErr: compileErr, numeric: numeric }));
      ok('请求体带概念与提示且不含密钥', seenBody.indexOf('阻尼共振') >= 0
        && seenBody.indexOf('prompt') >= 0 && seenBody.indexOf(secret) < 0, '');
      ok('生成公式仍在表达式白名单内', compiled && TTK.expr.validate(res.spec.series[0].expr).ok, res.spec.series[0].expr);

      var collideCalls = 0;
      TTK.generator.configure({
        endpoint: 'https://proxy.local/generate',
        transport: function () {
          collideCalls += 1;
          var spec = resonanceSpec();
          spec.id = 'oscillation';
          return spec;
        }
      });
      return TTK.generator.generate('阻尼共振', { ids: ['oscillation'] }).then(function (collided) {
        var cv = TTK.dsl.validate(collided.spec, ['oscillation']);
        ok('与已有 id 冲突时改写 id 而不是覆盖', collided.ai === true && collided.spec.id !== 'oscillation' && cv.ok,
          collided.spec && collided.spec.id);

        TTK.generator.configure({
          endpoint: 'https://proxy.local/generate',
          transport: function () {
            var evil = resonanceSpec();
            evil.series[0].expr = 'window.alert(1)';
            return evil;
          }
        });
        return TTK.generator.generate('阻尼共振', { ids: [] });
      }).then(function (evilRes) {
        var expr = evilRes.spec && evilRes.spec.series && evilRes.spec.series[0] && evilRes.spec.series[0].expr;
        ok('恶意公式被拒后降级且不谎称 AI', evilRes.ai === false && evilRes.reason === 'invalid'
          && evilRes.attempts === 2 && expr && expr.indexOf('window') < 0,
          JSON.stringify({ ai: evilRes.ai, reason: evilRes.reason, attempts: evilRes.attempts, expr: expr }));
        var eng = TTK.createEngine();
        var before = eng.all().length;
        var evil = resonanceSpec();
        evil.series[0].expr = 'window.alert(1)';
        var denied = TTK.generator.mount(eng, evil);
        ok('挂载入口拒绝白名单外的公式', denied.ok === false && eng.all().length === before, (denied.errors || []).join('; '));

        TTK.generator.configure({
          endpoint: 'https://proxy.local/generate',
          transport: function () { throw new Error('offline'); }
        });
        return TTK.generator.generate('阻尼共振');
      }).then(function (down) {
        ok('断网重试一次后降级为本地草稿', down.ai === false && down.source === 'local-draft' && down.reason === 'network' && down.attempts === 2, down.reason);
        restore();
        var again = TTK.generator.generate('再试一次');
        ok('清空端点后恢复同步本地草稿', again && typeof again.then !== 'function' && again.ai === false, '');
        done();
      });
    }).then(null, function (err) {
      ok('I4 异步流程未中断', false, err && (err.stack || err.message));
      restore();
      done();
    });
  } catch (err) {
    ok('I4 同步流程未中断', false, err && (err.stack || err.message));
    restore();
    done();
  }
}

/* === 15. 付的前端精修：I2 / I3 / I14 / I15 验收实证 ===
 * 在模拟 DOM 里直接驱动新增按钮与公开入口，逐条对应网页 Issue 的验收框。 */
function runLeadViews() {
  console.log('=== 15. I2 报告 / I3 工坊 / I14 图谱 / I15 同步入口 ===');
  var LV = global.TTK.views, E = global.TTK.engine;
  // 第 13 节为模拟刷新重新载入过视图层；清空旧模块留下的按钮回调，
  // 由当前视图模块重新绑定，保证按钮闭包与重绘用的是同一份编辑状态。
  ['studioValidate', 'studioCompile', 'studioSave', 'studioExample', 'reportExport', 'reportImport']
    .forEach(function (id) { if (els[id]) els[id].handlers.click = []; });
  var prevFetch = global.fetch, fetchCalls = 0;
  global.fetch = function () { fetchCalls += 1; return Promise.reject(new Error('offline')); };
  var html15 = read('index.html');
  var viewsSrc15 = read('src/ui/views.js');
  var appSrc15 = read('src/ui/app.js');

  ok('I15 界面含服务地址 / 匿名 ID / 状态控件',
    ['syncUrl', 'syncSave', 'syncClear', 'syncFlush', 'syncAnon', 'syncAnonApply', 'syncStatus']
      .every(function (id) { return html15.indexOf('id="' + id + '"') >= 0; }), '');
  ok('index.html 数据诚实措辞改为动态容器',
    html15.indexOf('id="storageNotice"') >= 0 &&
    html15.indexOf('记录仅保存在本机浏览器，不上传</div>') < 0 &&
    appSrc15.indexOf('updateStorageNotice') >= 0, '');
  ok('视图层不执行任意 JS、不发网络请求',
    !/\beval\s*\(/.test(viewsSrc15) && !/new\s+Function\s*\(/.test(viewsSrc15) &&
    viewsSrc15.indexOf('fetch(') < 0, '');

  /* --- I2：导出符合 schema、能重新导入、随数据变化 --- */
  LV.go('report');
  ok('报告视图提供导出 / 导入按钮',
    !!els['reportExport'] && !!els['reportImport'] && !!els['reportImportFile'], '');
  var exported = LV.exportReport(), trace = null, parseErr = '';
  try { trace = JSON.parse(exported || ''); } catch (e) { parseErr = e.message; }
  var topKeys = ['schema', 'exportedAt', 'notice', 'summary', 'events', 'progress', 'stuck', 'customTemplates'];
  var eventKeys = ['at', 'tpl', 'name', 'reason', 'params', 'insight'];
  ok('导出 JSON 符合 learning-trace v1 且字段全在白名单内',
    !!trace && trace.schema === 'ttk.learning-trace.v1' && Array.isArray(trace.events) &&
    typeof trace.notice === 'string' &&
    Object.keys(trace).every(function (k) { return topKeys.indexOf(k) >= 0; }) &&
    trace.events.every(function (e) {
      return Object.keys(e).every(function (k) { return eventKeys.indexOf(k) >= 0; });
    }), parseErr);
  ok('导出数据不含姓名 / 学校 / 设备标识字段',
    !!exported && !/deviceId|school|studentName|ipAddress|"ip"\s*:/i.test(exported), '');
  ok('无自动下载能力时仍给出可复制的导出文本',
    els['reportExportText'] && els['reportExportText'].value === exported, '');
  var imported = LV.importReport(exported);
  ok('导出的 JSON 能重新导入', imported === true && D.trail().length === trace.events.length,
    'trail=' + D.trail().length + ' events=' + (trace ? trace.events.length : -1));
  var reportBefore = els['view-report'].innerHTML;
  D.log({ at: Date.now(), tpl: TTK.templates[0].id, name: TTK.templates[0].name,
    reason: 'param', params: {}, insight: 'I2 即时重绘断言' });
  var reportAfter = els['view-report'].innerHTML;
  ok('聚合卡片 / 图表 / 掌握度 / 时间线随数据即时变化',
    reportAfter !== reportBefore && reportAfter.indexOf('I2 即时重绘断言') >= 0, '');

  /* --- I3：粘贴示例可挂载、非法公式定位、刷新后仍在 --- */
  var spring = JSON.parse(read('contracts/examples/spring.json'));
  LV.go('studio');
  els['studioJson'].value = JSON.stringify(spring, null, 2);
  var compileErr = '';
  try { els['studioCompile'].handlers.click[0](); } catch (e) { compileErr = e.message; }
  ok('粘贴 spring.json 可直接编译挂载', !compileErr && !!E.get('spring') &&
    E.get('spring').custom === true, compileErr);
  ok('挂载后自动切到沙盒且 hash 带模板 id',
    !!LV.current() && LV.current().id === 'sandbox' &&
    String(global.location.hash).indexOf('#sandbox/spring') === 0 &&
    appSrc15.indexOf('engine.select(payload.tpl)') >= 0,
    String(global.location.hash) + ' / ' + (LV.current() && LV.current().id));

  LV.go('studio');
  var evil = JSON.parse(JSON.stringify(spring));
  evil.id = 'verify_evil';
  evil.series[0].expr = 'window.alert(1)';
  els['studioJson'].value = JSON.stringify(evil, null, 2);
  var validateErr = '';
  try { els['studioValidate'].handlers.click[0](); } catch (e) { validateErr = e.message; }
  var studioHtml = els['view-studio'].innerHTML;
  ok('非法公式给出行号 / 字段 / 标识符的可读定位', !validateErr &&
    /第 \d+ 行/.test(studioHtml) && studioHtml.indexOf('series[0].expr') >= 0 &&
    studioHtml.indexOf('window') >= 0, studioHtml.slice(0, 180));
  ok('白名单外的公式不会被挂载', !E.get('verify_evil'), '');

  var customSpec = JSON.parse(JSON.stringify(spring));
  customSpec.id = 'verify_custom';
  customSpec.name = '校验用模板';
  els['studioJson'].value = JSON.stringify(customSpec, null, 2);
  var saveErr = '';
  try { els['studioSave'].handlers.click[0](); } catch (e) { saveErr = e.message; }
  ok('保存写入 ttk.custom.v1 且已挂载', !saveErr &&
    D.custom().some(function (s) { return s && s.id === 'verify_custom'; }) &&
    !!E.get('verify_custom'), saveErr);
  E.unregister('verify_custom');
  var restored = TTK.app.restoreCustom();
  ok('刷新后自定义模板仍在（恢复入口幂等）', restored >= 1 &&
    !!E.get('verify_custom') && E.get('verify_custom').custom === true, String(restored));

  /* --- I14：节点数随注册 / 卸载，掌握度随挑战完成 --- */
  LV.go('graph');
  var probe = JSON.parse(JSON.stringify(spring));
  probe.id = 'graph_probe';
  probe.name = '图谱探针';
  var pv = TTK.dsl.validate(probe, []);
  var graphBefore = els['view-graph'].innerHTML;
  E.register(TTK.dsl.compile(probe, pv));
  var graphAfter = els['view-graph'].innerHTML;
  ok('节点数量随 engine.register 同步变化',
    graphBefore.indexOf('graph_probe') < 0 && graphAfter.indexOf('graph_probe') >= 0, '');
  E.unregister('graph_probe');
  ok('节点数量随 engine.unregister 同步变化',
    els['view-graph'].innerHTML.indexOf('graph_probe') < 0, '');
  function masteryOf(id) {
    var m = new RegExp('data-node="' + id + '" data-mastery="([0-9.]+)"').exec(els['view-graph'].innerHTML);
    return m ? Number(m[1]) : -1;
  }
  var target = TTK.templates[0];
  var prog15 = D.progress();           // 先清掉一条，保证这次标记一定改变掌握度
  prog15[target.id + ':0'] = false;
  D.write(D.keys.progress, prog15);
  var mBefore = masteryOf(target.id);
  D.markChallenge(target.id, 0);
  var mAfter = masteryOf(target.id);
  ok('掌握度颜色数值随挑战完成变化并即时重绘', mBefore >= 0 && mAfter > mBefore,
    mBefore + ' -> ' + mAfter);
  ok('图谱节点可点击跳转沙盒',
    viewsSrc15.indexOf("g.addEventListener('click'") >= 0 &&
    viewsSrc15.indexOf("go('sandbox', g.getAttribute('data-node'))") >= 0, '');

  /* --- I15：配置刷新保留、状态即时重绘、零网络请求 --- */
  ok('界面装配订阅 TTK.data.subscribe 并接数据层配置入口',
    appSrc15.indexOf('data.subscribe(onDataChange)') >= 0 &&
    appSrc15.indexOf('data.remote.configure') >= 0, '');
  ok('默认本地模式且未配置服务地址', D.remote.mode === 'local' && !D.remote.endpoint, D.remote.mode);
  var flushErr = '';
  try { els['syncFlush'].handlers.click[0](); } catch (e) { flushErr = e.message; }
  ok('未配置时零网络请求', !flushErr && fetchCalls === 0, flushErr + ' calls=' + fetchCalls);
  var url15 = 'http://127.0.0.1:8787/v1';
  els['syncUrl'].value = url15;
  els['syncSave'].handlers.click[0]();
  ok('界面可配置服务地址并切到同步模式',
    D.remote.mode === 'rest' && D.remote.endpoint === url15, D.remote.mode);
  ok('服务地址写入本机（刷新后可恢复）',
    JSON.stringify(D.read(D.keys.remote) || {}).indexOf(url15) >= 0, '');
  ok('匿名 ID 由数据层持久化为 16 位十六进制',
    /^[0-9a-f]{16}$/.test(String(D.read(D.keys.anon) || '')),
    String(D.read(D.keys.anon) || ''));
  ok('同步状态显示待上传数 / 最近错误 / 匿名 ID',
    ['模式：', '待上传：', '最近错误：', '匿名 ID：'].every(function (k) {
      return String(els['syncStatus'].textContent).indexOf(k) >= 0;
    }), String(els['syncStatus'].textContent).slice(0, 120));
  ok('启用同步后数据诚实文案同步更新',
    String(els['storageNotice'].textContent).indexOf('已启用同步') >= 0,
    String(els['storageNotice'].textContent));
  els['syncAnon'].value = 'not-valid';
  els['syncAnonApply'].handlers.click[0]();
  ok('匿名 ID 输入有格式校验',
    String(els['syncStatus'].textContent).indexOf('16 位十六进制') >= 0, '');
  els['syncClear'].handlers.click[0]();
  ok('可恢复本地模式且全程零网络请求',
    D.remote.mode === 'local' && String(els['storageNotice'].textContent).indexOf('不上传') >= 0 &&
    fetchCalls === 0, 'calls=' + fetchCalls);

  global.fetch = prevFetch;
}

/* === 16. 偿还 #19 / #20 / #21 中付的部分（前端目录内） ===
 * 只验付的责任：生成代理配置入口、能力降级口径、生成模板持久化与共用导出入口。
 * 服务端 POST /generate 与模型端到端联调属秦 / 姜，不在这里越界断言。 */
function runLeadRepay() {
  console.log('=== 16. 偿还 #19 代理配置 / #20 能力口径 / #21 生成模板持久化 ===');
  var html16 = read('index.html');
  var app16 = read('src/ui/app.js');
  var views16 = read('src/ui/views.js');
  var settings16 = read('src/ui/settings.js');
  var readme16 = read('README.md');
  var doc1 = read('docs/01-接口契约.md');
  var doc2 = read('docs/02-路线图与任务看板.md');
  var doc4 = read('docs/04-参赛合规.md');
  var prevFetch16 = global.fetch, fetchCalls16 = 0;
  global.fetch = function () { fetchCalls16++; return Promise.reject(new Error('offline')); };

  /* --- #19：endpoint / model 配置入口，刷新保留，清空回本地，零请求 --- */
  ok('#19 界面含服务地址 / 模型 / 状态控件',
    ['genEndpoint', 'genModel', 'genSave', 'genClear', 'genStatus'].every(function (id) {
      return html16.indexOf('id="' + id + '"') >= 0;
    }), '');
  ok('#19 界面不收密钥、前端不带 Authorization',
    !/id="[^"]*(apiKey|token|secret)[^"]*"/i.test(html16) &&
    app16.indexOf('Authorization') < 0 && settings16.indexOf('Authorization') < 0 &&
    !/apiKey|token|secret/.test(settings16), '');
  ok('#19 本机设置只存 endpoint / model 且统一走数据层适配器',
    settings16.indexOf('TTK.data') >= 0 &&
    settings16.indexOf('data.write(GEN_KEY, clean, true)') >= 0 &&
    /endpoint: String/.test(settings16) && /model: String/.test(settings16), '');
  ok('#19 默认本地草稿模式且未配置代理',
    TTK.generator.config().enabled === false && TTK.settings.readGenConfig().endpoint === '',
    JSON.stringify(TTK.generator.config()));

  var genUrl16 = 'http://127.0.0.1:8787/generate';
  els['genEndpoint'].value = genUrl16;
  els['genModel'].value = 'mock-model';
  els['genSave'].handlers.click[0]();
  ok('#19 配置生效并写入本机（刷新后可恢复）',
    TTK.generator.config().enabled === true && TTK.generator.config().model === 'mock-model' &&
    !!D.read(TTK.settings.key, null) && D.read(TTK.settings.key, null).endpoint === genUrl16,
    JSON.stringify(TTK.generator.config()));
  ok('#19 状态区显示服务地址 / 模型 / 密钥口径',
    ['服务地址：', '模型：', '密钥：只放服务端'].every(function (k) {
      return String(els['genStatus'].textContent).indexOf(k) >= 0;
    }), String(els['genStatus'].textContent));
  var traceText16 = D.exportAll(TTK.engine);
  ok('#19 代理配置不进匿名导出 JSON',
    traceText16.indexOf(genUrl16) < 0 && traceText16.indexOf('mock-model') < 0, '');

  // 模拟刷新：清空内存里的 generator 配置，重新载入设置模块并走 app 的恢复入口
  TTK.generator.configure({ endpoint: '', model: '' });
  delete require.cache[require.resolve(path.join(ROOT, 'src/ui/settings.js'))];
  require(path.join(ROOT, 'src/ui/settings.js'));
  var restoredCfg16 = TTK.app.restoreGeneratorConfig();
  ok('#19 刷新后配置仍在并自动生效',
    restoredCfg16.endpoint === genUrl16 && TTK.generator.config().enabled === true,
    JSON.stringify(restoredCfg16));

  els['genClear'].handlers.click[0]();
  ok('#19 清空回到本地草稿模式且全程零网络请求',
    TTK.generator.config().enabled === false &&
    !!D.read(TTK.settings.key, null) && D.read(TTK.settings.key, null).endpoint === '' &&
    fetchCalls16 === 0, 'calls=' + fetchCalls16);
  var draft16 = TTK.generator.generate('未收录概念');
  ok('#19 未配置时代理不会被调用（同步返回本地草稿）',
    !!draft16 && typeof draft16.then !== 'function' && draft16.ai === false && fetchCalls16 === 0, '');
  els['genEndpoint'].value = 'not-a-url';
  els['genSave'].handlers.click[0]();
  ok('#19 非法服务地址被拒绝', TTK.generator.config().enabled === false, '');
  els['genEndpoint'].value = 'http://x/generate?api_key=abc';
  els['genSave'].handlers.click[0]();
  ok('#19 地址里夹带密钥被拒绝', TTK.generator.config().enabled === false, '');

  /* --- #20：冻结方案，界面与四份文档口径统一 --- */
  ok('#20 界面明确能力边界与替代操作',
    ['文字 / 文件名 / 图片内嵌文字', '语音只认文件名', '请改用文字，或把概念写进文件名', '不会上传']
      .every(function (s) { return html16.indexOf(s) >= 0; }) &&
    html16.indexOf('看懂截图') < 0 && html16.indexOf('听懂语音') < 0, '');
  ok('#20 app.js 语音提示与失败提示不夸大能力',
    app16.indexOf('语音只认文件名') >= 0 &&
    app16.indexOf('请改用文字，或把概念写进文件名') >= 0, '');
  ok('#20 README / docs/01 / docs/02 / docs/04 口径一致',
    [readme16, doc1, doc2, doc4].every(function (t) {
      return t.indexOf('文字 / 文件名 / 图片内嵌文字') >= 0 &&
        t.indexOf('语音只认文件名') >= 0 &&
        t.indexOf('看懂截图') < 0 && t.indexOf('听懂语音') < 0;
    }), '');

  /* --- #21：模型模板落盘、不覆盖内置、刷新恢复、导出导入共用入口 --- */
  var probe16 = JSON.parse(read('contracts/examples/spring.json'));
  probe16.id = 'repay_llm_probe';
  probe16.name = '代理生成探针';
  probe16.source = 'llm';
  var saved16 = TTK.app.saveGenerated(probe16);
  ok('#21 模型模板落盘到 ttk.custom.v1 且不含函数',
    saved16 === true && D.custom().some(function (s) {
      return s && s.id === 'repay_llm_probe' && s.source === 'llm';
    }) && JSON.stringify(D.custom()).indexOf('"function"') < 0, '');
  var builtin16 = TTK.templates[0];
  ok('#21 重复 id 不覆盖 10 个内置精修模板',
    TTK.app.saveGenerated(Object.assign({}, probe16, { id: builtin16.id })) === false &&
    !D.custom().some(function (s) { return s && s.id === builtin16.id; }), '');
  if (TTK.engine.get('repay_llm_probe')) TTK.engine.unregister('repay_llm_probe');
  TTK.app.restoreCustom();
  ok('#21 刷新后模型模板自动挂回引擎',
    !!TTK.engine.get('repay_llm_probe') && TTK.engine.get('repay_llm_probe').custom === true, '');
  var exported16 = JSON.parse(D.exportAll(TTK.engine));
  ok('#21 自定义模板随 exportAll 导出且符合 trace v1',
    exported16.schema === 'ttk.learning-trace.v1' && Array.isArray(exported16.customTemplates) &&
    exported16.customTemplates.some(function (s) { return s.id === 'repay_llm_probe'; }), '');
  TTK.engine.unregister('repay_llm_probe');
  D.saveCustom([]);
  var importTrace16 = JSON.stringify({
    schema: 'ttk.learning-trace.v1', events: [], progress: {}, stuck: [],
    customTemplates: [probe16]
  });
  var imported16 = TTK.views.importReport(importTrace16);
  ok('#21 导入 JSON 后模板立即恢复，不必手动刷新',
    imported16 === true && !!TTK.engine.get('repay_llm_probe'), '');
  var draftSpec16 = Object.assign({}, probe16, { id: 'repay_draft_probe', source: 'local-draft' });
  var draftMount16 = TTK.generator.mount(TTK.createEngine(), draftSpec16);
  ok('#21 本地草稿 persist === false，不落盘',
    draftMount16.ok === true && draftMount16.persist === false, '');
  ok('#21 页面文案与实际行为一致',
    app16.indexOf('mounted.persist === true') >= 0 &&
    app16.indexOf('已保存到本机，刷新后仍在') >= 0 &&
    app16.indexOf('刷新页面后不会保留') >= 0, '');
  ok('#21 工坊与报告共用 exportAll / importAll 同一入口',
    ['studioExport', 'studioImport', 'studioImportFile'].every(function (id) {
      return views16.indexOf("'" + id + "'") >= 0;
    }) && views16.indexOf("['studioExport', exportReport]") >= 0, '');
  ok('#19/#21 文档不再把生成链路写成「只在内存 / 骨架」',
    doc1.indexOf('生成模板只在内存里') < 0 && doc2.indexOf('生成的模板只在内存里') < 0, '');

  /* --- 11-09 补充验收：placeholder 路径 / 同 id 导入更新 / 导出白名单 / dsl 校验加严 --- */
  ok('#19 服务地址 placeholder 与服务端 /v1 前缀一致',
    html16.indexOf('http://127.0.0.1:8787/v1/generate') >= 0 &&
    html16.indexOf('POST /v1/generate') >= 0 &&
    read('services/api/README.md').indexOf('/v1/generate') >= 0, '');

  var updated16 = JSON.parse(JSON.stringify(probe16));
  updated16.name = '代理生成探针 v2';
  var importUpdate16 = TTK.views.importReport(JSON.stringify({
    schema: 'ttk.learning-trace.v1', events: [], progress: {}, stuck: [],
    customTemplates: [updated16]
  }));
  ok('#21 导入同 id 新版模板立即更新（先卸载再挂载，不用刷新）',
    importUpdate16 === true && !!TTK.engine.get('repay_llm_probe') &&
    TTK.engine.get('repay_llm_probe').name === '代理生成探针 v2', '');
  var builtinName16 = TTK.engine.get(builtin16.id).name;
  TTK.views.importReport(JSON.stringify({
    schema: 'ttk.learning-trace.v1', events: [], progress: {}, stuck: [],
    customTemplates: [Object.assign({}, probe16, { id: builtin16.id, name: '冒名内置' })]
  }));
  ok('#21 导入撞内置 id 仍不覆盖精修模板',
    TTK.engine.get(builtin16.id).name === builtinName16, '');
  ok('#21 同 id 更新源码走 unregister 且内置受保护',
    app16.indexOf('engine.unregister(spec.id)') >= 0 &&
    app16.indexOf('builtin[spec.id]') >= 0, '');

  D.saveCustom([Object.assign({}, probe16, { author: '张三', school: '某大学' })]);
  var blocked16 = TTK.views.exportReport();
  ok('#21 导出白名单拦截 customTemplates 契约外字段（防夹带可识别信息）',
    blocked16 === null, '');
  D.saveCustom([probe16]);
  ok('#21 白名单字段内的模板正常导出', TTK.views.exportReport() !== null, '');
  var dirty16 = Object.assign({}, probe16, { id: 'repay_dirty_probe', author: '李四' });
  TTK.app.saveGenerated(dirty16);
  ok('#21 落盘前经 dsl.pick 清洗契约外字段（模型输出不夹带进存储与导出）',
    D.custom().some(function (s) { return s && s.id === 'repay_dirty_probe' && s.author === undefined; }) &&
    JSON.stringify(D.custom()).indexOf('李四') < 0, '');
  D.saveCustom(D.custom().filter(function (s) { return s && s.id !== 'repay_dirty_probe'; }));

  var strict16 = JSON.parse(read('contracts/examples/spring.json'));
  strict16.id = 'strict_probe';
  strict16.series[0] = Object.assign({}, strict16.series[0], { style: 'bold' });
  ok('dsl 非法 style 报错（对齐 template.schema.json 枚举）',
    TTK.dsl.validate(strict16, []).ok === false, '');
  var strictMetrics16 = JSON.parse(read('contracts/examples/spring.json'));
  strictMetrics16.id = 'strict_m';
  strictMetrics16.metrics = [0, 1, 2, 3, 4, 5].map(function (i) {
    return { label: 'm' + i, expr: String(i) };
  });
  ok('dsl metrics 超过 5 条报错（不再静默截断）',
    TTK.dsl.validate(strictMetrics16, []).ok === false, '');
  var strictCh16 = JSON.parse(read('contracts/examples/spring.json'));
  strictCh16.id = 'strict_c';
  strictCh16.challenges = [0, 1, 2, 3].map(function (i) {
    return { text: 'c' + i, expr: String(i) + ' > 0' };
  });
  ok('dsl challenges 超过 3 条报错（不再静默截断）',
    TTK.dsl.validate(strictCh16, []).ok === false, '');
  var strictSrc16 = JSON.parse(read('contracts/examples/spring.json'));
  strictSrc16.id = 'strict_s';
  strictSrc16.source = 'someone-typed-this';
  ok('dsl 非法 source 枚举报错',
    TTK.dsl.validate(strictSrc16, []).ok === false, '');
  var legalSrc16 = JSON.parse(read('contracts/examples/spring.json'));
  legalSrc16.id = 'strict_ok';
  legalSrc16.source = 'llm';
  ok('dsl 合法 source 枚举与 style 通过',
    TTK.dsl.validate(legalSrc16, []).ok === true, '');
  ok('schema 已声明可选 source 字段（contracts 四处同步）',
    read('contracts/template.schema.json').indexOf('"source"') >= 0 &&
    doc1.indexOf('枚举 `local-draft` / `llm`') >= 0, '');

  D.saveCustom([]);

  global.fetch = prevFetch16;
}

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
