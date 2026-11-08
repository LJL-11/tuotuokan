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

  /* ---------------- #I3：自定义模板在刷新后恢复 ---------------- */
  // 工坊保存的是纯 TemplateSpec（ttk.custom.v1），启动时统一走 dsl 校验 + 编译再注册。
  // 坏数据只跳过，不阻断双击运行；已挂载的 id 不会重复注册（幂等，测试可再调一次）。
  function restoreCustomTemplates() {
    var list = data.custom();
    if (!Array.isArray(list)) return 0;
    var loaded = 0;
    list.forEach(function (spec) {
      if (!spec || typeof spec !== 'object' || !spec.id) return;
      if (engine.get(spec.id)) { loaded++; return; }
      var v;
      try { v = TTK.dsl.validate(spec, []); } catch (e) { return; }
      if (!v.ok) return;
      try { engine.register(TTK.dsl.compile(spec, v)); loaded++; }
      catch (e) { /* 跳过无法编译的模板 */ }
    });
    return loaded;
  }

  /* ---------------- #I15：同步产品入口 ---------------- */
  var syncResult = '', renderingSync = false;
  function currentAnonId() {
    if (data.remote.mode !== 'rest') return ''; // 本地模式不生成匿名 ID
    try { return data.remote.identity(); } catch (e) { return ''; }
  }
  function updateStorageNotice() {
    var el = $('storageNotice');
    if (!el) return;
    el.textContent = data.remote.mode === 'rest'
      ? '已启用同步：记录会按匿名 ID 上传到你配置的服务，不含姓名 / 学校 / 设备标识'
      : '记录仅保存在本机浏览器，不上传';
  }
  function renderSyncStatus() {
    if (renderingSync) return; // identity() 首次落盘会触发订阅，避免递归
    renderingSync = true;
    try {
      var r = data.remote, el = $('syncStatus');
      if (el) {
        el.textContent = [
          '模式：' + (r.mode === 'rest' ? '同步（已配置服务）' : '本地（不上传）'),
          '服务地址：' + (r.endpoint || '未配置'),
          '匿名 ID：' + (currentAnonId() || '未启用，本机不生成'),
          '待上传：' + r.pending() + ' 条',
          '最近错误：' + (r.lastError || '无'),
          '本机存储：' + (r.storageError || '正常'),
          '最近同步：' + (syncResult || '尚未执行')
        ].join('\n');
      }
      updateStorageNotice();
    } finally { renderingSync = false; }
  }
  function setSyncResult(text) { syncResult = text; renderSyncStatus(); }

  function initSyncPanel() {
    var urlEl = $('syncUrl'), anonEl = $('syncAnon');
    if (urlEl) urlEl.value = data.remote.endpoint || '';
    if (anonEl) anonEl.value = currentAnonId();
    var save = $('syncSave');
    if (save) save.addEventListener('click', function () {
      var url = String((urlEl && urlEl.value) || '').trim();
      try {
        data.remote.configure(url);
        setSyncResult(url ? '已启用同步，后台开始上传' : '已恢复本地模式');
        toast(url ? '同步已启用' : '已恢复本地模式', 'ok');
      } catch (e) {
        setSyncResult('配置失败：' + e.message);
        toast('服务地址无效：' + e.message);
      }
    });
    var clear = $('syncClear');
    if (clear) clear.addEventListener('click', function () {
      data.remote.configure('');
      if (urlEl) urlEl.value = '';
      setSyncResult('已恢复本地模式，停止上传');
      toast('已恢复本地模式', 'ok');
    });
    var flush = $('syncFlush');
    if (flush) flush.addEventListener('click', function () {
      var p = data.remote.flush();
      if (p && typeof p.then === 'function') {
        p.then(function (res) {
          setSyncResult(res && res.ok ? '同步成功，读回 ' + (res.events || 0) + ' 条事件'
            : (data.remote.mode === 'local' ? '本地模式，无需同步' : '同步失败：' + ((res && res.error) || '未知错误')));
        });
      } else setSyncResult('本地模式，无需同步');
    });
    var apply = $('syncAnonApply');
    if (apply) apply.addEventListener('click', function () {
      var value = String((anonEl && anonEl.value) || '').trim().toLowerCase();
      if (!/^[0-9a-f]{16}$/.test(value)) { setSyncResult('匿名 ID 需为 16 位十六进制'); return; }
      if (!global.confirm('切换匿名 ID 会隔离本机当前记录（不会删除已上传的历史）。建议先导出备份，确定继续？')) return;
      var res = data.remote.identity(value);
      if (res && res.ok) { setSyncResult('已切换到匿名 ID ' + res.anonId); toast('匿名 ID 已更新', 'ok'); }
      else setSyncResult('身份无效：' + ((res && res.error) || '未知错误'));
    });
    renderSyncStatus();
  }

  function onDataChange() {
    updateBadge();
    renderSyncStatus();
    var drawer = $('drawer');
    if (drawer && drawer.classList && typeof drawer.classList.contains === 'function' &&
      drawer.classList.contains('open')) renderDrawer();
  }

  // 模板注册 / 卸载后，侧栏与当前视图（尤其图谱节点数）立即同步。
  engine.on('register', function () {
    buildSidebar();
    if (TTK.views && TTK.views.refresh) TTK.views.refresh();
  });
  engine.on('unregister', function () {
    buildSidebar();
    if (TTK.views && TTK.views.refresh) TTK.views.refresh();
  });

  TTK.app = { restoreCustom: restoreCustomTemplates, renderSyncStatus: renderSyncStatus };

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
      // 隐藏期间画布尺寸为 0，跳过绘制；切回沙盒时由视图 change 事件补一次
      var view = TTK.views.current();
      if (view && view.id !== 'sandbox') return;
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

  /* ---------------- 输入层：文字 / 图片 / 语音 → 概念 ---------------- */
  var asking = false;
  var pendingMedia = null;

  function mediaKind(file) {
    var name = (file && file.name) || '';
    var type = (file && file.type) || '';
    if (type.indexOf('audio/') === 0 || /\.(mp3|wav|m4a|ogg|aac|flac)$/i.test(name)) return 'audio';
    if (type.indexOf('text/') === 0 || /svg/i.test(type) || /\.(svg|txt)$/i.test(name)) return 'text';
    return 'image';
  }

  function readBlob(file, asText) {
    return new Promise(function (resolve, reject) {
      if (asText && file && typeof file.text === 'function') {
        file.text().then(resolve, reject);
        return;
      }
      if (!asText && file && typeof file.arrayBuffer === 'function') {
        file.arrayBuffer().then(function (buf) { resolve(new Uint8Array(buf)); }, reject);
        return;
      }
      if (typeof FileReader !== 'function') {
        reject(new Error('无法在本机读取'));
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        if (asText) resolve(String(reader.result || ''));
        else resolve(new Uint8Array(reader.result));
      };
      reader.onerror = function () { reject(reader.error || new Error('无法在本机读取')); };
      if (asText) reader.readAsText(file);
      else reader.readAsArrayBuffer(file);
    });
  }

  function detectLocalText(file) {
    if (!file || typeof createImageBitmap !== 'function' || typeof TextDetector !== 'function') {
      return Promise.resolve('');
    }
    return createImageBitmap(file).then(function (bitmap) {
      return new TextDetector().detect(bitmap).then(function (items) {
        return (items || []).map(function (item) { return item.rawValue || ''; }).join(' ');
      }, function () { return ''; });
    }, function () { return ''; });
  }

  function takeMedia(file) {
    var kind = mediaKind(file);
    var name = file.name || '未命名';
    if (kind === 'audio') {
      pendingMedia = { audio: { name: name } };
      $('askHint').textContent = '已在本机选中语音「' + name + '」。不会上传。';
      return;
    }
    readBlob(file, kind === 'text').then(function (payload) {
      var image = { name: name };
      if (kind === 'text') image.body = String(payload || '').slice(0, 20000);
      else image.bytes = payload;
      return detectLocalText(kind === 'text' ? null : file).then(function (text) {
        if (text) image.text = text;
        pendingMedia = { image: image };
        $('askHint').textContent = '已在本机读完「' + name + '」。不会上传。';
      });
    }, function () {
      pendingMedia = null;
      $('askHint').textContent = '没有读成这个文件。它还在你的电脑上，没有上传。';
    });
  }

  function ask() {
    var typed = $('conceptInput').value.trim();
    var media = pendingMedia;
    if (!typed && !media) {
      $('askHint').textContent = '先输入想弄懂的概念，或选择图片 / 语音。内容只在本机处理。';
      return;
    }
    if (asking) return;
    var recognized = TTK.generator.recognize(media ? {
      text: typed,
      image: media.image || null,
      audio: media.audio || null
    } : typed);
    if (recognized.ok && recognized.conceptId && engine.get(recognized.conceptId)) {
      pendingMedia = null;
      $('askHint').textContent = recognized.message || '';
      TTK.views.go('sandbox', recognized.conceptId);
      toast('已匹配到「' + engine.get(recognized.conceptId).name + '」沙盒', 'ok');
      return;
    }
    if (recognized.unsupported || !recognized.concept) {
      $('askHint').textContent = recognized.message || '没有认出这个输入。';
      toast('没有认出');
      return;
    }
    pendingMedia = null;
    var q = recognized.concept;
    var ids = engine.all().map(function (t) { return t.id; });
    var produced = TTK.generator.generate(q, { ids: ids });
    if (produced && typeof produced.then === 'function') {
      asking = true;
      $('askBtn').disabled = true;
      $('askHint').textContent = '正在向已配置的代理请求「' + q + '」…';
      produced.then(function (result) { landGenerated(q, result); }, function () {
        landGenerated(q, { ai: false, spec: TTK.dsl.draft(q), source: 'local-draft', reason: 'network' });
      });
      return;
    }
    landGenerated(q, produced);
  }

  function landGenerated(q, result) {
    asking = false;
    $('askBtn').disabled = false;
    if (!result || !result.spec) {
      result = { ai: false, spec: TTK.dsl.draft(q), source: 'local-draft', reason: 'invalid' };
    }
    var mounted = TTK.generator.mount(engine, result.spec);
    if (!mounted.ok) {
      result = { ai: false, spec: TTK.dsl.draft(q), source: 'local-draft', reason: result.reason || 'invalid' };
      mounted = TTK.generator.mount(engine, result.spec);
    }
    if (!mounted.ok) {
      $('askHint').textContent = '没能挂上「' + q + '」：' + (mounted.errors || []).join('；');
      toast('生成失败');
      return;
    }
    buildSidebar();
    TTK.views.go('sandbox', mounted.tpl.id);
    if (result.ai === true) {
      $('askHint').textContent = '这份沙盒来自模型输出，并已通过公式白名单校验。刷新页面后不会保留。';
      toast('已生成「' + mounted.tpl.name + '」', 'ok');
      return;
    }
    $('askHint').textContent = draftHint(q, result);
    toast('已挂上本地草稿，不是 AI 生成');
  }

  function draftHint(q, result) {
    var why = result && result.reason;
    var tail = '下面是本地草稿（通用正弦曲线），不是 AI 生成。刷新页面后不会保留。';
    if (why === 'network') return '「' + q + '」的模型请求失败，已重试一次。' + tail;
    if (why === 'invalid') return '模型给「' + q + '」的模板没通过校验，已重试一次。' + tail;
    return '「' + q + '」还没有精修模板，也还没配模型代理。' + tail;
  }

  /* ---------------- 导航 ---------------- */
  function select(id) {
    switching = true;
    if (!engine.select(id)) { switching = false; return; }
    switching = false;
    TTK.views.setTpl(id); // hash 由路由层统一生成，保留当前视图
    global.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function init() {
    restoreCustomTemplates(); // 刷新后把工坊保存的模板重新挂进引擎
    buildSidebar();
    updateBadge();
    Array.prototype.forEach.call(document.querySelectorAll('#viewNav .view-tab'), function (btn) {
      btn.addEventListener('click', function () { TTK.views.go(btn.getAttribute('data-view')); });
    });
    TTK.views.on(function (evt, payload) {
      if (evt !== 'change' || !payload || !payload.route) return;
      // 浏览器前进 / 后退带回了模板 id，静默切换，避免重复写 hash
      if (payload.tpl && engine.get(payload.tpl) && payload.tpl !== engine.currentId) {
        switching = true;
        engine.select(payload.tpl);
        switching = false;
      }
      // 从其他视图切回来时补一次重绘（隐藏期间跳过过绘制）
      if (payload.route.id === 'sandbox' && engine.state) {
        global.requestAnimationFrame(function () { renderer.draw(engine.state.spec.chart); });
      }
    });
    $('askBtn').addEventListener('click', ask);
    $('mediaBtn').addEventListener('click', function () { $('mediaInput').click(); });
    $('mediaInput').addEventListener('change', function () {
      var input = $('mediaInput');
      var file = input.files && input.files[0];
      input.value = '';
      if (file) takeMedia(file);
    });
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
      var activeView = TTK.views.current();
      if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && (!activeView || activeView.id === 'sandbox')) {
        var list = engine.all(), idx = list.findIndex(function (t) { return t.id === engine.currentId; });
        var next = e.key === 'ArrowRight' ? (idx + 1) % list.length : (idx - 1 + list.length) % list.length;
        select(list[next].id);
      }
      if (e.key === 'Escape') closeDrawer();
    });

    initSyncPanel();
    data.subscribe(onDataChange);
    var initial = TTK.views.start(); // 解析 hash，决定刷新后停在哪个视图
    select(engine.get(initial.tpl) ? initial.tpl : engine.all()[0].id);
  }

  init();
})(window);
