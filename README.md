# 拖拖看 · 交互式概念沙盒

> 把任意抽象概念变成**可拖参数的可交互沙盒**：不是聊天框，也不是写死的小游戏，
> 而是一套「参数 + 关系/模型 + 可观测指标」的通用引擎。
> 赛题 1 · AI 赋能学习生产力 | 第二十届全国大学生软件创新大赛

**当前状态：M1 四视图可跑、M2 输入与生成闭环接通、静态站已上线。** 双击 `index.html` 即可运行，
内置 **10 个跨学科精修概念**；线上地址 <https://ljl-11.github.io/tuotuokan/>（GitHub Pages，仅托管静态文件）。

网页 Issue 已关闭的交付：#I13 数据层统一、#I1 四视图路由（hash `#<view>/<tplId>`，刷新保持）、
#I7 / #I8 引擎插件化与表达式安全加固（PR #16）、#I10 REST 适配器、#I11 匿名账号与跨设备同步数据侧、
#I12 CI 与 Pages 部署、#I4 模板生成（输出校验 / 失败重试 / 本地降级）、#I5 多模态概念识别、
#I6 模板库扩充与先修关系补全。

仍在进行：#I2 报告精修、#I3 模板工坊、#I14 图谱可视化、#I9 模拟骨架、#I15 同步产品入口，
以及若干偿还 Issue，见 [`docs/02-路线图与任务看板.md`](docs/02-路线图与任务看板.md)。

校验基线：`npm test` 235 项、`npm run api:smoke` 30 项、`npm run check:anon` PASS（`npm run check` 一次跑完）。

---

## 快速开始

**双击 `index.html` 即可运行**，零依赖、无构建、`file://` 可用（不用装 Node 也能看）。

需要校验时（Node ≥ 18，**不需要 `npm install`**）：

```bash
npm test            # 语法 / 脚本路径 / DOM 引用 / 数值稳定性 / DSL / 表达式安全 / 契约样例
npm run check:anon  # 匿名合规扫描
npm run check       # 两个都跑
```

## 四人分工

| 成员 | 职责 | 主要负责 | 起点任务 |
|---|---|---|---|
| 付 | 产品统筹 + 前端 / 可视化 | `src/ui/`、`src/viz/`、`assets/`、`index.html`、`docs/` | #I2 / #I3 / #I14 视图精修、#I15 同步入口 |
| 姜 | 算法 / ML：概念建模、AI 生成、多模态识别 | `src/model/` | #I4 / #I5 / #I6 已完成，下一步偿还 AI 代理链路与输入能力 |
| 曹 | 游戏 / 模拟引擎：沙盒运行骨架 | `src/core/` | #I7 / #I8 已完成，下一步 #I9 模拟骨架 |
| 秦 | 后端 / 多设备 / 工程 / 文档 | `services/api/`、`src/learning/data.js` | #I10 / #I11 / #I12 已完成，配合 #I15 与可选后端部署 |

> 表内单字为姓氏，仅作分工标识；对外材料不出现成员全名。

`contracts/` 是全员共管的汇合点，改动需评审。详见 [`docs/00-分工与协作.md`](docs/00-分工与协作.md)。

## 架构与目录

```
输入层   文字 / 文件名 / 图片内文字 → 概念   src/model/generator.js（已接，本机处理）
建模层   概念 → TemplateSpec              contracts/template.schema.json + TTK.dsl.prompt/draft
生成层   TemplateSpec → 可运行沙盒         src/model/dsl.js → src/core/engine.js
表现层   ComputeResult → Canvas / 指标卡   src/viz/ + src/ui/
闭环层   轨迹 → 掌握度 → 推荐下一个概念    src/learning/ + services/api/（可选同步服务）
```

| 目录 | 内容 |
|---|---|
| `contracts/` | 共享契约与可执行样例（**唯一汇合点**） |
| `src/core/` | 状态引擎、数学工具、安全表达式求值 |
| `src/model/` | 10 个精修模板、DSL 编译器、概念识别与模板生成（代理可选） |
| `src/viz/` | 声明式 Canvas 渲染器 |
| `src/learning/` | 数据适配器、概念图谱与学习诊断 |
| `src/ui/` | 页面装配、四视图路由与最小可用视图 |
| `services/api/` | 后端接口定义与实现目录 |
| `docs/` | 分工、接口契约、任务看板、环境、合规、ADR |
| `tools/` | 本地与 CI 校验脚本 |
| `.github/` | CODEOWNERS、Issue/PR 模板、CI |

接口细节见 [`docs/01-接口契约.md`](docs/01-接口契约.md)，上手见 [`docs/03-开发环境.md`](docs/03-开发环境.md)。

## 部署与数据：本地优先

- **静态站**：GitHub Pages 由仓库 Settings 配 `main / root` 发布，只托管 `index.html`、CSS 与脚本；
  **不运行 `services/api/server.js`，也不保存任何学习数据**。push 到 `main` 后自动更新，没有到期日。
- **数据在哪**：默认纯本地模式，轨迹 / 挑战 / 卡点 / 自定义模板写在**当前设备、当前浏览器 origin 的
  localStorage**（键名见 `docs/01` 第 5 节）。PC 与手机、以及 `file://` 与 Pages 站点之间，
  记录彼此独立、互不干涉。
- **怎么交接**：`TTK.data.exportAll(engine)` 导出匿名 JSON，`TTK.data.importAll(文本)` 在另一台设备导入；
  这是当前推荐的备份 / 迁移方式，导出内容符合 `learning-trace.schema.json`。
- **可选同步**：只有需要多设备自动合并时，才运行 `npm run api`（本机 Node 服务，默认 `127.0.0.1:8787/v1`）
  或另行把该服务部署到公网，再用 `TTK.data.remote.configure(url)` 接入。界面配置入口见 #I15；
  **未配置时零网络请求**。公网后端是可选增强，当前不部署不影响演示与本地评测。

## 协作规则

**不设审批门禁**：可以直接 push `main`，也可以开分支提 PR、互相合并，按方便来；不需要 approve，也没有指定合并人。

- 建议认领 `docs/02` 的任务再动手，改完跑一次 `npm run check`（全量校验 + 匿名扫描），避免互相覆盖。
- `contracts/` 是全员共管的汇合点，改字段前先和受影响的人对清楚，并同步四处（schema / examples / dsl.js / `docs/01`）。
- 目录 owner 见 `docs/00`；需要顺手改到别人目录（尤其 `index.html` / `src/ui/` / `assets/`）时先打声招呼，改完在提交说明里列出受影响文件。
- CI 在 push 与 PR 时自动跑 `npm test` + 匿名扫描，红了及时修。
- commit 用 `类型(范围): 一句话`。其余见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 两条硬规矩

- **匿名评审**：本仓库已 **public**，仓库内每一行都等同于对外材料。不得出现校名、成员全名、指导老师姓名、学号或任何可识别信息；分工一律只用姓氏单字（付 / 姜 / 曹 / 秦）或代号（队长 / 队员 A / B / C），Issue 标签 / 分支仍用字母代号。提交前跑 `npm run check:anon`，详见 [`docs/04-参赛合规.md`](docs/04-参赛合规.md)。
- **原创**：核心工作须在本次大赛期间完成，未参加其他国家级公开比赛；第三方依赖与 AI 使用情况如实记录。当前 v0 零第三方依赖。

关键时间：初赛作品提交截止 **2027.01.15 18:00**；全国决赛 **2027.05.22–23**。
