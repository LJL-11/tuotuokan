/* 拖拖看 · 安全表达式求值器
 * ---------------------------------------------------------------
 * 为什么不用宿主动态执行：接上 LLM 之后，公式来自不可信的文本，
 * 拼接执行等于把浏览器整个交出去。这里用递归下降解析器只支持数学表达式，
 * 语法层面就没有「执行任意 JS」的可能，是 AI 生成沙盒的安全基座。
 *
 * 支持：数字、参数 p.k、指标 m.v0、自变量 x、Math.* / M.clamp、四则、幂 ^、
 *       比较、&& || !、三元 ?:。
 * 不支持：赋值、语句、下标、字符串、对象构造、白名单外的函数调用、任何全局访问。
 *
 * I8 加固（编译前拒绝，运行时兜底）：
 * - 标识符路径只允许「对象根 + 一层属性」，且 Math / M 成员走白名单；
 * - 函数调用只允许固定的数学函数白名单，参数对象上的任意方法都调不到；
 * - 作用域只暴露白名单纯函数，不把完整的宿主 Math 交出去；
 * - 属性读取只认自有属性，原型链（constructor / 内置方法等）不可达；
 * - 除零、非有限结果、溢出、字面量溢出、深嵌套在编译或求值阶段被明确拒绝；
 * - 幂右结合，且一元负号优先级低于幂（-2^2 = -4）。
 */
