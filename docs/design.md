# OpenCode × 钉钉桥接程序 — 设计文档

| 项 | 值 |
|---|---|
| 版本 | v0.1（设计冻结版） |
| 日期 | 2026-10-20 |
| 状态 | 待实现 |
| 适用范围 | OpenCode **V2**（本机实测 `v2.0.18`），钉钉企业内部机器人（Stream 模式） |
| 运行环境 | macOS，单用户，本机 OpenCode 共享后台服务 |

---

## 1. 背景与目标

### 1.1 背景

团队希望用钉钉作为 OpenCode 的远程入口：在钉钉群里 @机器人 下达任务，任务在开发者的 Mac 上由本机 OpenCode 执行，执行过程可在终端 TUI 中实时观察，完成后结果回到钉钉。

本机已有 OpenCode V2 及其共享后台服务（TUI 默认连接该服务）。因此不需要在集群或服务器上跑 agent，也不需要为钉钉另起一个 OpenCode 进程。

### 1.2 目标

1. 钉钉消息 → 本机 OpenCode session 执行 → 结果回传钉钉，全链路闭环。
2. TUI 与钉钉操作**同一个** OpenCode session，终端侧可见完整执行过程。
3. 远程输入默认受控：白名单、目录白名单、高风险操作需人工确认。
4. 桥接程序是**纯适配层**：只做接入、鉴权、路由、审批编排与消息回传，不替代 OpenCode 的执行能力。

### 1.3 非目标（MVP 不做）

- 任何公网入站监听（不提供 webhook 接收地址）。
- 多租户、计费、用户自助注册。
- 图片 / 文件 / 语音消息、交互卡片与按钮审批。
- 多项目动态切换、同一项目并行执行。
- 允许 TUI 向桥接 session 输入或 steer。
- `always` 级持久审批授权。
- 自动启动 / 守护 OpenCode 服务。
- Web 管理台、指标看板。

---

## 2. 已确认的关键决策

| # | 决策 | 结论 | 理由 |
|---|---|---|---|
| D1 | TUI 在 MVP 的角色 | **只读**；检测到非桥接输入的任务标记 `HUMAN_INTERVENED` | TUI 中 Enter 是 steer 而非排队，会破坏任务边界与审批归属 |
| D2 | 关闭桥接时在途任务 | **继续执行**；桥接重启后补发结果 | 桥接不是执行者，OpenCode 拥有执行生命周期 |
| D3 | Forms / question | MVP **deny `question` 权限**；v1.1 支持文本应答 | 不处理会让任务永久挂起 |
| D4 | 审批策略 | **可切换预设**，默认 `default` = OpenCode 原生放行；`strict` = shell/web ask、跨目录 deny。`question` / `subagent` 两种预设下都 deny（功能性限制，非策略） | 逐条审批在手机上不可用；用户明确要求"OpenCode 默认允许" |
| D5 | 审批渠道 | **4 条并存**：① TUI 原生弹窗 ② Mac 原生对话框 ③ 钉钉回「允许/拒绝」④ 本机 CLI | 审批应该发生在电脑上，而不是手机上 |

补充决策：

- D5：执行队列**分两层**——桥接负责"准入队列 + 项目级串行锁"，OpenCode inbox 负责"单个 session 内的执行顺序"。两者不是重复。
- D6：事件**双通道**——per-session durable log 负责任务生命周期与最终文本，全局 `/api/event` 负责 permission / form / idle，并配合轮询对账。
- D7：完成判定依据是 `session.execution.succeeded|failed|interrupted` + `session.text.ended`，**不是** `session.idle`。
- D8：项目目录只能来自配置白名单，**不允许**由消息内容决定。
- D9：权限策略可在**运行中**通过 `PATCH /api/session/{id}` 就地改写，换预设不需要 `/new`。
- D10：长任务每 5 分钟发一次心跳（`⏳ 仍在执行`），避免"卡住了还是没开始"的焦虑。
- D11：时间线定位锚点改用**游标**：`GET /api/session/{id}/message` 的 `cursor` **不能与 `order` 同时使用**（服务端报 "Cursor cannot be combined with order"），因此翻页时只能带 `cursor`，方向由游标自带。

---

## 3. 假设与约束

**OpenCode 侧**

- 本机使用 V2 共享后台服务。TUI 必须以默认方式启动（`opencode`），**不可**使用 `--standalone`，也不可 `--server` 指向另一个私有实例，否则桥接看不到同一 session。
- V2 HTTP API 官方标注为 Experimental（OpenAPI `version: 0.0.1`）。必须锁定 OpenCode 与客户端版本，并在启动时做契约自检。
- OpenCode API 即使在 loopback 也需要认证（实测裸请求返回 `401`）。不能假设"本机即免认证"。

**钉钉侧**

- 使用企业内部机器人 + Stream 模式：桥接程序主动建立 WSS，**不需要**公网回调地址。
- 机器人必须**发布上线**后 `senderStaffId` 才有值（否则白名单会全部拒绝）。
- `sessionWebhook` 带过期时间（通常约 1.5 小时，以 `sessionWebhookExpiredTime` 为准），长任务需主动发送兜底。
- Stream 回调为至少一次投递，必须做消息级去重。

**模型与数据**

- 钉钉消息与仓库上下文会发送给配置的模型 provider。若企业不允许代码出本机，必须改用本地模型或禁用外部 provider。
- 仓库内容是不可信输入（prompt injection 面），权限策略必须默认从严。

---

## 4. 总体架构

### 4.1 架构图

```
┌────────────────────┐   WSS(Stream, 出站)   ┌──────────────────────────────┐
│  钉钉 群聊 / 单聊   │ ◄─────────────────────► │  桥接程序（本机常驻进程）     │
│                    │                        │                              │
│  @机器人 触发任务   │   HTTPS(出站)          │  · DingTalk Adapter          │
│  文本命令 / 审批回执 │ ◄───────────────────── │  · 鉴权与白名单               │
└────────────────────┘   sessionWebhook /      │  · 会话路由 + 两级队列        │
                          OpenAPI 主动发送       │  · 任务状态机                │
                                                  │  · 审批编排 + 超时            │
                                                  │  · Outbox（事务性外发）      │
                                                  │  · SQLite（映射/去重/游标）  │
                                                  └──────────────┬───────────────┘
                                                                 │ 本机 HTTP + Basic Auth
                                                                 │ Service.discover()
                                                                 ▼
                                                  ┌──────────────────────────────┐
                                                  │ OpenCode 共享后台服务         │
                                                  │  session / inbox / event log │
                                                  │  permission / form / tools   │
                                                  └──────────────┬───────────────┘
                                                                 │ 同一服务 / 同一 session
                                                                 ▼
                                                  ┌──────────────────────────────┐
                                                  │ 终端 TUI（只读观察）          │
                                                  └──────────────────────────────┘
```

要点：

- 桥接程序**不监听任何入站端口**，只有出站 WSS（钉钉）与出站 HTTP（本机 OpenCode）。
- 图中的 "Webhook 回消息" 是**出站** HTTP POST（`sessionWebhook`），不是公网回调入口。
- TUI 与桥接程序是**平级客户端**，都连同一个 OpenCode 服务。

### 4.2 组件职责

| 组件 | 职责 | 不负责 |
|---|---|---|
| DingTalk Adapter | Stream 连接、消息解析、ack、去重键提取、回复发送（sessionWebhook / OpenAPI） | 业务判定 |
| AuthZ | 用户白名单、会话白名单、命令权限、审批人校验 | 决定放行哪些高风险操作 |
| Router | `conversationId` → 项目别名 → 项目目录 → OpenCode session 映射 | 决定项目目录内容 |
| Scheduler | 准入队列、项目级串行锁、任务提交（prompt）、取消、超时 | 执行任务 |
| Task State Machine | 任务状态迁移、事件归并、结果组装 | 直接调用 OpenCode 工具 |
| OpenCode Adapter | 服务发现、鉴权、session CRUD、prompt、event log、permission、form、interrupt | 消息收发 |
| Outbox | 待发消息持久化、限速、重试、过期降级 | 决定发什么 |
| Store | SQLite：去重、映射、游标、审批、outbox、审计 | 业务逻辑 |

### 4.3 信任边界

```
互联网/钉钉  ──不可信──▶  桥接程序  ──高权限──▶  OpenCode 服务  ──▶  本机文件系统/网络
                                  │                     │
                                  │                     └──▶ 模型 provider（数据出网）
                                  └──▶ SQLite（可能含代码/密钥）
```

- 桥接程序拥有 OpenCode 服务的完整权限（service Basic Auth 可调用全部 API），因此**必须**按高权限本地组件对待：不暴露网络端口、凭证最小化、审计留痕。
- 钉钉消息内容是**不可信用户输入**，绝不拼接进 system prompt。

### 4.4 部署形态

- 单机、单进程、单实例（文件锁防重复启动）。
- 通过 macOS `launchd` LaunchAgent 常驻，`KeepAlive` 自动拉起。
- 桥接程序**不负责** OpenCode 服务的启停；服务不可用时对外明确报"本机 OpenCode 未运行"。

---

## 5. OpenCode 集成设计

### 5.1 服务发现与认证

```ts
import { OpenCode, Service } from "@opencode/client/service"

const endpoint = await Service.discover()   // 不会启动新服务
if (!endpoint) throw new Error("opencode service not running")

const client = OpenCode.make({
  baseUrl: endpoint.url,
  headers: Service.headers(endpoint),      // Basic auth
})
```

规则：

