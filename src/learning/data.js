/* 拖拖看 · 数据层
 * ---------------------------------------------------------------
 * 所有读写都经过这一层：应用层 / 图谱 / 报告 / 工坊都不碰 localStorage。
 * 换成后端 REST 只需替换适配器，上层一行都不用改（#I10）。
 * 导出的是匿名试用数据，可直接作验证材料。
 */
(function (global) {
  'use strict';

  var TTK = global.TTK = global.TTK || {};
  var K = {
    trail: 'ttk.trail.v1',
    progress: 'ttk.progress.v1',
    stuck: 'ttk.stuck.v1',
    custom: 'ttk.custom.v1',
    remote: 'ttk.remote.v1',
    anon: 'ttk.anon.v1',
    sync: 'ttk.sync.v1',
    ignoreLegacy: 'ttk.ignore-legacy.v1'
  };
  // 早期 / 手工导入的数据可能落在无版本后缀的键上。只接管、不删除原键，
  // 这样旧轨迹永远可回滚，也不会和用户自己存的副本打架。
  var LEGACY = {
    trail: ['ttk.trail', 'ttk.trace'],
    progress: ['ttk.progress'],
    stuck: ['ttk.stuck']
  };
  var REASONS = ['param', 'select', 'reset', 'stuck', 'challenge', 'view'];
  var MAX_TRAIL = 300, MAX_STUCK = 200, MAX_BATCH = 50;
  var memory = Object.create(null);

  function read(key, fallback) {
    if (Object.prototype.hasOwnProperty.call(memory, key)) return memory[key];
    try {
      var raw = global.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function write(key, value, silent) {
    try {
      global.localStorage.setItem(key, JSON.stringify(value));
      delete memory[key];
    } catch (e) {
      memory[key] = value; // 存储不可用时，本次页面会话仍可继续学习。
      if (remote) remote.storageError = '本机存储不可用，待上传数据暂存内存，关闭页面前请导出';
    }
    if (!silent) notify(key, value);
  }
  var listeners = [];
  function notify(key, value) {
    listeners.slice().forEach(function (fn) {
      try { fn(key, value); } catch (e) { console.error('[TTK] data listener', e); }
    });
  }

  /* ---------------- 匿名身份（#I11 的基础） ----------------
   * 16 位十六进制（64 bit）随机串，不含姓名 / 学校 / 学号 / 设备指纹，也不由服务端拼装，
   * 只用于匿名演示同步，不是正式账号认证。
   * 换设备时由用户手动输入同一 ID 完成接续。
   */
  function randomAnonId() {
    var s = '', bytes, i;
    if (global.crypto && typeof global.crypto.getRandomValues === 'function') {
      bytes = new Uint8Array(8);
      global.crypto.getRandomValues(bytes);
      for (i = 0; i < bytes.length; i++) s += ('0' + bytes[i].toString(16)).slice(-2);
      return s;
    }
    throw new Error('浏览器不支持安全随机数，请使用支持 crypto.getRandomValues 的浏览器');
  }
  function validAnonId(id) { return /^[0-9a-f]{16}$/.test(String(id || '')); }

  function eventKey(e) { return JSON.stringify([e.at, e.tpl, e.reason]); }
  function unique(list, key) {
    var seen = Object.create(null);
    return list.filter(function (item) {
      var k = key(item);
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });
  }
  function snapshot() {
    return {
      schema: 'ttk.learning-trace.v1', exportedAt: new Date().toISOString(),
      events: Data.trail(), progress: Data.progress(), stuck: Data.stuck(), customTemplates: Data.custom()
    };
  }
  function applySnapshot(trace, merge, localWins) {
    var local = merge ? snapshot() : { events: [], progress: {}, stuck: [], customTemplates: [] };
    var events = unique(normalizeTrail((trace.events || []).concat(local.events)).value, eventKey);
    events.sort(function (a, b) { return a.at - b.at; });
    var progress = normalizeProgress(trace.progress).value;
    Object.keys(local.progress).forEach(function (k) { progress[k] = !!(progress[k] || local.progress[k]); });
    var stuck = unique(normalizeStuck((trace.stuck || []).concat(local.stuck)).value, function (e) {
      return JSON.stringify([e.at, e.tpl]);
    }).sort(function (a, b) { return a.at - b.at; });
    var templates = Object.create(null);
    var custom = localWins ? (trace.customTemplates || []).concat(local.customTemplates) : local.customTemplates.concat(trace.customTemplates || []);
    custom.forEach(function (spec) {
      if (spec && typeof spec.id === 'string') templates[spec.id] = spec;
    });
    write(K.trail, events.slice(-MAX_TRAIL));
    write(K.progress, progress);
    write(K.stuck, stuck.slice(-MAX_STUCK));
    write(K.custom, Object.keys(templates).map(function (id) { return templates[id]; }));
    write(K.ignoreLegacy, true, true);
  }

  var remote = {
    mode: 'local',
    endpoint: '',
    queue: [],
    retry: 0,
    timer: null,
    inflight: false,
    lastError: '',
    storageError: '',
    epoch: 0,
    state: null,
    stateKey: '',
    flight: null,

    checkpoint: function () {
      if (!this.state) return;
      this.state.cache = snapshot();
      write(this.stateKey, this.state, true);
    },

    // 每个服务地址与匿名身份有独立的缓存和队列，切换时不串号。
    activate: function (seed) {
      this.stateKey = K.sync + ':' + encodeURIComponent(this.endpoint) + ':' + this.identity();
      var saved = read(this.stateKey, null);
      var restored = saved && saved.cache && Array.isArray(saved.queue);
      this.state = restored ? saved : {
        queue: seed ? seed.events.slice() : [], dirty: !!seed, revision: 0,
        cache: seed || { events: [], progress: {}, stuck: [], customTemplates: [] }
      };
      this.state.revision = Number.isSafeInteger(this.state.revision) ? this.state.revision : 0;
      this.queue = this.state.queue;
      applySnapshot(this.state.cache, false);
      if (seed && restored) {
        applySnapshot(seed, true, true);
        this.queue = this.state.queue = unique(this.queue.concat(seed.events), eventKey);
        this.state.dirty = true;
        this.state.revision++;
      }
      this.checkpoint();
    },

    stop: function () {
      this.epoch++;
      if (this.timer) global.clearTimeout(this.timer);
      this.timer = null;
      this.flight = null;
      this.inflight = false;
      this.retry = 0;
      this.lastError = '';
    },

    configure: function (url) {
      var next = String(url || '').trim().replace(/\/+$/, '');
      if (next && !/^https?:\/\/[^\s?#]+$/i.test(next)) throw new Error('服务地址必须是完整的 HTTP(S) URL');
      var seed = this.mode === 'local' ? snapshot() : null;
      this.checkpoint();
      this.stop();
      this.endpoint = next;
      this.mode = this.endpoint ? 'rest' : 'local';
      write(K.remote, { endpoint: this.endpoint });
      if (this.mode === 'rest') {
        this.activate(seed);
        this.schedule();
      } else {
        this.state = null;
        this.queue = [];
      }
      return this.mode;
    },

    // 本地已有的匿名 ID；没有就生成一个并落盘，之后所有请求都带它
    identity: function (id) {
      var saved = read(K.anon, null);
      if (id !== undefined) {
        var next = String(id || '').trim().toLowerCase();
        if (!validAnonId(next)) return { ok: false, error: '匿名 ID 需为 16 位十六进制' };
        var previous = typeof saved === 'string' ? saved : saved && saved.anonId;
        if (next === previous) return { ok: true, anonId: next };
        this.checkpoint();
        this.stop();
        write(K.anon, next);
        if (this.mode === 'rest') {
          this.activate(null);
          this.schedule();
        } else if (previous) {
          applySnapshot({}, false);
        }
        return { ok: true, anonId: next };
      }
      var cur = typeof saved === 'string' ? saved : (saved && saved.anonId);
      if (validAnonId(cur)) return cur;
      var fresh = randomAnonId();
      write(K.anon, fresh);
      return fresh;
    },

    changed: function () {
      if (this.mode !== 'rest' || !this.state) return;
      this.state.dirty = true;
      this.state.revision++;
      this.checkpoint();
      this.schedule();
    },

    push: function (event) {
      if (this.mode !== 'rest' || !this.state) return;
      var item = normalizeEvent(event), key = eventKey(item);
      if (!this.queue.some(function (e) { return eventKey(e) === key; })) this.queue.push(item);
      // 不静默截断待发送事件；按 50 条分批，浏览器配额不足时报告 storageError。
      this.changed();
    },

    schedule: function () {
      var self = this;
      Promise.resolve().then(function () { self.flush(); });
    },

    // 返回 Promise，页面层 getter 仍同步读缓存。失败保留队列，4xx 明确报错而不丢数据。
    flush: function () {
      var self = this;
      if (this.flight) return this.flight;
      if (this.mode !== 'rest' || !this.state || typeof global.fetch !== 'function') return Promise.resolve({ ok: false, local: true });
      if (global.navigator && global.navigator.onLine === false) return Promise.resolve({ ok: false, offline: true });
      if (this.timer) global.clearTimeout(this.timer);
      this.timer = null;
      var epoch = this.epoch, state = this.state, endpoint = this.endpoint, anonId = this.identity();
      this.inflight = true;
      function current() {
        if (epoch !== self.epoch) { var e = new Error('同步配置已切换'); e.stale = true; throw e; }
      }
      async function request(route, method, body) {
        current();
        var controller = global.AbortController ? new global.AbortController() : null;
        var timer;
        try {
          var timeout = new Promise(function (_, reject) {
            timer = global.setTimeout(function () {
              if (controller) controller.abort();
              reject(new Error('同步请求超时'));
            }, 10000);
          });
          var res = await Promise.race([
            global.fetch(endpoint + route, {
              method: method, headers: { 'Content-Type': 'application/json', 'X-Anon-Id': anonId },
              body: body === undefined ? undefined : JSON.stringify(body), signal: controller ? controller.signal : undefined
            }),
            timeout
          ]);
          current();
          if (!res.ok) { var err = new Error('同步失败：HTTP ' + res.status); err.status = res.status; throw err; }
          if (route !== '/trace') return null;
          var trace = await Promise.race([res.json(), timeout]);
          current();
          if (!trace || trace.schema !== 'ttk.learning-trace.v1' || !Array.isArray(trace.events)) throw new Error('服务端返回的轨迹格式无效');
          return trace;
        } finally { if (timer) global.clearTimeout(timer); }
      }
      this.flight = (async function () {
        try {
          do {
            while (state.queue.length) {
              var batch = state.queue.slice(0, MAX_BATCH);
              await request('/events', 'POST', { anonymous: true, events: batch });
              current();
              state.queue.splice(0, batch.length);
              self.checkpoint();
            }
            if (state.dirty) {
              var revision = state.revision;
              await request('/trace/import', 'POST', snapshot());
              current();
              if (state.revision === revision) state.dirty = false;
              self.checkpoint();
            }
          } while (state.queue.length || state.dirty);
          var trace = await request('/trace', 'GET');
          current();
          applySnapshot(trace, true, state.dirty);
          self.checkpoint();
          self.retry = 0;
          self.lastError = '';
          return { ok: true, events: trace.events.length };
        } catch (e) {
          if (epoch === self.epoch && !e.stale) {
            self.lastError = e.message;
            if (!e.status || e.status >= 500 || e.status === 429 || e.status === 408) self.backoff();
          }
          return { ok: false, error: e.message };
        } finally {
          if (epoch === self.epoch) {
            self.inflight = false;
            self.flight = null;
            if (!self.lastError && (state.queue.length || state.dirty)) self.schedule();
          }
        }
      })();
      return this.flight;
    },

    backoff: function () {
      var self = this;
      if (this.timer) return;
      this.retry = Math.min(this.retry + 1, 6);
      var wait = Math.min(1000 * Math.pow(2, this.retry - 1), 30000);
      this.timer = global.setTimeout(function () {
        self.timer = null;
        self.flush();
      }, wait);
    },

    pending: function () { return this.queue.length; }
  };

  // 断网恢复后立即补发，不用等退避计时器
  if (typeof global.addEventListener === 'function') {
    global.addEventListener('online', function () { remote.flush(); });
  }

  /* ---------------- 数据规范化（迁移与写入共用） ---------------- */
  function normalizeEvent(e) {
    return {
      at: Number.isSafeInteger(e && e.at) ? e.at : Date.now(),
      tpl: String((e && e.tpl) || ''),
      name: typeof (e && e.name) === 'string' ? e.name : '',
      reason: REASONS.indexOf(e && e.reason) >= 0 ? e.reason : 'param',
      params: numericParams(e && e.params),
      insight: typeof (e && e.insight) === 'string' ? e.insight : ''
    };
  }
  function numericParams(raw) {
    var out = Object.create(null);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) Object.keys(raw).forEach(function (key) {
      if (typeof raw[key] === 'number' && isFinite(raw[key])) out[key] = raw[key];
    });
    return out;
  }
  function normalizeTrail(raw) {
    if (raw == null) return { value: [], changed: false };
    if (!Array.isArray(raw)) return { value: [], changed: true };
    var out = [], changed = false;
    raw.forEach(function (e) {
      if (!e || typeof e !== 'object' || !e.tpl) { changed = true; return; }
      var item = normalizeEvent(e);
      out.push(item);
      if (JSON.stringify(item) !== JSON.stringify(e)) changed = true;
    });
    return { value: out, changed: changed || out.length !== raw.length };
  }
  function normalizeProgress(raw) {
    if (raw == null) return { value: {}, changed: false };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value: {}, changed: true };
    var out = Object.create(null), changed = false;
    Object.keys(raw).forEach(function (k) {
      out[k] = !!raw[k];
      if (out[k] !== raw[k]) changed = true;
    });
    return { value: out, changed: changed };
  }
  function normalizeStuck(raw) {
    if (raw == null) return { value: [], changed: false };
    if (!Array.isArray(raw)) return { value: [], changed: true };
    var out = [], changed = false;
    raw.forEach(function (e) {
      if (!e || typeof e !== 'object' || !e.tpl) { changed = true; return; }
      var item = { at: Number.isSafeInteger(e.at) ? e.at : Date.now(), tpl: String(e.tpl) };
      out.push(item);
      if (JSON.stringify(item) !== JSON.stringify(e)) changed = true;
    });
    return { value: out, changed: changed || out.length !== raw.length };
  }
  function isEmpty(v) {
    if (v == null) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') return Object.keys(v).length === 0;
    return false;
  }
  var NORMALIZE = { trail: normalizeTrail, progress: normalizeProgress, stuck: normalizeStuck };

  // 幂等迁移：v1 键缺失或为空时，从早期键接管；格式不齐的导入数据就地补全。
  // 只写 v1，绝不删除旧键；已有 v1 数据时不会被旧数据覆盖。
  function migrate() {
    var report = { sources: [], normalized: [], kept: {} };
    Object.keys(NORMALIZE).forEach(function (name) {
      var key = K[name], raw = read(key, null), source = key, i, old;
      if (isEmpty(raw) && !read(K.ignoreLegacy, false)) {
        for (i = 0; i < LEGACY[name].length; i++) {
          old = read(LEGACY[name][i], null);
          if (!isEmpty(old)) { raw = old; source = LEGACY[name][i]; break; }
        }
      }
      var n = NORMALIZE[name](raw);
      if (!isEmpty(raw) && (source !== key || n.changed)) {
        write(key, n.value);
        if (source !== key) report.sources.push(source + ' -> ' + key);
        if (n.changed) report.normalized.push(name);
      }
      report.kept[name] = Array.isArray(n.value) ? n.value.length : Object.keys(n.value).length;
    });
    return report;
  }

  var Data = {
    keys: K,
    remote: remote,
    read: read,
    write: write,
    migrate: migrate,
    trail: function () { return normalizeTrail(read(K.trail, [])).value; },
    progress: function () { return normalizeProgress(read(K.progress, {})).value; },
    stuck: function () { return normalizeStuck(read(K.stuck, [])).value; },
    custom: function () { return read(K.custom, []); },
    saveCustom: function (list) { write(K.custom, list); remote.changed(); },
    subscribe: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },

    // 写事件的唯一入口：补全字段 → 截断 → 落盘 → 交给同步适配器
    log: function (event) {
      var item = normalizeEvent(event);
      var list = this.trail();
      list.push(item);
      if (list.length > MAX_TRAIL) list = list.slice(-MAX_TRAIL);
      write(K.trail, list);
      this.remote.push(item);
      return item;
    },
    markChallenge: function (id, index) {
      var p = this.progress(), key = id + ':' + index;
      if (p[key]) return false;
      p[key] = true;
      write(K.progress, p);
      remote.changed();
      return true;
    },
    addStuck: function (id) {
      var list = this.stuck();
      list.push({ at: Date.now(), tpl: String(id) });
      if (list.length > MAX_STUCK) list = list.slice(-MAX_STUCK);
      write(K.stuck, list);
      remote.changed();
      return list.length;
    },

    byTpl: function (id, tpl) {
      var trail = this.trail(), progress = this.progress(), stuck = this.stuck();
      var total = tpl && tpl.challenges ? tpl.challenges.length : 0, done = 0, i;
      for (i = 0; i < total; i++) if (progress[id + ':' + i]) done++;
      var interactions = trail.filter(function (e) { return e.tpl === id; }).length;
      var stuckCount = stuck.filter(function (e) { return e.tpl === id; }).length;
      return {
        id: id, interactions: interactions, stuck: stuckCount,
        challengeDone: done, challengeTotal: total,
        challengeRate: total ? done / total : 0
      };
    },

    stats: function (engine) {
      var trail = this.trail(), progress = this.progress(), stuck = this.stuck();
      var byTpl = {}, explored = 0;
      trail.forEach(function (e) {
        if (!byTpl[e.tpl]) { byTpl[e.tpl] = 0; explored++; }
        byTpl[e.tpl]++;
      });
      var done = Object.keys(progress).filter(function (k) { return progress[k]; }).length;
      var total = engine ? engine.all().reduce(function (s, t) { return s + (t.challenges || []).length; }, 0) : 0;
      var paramEvents = trail.filter(function (e) { return e.reason === 'param'; }).length;
      return {
        interactions: trail.length,
        paramEvents: paramEvents,
        explored: explored,
        totalConcepts: engine ? engine.all().length : 0,
        challengesDone: done,
        challengesTotal: total,
        stuckCount: stuck.length,
        byTpl: byTpl
      };
    },

    timeline: function (n) { return this.trail().slice(-(n || 20)).reverse(); },

    exportAll: function (engine) {
      return JSON.stringify({
        schema: 'ttk.learning-trace.v1',
        exportedAt: new Date().toISOString(),
        notice: '匿名导出：不含姓名、学校、设备标识',
        summary: this.stats(engine),
        events: this.trail(),
        progress: this.progress(),
        stuck: this.stuck(),
        customTemplates: this.custom()
      }, null, 2);
    },

    importAll: function (text) {
      var obj;
      try { obj = JSON.parse(text); } catch (e) { return { ok: false, error: 'JSON 解析失败：' + e.message }; }
      if (!obj || typeof obj !== 'object' || !Array.isArray(obj.events)) {
        return { ok: false, error: '缺少 events 数组，不是有效的试用数据文件' };
      }
      if (obj.schema && obj.schema !== 'ttk.learning-trace.v1') return { ok: false, error: '不支持的轨迹版本' };
      write(K.trail, normalizeTrail(obj.events).value);
      write(K.progress, normalizeProgress(obj.progress || {}).value);
      write(K.stuck, normalizeStuck(obj.stuck || []).value);
      if (Array.isArray(obj.customTemplates)) write(K.custom, obj.customTemplates);
      remote.changed();
      return { ok: true, events: obj.events.length };
    },

    clear: function () {
      // 现有界面的清空只作用于本机：断开同步并取消待发送项，远端历史不删除。
      if (remote.state) {
        remote.state.queue.length = 0;
        remote.state.dirty = false;
      }
      remote.configure('');
      write(K.ignoreLegacy, true, true);
      write(K.trail, []);
      write(K.progress, {});
      write(K.stuck, []);
    }
  };

  TTK.data = Data;
  // 模块加载即幂等接管旧数据，应用层无需感知（#I13）
  // 首次迁移报告留一份，便于控制台排查与 CI 断言
  Data.lastMigration = Data.migrate();
  var savedRemote = read(K.remote, null);
  if (savedRemote && savedRemote.endpoint) remote.configure(savedRemote.endpoint);
})(window);
