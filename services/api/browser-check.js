'use strict';
/* 真实浏览器验收（#I10）：headless Edge/Chrome + CDP，零依赖。
 * 这台机器不需要装任何东西，跑 `node services/api/browser-check.js` 即可。
 * 覆盖 DELIVERY-I10.md 里标「待完成」的那几条：真实页面加载、拖参数上报、
 * 断网刷新后补发、同一匿名 ID 另一浏览器读回。
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var spawn = require('child_process').spawn;

var ROOT = path.resolve(__dirname, '..', '..');
var PAGE = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
var API_PORT = 8791;
var CDP_PORT = 9333;

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
  this.ws = ws;
  this.id = 0;
  this.pending = new Map();
  this.events = [];
  this.waiters = [];
  ws.addEventListener('message', function (m) {
    var msg = JSON.parse(m.data);
    if (msg.id && self.pending.has(msg.id)) {
      var h = self.pending.get(msg.id);
      self.pending.delete(msg.id);
      msg.error ? h.reject(new Error(msg.error.message)) : h.resolve(msg.result);
      return;
    }
    if (msg.method) {
      self.events.push(msg);
      self.waiters.slice().forEach(function (w) {
        if (w.method === msg.method) { w.resolve(msg); self.waiters = self.waiters.filter(function (x) { return x !== w; }); }
      });
    }
  });
  this.ready = new Promise(function (res, rej) {
    ws.addEventListener('open', function () { res(); });
    ws.addEventListener('error', function (e) { rej(new Error('CDP 连接失败')); });
  });
}
CDP.prototype.send = function (method, params) {
  var self = this, id = ++this.id;
  return new Promise(function (resolve, reject) {
    self.pending.set(id, { resolve: resolve, reject: reject });
    self.ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    setTimeout(function () {
      if (self.pending.has(id)) { self.pending.delete(id); reject(new Error('CDP 超时：' + method)); }
    }, 15000);
  });
};
CDP.prototype.once = function (method, ms) {
  var self = this;
  return new Promise(function (resolve, reject) {
    var w = { method: method, resolve: resolve };
    self.waiters.push(w);
    setTimeout(function () {
      if (self.waiters.indexOf(w) >= 0) {
        self.waiters = self.waiters.filter(function (x) { return x !== w; });
        reject(new Error('等待事件超时：' + method));
      }
    }, ms || 15000);
  });
};
CDP.prototype.eval = async function (expression) {
  var r = await this.send('Runtime.evaluate', {
    expression: expression, awaitPromise: true, returnByValue: true, userGesture: true
  });
  if (r.exceptionDetails) throw new Error('页面异常：' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  return r.result.value;
};

function trace(anonId) {
  return new Promise(function (resolve, reject) {
    http.get({
      host: '127.0.0.1', port: API_PORT, path: '/v1/trace',
      headers: { 'X-Anon-Id': anonId }
    }, function (res) {
      var b = '';
      res.on('data', function (c) { b += c; });
      res.on('end', function () { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async function main() {
  var exe = findBrowser();
  if (!exe) { console.log('未找到 Chrome/Edge，跳过浏览器验收'); process.exit(2); }

  var apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttk-bcdb-'));
  process.env.TTK_DB_DIR = apiDir;
  var api = require('./server.js');
  var apiServer = api.createServer();
  await new Promise(function (r) { apiServer.listen(API_PORT, '127.0.0.1', r); });

  var userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttk-bprof-'));
  var child = spawn(exe, [
    '--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + userDir, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-extensions', '--allow-file-access-from-files',
    '--window-size=1280,900', 'about:blank'
  ], { stdio: 'ignore' });

  var cdp, cleanup = function () {
    try { child.kill(); } catch (e) {}
    try { apiServer.close(); } catch (e) {}
  };

  try {
    console.log('真实浏览器验收');
    console.log('  浏览器：' + path.basename(exe) + '（headless）');
    console.log('  页面：' + PAGE + '\n');

    var ver = await waitPort('http://127.0.0.1:' + CDP_PORT + '/json/version', 50);
    ok('headless 浏览器已启动', !!ver.Browser, JSON.stringify(ver.Browser));

    var list = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
    var page = list.filter(function (t) { return t.type === 'page'; })[0];
    var ws = new WebSocket(page.webSocketDebuggerUrl);
    cdp = new CDP(ws);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');

    var loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: PAGE });
    await loaded;
    await wait(400);

    // 1. 页面可用性
    var boot = await cdp.eval('JSON.stringify({tpl:(document.getElementById("tplName")||{}).textContent||"", cards:document.querySelectorAll("#tplList .tpl-card").length, canvas:(document.getElementById("stage")||{}).width||0, ttk:typeof TTK, tpls:TTK.templates.length, routes:TTK.views.routes().length})');
    var b = JSON.parse(boot);
    ok('file:// 双击打开无白屏（标题与画布已渲染）', b.tpl.length > 0 && b.canvas > 0, boot);
    ok('六个沙盒全部载入侧栏', b.cards === 6 && b.tpls === 6, 'cards=' + b.cards + ' tpls=' + b.tpls);
    ok('四视图路由可用', b.routes === 4, 'routes=' + b.routes);
    var errs = cdp.events.filter(function (e) { return e.method === 'Runtime.exceptionThrown'; });
    ok('页面无未捕获异常', errs.length === 0, errs.length ? JSON.stringify(errs[0].params).slice(0, 200) : '');

    // 2. 本地模式不联网
    var fetchesLocal = await cdp.eval('window.__f=0;window.__of=window.fetch;window.fetch=function(){window.__f++;return window.__of.apply(this,arguments)};TTK.data.remote.configure("");TTK.data.log({at:Date.now(),tpl:"overfit",reason:"param",params:{a:1}});window.__f');
    ok('未配置服务时不发任何网络请求', fetchesLocal === 0, 'fetch 调用 ' + fetchesLocal + ' 次');
    ok('未配置服务时不生成待上传队列', (await cdp.eval('TTK.data.remote.pending()')) === 0, '');

    // 3. 接上服务后拖参数真的送到后端
    await cdp.eval('TTK.data.remote.configure("http://127.0.0.1:' + API_PORT + '/v1")');
    var anonId = await cdp.eval('TTK.data.remote.identity()');
    ok('浏览器内生成 16 位匿名 ID', /^[0-9a-f]{16}$/.test(anonId), anonId);

    await cdp.eval('(function(){var el=document.querySelector("#paramList input[type=range]");el.value=el.max;el.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
    await wait(1200);
    var t1 = await trace(anonId);
    ok('拖动真实滑块后事件到达 /events', t1.events.length >= 1, '服务端收到 ' + t1.events.length + ' 条');
    ok('上报事件字段符合契约', t1.events.every(function (e) {
      return typeof e.at === 'number' && typeof e.tpl === 'string' && ['param', 'select', 'reset', 'stuck', 'challenge', 'view'].indexOf(e.reason) >= 0 && typeof e.params === 'object';
    }), JSON.stringify(t1.events[0] || {}));
    ok('队列已清空（服务端确认后才出队）', (await cdp.eval('TTK.data.remote.pending()')) === 0, '');

    // 4. 断网 → 刷新页面 → 联网补发，不丢事件
    var before = (await trace(anonId)).events.length;
    await cdp.send('Network.emulateNetworkConditions', {
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0
    });
    await cdp.eval('(function(){var el=document.querySelector("#paramList input[type=range]");el.value=el.min;el.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
    await wait(900);
    var pendingOffline = await cdp.eval('TTK.data.remote.pending()');
    ok('断网时事件留在待上传队列', pendingOffline >= 1, 'pending=' + pendingOffline);

    var loaded2 = cdp.once('Page.loadEventFired');
    await cdp.send('Page.reload', {});
    await loaded2;
    await wait(600);
    var afterReload = await cdp.eval('JSON.stringify({pending:TTK.data.remote.pending(),mode:TTK.data.remote.mode,id:TTK.data.remote.identity(),tpl:(document.getElementById("tplName")||{}).textContent||""})');
    var r = JSON.parse(afterReload);
    ok('断网刷新后页面仍可用', r.tpl.length > 0, afterReload);
    ok('刷新后待上传队列从磁盘恢复', r.pending >= 1, afterReload);
    ok('刷新后匿名身份保持不变', r.id === anonId, r.id + ' vs ' + anonId);

    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1
    });
    await cdp.eval('TTK.data.remote.flush()');
    await wait(1500);
    var t2 = await trace(anonId);
    ok('恢复联网后自动补发，事件不丢失', t2.events.length > before, before + ' -> ' + t2.events.length);
    ok('补发后队列归零', (await cdp.eval('TTK.data.remote.pending()')) === 0, '');

    // 5. 同一匿名 ID 的「另一台设备」能读回进度
    var progressCount = await cdp.eval('Object.keys(TTK.data.progress()).length');
    var otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttk-bprof2-'));
    var child2 = spawn(exe, [
      '--headless=new', '--remote-debugging-port=' + (CDP_PORT + 1),
      '--user-data-dir=' + otherDir, '--no-first-run', '--no-default-browser-check',
      '--disable-gpu', '--disable-extensions', '--allow-file-access-from-files', 'about:blank'
    ], { stdio: 'ignore' });
    try {
      await waitPort('http://127.0.0.1:' + (CDP_PORT + 1) + '/json/version', 50);
      var list2 = await getJson('http://127.0.0.1:' + (CDP_PORT + 1) + '/json/list');
      var page2 = list2.filter(function (t) { return t.type === 'page'; })[0];
      var ws2 = new WebSocket(page2.webSocketDebuggerUrl);
      var cdp2 = new CDP(ws2);
      await cdp2.ready;
      await cdp2.send('Page.enable');
      await cdp2.send('Runtime.enable');
      var loaded3 = cdp2.once('Page.loadEventFired');
      await cdp2.send('Page.navigate', { url: PAGE });
      await loaded3;
      await wait(400);
      var handoff = await cdp2.eval('(function(){TTK.data.remote.configure("http://127.0.0.1:' + API_PORT + '/v1");var r=TTK.data.remote.identity("' + anonId + '");return JSON.stringify(r)})()');
      ok('新设备可手动输入匿名 ID 接续', JSON.parse(handoff).ok === true, handoff);
      await cdp2.eval('TTK.data.remote.flush()');
      await wait(1500);
      var other = await cdp2.eval('JSON.stringify({events:TTK.data.trail().length,progress:Object.keys(TTK.data.progress()).length,id:TTK.data.remote.identity()})');
      var o = JSON.parse(other);
      ok('另一浏览器读回同一轨迹（跨设备一致）', o.events > 0 && o.id === anonId, other);
      ok('另一浏览器读回挑战进度', o.progress === progressCount, '本地 ' + progressCount + ' 条，远端 ' + o.progress + ' 条');
    } finally {
      try { child2.kill(); } catch (e) {}
    }

    // 6. 四视图切换不破坏沙盒
    await cdp.eval('TTK.views.go("report")'); await wait(300);
    var report = await cdp.eval('JSON.stringify({shown:!document.getElementById("view-report").hidden,sandbox:!document.getElementById("view-sandbox").hidden,hash:location.hash})');
    var rp = JSON.parse(report);
    await cdp.eval('TTK.views.go("sandbox")'); await wait(300);
    var back = await cdp.eval('JSON.stringify({shown:!document.getElementById("view-sandbox").hidden,range:!!document.querySelector("#paramList input[type=range]"),canvas:(document.getElementById("stage")||{}).width||0})');
    var bk = JSON.parse(back);
    ok('学习报告视图可进入', rp.shown === true && rp.sandbox === false, report);
    ok('切回沙盒后参数控件与画布仍在', bk.shown === true && bk.range === true && bk.canvas > 0, back);

  } catch (e) {
    ok('验收过程未抛异常', false, e && e.message);
  } finally {
    cleanup();
    try { fs.rmSync(apiDir, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) {}
    console.log('\n---------------------------------------------');
    console.log(fail ? ('浏览器验收未通过：' + fail + ' / ' + (pass + fail) + ' 项失败')
      : ('浏览器验收全部通过：' + pass + ' 项，0 失败'));
    process.exit(fail ? 1 : 0);
  }
})();