1. **只用 `discover()`，不用 `ensure()`**。`ensure()` 会拉起一个新服务，破坏"同一个 session"的前提。
2. `discover()` 返回 `undefined` 时，桥接进入"OpenCode 不可用"模式：仍然连接钉钉，但所有任务命令返回"本机 OpenCode 未运行"，并以 5s→60s 退避重试发现。
3. 校验 `endpoint.url` 的 host 是 loopback（`127.0.0.1` / `::1` / `localhost`），否则拒绝连接并告警。
4. 若本机配置了 HTTP 代理，必须确保 `NO_PROXY` 包含 `localhost,127.0.0.1,::1`，否则桥接请求会被代理劫持。

### 5.2 版本与契约自检

启动时执行：

1. `GET /api/info` → 校验 `version` 落在允许区间（默认 `>=2.0.18 <2.1.0`）。
2. `GET /openapi.json` → 校验**必需路由**（method + path）存在：

   ```
   POST   /api/session
   GET    /api/session/{sessionID}
   GET    /api/session/active
   POST   /api/session/{sessionID}/prompt
   GET    /api/session/{sessionID}/inbox
   DELETE /api/session/{sessionID}/inbox/{inboxID}
   GET    /api/experimental/session/{sessionID}/log
   POST   /api/experimental/session/{sessionID}/interrupt
   GET    /api/session/{sessionID}/permission
   POST   /api/session/{sessionID}/permission/{requestID}/reply
   GET    /api/session/{sessionID}/form
   POST   /api/session/{sessionID}/form/{formID}/reply
   DELETE /api/session/{sessionID}/form/{formID}
   ```

   > **为什么按路由而不是 operationId 校验**：实测 2.0.18 的 operationId 是 `session.permission.reply` / `session.form.cancel`，官网最新版（2.0.32）改成了 `permission.reply` / `form.cancel`，但**路由完全一致**。operationId 在版本间会漂移，路由才是稳定契约。
3. 任一项不满足 → **fail closed**：不接任务，只回钉钉"本机 OpenCode 版本不兼容（当前 X，要求 Y）"。

客户端版本必须与服务端匹配并锁定（当前环境服务端 `2.0.18`，npm 上 `@opencode/client` 最新 `2.0.32`；不默认用 latest，需实测后锁定）。

### 5.3 Session 生命周期

- **创建**：收到第一个任务时懒创建，一个钉钉会话对应一个 active session。

  ```ts
  await client.session.create({
    location: { directory: project.directory },   // 绝对路径，来自白名单
    title: `DingTalk / ${conversationTitle} / ${alias} / ${timestamp}`,
    agent: "dingtalk",
    metadata: { source: "dingtalk-bridge", conversationID, projectAlias },
  })
  ```

- **复用**：后续任务复用同一 session，保留上下文（OpenCode 自带 compaction 处理长上下文）。
- **轮换**：`/new` 创建新 session 并更新映射（旧 session 保留，可在 TUI 中回看）。
- **失效**：OpenCode 返回 session 404 → 标记相关任务 `UNKNOWN`，通知钉钉"session 已被删除"，下次任务自动新建 session。

### 5.4 Prompt 与队列

```ts
await client.session.prompt({
  sessionID,
  id: task.opencodeMessageId,      // 幂等键，提交前生成并落库
  text: task.promptText,
  delivery: "queue",               // 绝不 steer
  metadata: { source: "dingtalk", taskID, conversationID, senderStaffID, msgID },
})
```

- `delivery` 固定 `"queue"`：即使 TUI 恰好在运行，输入也不会插进当前执行。
- `id` 幂等：网络重试复用同一 `id`；若服务端返回 409，则查询 `session.inbox.list` 确认是否已入队（见 §11.2）。
- `metadata` 会随 inbox item 保留，是**识别"是不是本桥接提交的输入"的唯一可靠依据**（见 §8.5）。
- 响应体是 `Session.Inbox.User`（inbox item），**不是**答案。

### 5.5 事件与状态获取（三层模型）

> ⚠️ 本节已按 **P0 探针实测（2026-10-20，服务端 2.0.18）** 修订。原文假设的"per-session durable log 是任务生命周期的权威来源"**不成立**——该端点在 2.0.18 中不返回任何业务事件（详见附录 A）。

**L1 · 全局事件流（低延迟，非持久）**

```
GET /api/event → client.event.subscribe()
```

- 覆盖 `permission.asked/replied`、`form.*`、`session.idle`、`session.status`、
  `session.inbox.enqueued/delivered`、`session.execution.succeeded/failed/interrupted`、
  `session.text.ended`、`session.step.*` 等。
- 性质：**live-only，断线丢事件，慢消费者会被断开。** 只能作为"尽快知道"的提示，**不能作为唯一事实源**。

**L2 · 消息时间线（持久化，权威）**

```
GET /api/session/{id}/message?order=asc&limit=N → client.message.list()
```

实测返回的时间线形态（每回合）：

```
msg_xxx  user      2026-10-20T05:42:53.043Z  :: 只回复 PONG。
msg_yyy  assistant 2026-10-20T05:42:53.051Z  :: PONG
msg_zzz  idle      2026-10-20T05:42:54.541Z  outcome=succeeded
```

- **`type:"idle"` 且带 `outcome` 的消息 = 回合结束标记**，是任务完成/失败/中断的**权威判据**（不带 outcome 的 stray idle 必须忽略，否则会提前结束任务）。
- 任务结果 = 该任务的 user 消息与 idle 标记之间的 assistant 文本片段。
- 该端点**持久且可分页**（`cursor.previous` / `cursor.next`），因此它是桥接程序重启后重建状态的唯一可靠依据。
- 锚点：`prompt` 响应返回的 `id` **就是**该任务 user 消息的 id，可直接用于"只取我这条任务之后的消息"。
- **分页陷阱**：`order=asc&limit=N` 返回的是**最早**的 N 条，长会话会把锚点挤出窗口 → 任务永远判不出结果。正确做法是**先取最新一页（`order=desc`）**，再用 `cursor.previous` 往回翻；且 **`cursor` 不能与 `order` 同时传**（服务端拒绝），翻页请求只能带 `cursor`。

**L3 · 空闲长轮询（降低轮询频率）**

```
POST /api/experimental/session/{id}/wait → client.session.wait()
```

- 实测：session 空闲时**立即**返回 `204`（2ms）；有任务在跑时**阻塞到 agent loop 变 idle**（实测 1504ms）。
- 因此它只能用作"何时去拉时间线"的触发器，**返回本身不能作为完成信号**（存在"提交后、执行尚未开始"的竞态）。
- 失败时返回 `503 ServiceUnavailableError`，需退避重试。

**降级能力（特性探测，默认不依赖）**

```
GET /api/experimental/session/{id}/log?after=<seq>&follow=true
```

- 2.0.18 实测：**任意 `after` 值都只返回 `log.synced`**，既不回放业务事件，也不推送实时事件。
- 保留为可选通道：启动时探测，若某版本开始回放真实事件则可作为加速层；**当前设计不依赖它**。

**轮询对账（兜底，权威补漏）**

- 每 2s 对"有活动任务的 session"执行：
  - `GET /api/session/{id}/message?order=asc` → 判断回合是否结束、收集结果文本；
  - `GET /api/session/{id}/permission` → 发现漏掉的待审批请求；
  - `GET /api/session/{id}/form` → 发现漏掉的 form；
  - `GET /api/session/{id}` → 读取 `outcome` / `time.idle`，校准状态。
- 桥接启动/重连后立即执行一次全量对账，重建"执行中但没收到事件"的任务状态。

### 5.6 权限审批

```
GET  /api/session/{id}/permission                 → client.permission.list({ sessionID })
POST /api/session/{id}/permission/{requestID}/reply → client.permission.reply({ sessionID, requestID, decision, message })
```

- `decision`：`once` | `always` | `reject`。
  - MVP **只开放** `once` 与 `reject`；`always` 会写入项目级持久 allow 规则，远程不得触发。
  - `reject` 的语义是"拒绝该请求并拒绝该 session 中所有其他待处理请求"。因此桥接**同时只保留一个待审批项**（发现第二个时先按 `reject` 兜底处理并在消息中说明）。
- 审批请求内容来自 `permission.asked` 事件：`action`、`resources[]`、`message`、`save[]`。
- 审批单落库后映射一个**短 ID**（如 `A-7F3K`，6 位 base32），钉钉侧用短 ID 回复，避免长串难输入。

### 5.7 Forms（question）

- MVP：`dingtalk` agent 的 `question` 权限为 `deny`，正常路径不会出现 form。
- 兜底：若仍收到 `form.created`，桥接通知用户"该任务需要交互式输入，MVP 不支持"，30s 后调用 `session.form.cancel` 取消；若取消失败则 `interrupt` 该任务。**不允许任务静默挂起。**
- v1.1：支持 `form.reply`，字段类型覆盖 string / number / boolean / select，超时 10 分钟自动取消。

### 5.8 中断与取消

```
POST /api/session/{id}/interrupt?resume=false   → client.session.interrupt({ sessionID, resume: false })
DELETE /api/session/{id}/inbox/{inboxID}         → client.session.inbox.cancel({ sessionID, inboxID })
```

`/cancel` 语义（MVP）：**取消当前任务 + 取消该 session 队列中所有待执行任务**。

1. 若有活动任务：`interrupt({ resume: false })`。
2. 遍历 `inbox.list`，对属于本桥接的任务逐个 `inbox.cancel`。
3. 任务状态置 `CANCELLED`，钉钉回执。

