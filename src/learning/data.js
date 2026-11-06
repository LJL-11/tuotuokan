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
    remote: 'ttk.remote.v1'
  };
  // 早期 / 手工导入的数据可能落在无版本后缀的键上。只接管、不删除原键，
  // 这样旧轨迹永远可回滚，也不会和用户自己存的副本打架。
  var LEGACY = {
    trail: ['ttk.trail', 'ttk.trace'],
    progress: ['ttk.progress'],
    stuck: ['ttk.stuck']
  };
  var REASONS = ['param', 'select', 'reset', 'stuck', 'challenge', 'view'];
  var MAX_TRAIL = 300, MAX_STUCK = 200;

  function read(key, fallback) {
    try {
      var raw = global.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function write(key, value) {
    try { global.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 隐私模式静默降级 */ }
    notify(key, value);
  }
  var listeners = [];
  function notify(key, value) {
    listeners.slice().forEach(function (fn) {
      try { fn(key, value); } catch (e) { console.error('[TTK] data listener', e); }
    });
  }

  var remote = {
    mode: 'local',
    endpoint: '',
    queue: [],
    configure: function (url) {
      this.endpoint = url;
      this.mode = url ? 'rest' : 'local';
      write(K.remote, { endpoint: this.endpoint });
    },
    // 事件同步接口：配置 endpoint 后才会真正发出，否则只排队在本地
    push: function (event) {
      this.queue.push(event);
      if (this.queue.length > 500) this.queue.shift();
      if (this.mode !== 'rest' || !this.endpoint || !global.fetch) return;
      global.fetch(this.endpoint + '/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ anonymous: true, events: this.queue.splice(0) })
      }).catch(function () { /* 离线时保留本地队列，联网后重试 */ });
    }
  };

  /* ---------------- 数据规范化（迁移与写入共用） ---------------- */
  function normalizeEvent(e) {
    return {
      at: Number(e && e.at) || Date.now(),
      tpl: String((e && e.tpl) || ''),
      name: typeof (e && e.name) === 'string' ? e.name : '',
      reason: REASONS.indexOf(e && e.reason) >= 0 ? e.reason : 'param',
      params: (e && e.params && typeof e.params === 'object') ? e.params : {},
      insight: typeof (e && e.insight) === 'string' ? e.insight : ''
    };
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
    var out = {}, changed = false;
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
      var item = { at: Number(e.at) || Date.now(), tpl: String(e.tpl) };
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
      if (isEmpty(raw)) {
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
    saveCustom: function (list) { write(K.custom, list); },
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
      return true;
    },
    addStuck: function (id) {
      var list = this.stuck();
      list.push({ at: Date.now(), tpl: String(id) });
      if (list.length > MAX_STUCK) list = list.slice(-MAX_STUCK);
      write(K.stuck, list);
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
      write(K.trail, normalizeTrail(obj.events).value);
      write(K.progress, normalizeProgress(obj.progress || {}).value);
      write(K.stuck, normalizeStuck(obj.stuck || []).value);
      if (Array.isArray(obj.customTemplates)) write(K.custom, obj.customTemplates);
      return { ok: true, events: obj.events.length };
    },

    clear: function () {
      write(K.trail, []);
      write(K.progress, {});
      write(K.stuck, []);
    }
  };

  TTK.data = Data;
  // 模块加载即幂等接管旧数据，应用层无需感知（#I13）
  // 首次迁移报告留一份，便于控制台排查与 CI 断言
  Data.lastMigration = Data.migrate();
})(window);
