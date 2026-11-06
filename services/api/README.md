# 后端服务 · 秦庆泽

## 你要交付什么

把 v0 里"只存本机 localStorage"的数据层，换成**可跨设备但完全匿名**的同步服务。
技术栈不限（Node / Python / Go / Serverless 均可），但必须满足下面三条硬约束：

1. **接口形状**：实现 `openapi.yaml` 里的端点，字段与 `contracts/learning-trace.schema.json` 一致。
2. **前端零改动**：上层只调 `TTK.data`，你要做的是替换适配器，不是让 UI 直接 fetch。
3. **匿名**：业务数据里不得出现姓名、学校、学号、设备指纹、IP；匿名 ID 随机不可反推。

## 分两步

### 第一步（#I10）：REST 适配器

前端已经预留：

```js
TTK.data.remote.configure('https://<your-api>/v1');  // 配置后 POST <url>/events
TTK.data.remote.configure('');                       // 回到纯本地模式
```

`remote.push(event)` 已经做了离线排队（上限 500 条）与联网批量提交。
你要补的是：服务端接收与去重（`at + tpl + reason`）、`/trace` 导出、`/trace/import` 导入，
以及让 `TTK.data` 的 `trail()/progress()/stuck()/custom()` 在 REST 模式下走服务端而非本地。
**未配置 endpoint 时的行为必须与现在完全一致**——这是 CI 与演示的底线。

### 第二步（#I11）：跨设备同步

`POST /auth/anonymous` 生成随机匿名 ID，用户在新设备手动输入即可恢复进度。
不要引入手机号 / 邮箱 / 第三方登录，那会带来可识别信息，违反匿名评审要求。

## 明确不要做的事

- 不要把模型 API 密钥放在前端。姜雅文的 LLM 调用（#I4）如果需要服务端代理，
  请在本服务加一个 `/generate` 转发端点，密钥只放环境变量，并在改动说明里写明。
- 不要改 `contracts/` 里的字段而不走评审流程。
- 不要把官方参赛表格、成员信息、项目记忆类文件放进仓库或部署产物。

## 建议的验收方式

1. 起本地服务，`configure('http://127.0.0.1:8787/v1')`，拖动参数后确认 `/events` 收到合法 JSON。
2. 断网拖动 → 联网 → 队列补发，不丢事件。
3. `TTK.data.exportAll()` 的导出结果能被 `/trace/import` 原样导入，且 `npm run check:anon` 通过。
4. 用同一匿名 ID 在另一个浏览器恢复，进度一致。
