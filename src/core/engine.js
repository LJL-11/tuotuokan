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

  /* ---------------- 模拟运行时（#I9） ----------------
   * 让 ODE 类沙盒按时间步进，ComputeResult 契约保持 v1 不变：
   *   - ODE 定义是模板的可选元数据 tpl.sim（见 src/model/templates.js），
   *     引擎只按通用形状消费，不认模板 id、不硬编码特判（contracts/README「三个不许」）；
   *   - compute(p, M) 仍是纯函数，静态模板数值一个不变；
   *   - 每帧只组装「现有 ComputeResult 形状」的 spec（chart/metrics/insight/m），不新增字段；
   *   - 不 emit change，避免每帧污染学习轨迹（app.js 的 change handler 会 recordTrail）
   *     与挑战判定；播放控件由 UI 层在 index.html 静态声明，经 bindControls 注入；
   *   - 时间由「步数 × 固定 dt」反推，暂停/恢复不补帧、不漂移。
   */
  var SIM_SPEED_MIN = 0.25;
  var SIM_SPEED_MAX = 8;

  // tpl.sim 的通用形状校验：模板提供方程，引擎提供时钟与调度
  function validSim(def) {
    return !!def && typeof def.deriv === 'function' && typeof def.state0 === 'function'
      && typeof def.duration === 'function' && def.dt > 0;
  }

  function createSimulation() {
    var registry = Object.create(null);
    var st = {
      id: null, def: null, tpl: null, params: null, base: null, frame: null,
      y: null, t: 0, steps: 0, total: 0, dt: 0,
      active: false, playing: false, speed: 1, accumulator: 0,
      lastWall: 0, rafId: null, renderer: null, controls: null,
      boundEngine: null, watchedEngine: null, onDeactivate: []
    };

    function hasDom() {
      var d = global.document;
      return !!d && typeof d.createElement === 'function' && !!d.getElementById('stage');
    }
    function canAnimate() {
      return hasDom() && typeof global.requestAnimationFrame === 'function'
        && typeof global.cancelAnimationFrame === 'function' && typeof TTK.Renderer === 'function';
    }
    function cancelLoop() {
      if (st.rafId !== null && typeof global.cancelAnimationFrame === 'function') {
        global.cancelAnimationFrame(st.rafId);
      }
      st.rafId = null;
    }
    function snapshot() {
      return {
        id: st.id, active: st.active, playing: st.playing, speed: st.speed,
        t: st.t, y: st.y ? st.y.slice() : null, steps: st.steps,
        total: st.total, dt: st.dt,
        progress: st.total > 1 ? Math.min(1, st.steps / (st.total - 1)) : 0
      };
    }

    /* 统一 ODE 接口：任何模板都能运行时注册 / 卸载 */
    function register(id, def) {
      if (!id || typeof id !== 'string') throw new Error('ODE 沙盒 id 必须是字符串');
      if (!validSim(def)) {
        throw new Error('ODE 沙盒缺少 deriv/state0/duration/dt: ' + id);
      }
      registry[id] = def;
      return sim;
    }
    function unregister(id) {
      if (!registry[id]) return false;
      delete registry[id];
      if (st.id === id) stop();
      return true;
    }
    function registered() { return Object.keys(registry); }

    /* 模板元数据发现：app.js 注册完模板后调一次 mount(engine)。
     * AI 生成 / 工坊新挂载的模板带 tpl.sim 时，attach() 也会懒发现。 */
    function discover(tpl) {
      if (!tpl || !tpl.id) return false;
      if (registry[tpl.id]) return true;
      if (!validSim(tpl.sim)) return false;
      registry[tpl.id] = tpl.sim;
      return true;
    }
    function mount(eng) {
      eng = eng || TTK.engine;
      if (!eng || typeof eng.all !== 'function') return [];
      var ids = [];
      eng.all().forEach(function (t) { if (discover(t)) ids.push(t.id); });
      bindEngine(eng);
      syncControls();
      return ids;
    }
    function supported(id, eng) {
      eng = eng || st.boundEngine || TTK.engine;
      var tpl = eng && typeof eng.get === 'function' ? eng.get(id || (eng.currentId)) : null;
      return !!(registry[id] || (tpl && validSim(tpl.sim)));
    }

    /* UI 层注入：控件是 index.html 里的静态 DOM，渲染器复用 app.js 的实例 */
    function bindControls(els) {
      st.controls = els || null;
      syncControls();
      return sim;
    }
    function setRenderer(r) { st.renderer = r || null; return sim; }
    function onDeactivate(fn) {
      if (typeof fn === 'function') st.onDeactivate.push(fn);
      return sim;
    }
    function fireDeactivate() {
      st.onDeactivate.slice().forEach(function (fn) {
        try { fn(); } catch (e) { console.error('[TTK] sim deactivate hook error', e); }
      });
    }

    /* 只截断「点数 == 总步数」的序列：时间序列与相图按帧揭示，
     * 与步数无关的扫描曲线（如 R0 sweep）原样保留。规则通用，不认模板 id。 */
    function buildFrame(idx) {
      var base = st.base;
      var panels = ((base.chart && base.chart.panels) || []).map(function (p, pi) {
        var series = (p.series || []).map(function (s) {
          var pts = s.points || [];
          return {
            name: s.name, color: s.color,
            points: pts.length === st.total ? pts.slice(0, idx + 1) : pts,
            style: s.style, width: s.width, fill: s.fill
          };
        });
        var markers = (p.markers || []).slice();
        if (pi === 0 && typeof st.def.marker === 'function') {
          var mk = st.def.marker(st.t, st.y, st.params);
          if (mk && isFinite(mk.x) && isFinite(mk.y)) {
            markers = markers.concat([{ x: mk.x, y: mk.y, label: mk.label, color: mk.color }]);
          }
        }
        return {
          title: p.title, xLabel: p.xLabel, yLabel: p.yLabel,
          xDomain: p.xDomain, yDomain: p.yDomain,
          series: series, markers: markers,
          guides: (p.guides || []).slice(), bands: (p.bands || []).slice()
        };
      });
      return {
        chart: { panels: panels },
        metrics: base.metrics,
        insight: base.insight,
        m: base.m
      };
    }

    function renderFrame() {
      if (!hasDom() || !st.frame) return;
      try {
        var canvas = global.document.getElementById('stage');
        if (!canvas || typeof canvas.getContext !== 'function') return;
        if (!st.renderer && typeof TTK.Renderer === 'function') {
          st.renderer = new TTK.Renderer(canvas);   // 仅无 app.js 时兜底
        }
        if (st.renderer) st.renderer.draw(st.frame.chart);
      } catch (e) { /* 无 Canvas 环境（本地校验 / 后台标签）静默跳过 */ }
    }

    function integrate(n) {
      if (!st.active || n <= 0) return 0;
      var room = st.total - 1 - st.steps;
      if (n > room) n = room;
      var d = st.def, p = st.params;
      var f = function (tt, ss) { return d.deriv(tt, ss, p); };  // rk4 只回传 (t, y)，参数由闭包注入
      for (var i = 0; i < n; i++) {
        st.y = TTK.math.rk4(f, st.t, st.y, d.dt);
        st.steps++;
      }
      st.t = st.steps * d.dt;   // 由步数反推，长跑无浮点累积误差
      st.frame = buildFrame(st.steps);
      return n;
    }

    function syncControls() {
      ensureWatch();
      var c = st.controls;
      if (!c) return;
      var eng = st.boundEngine || TTK.engine;
      var cur = eng && eng.currentId;
      var can = st.active || supported(cur, eng);
      if (c.bar) c.bar.hidden = !can;             // 静态概念上零视觉侵入
      if (c.btn) {
        c.btn.disabled = !can;
        c.btn.textContent = st.playing ? '暂停' : '播放模拟';
      }
      if (c.speed) { c.speed.disabled = !st.active; c.speed.value = String(st.speed); }
      if (c.resetBtn) c.resetBtn.disabled = !st.active;
      if (c.label) {
        var unit = (st.def && st.def.unit) || 's';   // 单位来自模板元数据，不认模板 id
        c.label.textContent = !can ? '当前概念暂无动态模拟'
          : !st.active ? '可播放动态模拟'
            : (st.playing ? '播放中' : st.steps >= st.total - 1 ? '已结束' : '已暂停') +
              ' · t=' + st.t.toFixed(2) + unit + ' · ' + st.speed + '×';
      }
    }

    function ensureWatch() {
      var e = TTK.engine;
      if (!e || st.watchedEngine === e || typeof e.on !== 'function' || !st.controls) return;
      st.watchedEngine = e;
      ['select', 'change'].forEach(function (evt) {
        e.on(evt, function () { syncControls(); });
      });
    }

    /* 参数 / 概念一变，静态链路会立刻重画；模拟状态随之失效，自动停止 */
    function bindEngine(eng) {
      if (!eng || st.boundEngine === eng || typeof eng.on !== 'function') return;
      st.boundEngine = eng;
      ['select', 'param', 'reset', 'unregister'].forEach(function (evt) {
        eng.on(evt, function () { if (st.active) stop(); });
      });
    }

    function attach(id, eng) {
      eng = eng || TTK.engine;
      if (!eng || typeof eng.get !== 'function') return false;
      var tplId = id || eng.currentId;
      var tpl = eng.get(tplId);
      if (!tpl) return false;
      discover(tpl);                    // 运行时新挂载的模板也能被识别
      var def = registry[tplId];
      if (!def) return false;
      var p = eng.currentId === tplId ? Object.assign({}, eng.params) : eng.defaults(tpl);
      var base;
      try { base = tpl.compute(p, TTK.math); } catch (e) { return false; }
      stop();
      st.id = tplId; st.def = def; st.tpl = tpl; st.params = p;
      st.base = base; st.dt = def.dt;
      st.total = Math.max(2, Math.round(def.duration(p) / def.dt) + 1);
      st.y = def.state0(p).slice();
      st.t = 0; st.steps = 0; st.active = true; st.playing = false;
      st.frame = buildFrame(0);
      renderFrame();
      bindEngine(eng);
      syncControls();
      return true;
    }

    function advance(ms) {
      if (!st.active || !st.playing) return snapshot();   // 暂停时零推进
      if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return snapshot();
      st.accumulator += ms * st.speed / 1000;
      var want = Math.floor(st.accumulator / st.dt);
      if (want > 600) { want = 600; st.accumulator = 0; }  // 后台标签回来不补帧爆炸
      else st.accumulator -= want * st.dt;
      if (want > 0) integrate(want);
      if (st.steps >= st.total - 1) { st.playing = false; cancelLoop(); }
      renderFrame();
      syncControls();
      return snapshot();
    }

    function loop(now) {
      if (!st.playing) return;
      var wall = typeof now === 'number' ? now : nowMs();
      var delta = Math.max(0, Math.min(wall - st.lastWall, 100));
      st.lastWall = wall;
      advance(delta);
      if (st.playing && canAnimate()) st.rafId = global.requestAnimationFrame(loop);
    }

    function play() {
      if (!st.active) return false;
      if (st.steps >= st.total - 1) reset();
      if (st.playing) return true;
      st.playing = true;
      st.accumulator = 0;
      st.lastWall = nowMs();
      if (canAnimate()) st.rafId = global.requestAnimationFrame(loop);
      syncControls();
      return true;
    }
    function pause() {
      st.playing = false;
      cancelLoop();
      st.accumulator = 0;
      st.lastWall = 0;
      syncControls();
      return snapshot();
    }
    function toggle() { return st.playing ? (pause(), true) : play(); }
    function stop() {
      var wasActive = st.active;
      st.playing = false;
      cancelLoop();
      st.active = false;
      st.accumulator = 0;
      st.lastWall = 0;
      syncControls();
      // 让 UI 重画静态 spec，避免拖参数 / 切概念后画面停在模拟最后一帧
      if (wasActive) fireDeactivate();
      return snapshot();
    }
    function reset() {
      if (!st.active) return false;
      pause();
      st.t = 0; st.steps = 0;
      st.y = st.def.state0(st.params).slice();
      st.frame = buildFrame(0);
      renderFrame();
      syncControls();
      return true;
    }
    function setSpeed(x) {
      var v = Number(x);
      if (!isFinite(v) || v <= 0) return false;
      st.speed = Math.min(SIM_SPEED_MAX, Math.max(SIM_SPEED_MIN, v));
      syncControls();
      return true;
    }
    function step(n) {
      if (!st.active) return snapshot();
      n = Math.floor(Number(n));
      if (!isFinite(n) || n < 1) n = 1;
      integrate(n);
      if (st.steps >= st.total - 1) { st.playing = false; cancelLoop(); }
      renderFrame();
      syncControls();
      return snapshot();
    }

    var sim = {
      register: register, unregister: unregister, registered: registered,
      mount: mount, supported: supported, discover: discover,
      bindControls: bindControls, setRenderer: setRenderer, onDeactivate: onDeactivate,
      attach: attach, play: play, pause: pause, toggle: toggle, stop: stop,
      reset: reset, setSpeed: setSpeed, step: step, advance: advance,
      state: snapshot,
      spec: function () { return st.frame; }
    };
    return sim;
  }

  TTK.sim = createSimulation();
})(window);