(function (global) {
  'use strict';

  var TTK = global.TTK = global.TTK || {};
  var TWO = ['<=', '>=', '==', '!=', '&&', '||'];
  var ONE = '+-*/%^<>()!,?:';
  var BLOCKED = {
    constructor: 1, prototype: 1, __proto__: 1, toString: 1, valueOf: 1,
    caller: 1, callee: 1, arguments: 1,
    __defineGetter__: 1, __defineSetter__: 1, __lookupGetter__: 1, __lookupSetter__: 1
  };
  // 可调用的数学函数白名单：裸函数名、Math.<fn>、M.<fn> 都从这里取
  var FN = {
    abs: 1, sin: 1, cos: 1, tan: 1, exp: 1, log: 1, sqrt: 1, pow: 1,
    min: 1, max: 1, floor: 1, ceil: 1, round: 1, clamp: 1
  };
  var ROOTS = {
    x: 1, p: 1, m: 1, M: 1, Math: 1, PI: 1, E: 1,
    abs: 1, sin: 1, cos: 1, tan: 1, exp: 1, log: 1, sqrt: 1, pow: 1,
    min: 1, max: 1, floor: 1, ceil: 1, round: 1, clamp: 1
  };
  // 只有这些根允许带一层属性；其它根名只能单独出现
  var OBJECT_ROOTS = { p: 1, m: 1, M: 1, Math: 1 };
  var MATH_MEMBERS = {
    abs: 1, sin: 1, cos: 1, tan: 1, exp: 1, log: 1, sqrt: 1, pow: 1,
    min: 1, max: 1, floor: 1, ceil: 1, round: 1,
    PI: 1, E: 1
  };
  var M_MEMBERS = { clamp: 1 };
  var MAX_LEN = 300, MAX_TOKENS = 120, MAX_NEST = 32, MAX_ARGS = 8;
  var hasOwn = Object.prototype.hasOwnProperty;

  function tokenize(src) {
    if (typeof src !== 'string') throw new Error('表达式必须是字符串');
    var s = src, i = 0, out = [], m, two, c;
    if (s.length > MAX_LEN) throw new Error('表达式过长（上限 ' + MAX_LEN + ' 字符）');
    if (!s.trim()) throw new Error('表达式为空');
    while (i < s.length) {
      c = s[i];
      // 只放行四种 ASCII 空白；\s 会放行 U+2028 等分隔符，容易被拿来绕过词法检查
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i));
      if (m) {
        var value = parseFloat(m[0]);
        if (!isFinite(value)) throw new Error('数值字面量溢出');
        out.push({ t: 'num', v: value }); i += m[0].length; continue;
      }
      m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(s.slice(i));
      if (m) {
        var parts = m[0].split('.'), k, member;
        if (!ROOTS[parts[0]]) throw new Error('不允许的标识符「' + parts[0] + '」');
        for (k = 0; k < parts.length; k++) {
          if (BLOCKED[parts[k]]) throw new Error('禁止访问属性 ' + parts[k]);
        }
        if (parts.length > 1) {
          if (parts.length > 2) throw new Error('只允许一层属性访问：' + m[0]);
          if (!OBJECT_ROOTS[parts[0]]) throw new Error('「' + parts[0] + '」不支持属性访问');
          member = parts[1];
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(member)) throw new Error('非法属性名：' + m[0]);
          if (parts[0] === 'Math' && !MATH_MEMBERS[member]) throw new Error('禁止访问属性 Math.' + member);
          if (parts[0] === 'M' && !M_MEMBERS[member]) throw new Error('禁止访问属性 M.' + member);
        }
        out.push({ t: 'ident', v: m[0] }); i += m[0].length; continue;
      }
      two = s.slice(i, i + 2);
      if (TWO.indexOf(two) >= 0) { out.push({ t: two, v: two }); i += 2; continue; }
      if (ONE.indexOf(c) >= 0) { out.push({ t: c, v: c }); i++; continue; }
      throw new Error('表达式含非法字符「' + c + '」');
    }
    if (out.length > MAX_TOKENS) throw new Error('表达式过于复杂（token 上限 ' + MAX_TOKENS + '）');

    // 编译前先量一次嵌套深度，避免递归下降被超深表达式拖成栈溢出
    var depth = 0, maxDepth = 0, run = 0, maxRun = 0, powCount = 0, ternaryCount = 0, j, t;
    for (j = 0; j < out.length; j++) {
      t = out[j].t;
      if (t === '(') { depth++; if (depth > maxDepth) maxDepth = depth; }
      else if (t === ')') { depth--; if (depth < 0) throw new Error('括号不匹配'); }
      if (t === '!' || t === '-' || t === '+' || t === '^' || t === '?') {
        run++; if (run > maxRun) maxRun = run;
      } else run = 0;
      if (t === '^') powCount++;
      if (t === '?' || t === ':') ternaryCount++;
    }
    if (depth !== 0) throw new Error('括号不匹配');
    if (maxDepth > MAX_NEST || maxRun > MAX_NEST || powCount > MAX_NEST || ternaryCount > MAX_NEST) {
      throw new Error('表达式嵌套过深（上限 ' + MAX_NEST + ' 层）');
    }
    out.push({ t: 'eof', v: '' });
    return out;
  }

  function lookup(name, sc) {
    var parts = name.split('.'), cur = sc, i;
    for (i = 0; i < parts.length; i++) {
      if (BLOCKED[parts[i]]) throw new Error('禁止访问属性 ' + parts[i]);
      if (cur === null || cur === undefined || typeof cur !== 'object') throw new Error('未知变量 ' + name);
      // 只认自有属性：原型链上的 constructor / 内置方法一概不可达
      if (!hasOwn.call(cur, parts[i])) throw new Error('未知变量 ' + name);
      cur = cur[parts[i]];
    }
    return cur;
  }

  function numResult(v) {
    if (typeof v !== 'number' || !isFinite(v)) throw new Error('数值溢出或非法结果');
    return v;
  }

  function constNum(v) {
    if (!isFinite(v)) throw new Error('数值字面量溢出');
    var f = function () { return v; };
    f.const = v;
    return f;
  }

  function callable(name) {
    var parts = name.split('.');
    if (parts.length === 1) return !!FN[parts[0]];
    if (parts.length !== 2) return false;
    if (parts[0] === 'Math') return !!FN[parts[1]] && !!MATH_MEMBERS[parts[1]];
    if (parts[0] === 'M') return !!FN[parts[1]] && !!M_MEMBERS[parts[1]];
    return false;
  }

  function bin(op, a, b) {
    var f;
    switch (op) {
      case '+': f = function (s) { return numResult(a(s) + b(s)); }; break;
      case '-': f = function (s) { return numResult(a(s) - b(s)); }; break;
      case '*': f = function (s) { return numResult(a(s) * b(s)); }; break;
      case '/': f = function (s) {
        var d = b(s);
        if (d === 0) throw new Error('除数不能为 0');
        return numResult(a(s) / d);
      }; break;
      case '%': f = function (s) {
        var d = b(s);
        if (d === 0) throw new Error('除数不能为 0');
        return numResult(a(s) % d);
      }; break;
      case '^': f = function (s) { return numResult(Math.pow(a(s), b(s))); }; break;
      case '<': f = function (s) { return a(s) < b(s); }; break;
      case '>': f = function (s) { return a(s) > b(s); }; break;
      case '<=': f = function (s) { return a(s) <= b(s); }; break;
      case '>=': f = function (s) { return a(s) >= b(s); }; break;
      case '==': f = function (s) { return a(s) === b(s); }; break;
      case '!=': f = function (s) { return a(s) !== b(s); }; break;
      case '&&': f = function (s) { return !!(a(s) && b(s)); }; break;
      case '||': f = function (s) { return !!(a(s) || b(s)); }; break;
      default: throw new Error('未知运算符 ' + op);
    }
    // 常量折叠：只做纯数字运算，编译期不执行任何来自作用域的函数
    if (typeof a.const === 'number' && typeof b.const === 'number') {
      var v = f(null);
      if (typeof v === 'number') f.const = v;
    }
    return f;
  }

  function compile(src) {
    var ts = tokenize(src), pos = 0;
    function peek() { return ts[pos]; }
    function take(t) {
      var k = ts[pos];
      if (t && k.t !== t) throw new Error('期望「' + t + '」，实际「' + k.t + '」');
      pos++;
      return k;
    }
    function expr() { return ternary(); }
    function ternary() {
      var a = or();
      if (peek().t === '?') {
        take('?'); var b = ternary(); take(':'); var c = ternary();
        return function (s) { return a(s) ? b(s) : c(s); };
      }
      return a;
    }
    function or() {
      var a = and(), op, b;
      while (peek().t === '||') { op = take().t; b = and(); a = bin(op, a, b); }
      return a;
    }
    function and() {
      var a = cmp(), op, b;
      while (peek().t === '&&') { op = take().t; b = cmp(); a = bin(op, a, b); }
      return a;
    }
    function cmp() {
      var a = add(), op, b;
      while (['<', '>', '<=', '>=', '==', '!='].indexOf(peek().t) >= 0) {
        op = take().t; b = add(); a = bin(op, a, b);
      }
      return a;
    }
    function add() {
      var a = mul(), op, b;
      while (peek().t === '+' || peek().t === '-') { op = take().t; b = mul(); a = bin(op, a, b); }
      return a;
    }
    function mul() {
      var a = unary(), op, b;
      while (peek().t === '*' || peek().t === '/' || peek().t === '%') {
        op = take().t; b = unary();
        if ((op === '/' || op === '%') && typeof b.const === 'number' && b.const === 0) {
          throw new Error('除数不能为 0（编译期拒绝）');
        }
        a = bin(op, a, b);
      }
      return a;
    }
    // 幂右结合；右操作数允许一元负号（2^-2）。base 不含一元负号，
    // 因此 -2^2 解析为 -(2^2) = -4，符合数学惯例。
    function pow() {
      var a = primary();
      if (peek().t === '^') { take('^'); return bin('^', a, unary()); }
      return a;
    }
    function unary() {
      var t = peek().t, a, neg;
      if (t === '-') {
        take(); a = unary();
        if (typeof a.const === 'number') return constNum(-a.const);
        neg = function (s) { return numResult(-a(s)); };
        return neg;
      }
      if (t === '+') {
        take(); a = unary();
        if (typeof a.const === 'number') return constNum(a.const);
        return a;
      }
      if (t === '!') { take(); a = unary(); return function (s) { return !a(s); }; }
      return pow();
    }
    function primary() {
      var k = peek(), args, e, name;
      if (k.t === 'num') { take(); return constNum(k.v); }
      if (k.t === 'ident') {
        take(); name = k.v;
        if (peek().t === '(') {
          if (!callable(name)) throw new Error('不允许调用「' + name + '」');
          take('('); args = [];
          while (peek().t !== ')' && peek().t !== 'eof') {
            args.push(expr());
            if (peek().t === ',') take(','); else break;
          }
          take(')');
          if (args.length > MAX_ARGS) throw new Error('函数参数过多');
          return function (s) {
            var fn = lookup(name, s);
            if (typeof fn !== 'function') throw new Error(name + ' 不是函数');
            return numResult(fn.apply(null, args.map(function (g) { return g(s); })));
          };
        }
        return function (s) { return lookup(name, s); };
      }
      if (k.t === '(') { take('('); e = expr(); take(')'); return e; }
      throw new Error('无法解析「' + k.v + '」');
    }

    var fn = expr();
    if (peek().t !== 'eof') throw new Error('表达式末尾有多余内容「' + peek().v + '」');
    return fn;
  }

  // 作用域只放白名单里的纯函数与常量，绝不把完整的宿主 Math 交出去
  function scope(p, M) {
    var math = M || TTK.math;
    var mathLite = {
      abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan,
      exp: Math.exp, log: Math.log, sqrt: Math.sqrt, pow: Math.pow,
      min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil, round: Math.round,
      PI: Math.PI, E: Math.E
    };
    return {
      x: 0, p: p || {}, m: {},
      M: { clamp: math.clamp }, Math: mathLite,
      PI: Math.PI, E: Math.E,
      abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan,
      exp: Math.exp, log: Math.log, sqrt: Math.sqrt, pow: Math.pow,
      min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil,
      round: Math.round, clamp: math.clamp
    };
  }

  TTK.expr = {
    compile: compile,
    scope: scope,
    validate: function (src) {
      try { return { ok: true, fn: compile(src) }; }
      catch (e) { return { ok: false, error: e.message }; }
    },
    eval: function (src, sc) { return compile(src)(sc || scope()); }
  };
})(window);
