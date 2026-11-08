# 匿名同步与模型代理服务 · 秦 #I10 / #19

零第三方依赖，使用 Node 内置 HTTP 与文件存储。前端接口仍是 `TTK.data`；不修改 `contracts/`、`index.html` 或队友的引擎与视图。

阶段结果、验证范围和下次接续步骤见 [I10 阶段交付说明](DELIVERY-I10.md)。

## 启动和验收

在仓库根目录运行（Node >=18）：

```powershell
npm run api
npm run check
npm run api:browser
```

服务默认监听 `http://127.0.0.1:8787/v1`。`npm run api:smoke` 覆盖原 I10 的 30 项与 #19 / #21 新增 10 项，共 40 项；使用随机端口、模拟模型上游和 `.local/ttk-api-*` 临时库，结束后校验路径并清理，不碰真实学习数据、不调用外部模型。

`npm run api:browser` 是**真实浏览器验收**：自动发现本机 Edge / Chrome，用 CDP 起 headless 实例打开 `file://` 页面，验证拖参数上报、断网刷新补发、跨浏览器读回，#I2 / #I3 / #I14 / #I15 的 UI 冒烟，以及偿还 #19 / #20 / #21 前端入口的生成落盘与刷新恢复（当前 37 项）。找不到浏览器时以退出码 2 跳过，不进 CI（CI 是 Linux 无头环境，装浏览器成本不值）。

服务数据保存在 `services/api/.data/db.json`，已被 Git 忽略。可用环境变量指定目录、地址和端口：

```powershell
$env:TTK_DB_DIR = 'D:\tuotuokan-data'
$env:PORT = '8787'
$env:HOST = '127.0.0.1'
npm run api
```

一个数据目录只运行一个服务进程。每次写操作先写临时文件再原子替换，保存成功才返回成功响应；保存失败返回 500、内存库回滚。损坏的数据库会阻止启动，不会静默清空。当前 JSON 文件存储适合原型验证，正式多进程部署应更换数据库；不要把试用数据库提交进仓库。

## 前端接入

双击根目录 `index.html`，在开发者工具控制台执行：

```js
TTK.data.remote.configure('http://127.0.0.1:8787/v1');
await TTK.data.remote.flush();
TTK.data.remote.identity(); // 本机匿名 ID，16 位十六进制
TTK.data.remote.pending();  // 待上传事件数
TTK.data.remote.lastError;  // 同步失败原因
TTK.data.remote.storageError; // 本机存储配额 / 权限异常提示
```

在另一浏览器恢复（将占位值替换为上一浏览器返回的 ID）：

```js
TTK.data.remote.identity('<16位匿名ID>');
TTK.data.remote.configure('http://127.0.0.1:8787/v1');
await TTK.data.remote.flush();
TTK.data.progress();
```

`identity()` 不发送网络请求，使用浏览器安全随机数；`POST /auth/anonymous` 也提供服务端创建 / 恢复入口。当前 ID 即匿名访问凭证，只用于演示规模的同步，不代表正式账号认证。无安全随机数的浏览器会明确报错，不使用弱随机数伪装。

配置地址前不发请求；显式 `configure(url)` 后会同步已有的本机记录并保存配置，刷新后自动恢复。清除配置可执行：

```js
TTK.data.remote.configure('');
```

**阶段说明**：上面的控制台调用是 I10 交付时的调试入口，保留作接口示例；**不是当前产品现状**。
#I15 已在 `index.html` / `src/ui/app.js` 落地产品界面（服务地址、匿名 ID、同步状态、待上传数、最近错误），
订阅 `TTK.data.subscribe()` 即时重绘，页面底部措辞随本地 / 同步模式切换。正常使用请走界面，控制台入口仅用于调试。

## 同步规则

