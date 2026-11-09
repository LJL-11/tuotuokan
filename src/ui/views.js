/* 拖拖看 · 四视图路由与内容（付 · #I1 / #I2 / #I3 / #I14）
 * ---------------------------------------------------------------
 * 四个视图：概念图谱 / 交互沙盒 / 学习报告 / 模板工坊。
 * 路由格式 #<view>/<tplId>：前半段决定显示哪个视图，后半段记住当前概念。
 * 兼容 v0 的 #overfit 这类「只有模板 id」的链接，一律当作沙盒视图处理。
 * 只用全局 TTK 与传统 script，双击 index.html 即可跑，不请求任何本地文件。
 *
 * 约定：视图之间不直接互相调用，只通过 TTK.engine 事件与 TTK.data 交换数据。
 * #I2 报告：聚合卡片 / 柱状图 / 掌握度 / 时间线 + 匿名导出导入；
 * #I3 工坊：JSON 编辑 → 校验定位 → expr 白名单编译 → 挂载预览 → 保存；
 * #I14 图谱：layout() 画先修关系，节点数随 register/unregister、颜色随掌握度变化。
 * #21：工坊与报告共用 exportReport / importReport 同一入口，导入后由 app.restoreCustom() 立即挂回引擎。
 * 视图重绘只改自己的容器；订阅 TTK.data 后数据一变就即时重绘。
 */
