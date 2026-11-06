/* 拖拖看 · 通用沙盒引擎
 * ---------------------------------------------------------------
 * 设计目标：模板只描述「参数 + 关系/模型 + 可观测指标」，
 * 引擎负责状态、计算调度、事件与校验。任意学科概念按同一 schema 注册即可。
 * 不依赖任何框架，双击 index.html 即可运行。
 */
(function (global) {
  'use strict';

  var TTK = global.TTK = global.TTK || {};

  /* ---------------- 数学工具（模板共用） ---------------- */
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function linspace(a, b, n) {
    if (n <= 1) return [a];
    var out = [], i;
    for (i = 0; i < n; i++) out.push(a + (b - a) * i / (n - 1));
    return out;
  }

  // 可复现随机数：保证拖参数时曲线不会随机抖动
  function rng(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  function gaussian(rand) {
    var u = 1 - rand(), v = 1 - rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // Gauss-Jordan 解线性方程组（岭回归用，带主元与奇异保护）
  function solve(A, b) {
    var n = b.length, M = [], i, j, k, maxRow, tmp, pivot, factor;
    for (i = 0; i < n; i++) M.push(A[i].slice().concat([b[i]]));
    for (i = 0; i < n; i++) {
      maxRow = i;
      for (j = i + 1; j < n; j++) {
        if (Math.abs(M[j][i]) > Math.abs(M[maxRow][i])) maxRow = j;
      }
      if (maxRow !== i) { tmp = M[i]; M[i] = M[maxRow]; M[maxRow] = tmp; }
      pivot = M[i][i];
      if (Math.abs(pivot) < 1e-12) {
        pivot = pivot < 0 ? -1e-12 : 1e-12;
        M[i][i] = pivot;
      }
      for (j = i; j <= n; j++) M[i][j] /= pivot;
      for (k = 0; k < n; k++) {
        if (k === i) continue;
        factor = M[k][i];
        if (factor === 0) continue;
        for (j = i; j <= n; j++) M[k][j] -= factor * M[i][j];
      }
    }
    return M.map(function (row) { return row[n]; });
  }

  // 四阶 Runge-Kutta，用于常微分方程数值积分
  function rk4(f, t, y, dt) {
    var k1 = f(t, y);
    var k2 = f(t + dt / 2, y.map(function (v, i) { return v + dt * k1[i] / 2; }));
    var k3 = f(t + dt / 2, y.map(function (v, i) { return v + dt * k2[i] / 2; }));
    var k4 = f(t + dt, y.map(function (v, i) { return v + dt * k3[i]; }));
    return y.map(function (v, i) {
      return v + dt * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]) / 6;
    });
  }

  function fmt(v, digits) {
    if (v === null || v === undefined || !isFinite(v)) return '--';
    var d = digits === undefined ? 2 : digits;
    var a = Math.abs(v);
    if (a !== 0 && (a < 0.001 || a >= 1e6)) return v.toExponential(1);
    return Number(v.toFixed(d)).toString();
  }

  TTK.math = { clamp: clamp, linspace: linspace, rng: rng, gaussian: gaussian, solve: solve, rk4: rk4, fmt: fmt };

  /* ---------------- 事件总线 ---------------- */
  function Emitter() { this._handlers = {}; }
  Emitter.prototype.on = function (evt, fn) {
    (this._handlers[evt] = this._handlers[evt] || []).push(fn);
    return this;
  };
  Emitter.prototype.emit = function (evt, payload) {
    (this._handlers[evt] || []).slice().forEach(function (fn) {
      try { fn(payload); } catch (err) { console.error('[TTK] handler error: ' + evt, err); }
    });
  };

  /* ---------------- 沙盒引擎 ---------------- */
  function Engine() {
    Emitter.call(this);
    this._templates = [];
    this._map = {};
    this.currentId = null;
    this.params = {};
    this.state = null;
    this.revision = 0;
  }
  Engine.prototype = Object.create(Emitter.prototype);
  Engine.prototype.constructor = Engine;

  Engine.prototype.register = function (tpl) {
    var required = ['id', 'name', 'subject', 'params', 'compute'];
    for (var i = 0; i < required.length; i++) {
      if (!tpl[required[i]]) throw new Error('模板缺少字段: ' + required[i] + ' (' + tpl.id + ')');
    }
    if (this._map[tpl.id]) throw new Error('重复模板 id: ' + tpl.id);
    this._templates.push(tpl);
    this._map[tpl.id] = tpl;
    return this;
  };

  Engine.prototype.all = function () { return this._templates.slice(); };
  Engine.prototype.get = function (id) { return this._map[id] || null; };
  Engine.prototype.unregister = function (id) {
    if (!this._map[id]) return false;
    delete this._map[id];
    this._templates = this._templates.filter(function (t) { return t.id !== id; });
    if (this.currentId === id) this.currentId = null;
    return true;
  };

  Engine.prototype.subjects = function () {
    var seen = {}, out = [];
    this._templates.forEach(function (t) {
      if (!seen[t.subject]) { seen[t.subject] = true; out.push(t.subject); }
    });
    return out;
  };

  Engine.prototype.defaults = function (tpl) {
    var p = {};
    tpl.params.forEach(function (def) { p[def.key] = def.default; });
    return p;
  };

  Engine.prototype.select = function (id) {
    var tpl = this.get(id);
    if (!tpl) return false;
    this.currentId = id;
    this.params = this.defaults(tpl);
    this.recompute();
    this.emit('select', this.state);
    return true;
  };

  Engine.prototype.setParam = function (key, raw) {
    var tpl = this.get(this.currentId);
    if (!tpl) return false;
    var def = null;
    for (var i = 0; i < tpl.params.length; i++) if (tpl.params[i].key === key) def = tpl.params[i];
    if (!def) return false;
    var value = parseFloat(raw);
    if (!isFinite(value)) return false;
    value = clamp(value, def.min, def.max);
    if (def.step >= 1) value = Math.round(value / def.step) * def.step;
    if (this.params[key] === value) return false;
    this.params[key] = value;
    this.recompute();
    this.emit('param', { key: key, value: value, state: this.state });
    return true;
  };

  Engine.prototype.reset = function () {
    if (!this.currentId) return;
    this.params = this.defaults(this.get(this.currentId));
    this.recompute();
    this.emit('reset', this.state);
  };

  Engine.prototype.recompute = function () {
    var tpl = this.get(this.currentId);
    if (!tpl) return;
    var spec;
    try {
      spec = tpl.compute(Object.assign({}, this.params), TTK.math);
    } catch (err) {
      console.error('[TTK] compute failed: ' + tpl.id, err);
      spec = { chart: { panels: [] }, metrics: [], insight: '模型计算出错，请调整参数后重试。' };
    }
    this.revision++;
    this.state = {
      tpl: tpl,
      params: Object.assign({}, this.params),
      spec: spec,
      revision: this.revision,
      at: Date.now()
    };
    this.emit('change', this.state);
  };

  // 输入层：把自然语言查询映射到已注册概念（AI 概念识别的本地降级实现）
  Engine.prototype.findByQuery = function (text) {
    var q = String(text || '').trim().toLowerCase();
    if (!q) return null;
    var best = null, bestScore = 0;
    this._templates.forEach(function (t) {
      var score = 0;
      (t.keywords || []).concat([t.name, t.id]).forEach(function (w) {
        var s = String(w).toLowerCase();
        if (!s) return;
        if (q === s) score += 10;
        else if (q.indexOf(s) >= 0 || s.indexOf(q) >= 0) score += 4;
      });
      if (score > bestScore) { bestScore = score; best = t; }
    });
    return best;
  };

  TTK.Emitter = Emitter;
  TTK.Engine = Engine;
  TTK.createEngine = function () { return new Engine(); };
})(window);
