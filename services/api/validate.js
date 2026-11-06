'use strict';
// 只覆盖仓库现有两份 draft-07 契约使用的关键字，不执行模板表达式。
var traceSchema = require('../../contracts/learning-trace.schema.json');
var templateSchema = require('../../contracts/template.schema.json');
function object(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function validate(value, schema, root, at, errors) {
  at = at || '$'; errors = errors || []; root = root || schema;
  if (schema.$ref) {
    var ref = schema.$ref.slice(2).split('/').reduce(function (s, k) { return s[k]; }, root);
    return validate(value, ref, root, at, errors);
  }
  function fail(message) { errors.push({ path: at, error: message }); }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && value !== schema.const) fail('固定值不匹配');
  if (schema.enum && schema.enum.indexOf(value) < 0) fail('不在允许的枚举中');
  var types = { object: object(value), array: Array.isArray(value), string: typeof value === 'string',
    number: typeof value === 'number' && Number.isFinite(value), integer: Number.isSafeInteger(value), boolean: typeof value === 'boolean' };
  if (schema.type && !types[schema.type]) { fail('必须为 ' + schema.type); return errors; }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail('字符串过短');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail('字符串过长');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail('字符串格式不匹配');
    if (schema.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))) fail('必须为 ISO 日期时间');
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail('低于最小值');
    if (schema.maximum !== undefined && value > schema.maximum) fail('超过最大值');
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) fail('必须大于下界');
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail('数组过短');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail('数组过长');
    if (schema.items) value.forEach(function (item, i) { validate(item, schema.items, root, at + '[' + i + ']', errors); });
  }
  if (object(value)) {
    (schema.required || []).forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(value, k)) errors.push({ path: at + '.' + k, error: '必填' });
    });
    Object.keys(value).forEach(function (k) {
      var child = schema.properties && Object.prototype.hasOwnProperty.call(schema.properties, k) ? schema.properties[k] : schema.additionalProperties;
      if (child === false) errors.push({ path: at + '.' + k, error: '不允许的字段' });
      else if (object(child)) validate(value[k], child, root, at + '.' + k, errors);
    });
  }
  return errors;
}
function template(spec) {
  var errors = validate(spec, templateSchema);
  if (!errors.length && spec.x.min >= spec.x.max) errors.push({ path: '$.x', error: 'min 必须小于 max' });
  if (!errors.length) {
    var keys = Object.create(null), reserved = ['x', 'p', 'M', 'Math', 'PI', 'E', 'm', '__proto__', 'constructor', 'prototype'];
    spec.params.forEach(function (p, i) {
      if (keys[p.key] || reserved.indexOf(p.key) >= 0 || p.min >= p.max || p.default < p.min || p.default > p.max) errors.push({ path: '$.params[' + i + ']', error: '参数名称重复、保留名或范围非法' });
      keys[p.key] = true;
    });
  }
  return errors;
}
function trace(value) {
  var errors = validate(value, traceSchema);
  if (value && Array.isArray(value.customTemplates)) value.customTemplates.forEach(function (spec, i) {
    template(spec).forEach(function (error) { errors.push({ path: '$.customTemplates[' + i + ']' + error.path.slice(1), error: error.error }); });
  });
  return errors;
}
module.exports = { event: function (value) { return validate(value, traceSchema.definitions.learningEvent, traceSchema); }, trace: trace, template: template, object: object };
