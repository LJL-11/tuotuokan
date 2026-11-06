#!/usr/bin/env node
/* 拖拖看 · 匿名评审合规扫描（零依赖）
 *
 * 规则分两类：
 *  1) 内置模式：邮箱、手机号、身份证号 —— 任何仓库都不该出现。
 *  2) 本机敏感词：把校名、成员姓名、指导老师姓名等一行一个写进 .local/forbidden.txt。
 *     该目录已被 .gitignore 排除，绝不入库；工具自身不含任何真实姓名。
 *
 * 扫描范围：git 跟踪的文件（未初始化 git 时退回遍历工作区文本）。
 * 说明：CI 里没有本机词表，只做模式检查，人工复核不能省，见 docs/04-参赛合规.md。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var ROOT = path.resolve(__dirname, '..');

var SKIP_DIRS = { '.git': 1, 'node_modules': 1, '.local': 1, 'dist': 1, 'build': 1, 'coverage': 1 };
var TEXT_EXT = /\.(md|js|json|yaml|yml|html|css|txt|example)$/i;
var TEXT_NAME = { 'CODEOWNERS': 1, 'LICENSE': 1, '.gitignore': 1, '.env.example': 1 };

function isText(rel) {
  var name = path.basename(rel);
  return TEXT_EXT.test(name) || !!TEXT_NAME[name];
}
function walk(dir, out) {
  out = out || [];
  var base = path.join(ROOT, dir);
  if (!fs.existsSync(base)) return out;
  fs.readdirSync(base, { withFileTypes: true }).forEach(function (e) {
    var rel = dir ? dir + '/' + e.name : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS[e.name]) walk(rel, out); }
    else if (isText(rel)) out.push(rel);
  });
  return out;
}
function files() {
  try {
    var s = cp.execFileSync('git', ['ls-files', '-z'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    });
    var tracked = s.split('\0').filter(Boolean).filter(isText);
    if (tracked.length) return { list: tracked, mode: 'git ls-files' };
  } catch (e) { /* 未初始化仓库时退回遍历 */ }
  return { list: walk('', []), mode: '目录遍历（尚未 git add）' };
}

var localWordsPath = path.join(ROOT, '.local', 'forbidden.txt');
var words = [];
if (fs.existsSync(localWordsPath)) {
  words = fs.readFileSync(localWordsPath, 'utf8')
    .split(/\r?\n/).map(function (s) { return s.trim(); })
    .filter(function (s) { return s && s.charAt(0) !== '#'; });
}

var rules = [
  { name: '邮箱地址', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: '手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { name: '身份证号', re: /(?<!\d)\d{17}[\dXx](?!\d)/g }
];
words.forEach(function (w) {
  rules.push({ name: '本机敏感词', re: new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') });
});

var target = files(), hits = [];
target.list.forEach(function (rel) {
  var abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return;
  var lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  lines.forEach(function (line, i) {
    rules.forEach(function (rule) {
      rule.re.lastIndex = 0;
      var m;
      while ((m = rule.re.exec(line))) {
        hits.push({ file: rel, line: i + 1, rule: rule.name, snippet: line.trim().slice(0, 70) });
        if (m[0].length === 0) rule.re.lastIndex++;   // 防零长匹配死循环
        if (hits.length > 200) return;
      }
    });
  });
});

console.log('匿名合规扫描：' + target.list.length + ' 个文本文件（' + target.mode + '）');
console.log('本机敏感词：' + (words.length ? words.length + ' 条（来自 .local/forbidden.txt）' : '未配置，仅做模式检查'));

if (hits.length) {
  console.log('\n发现 ' + hits.length + ' 处疑似可识别信息：');
  hits.slice(0, 30).forEach(function (h) {
    console.log('  ' + h.file + ':' + h.line + '  [' + h.rule + ']  ' + h.snippet);
  });
  console.log('\n请按 docs/04-参赛合规.md 处理后重跑。若属误报，先确认是否真的可以出现在提交材料中。');
  process.exit(1);
}
console.log('PASS：未发现邮箱 / 手机号 / 身份证号 / 本机敏感词。');
console.log('提醒：账号名、提交作者名、演示录屏中的个人信息仍需人工复核。');
process.exit(0);
