/* 拖拖看 · 模板 DSL（概念 → 可运行沙盒的编译层）
 * ---------------------------------------------------------------
 * 内置模板是「精修样例」，DSL 才是「通用引擎」的入口：
 * 纯数据描述 → 校验 → 编译成引擎认识的模板对象 → 直接注册挂载。
 * 同一份 schema 既给人在工坊里手写，也给 LLM 输出；公式一律走 expr.js 的安全求值。
 */
(function (global) {
  'use strict';

  var TTK = global.TTK = global.TTK || {};
  var palette = ['#4f46e5', '#0d9488', '#e11d48', '#d97706'];

  function isStr(v, max) { return typeof v === 'string' && v.trim().length > 0 && v.length <= (max || 60); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function arr(v) { return Array.isArray(v) ? v : []; }

  var example = {
    id: 'spring',
    name: '弹簧振子',
    subject: '物理学',
    icon: '~',
    brief: '劲度系数怎么决定振动快慢？',
    concept: '位移满足 x(t)=A·cos(√k·t)：k 越大，回复力越强，振动越快，但振幅不变。',
    keywords: ['弹簧', '胡克定律', '振动'],
    prerequisites: ['oscillation'],
    x: { min: 0, max: 10, label: '时间 (s)', yLabel: '位移', samples: 160 },
    params: [
      { key: 'A', label: '振幅 A', min: 0.1, max: 3, step: 0.1, default: 1, unit: 'm', hint: '拉开的初始距离' },
      { key: 'k', label: '劲度系数 k', min: 0.1, max: 8, step: 0.1, default: 1, unit: '', hint: '弹簧有多硬' }
    ],
    series: [
      { name: '位移 x(t)', expr: 'p.A * Math.cos(Math.sqrt(p.k) * x)', color: '#4f46e5' },
      { name: '包络 +A', expr: 'p.A', color: '#94a3b8', style: 'dashed' }
    ],
    metrics: [
      { label: '角频率', expr: 'Math.sqrt(p.k)', unit: 'rad/s' },
      { label: '周期', expr: '2 * PI / Math.sqrt(p.k)', unit: 's' }
    ],
    insight: '拖动 k：曲线横向压缩，但高度不变——刚度只改快慢，不改振幅。',
    challenges: [
      { text: '把 k 调到 5 以上，让周期小于 π', expr: '2 * PI / Math.sqrt(p.k) < PI' }
    ]
  };

  function validate(spec, existingIds) {
    var errors = [], fns = { series: [], metrics: [], challenges: [] };
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      return { ok: false, errors: ['模板必须是一个 JSON 对象'], fns: fns };
    }
    if (!/^[a-z][a-z0-9_-]{1,30}$/.test(spec.id || '')) errors.push('id 需为小写字母开头、2-31 位（字母/数字/-/_）');
    if (existingIds && existingIds.indexOf(spec.id) >= 0) errors.push('id「' + spec.id + '」已被占用');
    if (!isStr(spec.name, 40)) errors.push('name 必填且不超过 40 字');
    if (!isStr(spec.subject, 30)) errors.push('subject 必填且不超过 30 字');
    if (!isStr(spec.brief, 80)) errors.push('brief 必填且不超过 80 字');

    var reserved = { x: 1, p: 1, M: 1, Math: 1, PI: 1, E: 1, m: 1 };
    var params = arr(spec.params);
    if (params.length < 1 || params.length > 6) errors.push('params 需 1-6 个参数');
    var keys = {};
    params.forEach(function (d, i) {
      var tag = 'params[' + i + ']';
      if (!d || !/^[A-Za-z][A-Za-z0-9_]*$/.test(d.key || '') || reserved[d.key]) errors.push(tag + '.key 非法或与保留名冲突');
      if (keys[d.key]) errors.push(tag + '.key 重复');
      keys[d.key] = 1;
      if (!isStr(d.label, 30)) errors.push(tag + '.label 必填');
      if (!isNum(d.min) || !isNum(d.max) || d.min >= d.max) errors.push(tag + ' 需满足 min < max');
      if (!isNum(d.step) || d.step <= 0) errors.push(tag + '.step 需为正数');
      if (!isNum(d.default) || d.default < d.min || d.default > d.max) errors.push(tag + '.default 需落在范围内');
    });

    var x = spec.x || {};
    if (!isNum(x.min) || !isNum(x.max) || x.min >= x.max) errors.push('x 需含合法的 min / max');
    var samples = isNum(x.samples) ? Math.round(x.samples) : 160;
    if (samples < 20 || samples > 400) errors.push('x.samples 需在 20-400 之间');

    function checkExpr(src, tag, bucket) {
      var r = TTK.expr.validate(src);
      if (!r.ok) errors.push(tag + '：' + r.error);
      bucket.push(r.ok ? r.fn : function () { return NaN; });
    }
    var series = arr(spec.series);
    if (series.length < 1 || series.length > 4) errors.push('series 需 1-4 条曲线');
    series.forEach(function (s, i) {
      if (!s || !isStr(s.name, 30)) errors.push('series[' + i + '].name 必填');
      if (s && s.color && !/^#[0-9a-fA-F]{6}$/.test(s.color)) errors.push('series[' + i + '].color 需为 #rrggbb');
      checkExpr(s ? s.expr : '', 'series[' + i + '].expr', fns.series);
    });
    arr(spec.metrics).slice(0, 5).forEach(function (mt, i) {
      if (!mt || !isStr(mt.label, 30)) errors.push('metrics[' + i + '].label 必填');
      checkExpr(mt ? mt.expr : '', 'metrics[' + i + '].expr', fns.metrics);
    });
    arr(spec.challenges).slice(0, 3).forEach(function (c, i) {
      if (!c || !isStr(c.text, 80)) errors.push('challenges[' + i + '].text 必填');
      checkExpr(c ? c.expr : '', 'challenges[' + i + '].expr', fns.challenges);
    });
    if (spec.insight !== undefined && typeof spec.insight !== 'string') errors.push('insight 需为字符串');
    return { ok: errors.length === 0, errors: errors, fns: fns, samples: samples };
  }

  function safe(fn, sc) {
    try { var v = fn(sc); return isNum(v) ? v : NaN; } catch (e) { return NaN; }
  }

  /* ComputeResult 形状校验（与 contracts/compute-result.schema.json 同步）
   * 零依赖手写实现：CI 用它检查样例、全部模板输出与 #I9 模拟帧。
   * 只收集前 6 条错误，避免大点数序列把日志刷爆。 */
  function validateResult(r) {
    var errors = [];
    function bad(msg) { if (errors.length < 6) errors.push(msg); }
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      return { ok: false, errors: ['ComputeResult 必须是对象'] };
    }
    if (typeof r.insight !== 'string') bad('insight 需为字符串');
    if (!r.m || typeof r.m !== 'object' || Array.isArray(r.m)) bad('m 需为对象');
    if (!Array.isArray(r.metrics)) bad('metrics 需为数组');
    else r.metrics.forEach(function (mt, i) {
      if (!mt || typeof mt.label !== 'string') bad('metrics[' + i + '].label 缺失');
      if (!mt || !(isNum(mt.value) || typeof mt.value === 'string')) {
        bad('metrics[' + i + '].value 需为有限数或状态词');
      }
    });
    if (!r.chart || typeof r.chart !== 'object') bad('chart 缺失');
    else if (r.chart.panels !== undefined) {
      if (!Array.isArray(r.chart.panels)) bad('chart.panels 需为数组');
      else r.chart.panels.forEach(function (pane, i) {
        if (!pane || !Array.isArray(pane.series)) {
          bad('chart.panels[' + i + '].series 需为数组'); return;
        }
        pane.series.forEach(function (s, j) {
          if (!s || typeof s.name !== 'string' || !Array.isArray(s.points)) {
            bad('chart.panels[' + i + '].series[' + j + '] 形状非法'); return;
          }
          for (var k = 0; k < s.points.length; k++) {
            var pt = s.points[k];
            if (!Array.isArray(pt) || pt.length !== 2 || !isNum(pt[0]) || !isNum(pt[1])) {
              bad('chart.panels[' + i + '].series[' + j + '].points[' + k + '] 坐标非法');
              break;
            }
          }
        });
      });
    }
    return { ok: errors.length === 0, errors: errors };
  }

  function compile(spec, v) {
    v = v || validate(spec);
    if (!v.ok) throw new Error('模板校验未通过：' + v.errors.join('；'));
    var samples = v.samples, x = spec.x;
    var seriesDefs = arr(spec.series), metricDefs = arr(spec.metrics).slice(0, 5), challengeDefs = arr(spec.challenges).slice(0, 3);

    var tpl = {
      id: spec.id,
      name: spec.name,
      subject: spec.subject,
      icon: spec.icon || '◇',
      level: '自定义模板',
      keywords: arr(spec.keywords).concat([spec.name, spec.id]),
      brief: spec.brief,
      concept: spec.concept || '由模板 DSL 生成：拖动参数，观察公式描述的量如何变化。',
      prerequisites: arr(spec.prerequisites),
      custom: true,
      spec: spec,
      params: arr(spec.params).map(function (d) {
        return {
          key: d.key, label: d.label, min: d.min, max: d.max, step: d.step,
          default: d.default, unit: d.unit || '', hint: d.hint || ''
        };
      }),
      compute: function (p, M) {
        var sc = TTK.expr.scope(p, M);
        var xs = M.linspace(x.min, x.max, samples);
        var series = seriesDefs.map(function (def, i) {
          var pts = [];
          xs.forEach(function (xv) {
            sc.x = xv;
            var y = safe(v.fns.series[i], sc);
            if (isFinite(y)) pts.push([xv, y]);
          });
          return {
            name: def.name, color: def.color || palette[i % palette.length],
            style: def.style || 'line', width: def.style === 'dashed' ? 1.6 : 2.2, points: pts
          };
        });
        var sc2 = TTK.expr.scope(p, M);
        var metrics = metricDefs.map(function (def, i) {
          return { label: def.label, value: safe(v.fns.metrics[i], sc2), unit: def.unit || '', digits: 3, tone: 'plain', hint: '由 DSL 表达式计算' };
        });
        var m = {};
        metrics.forEach(function (mt, i) { m['v' + i] = mt.value; });
        return {
          m: m,
          insight: spec.insight || ('拖动参数，观察「' + seriesDefs[0].name + '」的形状怎么变。'),
          metrics: metrics,
          chart: {
            panels: [{
              title: spec.name + ' · 参数扫描',
              xLabel: x.label || 'x', yLabel: x.yLabel || 'y',
              xDomain: [x.min, x.max],
              series: series
            }]
          }
        };
      },
      challenges: challengeDefs.map(function (def, i) {
        return {
          text: def.text,
          check: function (p, m) {
            var sc = TTK.expr.scope(p, TTK.math);
            sc.m = m || {};
            try { return !!v.fns.challenges[i](sc); } catch (e) { return false; }
          }
        };
      })
    };
    return tpl;
  }

  // 给 LLM 的系统提示：接上模型后，让它只输出这份 JSON，产出即可直接挂载
  function prompt(conceptText) {
    return [
      '你在为「拖拖看」生成一份可交互概念沙盒模板。只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。',
      '目标概念：' + (conceptText || '（由用户填写）'),
      '',
      '输出必须符合以下 schema（示例）：',
      JSON.stringify(example, null, 2),
      '',
      '规则：',
      '1. params 1-6 个，每个含 key/label/min/max/step/default/unit/hint；key 用字母开头的标识符，不能叫 x、p、M、Math、m。',
      '2. 公式 expr 里 x 是横轴自变量，p.key 取参数值，m.v0 是第 1 个指标值；可用 Math.sin/cos/exp/log/sqrt/pow、PI、min/max/clamp、四则、^、比较、&& || !、三元 ?:。',
      '3. expr 只允许数学表达式：禁止赋值、语句、字符串、下标、对象、函数定义和任何全局访问。运行时会走受限解析器，不执行 JS。',
      '4. series 1-4 条，metrics 0-5 个，challenges 0-3 个（challenge.expr 是返回布尔的表达式）。',
      '5. brief/concept/insight 用简体中文，面向没学过该概念的大学生，讲清「拖哪个参数会看到什么」。',
      '6. id 用小写英文唯一的短标识；prerequisites 填已有模板 id（如 oscillation / gradient / overfit / supply / projectile / epidemic / bayes / compound / decay / logistic），没有就留空数组。'
    ].join('\n');
  }

  // 本地降级：没有 LLM 时先给一份可编辑草稿，不假装是 AI 生成
  function draft(text) {
    var name = String(text || '').trim().slice(0, 20) || '新概念';
    return {
      id: 'custom_' + Date.now().toString(36),
      name: name,
      subject: '自定义',
      icon: '◇',
      brief: '（草稿）用参数观察「' + name + '」',
      concept: '这是一份本地草稿：公式是通用的正弦曲线，请改写成该概念真实的关系。接入大模型后可按概念直接产出公式、指标与引导挑战。',
      keywords: [name],
      prerequisites: [],
      x: { min: 0, max: 10, label: 'x', yLabel: 'y', samples: 160 },
      params: [
        { key: 'A', label: '振幅 A', min: 0.1, max: 5, step: 0.1, default: 1, unit: '', hint: '纵向缩放' },
        { key: 'k', label: '频率系数 k', min: 0.1, max: 5, step: 0.1, default: 1, unit: '', hint: '横向压缩' }
      ],
      series: [{ name: '示例曲线', expr: 'p.A * Math.sin(p.k * x)', color: '#4f46e5' }],
      metrics: [{ label: '峰值', expr: 'p.A', unit: '' }],
      insight: '草稿公式是 A·sin(k·x)。把它替换成目标概念的真实关系，就得到一个新沙盒。',
      challenges: [{ text: '把振幅 A 调到 3 以上', expr: 'p.A >= 3' }]
    };
  }

  TTK.dsl = {
    palette: palette,
    example: example,
    validate: validate,
    validateResult: validateResult,
    compile: compile,
    prompt: prompt,
    draft: draft,
    blank: function () { return JSON.parse(JSON.stringify(example)); }
  };
})(window);