`resume=false` 会让已排队的输入继续停放，因此取消流程需要显式清空 inbox。

### 5.9 API 映射表

| 用途 | V2 端点 | 客户端方法 | 权威性 |
|---|---|---|---|
| 服务发现 / 鉴权 | —（本地注册文件） | `Service.discover()` / `Service.headers()` | — |
| 健康与版本 | `GET /api/info` | `client.server.info()` | 权威 |
| 契约自检 | `GET /openapi.json` | 原生 `fetch` | 权威（按路由） |
| 创建 session | `POST /api/session` | `client.session.create()` | 权威 |
| 读取 session | `GET /api/session/{id}` | `client.session.get()` | 权威（`outcome`/`time.idle`） |
| 活跃 session | `GET /api/session/active` | `client.session.active()` | 权威 |
| 提交任务 | `POST /api/session/{id}/prompt` | `client.session.prompt()` | 权威（返回 user 消息 id） |
| inbox 查询 | `GET /api/session/{id}/inbox` | `client.session.inbox.list()` | 权威 |
| inbox 取消 | `DELETE /api/session/{id}/inbox/{inboxID}` | `client.session.inbox.cancel()` | 权威 |
| **消息时间线** | `GET /api/session/{id}/message?order=asc` | `client.message.list()` | **权威（任务结果 + idle 回合标记）** |
| 等待空闲 | `POST /api/experimental/session/{id}/wait` | `client.session.wait()` | 触发器（不可单独作完成判据） |
| 全局事件 | `GET /api/event` | `client.event.subscribe()` | 提示（live-only） |
| 待审批列表 | `GET /api/session/{id}/permission` | `client.permission.list()` | 权威 |
| 审批回复 | `POST /api/session/{id}/permission/{requestID}/reply` | `client.permission.reply()` | 权威 |
| form 列表/回复/取消 | `GET/POST/DELETE /api/session/{id}/form...` | `client.session.form.list/reply/cancel()` | 权威 |
| 中断 | `POST /api/session/{id}/interrupt` | `client.session.interrupt()` | 权威 |
| 事件日志（降级） | `GET /api/experimental/session/{id}/log` | `client.session.log()` | **2.0.18 无业务事件，不依赖** |

> 客户端库的方法名跟随最新版 API（如 `client.permission.reply`），服务端 operationId 可能不同（2.0.18 为 `session.permission.reply`）——**路由一致即可用**。

### 5.10 事件处理表

| 事件 / 信号 | 通道 | 处理 |
|---|---|---|
| `session.inbox.enqueued` | L1 | item 无桥接 `metadata` → 判定为**外部输入**（§8.4）；否则确认任务已入队 |
| `session.inbox.delivered` | L1 | 对应 `inboxID` 的任务 → `RUNNING`；记录"当前任务" |
| `session.execution.started` | L1 | 当前任务 → `RUNNING`（补齐漏事件场景） |
| `session.text.ended` | L1 | 累积该任务的 assistant 文本片段（按 `assistantMessageID` + `ordinal` 幂等落库） |
| `session.execution.succeeded` | L1 | **触发**一次时间线拉取；最终判定仍以时间线的 `idle` 标记为准 |
| `session.execution.failed` | L1 | 触发时间线拉取 |
| `session.execution.interrupted` | L1 | 触发时间线拉取 |
| `session.inbox.cancelled` | L1 | 对应任务 → `CANCELLED` |
| `session.idle` | L1 | 触发一次时间线拉取，**不作为完成判定** |
| **时间线出现 `type:"idle"` 且带 `outcome` 的消息** | L2 | **权威完成判据**：该 user 消息之后的 idle 标记，其 `outcome` 即任务终态 |
| **时间线中的 assistant 消息** | L2 | **权威结果文本**（事件流只作加速） |
| `permission.asked` | L1 + L2 轮询 | 建审批单 + 钉钉审批消息；任务 → `WAITING_APPROVAL` |
| `permission.replied` | L1 + L2 轮询 | 更新审批单；任务回到 `RUNNING`；若非桥接发起 → 标记 `REMOTE_HANDLED` |
| `form.created` | L1 + L2 轮询 | MVP：通知 + 延时取消 |
| `form.replied` / `form.cancelled` | L1 + L2 轮询 | 更新状态 |
| `session.compaction.*` | L1 | 仅记录日志，MVP 不发用户态消息 |
| `session.tool.*` / `session.step.*` | L1 | 仅用于进度计数与心跳，不逐条推送 |

---

## 6. 钉钉集成设计

### 6.1 Stream 接入

- 回调 topic：`/v1.0/im/bot/messages/get`。
- 客户端：`dingtalk-stream`（Node，当前 `2.1.6-beta.1`，需锁定版本；备选 Python 官方 SDK）。
- 凭证：`clientId` / `clientSecret` 来自企业内部机器人应用的 Stream 模式配置。

### 6.2 消息字段使用

| 字段 | 用途 |
|---|---|
| `msgId` | **去重键**（主键） |
| `conversationId` | 会话路由键 |
| `conversationType` | `1`=单聊，`2`=群聊 |
| `conversationTitle` | 仅展示，不参与路由 |
| `senderStaffId` | **身份鉴权**（外部成员为空 → 拒绝） |
| `senderNick` | 仅展示 |
| `msgtype` / `text.content` | 消息正文（MVP 仅支持 `text`） |
| `isInAtList` | 群聊必须为 true 才处理 |
| `sessionWebhook` / `sessionWebhookExpiredTime` | 回复通道 |
| `robotCode` | 主动发送兜底 |
| `createAt` | 排序与超时判定 |

### 6.3 ack、去重与鉴权顺序

处理顺序固定为：

```
1. 解析 payload
2. msgtype != text            → 忽略（回一句"暂仅支持文本"可选）
3. 群聊且 !isInAtList        → 忽略
4. senderStaffId 为空        → 记审计 REJECTED，不回消息（外部成员）
5. senderStaffId 不在白名单  → 回"无权限"（不含任务细节）
6. conversationId 未映射项目 → 回"该群未绑定项目"
7. msgId 已存在              → 静默忽略（已 ack 过）
8. 限流/队列深度检查         → 超出则回"排队已满/请求过于频繁"
9. 事务内写入 inbound_messages + tasks(PENDING)
10. 成功提交后立刻 ack（返回空对象）
11. 异步交给 Scheduler 处理
```

- **第 9 步必须先落库再 ack**；落库失败则**不 ack**，让钉钉重投。
- 群聊中要去掉正文开头的 @机器人 片段。

### 6.4 回复通道

优先级：

1. **sessionWebhook**（消息自带，最简单）：POST `https://oapi.dingtalk.com/robot/sendBySession?session=...`，body 为
   `{"msgtype":"text","text":{"content":"..."},"at":{"atUserIds":[...],"isAtAll":false}}`。
   - 保存 `sessionWebhook` 与 `sessionWebhookExpiredTime`，过期后不再使用。
   - **该 URL 等同凭证，禁止写入日志。**
2. **OpenAPI 主动发送**（兜底）：`robotCode` + `openConversationId`（群）/ `userIds`（单聊），需先换 `accessToken` 并缓存。
   - 群消息单条有长度与频率限制，长结果需分片或截断。

所有出站消息一律经 **Outbox** 发送（§9.2）。

### 6.5 消息规范

- 结果摘要上限 `maxResultChars`（默认 3500 字符），超出截断并附"完整结果见本机 TUI"。
- 中间状态消息只发关键里程碑：已接收 / 排队位置 / 开始执行 / 需要审批 / 完成 / 失败 / 取消。
- 每个任务最多 1 条"开始执行"、1 条审批请求、1 条最终结果；不推送 token 级流式输出。
- 长任务（> `maxTaskDurationMs`，默认 2h）强制中断并通知，防止成本失控。
- 群聊中审批内容（shell 命令、路径）对全群可见；如项目敏感，可配置 `approvalChannel: "dm"` 走单聊（v1.1）。

### 6.6 桥接命令

| 命令 | 行为 |
|---|---|
| `/task <描述>` | **执行一个任务**（唯一会真正动手的入口） |
| `/ask <问题>` | 只读问答，走独立的只读 session（`dingtalk-chat` agent，不能改文件/跑命令） |
| `/new` | 轮换 session（当前有活动任务时拒绝） |
| `/status` | 返回项目、sessionID、当前任务、队列深度、待审批 ID、最近结果 |
| `/sessions` | **本机所有 OpenCode session 概览**：运行中/空闲、agent、项目目录、最后更新时间、"正在跑什么"（最后一个工具调用或叙述）；桥接自己的 session 标注 `〔本桥接〕` |
| `/cancel` | 取消当前任务 + 队列中全部待执行任务 |
| `/resume` | 解除"人工接管暂停"，恢复自动派发 |
| `/help` | 命令列表 |
| `#approve <approvalID>` | 批准一次（仅 `once`） |
| `#reject <approvalID> [原因]` | 拒绝 |
| `允许` / `拒绝` | 快捷审批：仅当该会话**只有一个**待确认项时生效，多个会回列表要求指定编号 |
| `#answer <formID> <值>` | v1.1 表单应答 |

命令只允许白名单用户使用；`#approve` 只允许审批人使用（§8.2）。

### 6.7 意图分流（关键安全边界）

默认 `taskMode: "prefix"`：**只有显式指令才成为任务**。

