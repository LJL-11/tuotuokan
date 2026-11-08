/* 拖拖看 · 概念输入与 AI 生成（姜 · #I4 / #I5）
 * ---------------------------------------------------------------
 * 接入方式：app.js 的「生成沙盒」调用
 *   recognize() →（未收录时）generate() → mount(engine, spec)。
 *
 * 三条不可破的约束：
 *  1. 模型输出永远是「数据」。先 JSON 化去掉函数，再 dsl.validate + dsl.compile，
 *     公式只走 expr 白名单，绝不把模型文本当代码执行。
 *  2. 没配代理、断网、或校验两次仍失败时，降级为 dsl.draft()，ai 必须为 false。
 *  3. 模型密钥不许放前端。这里只收 endpoint / model；apiKey、token 等字段直接丢掉。
 *
 * 代理约定（密钥留在秦的 services/api，本文件不实现服务端）：
 *   POST <endpoint>
 *   Content-Type: application/json
 *   { "concept", "model", "prompt" }
 *   响应可以是 TemplateSpec，或 { "spec": TemplateSpec }，
 *   或 { "choices": [{ "message": { "content": "<JSON 或 ```json>" } }] }。
 *   客户端不附带 Authorization。校验失败或网络失败会再请求一次，然后降级。
 *
 * 图片 / 语音：只在本机看文件名，以及画面或文件里能读到的文字。字节不上传。
 * 浏览器若提供本机文字识别，也只在本机做。认不出就说明，不编造概念。
 * recognize().level：supported 文字，fallback 文件名或图片内文字，unsupported 纯语音或没有可读文字的图。
 * mount() 成功时多返回 spec（可 JSON 序列化）和 persist。只有 source 为 llm 时 persist 为 true；本地草稿不落盘。
 */
