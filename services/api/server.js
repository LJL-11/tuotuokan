'use strict';
/* 拖拖看匿名同步服务 · 秦 #I10。零依赖；业务库和日志均不采集 IP 或设备指纹。 */
var http = require('http');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var check = require('./validate');
var ANON_RE = /^[0-9a-f]{16}$/;
var MAX_BODY = 2 * 1024 * 1024;
function emptyDb() { return { identities: {}, events: {}, progress: {}, stuck: {}, templates: {} }; }
function key(e) { return JSON.stringify([e.at, e.tpl, e.reason]); }
function mergeList(a, b, keyFn) {
  var seen = new Set();
  return a.concat(b).filter(function (e) { var k = keyFn(e); if (seen.has(k)) return false; seen.add(k); return true; });
}
function cleanEvent(e) {
  return { at: e.at, tpl: e.tpl, reason: e.reason, params: e.params,
    name: typeof e.name === 'string' ? e.name : '', insight: typeof e.insight === 'string' ? e.insight : '' };
}
function send(res, code, body) {
  var text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text),
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Anon-Id',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Cache-Control': 'no-store'
  });
  res.end(text);
}
function readBody(req, res, cb) {
  var chunks = [], size = 0, done = false;
  req.on('data', function (chunk) {
    if (done) return;
    size += chunk.length;
    if (size > MAX_BODY) { done = true; send(res, 413, { error: '请求体超过 2 MiB' }); return; }
    chunks.push(chunk);
  });
  req.on('end', function () {
    if (done) return;
    done = true;
    var body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch (e) { return send(res, 400, { error: 'JSON 解析失败' }); }
    if (!check.object(body)) return send(res, 400, { error: '请求体必须是对象' });
    try { cb(body); }
    catch (e) {
      console.error('[api] 写入失败：' + (e.code || e.name));
      send(res, 500, { error: '数据保存失败，请稍后重试' });
    }
  });
  req.on('error', function () { if (!done) { done = true; send(res, 400, { error: '请求未完整接收' }); } });
}
function createServer(options) {
  options = options || {};
  var directory = options.dataDir || process.env.TTK_DB_DIR || path.join(__dirname, '.data');
  var dbFile = path.join(directory, 'db.json'), db;
  try {
    db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    if (!check.object(db) || Object.keys(emptyDb()).some(function (k) { return !check.object(db[k]); })) throw new Error('数据库结构损坏');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // 损坏的库不能静默当空库覆盖。
    db = emptyDb();
  }
  // 写临时文件并原子替换；只有落盘成功才对客户端确认。失败不修改内存库。
  function commit(change) {
    var next = JSON.parse(JSON.stringify(db));
    var result = change(next);
    fs.mkdirSync(directory, { recursive: true });
    var temp = dbFile + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(next), 'utf8');
    fs.renameSync(temp, dbFile);
    db = next;
    return result;
  }
  function touch(store, id) {
    if (!store.identities[id]) store.identities[id] = { createdAt: new Date().toISOString() };
  }
  function append(store, id, events) {
    var old = store.events[id] || [];
    var list = mergeList(old, events.map(cleanEvent), key).sort(function (a, b) { return a.at - b.at; });
    store.events[id] = list;
    return list.length - old.length;
  }
  function trace(id) {
    return {
      schema: 'ttk.learning-trace.v1', exportedAt: new Date().toISOString(),
      notice: '匿名导出：不含姓名、学校、设备标识', events: db.events[id] || [],
      progress: db.progress[id] || {}, stuck: db.stuck[id] || [],
      customTemplates: Object.values(db.templates[id] || {})
    };
  }
  function mergeSnapshot(store, id, body) {
    var progress = store.progress[id] || (store.progress[id] = {});
    Object.keys(body.progress || {}).forEach(function (k) {
      Object.defineProperty(progress, k, { value: !!(progress[k] === true || body.progress[k]), enumerable: true, writable: true, configurable: true });
    });
    store.stuck[id] = mergeList(store.stuck[id] || [], (body.stuck || []).map(function (e) { return { at: e.at, tpl: e.tpl }; }), function (e) {
      return JSON.stringify([e.at, e.tpl]);
    }).sort(function (a, b) { return a.at - b.at; });
    var templates = store.templates[id] || (store.templates[id] = {});
    (body.customTemplates || []).forEach(function (spec) {
      Object.defineProperty(templates, spec.id, { value: spec, enumerable: true, writable: true, configurable: true });
    });
  }
  var server = http.createServer(function (req, res) {
    var route = String(req.url || '').split('?')[0];
    if (route.slice(0, 4) !== '/v1/') return send(res, 404, { error: '未知路径' });
    route = route.slice(3);
    if (req.method === 'OPTIONS') return send(res, 204);
    if (route === '/health' && req.method === 'GET') return send(res, 200, { ok: true });
    if (route === '/auth/anonymous' && req.method === 'POST') {
      return readBody(req, res, function (body) {
        var id;
        if (body.existingId !== undefined) {
          id = typeof body.existingId === 'string' ? body.existingId.trim().toLowerCase() : '';
          if (!ANON_RE.test(id)) return send(res, 400, { error: '匿名 ID 需为 16 位十六进制' });
        } else {
          do { id = crypto.randomBytes(8).toString('hex'); } while (db.identities[id]);
        }
        commit(function (store) { touch(store, id); });
        return send(res, 200, { anonId: id, createdAt: db.identities[id].createdAt });
      });
    }
    var known = (route === '/events' && req.method === 'POST') || (route === '/trace' && req.method === 'GET') ||
      (route === '/trace/import' && req.method === 'POST') || (route === '/templates' && ['GET', 'PUT'].indexOf(req.method) >= 0);
    if (!known) return send(res, 404, { error: '未知路径' });
    var id = String(req.headers['x-anon-id'] || '').trim().toLowerCase();
    if (!ANON_RE.test(id)) return send(res, 401, { error: '缺少或非法的 X-Anon-Id' });
    if (route === '/trace') return send(res, 200, trace(id));
    if (route === '/templates' && req.method === 'GET') return send(res, 200, Object.values(db.templates[id] || {}));
    readBody(req, res, function (body) {
      if (route === '/events') {
        if (body.anonymous !== true || !Array.isArray(body.events)) return send(res, 400, { error: '必须提供 anonymous: true 和 events 数组' });
        var errors = [];
        body.events.forEach(function (event, i) { check.event(event).forEach(function (e) { errors.push({ index: i, path: e.path, error: e.error }); }); });
        var extra = { schema: 'ttk.learning-trace.v1', exportedAt: new Date().toISOString(), events: [] };
        ['progress', 'stuck'].forEach(function (k) { if (body[k] !== undefined) extra[k] = body[k]; });
        errors = errors.concat(check.trace(extra));
        if (errors.length) return send(res, 400, { error: '事件格式不合法', details: errors });
        var added = commit(function (store) { touch(store, id); mergeSnapshot(store, id, extra); return append(store, id, body.events); });
        return send(res, 202, { accepted: body.events.length, added: added, duplicates: body.events.length - added });
      }
      if (route === '/trace/import') {
        var invalid = check.trace(body);
        if (invalid.length) return send(res, 400, { error: '轨迹格式不合法', details: invalid });
        commit(function (store) {
          touch(store, id);
          append(store, id, body.events);
          mergeSnapshot(store, id, body);
        });
        return send(res, 200, { ok: true, events: body.events.length });
      }
      var issues = check.template(body);
      if (issues.length) return send(res, 422, { error: '模板格式不合法', details: issues });
      commit(function (store) {
        touch(store, id);
        var templates = store.templates[id] || (store.templates[id] = {});
        Object.defineProperty(templates, body.id, { value: body, enumerable: true, writable: true, configurable: true });
      });
      return send(res, 200, { ok: true, id: body.id });
    });
  });
  server.dbFile = dbFile;
  return server;
}
module.exports = { createServer: createServer };
if (require.main === module) {
  var server = createServer();
  var port = Number(process.env.PORT || 8787);
  var host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, function () { console.log('匿名同步服务：http://' + host + ':' + server.address().port + '/v1'); });
}