| 输入 | 处理 |
|---|---|
| `/task <描述>` | 建任务（kind=`task`），走完整执行链路 |
| `/ask <问题>` | 建任务（kind=`ask`），走**同一套持久化链路**：只读 agent session（`dingtalk-chat`：read/glob/grep/web 允许，edit/shell/external_directory deny），不占项目锁，不加"摘要"后缀 |
| 其他文本 | **不建任务**，回一条本地状态回复（当前任务 / 队列 / OpenCode 与钉钉连接状态 / 上次任务 / 用法提示）。**零模型调用、零副作用** |

理由：群聊里一句"你在干啥"、"收到"、"谢谢"如果被当成任务，就等于**任何一句闲聊都可能触发本机远程执行**。`taskMode: "always"` 可恢复旧行为，但生产不建议。

本地状态回复是"诚实的零成本答案"：它报告的是桥接自己的真实状态（任务队列、连接、版本），不是模型编的内容。

**`/ask` 为什么也走任务管线**：问答同样要落库（task 行）、同样靠时间线判定结束、同样经 outbox 投递。这样即使 bridge 在回答途中重启，答案仍会在恢复后送达，而不是随进程一起消失。`kind` 字段区分两者（迁移 v3）。

### 6.8 通知：别的 session 跑完时 ping 一下

用户常常同时开着多个 OpenCode session（别的 TUI 标签页、别的项目），不可能一直盯着终端。桥接因此对**自己之外的** session 完成后发一条钉钉通知。

- **触发**：全局事件流里的 `session.execution.succeeded|failed|interrupted`（秒级）。
- **兜底**：事件流是 live-only 会丢事件，所以每 60s 扫一次最近更新的 session（看 `time.idle`），靠 idle 时间戳去重。
- **去重键**：`notify:<sessionID>:<idleTs>:<conversationID>`，写进 outbox 的唯一索引 → 事件路径与扫描路径不会重复发。
- **排除**：桥接自己的 task session 与 chat session 走任务回执，不重复通知。
- **内容**：标题、目录、agent、最后一段助手输出摘要（≤300 字）。
- **开关**：`bridge.notifyOtherSessions`（默认开）、`bridge.notifyConversations`（默认=绑定的群）、`bridge.notifyMinIntervalMs`（默认 60s）。

### 6.9 观察本机其它 session

TUI 一次只能看一个 session，"其它 session 在干什么"没有内置入口。桥接补上这个视角：

- `/sessions` → 列出本机最近的 OpenCode session：运行中（`▶️`）/空闲（`○`）、标题、agent、项目目录、最后更新时间，以及**正在做什么**（最后一个工具调用如"正在跑 shell"，或最后一段叙述 / 推理）。
- 闲聊分支的状态回复里也带一行"其它运行中的 session"。
- 桥接自己创建的 session 标注 `〔本桥接〕`。

数据来源：`GET /api/session?limit=N`（列表）+ `GET /api/session/active`（运行中集合）+ 每个 session 的 `GET /api/session/{id}/message?order=desc&limit=1`（最后一条消息）。

### 6.8 Agent 的安装位置（易踩的坑）

OpenCode 只在**session 的 location 及其上级目录** + **全局 `~/.config/opencode/agents/`** 里发现 agent。桥接的 session 建在*项目*目录（例如 `~/tms/tms-web`），因此 `dingtalk` / `dingtalk-chat` 两个 agent 必须装在全局目录：

```
~/.config/opencode/agents/dingtalk.md
~/.config/opencode/agents/dingtalk-chat.md
```

放在桥接自己的仓库里对项目 session **无效**，会导致 `session.create({agent:"dingtalk"})` 报 AgentNotFound。

---

## 7. 路由、会话与并发

### 7.1 映射

```
conversationId ──▶ projectAlias ──▶ directory（绝对路径，白名单）
                        │
                        └──▶ activeSessionId ──▶ OpenCode session
```

- 映射来自配置文件，**不由消息内容决定**。`/project` 切换为 v1.1。
- 一个钉钉会话 → 一个项目 → 一个 active session。
- 同一项目可被多个钉钉会话引用，此时用**项目级串行锁**避免并发写同一 worktree。

### 7.2 两级队列

| 层级 | 归属 | 语义 |
|---|---|---|
| 准入队列（PENDING） | 桥接 | 等项目锁、等前一个任务结束、限流 |
| 执行队列（SUBMITTED） | OpenCode inbox | 已在 OpenCode 中排队/执行 |

- 桥接**同一 session 同时只提交一个任务**；后续任务留在 PENDING，当前任务进入终态后再提交下一个。
- 这样保证"同一 session 任务有序执行"，且任务与 `inboxID` 一一对应，便于取消与结果归并。
- `delivery: "queue"` 仍作为兜底（防止 TUI 恰好在跑时发生 steer）。

### 7.3 项目级串行锁

- 存储：`project_locks(project_alias PK, task_id, owner_pid, expires_at, updated_at)`。
- 获取：事务内条件更新（`expires_at < now` 或不存在）→ 成功即持锁。
- 续租：每 30s 刷新 `expires_at`（租约 90s），避免进程崩溃后死锁。
- 释放：任务进入终态时释放；启动时清理过期租约。

### 7.4 任务状态机

```
                    ┌──────────────┐
   收到消息 ───────▶│  RECEIVED    │
                    └──────┬───────┘
          鉴权/限流失败       │ 通过
                    ┌──────▼───────┐
                    │  PENDING     │  等项目锁 / 等前序任务
                    └──────┬───────┘
          获得锁并提交      │ prompt 成功（拿到 inboxID）
                    ┌──────▼───────┐
                    │  SUBMITTED   │  已在 OpenCode inbox
                    └──────┬───────┘
          inbox.delivered  │
                    ┌──────▼───────┐        permission.asked
                    │   RUNNING    │◀──────────────────────────┐
                    └──┬───┬───┬───┘                           │
        execution.      │   │   │  permission.replied ────────┘
        succeeded  ┌────┘   │   └────┐
              ┌────▼────┐ ┌─▼──────┐ ┌▼──────────────┐
              │SUCCEEDED│ │ FAILED │ │ INTERRUPTED   │
              └─────────┘ └────────┘ └───────────────┘
                    ▲
      外部输入介入 ──┘ HUMAN_INTERVENED（叠加标记，继续跟踪）
                    ▲
      取消 ──────────┘ CANCELLED
                    ▲
      桥接重启/对账失败 ── UNKNOWN（终态但结果不确定）
```

补充规则：

- `WAITING_APPROVAL` 是 `RUNNING` 的子状态；审批被拒后任务**仍回到 RUNNING**，由 Agent 自行决定后续（可能成功、可能失败）。`reject` 不会直接终结任务。
- 外部输入介入不会终止任务，只打标记并发一条提示。

### 7.5 TUI 共存

- TUI 通过 `/sessions` 打开对应 session 即可实时看到执行过程；**TUI 不会自动跳转**。
- session 标题与 metadata 带钉钉来源标识，便于在 TUI 中定位。
- `/status` 回显 `sessionID`（短前缀），方便在 TUI 中检索。

---

## 8. 审批与人机交互

### 8.1 权限策略（预设可切换）

策略以**预设**形式配置：`projects[].permissionPreset` = `default` | `strict`；也可直接给 `projects[].permissions` 显式规则覆盖预设。

**`default`（当前启用）——对齐 OpenCode 原生放行**

| action | effect | 说明 |
|---|---|---|
| `read` / `glob` / `grep` / `edit` / `shell` / `webfetch` / `websearch` / `external_directory` | allow（OpenCode 默认） | 与本机 TUI 的默认体验一致 |
| `question` | **deny** | 功能性限制：MVP 没有应答通道，否则任务会永久挂起 |
| `subagent` | **deny** | 功能性限制：子 session 的审批请求桥接看不到 |

两条 deny 都是**硬拒绝**，不会弹审批框，因此不影响"不被打断"的体验。

**`strict`——原硬化档**

| action | effect |
|---|---|
| `read` / `glob` / `grep` | allow（项目内） |
| `edit` | allow（项目内） |
| `shell` | **ask** |
| `external_directory` | **deny** |
| `webfetch` / `websearch` | ask |
| `question` / `subagent` | deny |

补充：

- 预设切换**不需要新建 session**：桥接在 reconcile 时用 `PATCH /api/session/{id}` 把当前 session 的 ruleset 改写为生效预设（D9）。
- 放开 `subagent`（v1.1）必须同时跟踪 `parentID` 子 session 的审批请求，否则子 session 的 `ask` 无人应答。
- 组织级硬拒绝仍可用 OpenCode 的 `policies`（`tool.use` 规则），优先级高于项目配置。
- **`default` 预设下的安全边界只剩三处**：钉钉用户/会话白名单、项目目录白名单、审计日志。远程输入因此等同于本机输入，务必保证机器人账号与可见范围安全。

### 8.2 审批流（4 条渠道）

```
permission.asked
  → 建审批单（approvalID 短码，expires_at = now + 10min）
  → 同时推送到 4 个渠道（任一先响应者生效，其余自动失效）
```

| # | 渠道 | 交互 | 实现 |
|---|---|---|---|
| ① | **TUI 原生弹窗** | 终端里点允许/拒绝 | OpenCode 自身渲染；桥接从 `permission.replied` 识别为 `REMOTE_HANDLED` 并回钉钉告知 |
| ② | **Mac 原生对话框** | 桌面弹窗，点「允许一次 / 拒绝」，10 分钟自动关闭 | `osascript display dialog ... giving up after 600`（`src/approvals/mac-dialog.ts`） |
| ③ | **钉钉回「允许 / 拒绝」** | 手机上直接发两个字 | 该会话**只有一个**待确认项时生效；多个则回列表要求指定编号 |
| ④ | **本机 CLI** | 终端 `npm run cli -- approve A-7F3K` | `scripts/bridge-cli.ts`（`status` / `approvals` / `approve` / `reject`） |

