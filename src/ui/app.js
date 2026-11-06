/* 拖拖看 · 应用层
 * ---------------------------------------------------------------
 * 输入层（自然语言匹配） / 交互控件 / 闭环层（轨迹、挑战、卡点诊断、下一个沙盒）
 * 数据全部存在 localStorage，不上传、不依赖后端。
 */
(function (global) {
  'use strict';

  var TTK = global.TTK;
  var M = TTK.math;
  var engine = TTK.createEngine();
  TTK.templates.forEach(function (t) { engine.register(t); });
  var renderer = new TTK.Renderer(document.getElementById('stage'));

  var K = {
    trail: 'ttk.trail.v1',
    progress: 'ttk.progress.v1',
    stuck: 'ttk.stuck.v1'
  };

  function load(key, fallback) {
    try {
      var raw = global.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { global.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 隐私模式下静默降级 */ }
  }

  var progress = load(K.progress, {});
  var trail = load(K.trail, []);
  var stuckLog = load(K.stuck, []);

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var toastTimer = null;
  function toast(msg, kind) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 3200);
  }

  /* ---------------- 侧栏：概念库 ---------------- */
  function buildSidebar() {
    var subjects = engine.subjects();
    var html = '';
    subjects.forEach(function (sub) {
      html += '<div class="group-title">' + esc(sub) + '</div>';
      engine.all().filter(function (t) { return t.subject === sub; }).forEach(function (t) {
        var done = challengeDone(t);
        html += '<button class="tpl-card" data-id="' + t.id + '">' +
          '<span class="tpl-icon">' + esc(t.icon) + '</span>' +
          '<span class="tpl-meta"><span class="tpl-name">' + esc(t.name) + '</span>' +
          '<span class="tpl-brief">' + esc(t.brief) + '</span></span>' +
          '<span class="tpl-dot' + (done ? ' done' : '') + '" title="挑战完成度"></span>' +
          '</button>';
      });
    });
    $('tplList').innerHTML = html;
    $('tplCount').textContent = engine.all().length + ' 个概念';
    Array.prototype.forEach.call($('tplList').querySelectorAll('.tpl-card'), function (btn) {
      btn.addEventListener('click', function () { select(btn.dataset.id); });
    });
    $('subjectNav').innerHTML = subjects.map(function (s) {
      return '<span class="chip">' + esc(s) + '</span>';
    }).join('');
  }

  function challengeDone(tpl) {
    var total = (tpl.challenges || []).length;
    if (!total) return false;
    var n = 0;
    for (var i = 0; i < total; i++) if (progress[tpl.id + ':' + i]) n++;
    return n === total;
  }

  function markActive(id) {
    Array.prototype.forEach.call($('tplList').querySelectorAll('.tpl-card'), function (b) {
      b.classList.toggle('active', b.dataset.id === id);
    });
  }

  /* ---------------- 参数面板 ---------------- */
  function buildParams(tpl, params) {
    $('paramList').innerHTML = tpl.params.map(function (def) {
      var v = params[def.key];
      var shown = def.format ? def.format(v) : M.fmt(v, def.step < 1 ? 2 : 0);
      return '<div class="param" data-key="' + def.key + '">' +
        '<div class="param-row"><label for="p-' + def.key + '">' + esc(def.label) + '</label>' +
        '<span class="param-value" data-val="' + def.key + '">' + esc(shown) + (def.unit ? ' <em>' + esc(def.unit) + '</em>' : '') + '</span></div>' +
        '<input type="range" id="p-' + def.key + '" data-key="' + def.key + '" min="' + def.min + '" max="' + def.max + '" step="' + def.step + '" value="' + v + '">' +
        '<div class="param-scale"><span>' + (def.format ? def.format(def.min) : def.min) + '</span><span class="param-hint">' + esc(def.hint) + '</span><span>' + (def.format ? def.format(def.max) : def.max) + '</span></div>' +
        '</div>';
    }).join('');
    Array.prototype.forEach.call($('paramList').querySelectorAll('input[type=range]'), function (input) {
      input.addEventListener('input', function () {
        engine.setParam(input.dataset.key, input.value);
      });
    });
  }

  function syncParamValues(params, tpl) {
    tpl.params.forEach(function (def) {
      var v = params[def.key];
      var el = $('paramList').querySelector('[data-val="' + def.key + '"]');
      if (!el) return;
      var shown = def.format ? def.format(v) : M.fmt(v, def.step < 1 ? 2 : 0);
      el.innerHTML = esc(shown) + (def.unit ? ' <em>' + esc(def.unit) + '</em>' : '');
    });
  }

  /* ---------------- 指标 / 洞察 / 挑战 ---------------- */
  function renderMetrics(spec) {
    $('metricList').innerHTML = (spec.metrics || []).map(function (m) {
      var val = typeof m.value === 'number' ? M.fmt(m.value, m.digits) : m.value;
      return '<div class="metric ' + m.tone + '" title="' + esc(m.hint) + '">' +
        '<span class="metric-label">' + esc(m.label) + '</span>' +
        '<span class="metric-value">' + esc(val) + (m.unit ? '<em>' + esc(m.unit) + '</em>' : '') + '</span>' +
        '</div>';
    }).join('');
  }

  function buildChallenges(tpl) {
    $('challengeList').innerHTML = (tpl.challenges || []).map(function (c, i) {
      var done = !!progress[tpl.id + ':' + i];
      return '<div class="challenge' + (done ? ' done' : '') + '" data-index="' + i + '">' +
        '<span class="check">' + (done ? '✓' : '○') + '</span><span>' + esc(c.text) + '</span></div>';
    }).join('');
    var total = (tpl.challenges || []).length, done = 0;
    for (var i = 0; i < total; i++) if (progress[tpl.id + ':' + i]) done++;
    $('challengeCount').textContent = done + '/' + total;
  }

  function checkChallenges(state) {
    var tpl = state.tpl, m = state.spec.m || {}, changed = false;
    (tpl.challenges || []).forEach(function (c, i) {
      var key = tpl.id + ':' + i;
      if (progress[key]) return;
      var ok = false;
      try { ok = !!c.check(state.params, m); } catch (e) { ok = false; }
      if (ok) {
        progress[key] = true;
        changed = true;
        var el = $('challengeList').querySelector('[data-index="' + i + '"]');
        if (el) { el.classList.add('done'); el.querySelector('.check').textContent = '✓'; }
        toast('挑战完成：' + c.text, 'ok');
      }
    });
    if (changed) {
      save(K.progress, progress);
      var total = (tpl.challenges || []).length, done = 0;
      for (var j = 0; j < total; j++) if (progress[tpl.id + ':' + j]) done++;
      $('challengeCount').textContent = done + '/' + total;
      var card = $('tplList').querySelector('[data-id="' + tpl.id + '"] .tpl-dot');
      if (card && done === total) card.classList.add('done');
    }
  }

  /* ---------------- 闭环：轨迹 / 卡点诊断 ---------------- */
  var trailTimer = null, pendingTrail = null;
  function recordTrail(state, reason) {
    pendingTrail = { state: state, reason: reason };
    clearTimeout(trailTimer);
    trailTimer = setTimeout(function () {
      var item = pendingTrail;
      if (!item) return;
      var s = item.state;
      trail.push({
        at: Date.now(), tpl: s.tpl.id, name: s.tpl.name,
        reason: item.reason, params: Object.assign({}, s.params),
        insight: s.spec.insight || ''
      });
      if (trail.length > 300) trail = trail.slice(-300);
      save(K.trail, trail);
      updateBadge();
    }, 400);
  }

  function updateBadge() {
    $('journalBadge').textContent = trail.length > 99 ? '99+' : String(trail.length);
  }

  function diagnoseStuck() {
    var cur = engine.get(engine.currentId);
    stuckLog.push({ at: Date.now(), tpl: cur.id });
    if (stuckLog.length > 200) stuckLog = stuckLog.slice(-200);
    save(K.stuck, stuckLog);
    recordTrail(engine.state, 'stuck');

    var candidates = (cur.prerequisites || []).map(function (id) { return engine.get(id); }).filter(Boolean);
    var pool = candidates.length ? candidates : engine.all().filter(function (t) { return t.id !== cur.id; });
    // 优先推荐「还没完成挑战」的概念，其次推荐没探索过的
    var target = pool.find(function (t) { return !challengeDone(t); }) || pool[0];
    if (!target) { toast('已经把所有概念都走完了，试着换个参数组合重新观察'); return; }
    toast('卡点已记录 → 先补「' + target.name + '」的前置直觉', 'ok');
    setTimeout(function () { select(target.id); }, 700);
  }

  /* ---------------- 学习记录抽屉 ---------------- */
  function openDrawer() {
    renderDrawer();
    $('drawer').classList.add('open');
    $('mask').classList.add('open');
  }
  function closeDrawer() {
    $('drawer').classList.remove('open');
    $('mask').classList.remove('open');
  }
  function renderDrawer() {
    var byTpl = {};
    trail.forEach(function (r) { byTpl[r.tpl] = (byTpl[r.tpl] || 0) + 1; });
    var explored = Object.keys(byTpl).length;
    var totalChallenges = engine.all().reduce(function (s, t) { return s + (t.challenges || []).length; }, 0);
    var doneChallenges = Object.keys(progress).filter(function (k) { return progress[k]; }).length;
    $('statBox').innerHTML =
      '<div class="stat"><b>' + trail.length + '</b><span>次交互</span></div>' +
      '<div class="stat"><b>' + explored + '/' + engine.all().length + '</b><span>已探索概念</span></div>' +
      '<div class="stat"><b>' + doneChallenges + '/' + totalChallenges + '</b><span>完成挑战</span></div>' +
      '<div class="stat"><b>' + stuckLog.length + '</b><span>卡点记录</span></div>';

    $('progressBox').innerHTML = engine.all().map(function (t) {
      var total = (t.challenges || []).length, done = 0;
      for (var i = 0; i < total; i++) if (progress[t.id + ':' + i]) done++;
      var pct = total ? Math.round(done / total * 100) : 0;
      return '<div class="prog-row"><span>' + esc(t.name) + '</span>' +
        '<span class="prog-track"><i style="width:' + pct + '%"></i></span>' +
        '<b>' + done + '/' + total + '</b></div>';
    }).join('');

    var recent = trail.slice(-18).reverse();
    $('timeline').innerHTML = recent.length ? recent.map(function (r) {
      var d = new Date(r.at);
      var time = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      var label = r.reason === 'select' ? '进入沙盒' : r.reason === 'stuck' ? '标记卡点' : r.reason === 'reset' ? '重置参数' : '调整参数';
      var detail = r.reason === 'param'
        ? Object.keys(r.params).slice(0, 3).map(function (k) { return k + '=' + M.fmt(r.params[k], 2); }).join(' · ')
        : (r.insight || '').slice(0, 42) + '…';
      return '<div class="tl-item"><span class="tl-time">' + time + '</span>' +
        '<span class="tl-body"><b>' + esc(r.name) + '</b> · ' + label +
        '<small>' + esc(detail) + '</small></span></div>';
    }).join('') : '<div class="empty">还没有记录。拖动一个参数，轨迹就会出现在这里。</div>';
  }

  /* ---------------- 渲染调度 ---------------- */
  var raf = null;
  function scheduleDraw(state) {
    if (raf) return;
    raf = global.requestAnimationFrame(function () {
      raf = null;
      renderer.draw(state.spec.chart);
    });
  }

  var switching = false;
  engine.on('change', function (state) {
    scheduleDraw(state);
    renderMetrics(state.spec);
    $('insight').textContent = state.spec.insight || '';
    syncParamValues(state.params, state.tpl);
    checkChallenges(state);
    // 切换 / 重置会单独记一条，别重复记成「调整参数」
    if (!switching && state.revision > 1) recordTrail(state, 'param');
  });

  engine.on('select', function (state) {
    $('tplName').textContent = state.tpl.name;
    $('tplBrief').textContent = state.tpl.brief;
    $('tplSubject').textContent = state.tpl.subject + ' · ' + state.tpl.level;
    $('conceptNote').textContent = state.tpl.concept;
    buildParams(state.tpl, state.params);
    buildChallenges(state.tpl);
    markActive(state.tpl.id);
    recordTrail(state, 'select');
  });

  /* ---------------- 输入层：自然语言 → 概念 ---------------- */
  function ask() {
    var q = $('conceptInput').value.trim();
    if (!q) { $('askHint').textContent = '先输入一个想弄懂的概念，比如「过拟合」'; return; }
    var hit = engine.findByQuery(q);
    if (hit) {
      $('askHint').textContent = '';
      select(hit.id);
      toast('已匹配到「' + hit.name + '」沙盒', 'ok');
    } else {
      $('askHint').textContent = '暂未收录「' + q + '」。AI 生成接口已预留：接入大模型后按同一 schema 输出参数与模型，即可直接挂载到引擎（格式见 contracts/README.md 与 docs/01-接口契约.md）。';
    }
  }

  /* ---------------- 导航 ---------------- */
  function select(id) {
    switching = true;
    if (!engine.select(id)) { switching = false; return; }
    switching = false;
    global.location.hash = id;
    global.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function init() {
    buildSidebar();
    updateBadge();
    $('askBtn').addEventListener('click', ask);
    $('conceptInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') ask();
    });
    $('resetBtn').addEventListener('click', function () {
      switching = true;
      engine.reset();
      switching = false;
      recordTrail(engine.state, 'reset');
      toast('参数已回到默认值');
    });
    $('stuckBtn').addEventListener('click', diagnoseStuck);
    $('journalBtn').addEventListener('click', openDrawer);
    $('closeDrawer').addEventListener('click', closeDrawer);
    $('mask').addEventListener('click', closeDrawer);
    $('clearLog').addEventListener('click', function () {
      if (!global.confirm('清空本机全部学习记录与挑战进度？此操作不可恢复。')) return;
      trail = []; stuckLog = []; progress = {};
      save(K.trail, trail); save(K.stuck, stuckLog); save(K.progress, progress);
      buildSidebar(); buildChallenges(engine.get(engine.currentId));
      markActive(engine.currentId); updateBadge(); renderDrawer();
      toast('记录已清空');
    });
    document.addEventListener('keydown', function (e) {
      if (/INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        var list = engine.all(), idx = list.findIndex(function (t) { return t.id === engine.currentId; });
        var next = e.key === 'ArrowRight' ? (idx + 1) % list.length : (idx - 1 + list.length) % list.length;
        select(list[next].id);
      }
      if (e.key === 'Escape') closeDrawer();
    });

    var hash = global.location.hash.replace('#', '');
    select(engine.get(hash) ? hash : engine.all()[0].id);
  }

  init();
  TTK.engine = engine; // 便于控制台调试与后续接入 AI 生成
})(window);