- `trail()/progress()/stuck()/custom()` 仍同步返回缓存，保持现有上层调用方式。后台上传并读回后，会通过 `subscribe(fn)` 通知缓存更新。
- 事件按 50 条一批发到 `/events`；有快照改动时使用现有 `/trace/import` 上传挑战进度、卡点与模板，再从 `/trace` 拉回合并结果。
- 队列、快照按“服务 URL + 匿名 ID”分别持久化，切换身份或服务时不会串数据，旧响应也不会覆盖新身份缓存。
- 待上传事件不按 500 条静默截断。浏览器存储配额不足时，本次会话使用内存并报告 `storageError`，关闭页面前应导出；这种情况下无法保证刷新恢复。
- 网络异常、超时、5xx、429、408 保留队列并按 1–30 秒退避重试；`online` 事件立即重试。其他 4xx 保留队列和 `lastError`，修复后手动 `flush()`，不自动删除整批数据。
- 事件按 `at + tpl + reason` 去重；挑战完成值取逻辑 OR；卡点按 `at + tpl` 去重；模板按 id 保存，同 id 以最后一次成功上传为准。没有远端删除操作。
- 本机界面保留最近 300 条事件与 200 条卡点；服务端保存已接收的完整历史。`TTK.data.exportAll()` 是本机缓存导出，完整远端历史由 `GET /trace` 获取。
- `clear()` 清空本机学习记录、取消当前待上传项并关闭同步，远端历史保留。已经送达的请求不能撤回；再次启用同一身份会读回远端历史。
- 不提供实时推送或定时轮询。跨设备操作后，在另一端刷新或手动 `flush()` 拉取。

## 端点

以 `openapi.yaml` 为准；数据字段直接校验仓库现有两份 JSON Schema，不新增学习轨迹字段。

| 端点 | 行为 |
|---|---|
| `GET /health` | 存活探针 |
| `POST /generate` | 调用服务端配置的 Chat Completions 兼容上游，返回 `{spec}`；无配置返回 503 |
| `POST /auth/anonymous` | 创建或恢复 16 位随机匿名 ID；非法 existingId 返回 400 |
| `POST /events` | 批次完整校验、按身份去重、持久化后返回 202；支持草稿已有的可选 progress / stuck |
| `GET /trace` | 导出该身份完整 LearningTrace v1 |
| `POST /trace/import` | 校验后合并事件、进度、卡点与自定义模板；重复导入幂等 |
| `GET /templates` | 获取该身份模板 |
| `PUT /templates` | 按 TemplateSpec 校验并保存模板；非法返回 422 |

除生成代理、身份创建、健康检查与 OPTIONS 外均要求 `X-Anon-Id`。请求体上限 2 MiB。CORS 允许 `Content-Type`、`X-Anon-Id` 和 `file://` 页面的请求；服务不接收凭证 Cookie。

`validate.js` 只实现当前两份契约使用的校验关键字，不是通用 JSON Schema 引擎。更新契约时需同步检查这里。服务端不执行模板公式，客户端挂载模板仍必须经过 `TTK.dsl.validate/compile` 与表达式白名单。

## 验收与后续边界

`npm run check` 包含原有验证、I10 API / 数据层验收和匿名扫描；CI 同样运行三者。新增用例覆盖断网刷新恢复、HTTP 错误保留、发送途中继续写入、身份 / 地址切换、重启持久化、磁盘失败和完整导入导出。

I11 数据侧与 I12 静态部署均已完成（网页 #14 / #8 已关闭）：GitHub Pages 由仓库 Settings 配 `main / root` 发布，
地址 <https://ljl-11.github.io/tuotuokan/>，push 后自动更新；CI 在 push / PR 时全绿。
**Pages 只托管静态文件，不运行 `server.js`**，跨设备同步仍需本机 `npm run api` 或另行部署该服务；
产品入口、界面同步状态与匿名身份交互归 #I15（付），不属 I10 / I11 验收范围。

## 模型代理（#19）

