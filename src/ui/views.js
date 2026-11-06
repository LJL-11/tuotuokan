/* 拖拖看 · 四视图路由（付 · #I1）
 * ---------------------------------------------------------------
 * 四个视图：概念图谱 / 交互沙盒 / 学习报告 / 模板工坊。
 * 路由格式 #<view>/<tplId>：前半段决定显示哪个视图，后半段记住当前概念。
 * 兼容 v0 的 #overfit 这类「只有模板 id」的链接，一律当作沙盒视图处理。
 * 只用全局 TTK 与传统 script，双击 index.html 即可跑，不请求任何本地文件。
 *
 * 约定：视图之间不直接互相调用，只通过 TTK.engine 事件与 TTK.data 交换数据。
 * 报告 / 工坊 / 图谱这里只做「可切换的最小可用版」，精修分别交给 #I2 / #I3 / #I14。
 */
(function (global) {
  'use strict';

  var TTK = global.TTK = global.TTK || {};
  var DEFAULT_VIEW = 'sandbox';
  var ROUTES = [
    { id: 'graph', name: '概念图谱', hash: '#graph', mount: null, todo: '#I14 精修可视化' },
    { id: 'sandbox', name: '交互沙盒', hash: '#sandbox', mount: null, todo: 'v0 三栏装配' },
    { id: 'report', name: '学习报告', hash: '#report', mount: null, todo: '#I2 导出与图表' },
    { id: 'studio', name: '模板工坊', hash: '#studio', mount: null, todo: '#I3 编译与保存' }
  ];

  var currentId = null, context = { tpl: '' }, started = false, lastApplied = '';
  var handlers = [];

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

  /* ---------------- 视图内容（最小可用版） ---------------- */
  function pane(title, body, note) {
    return '<div class="pane-head"><h2>' + esc(title) + '</h2><span class="pane-tag">M1</span></div>' +
      '<div class="pane-body">' + body + '</div>' +
      (note ? '<p class="pane-note">' + esc(note) + '</p>' : '');
  }

  // 沙盒三栏是静态 DOM，由 app.js 装配；切回来时由 app.js 重绘 Canvas。
  function renderSandbox() { /* no-op：避免隐藏期间对零尺寸画布作图 */ }

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
      return '<line x1="' + (a.x + layout.nodeW) + '" y1="' + (a.y + layout.nodeH / 2) +
        '" x2="' + b.x + '" y2="' + (b.y + layout.nodeH / 2) +
        '" stroke="#cbd5e1" stroke-width="1.5"/>';
    }).join('');
    var nodes = layout.nodes.map(function (n) {
      var color = n.mastery >= 0.7 ? '#0d9488' : n.mastery >= 0.3 ? '#4f46e5' : '#94a3b8';
      return '<g data-node="' + esc(n.id) + '" style="cursor:pointer">' +
        '<rect x="' + n.x + '" y="' + n.y + '" width="' + layout.nodeW + '" height="' + layout.nodeH +
        '" rx="10" fill="#ffffff" stroke="' + color + '" stroke-width="1.5"/>' +
        '<rect x="' + n.x + '" y="' + n.y + '" width="5" height="' + layout.nodeH + '" rx="2" fill="' + color + '"/>' +
        '<text x="' + (n.x + 16) + '" y="' + (n.y + 22) + '" font-size="12" fill="#1e293b">' + esc(n.tpl.name) + '</text>' +
        '<text x="' + (n.x + 16) + '" y="' + (n.y + 40) + '" font-size="10" fill="#94a3b8">掌握度 ' +
        Math.round(n.mastery * 100) + '%</text></g>';
    }).join('');
    el.innerHTML = pane('概念图谱',
      '<div class="graph-scroll"><svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h +
      '" role="img" aria-label="概念先修关系图">' + edges + nodes + '</svg></div>',
      '点节点可跳到该概念的沙盒；布局精修与掌握度交互见 #I14');
    each(el.querySelectorAll('[data-node]'), function (g) {
      g.addEventListener('click', function () { go('sandbox', g.getAttribute('data-node')); });
    });
  }

  function renderReport() {
    var el = $('view-report');
    if (!el) return;
    var data = TTK.data, engine = TTK.engine;
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
      var pct = b.challengeTotal ? Math.round(b.challengeDone / b.challengeTotal * 100) : 0;
      return '<div class="prog-row"><span>' + esc(t.name) + '</span>' +
        '<span class="prog-track"><i style="width:' + pct + '%"></i></span>' +
        '<b>' + b.challengeDone + '/' + b.challengeTotal + '</b></div>';
    }).join('');
    var labels = {
      select: '进入沙盒', stuck: '标记卡点', reset: '重置参数',
      param: '调整参数', challenge: '完成挑战', view: '切换视图'
    };
    var timeline = data.timeline(12).map(function (r) {
      var d = new Date(r.at);
      var time = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      return '<div class="tl-item"><span class="tl-time">' + time + '</span>' +
        '<span class="tl-body"><b>' + esc(r.name) + '</b> · ' + esc(labels[r.reason] || r.reason) +
        '<small>' + esc((r.insight || '').slice(0, 46)) + '</small></span></div>';
    }).join('') || '<div class="empty">还没有记录。回到沙盒拖动一个参数试试。</div>';
    el.innerHTML = pane('学习报告',
      '<div class="stat-box">' + cards + '</div><h3>概念掌握度</h3>' + rows +
      '<h3>最近轨迹</h3><div class="timeline">' + timeline + '</div>',
      '匿名导出 / 导入按钮与图表精修见 #I2');
  }

  function renderStudio() {
    var el = $('view-studio');
    if (!el) return;
    var blank = (TTK.dsl && TTK.dsl.blank) ? TTK.dsl.blank() : {};
    el.innerHTML = pane('模板工坊',
      '<label class="studio-label" for="studioJson">TemplateSpec JSON</label>' +
      '<textarea id="studioJson" class="studio-json" spellcheck="false">' +
      esc(JSON.stringify(blank, null, 2)) + '</textarea>' +
      '<div class="studio-actions"><button id="studioValidate" class="btn primary">校验模板</button>' +
      '<span id="studioMsg" class="studio-msg"></span></div>',
      '编译、即时预览与保存到 TTK.data.saveCustom 见 #I3');
    var btn = $('studioValidate');
    if (btn) btn.addEventListener('click', validateStudio);
  }
  function validateStudio() {
    var msg = $('studioMsg'), ta = $('studioJson');
    if (!msg || !ta || !TTK.dsl) return;
    var obj;
    try { obj = JSON.parse(ta.value); }
    catch (e) {
      msg.textContent = 'JSON 解析失败：' + e.message;
      msg.className = 'studio-msg bad';
      return;
    }
    var res = TTK.dsl.validate(obj, []);
    if (res.ok) {
      msg.textContent = '校验通过（' + ((obj.params || []).length) + ' 个参数）';
      msg.className = 'studio-msg ok';
    } else {
      msg.textContent = (res.errors || []).slice(0, 3).join('；');
      msg.className = 'studio-msg bad';
    }
  }

  register('graph', renderGraph);
  register('sandbox', renderSandbox);
  register('report', renderReport);
  register('studio', renderStudio);

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
    DEFAULT_VIEW: DEFAULT_VIEW
  };
})(window);