钉钉消息仍然照发（`#approve A-7F3K` / `#reject A-7F3K`），作为**跨设备兜底**与留痕。

规则：

- 钉钉渠道与 CLI 渠道：只有**任务发起人**（或配置的 `approvers`）可以批准/拒绝，其他人的请求被拒绝并记录审计。
- Mac 对话框属于本机操作，等价于本机用户在场，默认放行给发起人上下文。
- 审批短码与 conversation + task 绑定，不允许跨会话使用。
- 审批消息展示 action 与 resources；如包含敏感内容，配置 `approvalChannel: "dm"`。
- 同一审批单只认第一个决定：数据库层用 `UPDATE ... WHERE status='PENDING'` 抢占，失败即"已被处理"。
- 弹窗同一审批项最多每 3 分钟弹一次，避免被关掉后反复骚扰。

### 8.3 超时与并发

- 超时任务每 5s 扫描一次；事务内 `UPDATE ... WHERE status='PENDING'` 抢占，先到先得，避免"人工批准"与"超时拒绝"同时下发。
- 超时拒绝后任务继续运行（Agent 收到拒绝结果），并钉钉告知"审批超时，已自动拒绝"。

### 8.4 人工接管（TUI 输入）

- 任何 `session.inbox.enqueued` 事件，若 item 的 `payload.metadata.source !== "dingtalk"` 或缺少 `taskID`，判定为**外部输入**。
- 触发：当前任务标记 `HUMAN_INTERVENED`；钉钉提示"检测到本机 TUI 输入，结果仅供参考"；该 session 置 `control_mode=PAUSED`，暂停自动派发新任务。
- 恢复：`/resume` 清除暂停（若仍有未处理的外部输入则拒绝恢复）。
- 原因：TUI 的 Enter 是 steer，外部输入会插入当前执行，破坏任务边界与审批归属。

### 8.5 任务结果

- 结果文本 = 该任务窗口内 `session.text.ended` 的文本片段按 `ordinal` 拼接。
- 桥接在提交 prompt 时附加固定后缀（不污染 system prompt）：

  ```
  <用户原文>

  ---
  [Bridge] 完成后请用不超过 3000 字的摘要回复，包含：做了什么、改了哪些文件、测试结果、遗留问题。不要提问。
  ```

- 结果超长截断；失败时回传 `SessionStructuredError` 的 type + message，不回传堆栈。
- 错误信息中不暴露项目外路径、token、代理配置。

---

## 9. 数据模型（SQLite）

### 9.1 表结构

```sql
-- 版本
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);

-- 钉钉会话 → 项目 / active session
CREATE TABLE conversations (
  conversation_id        TEXT PRIMARY KEY,
  conversation_type      INTEGER NOT NULL,          -- 1 单聊 / 2 群聊
  title                  TEXT,
  project_alias          TEXT NOT NULL,
  active_session_id      TEXT,
  session_webhook        TEXT,                      -- 过期即失效
  webhook_expires_at     INTEGER,
  last_msg_at            INTEGER,
  created_at             INTEGER NOT NULL
);

-- OpenCode session 状态
CREATE TABLE sessions (
  session_id        TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL,
  project_alias     TEXT NOT NULL,
  title             TEXT,
  control_mode      TEXT NOT NULL DEFAULT 'BRIDGE', -- BRIDGE / PAUSED
  last_poll_at    INTEGER,                          -- 最近一次时间线拉取时间
  created_at        INTEGER NOT NULL,
  last_active_at    INTEGER
);

-- 任务
CREATE TABLE tasks (
  task_id             TEXT PRIMARY KEY,             -- ULID
  msg_id              TEXT NOT NULL UNIQUE,          -- 钉钉 msgId 去重
  conversation_id     TEXT NOT NULL,
  sender_staff_id     TEXT NOT NULL,
  project_alias       TEXT NOT NULL,
  session_id          TEXT,
  inbox_id            TEXT UNIQUE,                  -- OpenCode inbox item
  opencode_message_id TEXT,                         -- = 该任务 user 消息 id（时间线锚点）
  approval_id         TEXT,                         -- 当前审批短码
  prompt_text         TEXT,
  status              TEXT NOT NULL,                -- 状态机
  outcome             TEXT,                         -- succeeded/failed/interrupted
  error_code          TEXT,
  error_message       TEXT,
  result_summary      TEXT,
  human_intervened    INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  submitted_at        INTEGER,
  started_at          INTEGER,
  finished_at         INTEGER
);
CREATE INDEX idx_tasks_status  ON tasks(status);
CREATE INDEX idx_tasks_session ON tasks(session_id);
CREATE INDEX idx_tasks_conv    ON tasks(conversation_id);
CREATE INDEX idx_tasks_created ON tasks(created_at);

-- 任务结果片段（幂等累积）
CREATE TABLE task_messages (
  task_id      TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  ordinal      INTEGER NOT NULL,
  kind         TEXT NOT NULL,                      -- assistant_text
  text         TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (task_id, message_id, ordinal)
);

-- 审批
CREATE TABLE approvals (
  approval_id     TEXT PRIMARY KEY,                 -- 短码 A-7F3K
  task_id        TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  request_id     TEXT NOT NULL,                     -- OpenCode permission id
  action         TEXT NOT NULL,
  resources      TEXT,                              -- JSON
  message        TEXT,
  status         TEXT NOT NULL,                     -- PENDING/APPROVED/REJECTED/TIMEOUT/REMOTE_HANDLED
  requested_at   INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  decided_at     INTEGER,
  decided_by     TEXT,
  decision_note  TEXT
);
CREATE INDEX idx_approvals_pending ON approvals(status, expires_at);

-- 出站消息（事务性 outbox）
CREATE TABLE outbox (
  outbox_id      TEXT PRIMARY KEY,
  dedupe_key     TEXT NOT NULL UNIQUE,
  task_id        TEXT,
  conversation_id TEXT NOT NULL,
  kind           TEXT NOT NULL,                     -- STATUS/APPROVAL/RESULT/ERROR
  payload        TEXT NOT NULL,                     -- JSON
  status         TEXT NOT NULL,                     -- PENDING/SENDING/SENT/FAILED
  attempts       INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  sent_at        INTEGER
);
CREATE INDEX idx_outbox_due ON outbox(status, next_attempt_at);

-- 入站消息去重
CREATE TABLE inbound_messages (
  msg_id       TEXT PRIMARY KEY,
  received_at  INTEGER NOT NULL,
  status       TEXT NOT NULL,                       -- ACCEPTED/REJECTED
  reason       TEXT,
  processed_at INTEGER
);

-- 项目级串行锁（租约）
CREATE TABLE project_locks (
  project_alias TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  owner_pid     INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 审计
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  actor_type  TEXT NOT NULL,                        -- USER/BRIDGE/SYSTEM
  actor_id    TEXT,
  action      TEXT NOT NULL,
  task_id     TEXT,
  session_id  TEXT,
  conversation_id TEXT,
  detail      TEXT,                                 -- JSON，已脱敏
  result      TEXT
);
CREATE INDEX idx_audit_ts ON audit_log(ts);
```

### 9.2 事务与幂等

- **事务性 outbox**：任务状态变更、游标推进、outbox 入队在**同一个事务**内提交，避免"状态变了但消息没发"或"消息发了但状态没落"。
- **事件处理幂等**：所有 handler 以 `task_id` / `inbox_id` / `(message_id, ordinal)` 为幂等键；重放不产生重复副作用。
- **outbox 发送**：至少一次。发送成功后标记 SENT；崩溃导致重复发送的概率存在，消息中携带 `taskID` 便于人工识别。
- **审批抢占**：`UPDATE approvals SET status=... WHERE approval_id=? AND status='PENDING'`，受影响行数为 0 表示已被处理。
- SQLite 开启 `WAL` + `busy_timeout=5000` + `foreign_keys=ON`；迁移在事务内执行，迁移前自动备份。

### 9.3 保留期

| 数据 | 保留 |
|---|---|
| `inbound_messages` | 7 天（去重窗口） |
| `tasks` / `task_messages` | 30 天 |
| `audit_log` | 90 天 |
| `outbox`（SENT/FAILED） | 14 天 |

数据库文件权限 `0600`；依赖 FileVault 落盘加密。

---

## 10. 端到端流程

### 10.1 正常路径

```
用户        钉钉          Bridge            SQLite        OpenCode
 │           │             │                  │             │
 │─text────▶│             │                  │             │
 │           │─Stream────▶│                  │             │
 │           │             │─查重+鉴权───────▶│             │
 │           │             │─事务: 落 inbound + task(PENDING) │
 │           │◀──ack──────│                  │             │
 │           │◀"已接收"───│(outbox)          │             │
 │           │             │─取项目锁────────▶│             │
 │           │             │─prompt(queue)──────────────────▶│
 │           │             │◀─inbox item────────────────────│
 │           │             │─事务: task=SUBMITTED, inbox_id ─▶│
 │           │             │                  │             │
 │           │             │◀─inbox.delivered────────────────│
 │           │◀"执行中"───│(outbox)          │             │
 │           │             │◀─text.ended─────────────────────│
 │           │             │◀─execution.succeeded─────────────│
 │           │             │─事务: task=SUCCEEDED + 结果 ────▶│
 │           │◀"结果"─────│(outbox)          │             │
```

### 10.2 审批路径

