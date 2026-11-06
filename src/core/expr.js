/* 拖拖看 · 安全表达式求值器
 * ---------------------------------------------------------------
 * 为什么不用 eval / new Function：接上 LLM 之后，公式来自不可信的文本，
 * 拼接执行等于把浏览器整个交出去。这里用递归下降解析器只支持数学表达式，
 * 语法层面就没有「执行任意 JS」的可能，是 AI 生成沙盒的安全基座。
 *
 * 支持：数字、参数 p.k、自变量 x、Math.* / M.*、四则、幂 ^、比较、&& || !、三元 ?:
 * 不支持：赋值、语句、下标、字符串、对象构造、任何全局对象访问。
 */
(function (global) {
  'use strict';

  var TTK = global.TTK = global.TTK || {};
  var TWO = ['<=', '>=', '==', '!=', '&&', '||'];
  var ONE = '+-*/%^<>()!,?:';
  var BLOCKED = { constructor: 1, prototype: 1, __proto__: 1, toString: 1, valueOf: 1, caller: 1, arguments: 1 };
  // 根名白名单：编译期就拒绝任何不在作用域里的标识符，注入表达式进不来
  var ROOTS = {
    x: 1, p: 1, m: 1, M: 1, Math: 1, PI: 1, E: 1,
    abs: 1, sin: 1, cos: 1, tan: 1, exp: 1, log: 1, sqrt: 1, pow: 1,
    min: 1, max: 1, floor: 1, ceil: 1, round: 1, clamp: 1
  };

  function tokenize(src) {
    var s = String(src), i = 0, out = [], m, two, c;
    if (s.length > 300) throw new Error('表达式过长（上限 300 字符）');
    while (i < s.length) {
      c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i));
      if (m) { out.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue; }
      m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(s.slice(i));
      if (m) {
        var parts = m[0].split('.'), k;
        if (!ROOTS[parts[0]]) throw new Error('不允许的标识符「' + parts[0] + '」');
        for (k = 0; k < parts.length; k++) {
          if (BLOCKED[parts[k]]) throw new Error('禁止访问属性 ' + parts[k]);
        }
        out.push({ t: 'ident', v: m[0] }); i += m[0].length; continue;
      }
      two = s.slice(i, i + 2);
      if (TWO.indexOf(two) >= 0) { out.push({ t: two, v: two }); i += 2; continue; }
      if (ONE.indexOf(c) >= 0) { out.push({ t: c, v: c }); i++; continue; }
      throw new Error('表达式含非法字符「' + c + '」');
    }
    if (out.length > 120) throw new Error('表达式过于复杂');
    out.push({ t: 'eof', v: '' });
    return out;
  }

  function lookup(name, sc) {
    var parts = name.split('.'), cur = sc, i;
    for (i = 0; i < parts.length; i++) {
      if (BLOCKED[parts[i]]) throw new Error('禁止访问属性 ' + parts[i]);
      if (cur === null || cur === undefined) throw new Error('未知变量 ' + name);
      if (!(parts[i] in Object(cur))) throw new Error('未知变量 ' + name);
      cur = cur[parts[i]];
    }
    return cur;
  }

  function bin(op, a, b) {
    switch (op) {
      case '+': return function (s) { return a(s) + b(s); };
      case '-': return function (s) { return a(s) - b(s); };
      case '*': return function (s) { return a(s) * b(s); };
      case '/': return function (s) { return a(s) / b(s); };
      case '%': return function (s) { return a(s) % b(s); };
      case '^': return function (s) { return Math.pow(a(s), b(s)); };
      case '<': return function (s) { return a(s) < b(s); };
      case '>': return function (s) { return a(s) > b(s); };
      case '<=': return function (s) { return a(s) <= b(s); };
      case '>=': return function (s) { return a(s) >= b(s); };
      case '==': return function (s) { return a(s) === b(s); };
      case '!=': return function (s) { return a(s) !== b(s); };
      case '&&': return function (s) { return !!(a(s) && b(s)); };
      case '||': return function (s) { return !!(a(s) || b(s)); };
      default: throw new Error('未知运算符 ' + op);
    }
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
      var a = pow(), op, b;
      while (peek().t === '*' || peek().t === '/' || peek().t === '%') { op = take().t; b = pow(); a = bin(op, a, b); }
      return a;
    }
    function pow() {
      var a = unary();
      if (peek().t === '^') { take('^'); return bin('^', a, pow()); }
      return a;
    }
    function unary() {
      var t = peek().t, a;
      if (t === '-') { take(); a = unary(); return function (s) { return -a(s); }; }
      if (t === '+') { take(); return unary(); }
      if (t === '!') { take(); a = unary(); return function (s) { return !a(s); }; }
      return primary();
    }
    function primary() {
      var k = peek(), args, e, name, f;
      if (k.t === 'num') { take(); return function () { return k.v; }; }
      if (k.t === 'ident') {
        take(); name = k.v;
        if (peek().t === '(') {
          take('('); args = [];
          while (peek().t !== ')' && peek().t !== 'eof') {
            args.push(expr());
            if (peek().t === ',') take(','); else break;
          }
          take(')');
          if (args.length > 8) throw new Error('函数参数过多');
          return function (s) {
            var fn = lookup(name, s);
            if (typeof fn !== 'function') throw new Error(name + ' 不是函数');
            return fn.apply(null, args.map(function (g) { return g(s); }));
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

  // 表达式可用的名字都在这里，作用域之外一律不可达
  function scope(p, M) {
    return {
      x: 0, p: p || {}, M: M || TTK.math, Math: Math,
      PI: Math.PI, E: Math.E,
      abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan,
      exp: Math.exp, log: Math.log, sqrt: Math.sqrt, pow: Math.pow,
      min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil,
      round: Math.round, clamp: (M || TTK.math).clamp
    };
  }

  TTK.expr = {
    compile: compile,
    scope: scope,
    validate: function (src) {
      try { return { ok: true, fn: compile(src) }; }
      catch (e) { return { ok: false, error: e.message }; }
    },
    eval: function (src, sc) { return compile(src)(sc); }
  };
})(window);
