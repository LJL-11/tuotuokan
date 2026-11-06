/* 拖拖看 · 概念输入与 AI 生成（队员 A · #I4 / #I5）
 * ---------------------------------------------------------------
 * 【状态】接口占位。骨架已由 index.html 加载（零副作用，可在控制台调试），当前只提供「诚实的本地降级」。
 * 【接入方式】在 app.js 的「生成沙盒」按钮里调用
 *            TTK.generator.recognize() → generate() → mount(engine, spec)。
 *
 * 三条不可破的约束：
 *  1. 模型输出永远是「数据」，必须先 dsl.validate + dsl.compile 才能进引擎，绝不执行模型给的代码。
 *  2. 没有模型时必须降级为 dsl.draft() 草稿，并在 UI 明示「本地草稿」，不得谎称 AI 生成。
 *  3. 模型密钥不许放前端。需要大模型时由队员 C 在 services/api 加服务端代理，这里只配 endpoint。
 */
(function (global) {
  'use strict';

  var TTK = global.TTK = global.TTK || {};
  var config = { enabled: false, endpoint: '', model: '' };

  /** 只接受服务端代理地址；任何 key/token 字段都会被忽略。 */
  function configure(options) {
    options = options || {};
    config.endpoint = String(options.endpoint || '');
    config.model = String(options.model || '');
    config.enabled = !!config.endpoint;
    return { enabled: config.enabled, endpoint: config.endpoint, model: config.model };
  }

  /**
   * 输入层：把任意输入映射到概念。
   * 现在只做文本关键词匹配（engine.findByQuery 的降级实现）。
   * TODO #I5：image / audio / 截图 OCR → 概念描述；识别失败要给出明确提示，不要返回空结果。
   * @returns {{ok:boolean, conceptId:(string|null), concept:string, source:string, unsupported:boolean}}
   */
  function recognize(input) {
    var text = typeof input === 'string' ? input : String((input && input.text) || '');
    var engine = TTK.engine;
    var hit = engine && engine.findByQuery ? engine.findByQuery(text) : null;
    var hasUnsupportedMedia = !!(input && typeof input === 'object' && (input.image || input.audio || input.file));
    return {
      ok: !!hit,
      conceptId: hit ? hit.id : null,
      concept: text.trim(),
      source: 'keyword-fallback',
      unsupported: hasUnsupportedMedia
    };
  }

  /**
   * 建模层：把概念变成 TemplateSpec。
   * 现在返回本地草稿（明确标注 ai:false）。
   * TODO #I4：POST 到 config.endpoint，body = { concept, prompt: TTK.dsl.prompt(concept) }，
   *           严格只取 JSON、dsl.validate 校验、失败重试一次，再降级。
   * @returns {{ok:boolean, spec:object, source:string, ai:boolean}}
   */
  function generate(concept) {
    return {
      ok: true,
      spec: TTK.dsl.draft(concept),
      source: 'local-draft',
      ai: false
    };
  }

  /** 把 TemplateSpec 安全挂载进引擎。任何来源的 spec 都必须走这里。 */
  function mount(engine, spec) {
    var ids = engine.all().map(function (t) { return t.id; });
    var v = TTK.dsl.validate(spec, ids);
    if (!v.ok) return { ok: false, errors: v.errors };
    var tpl;
    try { tpl = TTK.dsl.compile(spec, v); engine.register(tpl); }
    catch (e) { return { ok: false, errors: [e.message] }; }
    return { ok: true, tpl: tpl, source: spec && spec.source };
  }

  TTK.generator = {
    configure: configure,
    recognize: recognize,
    generate: generate,
    mount: mount,
    config: function () { return { enabled: config.enabled, endpoint: config.endpoint, model: config.model }; },
    TODO: ['#I4 LLM 生成 + 输出校验 + 降级', '#I5 多模态概念识别', '#I6 精修模板与先修关系', '与队员 C 约定 /generate 代理端点']
  };
})(window);