见 §8.2。关键点：审批期间任务处于 `WAITING_APPROVAL`，TUI 中同样能看到 OpenCode 的权限提示（本地可处理，但会以 `REMOTE_HANDLED` 记录）。

### 10.3 取消路径

```
/cancel → 事务: 抢占任务 → interrupt(resume:false) → 逐个 inbox.cancel
        → task=CANCELLED → outbox 通知
```

### 10.4 桥接重启恢复

```
启动 → 单实例锁 → 配置校验 → Service.discover() → 版本/契约自检
     → 对账: sessions 有活动任务 → 重新拉取消息时间线（GET /message?order=asc）重建状态
     → 补发 outbox 中未发送消息 → 恢复 Scheduler
```

- 重放期间收到的 `execution.succeeded` + `text.ended` → 组装结果并补发钉钉（**不重复执行**）。
- 游标丢失（`sessions` 记录损坏）时：退化为 `session.get`（`outcome`）+ `message.list` 还原；仍无法判定则标记 `UNKNOWN` 并告知钉钉"结果不确定，请查看本机 TUI"。

### 10.5 OpenCode 不可用

- Bridge 在线、OpenCode 离线：钉钉收到"⚠️ 本机 OpenCode 未运行，任务未提交"，不建任务。
- OpenCode 恢复：下一次命令自动重试发现，无需重启 bridge。
- Bridge 离线：钉钉消息不会被接收（本机无进程），**不会有任何本机执行**。Bridge 重启后若钉钉重投，靠 `msgId` 去重。

### 10.6 人工介入

见 §8.4。

---

## 11. 错误处理与可靠性

### 11.1 错误码

| 错误码 | 触发 | 用户可见文案 | 动作 |
|---|---|---|---|
| `AUTH_DENIED` | 用户/会话未授权 | 无权限 | 审计 |
| `DUP_MESSAGE` | msgId 重复 | 静默 | 忽略 |
| `RATE_LIMITED` | 频率超限 | 请求过于频繁 | 计数 |
| `QUEUE_FULL` | 队列/并发超限 | 排队已满 | 计数 |
| `NO_PROJECT` | 会话未绑定项目 | 该群未绑定项目 | 审计 |
| `OPENCODE_UNAVAILABLE` | 服务未发现/401 | 本机 OpenCode 未运行 | 退避重试 |
| `VERSION_MISMATCH` | 版本/契约不符 | 本机 OpenCode 版本不兼容 | fail closed |
| `PROMPT_REJECTED` | prompt 4xx | 任务提交失败 | 终态 |
| `PROMPT_CONFLICT` | 409 | （内部） | 查 inbox 判定 |
| `SESSION_MISSING` | session 404 | 会话已被删除 | 标 UNKNOWN |
| `APPROVAL_TIMEOUT` | 超时 | 审批超时，已自动拒绝 | 终态（审批维度） |
| `HUMAN_INTERVENED` | 检测到外部输入 | 检测到本机输入 | 标记 |
| `TASK_TIMEOUT` | 超过最大时长 | 任务超时，已中断 | 终态 |
| `OUTBOX_FAILED` | 多次发送失败 | （不打扰用户） | 死信 + 告警 |
| `CANCELLED` | 用户取消 | 任务已取消 | 终态 |

### 11.2 重试矩阵

| 场景 | 策略 |
|---|---|
| OpenCode 5xx / 网络错误 | 3 次，指数退避 1s/2s/4s；prompt 复用同一 `id` 保证幂等 |
| OpenCode 401 | 视为服务不可用，重新 `discover()`，退避 5s→60s |
| OpenCode 409（prompt） | 查 `inbox.list`，命中同 taskID 则视为已入队；否则按失败处理 |
| OpenCode 404（permission/form） | 视为已被他方处理，标记 `REMOTE_HANDLED` |
| OpenCode 404（session） | 标 `UNKNOWN`，通知；下次任务新建 session |
| 钉钉 outbox 5xx/429 | 最多 8 次，退避 1m→2m→…→30m，跨度 24h |
| 钉钉 4xx（非 429） | 不重试，标 FAILED |
| sessionWebhook 过期 | 切 OpenAPI 主动发送；仍失败则 FAILED |
| Stream 断连 | SDK 自动重连；重连后立即对账 + 重放去重 |
| 事件流断连 | 重新订阅全局 `/api/event`；期间的状态由时间线轮询兜底（durable） |

### 11.3 超时与限额

| 项 | 默认 |
|---|---|
| prompt HTTP 超时 | 30s |
| 钉钉回调处理（ack 前） | < 1s |
| Outbox 单条发送超时 | 15s |
| 审批超时 | 10 min |
| 任务最大时长 | 2 h |
| 单会话排队任务上限 | 10 |
| 单用户每小时任务上限 | 20 |
| 单条 prompt 长度上限 | 8000 字符 |
| 结果摘要长度上限 | 3500 字符 |
| Agent `steps` 上限 | 40 |
| 项目锁租约 | 90s（30s 续租） |

### 11.4 单实例

- 启动时对 `runtime/bridge.lock` 加文件锁（含 PID）；拿不到锁则退出，避免两个 bridge 抢同一批任务。
- `launchd` 的 `KeepAlive` 与文件锁共同保证"崩溃自动重启 + 不重复运行"。

---

## 12. 安全设计

### 12.1 认证与授权

| 层 | 机制 |
|---|---|
| 钉钉 Stream | `clientId`/`clientSecret` 建立 WSS，消息由钉钉签名投递 |
| 钉钉用户 | `senderStaffId` 白名单（外部成员为空 → 拒绝） |
| 钉钉会话 | `conversationId` → 项目白名单 |
| 命令 | 仅白名单用户；`#approve` 仅审批人 |
| 项目目录 | 配置白名单，消息内容不可影响 |
| OpenCode | service Basic Auth（`Service.headers`），不回退到匿名 |
| 桥接程序自身 | 不监听入站端口；单实例锁 |

### 12.2 凭证

- 钉钉 `clientSecret`：macOS Keychain 存放，launchd 启动包装脚本读取后注入环境变量；**不写入仓库、不写日志**。
- OpenCode Basic Auth：运行时从 `Service.discover()` 获取，仅驻留内存，不落盘。
- `sessionWebhook` / 钉钉 `accessToken`：等同凭证，落库时加密或限制文件权限，日志一律脱敏。
- 日志脱敏规则：`authorization`、`clientSecret`、`accessToken`、`sessionWebhook`、`prompt` 全文不记录（只记长度与哈希）。

### 12.3 提示注入与外泄

- 仓库文件、issue 文本、网页内容都是不可信输入；模型可能被诱导执行高危命令。
- 防线顺序：**目录边界（external_directory deny）→ 命令边界（shell ask）→ 出网边界（webfetch/websearch ask）→ 人工确认**。
- 审批消息展示原始 action/resource，避免"看起来无害"的包装。
- 不因"看起来无害"而自动批准：`always` 永不在远程开放。

### 12.4 数据出境与留存

- 任务文本与结果含源码/密钥，SQLite `0600` + 保留期（§9.3）+ FileVault。
- 传给模型 provider 的内容超出本机控制范围；若企业不允许，需改本地模型（v1.1 议题）。
- 钉钉侧同样留存消息内容，需与企业 IM 数据策略对齐（不在本程序范围内，但属落地前提）。

---

## 13. 可观测性与运维

### 13.1 日志

- 结构化 JSON 行（stdout），launchd 落盘并轮转。
- 字段：`ts, level, event, taskID, sessionID, msgID, conversationID, action, durationMs, outcome`。
- 事件示例：`bridge.start`、`dingtalk.message`、`task.admitted`、`task.submitted`、`task.running`、`approval.requested`、`approval.decided`、`task.succeeded`、`task.failed`、`opencode.unavailable`、`opencode.reconnected`、`outbox.sent`、`outbox.failed`。

### 13.2 审计

`audit_log` 记录：谁（`senderStaffId`）、在哪个群、对哪个项目/session/task、做了什么、审批决定、结果。默认 90 天，导出时脱敏。

### 13.3 健康

- 无入站端口。健康通过三处观察：
  1. `runtime/heartbeat.json`（PID、启动时间、最近钉钉消息时间、最近 OpenCode 事件时间、队列深度、OpenCode 版本）；
  2. `runtime/bridge.log`；
  3. `opencode service status` / `opencode api get /api/info`。
- 提供 `bridge status` 本地 CLI 读取上述文件。

### 13.4 部署（launchd LaunchAgent）

已实现：`scripts/install-launchd.sh`（`npm run install:launchd` / `npm run uninstall:launchd`）。

- Label：`com.opencode.dingtalk-bridge`，安装到 `~/Library/LaunchAgents/`。
- `ProgramArguments`：`<node绝对路径> <项目>/dist/index.js`（先 `npm run build` 产出 `dist/`，运行时不依赖 tsx）。
- `WorkingDirectory`：项目根；`EnvironmentVariables` 写入 `PATH`（含 nvm 的 node/bin 目录，保证能解析到 `opencode`）与 `NO_PROXY=localhost,127.0.0.1,::1`。
- `RunAtLoad` + `KeepAlive`（`ThrottleInterval=15`，避免配置错误时疯狂重启）。
- 日志：`~/Library/Logs/com.opencode-dingtalk-bridge/{out,error}.log`。
- **开机后 OpenCode 服务可能还没起来**：桥接在连续 2 次发现失败后执行 `opencode service start` —— 这是**共享**服务（`opencode.autoStartService`，默认 true），不是第二个私有实例；TUI 之后启动会复用它。
- 桥接自身有单实例文件锁（`src/runtime/lock.ts`），launchd 重启与手工启动不会并存。

