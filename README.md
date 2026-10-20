# opencode-dingtalk-bridge

钉钉 → 本机 OpenCode V2 的桥接程序。设计文档：[`docs/design.md`](docs/design.md)。

> 当前状态：**已跑通端到端，并已安装为开机自启的 LaunchAgent。**

| 模块 | 状态 |
|---|---|
| 钉钉 Stream 接入 / ack / 去重 / sessionWebhook 回复 | ✅ |
| OpenCode 服务发现 / 认证 / 版本 + 路由契约自检 | ✅ |
| 消息时间线（权威完成判据） | ✅ |
| 任务状态机 + 两级队列 + 项目锁 + outbox + SQLite | ✅ |
| 审批流（4 渠道：TUI / Mac 弹窗 / 钉钉 / CLI） | ✅ |
| 端到端（钉钉发任务 → 本机执行 → 结果回钉钉） | ✅ |
| 开机自启（launchd） | ✅ `com.opencode.dingtalk-bridge` |

## 消息怎么才算「任务」

钉钉里的每条 @ 消息**不会**都被执行。默认 `taskMode: "prefix"`：

| 你发的 | 机器人做什么 |
|---|---|
| `/task 帮我看下这个 bug` | **执行任务**（可写文件、跑命令） |
| `/ask 这个项目用的是哪个状态管理库` | **只读问答**（独立会话，不能改文件/跑命令） |
| `你在干啥` / `谢谢` / 任何闲聊 | **不执行**，回一条本地状态（当前任务、队列、连接状态、用法）——零模型调用、零副作用 |
| `/status` `/cancel` `/new` `/resume` `/help` | 桥接命令 |
| `/sessions` | **本机所有 OpenCode session 在干什么**（运行中/空闲、agent、项目、"正在跑什么"） |
| `#approve A-7F3K` / `允许` / `拒绝` | 审批 |

`taskMode: "always"` 可以改回"每条消息都是任务"的旧行为，但那样群里一句闲聊就可能触发远程执行，不建议。

## 架构一句话

钉钉 Stream（本机主动出站 WSS）→ 桥接程序（鉴权 / 路由 / 审批编排）→ 本机 OpenCode 共享服务 → 同一个 session，TUI 可实时观察；结果经 outbox 回传钉钉。

桥接程序**不监听任何入站端口**；它只会在本机 OpenCode 服务没起来时执行 `opencode service start`（**共享**服务，不是第二个实例）。

## 运维

```sh
launchctl print gui/$(id -u)/com.opencode.dingtalk-bridge   # 状态
tail -f ~/Library/Logs/com.opencode.dingtalk-bridge/out.log  # 日志
cat "$HOME/Library/Application Support/opencode-dingtalk-bridge/runtime/heartbeat.json"  # 健康
npm run cli -- status        # 最近任务
npm run cli -- approvals     # 待确认项
```

| 操作 | 命令 |
|---|---|
| 重启 | `launchctl kickstart -k gui/$(id -u)/com.opencode.dingtalk-bridge` |
| 停止 | `launchctl bootout gui/$(id -u)/com.opencode.dingtalk-bridge` |
| 重新安装（改了代码/配置后） | `npm run build && npm run install:launchd` |
| 卸载 | `npm run uninstall:launchd` |

## 审批的 4 条渠道

审批应该发生在**电脑上**，而不是手机上。任一渠道先响应即生效。

1. **TUI 原生弹窗** —— 终端里点允许/拒绝
2. **Mac 原生对话框** —— 桌面弹窗，点「允许一次 / 拒绝」，10 分钟自动关闭
3. **钉钉回「允许」/「拒绝」** —— 手机上发两个字（该会话只有一个待确认项时生效）
4. **本机 CLI** —— `npm run cli -- approve A-7F3K`

## 权限策略

`projects[].permissionPreset`：

- `default`（当前）—— **OpenCode 原生放行**。只 deny `question`（否则任务永久挂起）和 `subagent`（子 session 审批桥接看不到），两条都是硬拒绝、不弹框。
- `strict` —— `shell`/`webfetch` ask、跨目录 deny。

切换**不需要 `/new`**：桥接会 `PATCH /api/session/{id}` 就地改写运行中 session 的规则。

