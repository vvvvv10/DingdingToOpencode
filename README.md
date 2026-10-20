# opencode-dingtalk-bridge

钉钉 → 本机 OpenCode V2 的桥接程序。设计文档：[`docs/design.md`](docs/design.md)。

> 当前状态：**P0 探针通过**（两半链路分别验证）；**P1 核心已实现，待端到端验证**。

| 模块 | 状态 |
|---|---|
| 钉钉 Stream 接入 / ack / 去重 / sessionWebhook 回复 | ✅ 已实现，连接成功 |
| OpenCode 服务发现 / 认证 / 版本 + 路由契约自检 | ✅ 已实现并通过 |
| 消息时间线（权威完成判据） | ✅ 已实现并通过 |
| 任务状态机 + 两级队列 + 项目锁 + outbox + SQLite | ✅ 已实现 |
| 审批流（`#approve` / `#reject` / 超时） | ✅ 已实现，待联调 |
| 端到端（钉钉发任务 → 本机执行 → 结果回钉钉） | ⏳ 待真实消息验证 |

## 架构一句话

钉钉 Stream（本机主动出站 WSS）→ 桥接程序（鉴权 / 路由 / 审批编排）→ 本机 OpenCode 共享服务 → 同一个 session，TUI 可实时观察；结果经 outbox 回传钉钉。

桥接程序**不监听任何入站端口**，也**不会另起一个 OpenCode 进程**。

## 环境要求

- macOS，Node ≥ 20.11
- 本机 OpenCode **V2** 共享后台服务（默认的 `opencode` TUI 即可，**不可**用 `--standalone`）
- 钉钉企业内部机器人（Stream 模式），已发布上线

## 准备

### 1. 钉钉凭证（不要写进仓库）

```sh
security add-generic-password -U -a "$USER" -s opencode-dingtalk-client-secret -w '<clientSecret>'
```

`clientId` 与 `robotCode` 是非密，写在 `config/config.json` 里。

### 2. OpenCode 专用 agent

仓库内已提供 `.opencode/agents/dingtalk.md`（`mode: primary`），权限：

| action | effect |
|---|---|
| `read` / `glob` / `grep` | allow（项目内） |
| `edit` | allow（项目内） |
| `shell` | **ask** |
| `external_directory` | **deny** |
| `webfetch` / `websearch` | ask |
| `question` | deny（MVP 不支持交互式提问） |
| `subagent` | deny（MVP 不跟踪子 session 的审批） |

### 3. 配置

```sh
cp config/config.example.json config/config.json   # 然后按需修改
```

`config/config.json` 已被 `.gitignore` 忽略。至少要填：

- `dingtalk.clientId` / `dingtalk.robotCode`
- `projects[].alias` / `directory` / `allowedConversations` / `allowedUsers`

## 运行

```sh
npm install
npm run typecheck

npm run probe            # P0 全链路探针（OpenCode + 钉钉）
npm run probe:dingtalk   # 只测钉钉回环，等你发一条消息
npm run diag             # 诊断 OpenCode 各端点实际行为
```

## 已验证的行为（2026-10-20，服务端 2.0.18）

| 事实 | 结论 |
|---|---|
| `Service.discover()` + `Service.headers()` | 可发现共享服务并通过 Basic 认证；裸请求是 401 |
| `GET /api/experimental/session/{id}/log` | **不返回业务事件**（任意 `after` 都只有 `log.synced`）→ 不作为权威来源 |
| `GET /api/event` | live-only，能正常投递 `inbox.delivered` / `text.ended` / `execution.succeeded` → 只作低延迟加速 |
| `GET /api/session/{id}/message?order=asc` | **权威**：时间线含 `user` → `assistant` → `idle(outcome)` 回合标记 |
| `POST /api/experimental/session/{id}/wait` | session 空闲时立即 204，有任务时阻塞到 idle → 只能作触发器 |
| `prompt` 响应 `id` | **等于**时间线中的 user 消息 id，可作锚点 |
| operationId | 版本间会改名（`session.permission.reply` → `permission.reply`），**路由稳定** → 契约自检按路由校验 |

详见 `docs/design.md` 附录 A。

## 目录

```
docs/design.md        正式设计文档
src/index.ts          桥接主程序（路由 / 调度 / 状态机 / 审批 / 事件订阅）
src/config.ts         配置加载与校验（fail closed）
src/credentials.ts    Keychain 读取 client secret
src/logger.ts         结构化日志（含脱敏）
src/outbox.ts         事务性 outbox（重试 / 退避 / 死信）
src/opencode/client.ts    服务发现 / 认证 / 版本与路由契约自检
src/opencode/timeline.ts  消息时间线（权威完成判据）
src/dingtalk/adapter.ts   Stream 连接 / 解析 / ack / sessionWebhook 回复
src/dingtalk/send.ts      sessionWebhook + OpenAPI 主动发送
src/store/            持久化（conversations / sessions / tasks / approvals / outbox / locks / audit）
scripts/              P0 探针与诊断脚本
.opencode/agents/dingtalk.md  专用 agent
```
