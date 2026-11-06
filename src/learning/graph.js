/* 拖拖看 · 概念图谱与学习诊断
 * ---------------------------------------------------------------
 * 把散落的沙盒连成「先修关系图」，再从真实轨迹算掌握度，
 * 回答闭环层最难的一问：这个学生接下来该玩哪个沙盒，为什么。
 */
(function (global) {
  'use strict';

  var TTK = global.TTK = global.TTK || {};

  function Graph(engine, data) {
    this.engine = engine;
    this.data = data;
  }

  Graph.prototype.tpl = function (id) { return this.engine.get(id); };

  Graph.prototype.edges = function () {
    var out = [], self = this;
    this.engine.all().forEach(function (t) {
      (t.prerequisites || []).forEach(function (pre) {
        if (self.engine.get(pre)) out.push({ from: pre, to: t.id });
      });
    });
    return out;
  };

  Graph.prototype.depth = function (id, seen) {
    seen = seen || {};
    if (seen[id]) return 0; // 防环
    seen[id] = 1;
    var t = this.tpl(id), self = this;
    if (!t || !(t.prerequisites || []).length) return 0;
    var max = 0;
    t.prerequisites.forEach(function (pre) {
      if (self.engine.get(pre)) max = Math.max(max, self.depth(pre, Object.assign({}, seen)) + 1);
    });
    return max;
  };

  // 掌握度 = 挑战完成 + 探索深度 + 是否接触过 - 卡点惩罚
  Graph.prototype.mastery = function (id) {
    var t = this.tpl(id);
    if (!t) return 0;
    var b = this.data.byTpl(id, t);
    var challengePart = b.challengeTotal ? 0.6 * b.challengeRate : 0.6 * Math.min(1, b.interactions / 4);
    var m = challengePart
      + 0.25 * Math.min(1, b.interactions / 8)
      + (b.interactions > 0 ? 0.15 : 0)
      - 0.15 * Math.min(1, b.stuck / 2);
    return Math.max(0, Math.min(1, m));
  };

  Graph.prototype.recommend = function () {
    var self = this;
    return this.engine.all().map(function (t) {
      var m = self.mastery(t.id), b = self.data.byTpl(t.id, t);
      var ready = (t.prerequisites || []).every(function (pre) { return self.mastery(pre) >= 0.5; });
      var score = (ready ? 2 : 0) - m * 1.5 + Math.min(b.stuck, 3) * 0.4 + (b.interactions === 0 ? 0.2 : 0);
      var reason;
      if (b.stuck >= 1 && m < 0.6) reason = '在这里卡过 ' + b.stuck + ' 次，建议回看前置直觉';
      else if (!b.interactions) reason = '还没探索过，先建立第一印象';
      else if (ready && m < 0.6) reason = '先修概念已经掌握，正好往下走';
      else if (m >= 0.8) reason = '已经比较熟，可以试着讲给别人听';
      else reason = '再拖几组参数巩固一下';
      return { tpl: t, mastery: m, prereqReady: ready, score: score, reason: reason, stats: b };
    }).sort(function (a, b) { return b.score - a.score; });
  };

  // 分层布局：x = 先修深度，y = 同层序号；给视图直接生成 SVG 用
  Graph.prototype.layout = function () {
    var self = this, groups = {}, maxDepth = 0, maxCount = 0;
    this.engine.all().forEach(function (t) {
      var d = self.depth(t.id);
      (groups[d] = groups[d] || []).push(t);
      maxDepth = Math.max(maxDepth, d);
      maxCount = Math.max(maxCount, groups[d].length);
    });
    var GAP_X = 190, GAP_Y = 84, PAD_X = 24, PAD_Y = 24;
    var nodes = [];
    Object.keys(groups).forEach(function (d) {
      groups[d].forEach(function (t, i) {
        nodes.push({
          id: t.id, tpl: t, depth: Number(d),
          x: PAD_X + Number(d) * GAP_X,
          y: PAD_Y + i * GAP_Y,
          mastery: self.mastery(t.id)
        });
      });
    });
    return {
      nodes: nodes, edges: this.edges(),
      nodeW: 158, nodeH: 54,
      width: PAD_X * 2 + maxDepth * GAP_X + 158,
      height: PAD_Y * 2 + Math.max(1, maxCount - 1) * GAP_Y + 54
    };
  };

  TTK.createGraph = function (engine, data) { return new Graph(engine, data); };
})(window);