(function (global) {
  'use strict';

  var TTK = global.TTK = global.TTK || {};
  var DEFAULT_VIEW = 'sandbox';
  var ROUTES = [
    { id: 'graph', name: '概念图谱', hash: '#graph', mount: null, todo: '#I14 已完成' },
    { id: 'sandbox', name: '交互沙盒', hash: '#sandbox', mount: null, todo: 'v0 三栏装配' },
    { id: 'report', name: '学习报告', hash: '#report', mount: null, todo: '#I2 已完成' },
    { id: 'studio', name: '模板工坊', hash: '#studio', mount: null, todo: '#I3 已完成' }
  ];

  var currentId = null, context = { tpl: '' }, started = false, lastApplied = '';
  var handlers = [];
  // 编辑态放在模块里：数据变化触发重绘时，用户未保存的 JSON 与提示不会丢。
  var studioDraft = null, studioNotice = null, studioPreview = null;
  var reportNotice = null, reportExportText = '';

  function $(id) { return global.document ? global.document.getElementById(id) : null; }
  function each(list, fn) { Array.prototype.forEach.call(list || [], fn); }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function find(id) {
    for (var i = 0; i < ROUTES.length; i++) if (ROUTES[i].id === id) return ROUTES[i];
    return null;
  }
  function emit(evt, payload) {
    handlers.slice().forEach(function (fn) {
      try { fn(evt, payload); } catch (e) { console.error('[TTK.views] listener', e); }
    });
  }

  /* ---------------- hash 解析与同步 ---------------- */
  function parseHash() {
    var raw = String((global.location && global.location.hash) || '').replace(/^#\/?/, '');
    var parts = raw.split('/').filter(Boolean);
    var view = parts[0] || DEFAULT_VIEW, tpl = parts[1] || '';
    if (!find(view)) {
      // v0 链接只有模板 id（#overfit），或遇到未知 hash：交回沙盒，由应用层判断模板是否存在
      tpl = view;
      view = DEFAULT_VIEW;
    }
    return { view: view, tpl: tpl };
  }
  function buildHash(view, tpl) { return '#' + view + (tpl ? '/' + tpl : ''); }

  function applyView(route) {
    ROUTES.forEach(function (r) {
      var el = $('view-' + r.id);
      if (el) el.hidden = r.id !== route.id;
    });
    if (typeof route.mount === 'function') {
      try { route.mount(); } catch (e) { console.error('[TTK.views] 渲染失败 ' + route.id, e); }
    }
    currentId = route.id;
    var nav = $('viewNav');
    each(nav && nav.querySelectorAll ? nav.querySelectorAll('.view-tab') : [], function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === route.id);
    });
  }

  // 同一份 hash 只应用一次：既覆盖「hash 写入后事件异步到达」的浏览器行为，
  // 也覆盖校验环境里不派发事件的情况。
  function applyOnce(h, force) {
    var key = h.view + '/' + (h.tpl || '');
    if (!force && key === lastApplied && currentId === h.view) return false;
    var route = find(h.view);
    if (!route || typeof route.mount !== 'function') return false;
    if (h.tpl) context.tpl = h.tpl;
    lastApplied = key;
    applyView(route);
    emit('change', {
      route: route,
      tpl: h.tpl || context.tpl,
      hash: buildHash(route.id, h.tpl || context.tpl)
    });
    return true;
  }

  function onHashChange() { applyOnce(parseHash(), false); }

  /* ---------------- 数据订阅：即时重绘当前视图 ---------------- */
  // 模块被重新载入时（刷新模拟 / 测试重 require），先解绑旧订阅，避免重复重绘。
  function bindData() {
    if (!TTK.data || typeof TTK.data.subscribe !== 'function') return;
    if (global.__ttkViewsDataUnsub) {
      try { global.__ttkViewsDataUnsub(); } catch (e) { /* 旧实例已失效 */ }
    }
    global.__ttkViewsDataUnsub = TTK.data.subscribe(function () { rerender(); });
  }
  function refresh() {
    var route = find(currentId);
    if (!route || typeof route.mount !== 'function') return;
    try { route.mount(); } catch (e) { console.error('[TTK.views] 重绘失败 ' + route.id, e); }
  }
  // 统一走挂在 TTK.views 上的当前实现：模块被重新载入时，旧闭包里的按钮
  // 仍能驱动最新的视图，不会重绘到自己那份已经过期的 currentId。
  function rerender() {
    var fn = (TTK.views && typeof TTK.views.refresh === 'function') ? TTK.views.refresh : refresh;
    fn();
  }
  function goView(id, tpl) {
    if (TTK.views && typeof TTK.views.go === 'function') return TTK.views.go(id, tpl);
    return go(id, tpl);
  }

  /* ---------------- 公开路由接口 ---------------- */
  function register(id, fn) {
    var route = find(id);
    if (!route || typeof fn !== 'function') return false;
    route.mount = fn;
    return true;
  }
  /** 挂载视图但不改 hash；未注册 / 未知视图明确返回 false。 */
  function mount(id) {
    var route = find(id || DEFAULT_VIEW);
    if (!route) { console.warn('[TTK.views] 未知视图：' + id); return false; }
    if (typeof route.mount !== 'function') {
      console.warn('[TTK.views] 视图「' + route.name + '」尚未实现（' + route.todo + '）');
      return false;
    }
    applyView(route);
    emit('change', { route: route, tpl: context.tpl, hash: route.hash });
    return true;
  }
  function go(id, tpl) {
    var route = find(id);
    if (!route || typeof route.mount !== 'function') return false;
    var t = tpl || context.tpl;
    if (global.location) global.location.hash = buildHash(route.id, t);
    applyOnce({ view: route.id, tpl: t }, true);
    return true;
  }
  /** 应用层切换概念时调用：保留当前视图，只把后半段换成新模板 id。 */
  function setTpl(id) {
    context.tpl = id || '';
    var view = currentId || DEFAULT_VIEW;
    var target = buildHash(view, context.tpl);
    if (global.location && global.location.hash !== target) global.location.hash = target;
    applyOnce({ view: view, tpl: context.tpl }, false);
    return context.tpl;
  }
  /** 应用层初始化时调用一次：绑定 hashchange，返回初始 { view, tpl }。 */
  function start() {
    var h = parseHash();
    if (started) return h;
    started = true;
    if (h.tpl) context.tpl = h.tpl;
    lastApplied = h.view + '/' + (h.tpl || '');
    applyView(find(h.view));
    global.onhashchange = onHashChange;
    return h;
  }
  function current() { return find(currentId); }
  function routes() { return ROUTES.slice(); }

  /* ---------------- 公共片段 ---------------- */
  function pane(title, body, note, tag) {
    return '<div class="pane-head"><h2>' + esc(title) + '</h2><span class="pane-tag">' +
      esc(tag || 'M2') + '</span></div>' +
      '<div class="pane-body">' + body + '</div>' +
      (note ? '<p class="pane-note">' + esc(note) + '</p>' : '');
  }
  function noticeHtml(notice, id) {
    return notice ? '<span id="' + esc(id) + '" class="studio-msg ' + (notice.kind === 'bad' ? 'bad' : 'ok') + '">' +
      esc(notice.text) + '</span>' : '<span id="' + esc(id) + '"></span>';
  }
  function setStudioNotice(text, kind) {
    studioNotice = { text: text, kind: kind || 'ok' };
    rerender();
  }

  // 沙盒三栏是静态 DOM，由 app.js 装配；切回来时由 app.js 重绘 Canvas。
  function renderSandbox() { /* no-op：避免隐藏期间对零尺寸画布作图 */ }

  /* ---------------- #I14 概念图谱 ---------------- */
  function masteryColor(m) {
    return m >= 0.75 ? '#0d9488' : m >= 0.5 ? '#4f46e5' : m >= 0.25 ? '#d97706' : '#94a3b8';
  }
  function renderGraph() {
    var el = $('view-graph');
    if (!el) return;
    var graph = TTK.graph, engine = TTK.engine;
    if (!graph || !engine) {
      el.innerHTML = pane('概念图谱', '<div class="empty">图谱尚未就绪</div>');
      return;
    }
    var layout = graph.layout(), byId = {};
    layout.nodes.forEach(function (n) { byId[n.id] = n; });
    var w = Math.max(layout.width, 320), h = Math.max(layout.height, 180);
    var edges = layout.edges.map(function (e) {
      var a = byId[e.from], b = byId[e.to];
      if (!a || !b) return '';
      // 水平手柄的三次贝塞尔：先修边从左到右呈平滑 S 弧，比直线更易读
      var x1 = a.x + layout.nodeW, y1 = a.y + layout.nodeH / 2;
      var x2 = b.x - 6, y2 = b.y + layout.nodeH / 2;
      var dx = Math.max(24, (x2 - x1) / 2);
      return '<path d="M' + x1 + ',' + y1 + ' C' + (x1 + dx) + ',' + y1 + ' ' + (x2 - dx) + ',' + y2 + ' ' + x2 + ',' + y2 +
        '" fill="none" stroke="#cbd5e1" stroke-width="1.5" marker-end="url(#ttkArrow)"/>';
    }).join('');
    var nodes = layout.nodes.map(function (n) {
      var color = masteryColor(n.mastery);
      var isCurrent = engine.currentId === n.id;
      var barW = Math.max(30, layout.nodeW - 32);
      return '<g data-node="' + esc(n.id) + '" data-mastery="' + n.mastery.toFixed(3) +
        '"' + (isCurrent ? ' data-current="1"' : '') + ' style="cursor:pointer">' +
        '<rect x="' + n.x + '" y="' + n.y + '" width="' + layout.nodeW + '" height="' + layout.nodeH +
        '" rx="10" fill="' + (isCurrent ? '#f5f3ff' : '#ffffff') + '" stroke="' + color +
        '" stroke-width="' + (isCurrent ? 3 : 1.5) + '"/>' +
        '<rect x="' + n.x + '" y="' + n.y + '" width="5" height="' + layout.nodeH + '" rx="2" fill="' + color + '"/>' +
        '<text x="' + (n.x + 16) + '" y="' + (n.y + 20) + '" font-size="12" font-weight="600" fill="#1e293b">' +
        esc(n.tpl.name) + '</text>' +
        '<text x="' + (n.x + 16) + '" y="' + (n.y + 36) + '" font-size="10" fill="#94a3b8">掌握度 ' +
        Math.round(n.mastery * 100) + '%</text>' +
        '<rect x="' + (n.x + 16) + '" y="' + (n.y + layout.nodeH - 12) + '" width="' + barW +
        '" height="4" rx="2" fill="#eef2f7"/>' +
        '<rect x="' + (n.x + 16) + '" y="' + (n.y + layout.nodeH - 12) + '" width="' + (barW * n.mastery).toFixed(1) +
        '" height="4" rx="2" fill="' + color + '"/></g>';
    }).join('');
    var legend = '<div class="graph-legend">' +
      [['#94a3b8', '未接触'], ['#d97706', '初步'], ['#4f46e5', '进阶'], ['#0d9488', '熟练']]
        .map(function (p) { return '<span><i style="background:' + p[0] + '"></i>' + p[1] + '</span>'; }).join('') +
      '<span class="graph-count">' + layout.nodes.length + ' 个节点 · ' + layout.edges.length + ' 条先修边</span></div>';
    el.innerHTML = pane('概念图谱',
      legend + '<div class="graph-scroll"><svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h +
      '" role="img" aria-label="概念先修关系图"><defs><marker id="ttkArrow" markerWidth="7" markerHeight="7" ' +
      'refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="#cbd5e1"/></marker></defs>' +
      edges + nodes + '</svg></div>',
      '点节点跳到对应沙盒；节点数随模板注册 / 卸载同步，颜色随挑战完成与探索深度即时变化。',
      'M2');
    each(el.querySelectorAll('[data-node]'), function (g) {
      g.addEventListener('click', function () { go('sandbox', g.getAttribute('data-node')); });
    });
  }

  /* ---------------- #I2 学习报告 ---------------- */
  var TRACE_TOP_KEYS = {
    schema: 1, exportedAt: 1, notice: 1, summary: 1,
    events: 1, progress: 1, stuck: 1, customTemplates: 1
  };
  var EVENT_KEYS = { at: 1, tpl: 1, name: 1, reason: 1, params: 1, insight: 1 };
  // TemplateSpec 顶层字段白名单：与 dsl.js 的 specKeys / template.schema.json 同一份，不单独维护。
  var TEMPLATE_KEYS = (TTK.dsl && TTK.dsl.specKeys) || {
    id: 1, name: 1, subject: 1, icon: 1, brief: 1, concept: 1, keywords: 1,
    prerequisites: 1, x: 1, params: 1, series: 1, metrics: 1, challenges: 1,
    insight: 1, source: 1
  };

  function downloadJson(text, filename) {
    // 任何环境都保留一份可复制的文本；能下载时再走 Blob + a[download]。
    reportExportText = text;
    try {
      if (typeof global.Blob === 'function' && global.document &&
        typeof global.document.createElement === 'function' &&
        typeof global.URL !== 'undefined' && typeof global.URL.createObjectURL === 'function') {
        var url = global.URL.createObjectURL(new global.Blob([text], { type: 'application/json' }));
        var a = global.document.createElement('a');
        a.href = url;
        a.download = filename;
        if (global.document.body && typeof global.document.body.appendChild === 'function') {
          global.document.body.appendChild(a);
        }
        if (typeof a.click === 'function') a.click();
        return 'download';
      }
    } catch (e) { /* 退回手动复制，不阻断导出 */ }
    return 'manual';
  }

  /** 匿名导出：字段白名单自检通过后下载，返回文本便于控制台核对。 */
  function exportReport() {
    if (!TTK.data || !TTK.engine) return null;
    var text = TTK.data.exportAll(TTK.engine), obj;
    try { obj = JSON.parse(text); } catch (e) { return null; }
    var extra = Object.keys(obj).filter(function (k) { return !TRACE_TOP_KEYS[k]; });
    var badEvent = (obj.events || []).some(function (e) {
      return Object.keys(e).some(function (k) { return !EVENT_KEYS[k]; });
    });
    // customTemplates 每个元素也过顶层白名单：模板是用户 / 模型产出的自由 JSON，
    // 不查就会夹带契约外字段（如姓名、设备信息）进入「匿名」导出。
    var custom = Array.isArray(obj.customTemplates) ? obj.customTemplates : [];
    var badTpl = custom.length > 50 || custom.some(function (t) {
      if (!t || typeof t !== 'object' || Array.isArray(t)) return true;
      return Object.keys(t).some(function (k) { return !TEMPLATE_KEYS[k]; });
    });
    if (extra.length || badEvent || badTpl) {
      reportNotice = { text: '导出已阻止：出现契约外字段（' + extra.join(', ') + '），可能夹带可识别信息', kind: 'bad' };
      rerender();
      return null;
    }
    var how = downloadJson(text, 'ttk-learning-trace.json');
    reportNotice = {
      text: how === 'download'
        ? '已导出匿名 JSON（符合 learning-trace v1，不含姓名 / 学校 / 设备标识）'
        : '已生成匿名 JSON；当前浏览器不支持自动下载，请在下方文本框手动复制保存',
      kind: 'ok'
    };
    rerender();
    return text;
  }

  function importReport(text) {
    var obj;
    try { obj = JSON.parse(text); } catch (e) {
      reportNotice = { text: '导入失败：JSON 解析错误 ' + e.message, kind: 'bad' };
      rerender(); return false;
    }
    if (!obj || obj.schema !== 'ttk.learning-trace.v1' || !Array.isArray(obj.events)) {
      reportNotice = { text: '导入失败：不是 learning-trace v1 文件（缺 schema 或 events）', kind: 'bad' };
      rerender(); return false;
    }
    var res = TTK.data.importAll(text);
    // #21：导入的 customTemplates 不只写回 localStorage，还立刻挂回引擎，
    // 这样另一台设备恢复后侧栏 / 图谱 / 工坊列表当次就能看到，不必手动刷新。
    if (res.ok && TTK.app && typeof TTK.app.restoreCustom === 'function') {
      try { TTK.app.restoreCustom(); } catch (e) { /* 单个坏模板由恢复入口自行跳过 */ }
    }
    reportNotice = res.ok
      ? { text: '已导入 ' + res.events + ' 条事件；聚合卡片、图表、掌握度与时间线已即时刷新', kind: 'ok' }
      : { text: '导入失败：' + res.error, kind: 'bad' };
    rerender();
    return res.ok;
  }

  function readImportFile(file, done) {
    if (!file) return;
    if (typeof file.text === 'function') {
      file.text().then(done, function () { done(''); });
      return;
    }
    if (typeof global.FileReader === 'function') {
      var reader = new global.FileReader();
      reader.onload = function () { done(String(reader.result || '')); };
      reader.onerror = function () { done(''); };
      reader.readAsText(file);
      return;
    }
    done('');
  }

  function reportChart(engine, data) {
    var rows = engine.all().map(function (t) {
      return { name: t.name, n: data.byTpl(t.id, t).interactions };
    });
    var max = 1;
    rows.forEach(function (r) { if (r.n > max) max = r.n; });
    var barW = 34, gap = 12, base = 104, chartH = 148;
    var chartW = Math.max(320, rows.length * (barW + gap) + 36);
    var bars = rows.map(function (r, i) {
      var height = Math.max(2, Math.round(r.n / max * 78));
      var x = 24 + i * (barW + gap);
      return '<rect x="' + x + '" y="' + (base - height) + '" width="' + barW + '" height="' + height +
        '" rx="4" fill="#4f46e5" opacity="' + (r.n ? 0.85 : 0.25) + '"/>' +
        '<text x="' + (x + barW / 2) + '" y="' + (base - height - 5) + '" font-size="10" ' +
        'text-anchor="middle" fill="#64748b">' + r.n + '</text>' +
        '<text x="' + (x + barW / 2) + '" y="' + (base + 15) + '" font-size="9" ' +
        'text-anchor="middle" fill="#94a3b8">' + esc(String(r.name).slice(0, 4)) + '</text>';
    }).join('');
    return '<div class="report-chart"><svg viewBox="0 0 ' + chartW + ' ' + chartH + '" width="100%" ' +
      'height="' + chartH + '" role="img" aria-label="各概念交互次数">' +
      '<line x1="12" y1="' + (base + 0.5) + '" x2="' + (chartW - 12) + '" y2="' + (base + 0.5) +
      '" stroke="#e2e8f0"/>' + bars + '</svg></div>';
  }

  function renderReport() {
    var el = $('view-report');
    if (!el) return;
    var data = TTK.data, engine = TTK.engine, graph = TTK.graph;
    if (!data || !engine) {
      el.innerHTML = pane('学习报告', '<div class="empty">数据层尚未就绪</div>');
      return;
    }
    var s = data.stats(engine);
    var cards = [
      ['次交互', s.interactions],
      ['已探索概念', s.explored + '/' + s.totalConcepts],
      ['完成挑战', s.challengesDone + '/' + s.challengesTotal],
      ['卡点记录', s.stuckCount]
    ].map(function (c) {
      return '<div class="stat"><b>' + esc(c[1]) + '</b><span>' + esc(c[0]) + '</span></div>';
    }).join('');
    var rows = engine.all().map(function (t) {
      var b = data.byTpl(t.id, t);
      var mastery = graph && typeof graph.mastery === 'function' ? graph.mastery(t.id) : b.challengeRate;
      var pct = Math.round(mastery * 100);
      return '<div class="prog-row"><span>' + esc(t.name) + '</span>' +
        '<span class="prog-track"><i style="width:' + pct + '%"></i></span>' +
        '<b>' + pct + '%</b></div>';
    }).join('');
    var labels = {
      select: '进入沙盒', stuck: '标记卡点', reset: '重置参数',
      param: '调整参数', challenge: '完成挑战', view: '切换视图'
    };
    var timeline = data.timeline(20).map(function (r) {
      var d = new Date(r.at);
      var time = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      return '<div class="tl-item"><span class="tl-time">' + time + '</span>' +
        '<span class="tl-body"><b>' + esc(r.name) + '</b> · ' + esc(labels[r.reason] || r.reason) +
        '<small>' + esc((r.insight || '').slice(0, 46)) + '</small></span></div>';
    }).join('') || '<div class="empty">还没有记录。回到沙盒拖动一个参数试试。</div>';
    var tools = '<div class="report-tools">' +
      '<button id="reportExport" class="btn primary">导出匿名 JSON</button>' +
      '<button id="reportImport" class="btn">导入 JSON</button>' +
      '<input id="reportImportFile" type="file" accept=".json,application/json" hidden>' +
      noticeHtml(reportNotice, 'reportMsg') + '</div>' +
      (reportExportText ? '<label class="studio-label" for="reportExportText">导出内容（可手动复制）</label>' +
        '<textarea id="reportExportText" class="report-export-text" readonly></textarea>' : '');
    el.innerHTML = pane('学习报告',
      tools + '<div class="stat-box">' + cards + '</div>' +
      '<h3>各概念交互次数</h3>' + reportChart(engine, data) +
      '<h3>概念掌握度</h3>' + rows +
      '<h3>最近轨迹</h3><div class="timeline">' + timeline + '</div>',
      '导出文件符合 contracts/learning-trace.schema.json，字段白名单校验后才允许下载；导入会用文件内容覆盖本机记录（不是合并，请先导出备份）。',
      'M2');
    if (reportExportText) {
      var box = $('reportExportText');
      if (box) box.value = reportExportText;
    }
    var ex = $('reportExport');
    if (ex) ex.addEventListener('click', exportReport);
    var im = $('reportImport');
    if (im) im.addEventListener('click', function () {
      var f = $('reportImportFile');
      if (f && typeof f.click === 'function') f.click();
    });
    var fi = $('reportImportFile');
    if (fi) fi.addEventListener('change', function () {
      var f = fi.files && fi.files[0];
      readImportFile(f, function (text) { if (text) importReport(text); });
      fi.value = '';
    });
  }

  /* ---------------- #I3 模板工坊 ---------------- */
  function jsonErrorLine(err, text) {
    var m = /line (\d+)/i.exec(err.message || '');
    if (m) return Number(m[1]);
    m = /position (\d+)/i.exec(err.message || '');
    if (m) return text.slice(0, Number(m[1])).split('\n').length;
    return null;
  }

  /** 把 dsl.validate 的字段路径映射到 JSON 文本里的行，并取出报错的标识符。 */
  function errorLocation(text, spec, err) {
    var s = String(err || ''), split = s.indexOf('：');
    var tag = split > 0 ? s.slice(0, split) : s;
    var msg = split > 0 ? s.slice(split + 1) : '';
    var im = /「([^」]+)」/.exec(msg);
    var m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)\])?(?:\.([A-Za-z_][A-Za-z0-9_]*))?/.exec(tag);
    var hit = null;
    if (m && spec) {
      var field = m[1], idx = m[2] === undefined ? null : Number(m[2]), sub = m[3];
      var target = spec[field];
      if (idx !== null && Array.isArray(target)) target = target[idx];
      if (sub && target && typeof target === 'object') target = target[sub];
      if (target !== undefined && target !== null && typeof target !== 'object') {
        var needle = JSON.stringify(target), pos = text.indexOf(needle);
        if (pos >= 0) hit = { pos: pos, len: needle.length, line: text.slice(0, pos).split('\n').length };
      }
      if (!hit) {
        var key = sub || field;
        var re = new RegExp('"' + key + '"\\s*:', 'g');
        var found = null, count = 0, nth = idx === null ? 1 : idx + 1;
        while ((found = re.exec(text))) { count++; if (count >= nth) break; }
        if (found) hit = { pos: found.index, len: found[0].length, line: text.slice(0, found.index).split('\n').length };
      }
    }
    return { tag: tag, msg: msg, ident: im ? im[1] : '', hit: hit };
  }
  function describeError(loc) {
    var head = loc.hit ? '第 ' + loc.hit.line + ' 行' : '未能定位行';
    return head + ' · ' + loc.tag + (loc.ident ? ' · 标识符「' + loc.ident + '」' : '') +
      (loc.msg ? '：' + loc.msg : '');
  }
  function highlightStudio(loc) {
    var ta = $('studioJson');
    if (!ta || !loc || !loc.hit || typeof ta.setSelectionRange !== 'function') return;
    var text = String(ta.value || '');
    var start = text.lastIndexOf('\n', loc.hit.pos) + 1;
    var end = text.indexOf('\n', loc.hit.pos + loc.hit.len);
    if (end < 0) end = text.length;
    try {
      if (typeof ta.focus === 'function') ta.focus();
      ta.setSelectionRange(start, end);
    } catch (e) { /* 不支持选区的环境忽略 */ }
  }

  function parseStudio() {
    var ta = $('studioJson');
    var text = ta ? String(ta.value || '') : '';
    studioDraft = text;
    var spec;
    try { spec = JSON.parse(text); }
    catch (e) {
      var line = jsonErrorLine(e, text);
      setStudioNotice('JSON 解析失败' + (line ? '（第 ' + line + ' 行）' : '') + '：' + e.message, 'bad');
      return null;
    }
    return { text: text, spec: spec };
  }

  function existingIds(own) {
    if (!TTK.engine) return [];
    return TTK.engine.all().map(function (t) { return t.id; }).filter(function (id) { return id !== own; });
  }
  function customList() {
    var list = TTK.data && TTK.data.custom ? TTK.data.custom() : [];
    return Array.isArray(list) ? list : [];
  }

  /** 校验入口：返回 {parsed, v}，失败时给出行号 + 字段 + 标识符并高亮出错行。 */
  function validateStudio() {
    var parsed = parseStudio();
    if (!parsed) return null;
    var own = parsed.spec && parsed.spec.id;
    var current = TTK.engine && TTK.engine.get(own);
    if (current && !current.custom) {
      setStudioNotice('id「' + own + '」是内置精修模板，不能覆盖；请换一个 id', 'bad');
      return null;
    }
    var v = TTK.dsl.validate(parsed.spec, existingIds(own));
    if (!v.ok) {
      var errors = v.errors || ['校验失败'];
      var first = errorLocation(parsed.text, parsed.spec, errors[0]);
      var more = errors.length > 1
        ? '；另有 ' + (errors.length - 1) + ' 处：' + errors.slice(1, 3).map(function (e) {
          return describeError(errorLocation(parsed.text, parsed.spec, e));
        }).join('；')
        : '';
      setStudioNotice('校验未通过：' + describeError(first) + more, 'bad');
      highlightStudio(first);
      return null;
    }
    setStudioNotice('校验通过（' + ((parsed.spec.params || []).length) +
      ' 个参数）；公式只走 expr 白名单，不会执行任意 JS', 'ok');
    return { parsed: parsed, v: v };
  }

  /** 编译 → 注册 → 工坊内即时预览 → 自动切到沙盒，可直接拖动参数。 */
  function compileStudio() {
    var checked = validateStudio();
    if (!checked || !TTK.engine) return null;
    var spec = checked.parsed.spec, tpl;
    try { tpl = TTK.dsl.compile(spec, checked.v); }
    catch (e) { setStudioNotice('编译失败：' + e.message, 'bad'); return null; }
    var existing = TTK.engine.get(spec.id);
    try {
      if (existing) TTK.engine.unregister(spec.id);
      TTK.engine.register(tpl);
    } catch (e) { setStudioNotice('挂载失败：' + e.message, 'bad'); return null; }
    studioPreview = { tpl: tpl };
    setStudioNotice('已编译并挂载「' + tpl.name + '」；公式经 expr 白名单校验。切到沙盒即可拖动参数。', 'ok');
    paintStudioPreview();
    goView('sandbox', tpl.id);
    return tpl;
  }

  function saveStudio() {
    var checked = validateStudio();
    if (!checked || !TTK.data || !TTK.engine) return false;
    var spec = JSON.parse(JSON.stringify(checked.parsed.spec));
    var list = customList().filter(function (s) { return s && s.id !== spec.id; });
    list.push(spec);
    TTK.data.saveCustom(list);
    if (!TTK.engine.get(spec.id)) {
      try { TTK.engine.register(TTK.dsl.compile(spec, checked.v)); }
      catch (e) { /* 校验已通过，理论上不会到这一步 */ }
    }
    setStudioNotice('已保存「' + spec.name + '」到本机（ttk.custom.v1）。刷新页面后会自动重新挂载。', 'ok');
    return true;
  }

  function loadStudio(id) {
    var found = customList().filter(function (s) { return s && s.id === id; })[0];
    if (!found) return;
    studioDraft = JSON.stringify(found, null, 2);
    setStudioNotice('已载入「' + found.name + '」，可继续编辑后点「编译并挂载」', 'ok');
  }

  function deleteStudio(id) {
    var list = customList().filter(function (s) { return s && s.id !== id; });
    TTK.data.saveCustom(list);
    var tpl = TTK.engine && TTK.engine.get(id);
    if (tpl && tpl.custom) {
      try { TTK.engine.unregister(id); } catch (e) { /* 已不在注册表 */ }
    }
    if (studioPreview && studioPreview.tpl.id === id) studioPreview = null;
    setStudioNotice('已删除自定义模板「' + id + '」', 'ok');
  }

  function paintStudioPreview() {
    if (!studioPreview) return;
    var box = $('studioPreviewBody');
    if (!box) return;
    var tpl = studioPreview.tpl, spec;
    try { spec = tpl.compute(TTK.engine.defaults(tpl), TTK.math); }
    catch (e) { box.innerHTML = '<div class="empty">预览计算失败：' + esc(e.message) + '</div>'; return; }
    var metrics = (spec.metrics || []).map(function (m) {
      return '<span class="studio-metric">' + esc(m.label) + ' <b>' + esc(TTK.math.fmt(m.value, 3)) +
        '</b> ' + esc(m.unit || '') + '</span>';
    }).join('') || '<span class="studio-metric">该模板没有指标</span>';
    box.innerHTML = '<canvas id="studioCanvas" class="studio-canvas"></canvas>' +
      '<div class="studio-metrics">' + metrics + '</div>';
    var cv = $('studioCanvas');
    if (cv && typeof cv.getContext === 'function' && TTK.Renderer) {
      try { new TTK.Renderer(cv).draw(spec.chart); } catch (e) { /* 预览失败不影响挂载 */ }
    }
  }

  function renderStudio() {
    var el = $('view-studio');
    if (!el) return;
    var blank = (TTK.dsl && TTK.dsl.blank) ? TTK.dsl.blank() : {};
    var text = studioDraft === null ? JSON.stringify(blank, null, 2) : studioDraft;
    var saved = customList();
    var list = saved.length ? saved.map(function (s) {
      var badge = s && s.source === 'llm' ? '<span class="studio-badge">模型生成</span>' : '';
      return '<div class="studio-saved"><span>' + esc((s && s.name) || (s && s.id) || '未命名') +
        ' <small>' + esc((s && s.id) || '') + '</small>' + badge + '</span>' +
        '<button class="btn tiny" data-studio-load="' + esc(s && s.id) + '">载入</button>' +
        '<button class="btn tiny" data-studio-del="' + esc(s && s.id) + '">删除</button></div>';
    }).join('') : '<div class="empty">还没有保存的自定义模板。</div>';
    el.innerHTML = pane('模板工坊',
      '<label class="studio-label" for="studioJson">TemplateSpec JSON</label>' +
      '<textarea id="studioJson" class="studio-json" spellcheck="false"></textarea>' +
      '<div class="studio-actions">' +
      '<button id="studioValidate" class="btn">校验模板</button>' +
      '<button id="studioCompile" class="btn primary">编译并挂载</button>' +
      '<button id="studioSave" class="btn">保存到本机</button>' +
      '<button id="studioExample" class="btn">载入 spring 示例</button>' +
      noticeHtml(studioNotice, 'studioMsg') + '</div>' +
      '<div class="studio-actions">' +
      '<button id="studioExport" class="btn">导出 JSON</button>' +
      '<button id="studioImport" class="btn">导入恢复</button>' +
      '<input id="studioImportFile" type="file" accept=".json,application/json" hidden>' +
      '<span class="studio-note">与「学习报告」共用 exportAll / importAll 同一入口</span></div>' +
      (reportExportText ? '<label class="studio-label" for="studioExportText">导出内容（可手动复制）</label>' +
        '<textarea id="studioExportText" class="report-export-text" readonly></textarea>' : '') +
      '<div id="studioPreview" class="studio-preview"><h3>即时预览</h3>' +
      '<div id="studioPreviewBody"><div class="empty">点「编译并挂载」后会在这里画出曲线与指标。</div></div></div>' +
      '<h3>已保存的自定义模板（刷新后自动挂载）</h3><div class="studio-list">' + list + '</div>',
      '粘贴 contracts/examples/spring.json → 校验 → 编译挂载 → 切到沙盒拖动；非法公式会指出行号、字段与标识符。导出 / 导入与「学习报告」共用同一入口，自定义模板随 JSON 一起备份与恢复。',
      'M2');
    var ta = $('studioJson');
    if (ta) {
      ta.value = text;
      ta.addEventListener('input', function () { studioDraft = ta.value; });
    }
    var binds = [
      ['studioValidate', function () { validateStudio(); }],
      ['studioCompile', compileStudio],
      ['studioSave', saveStudio],
      ['studioExample', function () {
        studioDraft = JSON.stringify(TTK.dsl.example, null, 2);
        setStudioNotice('已载入 spring 示例；点「编译并挂载」即可拖动参数', 'ok');
      }],
      ['studioExport', exportReport],
      ['studioImport', function () {
        var f = $('studioImportFile');
        if (f && typeof f.click === 'function') f.click();
      }]
    ];
    binds.forEach(function (b) {
      var el2 = $(b[0]);
      if (el2) el2.addEventListener('click', b[1]);
    });
    var si = $('studioImportFile');
    if (si) si.addEventListener('change', function () {
      var f = si.files && si.files[0];
      readImportFile(f, function (text) { if (text) importReport(text); });
      si.value = '';
    });
    if (reportExportText) {
      var exportBox = $('studioExportText');
      if (exportBox) exportBox.value = reportExportText;
    }
    each(el.querySelectorAll('[data-studio-load]'), function (btn) {
      btn.addEventListener('click', function () { loadStudio(btn.getAttribute('data-studio-load')); });
    });
    each(el.querySelectorAll('[data-studio-del]'), function (btn) {
      btn.addEventListener('click', function () { deleteStudio(btn.getAttribute('data-studio-del')); });
    });
    paintStudioPreview();
  }

  register('graph', renderGraph);
  register('sandbox', renderSandbox);
  register('report', renderReport);
  register('studio', renderStudio);
  bindData();

  TTK.views = {
    register: register,
    mount: mount,
    go: go,
    current: current,
    routes: routes,
    on: function (fn) {
      handlers.push(fn);
      return function () { handlers = handlers.filter(function (h) { return h !== fn; }); };
    },
    start: start,
    setTpl: setTpl,
    parseHash: parseHash,
    hash: function () { return buildHash(currentId || DEFAULT_VIEW, context.tpl); },
    refresh: refresh,
    exportReport: exportReport,
    importReport: importReport,
    DEFAULT_VIEW: DEFAULT_VIEW
  };
})(window);