常用命令：

```sh
launchctl print gui/$(id -u)/com.opencode.dingtalk-bridge
launchctl kickstart -k gui/$(id -u)/com.opencode.dingtalk-bridge
launchctl bootout   gui/$(id -u)/com.opencode.dingtalk-bridge
```

---

## 14. 配置

### 14.1 桥接配置

```jsonc
{
  "$schema": "./schema.json",
  "dingtalk": {
    "clientId": "${DINGTALK_CLIENT_ID}",
    "clientSecret": "${DINGTALK_CLIENT_SECRET}",
    "robotCode": "${DINGTALK_ROBOT_CODE}"
  },
  "opencode": {
    "versionRange": ">=2.0.18 <2.1.0",
    "autoStartService": true,
    "requiredRoutes": [
      "POST /api/session",
      "GET /api/session/{sessionID}",
      "GET /api/session/active",
      "POST /api/session/{sessionID}/prompt",
      "GET /api/session/{sessionID}/inbox",
      "DELETE /api/session/{sessionID}/inbox/{inboxID}",
      "GET /api/experimental/session/{sessionID}/log",
      "POST /api/session/{sessionID}/interrupt",
      "GET /api/session/{sessionID}/permission",
      "POST /api/session/{sessionID}/permission/{requestID}/reply",
      "GET /api/session/{sessionID}/form",
      "POST /api/session/{sessionID}/form/{formID}/reply",
      "DELETE /api/session/{sessionID}/form/{formID}"
    ]
  },
  "bridge": {
    "dataDir": "~/Library/Application Support/opencode-dingtalk-bridge",
    "approvalTimeoutMs": 600000,
    "maxTaskDurationMs": 7200000,
    "maxPromptChars": 8000,
    "maxResultChars": 3500,
    "maxQueuePerSession": 10,
    "maxTasksPerUserPerHour": 20,
    "approvalChannel": "group",
    "logLevel": "info"
  },
  "projects": [
    {
      "alias": "my-app",
      "directory": "~/code/my-app",
      "agent": "dingtalk",
      "permissionPreset": "default",
      "allowedConversations": ["cidxxxxxxxxxxxxxx=="],
      "allowedUsers": ["012345678901234567"],
      "approvers": ["012345678901234567"],
      "permissions": [
        { "action": "external_directory", "resource": "*", "effect": "deny" },
        { "action": "shell", "resource": "*", "effect": "ask" },
        { "action": "edit", "resource": "*", "effect": "allow" },
        { "action": "webfetch", "resource": "*", "effect": "ask" },
        { "action": "websearch", "resource": "*", "effect": "ask" },
        { "action": "question", "resource": "*", "effect": "deny" },
        { "action": "subagent", "resource": "*", "effect": "deny" }
      ]
    }
  ]
}
```

- 配置校验（zod）：目录必须存在且为绝对路径（`~` 展开 + `realpath`）；alias 唯一；会话/用户列表非空；权限规则合法。任一不合法 → 打印明确错误并退出（fail closed）。
- MVP 可用 `.env`（`0600`）代替 Keychain；生产建议 Keychain。

### 14.2 OpenCode 侧专用 agent

放在项目 `.opencode/agents/dingtalk.md`（或全局 `~/.config/opencode/agents/`）：

```md
---
description: Executes tasks submitted from the DingTalk bridge
mode: primary
steps: 40
permissions:
  - action: external_directory
    resource: "*"
    effect: deny
  - action: shell
    resource: "*"
    effect: ask
  - action: edit
    resource: "*"
    effect: allow
  - action: webfetch
    resource: "*"
    effect: ask
  - action: websearch
    resource: "*"
    effect: ask
  - action: question
    resource: "*"
    effect: deny
  - action: subagent
    resource: "*"
    effect: deny
---

<!-- 不设置 system，保留默认基座提示；输出格式约束由 bridge 附加的任务后缀承担 -->
```

- agent 规则在全局规则**之后**生效，`last matching rule wins`。
- 桥接创建 session 时传 `agent: "dingtalk"`；模型由 agent/全局决定，**不接受**来自钉钉的模型或 agent 切换。

---

## 15. 测试与验收

### 15.1 测试策略

| 层次 | 手段 |
|---|---|
| 单元 | 鉴权、去重、命令解析、状态机迁移、事件归并、outbox 重试、配置校验、锁租约 |
| 契约 | 对固定版本 OpenCode 拉 `/openapi.json`，断言**必需路由（method+path）**与 schema 字段；**不断言 operationId**（版本间会改名） |
| 集成（假 OpenCode） | 自建假服务实现 prompt/inbox/log/permission/form/interrupt，注入 durable 事件与 4xx/5xx |
| 集成（假钉钉） | 在 Adapter 边界注入回调，验证 ack 时序、去重、白名单、@ 判定 |
| 端到端 | 真实 OpenCode + 真实测试机器人账号，人工走通验收用例 |

### 15.2 验收用例

| # | 用例 | 通过标准 |
|---|---|---|
| A1 | 正常任务 | 钉钉发任务 → TUI 打开该 session 可见实时执行 → 钉钉收到最终结果 |
| A2 | 未授权用户 | 外部成员（`senderStaffId` 为空）/ 非白名单用户 → 拒绝，未创建 session |
| A3 | 重复消息 | 同一 `msgId` 投递两次 → 只执行一次 |
| A4 | 会话内顺序 | 同一会话连发 3 条 → 严格串行，顺序不变，状态消息含排队位次 |
| A5 | 项目级串行 | 两个会话映射同一项目 → 不并发执行 |
| A6 | 审批放行 | `shell` 请求 → 钉钉收到审批 → `#approve` → 命令执行 → 结果回传 |
| A7 | 审批拒绝 | `#reject` → 命令未执行 → 任务继续并以失败/说明结束 → 钉钉收到结果 |
| A8 | 审批超时 | 10 分钟不响应 → 自动 reject → 钉钉收到"审批超时" |
| A9 | 外部审批 | TUI 内批准 → 桥接标记 `REMOTE_HANDLED` → 钉钉提示"已在本机处理" |
| A10 | 取消 | `/cancel` → 活动任务中断、排队任务取消 → 钉钉收到取消回执 |
| A11 | 桥接重启 | 执行中 kill bridge → 任务继续 → 重启后结果补发，**不重复执行** |
| A12 | OpenCode 不可用 | 停服务 → 钉钉收到"本机 OpenCode 未运行"；恢复后下一条正常 |
| A13 | 版本不匹配 | 版本/契约自检失败 → 拒接任务并给出明确提示 |
| A14 | 外部输入 | TUI 中输入 → 任务标 `HUMAN_INTERVENED`、session 暂停、`/resume` 恢复 |
| A15 | webhook 过期 | 模拟过期 → 切 OpenAPI 主动发送或明确失败，不崩溃 |
| A16 | 长结果 | 超长结果被截断并提示查看 TUI |
| A17 | 桥接关闭 | 停止 bridge → 钉钉无法触发本机执行；无任何本机副作用 |
| A18 | 凭据泄漏 | 检索日志与数据库外发内容，不含 webhook / secret / token / prompt 全文 |
| A19 | 目录越界 | 提示要求读取项目外文件 → 被 `external_directory` 拒绝 |
| A20 | 幂等 | prompt 网络超时后重试 → OpenCode 中只出现一次执行 |

### 15.3 完成定义

- §15.2 全部通过。
- 桥接连续运行 24h 无未处理 outbox 积压、无未回收项目锁。
- 审计日志能完整还原"谁在何时让本机做了什么"。

---

## 16. 实施计划

| 阶段 | 内容 | 产出 |
|---|---|---|
| P0 探针 | 服务发现/鉴权、建 session、prompt、log 重放、permission 列表与回复、钉钉回声 | 可跑通的最小脚本 |
| P1 核心 | 鉴权去重、映射、两级队列、状态机、结果回传、SQLite 持久化 | A1–A5 通过 |
| P2 人机 | 审批流、超时、取消、外部输入检测、重启恢复 | A6–A11、A14 通过 |
| P3 加固 | 契约自检、审计、launchd、健康检查、错误文案、压测 | A12–A20 通过 |
| P4 收尾 | 运维文档、凭证迁移到 Keychain、告警接入 | 交付 |

---

## 17. 风险与待验证项

### 17.1 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| V2 API 为 Experimental，升级可能破坏 | 高 | 锁版本 + 启动契约自检 + 契约测试 + fail closed |
| `dingtalk-stream` Node SDK 为 beta | 中 | 锁版本；备选 Python 官方 SDK（OpenCode 侧仍走 HTTP/SSE） |
| sessionWebhook 过期 / 频率限制 | 中 | OpenAPI 主动发送兜底 + outbox 退避 + 限速 |
| 仓库内容提示注入 | 高 | external_directory deny + shell ask + webfetch ask + 人工确认 |
| 模型 provider 数据出境 | 高（合规） | 本地模型或 provider 白名单，落地前确认 |
| 单用户 macOS 无容器隔离 | 中 | 桥接无入站端口 + 权限从严 + 后续迁到专用 OS 用户/容器 |
| 上下文膨胀与成本 | 中 | OpenCode compaction + `steps` 上限 + 任务时长上限 |
| TUI 行为与 API 变化 | 中 | 升级后跑 A1 回归 |

### 17.2 实现期需实测确认

已由 P0 探针确认（详见附录 A）：

