# 共享契约 · contracts/

> **这是四个人唯一的汇合点。** 目录里的文件定义了「谁产出什么、谁消费什么」。
> 改动这里的任何字段，都要先和受影响的队员对清楚，并同步下面列出的四处，避免别人在自己的分支里发现字段变了。

## 为什么需要它

姜生成的模板，要能被曹的引擎执行，被付的渲染器画出来，被秦的后端存下来。
如果各自凭感觉定义字段，四个人会各写各的、最后拼不起来。契约先行，才能真并行。

## 四层数据流

```
输入层  文字 / 文件名 / 图片内嵌文字 ──(姜: recognize)──> conceptId | 概念描述
        （语音只认文件名，请改用文字，或把概念写进文件名；字节不上传）
建模层  概念描述 ──(姜: generate)──> TemplateSpec JSON  ← contracts/template.schema.json
编译层  TemplateSpec ──(曹: TTK.dsl.validate/compile)──> RuntimeTemplate
运行层  RuntimeTemplate.compute(p, M) ──> ComputeResult  ← contracts/compute-result.schema.json
表现层  ComputeResult.chart ──(付: TTK.render)──> Canvas
闭环层  学习事件 ──(付采集 / 秦存储)──> LearningTrace  ← contracts/learning-trace.schema.json
诊断层  LearningTrace ──(付+秦: TTK.Graph)──> 下一个推荐概念
```

## 三份契约

| 文件 | 定义什么 | 产出方 | 消费方 |
|---|---|---|---|
| `template.schema.json` | AI 生成 / 人工编写的模板 JSON（TemplateSpec） | 姜（生成）、付（工坊手写） | 曹的编译器 |
| `compute-result.schema.json` | `compute()` 返回值（ComputeResult）与 chart spec | 曹的引擎、姜的模板 | 付的渲染器与指标卡 |
| `learning-trace.schema.json` | 学习轨迹事件与匿名导出格式（LearningTrace） | 付（采集）、秦（存储/同步） | 图谱诊断、学习报告、复赛验证数据 |

字段语义与函数调用方式始终以 `docs/01-接口契约.md` 第 3 节为准；本目录的 schema 只管**数据形状**，
零依赖的形状校验实现是 `TTK.dsl.validateResult()`（CI 会用它校验样例、模板输出与模拟帧）。

`examples/` 放的是**可执行的最小样例**，不是摆设：
- `spring.json` 必须能被 `TTK.dsl.validate` 通过并编译注册（CI 会检查）。
- `trace.json` 必须能被 `TTK.data.importAll` 导入（CI 会检查）。
- `compute-result.json` 必须能被 `TTK.dsl.validateResult` 接受（CI 会检查）。

> **#I9 模拟骨架**没有扩展 ComputeResult：播放帧只是把同一份 `chart/metrics/insight/m`
> 按步数截断后的视图，不新增字段、不改含义，因此仍是 v1、不需要升版本，也不影响渲染器。
> 播放进度（t / steps / speed）从 `TTK.sim.state()` 读取，不进数据契约。

## 版本规则

- 每个契约对象用 `schema` 字段或文件 `title` 标版本，当前均为 **v1**。
- **加可选字段** = 兼容变更，可直接合。
- **改字段含义 / 删字段 / 改必填** = 不兼容变更：必须升 v2，保留 v1 读兼容，并在改动说明里写清迁移方案。
- `params[].key`、`tpl.id`、`event.reason` 是跨层主键，**不许改名**。

## 三个不许

1. 不许在引擎或 UI 里对模板字段做硬编码特判（"如果是 overfit 就…"）——那会毁掉通用性。
2. 不许让模板产出 DOM、Canvas 调用或直接读写 localStorage，模板只做纯计算。
3. 不许在 `expr` 字符串里执行任意 JS；所有公式走 `src/core/expr.js` 的受限求值器。
