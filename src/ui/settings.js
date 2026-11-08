/* 拖拖看 · 本机设置（付 · 偿还 #19）
 * ---------------------------------------------------------------
 * 生成代理的 endpoint / model 是**本机设置**，不是学习轨迹：
 * 不进 events、不进同步队列、不进匿名导出 JSON、不带任何密钥。
 *
 * 所有读写仍然经过 TTK.data 的 read / write（silent 模式），
 * 这样 #I13「app.js 不自带存储实现」「换适配器只改数据层」两条约束都不破，
 * 也避免把一次配置保存误当成学习事件触发订阅重绘或后台上传。
 */
(function (global) {
  'use strict';

  var TTK = global.TTK = global.TTK || {};
  var GEN_KEY = 'ttk.generator.v1';

  function readGenConfig() {
    var data = TTK.data;
    if (!data || typeof data.read !== 'function') return { endpoint: '', model: '' };
    var saved = null;
    try { saved = data.read(GEN_KEY, null); } catch (e) { saved = null; }
    if (!saved || typeof saved !== 'object') return { endpoint: '', model: '' };
    return {
      endpoint: String(saved.endpoint || ''),
      model: String(saved.model || '')
    };
  }

  function saveGenConfig(cfg) {
    var clean = {
      endpoint: String((cfg && cfg.endpoint) || ''),
      model: String((cfg && cfg.model) || '')
    };
    var data = TTK.data;
    if (data && typeof data.write === 'function') data.write(GEN_KEY, clean, true);
    return clean;
  }

  TTK.settings = {
    key: GEN_KEY,
    readGenConfig: readGenConfig,
    saveGenConfig: saveGenConfig
  };
})(window);
