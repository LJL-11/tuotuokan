'use strict';
/* #19 / #21：真实 HTTP 模拟上游。无真实密钥、无外部模型请求。 */
var assert = require('assert/strict');
var fs = require('fs');
var path = require('path');
var http = require('http');
var vm = require('vm');
var createServer = require('./server').createServer;
var validate = require('./validate');
var spring = require('../../contracts/examples/spring.json');
module.exports = async function (h) {
  var mode = 'choices', seen = [], release, reached;
  var upstream = http.createServer(function (req, res) {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      var body = JSON.parse(Buffer.concat(chunks).toString());
      seen.push({ headers: req.headers, body: body, url: req.url });
      var spec = h.plain(spring);
      spec.id = 'generated';
      function reply() {
        if (res.destroyed) return;
        if (mode === 'invalid-json') return res.end('{');
        if (mode === 'invalid-spec') return res.end(JSON.stringify({ id: 'broken' }));
        if (mode === 'oversized') return res.end('x'.repeat(1024 * 1024 + 1));
        if (mode === 'server-error' || mode === 'busy' || mode === 'redirect') {
          res.writeHead(mode === 'busy' ? 429 : (mode === 'redirect' ? 302 : 500), { Location: 'http://127.0.0.1:1/never' });
          return res.end(JSON.stringify({ debug: 'test-only-secret-never-real' }));
        }
        if (mode === 'malicious') spec.series[0].expr = 'window.alert(1)';
        if (mode === 'spec') return res.end(JSON.stringify({ spec: spec }));
        if (mode === 'direct') return res.end(JSON.stringify(spec));
        res.end(JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify(spec) + '\n```' } }], debug: 'discard' }));
      }
      if (mode === 'hold') { release = reply; if (reached) reached(); }
      else if (mode === 'timeout') { /* 等待代理到时中止连接 */ }
      else reply();
    });
  });
  var upstreamBase = await h.listen(upstream);
  var llm = { url: upstreamBase + '/chat/completions', apiKey: 'test-only-secret-never-real', model: 'test-model', rateLimit: 200 };
  var api = await h.listen(createServer({ dataDir: path.join(h.tmp, 'generate'), llm: llm }));
  var body = { concept: '阻尼共振', model: '', prompt: '请按 TemplateSpec 返回 JSON' };
  async function call(url, data) { return h.request(url || api, '/generate', 'POST', data || body); }
  function runtime(c) {
    ['src/core/engine.js', 'src/core/expr.js', 'src/model/dsl.js', 'src/model/generator.js'].forEach(function (file) {
      vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../..', file), 'utf8'), c.context, { filename: file });
    });
    // 保留真实 HTTP；不注入 generator.transport，确实穿过 fetchSpec → 服务端 → 上游。
    c.context.fetch = async function (url, init) {
      assert.equal(init.headers.Authorization, undefined);
      var target = new URL(url);
      var result = await h.request(target.origin + '/v1', target.pathname.slice(3), init.method,
        init.body ? JSON.parse(init.body) : undefined, init.headers['X-Anon-Id']);
      return { ok: result.status >= 200 && result.status < 300, status: result.status,
        text: async function () { return JSON.stringify(result.body); }, json: async function () { return result.body; } };
    };
    return c.context.TTK;
  }
  await h.test('#19 未配置代理返回 503；健康探针、CORS 不受影响', async function () {
    var disabled = await h.listen(createServer({ dataDir: path.join(h.tmp, 'disabled'), llm: {} }));
    assert.equal((await call(disabled)).status, 503);
    assert.equal((await h.request(disabled, '/health')).status, 200);
    var preflight = await h.request(disabled, '/generate', 'OPTIONS');
    assert.equal(preflight.status, 204); assert.equal(preflight.headers['access-control-allow-origin'], '*');
  });
  await h.test('#19 拒绝非法环境变量，错误不暴露地址或密钥', function () {
    for (var change of [{ url: 'not-a-url' }, { url: 'http://example.invalid/v1' }, { timeoutMs: 8000 }, { rateLimit: 0 }, { apiKey: 'bad\nkey' }]) {
      assert.throws(function () { createServer({ llm: Object.assign({}, llm, change) }); }, /^Error: 模型代理环境变量配置非法，请检查 TTK_LLM_\*$/);
    }
  });
  await h.test('#19 输入字段、长度、类型与密钥字段校验，非法输入不调用上游', async function () {
    var before = seen.length;
    for (var change of [{ concept: '' }, { concept: 1 }, { concept: 'x'.repeat(201) }, { prompt: '' }, { prompt: 'x'.repeat(24001) }, { model: {} }, { apiKey: 'forbidden' }, { endpoint: 'http://example.invalid' }]) {
      assert.equal((await call(api, Object.assign({}, body, change))).status, 400);
    }
    assert.equal(seen.length, before);
  });
  await h.test('#19 三种上游响应均归一为 TemplateSpec；密钥仅在服务端上游请求头', async function () {
    for (var form of ['choices', 'spec', 'direct']) {
      mode = form;
      var result = await call();
      assert.equal(result.status, 200); assert.deepEqual(validate.template(result.body.spec), []);
      assert.deepEqual(Object.keys(result.body), ['spec']); assert.equal(result.body.spec.source, 'llm');
      assert.ok(!JSON.stringify(result.body).includes(llm.apiKey));
    }
    var sent = seen[seen.length - 1];
    assert.equal(sent.url, '/v1/chat/completions'); assert.equal(sent.headers.authorization, 'Bearer ' + llm.apiKey);
    assert.equal(sent.headers['x-anon-id'], undefined); assert.equal(sent.body.model, 'test-model'); assert.equal(sent.body.stream, false);
    assert.deepEqual(sent.body.messages, [{ role: 'system', content: body.prompt }, { role: 'user', content: body.concept }]);
    await call(api, Object.assign({}, body, { model: 'chosen-model' }));
    assert.equal(seen[seen.length - 1].body.model, 'chosen-model');
    assert.equal(fs.existsSync(path.join(h.tmp, 'generate', 'db.json')), false);
  });
  await h.test('#19 TTK_LLM_THINKING=off 声明 enable_thinking:false，默认不发送，非法值拒绝启动', async function () {
    mode = 'choices';
    var thinking = await h.listen(createServer({ dataDir: path.join(h.tmp, 'thinking'), llm: Object.assign({}, llm, { thinking: 'off' }) }));
    await call(thinking);
    assert.equal(seen[seen.length - 1].body.enable_thinking, false);
    await call(api);
    assert.equal(seen[seen.length - 1].body.enable_thinking, undefined);
    assert.throws(function () { createServer({ dataDir: path.join(h.tmp, 'bad-thinking'), llm: Object.assign({}, llm, { thinking: 'maybe' }) }); }, /^Error: 模型代理环境变量配置非法，请检查 TTK_LLM_\*$/);
  });
  await h.test('#19 上游非法 JSON / 模板 / 超大响应 / 500 / 重定向不透传，429 明确返回', async function () {
    for (var errorMode of ['invalid-json', 'invalid-spec', 'oversized', 'server-error', 'redirect', 'busy']) {
      mode = errorMode; var result = await call();
      assert.equal(result.status, mode === 'busy' ? 429 : 502);
      assert.ok(result.body.error); assert.ok(!JSON.stringify(result.body).includes(llm.apiKey));
    }
  });
  await h.test('#19 总超时返回 504 并释放并发名额，后续请求仍成功', async function () {
    var fast = await h.listen(createServer({ dataDir: path.join(h.tmp, 'fast'), llm: Object.assign({}, llm, { timeoutMs: 150, maxConcurrent: 1 }) }));
    mode = 'timeout'; assert.equal((await call(fast)).status, 504);
    mode = 'choices'; assert.equal((await call(fast)).status, 200);
  });
  await h.test('#19 全局分钟限流与并发限流返回 429 / Retry-After，不按 IP 留痕', async function () {
    var limited = await h.listen(createServer({ dataDir: path.join(h.tmp, 'limited'), llm: Object.assign({}, llm, { rateLimit: 1 }) }));
    assert.equal((await call(limited)).status, 200);
    var blocked = await call(limited); assert.equal(blocked.status, 429); assert.ok(Number(blocked.headers['retry-after']) > 0);
    var single = await h.listen(createServer({ dataDir: path.join(h.tmp, 'single'), llm: Object.assign({}, llm, { maxConcurrent: 1 }) }));
    mode = 'hold';
    var ready = new Promise(function (resolve) { reached = resolve; });
    var first = call(single); await ready;
    try { assert.equal((await call(single)).status, 429); }
    finally { mode = 'choices'; release(); reached = null; }
    assert.equal((await first).status, 200); assert.equal((await call(single)).status, 200);
  });
  await h.test('#19 生成器真实 HTTP 成功挂载；非法公式、500、超时均重试后诚实降级', async function () {
    var c = h.client(), ttk = runtime(c);
    ttk.generator.configure({ endpoint: api + '/generate' }); mode = 'choices';
    var result = await ttk.generator.generate(body.concept, { ids: ['generated'] });
    assert.equal(result.ai, true); assert.notEqual(result.spec.id, 'generated');
    assert.equal(ttk.generator.mount(ttk.createEngine(), result.spec).ok, true);
    var fast = await h.listen(createServer({ dataDir: path.join(h.tmp, 'client-fast'), llm: Object.assign({}, llm, { timeoutMs: 150 }) }));
    for (var failure of ['malicious', 'server-error', 'invalid-json', 'timeout']) {
      mode = failure; ttk.generator.configure({ endpoint: (failure === 'timeout' ? fast : api) + '/generate' });
      var before = seen.length, fallback = await ttk.generator.generate(body.concept);
      assert.equal(fallback.ai, false); assert.equal(fallback.attempts, 2); assert.equal(seen.length - before, 2);
      assert.equal(fallback.source, 'local-draft'); assert.equal(ttk.generator.mount(ttk.createEngine(), fallback.spec).ok, true);
    }
    c.dispose(); mode = 'choices';
  });
  await h.test('#21 模型 spec 纯本地保存、刷新恢复、导出导入及 id 去重后仍可编译，无网络请求', async function () {
    var store = new Map(), calls = 0, c = h.client(store, async function () { calls++; throw new Error('unexpected'); });
    var ttk = runtime(c), engine = ttk.createEngine();
    engine.register(ttk.dsl.compile(spring, ttk.dsl.validate(spring)));
    ttk.generator.configure({ endpoint: api + '/generate' });
    var result = await ttk.generator.generate(body.concept, { ids: ['generated', 'spring'] });
    var mounted = ttk.generator.mount(engine, result.spec);
    assert.equal(mounted.persist, true); assert.ok(mounted.spec); assert.equal(typeof mounted.tpl.compute, 'function');
    c.context.fetch = async function () { calls++; throw new Error('unexpected local request'); };
    c.data.saveCustom([h.plain(mounted.spec)]);
    assert.deepEqual(validate.trace(JSON.parse(c.data.exportAll())), []);
    var reloaded = h.client(store), reloadedTTK = runtime(reloaded);
    var saved = reloaded.data.custom()[0]; assert.equal(saved.source, 'llm');
    assert.equal(reloadedTTK.generator.mount(reloadedTTK.createEngine(), saved).ok, true);
    var imported = h.client(), importedTTK = runtime(imported);
    assert.equal(imported.data.importAll(c.data.exportAll()).ok, true);
    assert.equal(importedTTK.generator.mount(importedTTK.createEngine(), imported.data.custom()[0]).ok, true);
    ttk.generator.configure({ endpoint: '' });
    var draft = ttk.generator.mount(engine, ttk.generator.generate('本地草稿').spec);
    assert.equal(draft.persist, false); assert.equal(c.data.custom().length, 1);
    assert.equal(calls, 0); assert.equal(c.data.remote.mode, 'local');
    c.dispose(); reloaded.dispose(); imported.dispose();
  });
  await h.test('#21 模型模板上传后可由同 ID 新客户端读回；/templates 与快照同一份数据，重启仍可用', async function () {
    var dir = path.join(h.tmp, 'template-sync');
    var syncServer = createServer({ dataDir: dir, llm: {} }), sync = await h.listen(syncServer);
    var id = '9988aabb7766ccdd', c = h.client(null, null, { online: false });
    var ttk = runtime(c); ttk.generator.configure({ endpoint: api + '/generate' });
    var result = await ttk.generator.generate(body.concept);
    c.data.remote.identity(id); c.data.remote.configure(sync);
    c.data.saveCustom([h.plain(result.spec)]); c.context.navigator.onLine = true;
    assert.equal((await c.data.remote.flush()).ok, true);
    var list = (await h.request(sync, '/templates', 'GET', undefined, id)).body;
    assert.deepEqual(list, h.plain(c.data.custom())); assert.equal(list[0].source, 'llm');
    var revised = h.plain(list[0]); revised.brief = '经 /templates 更新';
    assert.equal((await h.request(sync, '/templates', 'PUT', revised, id)).status, 200);
    var other = h.client(null, null, { online: false }), otherTTK = runtime(other);
    other.data.remote.identity(id); other.data.remote.configure(sync); other.context.navigator.onLine = true;
    assert.equal((await other.data.remote.flush()).ok, true);
    assert.equal(other.data.custom()[0].brief, revised.brief);
    assert.equal(otherTTK.generator.mount(otherTTK.createEngine(), other.data.custom()[0]).ok, true);
    assert.deepEqual(validate.trace(JSON.parse(other.data.exportAll())), []);
    var stranger = (await h.request(sync, '/templates', 'GET', undefined, '1122334455667788')).body;
    assert.deepEqual(stranger, []); c.dispose(); other.dispose();
    await h.close(syncServer);
    sync = await h.listen(createServer({ dataDir: dir, llm: {} }));
    assert.equal((await h.request(sync, '/templates', 'GET', undefined, id)).body[0].brief, revised.brief);
  });
};
