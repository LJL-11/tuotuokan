/* 拖拖看 · 概念模板库
 * ---------------------------------------------------------------
 * 每个模板 = 参数声明 + 关系/模型 + 可观测指标 + 引导挑战。
 * 新增一个学科概念只需在这里 register 一条，不用改引擎和渲染器。
 * 模板产出统一 schema，因此「热门学科精修模板 + 长尾 AI 生成」可以共用同一套运行时。
 */
(function (global) {
  'use strict';

  var TTK = global.TTK = global.TTK || {};
  var C = TTK.colors;

  function metric(label, value, unit, digits, tone, hint) {
    return { label: label, value: value, unit: unit || '', digits: digits === undefined ? 2 : digits, tone: tone || 'plain', hint: hint || '' };
  }

  function zeros(n, m) {
    return Array.from({ length: n }, function () { return new Array(m).fill(0); });
  }

  function line(name, points, color, style, width) {
    return { name: name, points: points, color: color, style: style || 'line', width: width || 2 };
  }

  /* ============ 1. 机器学习：过拟合与正则化 ============ */
  var overfit = {
    id: 'overfit',
    name: '过拟合与正则化',
    subject: '机器学习',
    icon: '∿',
    level: '核心概念',
    keywords: ['过拟合', '正则化', '泛化', '多项式', '岭回归', '欠拟合', '训练误差', '测试误差', 'overfit', 'regularization'],
    brief: '模型是在学规律，还是在背噪声？拖一拖就知道了。',
    concept: '用带噪声的少量样本去拟合一条真实曲线。阶数决定模型有多「能记」，正则化惩罚复杂系数，数据量决定噪声能被平均掉多少。观察训练误差与测试误差何时分道扬镳。',
    params: [
      { key: 'degree', label: '多项式阶数', min: 1, max: 12, step: 1, default: 8, unit: '阶', hint: '模型容量：越高越能贴合每个样本' },
      { key: 'logLam', label: '正则化强度 10^k', min: -6, max: 0, step: 0.1, default: -4.5, unit: '', hint: 'k 越小惩罚越弱，越容易过拟合', format: function (v) { return '10^' + Number(v).toFixed(1); } },
      { key: 'noise', label: '数据噪声 σ', min: 0, max: 0.6, step: 0.01, default: 0.25, unit: '', hint: '真实观测里躲不掉的随机误差' },
      { key: 'n', label: '训练样本数', min: 10, max: 120, step: 5, default: 25, unit: '个', hint: '数据本身就是最好的正则化' }
    ],
    prerequisites: ['gradient'],
    compute: function (p, M) {
      var d = Math.round(p.degree), lam = Math.pow(10, p.logLam), n = Math.round(p.n);
      var rand = M.rng(20261106);
      function truth(x) { return Math.sin(2 * Math.PI * x) * 0.8 + 0.3 * x; }
      // 基函数取 t = 2x-1 ∈ [-1,1]：高阶项才具备振荡能力，过拟合才看得见
      function features(x, deg) {
        var t = 2 * x - 1, row = [], k;
        for (k = 0; k <= deg; k++) row.push(Math.pow(t, k));
        return row;
      }
      var train = M.linspace(0, 1, n).map(function (x) {
        var xx = M.clamp(x + (rand() - 0.5) * 0.008, 0, 1);
        return [xx, truth(xx) + M.gaussian(rand) * p.noise];
      });
      // 测试集同样带噪（独立种子）：否则训练误差天然含噪声，泛化差距会恒为负
      var testRand = M.rng(90210);
      var test = M.linspace(0, 1, 200).map(function (x) {
        return [x, truth(x) + M.gaussian(testRand) * p.noise];
      });

      function fitRidge(deg, lambda) {
        var dim = deg + 1;
        var A = zeros(dim, dim), b = new Array(dim).fill(0), i, j;
        train.forEach(function (t) {
          var f = features(t[0], deg);
          for (i = 0; i < dim; i++) {
            b[i] += f[i] * t[1];
            for (j = 0; j < dim; j++) A[i][j] += f[i] * f[j];
          }
        });
        // 按矩阵自身尺度归一化：λ 就是相对惩罚强度，不受样本数与阶数影响
        var scale = 0;
        for (i = 0; i < dim; i++) scale += A[i][i];
        scale = scale / dim || 1;
        for (i = 1; i < dim; i++) A[i][i] += lambda * scale + 1e-10; // 偏置项不惩罚
        A[0][0] += 1e-10;
        var w = M.solve(A, b);
        return function (x) {
          var f = features(x, deg), s = 0;
          for (var k = 0; k < dim; k++) s += f[k] * w[k];
          return isFinite(s) ? M.clamp(s, -8, 8) : 0;
        };
      }

      var fit = fitRidge(d, lam);
      var grid = M.linspace(0, 1, 160);
      var truthPts = grid.map(function (x) { return [x, truth(x)]; });
      var fitPts = grid.map(function (x) { return [x, fit(x)]; });
      var trainPts = train.map(function (t) { return [t[0], t[1]]; });

      var trainMSE = train.reduce(function (s, t) { return s + Math.pow(fit(t[0]) - t[1], 2); }, 0) / n;
      var testMSE = test.reduce(function (s, t) { return s + Math.pow(fit(t[0]) - t[1], 2); }, 0) / test.length;
      var gap = testMSE - trainMSE;
      // 去掉噪声后的真实偏差：用来画「复杂度—泛化」的 U 型曲线
      function cleanError(fn) {
        return grid.reduce(function (s, x) { return s + Math.pow(fn(x) - truth(x), 2); }, 0) / grid.length;
      }
      var cleanMSE = cleanError(fit);

      // 扫描阶数：让 U 型误差曲线可见，当前阶数用标记点标出
      var sweep = [];
      for (var deg = 1; deg <= 12; deg++) {
        sweep.push([deg, Math.min(cleanError(fitRidge(deg, lam)), 3)]);
      }

      var m = { trainMSE: trainMSE, testMSE: testMSE, gap: gap, cleanMSE: cleanMSE };
      var insight;
      if (gap > 0.08) insight = '训练误差很低、测试误差却高：曲线在拼命穿过每一个噪声点。这就是过拟合——降低阶数、加大正则化，或者干脆多给点数据。';
      else if (trainMSE > 0.18 && testMSE > 0.18) insight = '模型连训练集都拟合不好，属于欠拟合。提高阶数或减弱正则化，让它有能力表达这条曲线。';
      else insight = '两条误差挨得很近，模型抓到的是规律而不是噪声。注意第二张图：复杂度不是越高越好，测试误差是一条 U 型曲线。';

      return {
        m: m,
        insight: insight,
        metrics: [
          metric('训练 MSE', trainMSE, '', 3, 'plain', '模型在见过的样本上的误差'),
          metric('测试 MSE', testMSE, '', 3, testMSE > 0.12 ? 'bad' : testMSE > 0.05 ? 'warn' : 'good', '换一批数据后的真实表现'),
          metric('泛化差距', gap, '', 3, gap > 0.08 ? 'bad' : gap > 0.05 ? 'warn' : 'good', '两者之差，过拟合的体温计'),
          metric('对真值偏差', cleanMSE, '', 3, cleanMSE > 0.1 ? 'bad' : cleanMSE > 0.05 ? 'warn' : 'good', '去掉噪声后，模型离真实规律多远'),
          metric('模型自由度', d + 1, '个', 0, 'plain', '可学习系数个数')
        ],
        chart: {
          panels: [
            {
              title: '① 模型拟合：真值 / 拟合曲线 / 训练样本',
              xLabel: 'x', yLabel: 'f(x)',
              xDomain: [0, 1], yDomain: [-1.5, 1.8],
              series: [
                line('真实规律', truthPts, C.slate, 'dashed', 1.6),
                line('模型拟合', fitPts, C.indigo, 'line', 2.4),
                line('训练样本', trainPts, C.coral, 'scatter', 3)
              ]
            },
            {
              title: '② 复杂度扫描：对真值偏差的 U 型曲线（红点为当前阶数）',
              xLabel: '多项式阶数', yLabel: '偏差 MSE',
              xDomain: [1, 12], yDomain: [0, Math.max(0.25, Math.min(2, Math.max.apply(null, sweep.map(function (q) { return q[1]; })) * 1.1))],
              series: [line('对真值偏差', sweep, C.teal, 'line', 2.2)],
              markers: [{ x: d, y: Math.min(cleanMSE, 3), label: '当前 d=' + d, color: C.coral }],
              guides: [{ axis: 'x', value: d, label: '', color: '#cbd5e1' }]
            }
          ]
        }
      };
    },
    challenges: [
      { text: '把阶数调到 ≥10、正则化调到 10^-4 以下，让泛化差距超过 0.09', check: function (p, m) { return p.degree >= 10 && p.logLam <= -4 && m.gap > 0.09; } },
      { text: '保持高阶数，用正则化把泛化差距压回 0.065 以内', check: function (p, m) { return p.degree >= 8 && p.logLam >= -1.5 && m.gap < 0.065; } }
    ]
  };

  /* ============ 2. 机器学习 / 数学：梯度下降 ============ */
  var gradient = {
    id: 'gradient',
    name: '梯度下降与学习率',
    subject: '机器学习',
    icon: '↓',
    level: '核心概念',
    keywords: ['梯度下降', '学习率', '动量', '收敛', '局部最优', '优化', 'gradient', 'loss', '损失函数'],
    brief: '为什么步长太大反而学不会？看着小球在损失地形上滚。',
    concept: '损失函数是一个有高有低的地形，梯度告诉你哪边是下坡。学习率决定一步迈多大，动量让小球带着惯性冲过小坑。起点不同，最后落进的谷也可能不同。',
    params: [
      { key: 'lr', label: '学习率 η', min: 0.001, max: 0.6, step: 0.001, default: 0.03, unit: '', hint: '每一步沿梯度走多远' },
      { key: 'momentum', label: '动量 β', min: 0, max: 0.95, step: 0.01, default: 0, unit: '', hint: '保留多少上一步的速度' },
      { key: 'x0', label: '起点 x₀', min: -2, max: 2, step: 0.1, default: -1.9, unit: '', hint: '非凸地形里，起点决定归宿' },
      { key: 'steps', label: '迭代步数', min: 5, max: 120, step: 5, default: 40, unit: '步', hint: '给它多少时间收敛' }
    ],
    prerequisites: ['oscillation'],
    compute: function (p, M) {
      function f(x) { return Math.pow(x, 4) - 3 * x * x + 0.5 * x; }
      function df(x) { return 4 * Math.pow(x, 3) - 6 * x + 0.5; }
      var x = p.x0, v = 0, steps = Math.round(p.steps), i;
      var path = [[x, f(x)]], losses = [[0, f(x)]], maxJump = 0, diverged = false;
      for (i = 1; i <= steps; i++) {
        v = p.momentum * v - p.lr * df(x);
        var nx = x + v;
        maxJump = Math.max(maxJump, Math.abs(nx - x));
        x = nx;
        if (!isFinite(x) || Math.abs(x) > 2.6) { diverged = true; break; }
        path.push([x, f(x)]);
        losses.push([i, f(x)]);
      }
      var finalLoss = f(M.clamp(x, -2.2, 2.2));
      var converged = !diverged && Math.abs(df(x)) < 0.08;
      var terrain = M.linspace(-2.2, 2.2, 180).map(function (t) { return [t, f(t)]; });
      var globalMin = Math.min.apply(null, terrain.map(function (q) { return q[1]; }));

      var m = { finalLoss: finalLoss, finalX: x, converged: converged, diverged: diverged, maxJump: maxJump };
      var insight;
      if (diverged) insight = '步子太大，参数直接被甩出地形了：梯度在远处变得极陡，下一步更远，形成正反馈。把 η 调小再看。';
      else if (converged) insight = '小球停在了谷底，梯度接近 0。把 x₀ 拖到另一侧试试：同一个算法、同一个损失，可能收敛到完全不同的谷。';
      else insight = '还没停稳。增加迭代步数、微降学习率，或加一点动量帮它翻过小坡——但动量太大又会在谷底来回震荡。';

      return {
        m: m,
        insight: insight,
        metrics: [
          metric('最终损失', finalLoss, '', 3, converged ? 'good' : diverged ? 'bad' : 'warn', '越低越好'),
          metric('最终位置', x, '', 3, 'plain', '收敛到哪个谷'),
          metric('状态', diverged ? '发散' : converged ? '已收敛' : '未收敛', '', 0, diverged ? 'bad' : converged ? 'good' : 'warn', '看梯度是否接近 0'),
          metric('最大单步位移', maxJump, '', 3, maxJump > 1 ? 'bad' : 'plain', '越大越不稳定')
        ],
        chart: {
          panels: [
            {
              title: '① 损失地形上的下降轨迹',
              xLabel: '参数 x', yLabel: '损失 f(x)',
              xDomain: [-2.2, 2.2],
              series: [
                line('损失地形', terrain, C.slate, 'dashed', 1.6),
                line('下降路径', path, C.indigo, 'line', 2.2),
                line('迭代位置', path, C.coral, 'scatter', 2.6)
              ],
              markers: [
                { x: p.x0, y: f(p.x0), label: '起点', color: C.amber },
                !diverged ? { x: x, y: f(x), label: '终点', color: C.teal } : null
              ].filter(Boolean)
            },
            {
              title: '② 损失随迭代步数的变化',
              xLabel: '迭代步数', yLabel: 'f(x)',
              yDomain: [globalMin - 0.6, Math.max(4, Math.max.apply(null, losses.map(function (q) { return q[1]; })) + 0.5)],
              series: [line('训练损失', losses, C.teal, 'line', 2.2)],
              guides: [{ axis: 'y', value: globalMin, label: '全局最优', color: C.slate }]
            }
          ]
        }
      };
    },
    challenges: [
      { text: '把学习率调到 0.4 以上，让优化发散', check: function (p, m) { return p.lr >= 0.4 && m.diverged; } },
      { text: '从 x₀ = -1.9 出发，让损失收敛到 -2.5 以下', check: function (p, m) { return m.converged && m.finalLoss < -2.5; } }
    ]
  };

  /* ============ 3. 经济：供需均衡 ============ */
  var supplyDemand = {
    id: 'supply',
    name: '供需均衡与税收',
    subject: '经济学',
    icon: '×',
    level: '入门',
    keywords: ['供需', '供给', '需求', '均衡', '价格', '税收', '弹性', '消费者剩余', '生产者剩余', 'equilibrium'],
    brief: '价格不是谁定的，是两条曲线自己撞出来的。',
    concept: '需求随价格上升而减少，供给随价格上升而增加，交点就是市场自发形成的均衡。加税相当于把供给曲线整体抬高，新的交点价格更高、数量更少——多出来的负担由买卖双方按弹性分摊。',
    params: [
      { key: 'a', label: '需求截距 a', min: 40, max: 140, step: 2, default: 100, unit: '', hint: '价格为 0 时想买多少' },
      { key: 'b', label: '需求斜率 b', min: 0.2, max: 2.5, step: 0.05, default: 1, unit: '', hint: '越小=需求越刚性' },
      { key: 'c', label: '供给截距 c', min: 0, max: 40, step: 1, default: 10, unit: '', hint: '价格为 0 时愿意供多少' },
      { key: 'd', label: '供给斜率 d', min: 0.2, max: 2.5, step: 0.05, default: 1, unit: '', hint: '越小=供给越有弹性' },
      { key: 'tax', label: '单位税 / 补贴 t', min: -20, max: 30, step: 1, default: 0, unit: '元', hint: '正数为税，负数为补贴' }
    ],
    prerequisites: [],
    compute: function (p, M) {
      // 需求 Q = a - b·P ；供给 Q = c + d·(P - t)
      var pStar = (p.a - p.c + p.d * p.tax) / (p.b + p.d);
      var qStar = Math.max(0, p.a - p.b * pStar);
      var pCeil = p.a / p.b;                 // 需求归零价格
      var pFloor = p.c / p.d - p.tax;        // 供给启动价格
      var cs = Math.max(0, 0.5 * (pCeil - pStar) * qStar);
      var ps = Math.max(0, 0.5 * (pStar - pFloor) * qStar);
      var revenue = p.tax * qStar;
      var qMax = Math.max(p.a * 1.05, qStar * 1.3, 10);
      var pMax = Math.max(pCeil * 1.1, pStar * 1.2, 10);
      var qs = M.linspace(0, qMax, 80);
      var demand = qs.map(function (q) { return [q, (p.a - q) / p.b]; });
      var supply = qs.map(function (q) { return [q, p.c / p.d + q / p.d + p.tax]; });
      var m = { pStar: pStar, qStar: qStar, cs: cs, ps: ps, revenue: revenue, pCeil: pCeil };
      var insight;
      if (p.tax > 3) insight = '征税把供给曲线抬高，均衡价格上升、成交数量下降。差额被谁吃掉？看下方两根柱子：需求越刚性（b 小），买方承担得越多。';
      else if (p.tax < -3) insight = '补贴相当于负的税收：价格更低、成交更多，但政府要付出补贴成本。把它拖回正数对比一下。';
      else insight = '两条线的交点就是市场自己找到的价格，没有任何人「定价」。试着移动任一截距或斜率，看交点怎么跑。';

      return {
        m: m,
        insight: insight,
        metrics: [
          metric('均衡价格', pStar, '元', 2, 'good', '供需相交处'),
          metric('均衡数量', qStar, '件', 1, 'plain', '实际成交量'),
          metric('消费者剩余', cs, '', 0, 'plain', '买方省下的钱'),
          metric('生产者剩余', ps, '', 0, 'plain', '卖方多赚的钱'),
          metric('政府净收入', revenue, '元', 0, revenue > 0 ? 'warn' : 'plain', '负数表示补贴支出')
        ],
        chart: {
          panels: [
            {
              title: '① 供需曲线与均衡点（纵轴价格 / 横轴数量）',
              xLabel: '数量 Q', yLabel: '价格 P',
              xDomain: [0, qMax], yDomain: [0, pMax],
              series: [
                line('需求', demand, C.indigo, 'line', 2.2),
                line('供给', supply, C.teal, 'line', 2.2)
              ],
              markers: [{ x: qStar, y: pStar, label: '均衡 (' + M.fmt(pStar, 1) + ', ' + M.fmt(qStar, 0) + ')', color: C.coral }],
              guides: [
                { axis: 'y', value: pStar, label: 'P*', color: C.slate },
                { axis: 'x', value: qStar, label: 'Q*', color: C.slate }
              ]
            },
            {
              title: '② 福利分配：谁拿走了多少',
              xLabel: '', yLabel: '金额',
              xDomain: [0, 3],
              series: [
                { name: '消费者剩余', points: [[0.6, cs]], color: C.indigo, style: 'bar', width: 2 },
                { name: '生产者剩余', points: [[1.5, ps]], color: C.teal, style: 'bar', width: 2 },
                { name: '政府净收入', points: [[2.4, Math.abs(revenue)]], color: C.amber, style: 'bar', width: 2 }
              ]
            }
          ]
        }
      };
    },
    challenges: [
      { text: '把单位税调到 15 以上，观察均衡数量下降与政府收入出现', check: function (p, m) { return p.tax >= 15 && m.revenue > 0; } },
      { text: '把需求斜率调到 0.5 以下并保持征税，看消费者剩余怎么变', check: function (p, m) { return p.b <= 0.5 && p.tax >= 10; } }
    ]
  };

  /* ============ 4. 物理：抛体运动 ============ */
  var projectile = {
    id: 'projectile',
    name: '抛体运动与阻力',
    subject: '物理学',
    icon: '⌒',
    level: '入门',
    keywords: ['抛体', '抛物线', '射程', '重力', '空气阻力', '初速度', '角度', 'projectile', '运动'],
    brief: '45° 一定扔得最远吗？把空气阻力打开就不一定了。',
    concept: '竖直方向被重力拉回来，水平方向匀速前进，两者合成一条抛物线。加上与速度平方成正比的空气阻力后，轨迹不再对称，最优发射角也会小于 45°。',
    params: [
      { key: 'v0', label: '初速度 v₀', min: 5, max: 40, step: 1, default: 22, unit: 'm/s', hint: '出手那一刻有多快' },
      { key: 'angle', label: '发射角 θ', min: 5, max: 85, step: 1, default: 45, unit: '°', hint: '无阻力时 45° 射程最大' },
      { key: 'g', label: '重力加速度 g', min: 1, max: 20, step: 0.1, default: 9.8, unit: 'm/s²', hint: '调到 1.6 就是月球' },
      { key: 'drag', label: '空气阻力 k', min: 0, max: 0.12, step: 0.002, default: 0, unit: '', hint: '与速度平方成正比' }
    ],
    prerequisites: ['oscillation'],
    compute: function (p, M) {
      var rad = p.angle * Math.PI / 180;
      var dt = 0.008, x = 0, y = 0, t = 0;
      var vx = p.v0 * Math.cos(rad), vy = p.v0 * Math.sin(rad);
      var traj = [[0, 0]], vel = [[0, vx], [0, vy]], maxH = 0, apexX = 0, i;
      for (i = 0; i < 4000; i++) {
        var speed = Math.sqrt(vx * vx + vy * vy);
        var ax = -p.drag * vx * speed;
        var ay = -p.g - p.drag * vy * speed;
        vx += ax * dt; vy += ay * dt;
        x += vx * dt; y += vy * dt; t += dt;
        if (y > maxH) { maxH = y; apexX = x; }
        if (y < 0) break;
        traj.push([x, Math.max(0, y)]);
        if (i % 5 === 0) { vel.push([t, vx]); vel.push([t, vy]); }
      }
      var range = x, flight = t, landingSpeed = Math.sqrt(vx * vx + vy * vy);
      var idealR = p.v0 * p.v0 * Math.sin(2 * rad) / p.g;
      var ideal = M.linspace(0, Math.max(idealR, range) * 1.05, 90).map(function (xx) {
        return [xx, Math.max(0, xx * Math.tan(rad) - p.g * xx * xx / (2 * p.v0 * p.v0 * Math.cos(rad) * Math.cos(rad)))];
      });
      // 速度分量拆成两条独立曲线
      var vxPts = [], vyPts = [];
      for (i = 0; i < vel.length; i += 2) {
        if (vel[i]) vxPts.push([vel[i][0], vel[i][1]]);
        if (vel[i + 1]) vyPts.push([vel[i + 1][0], vel[i + 1][1]]);
      }
      var m = { range: range, maxH: maxH, flight: flight, landingSpeed: landingSpeed, idealR: idealR };
      var insight;
      if (p.drag > 0.02) insight = '虚线是无阻力的理想抛物线，实线明显被「压短、压陡」了：阻力在上升段和下降段都吃掉速度，下降段比上升段更陡。';
      else if (p.g < 4) insight = '重力变小，物体滞空时间成倍变长，射程几乎按 1/g 放大。同样的力气，在月球上能扔出六倍远。';
      else insight = '无阻力时理论射程 v₀²sin(2θ)/g，45° 最大。把角度拖离 45°，看射程怎么缩；再打开一点点阻力，看最优角度往哪边偏。';

      return {
        m: m,
        insight: insight,
        metrics: [
          metric('射程', range, 'm', 1, 'good', '落地点水平距离'),
          metric('最大高度', maxH, 'm', 1, 'plain', '轨迹顶点'),
          metric('飞行时间', flight, 's', 2, 'plain', '滞空多久'),
          metric('落地速度', landingSpeed, 'm/s', 1, 'plain', '阻力越大损失越多'),
          metric('理论射程(无阻力)', idealR, 'm', 1, 'plain', '用于对比')
        ],
        chart: {
          panels: [
            {
              title: '① 飞行轨迹（虚线为无阻力理论值）',
              xLabel: '水平距离 (m)', yLabel: '高度 (m)',
              yDomain: [0, Math.max(2, maxH * 1.2)],
              series: [
                line('理论轨迹', ideal, C.slate, 'dashed', 1.6),
                line('实际轨迹', traj, C.indigo, 'line', 2.4)
              ],
              markers: [
                { x: apexX, y: maxH, label: '最高点', color: C.amber },
                { x: range, y: 0, label: '落点 ' + M.fmt(range, 1) + 'm', color: C.coral }
              ],
              guides: [{ axis: 'y', value: 0, label: '', color: '#cbd5e1' }]
            },
            {
              title: '② 速度分量随时间变化',
              xLabel: '时间 (s)', yLabel: '速度 (m/s)',
              series: [
                line('水平 vₓ', vxPts, C.teal, 'line', 1.8),
                line('竖直 vᵧ', vyPts, C.coral, 'line', 1.8)
              ],
              guides: [{ axis: 'y', value: 0, label: 'v=0', color: C.slate }]
            }
          ]
        }
      };
    },
    challenges: [
      { text: '把重力调到 3 以下，看射程翻几倍', check: function (p, m) { return p.g <= 3; } },
      { text: '把空气阻力调到 0.06 以上，让实线明显偏离理论虚线', check: function (p, m) { return p.drag >= 0.06; } }
    ]
  };

  /* ============ 5. 物理：单摆与阻尼振动 ============ */
  var oscillation = {
    id: 'oscillation',
    name: '单摆与阻尼振动',
    subject: '物理学',
    icon: '~',
    level: '进阶',
    keywords: ['单摆', '振动', '阻尼', '周期', '相图', '非线性', '摆长', 'oscillation', 'pendulum'],
    brief: '摆得越大，周期还一样吗？相图会告诉你答案。',
    concept: '小角度下周期只由摆长和重力决定，与振幅无关；但角度一大，sinθ 的非线性就让周期变长。阻尼几乎只改振幅、不改周期——这两件事在时域曲线和相图上表现得非常清楚。',
    params: [
      { key: 'L', label: '摆长 L', min: 0.2, max: 3, step: 0.05, default: 1, unit: 'm', hint: '越长摆得越慢' },
      { key: 'damp', label: '阻尼 γ', min: 0, max: 1.5, step: 0.02, default: 0.2, unit: '', hint: '0 表示永不衰减' },
      { key: 'theta0', label: '初始摆角 θ₀', min: 5, max: 80, step: 1, default: 35, unit: '°', hint: '大角度会暴露非线性' },
      { key: 'g', label: '重力 g', min: 1, max: 20, step: 0.1, default: 9.8, unit: 'm/s²', hint: '越大回摆越快' }
    ],
    prerequisites: [],
    compute: function (p, M) {
      var dt = 0.01, T = 14, y = [p.theta0 * Math.PI / 180, 0], t = 0;
      var f = function (_, s) { return [s[1], -(p.g / p.L) * Math.sin(s[0]) - p.damp * s[1]]; };
      var series = [], phase = [], peaks = [], prev, prev2;
      for (var i = 0; i <= T / dt; i++) {
        var deg = y[0] * 180 / Math.PI;
        series.push([t, deg]);
        phase.push([deg, y[1]]);
        if (prev2 !== undefined && prev > prev2 && prev >= deg && prev > 1) peaks.push(t - dt);
        prev2 = prev; prev = deg;
        y = M.rk4(f, t, y, dt);
        t += dt;
      }
      var theoryT = 2 * Math.PI * Math.sqrt(p.L / p.g);
      var measuredT = peaks.length >= 2 ? (peaks[peaks.length - 1] - peaks[0]) / (peaks.length - 1) : NaN;
      var endAmp = Math.abs(series[series.length - 1][1]);
      var ampRatio = p.damp > 0 ? Math.exp(-p.damp * T / 2) : 1;
      var env1 = series.map(function (q) { return [q[0], p.theta0 * Math.exp(-p.damp * q[0] / 2)]; });
      var env2 = series.map(function (q) { return [q[0], -p.theta0 * Math.exp(-p.damp * q[0] / 2)]; });
      var m = { theoryT: theoryT, measuredT: measuredT, ampRatio: ampRatio, endAmp: endAmp, ratio: isFinite(measuredT) ? measuredT / theoryT : 1 };
      var insight;
      if (p.theta0 >= 60) insight = '摆角一大，实测周期明显长于 2π√(L/g)：回复力是 sinθ 而不是 θ，摆到远处「拉回来」的力比线性预测更弱。';
      else if (p.damp === 0) insight = '阻尼归零，振幅不再衰减，相图闭合成一个环——能量守恒。加一点阻尼，环就会一圈圈向原点收缩。';
      else insight = '虚线是振幅包络 e^(-γt/2)：阻尼只让振幅缩小，几乎不动周期。把摆长拉长，看周期按 √L 变慢。';

      return {
        m: m,
        insight: insight,
        metrics: [
          metric('小角理论周期', theoryT, 's', 2, 'plain', '2π√(L/g)'),
          metric('实测周期', measuredT, 's', 2, 'plain', '由峰值间隔算出'),
          metric('周期偏差', (m.ratio - 1) * 100, '%', 1, Math.abs(m.ratio - 1) > 0.05 ? 'warn' : 'good', '大角度非线性造成'),
          metric('14s 后振幅比', ampRatio * 100, '%', 1, 'plain', '按衰减包络估算'),
          metric('末态振幅', endAmp, '°', 2, 'plain', '还剩多少摆幅')
        ],
        chart: {
          panels: [
            {
              title: '① 摆角随时间变化（虚线为衰减包络）',
              xLabel: '时间 (s)', yLabel: '摆角 (°)',
              xDomain: [0, T],
              series: [
                line('上包络', env1, C.slate, 'dashed', 1.2),
                line('下包络', env2, C.slate, 'dashed', 1.2),
                line('摆角 θ(t)', series, C.indigo, 'line', 2)
              ],
              guides: [{ axis: 'y', value: 0, label: '平衡位置', color: C.slate }]
            },
            {
              title: '② 相图：角度 × 角速度',
              xLabel: '摆角 (°)', yLabel: '角速度 (rad/s)',
              series: [line('相轨迹', phase, C.violet, 'line', 1.6)]
            }
          ]
        }
      };
    },
    challenges: [
      { text: '把阻尼归零，观察相图从螺旋变成闭合环', check: function (p, m) { return p.damp === 0; } },
      { text: '把初始摆角调到 70° 以上，看实测周期比理论长多少', check: function (p, m) { return p.theta0 >= 70; } }
    ]
  };

  /* ============ 6. 生物 / 数学：SIR 传染病模型 ============ */
  var epidemic = {
    id: 'epidemic',
    name: 'SIR 与传播阈值',
    subject: '生物 / 数学',
    icon: '◕',
    level: '进阶',
    keywords: ['传染病', 'SIR', 'R0', '再生数', '群体免疫', '疫情', '峰值', '传播', 'epidemic', '感染'],
    brief: '为什么 R₀ 差一点点，结果会差很多？',
    concept: '人群分成易感 S、感染 I、康复 R 三类，每天有人从 S 流到 I、再从 I 流到 R。基本再生数 R₀=β/γ 决定疫情会不会起飞；当易感者被消耗到 1/R₀ 以下，感染人数自然见顶——这就是群体免疫阈值。',
    params: [
      { key: 'beta', label: '传染率 β', min: 0.05, max: 1.2, step: 0.01, default: 0.35, unit: '/天', hint: '一个感染者每天能传多少人' },
      { key: 'gamma', label: '康复率 γ', min: 0.02, max: 0.8, step: 0.01, default: 0.12, unit: '/天', hint: '倒数≈平均传染期' },
      { key: 'i0', label: '初始感染比例', min: 0.001, max: 0.2, step: 0.001, default: 0.01, unit: '', hint: '一开始有多少人中招' },
      { key: 'days', label: '观察天数', min: 30, max: 200, step: 10, default: 120, unit: '天', hint: '把时间轴拉长看全貌' }
    ],
    prerequisites: ['gradient'],
    compute: function (p, M) {
      var dt = 0.2, steps = Math.round(p.days / dt);
      var f = function (_, s) {
        var inf = p.beta * s[0] * s[1];
        return [-inf, inf - p.gamma * s[1], p.gamma * s[1]];
      };
      var y = [1 - p.i0, p.i0, 0], t = 0;
      var S = [], I = [], R = [], peakI = 0, peakDay = 0;
      for (var i = 0; i <= steps; i++) {
        S.push([t, y[0]]); I.push([t, y[1]]); R.push([t, y[2]]);
        if (y[1] > peakI) { peakI = y[1]; peakDay = t; }
        y = M.rk4(f, t, y, dt);
        t += dt;
      }
      var R0 = p.beta / p.gamma;
      var herd = R0 > 1 ? 1 - 1 / R0 : 0;
      var finalR = y[2];

      // R₀ 扫描：展示阈值效应（当前 R₀ 用红点标出）
      function finalSize(beta) {
        var s = [1 - p.i0, p.i0, 0], tt = 0;
        var fn = function (_, v) {
          var inf2 = beta * v[0] * v[1];
          return [-inf2, inf2 - p.gamma * v[1], p.gamma * v[1]];
        };
        for (var k = 0; k < 900; k++) { s = M.rk4(fn, tt, s, 0.5); tt += 0.5; }
        return s[2];
      }
      var sweep = [], b;
      for (b = 0.1; b <= 8.01; b += 0.25) sweep.push([b, finalSize(b)]);
      var currentFinal = finalSize(p.beta);

      var m = { R0: R0, peakI: peakI, peakDay: peakDay, finalR: finalR, herd: herd, currentFinal: currentFinal };
      var insight;
      if (R0 <= 1) insight = 'R₀ ≤ 1：每个感染者平均传不到一个人，I 曲线从一开始就往下走，疫情起不来。把 β 稍微调大跨过 1，看曲线形状怎么突变。';
      else if (R0 >= 4) insight = 'R₀ 很大，峰值又高又早。注意最终感染比例并不会到 100%——易感者被消耗到 1/R₀ 以下时，传播链自己就断了。';
      else insight = '感染人数先升后降，峰值出现在易感者比例跌破 1/R₀ 的时刻。第二张图能看到 R₀ 与最终规模的非线性关系。';

      return {
        m: m,
        insight: insight,
        metrics: [
          metric('基本再生数 R₀', R0, '', 2, R0 > 1 ? 'warn' : 'good', 'β / γ'),
          metric('峰值感染比例', peakI * 100, '%', 1, peakI > 0.3 ? 'bad' : 'plain', '医疗压力的来源'),
          metric('达峰天数', peakDay, '天', 1, 'plain', '峰值来得有多快'),
          metric('最终感染比例', finalR * 100, '%', 1, 'plain', '累计被感染的人'),
          metric('群体免疫阈值', herd * 100, '%', 1, 'plain', '1 - 1/R₀')
        ],
        chart: {
          panels: [
            {
              title: '① S / I / R 人群比例随时间变化',
              xLabel: '时间 (天)', yLabel: '人群比例',
              xDomain: [0, p.days], yDomain: [0, 1.05],
              series: [
                line('易感 S', S, C.indigo, 'line', 2),
                line('感染 I', I, C.coral, 'line', 2.4),
                line('康复 R', R, C.teal, 'line', 2)
              ],
              markers: [{ x: peakDay, y: peakI, label: '峰值', color: C.coral }],
              guides: R0 > 1 ? [{ axis: 'y', value: herd, label: '1-1/R₀', color: C.amber }] : []
            },
            {
              title: '② R₀ 扫描：跨过 1 之后，最终感染规模如何跳变',
              xLabel: '基本再生数 R₀', yLabel: '最终感染比例',
              xDomain: [0, 8], yDomain: [0, 1.05],
              series: [line('最终感染比例', sweep, C.teal, 'line', 2.2)],
              markers: [{ x: Math.min(R0, 8), y: currentFinal, label: '当前 R₀', color: C.coral }],
              guides: [{ axis: 'x', value: 1, label: 'R₀ = 1 阈值', color: C.amber }]
            }
          ]
        }
      };
    },
    challenges: [
      { text: '把 β/γ 调到 1 以下，让疫情不再爆发', check: function (p, m) { return m.R0 < 1; } },
      { text: '把 R₀ 调到 4 以上，让峰值感染超过 30%', check: function (p, m) { return m.R0 >= 4 && m.peakI > 0.3; } }
    ]
  };

  TTK.templates = [overfit, gradient, supplyDemand, projectile, oscillation, epidemic];
})(window);
