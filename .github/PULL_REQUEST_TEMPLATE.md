## 这个 PR 做什么

<!-- 一句话说清，贴关联 Issue：Closes #I4 -->

关联 Issue：

## 改动范围

- [ ] 只改了自己 owner 的目录
- [ ] 改了 `contracts/`（需队长 + 全部受影响方 approve，并同步四处文档/schema/样例）
- [ ] 改了 `index.html` 脚本加载顺序（需队员 B 确认）
- [ ] 属于交叉补位，已在对应 owner 的 issue 里说明

## 自检清单

- [ ] `npm test` 通过
- [ ] `npm run check:anon` 通过
- [ ] 双击 `index.html` 能跑，原有 6 个沙盒交互没被破坏
- [ ] 模板里没有 `Math.random()` / DOM 操作 / 网络请求
- [ ] 没有把密钥、真实姓名、校名、账号信息写进代码或文档
- [ ] 新增引导挑战已经亲手拖到过、确认可达
- [ ] 涉及 UI 的改动附了截图（截图中无个人信息、无浏览器历史）
- [ ] **我没有直接 push `main`，也不会自己点 Merge —— 等队长 approve 后由队长合并**

## 合并准入（队长确认）

- [ ] 关联了 Issue
- [ ] CI 全绿
- [ ] 队长已 approve；涉及 `contracts/` 的，受影响方也已 approve
- [ ] 由队长执行 Squash merge

## 给 reviewer 的说明

<!-- 特别是：有没有临时硬编码？是否引入技术债（有的话请建偿还 Issue 并贴链接）？
     有没有需要先合并的其他 PR？ -->
