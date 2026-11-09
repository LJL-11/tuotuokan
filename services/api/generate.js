'use strict';
/* 秦 · #19。只转发纯文本并校验数据形状；公式仍由客户端 DSL / expr 校验。 */
var http = require('http');
var https = require('https');
var check = require('./validate');
var schema = require('../../contracts/template.schema.json');
var MAX_RESPONSE = 1024 * 1024;
function positive(value, fallback, max) {
  if (value === undefined || value === '') return fallback;
  var n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error('模型代理配置非法');
  return n;
}
function settings(options) {
  var env = process.env, supplied = options !== undefined;
  options = options || {};
  function get(key, name) { return supplied ? options[key] : env[name]; }
  var url = get('url', 'TTK_LLM_URL'), target = url ? new URL(url) : null;
  if (target && (target.username || target.password || target.hash || target.search ||
      (target.protocol !== 'https:' && !(target.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].indexOf(target.hostname) >= 0)))) throw new Error('模型代理地址非法');
  var key = get('apiKey', 'TTK_LLM_API_KEY') || '';
  var model = get('model', 'TTK_LLM_MODEL') || '';
  if (typeof key !== 'string' || /[\x00-\x1f\x7f]/.test(key) || !validModel(model)) throw new Error('模型代理配置非法');
  var thinking = get('thinking', 'TTK_LLM_THINKING') || '';
  if (['', 'on', 'off'].indexOf(thinking) < 0) throw new Error('模型代理配置非法');
  return {
    target: target, apiKey: key, model: model, thinking: thinking,
    timeoutMs: positive(get('timeoutMs', 'TTK_LLM_TIMEOUT_MS'), 6500, 7000),
    rateLimit: positive(get('rateLimit', 'TTK_LLM_RATE_LIMIT'), 20, 10000),
    maxConcurrent: positive(get('maxConcurrent', 'TTK_LLM_MAX_CONCURRENT'), 2, 100)
  };
}
function validModel(value) { return typeof value === 'string' && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value); }
function inputError(body) {
  if (Object.keys(body).some(function (k) { return ['concept', 'model', 'prompt'].indexOf(k) < 0; })) return '只接收 concept、model、prompt';
  if (typeof body.concept !== 'string' || !body.concept.trim() || body.concept.length > 200) return 'concept 需为 1–200 字的概念';
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 24000) return 'prompt 需为 1–24000 字的模板提示';
  if (body.model !== undefined && !validModel(body.model)) return 'model 需为不超过 128 字的模型名';
  return '';
}
function extractSpec(payload) {
  var value = payload;
  if (check.object(value) && value.choices && value.choices[0] && value.choices[0].message) value = value.choices[0].message.content;
  if (typeof value === 'string') {
    var raw = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    value = JSON.parse(raw);
  }
  if (check.object(value) && check.object(value.spec)) value = value.spec;
  if (!check.object(value) || check.template(value).length) throw new Error('模型返回非法模板');
  // 不把供应商响应中的调试字段、凭证或其他元数据原样送回浏览器。
  var spec = {};
  Object.keys(schema.properties).forEach(function (k) {
    if (Object.prototype.hasOwnProperty.call(value, k)) spec[k] = value[k];
  });
  spec.source = 'llm';
  return spec;
}
function upstream(config, body, model, onCancel) {
  return new Promise(function (resolve, reject) {
    var done = false, timer, req;
    function finish(error, spec) {
      if (done) return;
      done = true; clearTimeout(timer);
      if (error) reject(error); else resolve(spec);
    }
    function fail(status, message) { finish({ status: status, message: message }); if (req) req.destroy(); }
    var payload = { model: model, stream: false, messages: [
      { role: 'system', content: body.prompt }, { role: 'user', content: body.concept.trim() }
    ] };
    // 部分混合推理模型（如百炼 deepseek 系列）默认先思考再输出，完整模板生成可达 30s，
    // 远超总超时；TTK_LLM_THINKING=off 时显式关闭思考模式（其他供应商不受影响，默认不发该字段）。
    if (config.thinking === 'off') payload.enable_thinking = false;
    payload = JSON.stringify(payload);
    var headers = { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (config.apiKey) headers.Authorization = 'Bearer ' + config.apiKey;
    req = (config.target.protocol === 'https:' ? https : http).request(config.target, {
      method: 'POST', headers: headers, agent: false
    }, function (res) {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.destroy();
        return fail(res.statusCode === 429 ? 429 : 502, res.statusCode === 429 ? '模型服务繁忙，请稍后重试' : '模型服务请求失败');
      }
      var chunks = [], size = 0;
      res.on('data', function (chunk) {
        size += chunk.length;
        if (size > MAX_RESPONSE) { res.destroy(); fail(502, '模型响应超过 1 MiB'); return; }
        chunks.push(chunk);
      });
      res.on('end', function () {
        if (done) return;
        try { finish(null, extractSpec(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
        catch (e) { fail(502, '模型返回的 JSON 或模板格式不合法'); }
      });
      res.on('error', function () { fail(502, '模型响应未完整接收'); });
      res.on('aborted', function () { fail(502, '模型响应未完整接收'); });
    });
    req.on('error', function () { fail(502, '无法连接模型服务'); });
    timer = setTimeout(function () { fail(504, '模型生成超时'); }, config.timeoutMs);
    onCancel(function () { fail(502, '客户端已断开'); });
    req.end(payload);
  });
}
function createGenerate(options) {
  var config;
  try { config = settings(options); }
  catch (e) { throw new Error('模型代理环境变量配置非法，请检查 TTK_LLM_*'); }
  var started = Date.now(), count = 0, active = 0;
  return async function (body, res, send) {
    var invalid = inputError(body);
    if (invalid) return send(res, 400, { error: invalid });
    var model = (body.model || config.model).trim();
    if (!config.target || !model) return send(res, 503, { error: '模型代理尚未配置地址或模型' });
    var now = Date.now();
    if (now - started >= 60000) { started = now; count = 0; }
    if (count >= config.rateLimit || active >= config.maxConcurrent) {
      res.setHeader('Retry-After', String(count >= config.rateLimit ? Math.max(1, Math.ceil((60000 - (now - started)) / 1000)) : 1));
      return send(res, 429, { error: '生成请求过于频繁，请稍后重试' });
    }
    count++; active++;
    var cancel;
    function disconnected() { if (!res.writableEnded && cancel) cancel(); }
    res.on('close', disconnected);
    try {
      var spec = await upstream(config, body, model, function (fn) { cancel = fn; });
      if (!res.destroyed) send(res, 200, { spec: spec });
    } catch (e) {
      if (!res.destroyed) {
        if (e.status === 429) res.setHeader('Retry-After', '1');
        send(res, e.status || 502, { error: e.status ? e.message : '模型生成失败' });
      }
    } finally { active--; res.removeListener('close', disconnected); }
  };
}
module.exports = { createGenerate: createGenerate };
