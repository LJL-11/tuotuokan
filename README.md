# 拖拖看 · 交互式概念沙盒

> 把任意抽象概念变成**可拖参数的可交互沙盒**：不是聊天框，也不是写死的小游戏，
> 而是一套「参数 + 关系/模型 + 可观测指标」的通用引擎。
> 赛题 1 · AI 赋能学习生产力 | 第二十届全国大学生软件创新大赛

**当前状态：M0 框架就绪。** v0 原型已可运行（6 个跨学科概念），
四层架构里未完成的输入层 / AI 生成 / 跨设备同步 / 四视图与学习闭环，
已按分工拆成可认领的 issue，见 [`docs/02-路线图与任务看板.md`](docs/02-路线图与任务看板.md)。

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

| 代号 | 职责 | 主要负责 | 起点任务 |
|---|---|---|---|
| 队长 | 产品统筹 + 前端 / 可视化 | `src/ui/`、`src/viz/`、`assets/`、`index.html`、`docs/` | #I1 四视图路由 |
| 队员 A | 算法 / ML：概念建模、AI 生成、多模态识别 | `src/model/` | #I4 接 LLM 生成模板 |
| 队员 B | 游戏 / 模拟引擎：沙盒运行骨架 | `src/core/` | #I7 引擎插件化与性能 |
| 队员 C | 后端 / 多设备 / 工程 / 文档 | `services/api/`、`src/learning/data.js` | #I10 REST 适配器 |

`contracts/` 是全员共管的汇合点，改动需评审。详见 [`docs/00-分工与协作.md`](docs/00-分工与协作.md)。

## 架构与目录

```
输入层   文字/截图/板书/语音 → 概念        src/model/generator.js（待接）
建模层   概念 → TemplateSpec              contracts/template.schema.json
生成层   TemplateSpec → 可运行沙盒         src/model/dsl.js → src/core/engine.js
表现层   ComputeResult → Canvas / 指标卡   src/viz/ + src/ui/
闭环层   轨迹 → 掌握度 → 推荐下一个概念    src/learning/ + services/api/
```

| 目录 | 内容 |
|---|---|
| `contracts/` | 共享契约与可执行样例（**唯一汇合点**） |
| `src/core/` | 状态引擎、数学工具、安全表达式求值 |
| `src/model/` | 精修模板库、DSL 编译器、AI 生成占位 |
| `src/viz/` | 声明式 Canvas 渲染器 |
| `src/learning/` | 数据适配器、概念图谱与学习诊断 |
| `src/ui/` | 页面装配、四视图路由骨架 |
| `services/api/` | 后端接口定义与实现目录 |
| `docs/` | 分工、接口契约、任务看板、环境、合规、ADR |
| `tools/` | 本地与 CI 校验脚本 |
| `.github/` | CODEOWNERS、Issue/PR 模板、CI |

接口细节见 [`docs/01-接口契约.md`](docs/01-接口契约.md)，上手见 [`docs/03-开发环境.md`](docs/03-开发环境.md)。

## 协作规则

- **`main` 是受保护分支：队员一律不得直接 push，也不得自行合并 PR**，只能从 `feat/<代号>-<短名>` 提 PR。
- 每个 PR 必须 **CI 全绿 + 队长 approve** 才能合并；**只有队长执行合并**，且只用 Squash merge。
- 提 PR 前跑 `npm run check`；涉及 `contracts/` 需队长 + 受影响方 approve。
- 上面这些由 GitHub 分支保护规则强制执行，不是口头约定。队长开启步骤见 [`docs/00-分工与协作.md`](docs/00-分工与协作.md) 第五节。
- commit 格式 `feat(model): 一句话`。完整规则见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 两条硬规矩

- **匿名评审**：提交材料、演示视频、答辩 PPT、界面文案与任何对外内容不得出现校名、成员姓名、指导老师姓名或可识别信息。仓库保持私有，日常一律用代号 A/B/C；`.github/CODEOWNERS` 里的姓名只是队内临时占位标注，**提交前必须清理**（见 [`docs/04-参赛合规.md`](docs/04-参赛合规.md)）。提交前跑 `npm run check:anon`。
- **原创**：核心工作须在本次大赛期间完成，未参加其他国家级公开比赛；第三方依赖与 AI 使用情况如实记录。当前 v0 零第三方依赖。

关键时间：初赛作品提交截止 **2027.01.15 18:00**；全国决赛 **2027.05.22–23**。
