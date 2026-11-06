/* 拖拖看 · 应用层
 * ---------------------------------------------------------------
 * 输入层（自然语言匹配） / 交互控件 / 闭环层（轨迹、挑战、卡点诊断、下一个沙盒）
 * 学习数据的唯一真源是 TTK.data，卡点推荐的唯一来源是 TTK.createGraph 的 recommend()。
 * 本文件不直接读写本地存储，也不自带存储实现（#I13）。
 */
(function (global) {
  'use strict';

  var TTK = global.TTK;
  var M = TTK.math;
  var data = TTK.data;
  var engine = TTK.createEngine();
  TTK.templates.forEach(function (t) { engine.register(t); });
  var graph = TTK.createGraph(engine, data);
  var renderer = new TTK.Renderer(document.getElementById('stage'));
  TTK.engine = engine; // 便于控制台调试与后续接入 AI 生成
  TTK.graph = graph;   // 四视图 / 图谱可视化共用同一个实例

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
    var b = data.byTpl(tpl.id, tpl);
    return b.challengeTotal > 0 && b.challengeDone === b.challengeTotal;
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
    var progress = data.progress();
    $('challengeList').innerHTML = (tpl.challenges || []).map(function (c, i) {
      var done = !!progress[tpl.id + ':' + i];
      return '<div class="challenge' + (done ? ' done' : '') + '" data-index="' + i + '">' +
        '<span class="check">' + (done ? '✓' : '○') + '</span><span>' + esc(c.text) + '</span></div>';
    }).join('');
    var b = data.byTpl(tpl.id, tpl);
    $('challengeCount').textContent = b.challengeDone + '/' + b.challengeTotal;
  }

  function checkChallenges(state) {
    var tpl = state.tpl, m = state.spec.m || {}, changed = false;
    (tpl.challenges || []).forEach(function (c, i) {
      var ok = false;
      try { ok = !!c.check(state.params, m); } catch (e) { ok = false; }
      if (!ok || !data.markChallenge(tpl.id, i)) return; // 已完成的不重复写盘 / 不重复提示
      changed = true;
      var el = $('challengeList').querySelector('[data-index="' + i + '"]');
      if (el) { el.classList.add('done'); el.querySelector('.check').textContent = '✓'; }
      toast('挑战完成：' + c.text, 'ok');
    });
    if (changed) {
      var b = data.byTpl(tpl.id, tpl);
      $('challengeCount').textContent = b.challengeDone + '/' + b.challengeTotal;
      var card = $('tplList').querySelector('[data-id="' + tpl.id + '"] .tpl-dot');
      if (card && b.challengeTotal && b.challengeDone === b.challengeTotal) card.classList.add('done');
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
      data.log({
        at: Date.now(), tpl: s.tpl.id, name: s.tpl.name,
        reason: item.reason, params: Object.assign({}, s.params),
        insight: s.spec.insight || ''
      });
      updateBadge();
    }, 400);
  }

  function updateBadge() {
    var n = data.trail().length;
    $('journalBadge').textContent = n > 99 ? '99+' : String(n);
  }

  function diagnoseStuck() {
    var cur = engine.get(engine.currentId);
    data.addStuck(cur.id);
    recordTrail(engine.state, 'stuck');

    // 图谱给出的是按分数降序的完整建议数组；卡住时优先回到当前概念的先修链。
    var suggestions = graph.recommend();
    var pre = {};
    (cur.prerequisites || []).forEach(function (id) { pre[id] = true; });
    var candidates = suggestions.filter(function (s) { return s.tpl && s.tpl.id !== cur.id; });
    var pick = candidates.filter(function (s) { return pre[s.tpl.id]; })[0] || candidates[0];
    if (!pick) { toast('已经把所有概念都走完了，试着换个参数组合重新观察'); return; }
    toast('卡点已记录 → 先补「' + pick.tpl.name + '」：' + pick.reason, 'ok');
    setTimeout(function () { select(pick.tpl.id); }, 700);
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
    var stats = data.stats(engine);
    $('statBox').innerHTML =
      '<div class="stat"><b>' + stats.interactions + '</b><span>次交互</span></div>' +
      '<div class="stat"><b>' + stats.explored + '/' + stats.totalConcepts + '</b><span>已探索概念</span></div>' +
      '<div class="stat"><b>' + stats.challengesDone + '/' + stats.challengesTotal + '</b><span>完成挑战</span></div>' +
      '<div class="stat"><b>' + stats.stuckCount + '</b><span>卡点记录</span></div>';

    $('progressBox').innerHTML = engine.all().map(function (t) {
      var b = data.byTpl(t.id, t);
      var pct = b.challengeTotal ? Math.round(b.challengeDone / b.challengeTotal * 100) : 0;
      return '<div class="prog-row"><span>' + esc(t.name) + '</span>' +
        '<span class="prog-track"><i style="width:' + pct + '%"></i></span>' +
        '<b>' + b.challengeDone + '/' + b.challengeTotal + '</b></div>';
    }).join('');

    var recent = data.timeline(18);
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
      data.clear();
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
})(window);