`POST /v1/generate` 接收 `{concept, model, prompt}`，只返回 `{spec: TemplateSpec}`。
`concept` 为 1–200 字，`prompt` 为 1–24000 字；`model` 可省或为空，使用服务端默认模型。
客户端不能提交密钥、上游地址或其他字段。模型密钥只在服务端发往固定上游的 `Authorization: Bearer ...` 中使用。

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `TTK_LLM_URL` | 空（代理未启用） | 上游完整 Chat Completions URL，包含 `/chat/completions`；HTTPS，本机模拟允许 HTTP loopback；不接受 URL 凭证、查询串或片段 |
| `TTK_LLM_API_KEY` | 空 | 服务端模型密钥；本机无鉴权模型可留空 |
| `TTK_LLM_MODEL` | 空 | 默认模型名；前端传非空 `model` 可覆盖 |
| `TTK_LLM_TIMEOUT_MS` | `6500` | 总请求超时，整数 1–7000 毫秒，早于客户端 8 秒超时 |
| `TTK_LLM_RATE_LIMIT` | `20` | 每个服务进程全局每分钟最多请求数，整数 1–10000；重试也计次 |
| `TTK_LLM_MAX_CONCURRENT` | `2` | 同时生成数，整数 1–100 |

上游使用非流式 `{model, stream:false, messages:[{role:'system', content:prompt}, {role:'user', content:concept}]}`。
协议参考 [Chat Completions 兼容接口文档](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions)；
具体服务商与模型尚未选定。上游响应支持 TemplateSpec、`{spec}`、`choices[0].message.content`（可含 JSON 代码围栏）。
代理校验模板形状并去掉顶层额外元数据，客户端仍须经过 DSL / 表达式白名单；服务端不执行公式。

配置示例（服务商确认后替换占位值，密钥通过进程环境注入，不写进源码）：

```powershell
$env:TTK_LLM_URL = 'https://<模型服务域名>/v1/chat/completions'
$env:TTK_LLM_MODEL = '<模型名>'
# 在本机设置 TTK_LLM_API_KEY；不要把真实值写入仓库或群聊。
npm run api
```

Node 18 启动不会自动读取 `.env`，请使用当前终端的环境变量；改配置后重启服务。
页面「学习记录 → AI 生成代理」填 `http://127.0.0.1:8787/v1/generate`，模型名可留空。
这是**生成代理地址**；同步服务地址仍是 `http://127.0.0.1:8787/v1`，两项独立配置。

未配置地址或模型返回 503；限流返回 429 和 `Retry-After`；上游连接、状态、JSON / 模板错误返回 502；
总超时返回 504 并中止上游连接，响应限 1 MiB，不跟随重定向。
错误不透传上游正文、密钥或地址；不记录概念、提示、IP、身份、图片或语音。
每进程限流不按 IP 留痕，也不代替公网部署的访问控制。代理自身不重试，前端重试一次后降级为 `ai:false` 草稿。
生成请求只发送概念与提示文本到**用户配置的服务及其上游**；不发送学习轨迹、匿名 ID 或媒体字节。

## 生成模板数据确认（#21）

秦确认：`saveCustom(list)` 接收纯 TemplateSpec 数组，存 `ttk.custom.v1`，不存带 `compute()` 的 RuntimeTemplate。
`generator.mount()` 的 `spec` 可序列化，`persist === true` 的模型模板由付的页面逻辑保存；本地草稿不落盘。
生成器对占用 id 改名；保存入口拒绝内置 id；相同自定义 id 由调用方先去重再替换，快照 / 服务端同 id 最后成功上传者生效。
恢复时始终先 DSL 校验与编译，不覆盖已注册的精修模板。无需修改数据格式、共享契约或增加存储 key。

新增 #21 用例验证：模型生成 → 本地保存 → 刷新 / 导出 / 导入 → 编译挂载；
配置同步后 `/trace/import` 上传的模板与 `GET/PUT /templates` 共用一份数据，同 ID 新客户端能读回，换 ID 隔离，服务重启保留。
交付范围与联调清单见 [#19 / #21 交接说明](DELIVERY-R1-R3.md)。目前只完成本机模拟模型上游验证，未做真实供应商调用；两条 Issue 等姜完成真实模型联调后再统一验收。
