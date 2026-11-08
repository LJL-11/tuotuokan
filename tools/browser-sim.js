#!/usr/bin/env node
'use strict';
/* #I9 真实 Canvas 验收（headless Edge/Chrome + CDP，零依赖）
 * 运行：npm run check:browser
 *
 * Node 桩验证不了「画面真的在动」——Renderer 被替换成空实现。
 * 这里用真实浏览器打开 file://index.html，直接读 canvas 的像素哈希：
 *   播放时哈希必须变化、暂停后哈希必须静止、调速后 t 推进成比例、
 *   静态概念不显示控制条、播放过程不污染引擎重算与学习轨迹。
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var spawn = require('child_process').spawn;

var ROOT = path.resolve(__dirname, '..');
var PAGE = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
var CDP_PORT = 9400 + (process.pid % 200);

var pass = 0, fail = 0;
function ok(name, cond, detail) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (!cond && detail !== undefined ? '  :: ' + detail : ''));
  cond ? pass++ : fail++;
}
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function findBrowser() {
  var cands = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  for (var i = 0; i < cands.length; i++) if (fs.existsSync(cands[i])) return cands[i];
  return null;
}
function getJson(url) {
  return new Promise(function (resolve, reject) {
    http.get(url, function (res) {
      var b = '';
      res.on('data', function (c) { b += c; });
      res.on('end', function () { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
function waitPort(url, tries) {
  return getJson(url).catch(function (e) {
    if (tries <= 0) throw e;
    return wait(200).then(function () { return waitPort(url, tries - 1); });
  });
}

function CDP(ws) {
  var self = this;
  this._ws = ws;
  this.id = 0;
  this.pending = new Map();
  this.events = [];
  ws.addEventListener('message', function (m) {
    var msg = JSON.parse(m.data);
    if (msg.id && self.pending.has(msg.id)) {
      var h = self.pending.get(msg.id);
      self.pending.delete(msg.id);
      msg.error ? h.reject(new Error(msg.error.message)) : h.resolve(msg.result);
      return;
    }
    if (msg.method) self.events.push(msg);
  });
  this.ready = new Promise(function (res, rej) {
    ws.addEventListener('open', function () { res(); });
    ws.addEventListener('error', function () { rej(new Error('CDP 连接失败')); });
  });
}
CDP.prototype.send = function (method, params) {
  var self = this, id = ++this.id, ws = this._ws;
  return new Promise(function (resolve, reject) {
    self.pending.set(id, { resolve: resolve, reject: reject });
    ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    setTimeout(function () {
      if (self.pending.has(id)) { self.pending.delete(id); reject(new Error('CDP 超时：' + method)); }
    }, 15000);
  });
};
CDP.prototype.eval = async function (expression) {
  var r = await this.send('Runtime.evaluate', {
    expression: expression, awaitPromise: true, returnByValue: true, userGesture: true
  });
  if (r.exceptionDetails) {
    throw new Error('页面异常：' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description
      || r.exceptionDetails.text));
  }
  return r.result.value;
};

(async function main() {
  var exe = findBrowser();
  if (!exe) { console.log('未找到 Chrome/Edge，跳过真实 Canvas 验收'); process.exit(2); }

  var userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttk-simprof-'));
  var child = spawn(exe, [
    '--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + userDir, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-extensions', '--allow-file-access-from-files',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--window-size=1280,900', 'about:blank'
  ], { stdio: 'ignore' });
  var cleanup = function () { try { child.kill(); } catch (e) {} };

  try {
    console.log('真实 Canvas 验收（#I9）');
    console.log('  浏览器：' + path.basename(exe) + '（headless）');
    console.log('  页面：' + PAGE + '\n');

    var ver = await waitPort('http://127.0.0.1:' + CDP_PORT + '/json/version', 50);
    ok('headless 浏览器已启动', !!ver.Browser, JSON.stringify(ver.Browser));
    var list = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
    var page = list.filter(function (t) { return t.type === 'page'; })[0];
    var ws = new WebSocket(page.webSocketDebuggerUrl);
    var cdp = new CDP(ws);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    var loaded = new Promise(function (resolve) {
      var timer = setInterval(function () {
        if (cdp.events.some(function (e) { return e.method === 'Page.loadEventFired'; })) {
          clearInterval(timer); resolve();
        }
      }, 50);
      setTimeout(function () { clearInterval(timer); resolve(); }, 15000);
    });
    await cdp.send('Page.navigate', { url: PAGE });
    await loaded;
    await wait(500);

    // 页面内探针：直接读 canvas 像素，避免把大 base64 传回 Node
    await cdp.eval([
      'window.__simProbe = {',
      '  info: function () {',
      '    var c = document.getElementById("stage");',
      '    var ctx = c.getContext("2d");',
      '    var d = ctx.getImageData(0, 0, c.width, c.height).data;',
      '    var h = 2166136261 >>> 0, nonWhite = 0;',
      '    for (var i = 0; i < d.length; i += 16) {',
      '      h ^= d[i]; h = Math.imul(h, 16777619) >>> 0;',
      '      if (d[i] < 245 || d[i+1] < 245 || d[i+2] < 245) nonWhite++;',
      '    }',
      '    return { h: h >>> 0, nonWhite: nonWhite, w: c.width, hh: c.height };',
      '  },',
      '  state: function () { return TTK.sim.state(); },',
      '  revision: function () { return TTK.engine.revision; },',
      '  trail: function () { return TTK.data.trail().length; },',
      '  barHidden: function () { return document.getElementById("simBar").hidden; },',
      '  go: function (id) {',
      '    var el = document.querySelector(`#tplList .tpl-card[data-id="${id}"]`);',
      '    if (!el) return false; el.click(); return true;',
      '  }',
      '}; true'
    ].join('\n'));
    var probe = function (expr) { return cdp.eval('window.__simProbe.' + expr); };

    var boot = JSON.parse(await cdp.eval('JSON.stringify({' +
      'tpl:(document.getElementById("tplName")||{}).textContent||"",' +
      'simIds:TTK.sim.registered(),' +
      'bar:!!document.getElementById("simBar"),' +
      'canvas:document.getElementById("stage").width,' +
      'routes:TTK.views.routes().length})'));
    ok('file:// 打开完成、模拟能力已从模板元数据发现',
      boot.tpl.length > 0 && boot.canvas > 0 && boot.bar
      && boot.simIds.indexOf('oscillation') >= 0 && boot.simIds.indexOf('epidemic') >= 0,
      JSON.stringify(boot));

    // 1. 控制条只在可模拟概念下显示
    ok('点侧栏切到单摆', (await probe('go("oscillation")')) === true, '');
    await wait(250);
    var staticInfo = await probe('info()');
    ok('画布确实绘制了内容（非空白）', staticInfo.nonWhite > 50, JSON.stringify(staticInfo));
    ok('可模拟概念显示控制条', (await probe('barHidden()')) === false, '');
    ok('切到静态概念隐藏控制条', await (async function () {
      await probe('go("overfit")'); await wait(200);
      return (await probe('barHidden()')) === true;
    })(), '');

    // 2. 播放：像素必须随时间变化
    // 切概念的轨迹有 400ms 写盘节流，先等它落地再取基线
    await probe('go("oscillation")'); await wait(700);
    var revBefore = await probe('revision()');
    var trailBefore = await probe('trail()');
    var hStatic = (await probe('info()')).h;
    await cdp.eval('document.getElementById("simPlayBtn").click(); true');
    await wait(60);
    var frame0 = await probe('info()');
    var t0 = (await probe('state()')).t;
    await wait(700);
    var frame1 = await probe('info()');
    var st1 = await probe('state()');
    ok('点击播放后进入播放态且模拟时间推进', st1.playing === true && st1.t > t0,
      JSON.stringify({ t0: t0, t1: st1.t, playing: st1.playing }));
    ok('真实 Canvas 像素在播放中变化（不是静态贴图）', frame0.h !== frame1.h,
      'h=' + frame0.h + ' -> ' + frame1.h);
    ok('模拟帧视图与静态全曲线视图不同', hStatic !== frame1.h, '');
    ok('播放不触发引擎重算（revision 不变）', (await probe('revision()')) === revBefore, '');
    ok('播放不写学习轨迹', (await probe('trail()')) === trailBefore, '');

    // 3. 暂停：像素与状态都冻结
    await cdp.eval('document.getElementById("simPlayBtn").click(); true');
    await wait(200);
    var pauseA = await probe('info()');
    var tPause = (await probe('state()')).t;
    await wait(500);
    var pauseB = await probe('info()');
    var stPause = await probe('state()');
    ok('暂停时画面像素完全静止', pauseA.h === pauseB.h, 'h=' + pauseA.h + ' vs ' + pauseB.h);
    ok('暂停时模拟时间零漂移', stPause.t === tPause && stPause.playing === false,
      JSON.stringify({ before: tPause, after: stPause.t }));

    // 4. 调速：2× 与 1× 在同样墙钟时长下推进成比例
    async function measure(speed, ms) {
      await cdp.eval('document.getElementById("simResetBtn").click(); true');
      await cdp.eval('(function(){var s=document.getElementById("simSpeed");s.value="' + speed +
        '";s.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
      await cdp.eval('document.getElementById("simPlayBtn").click(); true');  // 播放
      await wait(ms);
      var t = (await probe('state()')).t;
      await cdp.eval('document.getElementById("simPlayBtn").click(); true');  // 暂停
      await wait(80);
      return t;
    }
    var t1x = await measure(1, 600);
    var t2x = await measure(2, 600);
    ok('调速生效：2× 推进约为 1× 的两倍',
      t1x > 0 && t2x > t1x * 1.45 && t2x < t1x * 2.8,
      '1× t=' + t1x.toFixed(3) + 's, 2× t=' + t2x.toFixed(3) + 's, 比值=' + (t2x / t1x).toFixed(2));

    // 5. 重置与静态概念回归
    await cdp.eval('document.getElementById("simResetBtn").click(); true');
    ok('重置回到 t=0', (await probe('state()')).t === 0, '');
    await probe('go("overfit")'); await wait(250);
    ok('切到静态概念自动停止模拟', (await probe('state()')).active === false, '');
    var staticA = (await probe('info()')).h;
    await wait(400);
    ok('静态概念画面不漂移', (await probe('info()')).h === staticA, '');

    var errs = cdp.events.filter(function (e) { return e.method === 'Runtime.exceptionThrown'; });
    ok('页面全程无未捕获异常', errs.length === 0,
      errs.length ? JSON.stringify(errs[0].params).slice(0, 240) : '');
  } catch (e) {
    ok('验收过程未抛异常', false, e && (e.stack || e.message));
  } finally {
    cleanup();
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) {}
    console.log('\n---------------------------------------------');
    console.log(fail ? ('真实 Canvas 验收未通过：' + fail + ' / ' + (pass + fail) + ' 项失败')
      : ('真实 Canvas 验收全部通过：' + pass + ' 项，0 失败'));
    process.exit(fail ? 1 : 0);
  }
})();
