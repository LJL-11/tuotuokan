/* 拖拖看 · 数据层
 * ---------------------------------------------------------------
 * 现在落在 localStorage，但所有读写都经过这一层；换成后端 REST 只需替换适配器，
 * 上层（图谱 / 诊断 / 报告 / 工坊）不用改。导出的是匿名试用数据，直接可作复赛验证材料。
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
  var savedRemote = read(K.remote, null);
  if (savedRemote && savedRemote.endpoint) remote.configure(savedRemote.endpoint);

  var Data = {
    keys: K,
    remote: remote,
    read: read,
    write: write,
    trail: function () { return read(K.trail, []); },
    progress: function () { return read(K.progress, {}); },
    stuck: function () { return read(K.stuck, []); },
    custom: function () { return read(K.custom, []); },
    saveCustom: function (list) { write(K.custom, list); },
    subscribe: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },

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
      write(K.trail, obj.events);
      write(K.progress, obj.progress || {});
      write(K.stuck, obj.stuck || []);
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
})(window);
