/* 拖拖看 · 通用沙盒引擎
 * ---------------------------------------------------------------
 * 设计目标：模板只描述「参数 + 关系/模型 + 可观测指标」，
 * 引擎负责状态、计算调度、事件与校验。任意学科概念按同一 schema 注册即可。
 * 不依赖任何框架，双击 index.html 即可运行。
 *
 * #I7 运行时能力：
 *  - 模板与插件都可在运行时注册 / 卸载，并广播 register / unregister 事件；
 *  - 按模板 + 参数快照缓存 compute 结果（依赖 docs/01 的纯函数契约）；
 *  - 单次重算计时，默认预算 16ms；超预算告警 + 缓存优先降级，计算结果不变。
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

  /* ---------------- 模板级缓存（#I7） ----------------
   * 每个模板一个 LRU 桶，按参数快照索引。compute 是纯函数（docs/01），
   * 因此同一参数组合可以安全复用上次的 ComputeResult，数值逐点不变。
   */
  var DEFAULT_BUDGET_MS = 16;
  var DEFAULT_CACHE_LIMIT = 64;

  function nowMs() {
    var p = global.performance;
    return p && typeof p.now === 'function' ? p.now() : Date.now();
  }

  function Cache(limit) {
    this.limit = limit;
    this.entries = Object.create(null);
    this.order = [];
    this.evictions = 0;
  }
  Cache.prototype.get = function (key) {
    if (!Object.prototype.hasOwnProperty.call(this.entries, key)) return undefined;
    var i = this.order.indexOf(key);
    if (i >= 0) { this.order.splice(i, 1); this.order.push(key); }
    return this.entries[key];
  };
  Cache.prototype.set = function (key, value) {
    if (Object.prototype.hasOwnProperty.call(this.entries, key)) {
      var i = this.order.indexOf(key);
      if (i >= 0) this.order.splice(i, 1);
    }
    this.entries[key] = value;
    this.order.push(key);
    this.trim();
  };
  Cache.prototype.trim = function () {
    while (this.order.length > this.limit) {
      var old = this.order.shift();
      delete this.entries[old];
      this.evictions++;
    }
  };
  Cache.prototype.clear = function () {
    this.entries = Object.create(null);
    this.order = [];
  };

  /* ---------------- 沙盒引擎 ---------------- */
  function Engine() {
    Emitter.call(this);
    this._templates = [];
    this._map = Object.create(null);
    this.currentId = null;
    this.params = {};
    this.state = null;
    this.revision = 0;

    this.budgetMs = DEFAULT_BUDGET_MS;   // 单次重算预算，0 = 关闭检查
    this.cacheLimit = DEFAULT_CACHE_LIMIT;
    this._cache = Object.create(null);   // id -> Cache
    this._plugins = [];                 // [{ id, plugin }]
    this._degraded = Object.create(null); // id -> 连续超预算次数
    this._lastWarn = Object.create(null);
    this._pendingRecompute = null;
    this.lastCostMs = 0;
    this.lastCacheHit = false;
    this._stats = { recomputes: 0, hits: 0, misses: 0, overBudget: 0, totalCostMs: 0, maxCostMs: 0 };
  }
  Engine.prototype = Object.create(Emitter.prototype);
  Engine.prototype.constructor = Engine;

  /* ---- 注册表：运行时插拔 ---- */
  Engine.prototype.register = function (tpl) {
    var required = ['id', 'name', 'subject', 'params', 'compute'];
    if (!tpl || typeof tpl !== 'object' || Array.isArray(tpl)) throw new Error('模板必须是对象');
    for (var i = 0; i < required.length; i++) {
      if (!tpl[required[i]]) throw new Error('模板缺少字段: ' + required[i] + ' (' + tpl.id + ')');
    }
    if (typeof tpl.compute !== 'function') throw new Error('模板 compute 必须是函数: ' + tpl.id);
    if (!Array.isArray(tpl.params)) throw new Error('模板 params 必须是数组: ' + tpl.id);
    if (this._map[tpl.id]) throw new Error('重复模板 id: ' + tpl.id);
    this.clearCache(tpl.id);          // 同 id 重新挂载：旧实现的结果不能复用
    delete this._degraded[tpl.id];
    this._templates.push(tpl);
    this._map[tpl.id] = tpl;
    this.emit('register', { id: tpl.id, tpl: tpl });
    return this;
  };

  Engine.prototype.all = function () { return this._templates.slice(); };
  Engine.prototype.get = function (id) { return this._map[id] || null; };

  Engine.prototype.unregister = function (id) {
    var tpl = this._map[id];
    if (!tpl) return false;
    delete this._map[id];
    this._templates = this._templates.filter(function (t) { return t.id !== id; });
    this.clearCache(id);
    delete this._degraded[id];
    delete this._lastWarn[id];
    var wasCurrent = this.currentId === id;
    if (wasCurrent) {
      if (this._pendingRecompute) { clearTimeout(this._pendingRecompute); this._pendingRecompute = null; }
      this.currentId = null;
      this.params = {};
      var next = this._templates[0];
      if (next) this.select(next.id);   // 保证 change 事件始终带完整 state（app.js 依赖）
      else this.state = null;           // 一个模板都不剩时不发 change，避免 UI 读到空 state
    }
    this.emit('unregister', { id: id, tpl: tpl, wasCurrent: wasCurrent, state: this.state });
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

  /* ---- 插件：运行时装卸，提供重算前后钩子 ----
   * plugin = { id, install(engine)?, uninstall(engine)?,
   *            beforeRecompute(ctx, engine)?, afterRecompute(ctx, engine)? }
   * 钩子抛错只记日志，不影响重算。ctx 见 recompute()。
   */
  Engine.prototype.use = function (plugin) {
    if (!plugin || typeof plugin !== 'object' || !plugin.id) throw new Error('插件缺少 id');
    for (var i = 0; i < this._plugins.length; i++) {
      if (this._plugins[i].id === plugin.id) throw new Error('重复插件 id: ' + plugin.id);
    }
    this._plugins.push({ id: plugin.id, plugin: plugin });
    if (typeof plugin.install === 'function') {
      try { plugin.install(this); } catch (e) { console.error('[TTK] plugin install error: ' + plugin.id, e); }
    }
    this.emit('plugin', { action: 'use', id: plugin.id });
    return this;
  };

  Engine.prototype.unuse = function (id) {
    for (var i = 0; i < this._plugins.length; i++) {
      if (this._plugins[i].id !== id) continue;
      var plugin = this._plugins[i].plugin;
      this._plugins.splice(i, 1);
      if (typeof plugin.uninstall === 'function') plugin.uninstall(this);
      else if (typeof plugin.dispose === 'function') plugin.dispose(this);
      this.emit('plugin', { action: 'unuse', id: id });
      return true;
    }
    return false;
  };

  Engine.prototype.plugins = function () {
    return this._plugins.map(function (p) { return p.id; });
  };

  Engine.prototype._runHook = function (name, ctx) {
    for (var i = 0; i < this._plugins.length; i++) {
      var fn = this._plugins[i].plugin[name];
      if (typeof fn !== 'function') continue;
      try { fn(ctx, this); } catch (e) { console.error('[TTK] plugin hook error: ' + name, e); }
    }
  };

  /* ---- 缓存与预算的可观测接口 ---- */
  Engine.prototype._ensureCache = function (id) {
    if (!this._cache[id]) this._cache[id] = new Cache(this.cacheLimit);
    return this._cache[id];
  };

  Engine.prototype._cacheKey = function (tpl, p) {
    var parts = [];
    for (var i = 0; i < tpl.params.length; i++) {
      var k = tpl.params[i].key, v = p[k];
      parts.push(k + '=' + (typeof v === 'number' ? (v === 0 ? '0' : String(v)) : JSON.stringify(v)));
    }
    return parts.join('|');
  };

  Engine.prototype.clearCache = function (id) {
    if (id === undefined) {
      Object.keys(this._cache).forEach(function (k) { delete this._cache[k]; }, this);
      return this;
    }
    delete this._cache[id];
    return this;
  };

  Engine.prototype.cacheStats = function () {
    var per = {}, size = 0, evictions = 0, self = this;
    Object.keys(this._cache).forEach(function (id) {
      var c = self._cache[id];
      per[id] = { size: c.order.length, limit: c.limit, evictions: c.evictions };
      size += c.order.length;
      evictions += c.evictions;
    });
    return { size: size, evictions: evictions, perTemplate: per };
  };

  Engine.prototype.setBudget = function (ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) throw new Error('预算需为非负毫秒数');
    this.budgetMs = ms;
    return this;
  };

  Engine.prototype.setCacheLimit = function (n) {
    var limit = Math.max(1, Math.floor(n));
    if (!isFinite(limit) || limit < 1) throw new Error('缓存容量需为正整数');
    this.cacheLimit = limit;
    var self = this;
    Object.keys(this._cache).forEach(function (id) {
      var c = self._cache[id];
      c.limit = self._degraded[id] ? limit * 4 : limit;
      c.trim();
    });
    return this;
  };

  Engine.prototype.stats = function () {
    var s = Object.assign({}, this._stats);
    s.budgetMs = this.budgetMs;
    s.cacheLimit = this.cacheLimit;
    s.cache = this.cacheStats();
    s.degraded = Object.keys(this._degraded);
    s.plugins = this.plugins();
    s.lastCostMs = this.lastCostMs;
    s.lastCacheHit = this.lastCacheHit;
    return s;
  };

  /* ---- 状态与重算 ---- */
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

  /* recompute(opts)
   *   opts.force    = true  忽略缓存读，强制重算并刷新该条目
   *   opts.noCache  = true  完全不读不写缓存（benchmark 测原始耗时用）
   * 其余行为（state 形状、change 事件、revision）与 v0 完全一致。
   */
  Engine.prototype.recompute = function (opts) {
    var tpl = this.get(this.currentId);
    if (!tpl) return;
    opts = opts || {};
    var p = Object.assign({}, this.params);
    var key = this._cacheKey(tpl, p);
    var cache = opts.noCache ? null : this._ensureCache(tpl.id);
    var hit = false, failed = false, spec = null;

    var ctx = {
      id: tpl.id, tpl: tpl, params: p, cacheHit: false, costMs: 0,
      budgetMs: this.budgetMs, degraded: false, consecutive: 0,
      spec: null, failed: false, state: null
    };
    this._runHook('beforeRecompute', ctx);

    var t0 = nowMs();
    if (cache && !opts.force) {
      var cached = cache.get(key);
      if (cached !== undefined) { spec = cached; hit = true; }
    }
    if (!hit) {
      try {
        spec = tpl.compute(p, TTK.math);
      } catch (err) {
        console.error('[TTK] compute failed: ' + tpl.id, err);
        failed = true;
        spec = { chart: { panels: [] }, metrics: [], insight: '模型计算出错，请调整参数后重试。' };
      }
      if (cache && !failed) cache.set(key, spec);
    }
    this.revision++;
    this.state = {
      tpl: tpl,
      params: p,
      spec: spec,
      revision: this.revision,
      at: Date.now()
    };
    var costMs = nowMs() - t0;

    this.lastCostMs = costMs;
    this.lastCacheHit = hit;
    this._stats.recomputes++;
    if (hit) this._stats.hits++; else this._stats.misses++;
    this._stats.totalCostMs += costMs;
    if (costMs > this._stats.maxCostMs) this._stats.maxCostMs = costMs;

    // 预算只针对「真实计算」：命中缓存本来就是降级手段，不算超预算
    var over = this.budgetMs > 0 && !hit && !failed && costMs > this.budgetMs;
    if (over) {
      this._stats.overBudget++;
      var n = (this._degraded[tpl.id] || 0) + 1;
      this._degraded[tpl.id] = n;
      if (cache) { cache.limit = this.cacheLimit * 4; cache.trim(); }
      ctx.consecutive = n;
      ctx.degraded = true;
    } else if (!hit && !failed) {
      if (this._degraded[tpl.id]) {
        delete this._degraded[tpl.id];
        if (cache) { cache.limit = this.cacheLimit; cache.trim(); }
      }
    }
    ctx.cacheHit = hit;
    ctx.costMs = costMs;
    ctx.failed = failed;
    ctx.spec = spec;
    ctx.state = this.state;
    this._runHook('afterRecompute', ctx);

    if (over) {
      this.emit('budget', ctx);
      // 告警节流：同一个模板 1 秒内最多一条，避免拖动时刷屏
      var last = this._lastWarn[tpl.id] || 0, at = Date.now();
      if (at - last > 1000) {
        this._lastWarn[tpl.id] = at;
        console.warn('[TTK] 重算超预算: ' + tpl.id + ' ' + costMs.toFixed(2) + 'ms > ' +
          this.budgetMs + 'ms，已启用缓存优先降级');
      }
    }
    this.emit('change', this.state);
  };

  /* 预算感知的合并重算（降级入口）
   * 只对超预算模板生效：同一事件循环内多次请求合并为一次，参数取最新，
   * 数值等价于「最后一次同步重算」，但重算次数减少。现有同步 API 不受影响；
   * 想用它的上层应改调本方法，不要与 setParam() 混用。
   */
  Engine.prototype.requestRecompute = function () {
    if (!this._degraded[this.currentId]) { this.recompute(); return; }
    if (this._pendingRecompute) return;
    var self = this;
    this._pendingRecompute = setTimeout(function () {
      self._pendingRecompute = null;
      self.recompute();
    }, 0);
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
  TTK.Cache = Cache;
  TTK.Engine = Engine;
  TTK.createEngine = function () { return new Engine(); };
})(window);
