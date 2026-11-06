/* 拖拖看 · 四视图路由骨架（付嘉一 · #I1）
 * ---------------------------------------------------------------
 * 【状态】接口占位。骨架已由 index.html 加载（零副作用，可在控制台调试），但**视图实现与 UI 接入未完成**。
 * 【接入方式】用 TTK.views.register(id, fn) 注册各视图的挂载函数，
 *            再在 app.js 里把导航切换挂到 TTK.views.go()。
 * 【为什么只有骨架】原页面已能完整跑通沙盒交互，先冻结路由契约再迁移，
 *            避免四个人同时改 app.js 造成冲突。任务见 docs/02 的 #I1/#I2/#I3/#I14。
 *
 * 约定：视图之间不直接互相调用，只通过 TTK.engine 事件与 TTK.data 交换数据。
 */
(function (global) {
  'use strict';

  var TTK = global.TTK = global.TTK || {};

  var ROUTES = [
    { id: 'graph', name: '概念图谱', hash: '#graph', mount: null, todo: '#I14' },
    { id: 'sandbox', name: '交互沙盒', hash: '#sandbox', mount: null, todo: '复用 app.js 现有装配' },
    { id: 'report', name: '学习报告', hash: '#report', mount: null, todo: '#I2' },
    { id: 'studio', name: '模板工坊', hash: '#studio', mount: null, todo: '#I3' }
  ];

  var currentId = null;

  function find(id) {
    for (var i = 0; i < ROUTES.length; i++) if (ROUTES[i].id === id) return ROUTES[i];
    return null;
  }

  /** 挂载某个视图；未实现的视图明确告警并返回 false，绝不假装成功。 */
  function mount(id) {
    var route = find(id || 'sandbox');
    if (!route) { console.warn('[TTK.views] 未知视图：' + id); return false; }
    if (typeof route.mount !== 'function') {
      console.warn('[TTK.views] 视图「' + route.name + '」尚未实现（' + route.todo + '），保持当前视图不变');
      return false;
    }
    route.mount();
    currentId = route.id;
    emit('change', route);
    return true;
  }

  /** 切换视图并同步 hash；返回是否切换成功。 */
  function go(id) {
    var ok = mount(id);
    if (ok && global.location) global.location.hash = find(id).hash;
    return ok;
  }

  function current() { return find(currentId); }
  function routes() { return ROUTES.slice(); }

  var handlers = [];
  function on(fn) { handlers.push(fn); return function () { handlers = handlers.filter(function (h) { return h !== fn; }); }; }
  function emit(evt, payload) { handlers.slice().forEach(function (fn) { try { fn(evt, payload); } catch (e) { console.error(e); } }); }

  /** 供实现方注册：register('report', function(){ ... }) */
  function register(id, fn) {
    var route = find(id);
    if (!route || typeof fn !== 'function') return false;
    route.mount = fn;
    return true;
  }

  TTK.views = {
    register: register,
    mount: mount,
    go: go,
    current: current,
    routes: routes,
    on: on,
    TODO: ['#I1 接入 index.html 与导航', '#I2 学习报告', '#I3 模板工坊', '#I13 先统一数据层', '#I14 图谱视图']
  };
})(window);
