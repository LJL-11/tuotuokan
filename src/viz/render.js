/* 拖拖看 · 通用可视化渲染器
 * ---------------------------------------------------------------
 * 模板只产出声明式的 chart spec，所有绘制（坐标、网格、图例、多面板）在这里统一完成。
 * 这是「通用引擎」而非「写死小游戏」的关键：新增概念不需要碰渲染代码。
 *
 * chart spec:
 * {
 *   panels: [ panel, ... ]        // 可选；不写则单面板
 *   panel = {
 *     title, xLabel, yLabel,
 *     xDomain: [min,max], yDomain: [min,max],   // 可选，缺省自动
 *     series: [{ name, color, points:[[x,y]], style:'line|dashed|area|scatter|bar', width, fill }],
 *     markers: [{ x, y, label, color }],
 *     guides:  [{ axis:'x'|'y', value, label, color }],
 *     bands:   [{ axis:'x'|'y', from, to, color, label }]
 *   }
 * }
 */
(function (global) {
  'use strict';

  var TTK = global.TTK = global.TTK || {};

  var C = {
    indigo: '#4f46e5',
    teal: '#0d9488',
    coral: '#e11d48',
    amber: '#d97706',
    violet: '#7c3aed',
    slate: '#64748b',
    grid: '#e9edf4',
    axis: '#cbd5e1',
    text: '#475569',
    muted: '#94a3b8',
    paper: '#ffffff'
  };
  TTK.colors = C;

  var PAD = { l: 58, r: 20, t: 26, b: 40 };

  function niceTicks(min, max, count) {
    if (!isFinite(min) || !isFinite(max) || max <= min) return [min];
    var span = max - min;
    var raw = span / count;
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    var start = Math.ceil(min / step) * step;
    var out = [];
    for (var v = start; v <= max + step * 0.001 && out.length < 12; v += step) {
      out.push(Math.abs(v) < step * 1e-6 ? 0 : v);
    }
    return out;
  }

  function short(v) {
    if (!isFinite(v)) return '';
    var a = Math.abs(v);
    if (a >= 1e5 || (a < 0.01 && a > 0)) return v.toExponential(0);
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1);
    return String(Number(v.toFixed(2)));
  }

  function domains(panel) {
    var xs = [], ys = [], hasPoint = false;
    (panel.series || []).forEach(function (s) {
      (s.points || []).forEach(function (p) {
        if (!p || !isFinite(p[0]) || !isFinite(p[1])) return;
        xs.push(p[0]); ys.push(p[1]); hasPoint = true;
      });
    });
    (panel.markers || []).forEach(function (m) {
      if (isFinite(m.x)) xs.push(m.x);
      if (isFinite(m.y)) ys.push(m.y);
    });
    var xd = panel.xDomain, yd = panel.yDomain;
    if (!xd) {
      if (!hasPoint || xs.length === 0) xd = [0, 1];
      else {
        var lo = Math.min.apply(null, xs), hi = Math.max.apply(null, xs);
        var px = (hi - lo || 1) * 0.06;
        xd = [lo - px, hi + px];
      }
    }
    if (!yd) {
      if (!hasPoint || ys.length === 0) yd = [0, 1];
      else {
        var lo2 = Math.min.apply(null, ys), hi2 = Math.max.apply(null, ys);
        var py = (hi2 - lo2 || 1) * 0.12;
        yd = [lo2 - py, hi2 + py];
      }
    }
    if (yd[1] - yd[0] < 1e-9) yd = [yd[0] - 1, yd[0] + 1];
    if (xd[1] - xd[0] < 1e-9) xd = [xd[0] - 1, xd[0] + 1];
    return { xd: xd, yd: yd };
  }

  function Renderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.spec = null;
    this._raf = null;
    var self = this;
    this._onResize = function () { self.draw(self.spec); };
    if (global.ResizeObserver) {
      this._ro = new ResizeObserver(this._onResize);
      this._ro.observe(canvas);
    } else {
      global.addEventListener('resize', this._onResize);
    }
  }

  Renderer.prototype.draw = function (spec) {
    this.spec = spec || null;
    var canvas = this.canvas, ctx = this.ctx;
    var box = canvas.getBoundingClientRect();
    var w = Math.max(320, Math.round(box.width || canvas.clientWidth || 720));
    var h = Math.max(220, Math.round(box.height || canvas.clientHeight || 400));
    var dpr = global.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = C.paper;
    ctx.fillRect(0, 0, w, h);

    var panels = (spec && spec.panels && spec.panels.length) ? spec.panels : (spec ? [spec] : []);
    if (!panels.length) {
      ctx.fillStyle = C.muted;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('暂无可视化数据', w / 2, h / 2);
      return;
    }
    var gap = 10;
    var ph = (h - gap * (panels.length - 1)) / panels.length;
    var self = this;
    panels.forEach(function (p, i) {
      self._panel(p, 0, i * (ph + gap), w, ph);
    });
  };

  Renderer.prototype._panel = function (panel, ox, oy, w, h) {
    var ctx = this.ctx;
    var d = domains(panel);
    var xd = d.xd, yd = d.yd;
    var titleH = panel.title ? 20 : 0;
    var top = oy + PAD.t + titleH;
    var left = ox + PAD.l;
    var pw = Math.max(40, w - PAD.l - PAD.r);
    var pheight = Math.max(40, h - PAD.t - PAD.b - titleH);
    var bottom = top + pheight;

    var X = function (v) { return left + (v - xd[0]) / (xd[1] - xd[0]) * pw; };
    var Y = function (v) { return bottom - (v - yd[0]) / (yd[1] - yd[0]) * pheight; };

    // 标题
    if (panel.title) {
      ctx.fillStyle = C.text;
      ctx.font = '600 12px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(panel.title, left - 42, oy + 16);
    }

    // 区间带（先画，压在网格下）
    (panel.bands || []).forEach(function (b) {
      ctx.fillStyle = b.color || 'rgba(79,70,229,0.07)';
      if (b.axis === 'y') {
        var y1 = Y(Math.max(yd[0], Math.min(yd[1], b.to)));
        var y2 = Y(Math.max(yd[0], Math.min(yd[1], b.from)));
        ctx.fillRect(left, Math.min(y1, y2), pw, Math.abs(y2 - y1));
      } else {
        var x1 = X(Math.max(xd[0], Math.min(xd[1], b.from)));
        var x2 = X(Math.max(xd[0], Math.min(xd[1], b.to)));
        ctx.fillRect(Math.min(x1, x2), top, Math.abs(x2 - x1), pheight);
      }
    });

    // 网格 + 刻度
    var xt = niceTicks(xd[0], xd[1], 5), yt = niceTicks(yd[0], yd[1], 4);
    ctx.lineWidth = 1;
    ctx.strokeStyle = C.grid;
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = C.muted;
    xt.forEach(function (v) {
      var x = X(v);
      if (x < left - 1 || x > left + pw + 1) return;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillText(short(v), x, bottom + 14);
    });
    yt.forEach(function (v) {
      var y = Y(v);
      if (y < top - 1 || y > bottom + 1) return;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + pw, y); ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(short(v), left - 8, y + 3);
    });
    ctx.strokeStyle = C.axis;
    ctx.beginPath();
    ctx.moveTo(left, top); ctx.lineTo(left, bottom); ctx.lineTo(left + pw, bottom);
    ctx.stroke();

    // 辅助线
    (panel.guides || []).forEach(function (g) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = g.color || C.slate;
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (g.axis === 'y') { ctx.moveTo(left, Y(g.value)); ctx.lineTo(left + pw, Y(g.value)); }
      else { ctx.moveTo(X(g.value), top); ctx.lineTo(X(g.value), bottom); }
      ctx.stroke();
      ctx.restore();
      if (g.label) {
        ctx.fillStyle = g.color || C.slate;
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'left';
        if (g.axis === 'y') ctx.fillText(g.label, left + 6, Math.max(top + 10, Y(g.value) - 5));
        else ctx.fillText(g.label, Math.min(left + pw - 60, X(g.value) + 5), top + 11);
      }
    });

    // 数据系列
    (panel.series || []).forEach(function (s) {
      var pts = (s.points || []).filter(function (p) {
        return p && isFinite(p[0]) && isFinite(p[1]);
      });
      if (!pts.length) return;
      var color = s.color || C.indigo;
      var width = s.width || 2;
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top, pw, pheight);
      ctx.clip();

      if (s.style === 'area') {
        var base = Y(Math.max(yd[0], 0));
        ctx.beginPath();
        ctx.moveTo(X(pts[0][0]), base);
        pts.forEach(function (p) { ctx.lineTo(X(p[0]), Y(p[1])); });
        ctx.lineTo(X(pts[pts.length - 1][0]), base);
        ctx.closePath();
        ctx.fillStyle = s.fill || 'rgba(79,70,229,0.12)';
        ctx.fill();
      }
      if (s.style === 'bar') {
        var bw = Math.max(2, Math.min(18, pw / Math.max(pts.length, 1) * 0.6));
        ctx.fillStyle = s.fill || color;
        pts.forEach(function (p) { ctx.fillRect(X(p[0]) - bw / 2, Y(p[1]), bw, bottom - Y(p[1])); });
      } else if (s.style === 'scatter') {
        ctx.fillStyle = color;
        pts.forEach(function (p) {
          ctx.beginPath(); ctx.arc(X(p[0]), Y(p[1]), s.radius || 3, 0, Math.PI * 2); ctx.fill();
        });
      } else {
        ctx.beginPath();
        pts.forEach(function (p, i) { i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])); });
        if (s.style === 'dashed') ctx.setLineDash([6, 4]);
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    });

    // 标记点
    (panel.markers || []).forEach(function (m) {
      if (!isFinite(m.x) || !isFinite(m.y)) return;
      var x = X(m.x), y = Y(m.y);
      ctx.fillStyle = C.paper;
      ctx.strokeStyle = m.color || C.coral;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (m.label) {
        ctx.fillStyle = m.color || C.coral;
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.textAlign = x > left + pw - 90 ? 'right' : 'left';
        var dy = y < top + 24 ? 18 : -9;
        ctx.fillText(m.label, x + (ctx.textAlign === 'right' ? -8 : 8), y + dy);
      }
    });

    // 轴名
    ctx.fillStyle = C.muted;
    ctx.font = '10px system-ui, sans-serif';
    if (panel.yLabel) {
      ctx.save();
      ctx.translate(ox + 14, top + pheight / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.fillText(panel.yLabel, 0, 0);
      ctx.restore();
    }
    if (panel.xLabel) {
      ctx.textAlign = 'right';
      ctx.fillText(panel.xLabel, left + pw, oy + h - 4);
    }

    // 图例
    var legend = (panel.series || []).filter(function (s) { return s.name; }).slice(0, 6);
    if (legend.length) {
      var lx = left + 8, ly = top + 8;
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      legend.forEach(function (s, idx) {
        var col = idx % 3, row = Math.floor(idx / 3);
        var x = lx + col * 116, y = ly + row * 16;
        if (x + 110 > left + pw) return;
        ctx.fillStyle = s.color || C.indigo;
        ctx.fillRect(x, y - 7, 12, 3);
        ctx.fillStyle = C.text;
        ctx.fillText(s.name, x + 16, y - 3);
      });
    }
  };

  TTK.Renderer = Renderer;
})(window);
