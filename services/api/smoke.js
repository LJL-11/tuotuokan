'use strict';
/* I10 验收：真实 HTTP、临时数据库、隔离浏览器数据层。不会读写真实学习数据。 */
var assert = require('assert/strict');
var fs = require('fs');
var path = require('path');
var http = require('http');
var vm = require('vm');
var crypto = require('crypto');
var createServer = require('./server').createServer;
var validate = require('./validate');
var source = fs.readFileSync(path.join(__dirname, '../../src/learning/data.js'), 'utf8');
var spring = require('../../contracts/examples/spring.json');
var example = require('../../contracts/examples/trace.json');
// Windows 沙箱的系统临时目录不一定允许 rename；使用被 git 忽略的本地测试目录。
var testRoot = process.env.TTK_TEST_TMP || path.join(__dirname, '../../.local');
fs.mkdirSync(testRoot, { recursive: true });
var tmp = fs.mkdtempSync(path.join(testRoot, 'ttk-api-'));
var servers = [], clients = [], total = 0, failures = [];
var ID = 'a1b2c3d4e5f60718', OTHER = 'deadbeefcafebabe';
function event(at, tpl) { return { at: at, tpl: tpl || 'spring', reason: 'param', params: { A: 1 } }; }
function trace(events, extra) {
  return Object.assign({ schema: 'ttk.learning-trace.v1', exportedAt: new Date().toISOString(), events: events || [] }, extra || {});
}
async function test(name, fn) {
  total++;
  try { await fn(); console.log('  PASS  ' + name); }
  catch (e) { failures.push(name); console.error('  FAIL  ' + name + '\n    ' + (e.stack || e)); }
}
function listen(server) {
  servers.push(server);
  return new Promise(function (resolve, reject) {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', function () { resolve('http://127.0.0.1:' + server.address().port + '/v1'); });
  });
}
function close(server) { return new Promise(function (resolve) { server.close(resolve); }); }
function request(base, route, method, body, id, raw) {
  return new Promise(function (resolve, reject) {
    var payload = raw === undefined ? (body === undefined ? '' : JSON.stringify(body)) : raw;
    var target = new URL(base + route);
    var req = http.request(target, { method: method || 'GET', headers: Object.assign({
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Connection': 'close'
    }, id ? { 'X-Anon-Id': id } : {}) }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject); req.end(payload);
  });
}
function response(status, body) { return { ok: status >= 200 && status < 300, status: status, json: async function () { return body; } }; }
function client(store, transport, options) {
  options = options || {}; store = store || new Map();
  var hooks = {}, timers = new Set();
  var context = {
    console: console, crypto: crypto.webcrypto, AbortController: AbortController,
    navigator: { onLine: options.online !== false },
    localStorage: {
      getItem: function (k) { if (options.storageFails) throw new Error('storage blocked'); return store.get(k) || null; },
      setItem: function (k, v) { if (options.storageFails) throw new Error('quota'); store.set(k, v); }
    },
    setTimeout: function (fn, ms) {
      var timer = setTimeout(function () { timers.delete(timer); fn(); }, options.fastTimeout && ms === 10000 ? 5 : ms);
      timer.unref(); timers.add(timer); return timer;
    },
    clearTimeout: function (timer) { clearTimeout(timer); timers.delete(timer); },
    addEventListener: function (name, fn) { hooks[name] = fn; },
    fetch: transport || async function (url, init) {
      var target = new URL(url), base = target.origin + '/v1', route = target.pathname.slice(3);
      var result = await request(base, route, init.method, init.body ? JSON.parse(init.body) : undefined, init.headers['X-Anon-Id']);
      return response(result.status, result.body);
    }
  };
  context.window = context;
  vm.runInNewContext(source, context, { filename: 'data.js' });
  var c = { data: context.TTK.data, context: context, hooks: hooks, store: store,
    dispose: function () { context.TTK.data.remote.configure(''); timers.forEach(clearTimeout); timers.clear(); } };
  clients.push(c); return c;
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }
async function main() {
  var directory = path.join(tmp, 'db');
  var server = createServer({ dataDir: directory });
  var base = await listen(server);
  console.log('I10 API 与数据层验收（隔离临时数据库）');
  await test('两份仓库契约示例可校验', function () {
    assert.deepEqual(validate.trace(example), []); assert.deepEqual(validate.template(spring), []);
  });
  await test('健康检查与 CORS 预检允许 file:// 所需请求头', async function () {
    assert.equal((await request(base, '/health')).status, 200);
    var r = await request(base, '/events', 'OPTIONS');
    assert.equal(r.status, 204); assert.equal(r.headers['access-control-allow-origin'], '*');
    assert.match(r.headers['access-control-allow-headers'], /X-Anon-Id/);
  });
  await test('创建、恢复匿名身份；非法 existingId 明确拒绝', async function () {
    var r = await request(base, '/auth/anonymous', 'POST', {});
    assert.match(r.body.anonId, /^[0-9a-f]{16}$/);
    var again = await request(base, '/auth/anonymous', 'POST', { existingId: r.body.anonId });
    assert.deepEqual(again.body, r.body);
    assert.equal((await request(base, '/auth/anonymous', 'POST', { existingId: 'bad' })).status, 400);
  });
  await test('缺失、非法匿名凭证拒绝，合法大小写归一', async function () {
    var body = { anonymous: true, events: [] };
    assert.equal((await request(base, '/events', 'POST', body)).status, 401);
    assert.equal((await request(base, '/events', 'POST', body, 'bad')).status, 401);
    assert.equal((await request(base, '/events', 'POST', body, ID.toUpperCase())).status, 202);
  });
  await test('事件批次原子校验，拒绝浮点时间、非法参数及 reason', async function () {
    for (var bad of [Object.assign(event(1), { at: 1.5 }), Object.assign(event(1), { reason: 'bogus' }), Object.assign(event(1), { params: { A: '1' } })]) {
      var r = await request(base, '/events', 'POST', { anonymous: true, events: [event(2), bad] }, OTHER);
      assert.equal(r.status, 400); assert.ok(r.body.details.length);
    }
    assert.equal((await request(base, '/trace', 'GET', undefined, OTHER)).body.events.length, 0);
  });
  await test('重复事件幂等，排序且不保留事件未知字段', async function () {
    var batch = { anonymous: true, events: [Object.assign(event(20), { extra: 'discard' }), event(10)] };
    assert.equal((await request(base, '/events', 'POST', batch, ID)).body.added, 2);
    assert.equal((await request(base, '/events', 'POST', batch, ID)).body.duplicates, 2);
    var r = await request(base, '/trace', 'GET', undefined, ID);
    assert.deepEqual(r.body.events.map(function (e) { return e.at; }), [10, 20]);
    assert.equal(r.body.events[1].extra, undefined); assert.deepEqual(validate.trace(r.body), []);
    assert.ok(fs.existsSync(server.dbFile));
  });
  await test('模板按完整 schema 拒绝缺 brief、非法参数和样式', async function () {
    for (var change of [function (s) { delete s.brief; }, function (s) { s.params[0].step = 0; }, function (s) { s.series[0].style = 'html'; }]) {
      var spec = plain(spring); change(spec);
      assert.equal((await request(base, '/templates', 'PUT', spec, ID)).status, 422);
    }
    assert.equal((await request(base, '/templates', 'PUT', spring, ID)).status, 200);
    assert.equal((await request(base, '/templates', 'GET', undefined, ID)).body[0].id, spring.id);
    assert.equal((await request(base, '/templates', 'GET', undefined, OTHER)).body.length, 0);
  });
  await test('完整轨迹导入含模板；进度取 OR，卡点去重，不覆盖并行完成', async function () {
    var data = trace([event(30)], { progress: { 'spring:0': true }, stuck: [{ at: 30, tpl: 'spring' }], customTemplates: [spring] });
    assert.equal((await request(base, '/trace/import', 'POST', data, OTHER)).status, 200);
    await request(base, '/trace/import', 'POST', data, OTHER);
    await request(base, '/trace/import', 'POST', trace([], { progress: { 'spring:0': false, 'spring:1': true } }), OTHER);
    var r = (await request(base, '/trace', 'GET', undefined, OTHER)).body;
    assert.deepEqual(r.progress, { 'spring:0': true, 'spring:1': true });
    assert.equal(r.stuck.length, 1); assert.equal(r.events.length, 1); assert.equal(r.customTemplates[0].id, spring.id);
  });
  await test('非法轨迹版本、日期、布尔进度和卡点均拒绝且不修改历史', async function () {
    for (var invalid of [trace([], { schema: 'wrong' }), trace([], { exportedAt: 'today' }), trace([], { progress: { 'a:0': 'yes' } }), trace([], { stuck: [{ at: 1.2, tpl: 'a' }] })]) {
      assert.equal((await request(base, '/trace/import', 'POST', invalid, OTHER)).status, 400);
    }
    assert.equal((await request(base, '/trace', 'GET', undefined, OTHER)).body.events.length, 1);
  });
  await test('兼容 events 的可选进度字段但拒绝非法字段类型', async function () {
    assert.equal((await request(base, '/events', 'POST', { anonymous: true, events: [], progress: { 'a:0': true } }, ID)).status, 202);
    assert.equal((await request(base, '/events', 'POST', { anonymous: true, events: [], progress: [] }, ID)).status, 400);
  });
  await test('畸形 JSON、null、超大请求返回明确错误，服务仍可用', async function () {
    assert.equal((await request(base, '/events', 'POST', null, ID, '{')).status, 400);
    assert.equal((await request(base, '/events', 'POST', null, ID)).status, 400);
    assert.equal((await request(base, '/events', 'POST', null, ID, ' '.repeat(2 * 1024 * 1024 + 10))).status, 413);
    assert.equal((await request(base, '/health')).status, 200);
  });
  await test('服务重启后学习数据仍存在', async function () {
    await close(server);
    server = createServer({ dataDir: directory }); base = await listen(server);
    assert.equal((await request(base, '/trace', 'GET', undefined, OTHER)).body.progress['spring:0'], true);
  });
  await test('磁盘写入失败返回 500，不把未持久化事件当成功', async function () {
    var badDir = path.join(tmp, 'blocked');
    var s = createServer({ dataDir: badDir }), url = await listen(s);
    fs.writeFileSync(badDir, 'not a directory');
    assert.equal((await request(url, '/events', 'POST', { anonymous: true, events: [event(1)] }, ID)).status, 500);
    assert.equal((await request(url, '/trace', 'GET', undefined, ID)).body.events.length, 0);
  });
  await test('损坏的数据库不被静默清空覆盖', function () {
    var dir = path.join(tmp, 'corrupt'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'db.json'), '{');
    assert.throws(function () { createServer({ dataDir: dir }); });
    assert.equal(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'), '{');
  });
  await test('纯本地模式不发网络请求，同步 getter 与旧数据迁移保持兼容', async function () {
    var calls = 0, store = new Map([['ttk.trail', JSON.stringify([event(1)])]]);
    var c = client(store, async function () { calls++; throw new Error('unexpected'); });
    c.data.log(event(2)); c.data.markChallenge('spring', 0); await Promise.resolve();
    assert.equal(calls, 0); assert.equal(c.data.trail().length, 2); assert.equal(c.data.remote.pending(), 0);
    assert.equal(typeof c.data.trail().then, 'undefined'); c.dispose();
  });
  await test('存储被禁用时保留会话数据，并明确提示持久化失败', function () {
    var c = client(null, null, { storageFails: true });
    c.data.log(event(3)); c.data.log(event(4));
    assert.equal(c.data.trail().length, 2); assert.ok(c.data.remote.storageError); c.dispose();
  });
  await test('清空后刷新不会重新从保留的旧版键恢复历史', function () {
    var store = new Map([['ttk.trail', JSON.stringify([event(1)])]]);
    var c = client(store); assert.equal(c.data.trail().length, 1); c.data.clear();
    var reloaded = client(store); assert.equal(reloaded.data.trail().length, 0);
    assert.ok(store.has('ttk.trail')); c.dispose(); reloaded.dispose();
  });
  await test('随机 ID 与校验一致，非法恢复不会替换原身份', function () {
    var c = client(), id = c.data.remote.identity(); assert.match(id, /^[0-9a-f]{16}$/);
    assert.equal(c.data.remote.identity('123').ok, false); assert.equal(c.data.remote.identity(), id); c.dispose();
  });
  await test('断网刷新后队列恢复，联网一次补齐轨迹、挑战、卡点与模板', async function () {
    var store = new Map(), c = client(store, null, { online: false });
    c.data.remote.identity('1234abcd5678efab'); c.data.remote.configure(base + '/');
    for (var i = 0; i < 70; i++) c.data.log(event(1000 + i));
    c.data.markChallenge('spring', 0); c.data.addStuck('spring'); c.data.saveCustom([spring]);
    assert.equal(c.data.remote.pending(), 70);
    var reloaded = client(store, null, { online: false });
    assert.equal(reloaded.data.remote.pending(), 70);
    reloaded.context.navigator.onLine = true;
    assert.equal((await reloaded.data.remote.flush()).ok, true);
    assert.equal(reloaded.data.remote.pending(), 0);
    var data = (await request(base, '/trace', 'GET', undefined, '1234abcd5678efab')).body;
    assert.equal(data.events.length, 70); assert.equal(data.progress['spring:0'], true);
    assert.equal(data.stuck.length, 1); assert.equal(data.customTemplates[0].id, spring.id);
    c.dispose(); reloaded.dispose();
  });
  await test('同一匿名 ID 的新客户端能读回服务端数据并通知订阅者', async function () {
    var c = client(null, null, { online: false }), notices = 0;
    c.data.remote.identity('1234abcd5678efab'); c.data.subscribe(function () { notices++; }); c.data.remote.configure(base);
    c.context.navigator.onLine = true; assert.equal((await c.data.remote.flush()).ok, true);
    assert.equal(c.data.trail().length, 70); assert.equal(c.data.progress()['spring:0'], true);
    assert.equal(c.data.custom()[0].id, spring.id); assert.ok(notices > 0); c.dispose();
  });
  await test('单独完成挑战与保存模板也会同步，不依赖下一次拖动', async function () {
    var c = client(null, null, { online: false }); c.data.remote.identity('5555abcd6666efab'); c.data.remote.configure(base);
    c.context.navigator.onLine = true; assert.equal((await c.data.remote.flush()).ok, true);
    c.data.markChallenge('spring', 1); c.data.saveCustom([spring]); assert.equal((await c.data.remote.flush()).ok, true);
    var data = (await request(base, '/trace', 'GET', undefined, '5555abcd6666efab')).body;
    assert.equal(data.progress['spring:1'], true); assert.equal(data.customTemplates.length, 1); c.dispose();
  });
  await test('HTTP 500、429、401 都保留事件；修复连接后可补发', async function () {
    var status = 500, c = client(null, async function (url) { return response(status, trace([])); }, { online: false });
    c.data.remote.configure('http://example.invalid/v1'); c.data.log(event(1)); c.context.navigator.onLine = true;
    for (var code of [500, 429, 401]) {
      status = code; assert.equal((await c.data.remote.flush()).ok, false);
      assert.equal(c.data.remote.pending(), 1); assert.match(c.data.remote.lastError, new RegExp(String(code)));
    }
    status = 200; assert.equal((await c.data.remote.flush()).ok, true); assert.equal(c.data.remote.pending(), 0); c.dispose();
  });
  await test('连接异常保留队列，online 事件立即触发补发', async function () {
    var offline = true, c = client(null, async function () { if (offline) throw new Error('offline'); return response(200, trace([])); }, { online: false });
    c.data.remote.configure('http://example.invalid/v1'); c.data.log(event(1)); c.context.navigator.onLine = true;
    assert.equal((await c.data.remote.flush()).ok, false); assert.equal(c.data.remote.pending(), 1);
    offline = false; c.hooks.online(); await c.data.remote.flush(); assert.equal(c.data.remote.pending(), 0); c.dispose();
  });
  await test('请求途中新增超过 500 条事件，不截断或移错队列', async function () {
    var release, sent = [], first = true;
    var c = client(null, async function (url, init) {
      if (url.endsWith('/events')) {
        sent = sent.concat(JSON.parse(init.body).events);
        if (first) { first = false; return new Promise(function (resolve) { release = resolve; }); }
      }
      return response(200, trace([]));
    }, { online: false });
    c.data.remote.configure('http://example.invalid/v1'); c.data.log(event(1)); c.context.navigator.onLine = true;
    var pending = c.data.remote.flush();
    for (var i = 2; i <= 620; i++) c.data.log(event(i));
    release(response(202)); assert.equal((await pending).ok, true);
    assert.equal(new Set(sent.map(function (e) { return e.at; })).size, 620); assert.equal(c.data.remote.pending(), 0); c.dispose();
  });
  await test('切换匿名身份时旧响应不得污染新缓存，旧队列独立保留', async function () {
    var release, old = true;
    var c = client(null, async function () {
      if (old) { old = false; return new Promise(function (resolve) { release = resolve; }); }
      return response(200, trace([]));
    }, { online: false });
    c.data.remote.identity(ID); c.data.remote.configure('http://example.invalid/v1'); c.data.log(event(9));
    c.context.navigator.onLine = true; var pending = c.data.remote.flush();
    c.context.navigator.onLine = false; c.data.remote.identity(OTHER);
    release(response(202)); await pending;
    assert.equal(c.data.trail().length, 0); assert.equal(c.data.remote.pending(), 0);
    c.data.remote.identity(ID); assert.equal(c.data.remote.pending(), 1); assert.equal(c.data.trail()[0].at, 9); c.dispose();
  });
  await test('切换服务地址不把旧服务队列传到新服务', function () {
    var c = client(null, null, { online: false }); c.data.remote.configure('http://one.invalid/v1'); c.data.log(event(1));
    c.data.remote.configure('http://two.invalid/v1'); assert.equal(c.data.trail().length, 0); assert.equal(c.data.remote.pending(), 0);
    c.data.remote.configure('http://one.invalid/v1'); assert.equal(c.data.remote.pending(), 1); c.dispose();
  });
  await test('旧身份的网络错误不会覆盖新身份同步状态', async function () {
    var rejectOld;
    var c = client(null, function () { return new Promise(function (_, reject) { rejectOld = reject; }); }, { online: false });
    c.data.remote.identity(ID); c.data.remote.configure('http://example.invalid/v1'); c.data.log(event(1));
    c.context.navigator.onLine = true; var pending = c.data.remote.flush();
    c.context.navigator.onLine = false; c.data.remote.identity(OTHER);
    rejectOld(new Error('old failed')); await pending;
    assert.equal(c.data.remote.lastError, ''); assert.equal(c.data.remote.timer, null); c.dispose();
  });
  await test('切回本地后新增记录，重新启用原服务不会丢失', async function () {
    var c = client(null, null, { online: false }); c.data.remote.configure(base); c.data.log(event(1));
    c.data.remote.configure(''); c.data.log(event(2)); c.data.remote.configure(base);
    c.context.navigator.onLine = true; assert.equal((await c.data.remote.flush()).ok, true);
    assert.deepEqual(plain(c.data.trail().map(function (e) { return e.at; })), [1, 2]); c.dispose();
  });
  await test('导入后后台同步，清空则断开同步且不删除远端历史', async function () {
    var c = client(null, null, { online: false }); c.data.remote.identity('1111abcd2222efab'); c.data.remote.configure(base);
    assert.equal(c.data.importAll(JSON.stringify(trace([event(77)], { customTemplates: [spring] }))).ok, true);
    c.context.navigator.onLine = true; assert.equal((await c.data.remote.flush()).ok, true);
    c.data.clear(); assert.equal(c.data.trail().length, 0); assert.equal(c.data.remote.mode, 'local');
    assert.equal((await request(base, '/trace', 'GET', undefined, '1111abcd2222efab')).body.events.length, 1); c.dispose();
  });
  await test('超时释放请求锁并保留队列', async function () {
    var c = client(null, function () { return new Promise(function () {}); }, { online: false, fastTimeout: true });
    c.data.remote.configure('http://example.invalid/v1'); c.data.log(event(1)); c.context.navigator.onLine = true;
    var guard = setTimeout(function () {}, 1000);
    var result = await c.data.remote.flush(); clearTimeout(guard);
    assert.equal(result.ok, false); assert.equal(c.data.remote.inflight, false); assert.equal(c.data.remote.pending(), 1); c.dispose();
  });
}
main().catch(function (e) { failures.push('运行异常'); console.error(e.stack || e); }).finally(async function () {
  clients.forEach(function (c) { c.dispose(); });
  await Promise.all(servers.filter(function (s) { return s.listening; }).map(close));
  // 删除前校验绝对路径确实是本次创建的临时目录。
  var resolved = fs.realpathSync(tmp), parent = fs.realpathSync(testRoot);
  if (path.dirname(resolved) === parent && /^ttk-api-/.test(path.basename(resolved))) fs.rmSync(resolved, { recursive: true, force: true });
  console.log('\n验收：' + (total - failures.length) + '/' + total + ' 项通过');
  process.exitCode = failures.length ? 1 : 0;
});
