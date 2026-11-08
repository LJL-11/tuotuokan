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
    // 模板库由 #I6 从 6 个扩到 10 个，这里按实际数量动态校验，别再写死。
    ok('全部精修沙盒载入侧栏', b.cards === b.tpls && b.tpls >= 6,
      'cards=' + b.cards + ' tpls=' + b.tpls);
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

    // 7. #I2 / #I3 / #I14 / #I15 前端入口在真实浏览器里的冒烟
    await cdp.eval('TTK.data.remote.configure("")');
    await cdp.eval('TTK.views.go("report")'); await wait(250);
    var uiReport = await cdp.eval('(function(){var orig=URL.createObjectURL;URL.createObjectURL=null;var t=TTK.views.exportReport();URL.createObjectURL=orig;var box=document.getElementById("reportExportText");var obj={};try{obj=JSON.parse(t||"{}")}catch(e){}return JSON.stringify({ok:obj.schema==="ttk.learning-trace.v1",copied:!!box&&box.value===t,imported:TTK.views.importReport(t)})})()');
    var ur = JSON.parse(uiReport);
    ok('报告导出 / 导入链路可用且导出符合契约',
      ur.ok === true && ur.copied === true && ur.imported === true, uiReport);

    await cdp.eval('TTK.views.go("studio")'); await wait(250);
    var uiStudio = await cdp.eval('(function(){var s=JSON.parse(JSON.stringify(TTK.dsl.example));s.id="browser_spring";document.getElementById("studioJson").value=JSON.stringify(s,null,2);document.getElementById("studioCompile").click();return JSON.stringify({mounted:!!TTK.engine.get("browser_spring"),view:TTK.views.current().id,hash:location.hash})})()');
    var us = JSON.parse(uiStudio);
    ok('粘贴示例可编译挂载并自动切到沙盒',
      us.mounted === true && us.view === 'sandbox' && us.hash.indexOf('browser_spring') >= 0, uiStudio);

    await cdp.eval('TTK.views.go("studio")'); await wait(250);
    var uiBad = await cdp.eval('(function(){var s=JSON.parse(JSON.stringify(TTK.dsl.example));s.id="browser_evil";s.series[0].expr="window.alert(1)";document.getElementById("studioJson").value=JSON.stringify(s,null,2);document.getElementById("studioValidate").click();return JSON.stringify({msg:(document.getElementById("studioMsg")||{}).textContent||"",mounted:!!TTK.engine.get("browser_evil")})})()');
    var ub = JSON.parse(uiBad);
    ok('非法公式给出行号与标识符且不会挂载',
      /第 \d+ 行/.test(ub.msg) && ub.msg.indexOf('window') >= 0 && ub.mounted === false, uiBad);

    var uiSaved = await cdp.eval('(function(){var s=JSON.parse(JSON.stringify(TTK.dsl.example));s.id="browser_saved";document.getElementById("studioJson").value=JSON.stringify(s,null,2);document.getElementById("studioSave").click();return JSON.stringify({count:TTK.data.custom().length,mounted:!!TTK.engine.get("browser_saved")})})()');
    var usv = JSON.parse(uiSaved);
    ok('工坊保存到本机且已挂载', usv.count >= 1 && usv.mounted === true, uiSaved);
    var reloaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.reload', { ignoreCache: true });
    await reloaded; await wait(500);
    var afterReload = await cdp.eval('JSON.stringify({mounted:!!TTK.engine.get("browser_saved"),custom:TTK.data.custom().length})');
    var ar = JSON.parse(afterReload);
    ok('刷新页面后自定义模板仍在', ar.mounted === true && ar.custom >= 1, afterReload);

    await cdp.eval('TTK.views.go("graph")'); await wait(250);
    var uiGraph = await cdp.eval('(function(){var list=document.querySelectorAll("#view-graph [data-node]");var first=list[0];var id=first&&first.getAttribute("data-node");if(first)first.dispatchEvent(new MouseEvent("click",{bubbles:true}));return JSON.stringify({nodes:list.length,tpls:TTK.engine.all().length,id:id,hash:location.hash})})()');
    var ug = JSON.parse(uiGraph);
    ok('图谱节点数与模板数一致且可点击跳转沙盒',
      ug.nodes === ug.tpls && ug.hash.indexOf('#sandbox/' + ug.id) === 0, uiGraph);

    var uiSync = await cdp.eval('(function(){document.getElementById("journalBtn").click();return JSON.stringify({status:document.getElementById("syncStatus").textContent,notice:document.getElementById("storageNotice").textContent,hasUrl:!!document.getElementById("syncUrl"),hasAnon:!!document.getElementById("syncAnon"),mode:TTK.data.remote.mode})})()');
    var uy = JSON.parse(uiSync);
    ok('同步面板显示模式 / 待上传 / 匿名 ID',
      uy.hasUrl === true && uy.hasAnon === true && uy.status.indexOf('待上传') >= 0 &&
      uy.status.indexOf('匿名 ID') >= 0, uiSync);
    ok('本地模式数据诚实文案正确', uy.mode === 'local' && uy.notice.indexOf('不上传') >= 0, uy.notice);
    var uiSyncOn = await cdp.eval('(function(){document.getElementById("syncUrl").value="http://127.0.0.1:8791/v1";document.getElementById("syncSave").click();return JSON.stringify({mode:TTK.data.remote.mode,notice:document.getElementById("storageNotice").textContent,status:document.getElementById("syncStatus").textContent})})()');
    var uy2 = JSON.parse(uiSyncOn);
    ok('界面可启用同步并即时更新状态与措辞',
      uy2.mode === 'rest' && uy2.notice.indexOf('已启用同步') >= 0 &&
      uy2.status.indexOf('匿名 ID') >= 0, uiSyncOn);
    await cdp.eval('TTK.data.remote.configure("")');

    // 8. 偿还 #19 / #20 / #21 的前端入口在真实浏览器里的冒烟
    var capUi = await cdp.eval('(function(){var h=document.getElementById("askPrivacy").textContent;return JSON.stringify({honest:h.indexOf("语音只认文件名")>=0&&h.indexOf("请改用文字，或把概念写进文件名")>=0,panel:!!document.getElementById("genEndpoint")&&!!document.getElementById("genModel"),status:document.getElementById("genStatus").textContent})})()');
    var cap = JSON.parse(capUi);
    ok('能力口径与生成代理面板在真实页面可见',
      cap.honest === true && cap.panel === true && cap.status.indexOf('本地草稿') >= 0, capUi);

    var genCfg = await cdp.eval('(function(){document.getElementById("genEndpoint").value="http://127.0.0.1:8791/generate";document.getElementById("genModel").value="browser-model";document.getElementById("genSave").click();return JSON.stringify({enabled:TTK.generator.config().enabled,saved:TTK.settings.readGenConfig(),status:document.getElementById("genStatus").textContent})})()');
    var gc = JSON.parse(genCfg);
    ok('界面可配置 endpoint / model 并写入本机',
      gc.enabled === true && gc.saved.endpoint.indexOf('/generate') >= 0 &&
      gc.saved.model === 'browser-model' && gc.status.indexOf('browser-model') >= 0, genCfg);

    // 用注入的 transport 模拟服务端返回合法模板，走完整的 recognize → generate → mount → 落盘链路
    await cdp.eval('(function(){var s=JSON.parse(JSON.stringify(TTK.dsl.example));s.id="browser_llm";s.name="浏览器模型模板";TTK.generator.configure({endpoint:"http://127.0.0.1:8791/generate",model:"browser-model",transport:function(){return JSON.parse(JSON.stringify(s))}});document.getElementById("conceptInput").value="一个完全未收录的概念xyz";document.getElementById("askBtn").click();return "ok"})()');
    await wait(600);
    var genAfter = await cdp.eval('JSON.stringify({mounted:!!TTK.engine.get("browser_llm"),custom:TTK.data.custom().some(function(s){return s.id==="browser_llm"&&s.source==="llm"}),hint:document.getElementById("askHint").textContent,exported:JSON.parse(TTK.data.exportAll(TTK.engine)).customTemplates.some(function(s){return s.id==="browser_llm"})})');
    var ga = JSON.parse(genAfter);
    ok('模型模板落盘、可随导出 JSON 备份且文案标明 AI 来源',
      ga.mounted === true && ga.custom === true && ga.exported === true &&
      ga.hint.indexOf('模型生成') >= 0, genAfter);

    var reloaded3 = cdp.once('Page.loadEventFired');
    await cdp.send('Page.reload', { ignoreCache: true });
    await reloaded3; await wait(500);
    var after3 = await cdp.eval('JSON.stringify({mounted:!!TTK.engine.get("browser_llm"),cfg:TTK.settings.readGenConfig(),enabled:TTK.generator.config().enabled})');
    var a3 = JSON.parse(after3);
    ok('刷新后模型模板与代理配置都还在',
      a3.mounted === true && a3.enabled === true && a3.cfg.model === 'browser-model', after3);

    var cleared = await cdp.eval('(function(){document.getElementById("journalBtn").click();document.getElementById("genClear").click();return JSON.stringify({enabled:TTK.generator.config().enabled,cfg:TTK.settings.readGenConfig(),status:document.getElementById("genStatus").textContent})})()');
    var cl = JSON.parse(cleared);
    ok('清空配置回到本地草稿模式',
      cl.enabled === false && cl.cfg.endpoint === '' && cl.status.indexOf('本地草稿') >= 0, cleared);

    var draftUi = await cdp.eval('(function(){var before=TTK.data.custom().length;document.getElementById("conceptInput").value="另一个未收录概念abc";document.getElementById("askBtn").click();return JSON.stringify({before:before,after:TTK.data.custom().length,hint:document.getElementById("askHint").textContent})})()');
    var du = JSON.parse(draftUi);
    ok('本地草稿不落盘且文案标明不是 AI 生成',
      du.before === du.after && du.hint.indexOf('本地草稿') >= 0, draftUi);

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
