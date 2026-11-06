# 贡献指南

## 动手之前

按顺序读三份，十分钟，能省掉后面大量返工：

1. [`docs/00-分工与协作.md`](docs/00-分工与协作.md) — 你是谁、能改哪些目录、分支怎么切
2. [`contracts/README.md`](contracts/README.md) — 你产出的数据是谁消费的
3. [`docs/01-接口契约.md`](docs/01-接口契约.md) — 具体函数签名与返回结构

然后认领一个 [`docs/02-路线图与任务看板.md`](docs/02-路线图与任务看板.md) 里的 issue。
**不要在没有 issue 的情况下大改架构。**

## 分支与提交

可以直接在 `main` 上改，也可以自己切分支（开分支是可选做法）：

```bash
git switch main && git pull
git switch -c feat/a-llm-generator     # feat / fix / docs / refactor / test / chore
```

commit 格式 `类型(范围): 一句话`，范围用目录名：

```
feat(model): 接入 LLM 模板生成与本地降级
fix(core): 修复高阶多项式在边界的数值溢出
docs(contracts): 补充 prerequisites 的图谱语义
```

一次提交只做一件事；不要顺手格式化别人的文件。

## 合入方式

**本仓库不设审批门禁**：直接 push `main`、开分支提 PR、互相合并都行，不需要 approve，也没有指定合并人。

建议做到的三件事（靠自觉，不是门槛）：

1. 提交前跑 `npm run check`（64 项校验 + 匿名合规扫描）。
2. 改动较大、或涉及公共文件（`contracts/`、`index.html`）时，先在群里说一声，避免互相覆盖。
3. CI 在 push 和 PR 时自动运行，红了尽快修，别让 `main` 长期挂红。

## 提交前自检

- [ ] `npm test` 通过（语法、脚本路径、DOM 引用、模板数值、DSL、表达式安全、契约样例）
- [ ] `npm run check:anon` 通过
- [ ] **双击 `index.html`** 真的能跑，且原有 6 个沙盒未被破坏
- [ ] 没有把 `Math.random()` 写进模板（要用 `TTK.math.rng(seed)`）
- [ ] 没有在模板里操作 DOM / Canvas / localStorage / 网络
- [ ] 没有在前端写密钥、账号、校名
- [ ] 涉及 `contracts/` 的改动已同步 JSON Schema、examples、dsl.js 和 `docs/01-接口契约.md`
- [ ] 新增模板的每个挑战都实际拖到过（不是只看代码觉得可达）

## 交叉改动

- 改 `contracts/`、`index.html` 脚本加载顺序或别人 owner 的目录时，先和对应的人对清楚。
- 别让别人在自己的分支里发现字段变了；具体同步清单见下节。
- 若走 PR，可用 `.github/PULL_REQUEST_TEMPLATE.md` 里的自检清单。

## 改契约的正确姿势

1. 先开 Issue：写清「为什么要改、谁受影响、有没有兼容方案」。
2. 讨论达成一致后再动代码，同步四处：`contracts/*.schema.json`、`contracts/examples/*`、
   `src/model/dsl.js` 的 `validate()`/`example`、`docs/01-接口契约.md`。
3. 加可选字段 = 兼容；改含义 / 删字段 / 改必填 = **升 v2 并保留 v1 读兼容**。
4. 在改动说明里列出需要配合改动的队员。

## 命名与语言

- 代码标识符、分支、commit 用英文；界面文案、文档、注释用简体中文。
- 模板 `id` 小写英文、`params[].key` 字母开头，且不得与保留名 `x/p/M/Math/PI/E/m` 冲突。
- 仓库已 public，分工只用姓氏单字或代号，**禁止写成员全名**；Issue 标签 / 分支前缀沿用字母代号：`owner:lead` = 付，`owner:a` = 姜，`owner:b` = 曹，`owner:c` = 秦。
- 仓库内任何内容都视为对外材料，提交前跑 `npm run check:anon`；详见 [`docs/04-参赛合规.md`](docs/04-参赛合规.md)。