(function (global) {
  'use strict';

  var TTK = global.TTK = global.TTK || {};
  var config = { enabled: false, endpoint: '', model: '', transport: null };

  function configure(options) {
    options = options || {};
    config.endpoint = String(options.endpoint || '');
    config.model = String(options.model || '');
    config.transport = typeof options.transport === 'function' ? options.transport : null;
    config.enabled = !!config.endpoint;
    return publicConfig();
  }

  function publicConfig() {
    return { enabled: config.enabled, endpoint: config.endpoint, model: config.model };
  }

  function mediaName(value) {
    if (value == null) return '';
    if (typeof value === 'string') {
      if (value.indexOf('data:') === 0 || value.length > 80) return '';
      return value.trim();
    }
    var name = value.name || value.filename || '';
    return String(name).replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 80);
  }

  function mediaParts(input) {
    if (!input || typeof input !== 'object') return { present: false, label: '' };
    var present = !!(input.image || input.audio || input.file);
    var label = mediaName(input.image) || mediaName(input.file) || mediaName(input.audio);
    return { present: present, label: label };
  }

  function stripTail(text) {
    return String(text || '').trim().toLowerCase()
      .replace(/[?？!！。，,\s]+$/g, '')
      .replace(/(是什么|什么意思|是啥|吗|呢)$/g, '')
      .trim();
  }

  /* 关键词降级就是 engine.findByQuery。
   * 只有一种情况退回：整个查询是「一个短关键词再粘上至少两个字」的未收录名字，
   * 例如「阻尼共振」。段落里出现关键词、或同一概念的多个关键词，仍沿用原匹配。 */
  function unlistedExtension(engine, text, hit) {
    var q = stripTail(text);
    if (!q || !hit || q.length > 16 || !engine || typeof engine.all !== 'function') return false;
    var found = [];
    engine.all().forEach(function (t) {
      (t.keywords || []).concat([t.name, t.id]).forEach(function (w) {
        var s = String(w || '').trim().toLowerCase();
        if (s && q.indexOf(s) >= 0) found.push(s);
      });
    });
    if (!found.length) return false;
    found.sort(function (a, b) { return b.length - a.length; });
    if (q === found[0]) return false;
    var own = 0;
    (hit.keywords || []).concat([hit.name, hit.id]).forEach(function (w) {
      var s = String(w || '').trim().toLowerCase();
      if (s && s !== String(hit.id || '').toLowerCase() && q.indexOf(s) >= 0) own += 1;
    });
    if (own >= 2) return false;
    return q.indexOf(found[0]) === 0 && q.length - found[0].length >= 2;
  }

  function keywordHit(engine, text) {
    var q = stripTail(text);
    if (!q || !engine || typeof engine.findByQuery !== 'function') return null;
    var hit = engine.findByQuery(q);
    if (!hit || unlistedExtension(engine, q, hit)) return null;
    return hit;
  }

  function clipText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  function bytesOf(value) {
    if (!value) return null;
    if (typeof Uint8Array !== 'undefined' && value instanceof Uint8Array) return value;
    if (Array.isArray(value)) return new Uint8Array(value);
    return null;
  }

  function utf8Decode(bytes) {
    if (!bytes || !bytes.length) return '';
    if (typeof TextDecoder === 'function') {
      try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); }
      catch (e) { /* 换一种解码 */ }
    }
    var raw = '';
    var i;
    for (i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);
    try { return decodeURIComponent(escape(raw)); }
    catch (e2) { return raw; }
  }

  function textFromMarkup(raw) {
    var s = String(raw || '');
    if (!s) return '';
    if (s.indexOf('<') < 0) return clipText(s);
    var parts = [];
    var re = /<text\b[^>]*>([\s\S]*?)<\/text>/gi;
    var found;
    while ((found = re.exec(s))) parts.push(found[1].replace(/<[^>]+>/g, ' '));
    return clipText(parts.join(' '));
  }

  function pngChunkText(type, data) {
    var end = 0;
    while (end < data.length && data[end] !== 0) end += 1;
    if (type === 'tEXt') return utf8Decode(data.subarray(end + 1));
    var flag = data[end + 1];
    var cursor = end + 3;
    if (cursor > data.length || flag !== 0) return '';
    while (cursor < data.length && data[cursor] !== 0) cursor += 1;
    cursor += 1;
    while (cursor < data.length && data[cursor] !== 0) cursor += 1;
    cursor += 1;
    return utf8Decode(data.subarray(cursor));
  }

  function textFromPng(bytes) {
    bytes = bytesOf(bytes);
    if (!bytes || bytes.length < 8) return '';
    var sig = [137, 80, 78, 71, 13, 10, 26, 10];
    var i;
    for (i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return '';
    var out = [];
    var p = 8;
    while (p + 12 <= bytes.length) {
      var len = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
      if (len > 8000000 || p + 12 + len > bytes.length) break;
      var type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
      if (type === 'tEXt' || type === 'iTXt') out.push(pngChunkText(type, bytes.subarray(p + 8, p + 8 + len)));
      if (type === 'IEND') break;
      p += 12 + len;
    }
    return clipText(out.join(' '));
  }

  function extractMediaText(input) {
    if (!input || typeof input !== 'object') return '';
    var image = input.image || input.file;
    var parts = [];
    function push(value) {
      var s = clipText(value);
      if (s) parts.push(s);
    }
    if (typeof image === 'string') push(textFromMarkup(image));
    else if (image && typeof image === 'object') {
      push(image.text);
      push(image.alt);
      push(image.description);
      if (!image.text && !image.alt && !image.description) {
        push(textFromMarkup(image.body || image.svg || ''));
        push(textFromPng(image.bytes));
      }
    }
    return clipText(parts.join(' '));
  }

  /**
   * 文本走 findByQuery。图片读取本机文字；语音只看文件名。
   * 字节不离开浏览器。认不出时 message 一定非空，conceptId 保持空。
   */
  function recognize(input) {
    var text = typeof input === 'string' ? input : String((input && input.text) || '');
    text = text.trim().slice(0, 200);
    var media = mediaParts(input);
    var extracted = media.present ? extractMediaText(input) : '';
    var engine = TTK.engine;
    var textHit = text ? keywordHit(engine, text) : null;
    var contentHit = !text && extracted ? keywordHit(engine, extracted) : null;
    var nameHit = !text && !contentHit && media.label ? keywordHit(engine, media.label) : null;
    var hit = textHit || contentHit || nameHit;
    var concept = hit ? hit.name : (text || extracted || '');
    var audioOnly = !!(input && typeof input === 'object' && input.audio && !input.image && !input.file);
    var message = '';
    if (hit && textHit && media.present) message = '已按文字匹配到已收录概念。图片和语音内容没有上传。';
    else if (hit && contentHit) message = '已从图片里的文字认出「' + hit.name + '」。内容只在本机读取，没有上传。';
    else if (hit && nameHit) message = '只根据文件名在本机匹配，图片和语音内容没有上传。';
    else if (extracted) message = '从图片里读到「' + extracted.slice(0, 42) + '」，没有对上已收录概念。内容没有上传。';
    else if (audioOnly) message = '本机听不懂这段语音，没有上传。请改用文字，或把概念写进文件名。';
    else if (media.present) message = '没有认出这个概念。图片和语音只在本机查看，内容没有上传。';
    else if (!hit) message = text ? ('没有匹配到已收录的「' + text + '」。') : '请输入想弄懂的概念。';
    var source = 'none';
    if (textHit) source = 'keyword-fallback';
    else if (contentHit || extracted) source = 'image-text';
    else if (nameHit) source = 'filename';
    var level = 'unsupported';
    if (textHit || (text && !media.present)) level = 'supported';
    else if (contentHit || nameHit || extracted) level = 'fallback';
    return {
      ok: !!hit,
      conceptId: hit ? hit.id : null,
      concept: concept,
      source: source,
      level: level,
      unsupported: !!(media.present && !hit && !extracted),
      message: message
    };
  }

  function hash36(text) {
    var h = 2166136261;
    var str = String(text || '');
    var i;
    for (i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function validId(id) {
    return /^[a-z][a-z0-9_-]{1,30}$/.test(id || '');
  }

  function asData(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    try { return JSON.parse(JSON.stringify(obj)); }
    catch (e) { return null; }
  }

  function uniquify(spec, concept, ids) {
    var data = asData(spec);
    if (!data) return null;
    var taken = {};
    (ids || []).forEach(function (id) { taken[id] = 1; });
    var base = validId(data.id) ? data.id : ('g' + hash36(concept || data.name || 'concept'));
    base = base.slice(0, 28);
    var candidate = base;
    var n = 1;
    while (taken[candidate]) {
      n += 1;
      if (n > 50) {
        candidate = ('g' + hash36(String(concept) + ':' + n)).slice(0, 31);
        break;
      }
      candidate = (base + n).slice(0, 31);
    }
    data.id = candidate;
    return data;
  }

  function localResult(concept, reason, ids) {
    var spec = uniquify(TTK.dsl.draft(concept), concept, ids || []);
    if (spec) spec.source = 'local-draft';
    return {
      ok: !!spec,
      spec: spec,
      source: 'local-draft',
      ai: false,
      reason: reason || 'no-endpoint',
      attempts: 0
    };
  }

  function parseLooseJson(text) {
    var raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    var start = raw.indexOf('{');
    var end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      var obj = JSON.parse(raw.slice(start, end + 1));
      if (obj && obj.spec && typeof obj.spec === 'object' && !obj.params) return obj.spec;
      return obj;
    } catch (e) { return null; }
  }

  function extractSpec(payload) {
    if (payload == null) return null;
    if (typeof payload === 'string') return parseLooseJson(payload);
    if (typeof payload !== 'object') return null;
    if (payload.spec && typeof payload.spec === 'object') return payload.spec;
    if (payload.id && (payload.params || payload.series)) return payload;
    var choice = payload.choices && payload.choices[0] && payload.choices[0].message;
    if (choice && typeof choice.content === 'string') return parseLooseJson(choice.content);
    if (typeof payload.content === 'string') return parseLooseJson(payload.content);
    if (typeof payload.output === 'string') return parseLooseJson(payload.output);
    return null;
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var armed = false;
      // 校验脚本会把 setTimeout 换成「立刻调用」。这种同步触发还没武装，不能当成超时。
      var timer = setTimeout(function () {
        if (!armed || done) return;
        done = true;
        reject(new Error('timeout'));
      }, ms);
      armed = true;
      function finish(err, value) {
        if (done) return;
        done = true;
        if (typeof clearTimeout === 'function') clearTimeout(timer);
        if (err) reject(err);
        else resolve(value);
      }
      Promise.resolve(promise).then(function (value) { finish(null, value); }, function (err) { finish(err); });
    });
  }

  function fetchSpec(req) {
    if (typeof global.fetch !== 'function') return Promise.reject(new Error('当前环境没有 fetch'));
    return global.fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body
    }).then(function (res) {
      if (!res || !res.ok) throw new Error('代理返回 ' + (res && res.status));
      return res.text();
    });
  }

  function postSpec(concept) {
    var body;
    try {
      body = JSON.stringify({
        concept: concept,
        model: config.model,
        prompt: TTK.dsl.prompt(concept)
      });
    } catch (e) {
      return Promise.reject(e);
    }
    var req = {
      url: config.endpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: body
    };
    var sent;
    try {
      sent = config.transport ? config.transport(req) : fetchSpec(req);
    } catch (e) {
      return Promise.reject(e);
    }
    return withTimeout(Promise.resolve(sent).then(function (payload) {
      var spec = extractSpec(payload);
      if (!spec) throw new Error('响应里没有可解析的模板 JSON');
      return spec;
    }), 8000);
  }

  function remoteGenerate(concept, ids) {
    function once(n) {
      return postSpec(concept).then(function (raw) {
        var spec = uniquify(raw, concept, ids);
        var errors = ['响应不是合法模板'];
        var okSpec = false;
        if (spec) {
          spec.source = 'llm';
          var v = TTK.dsl.validate(spec, ids);
          okSpec = v.ok;
          errors = v.errors;
        }
        if (!okSpec) {
          if (n < 2) return once(n + 1);
          var invalid = localResult(concept, 'invalid', ids);
          invalid.attempts = n;
          invalid.errors = errors;
          return invalid;
        }
        return { ok: true, spec: spec, source: 'llm', ai: true, reason: '', attempts: n };
      }, function () {
        if (n < 2) return once(n + 1);
        var failed = localResult(concept, 'network', ids);
        failed.attempts = n;
        return failed;
      });
    }
    return once(1);
  }

  /**
   * 未配置代理时同步返回本地草稿（ai:false）。
   * 已配置时返回 Promise：校验通过则 ai:true，否则重试一次再降级。
   */
  function generate(concept, options) {
    var text = String(concept == null ? '' : concept).trim().slice(0, 200);
    var ids = options && Array.isArray(options.ids) ? options.ids : [];
    if (!config.enabled) return localResult(text, 'no-endpoint', ids);
    return remoteGenerate(text, ids);
  }

  /** 任何来源的 spec 都必须走这里才能进引擎。 */
  function mount(engine, spec) {
    var ids = engine.all().map(function (t) { return t.id; });
    var data = asData(spec);
    var v = TTK.dsl.validate(data, ids);
    if (!v.ok) return { ok: false, errors: v.errors };
    var tpl;
    try { tpl = TTK.dsl.compile(data, v); engine.register(tpl); }
    catch (e) { return { ok: false, errors: [e.message] }; }
    return {
      ok: true,
      tpl: tpl,
      source: data && data.source,
      spec: data,
      persist: !!(data && data.source === 'llm')
    };
  }

  TTK.generator = {
    configure: configure,
    recognize: recognize,
    generate: generate,
    mount: mount,
    config: publicConfig
  };
})(window);