> ⚠️ `default` 下，钉钉消息等同于本机命令，agent 会直接改写目标仓库源码。请确保机器人账号、可见范围和白名单都收紧。

## 准备

### 1. 钉钉凭证（不要写进仓库）

```sh
security add-generic-password -U -a "$USER" -s opencode-dingtalk-client-secret -w '<clientSecret>'
```

`clientId` 与 `robotCode` 是非密，写在 `config/config.json` 里。

### 2. OpenCode 专用 agent

仓库内 `.opencode/agents/dingtalk.md`（`mode: primary`）与配置里的 `permissionPreset` 保持一致。

### 3. 配置

```sh
cp config/config.example.json config/config.json   # 然后按需修改
```

`config/config.json` 已被 `.gitignore` 忽略。至少要填：

- `dingtalk.clientId` / `dingtalk.robotCode`
- `projects[].alias` / `directory` / `allowedConversations` / `allowedUsers` / `approvers`
- `projects[].permissionPreset`

当前绑定：钉钉群「opencode」→ `tms-web` → `/Users/qianjiajie/tms/tms-web`。

## 开发

```sh
npm install
npm run typecheck
npm run dev          # 前台跑（会和 launchd 抢单实例锁，先停 LaunchAgent）
npm run build        # 产出 dist/
npm run probe        # P0 全链路探针
npm run probe:dingtalk  # 只测钉钉回环
npm run diag         # 诊断 OpenCode 各端点实际行为
```

## 已验证的行为（2026-10-20，服务端 2.0.18）

| 事实 | 结论 |
|---|---|
| `Service.discover()` + `Service.headers()` | 可发现共享服务并通过 Basic 认证；裸请求是 401 |
| `GET /api/experimental/session/{id}/log` | **不返回业务事件**（任意 `after` 都只有 `log.synced`）→ 不作为权威来源 |
| `GET /api/event` | live-only，能正常投递 `inbox.delivered` / `text.ended` / `execution.succeeded` → 只作低延迟加速 |
| `GET /api/session/{id}/message` | **权威**：时间线含 `user` → `assistant` → `idle(outcome)` 回合标记 |
| `GET /message` 分页 | `order=asc&limit=N` 只返回**最早**的 N 条；且 **`cursor` 不能与 `order` 同传** → 先取 desc 最新页，再用 `cursor.previous` 回翻 |
| `POST /api/experimental/session/{id}/wait` | session 空闲时立即 204，有任务时阻塞到 idle → 只能作触发器 |
| `prompt` 响应 `id` | **等于**时间线中的 user 消息 id，可作锚点 |
| operationId | 版本间会改名（`session.permission.reply` → `permission.reply`），**路由稳定** → 契约自检按路由校验 |
| `PATCH /api/session/{id}` | 可运行中改权限规则，无需 `/new` |
| Node 版本 | 客户端 SSE 读取依赖 `Promise.withResolvers`（Node 22+）；Node 20 需 `src/polyfills.ts` |

详见 `docs/design.md` 附录 A。

## 目录

```
docs/design.md        正式设计文档
src/index.ts          桥接主程序（路由 / 调度 / 状态机 / 审批 / 事件订阅）
src/config.ts         配置加载与校验（fail closed）
src/credentials.ts    Keychain 读取 client secret
src/logger.ts         结构化日志（含脱敏）
src/outbox.ts         事务性 outbox（重试 / 退避 / 死信）
src/limits.ts         准入控制（队列深度 / 用户小时配额）
src/permissions.ts    权限预设（default / strict）
src/approvals/mac-dialog.ts  macOS 原生审批对话框
src/runtime/lock.ts   单实例文件锁
src/runtime/heartbeat.ts  本地健康探针
src/opencode/client.ts    服务发现 / 认证 / 版本与路由契约自检
src/opencode/timeline.ts  消息时间线（权威完成判据 + 游标分页）
src/dingtalk/adapter.ts   Stream 连接 / 解析 / ack / sessionWebhook 回复
src/dingtalk/send.ts      sessionWebhook + OpenAPI 主动发送
src/store/            持久化（conversations / sessions / tasks / approvals / outbox / locks / audit / retention）
scripts/              探针、诊断、CLI、launchd 安装脚本
.opencode/agents/dingtalk.md  专用 agent
```