1. ✅ **per-session durable log 在 2.0.18 不返回业务事件**（任意 `after` 都只有 `log.synced`）→ 已改为"消息时间线为权威"（§5.5 L2）。
2. ✅ **operationId 在版本间漂移、路由稳定** → 契约自检改为按路由校验（§5.2）。
3. ✅ **`prompt` 响应 `id` == 时间线中的 user 消息 id** → 可作时间线锚点。
4. ✅ **`/wait` 在 session 空闲时立即返回 204** → 只能作触发器，不能单独作完成判据。
5. ✅ **消息时间线含 `type:"idle"` + `outcome` 回合结束标记** → 权威完成判据。
6. ✅ **全局 `/api/event` 正常投递** `inbox.enqueued/delivered`、`text.ended`、`execution.succeeded` → 可作低延迟加速层。

仍待实测：

7. session 级 `permissions` 与全局/agent 规则的**合并顺序**（文档未明确）。
8. `session.prompt` 重复 `id` 的行为（409 冲突 vs 直接返回既有 inbox item）。
9. `permission.reply({decision:"reject"})` 的实际影响范围（文档称会拒绝该 session 全部待处理请求）。
10. `session.form.cancel` 后 Agent 是否继续执行或直接失败。
11. 钉钉 OpenAPI 主动发送时 `openConversationId` 与回调 `conversationId` 是否一致。
12. 通过 API 创建的 session 在 TUI `/sessions` 中的可见性与实时刷新表现。
13. 客户端 `@opencode/client` 与服务端 `2.0.18` 的长期兼容版本（P0 初步验证 2.0.32 可用）。
14. 钉钉 `senderStaffId` 在机器人**发布上线后**是否稳定返回（P0 尚未收到真实消息）。

---

## 18. 后续迭代（v1.1+）

1. **Forms 支持**：DingTalk 文本应答回填（`#answer`），字段类型覆盖 string/number/boolean/select。
2. **交互卡片审批**：按钮式批准/拒绝，带会话隔离与操作人记录。
3. **TUI 插件**：新建/命中 session 时自动跟随或本地通知，替代"手动打开 session"。
4. **子 agent 支持**：放开 `subagent`，按 `parentID` 跟踪子 session 的审批请求。
5. **多项目与并行**：用 OpenCode worktree 为每个任务隔离工作区，支持同项目并行。
6. **单聊审批通道**：敏感项目审批走私聊。
7. **附件支持**：图片/文件消息下载后以附件形式投喂 session。
8. **隔离强化**：专用 macOS 用户或容器运行 OpenCode，桥接仅保留最小权限。
9. **指标与告警**：队列深度、审批时延、失败率接入现有监控。
10. **多机器人 / 多项目并行实例**：按 conversation 分片。

---

## 附录 A：P0 探针实测记录（2026-10-20）

环境：OpenCode 服务端 `2.0.18`（`http://127.0.0.1:49374`），客户端 `@opencode/client 2.0.32`，
`dingtalk-stream 2.1.6-beta.1`，macOS，Node 20.13.1。

| # | 验证项 | 结果 |
|---|---|---|
| A-1 | `Service.discover()` 能否发现共享服务 | ✅ 成功，拿到 `http://127.0.0.1:49374` + Basic auth；裸 `curl` 返回 `401`，证明必须走 `Service.headers()` |
| A-2 | 契约自检 | ✅ 13 条必需路由全部存在（按 method+path 校验） |
| A-3 | 专用 agent 能否被 API 使用 | ✅ `.opencode/agents/dingtalk.md`（`mode: primary`）可用，`session.create({agent:"dingtalk"})` 成功 |
| A-4 | `prompt` 幂等 id | ✅ 响应 `data.id`（`msg_…`）**就是**时间线中的 user 消息 id，可作锚点 |
| A-5 | `delivery:"queue"` | ✅ 生效；`GET /inbox` 在任务被取走后为空 |
| A-6 | **per-session durable log** | ❌ **不可用**：`after=0/1/2/3/4/5/10` 全部只返回 `log.synced`（seq 递增但无业务事件）；`follow=true` 连接保持打开但**不推送**任何事件 |
| A-7 | **全局 `/api/event`** | ✅ 正常投递：`session.inbox.enqueued` / `inbox.delivered` / `step.started|ended` / `text.delta|ended` / `execution.succeeded` / `usage.updated` |
| A-8 | **消息时间线** `GET /message?order=asc` | ✅ 权威：顺序为 `user` → `assistant(content[text])` → `idle(outcome=succeeded)` |
| A-9 | `/experimental/session/{id}/wait` | ⚠️ 空闲时**立即 204**（2ms），有任务时阻塞到 idle（实测 1504ms）→ 只能作触发器 |
| A-10 | `GET /session/{id}` | ✅ 返回 `outcome:"succeeded"`、`time.idle` |
| A-11 | 钉钉 Stream 连接 | ✅ `connect success`——提供的 `clientId`/`clientSecret`/`robotCode` 有效（`dingapvpuh1glvotxjml`） |
| A-12 | 钉钉消息回环 | ✅ 真实消息收到（群 `opencode`，`conversationType=2`，`isInAtList=true`，`senderStaffId` 有值），sessionWebhook 回复成功 |
| A-13 | 完整任务链路 | ✅ `PENDING → SUBMITTED → RUNNING → INTERRUPTED` 全程落库，outbox 逐条投递（accepted/started/approval/result 全部 SENT） |
| A-14 | `PATCH /api/session/{id}` 改 permissions | ✅ 可运行中就地改策略（`session.permissions.synced`），无需 `/new` |
| A-15 | `GET /message` 分页 | ⚠️ **`order=asc&limit=N` 只返回最早的 N 条**；且 **`cursor` 不能与 `order` 同时传**（"Cursor cannot be combined with order"）→ 必须先取 desc 最新页，再用 `cursor.previous` 回翻 |
| A-16 | 审批多渠道 | ✅ Mac 原生对话框实测可用（`button returned:允许一次`），审批单抢占逻辑生效 |
| A-17 | 权限预设热切换 | ✅ `default` 预设下 `shell` 不再触发审批 |
| A-18 | Node 版本 | ⚠️ `@opencode/client` 的 SSE 读取依赖 `Promise.withResolvers`（Node 22+）；Node 20 需 polyfill（`src/polyfills.ts`） |
| A-19 | 副作用观察 | ⚠️ 任务目标仓库是 bridge 自身时，`default` 预设下 agent **会直接改写 bridge 源码**（本次实测 agent 重构了 timeline.ts 并补齐了 limits/lock/heartbeat/retention 模块）→ **不要把 bridge 仓库设为默认项目** |
| A-20 | 长时间任务 | ✅ 任务运行 14 分钟未结束时，bridge 保持 `RUNNING` 且不误判；心跳消息按 5 分钟间隔补充 |
| A-21 | `/ask` 崩溃 | ❌→✅ 曾因 `chat_sessions` 表缺失（重构时 schema 改成版本化迁移，旧表没建）抛未捕获异常 → **进程直接崩溃** → launchd 重启 → in-flight 问答丢失。已修：① 迁移 v3 建表 ② 进程级 `unhandledRejection` / `uncaughtException` 兜底（**一个请求失败不能带走整个守护进程**）③ `/ask` 改走持久化任务管线，重启后仍能补发 |
| A-22 | `/ask` 端到端 | ✅ 离线测试：只读 agent 16s 返回 `succeeded`，答案经 outbox 正确回传；`/ask 北京天气` 也能拿到实时数据 |
| A-23 | **磁盘写满** | ❌→✅ `ENOSPC` 导致心跳写入失败并把进程带崩（`bridge.uncaught_exception`）。已修：心跳 flush 吞掉写失败（诊断文件永远不值得拖垮守护进程） |
| A-24 | **launchd 读 `~/Desktop`** | ❌→✅ macOS TCC 保护目录：launchd 代理进程读 `~/Desktop` 下的文件会**永久阻塞**在 `open()`（授权弹窗对 launchd 弹不出来），而手动启动正常。实测探针确认。结论：**bridge 源码不能放 `~/Desktop`/`~/Documents`/`~/Downloads`**；任务工作目录可以（真正读写的是 OpenCode 服务进程，它从终端继承了权限） |

**结论：架构从"durable log 为主"改为"消息时间线为主 + 全局事件流加速 + 轮询兜底"（§5.5）。**

**运维提醒**：默认项目**不要**指向 bridge 自身的仓库。`default` 放行预设下，远程消息等同于本机命令，agent 会直接改写该目录下的源码（本次实测即如此）。请把默认项目指向真正的业务仓库。

---

## 19. 参考

- OpenCode V2 API：<https://opencode.ai/v2/docs/api>
- OpenCode V2 客户端与本地服务发现：<https://opencode.ai/v2/docs/build/client>
- OpenCode 权限模型：<https://opencode.ai/v2/docs/permissions>
- OpenCode Agents：<https://opencode.ai/v2/docs/agents>
- OpenCode TUI：<https://opencode.ai/v2/docs/cli/tui>
- OpenCode CLI 与共享后台服务：<https://opencode.ai/v2/docs/cli>
- 钉钉 Stream 模式：<https://open.dingtalk.com/document/development/stream>
- 钉钉机器人接收消息：<https://open.dingtalk.com/document/dingstart/robot-receive-message>
- 钉钉机器人回复与发送消息：<https://open.dingtalk.com/document/dingstart/robot-reply-and-send-messages>
- 钉钉 Stream 协议：<https://open.dingtalk.com/document/direction/stream-mode-protocol-access-description>
