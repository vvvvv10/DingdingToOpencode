/**
 * Bridge runtime.
 *
 *   DingTalk Stream ──▶ Router/AuthZ ──▶ Scheduler ──▶ OpenCode session
 *         ▲                                   │
 *         └────── Outbox ◀── task state ◀──────┘
 *
 * The completion verdict comes from the durable message timeline
 * (src/opencode/timeline.ts); the global event stream is only a latency
 * trigger. See docs/design.md §5.5.
 */
import "./polyfills.js"
import { join } from "node:path"
import { OpenCode } from "@opencode/client"
import { loadConfig, type BridgeConfig, type ProjectConfig } from "./config.js"
import { readClientSecret } from "./credentials.js"
import { createLogger, type Logger } from "./logger.js"
import { checkAdmission } from "./limits.js"
import { connectOpenCode, OpenCodeUnavailableError } from "./opencode/client.js"
import { fetchTurnWindow, waitForTurn } from "./opencode/timeline.js"
import { showApprovalDialog } from "./approvals/mac-dialog.js"
import { SessionNotifier } from "./notify.js"
import { DingTalkAdapter, type DingTalkInbound } from "./dingtalk/adapter.js"
import { DingTalkSenderImpl, type SendTarget } from "./dingtalk/send.js"
import { Outbox } from "./outbox.js"
import { HeartbeatWriter, heartbeatPath } from "./runtime/heartbeat.js"
import { acquireInstanceLock } from "./runtime/lock.js"
import { audit, openDatabase, type Db } from "./store/db.js"
import { applyRetention } from "./store/retention.js"
import {
  getConversation,
  getSession,
  setActiveSession,
  setSessionControlMode,
  touchSessionPoll,
  upsertConversation,
} from "./store/conversations.js"
import {
  acquireProjectLock,
  activeTasks,
  appendTaskText,
  clearExpiredLocks,
  createTask,
  getTask,
  markInboundRejected,
  newApprovalId,
  newTaskId,
  overdueTasks,
  pendingTasks,
  recordInbound,
  releaseProjectLock,
  renewProjectLock,
  sessionTask,
  taskTexts,
  updateTask,
  type Task,
} from "./store/tasks.js"

const log = createLogger({ scope: "bridge" })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Client = ReturnType<typeof OpenCode.make>

export type SenderLike = {
  send: (target: SendTarget, text: string) => Promise<boolean>
}

export type BridgeOptions = {
  config: BridgeConfig
  db: Db
  secret: string
  /** Injected OpenCode client (tests inject a fake server client). */
  client?: Client
  /** Injected outbound sender (tests capture messages instead of sending). */
  sender?: SenderLike
  /** Injected reply channel (tests capture replies instead of calling DingTalk). */
  reply?: (message: DingTalkInbound, text: string) => Promise<void>
  heartbeat?: HeartbeatWriter
}

/** Deterministic OpenCode message id: a retried prompt stays idempotent. */
export function promptMessageId(taskId: string): string {
  return `msg_bridge_${taskId}`
}

/** Metadata sources the bridge stamps on its own prompts. */
const BRIDGE_SOURCES = new Set(["dingtalk", "dingtalk-ask"])

/** Read-only ruleset for `/ask` chat sessions. */
const CHAT_PERMISSIONS = [
  { action: "read", resource: "*", effect: "allow" as const },
  { action: "glob", resource: "*", effect: "allow" as const },
  { action: "grep", resource: "*", effect: "allow" as const },
  { action: "webfetch", resource: "*", effect: "allow" as const },
  { action: "websearch", resource: "*", effect: "allow" as const },
  { action: "edit", resource: "*", effect: "deny" as const },
  { action: "shell", resource: "*", effect: "deny" as const },
  { action: "external_directory", resource: "*", effect: "deny" as const },
  { action: "question", resource: "*", effect: "deny" as const },
  { action: "subagent", resource: "*", effect: "deny" as const },
]

export class Bridge {
  private client: Client | undefined
  private openCodeVersion = "unknown"
  private outbox: Outbox
  private sender: SenderLike
  private adapter: DingTalkAdapter | undefined
  private replyFn: (message: DingTalkInbound, text: string) => Promise<void>
  private heartbeat: HeartbeatWriter | undefined
  /** approvalId -> last time a macOS dialog was shown for it. */
  private dialogShownAt = new Map<string, number>()
  /** Notifications for sessions the bridge does not own. */
  private notifier: SessionNotifier | undefined
  private running = false
  private lastRetentionAt = 0

  constructor(private readonly opts: BridgeOptions) {
    this.client = opts.client
    this.sender =
      opts.sender ??
      new DingTalkSenderImpl({
        clientId: opts.config.dingtalk.clientId,
        clientSecret: opts.secret,
        robotCode: opts.config.dingtalk.robotCode,
        log,
      })
    this.outbox = new Outbox(
      opts.db,
      (item, text) => this.deliver(item.conversation_id, text, item.task_id),
      log,
    )
    this.replyFn =
      opts.reply ??
      (async (message, text) => {
        if (!this.adapter) return
        await this.adapter.reply(message, text)
      })
    this.heartbeat = opts.heartbeat

    if (opts.config.bridge.notifyOtherSessions) {
      const conversations =
        opts.config.bridge.notifyConversations.length > 0
          ? opts.config.bridge.notifyConversations
          : opts.config.projects.flatMap((project) => project.allowedConversations)
      this.notifier = new SessionNotifier({
        client: this.client!,
        db: opts.db,
        log,
        conversations,
        minIntervalMs: opts.config.bridge.notifyMinIntervalMs,
        deliver: ({ dedupeKey, conversationId, text }) => {
          this.outbox.enqueue({ dedupeKey, conversationId, kind: "STATUS", text })
        },
      })
    }
  }

  // ------------------------------------------------------------------ startup

  async start(): Promise<void> {
    this.running = true
    clearExpiredLocks(this.db)
    await this.connectOpenCode()
    if (!this.skipDingTalk()) {
      this.adapter = new DingTalkAdapter({
        clientId: this.opts.config.dingtalk.clientId,
        clientSecret: this.opts.secret,
        robotCode: this.opts.config.dingtalk.robotCode,
        log,
        onMessage: (message) => this.handleMessage(message),
      })
      await this.adapter.connect()
    }
    void this.watchGlobalEvents()
    void this.loop()
    log.info("bridge.started", {
      projects: this.opts.config.projects.map((project) => project.alias),
      opencode: this.openCodeVersion,
    })
    this.heartbeat?.update({
      opencodeVersion: this.openCodeVersion,
      opencodeAvailable: Boolean(this.client),
      dingtalkConnected: this.adapter?.isConnected ?? false,
    })
  }

  /**
   * The DingTalk adapter is only needed when the bridge really talks to
   * DingTalk. Tests inject their own inbound handler, sender and client and
   * must not open a Stream connection.
   */
  private skipDingTalk(): boolean {
    return Boolean(this.opts.client && this.opts.reply && this.opts.sender)
  }

  async stop(): Promise<void> {
    this.running = false
    this.adapter?.disconnect()
    log.info("bridge.stopped")
  }

  get db(): Db {
    return this.opts.db
  }

  private async connectOpenCode(): Promise<void> {
    if (this.client) {
      // Injected client (tests): assume it is healthy.
      this.openCodeVersion = "injected"
      return
    }
    for (;;) {
      try {
        const connection = await connectOpenCode({
          versionRange: this.opts.config.opencode.versionRange,
          requiredRoutes: this.opts.config.opencode.requiredRoutes,
          log,
        })
        this.client = connection.client
        this.openCodeVersion = connection.version
        return
      } catch (error) {
        const reason =
          error instanceof OpenCodeUnavailableError ? error.reason : "unknown"
        this.client = undefined
        log.warn("opencode.unavailable", { reason, error: (error as Error).message })
        this.heartbeat?.update({ opencodeAvailable: false, opencodeVersion: "unknown" })
        // Keep serving DingTalk: commands still work, tasks are rejected with a
        // clear message. The service may come back at any time.
        await sleep(10_000)
      }
    }
  }

  // ------------------------------------------------------------- message flow

  async handleMessage(message: DingTalkInbound): Promise<void> {
    this.heartbeat?.update({ lastDingTalkMessageAt: Date.now() })

    if (message.msgtype !== "text" || !message.text) {
      await this.replyDirect(message, "目前仅支持文本消息。")
      return
    }
    if (message.conversationType === "2" && !message.isInAtList) {
      return
    }

    const route = this.resolveRoute(message)
    if (!route.ok) {
      audit(this.db, {
        actorType: "USER",
        actorId: message.senderStaffId,
        action: "task.rejected",
        conversationId: message.conversationId,
        detail: {
          reason: route.code,
          receivedConversationId: message.conversationId,
          knownConversations: this.opts.config.projects.flatMap(
            (project) => project.allowedConversations,
          ),
        },
        result: route.code,
      })
      await this.replyDirect(message, route.message)
      return
    }

    const project = route.project
    const text = message.text

    // Dedupe every inbound message (commands included): DingTalk delivers at
    // least once, so a redelivered "/cancel" must not cancel twice.
    const dedupe = recordInbound(this.db, message.msgId, "ACCEPTED")
    if (dedupe === "DUPLICATE") {
      log.info("dingtalk.message.duplicate", { msgId: message.msgId })
      return
    }

    // ---- intent split -----------------------------------------------------
    // A casual "你在干啥" must never become remote code execution on this
    // machine. Only an explicit instruction becomes a task; anything else is
    // answered with the bridge's own state (no model call, no side effects).
    if (/^\/task(\s|$)/i.test(text)) {
      const body = text.replace(/^\/task\s*/i, "").trim()
      if (!body) {
        await this.replyDirect(message, "用法：/task <要执行的任务>")
        return
      }
      await this.startTask(message, project, body)
      return
    }

    if (/^\/ask(\s|$)/i.test(text)) {
      const body = text.replace(/^\/ask\s*/i, "").trim()
      if (!body) {
        await this.replyDirect(message, "用法：/ask <想问的问题>")
        return
      }
      if (!this.opts.config.bridge.askEnabled) {
        await this.replyDirect(message, "只读问答已关闭。")
        return
      }
      // A question is a task of kind "ask": it goes through the same durable
      // pipeline (task row -> timeline -> outbox), so the answer still arrives
      // if the bridge restarts mid-answer.
      await this.startTask(message, project, body, "ask")
      return
    }

    if (text.startsWith("/")) {
      await this.handleCommand(message, project, text)
      return
    }
    if (text.startsWith("#")) {
      await this.handleApprovalCommand(message, project, text)
      return
    }
    if (/^(允许|批准|同意|approve|allow)$/i.test(text.trim())) {
      await this.handleQuickApproval(message, project, "approve")
      return
    }
    if (/^(拒绝|驳回|reject|deny)$/i.test(text.trim())) {
      await this.handleQuickApproval(message, project, "reject")
      return
    }

    if (this.opts.config.bridge.taskMode === "always") {
      await this.startTask(message, project, text)
      return
    }

    // Not an instruction: answer with local state, no model call.
    const others = await this.buildOtherSessionsSummary()
    await this.replyDirect(message, this.buildStatusReply(project) + (others ? `\n${others}` : ""))
  }

  /** Admit a task: validate, persist, schedule. */
  private async startTask(
    message: DingTalkInbound,
    project: ProjectConfig,
    text: string,
    kind: "task" | "ask" = "task",
  ): Promise<void> {
    if (text.length > this.opts.config.bridge.maxPromptChars) {
      markInboundRejected(this.db, message.msgId, "prompt_too_long")
      await this.replyDirect(message, `任务过长（上限 ${this.opts.config.bridge.maxPromptChars} 字符）。`)
      return
    }

    const admission = checkAdmission(this.db, {
      conversationId: message.conversationId,
      senderStaffId: message.senderStaffId,
      maxQueuePerSession: this.opts.config.bridge.maxQueuePerSession,
      maxTasksPerUserPerHour: this.opts.config.bridge.maxTasksPerUserPerHour,
    })
    if (!admission.ok) {
      markInboundRejected(this.db, message.msgId, admission.code)
      audit(this.db, {
        actorType: "USER",
        actorId: message.senderStaffId,
        action: "task.rejected",
        conversationId: message.conversationId,
        detail: { reason: admission.code },
        result: admission.code,
      })
      await this.replyDirect(message, admission.message)
      return
    }

    upsertConversation(this.db, {
      conversationId: message.conversationId,
      conversationType: Number(message.conversationType) || 1,
      title: message.conversationTitle,
      projectAlias: project.alias,
      webhook: message.sessionWebhook,
      webhookExpiresAt: message.sessionWebhookExpiredTime,
    })

    if (!this.client) {
      markInboundRejected(this.db, message.msgId, "opencode_unavailable")
      await this.replyDirect(message, "⚠️ 本机 OpenCode 未运行，任务未提交。")
      return
    }

    const task = createTask(this.db, {
      taskId: newTaskId(),
      msgId: message.msgId,
      conversationId: message.conversationId,
      senderStaffId: message.senderStaffId,
      projectAlias: project.alias,
      promptText: text,
      kind,
    })

    audit(this.db, {
      actorType: "USER",
      actorId: message.senderStaffId,
      action: "task.admitted",
      taskId: task.task_id,
      conversationId: message.conversationId,
      detail: { project: project.alias },
      result: "PENDING",
    })

    this.outbox.enqueue({
      dedupeKey: `task:${task.task_id}:accepted`,
      taskId: task.task_id,
      conversationId: message.conversationId,
      kind: "STATUS",
      text:
        kind === "ask"
          ? `🤔 思考中…（${task.task_id}）`
          : `✅ 已接收（任务 ${task.task_id}）\n项目：${project.alias}\n状态：排队中`,
    })

    await this.schedule()
  }

  /**
   * Machine-wide session overview.
   *
   * The TUI shows one session at a time, so there is no built-in way to see
   * what the *other* sessions are doing. This lists every recent session with
   * its state (running / idle), project, agent and what it is doing right now
   * (its last tool call, or its last narration).
   */
  private async buildSessionOverview(limit = 8): Promise<string> {
    if (!this.client) return "⚠️ 本机 OpenCode 未运行，看不到 session。"

    let sessions: Array<Record<string, any>>
    let activeIds: Set<string>
    try {
      const [list, active] = await Promise.all([
        this.client.session.list({ limit, order: "desc" }),
        this.client.session.active(),
      ])
      sessions = (list.data ?? []) as Array<Record<string, any>>
      activeIds = new Set(Object.keys(active ?? {}))
    } catch (error) {
      log.warn("sessions.overview.failed", { error: (error as Error).message })
      return "⚠️ 读取 session 列表失败。"
    }

    if (sessions.length === 0) return "本机没有 session。"

    const lines = ["🗂 本机 OpenCode session："]
    for (const session of sessions) {
      const id = String(session.id ?? "")
      const running = activeIds.has(id)
      const directory = String(session.location?.directory ?? "?")
      const title = String(session.title ?? "(无标题)")
      const agent = String(session.agent ?? "?")
      const mine = session.metadata?.source === "dingtalk-bridge"

      let doing = ""
      try {
        const messages = await this.client.message.list({
          sessionID: id,
          order: "desc",
          limit: 1,
        })
        doing = describeLastActivity(messages.data?.[0] as Record<string, any> | undefined)
      } catch {
        doing = ""
      }

      const updated = session.time?.updated
        ? new Date(Number(session.time.updated)).toLocaleString("zh-CN", {
            hour12: false,
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "?"

      lines.push(
        [
          running ? "▶️" : "○",
          `${title}`.slice(0, 40),
          `〔${agent}〕`,
          `〔${basename(directory)}〕`,
          mine ? "〔本桥接〕" : "",
          updated,
          doing ? `· ${doing}` : "",
        ]
          .filter(Boolean)
          .join(" "),
      )
    }
    lines.push("", "▶️ = 正在运行，○ = 空闲。id 可用于 TUI /sessions 打开。")
    return lines.join("\n")
  }

  /**
   * Local, zero-cost answer for non-instructional messages.
   *
   * "你在干啥" must never become a task; answering with the bridge's own
   * state is both truthful and instant.
   */
  private buildStatusReply(project: ProjectConfig): string {
    const active = activeTasks(this.db)
    const queued = active.filter((task) => task.status === "PENDING").length
    const running = active.filter((task) => task.status !== "PENDING")
    const last = this.db
      .prepare(
        "SELECT task_id, status, outcome, finished_at FROM tasks ORDER BY created_at DESC LIMIT 1",
      )
      .get() as
      | { task_id: string; status: string; outcome: string | null; finished_at: number | null }
      | undefined

    const lines = [
      "🤖 桥接待命中（我没把这句当任务执行）",
      `· 项目：${project.alias} → ${project.directory}`,
      `· 当前任务：${running.length > 0 ? running.map((task) => `${task.task_id}(${task.status})`).join(", ") : "无"}`,
      `· 队列：${queued}`,
      `· OpenCode：${this.client ? `${this.openCodeVersion} ✓` : "未运行 ✗"}`,
      `· 钉钉：${this.adapter?.isConnected ? "已连接 ✓" : "未连接 ✗"}`,
    ]
    if (last) {
      const when = last.finished_at
        ? new Date(last.finished_at).toLocaleString("zh-CN", { hour12: false })
        : "进行中"
      lines.push(`· 上次任务：${last.task_id} (${last.outcome ?? last.status}) ${when}`)
    }
    lines.push("", "要干活发：/task <描述>", "要问问题发：/ask <问题>", "命令列表：/help")
    return lines.join("\n")
  }

  /** One-line summary of the other running sessions on this machine. */
  private async buildOtherSessionsSummary(): Promise<string> {
    if (!this.client) return ""
    try {
      const active = await this.client.session.active()
      const ids = Object.keys(active ?? {})
      if (ids.length === 0) return ""
      const parts: string[] = []
      for (const id of ids.slice(0, 3)) {
        const session = await this.client.session.get({ sessionID: id })
        parts.push(
          `${String(session.title ?? "(无标题)").slice(0, 24)}〔${String(session.agent ?? "?")}〕`,
        )
      }
      return `· 其它运行中的 session：${parts.join("、")}`
    } catch {
      return ""
    }
  }

  /**
   * Mobile-friendly approval: reply "允许" / "拒绝" without typing a code.
   * Only applies when the conversation has exactly one pending approval.
   */
  private async handleQuickApproval(
    message: DingTalkInbound,
    project: ProjectConfig,
    decision: "approve" | "reject",
  ): Promise<void> {
    const pending = this.db
      .prepare(
        `SELECT a.* FROM approvals a
         JOIN tasks t ON t.task_id = a.task_id
         WHERE t.conversation_id = ? AND a.status = 'PENDING'
         ORDER BY a.requested_at ASC`,
      )
      .all(message.conversationId) as Array<{
      approval_id: string
      task_id: string
      session_id: string
      request_id: string
    }>

    if (pending.length === 0) {
      await this.replyDirect(message, "当前没有待确认项。")
      return
    }
    if (pending.length > 1) {
      const ids = pending.map((item) => item.approval_id).join("、")
      await this.replyDirect(message, `有 ${pending.length} 个待确认项，请指定编号：${ids}`)
      return
    }

    const approval = pending[0]!
    const approvers = project.approvers.length > 0 ? project.approvers : project.allowedUsers
    if (approvers.length > 0 && !approvers.includes(message.senderStaffId)) {
      await this.replyDirect(message, "⛔ 你没有审批权限。")
      return
    }

    const applied = await this.applyApproval(approval, decision, message.senderStaffId)
    if (!applied.ok) {
      await this.replyDirect(message, applied.message)
      return
    }
    await this.replyDirect(
      message,
      decision === "approve"
        ? `✅ 已批准 ${approval.approval_id}，继续执行。`
        : `🚫 已拒绝 ${approval.approval_id}。`,
    )
  }

  /**
   * Apply a decision to a pending approval and forward it to OpenCode.
   *
   * Shared by the DingTalk command, the one-key reply, the macOS dialog and
   * the local CLI. The database claim guarantees a single winner.
   */
  private async applyApproval(
    approval: {
      approval_id: string
      task_id: string
      session_id: string
      request_id: string
    },
    decision: "approve" | "reject",
    decidedBy: string,
    note?: string,
  ): Promise<{ ok: boolean; message: string }> {
    const claimed = this.db
      .prepare(
        "UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, decision_note = ? WHERE approval_id = ? AND status = 'PENDING'",
      )
      .run(
        decision === "approve" ? "APPROVED" : "REJECTED",
        Date.now(),
        decidedBy,
        note ?? null,
        approval.approval_id,
      )
    if (claimed.changes === 0) {
      return { ok: false, message: "该确认项已被处理。" }
    }

    if (!this.client) {
      return { ok: false, message: "⚠️ 本机 OpenCode 未运行，无法继续。" }
    }

    try {
      await this.client.permission.reply({
        sessionID: approval.session_id,
        requestID: approval.request_id,
        decision: decision === "approve" ? "once" : "reject",
        message: note ?? undefined,
      })
    } catch (error) {
      log.warn("approval.reply.failed", {
        approvalId: approval.approval_id,
        error: (error as Error).message,
      })
      return { ok: false, message: "提交确认失败，请重试或联系管理员。" }
    }

    const task = getTask(this.db, approval.task_id)
    if (task) {
      updateTask(this.db, task.task_id, { status: "RUNNING", approval_id: null })
      this.outbox.enqueue({
        dedupeKey: `task:${task.task_id}:approval_decided:${approval.approval_id}`,
        taskId: task.task_id,
        conversationId: task.conversation_id,
        kind: "STATUS",
        text:
          decision === "approve"
            ? `✅ 确认项 ${approval.approval_id} 已批准，继续执行。`
            : `🚫 确认项 ${approval.approval_id} 已拒绝。`,
      })
    }

    audit(this.db, {
      actorType: decidedBy === "mac" ? "SYSTEM" : "USER",
      actorId: decidedBy,
      action: decision === "approve" ? "approval.approved" : "approval.rejected",
      taskId: approval.task_id,
      sessionId: approval.session_id,
      conversationId: task?.conversation_id,
      detail: { approvalId: approval.approval_id, note: note ?? null, via: decidedBy },
      result: "OK",
    })
    return { ok: true, message: "ok" }
  }

  private async ensureChatSession(
    conversationId: string,
    project: ProjectConfig,
  ): Promise<string | undefined> {
    if (!this.client) return undefined
    const existing = this.db
      .prepare("SELECT session_id FROM chat_sessions WHERE conversation_id = ?")
      .get(conversationId) as { session_id: string } | undefined
    if (existing) {
      try {
        await this.client.session.get({ sessionID: existing.session_id })
        return existing.session_id
      } catch {
        // session gone: fall through and create a new one
      }
    }
    try {
      const session = await this.client.session.create({
        location: { directory: project.directory },
        title: `DingTalk chat / ${project.alias}`,
        agent: "dingtalk-chat",
        metadata: { source: "dingtalk-bridge", kind: "chat" },
        permissions: CHAT_PERMISSIONS,
      })
      this.db
        .prepare(
          "INSERT INTO chat_sessions (conversation_id, session_id, created_at) VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET session_id = excluded.session_id",
        )
        .run(conversationId, session.id, Date.now())
      log.info("chat.session.created", { sessionId: session.id })
      return session.id
    } catch (error) {
      log.error("chat.session.failed", { error: (error as Error).message })
      return undefined
    }
  }

  private resolveRoute(
    message: DingTalkInbound,
  ): { ok: true; project: ProjectConfig } | { ok: false; code: string; message: string } {
    if (!message.senderStaffId) {
      return { ok: false, code: "AUTH_DENIED", message: "⛔ 无权限（仅限企业内部成员）" }
    }
    const project = this.opts.config.projects.find((candidate) =>
      candidate.allowedConversations.includes(message.conversationId),
    )
    if (!project) {
      return { ok: false, code: "NO_PROJECT", message: "⚠️ 该会话未绑定项目。" }
    }
    if (project.allowedUsers.length > 0 && !project.allowedUsers.includes(message.senderStaffId)) {
      return { ok: false, code: "AUTH_DENIED", message: "⛔ 无权限" }
    }
    return { ok: true, project }
  }

  // ----------------------------------------------------------------- commands

  private async handleCommand(
    message: DingTalkInbound,
    project: ProjectConfig,
    text: string,
  ): Promise<void> {
    const command = text.split(/\s+/)[0]?.toLowerCase() ?? ""
    const conversation = getConversation(this.db, message.conversationId)
    const sessionId = conversation?.active_session_id ?? undefined
    const running = sessionId ? sessionTask(this.db, sessionId) : undefined

    if (command === "/help") {
      await this.replyDirect(
        message,
        [
          "可用命令：",
          "/task <描述> 执行一个任务（只有这个会真的动手）",
          "/ask <问题> 只读问答（不会改任何文件）",
          "/status 查看当前任务与会话",
          "/sessions 查看本机所有 OpenCode session 在干什么",
          "/cancel 取消当前任务与排队任务",
          "/resume 恢复被本机输入暂停的会话",
          "/new 开启新会话",
          "/help 本帮助",
        ].join("\n"),
      )
      return
    }

    if (command === "/sessions") {
      await this.replyDirect(message, await this.buildSessionOverview())
      return
    }

    if (command === "/status") {
      const pending = pendingTasks(this.db).filter(
        (task) => task.conversation_id === message.conversationId,
      ).length
      const lines = [
        `项目：${project.alias}`,
        `会话：${sessionId ?? "<无>"}`,
        `当前任务：${running ? `${running.task_id} (${running.status})` : "<无>"}`,
        `排队中：${pending}`,
      ]
      await this.replyDirect(message, lines.join("\n"))
      return
    }

    if (command === "/cancel") {
      if (!sessionId) {
        await this.replyDirect(message, "没有可取消的任务。")
        return
      }
      const cancelled = await this.cancelSessionTasks(sessionId, message.conversationId)
      await this.replyDirect(
        message,
        cancelled > 0 ? `🚫 已取消 ${cancelled} 个任务。` : "没有可取消的任务。",
      )
      return
    }

    if (command === "/resume") {
      if (!sessionId) {
        await this.replyDirect(message, "没有可恢复的会话。")
        return
      }
      const session = getSession(this.db, sessionId)
      if (!session || session.control_mode !== "PAUSED") {
        await this.replyDirect(message, "当前会话未被暂停。")
        return
      }
      setSessionControlMode(this.db, sessionId, "BRIDGE")
      await this.replyDirect(message, "▶️ 已恢复自动派发。")
      await this.schedule()
      return
    }

    if (command === "/new") {
      if (running) {
        await this.replyDirect(message, "当前有任务在执行，请先 /cancel。")
        return
      }
      upsertConversation(this.db, {
        conversationId: message.conversationId,
        conversationType: Number(message.conversationType) || 1,
        title: message.conversationTitle,
        projectAlias: project.alias,
        webhook: message.sessionWebhook,
        webhookExpiresAt: message.sessionWebhookExpiredTime,
      })
      this.db
        .prepare("UPDATE conversations SET active_session_id = NULL WHERE conversation_id = ?")
        .run(message.conversationId)
      await this.replyDirect(message, "🆕 已开启新会话，下次任务将使用新 session。")
      return
    }

    await this.replyDirect(message, `未知命令：${command}（发送 /help 查看帮助）`)
  }

  private async handleApprovalCommand(
    message: DingTalkInbound,
    project: ProjectConfig,
    text: string,
  ): Promise<void> {
    const match = /^#(approve|reject)\s+([A-Za-z0-9]{4,8})\s*(.*)$/.exec(text.trim())
    if (!match) {
      await this.replyDirect(message, "命令格式：#approve <编号> 或 #reject <编号> [原因]")
      return
    }
    const [, action, rawApprovalId, note] = match
    const approvalId = rawApprovalId!.toUpperCase()
    const approval = this.db
      .prepare("SELECT * FROM approvals WHERE approval_id = ?")
      .get(approvalId.toUpperCase()) as
      | {
          approval_id: string
          task_id: string
          session_id: string
          request_id: string
          status: string
          expires_at: number
        }
      | undefined

    if (!approval) {
      await this.replyDirect(message, `找不到待确认项 ${approvalId.toUpperCase()}。`)
      return
    }

    const task = getTask(this.db, approval.task_id)
    if (!task || task.conversation_id !== message.conversationId) {
      await this.replyDirect(message, "该确认项不属于当前会话。")
      return
    }

    const approvers = project.approvers.length > 0 ? project.approvers : project.allowedUsers
    if (approvers.length > 0 && !approvers.includes(message.senderStaffId)) {
      await this.replyDirect(message, "⛔ 你没有审批权限。")
      audit(this.db, {
        actorType: "USER",
        actorId: message.senderStaffId,
        action: "approval.denied_by_policy",
        taskId: task.task_id,
        conversationId: message.conversationId,
        result: "AUTH_DENIED",
      })
      return
    }

    const applied = await this.applyApproval(
      approval,
      action === "approve" ? "approve" : "reject",
      message.senderStaffId,
      note,
    )
    if (!applied.ok) {
      await this.replyDirect(message, applied.message)
      return
    }
    await this.replyDirect(
      message,
      action === "approve" ? "✅ 已批准，继续执行。" : "🚫 已拒绝该操作。",
    )
  }

  // ----------------------------------------------------------------- scheduler

  private async schedule(): Promise<void> {
    if (!this.client) return

    for (const task of pendingTasks(this.db)) {
      const project = this.opts.config.projects.find(
        (candidate) => candidate.alias === task.project_alias,
      )
      if (!project) continue

      const conversation = getConversation(this.db, task.conversation_id)
      if (!conversation) continue

      if (task.kind === "ask") {
        // Read-only question: own session, no project lock (it changes
        // nothing), no summary suffix.
        const chatSessionId = await this.ensureChatSession(task.conversation_id, project)
        if (!chatSessionId) continue
        if (sessionTask(this.db, chatSessionId)) continue // chat session busy
        try {
          const inbox = await this.client.session.prompt({
            sessionID: chatSessionId,
            id: promptMessageId(task.task_id),
            text: task.prompt_text ?? "",
            delivery: "queue",
            metadata: {
              source: "dingtalk-ask",
              taskID: task.task_id,
              conversationID: task.conversation_id,
            },
          })
          updateTask(this.db, task.task_id, {
            status: "SUBMITTED",
            session_id: chatSessionId,
            inbox_id: inbox.id,
            opencode_message_id: inbox.id,
            submitted_at: Date.now(),
          })
          log.info("ask.submitted", { taskId: task.task_id, sessionId: chatSessionId })
        } catch (error) {
          updateTask(this.db, task.task_id, {
            status: "FAILED",
            error_code: "PROMPT_REJECTED",
            error_message: (error as Error).message,
            finished_at: Date.now(),
          })
          this.outbox.enqueue({
            dedupeKey: `task:${task.task_id}:failed`,
            taskId: task.task_id,
            conversationId: task.conversation_id,
            kind: "ERROR",
            text: `❌ 问答提交失败（${task.task_id}）`,
          })
        }
        continue
      }

      let sessionId = conversation.active_session_id ?? undefined
      if (sessionId) {
        const active = sessionTask(this.db, sessionId)
        if (active) continue // session busy: keep this task queued
        const session = getSession(this.db, sessionId)
        if (session && session.control_mode === "PAUSED") continue // human took over
        // The conversation was rebound to another project: the old session
        // still points at the previous directory, so it must not be reused.
        if (session && session.project_alias !== task.project_alias) {
          log.info("conversation.rebound", {
            conversationId: task.conversation_id,
            from: session.project_alias,
            to: task.project_alias,
            sessionId,
          })
          this.db
            .prepare("UPDATE conversations SET active_session_id = NULL WHERE conversation_id = ?")
            .run(task.conversation_id)
          sessionId = undefined
        }
      }
      if (!sessionId) {
        sessionId = await this.ensureSession(task, project, conversation.conversation_type)
        if (!sessionId) continue
      }

      if (!acquireProjectLock(this.db, task.project_alias, task.task_id, process.pid)) {
        continue // project busy
      }

      try {
        const inbox = await this.client.session.prompt({
          sessionID: sessionId,
          // Idempotency key: a retried prompt reuses the same message id, so
          // OpenCode executes the task at most once (design §5.4, A20).
          id: promptMessageId(task.task_id),
          text: `${task.prompt_text}\n\n---\n[Bridge] 完成后请用不超过 ${
            this.opts.config.bridge.maxResultChars
          } 字的摘要回复，包含：做了什么、改了哪些文件、测试结果、遗留问题。不要提问。`,
          delivery: "queue",
          metadata: {
            source: "dingtalk",
            taskID: task.task_id,
            conversationID: task.conversation_id,
            senderStaffID: task.sender_staff_id,
            msgID: task.msg_id,
          },
        })
        updateTask(this.db, task.task_id, {
          status: "SUBMITTED",
          session_id: sessionId,
          inbox_id: inbox.id,
          opencode_message_id: inbox.id,
          submitted_at: Date.now(),
        })
        this.outbox.enqueue({
          dedupeKey: `task:${task.task_id}:started`,
          taskId: task.task_id,
          conversationId: task.conversation_id,
          kind: "STATUS",
          text: `▶️ 开始执行（${task.task_id}）`,
        })
        log.info("task.submitted", { taskId: task.task_id, sessionId, inboxId: inbox.id })
      } catch (error) {
        const conflict = await this.handlePromptConflict(task, sessionId, error)
        if (conflict) continue
        releaseProjectLock(this.db, task.project_alias, task.task_id)
        updateTask(this.db, task.task_id, {
          status: "FAILED",
          error_code: "PROMPT_REJECTED",
          error_message: (error as Error).message,
          finished_at: Date.now(),
        })
        this.outbox.enqueue({
          dedupeKey: `task:${task.task_id}:failed`,
          taskId: task.task_id,
          conversationId: task.conversation_id,
          kind: "ERROR",
          text: `❌ 任务提交失败（${task.task_id}）`,
        })
      }
    }
  }

  /**
   * A 409 on prompt means the same message id is already queued. Confirm it
   * through the inbox instead of submitting a second copy (design §11.2).
   */
  private async handlePromptConflict(
    task: Task,
    sessionId: string,
    error: unknown,
  ): Promise<boolean> {
    const status = (error as { status?: number }).status
    if (status !== 409 || !this.client) return false
    try {
      const inbox = await this.client.session.inbox.list({ sessionID: sessionId })
      const existing = inbox.find((item) => item.id === promptMessageId(task.task_id))
      if (!existing) return false
      updateTask(this.db, task.task_id, {
        status: "SUBMITTED",
        session_id: sessionId,
        inbox_id: existing.id,
        opencode_message_id: existing.id,
        submitted_at: Date.now(),
      })
      log.info("task.prompt.conflict.resolved", { taskId: task.task_id, inboxId: existing.id })
      return true
    } catch {
      return false
    }
  }

  private async ensureSession(
    task: Task,
    project: ProjectConfig,
    conversationType: number,
  ): Promise<string | undefined> {
    if (!this.client) return undefined
    const title = `DingTalk / ${project.alias} / ${task.task_id}`
    try {
      const session = await this.client.session.create({
        location: { directory: project.directory },
        title,
        agent: project.agent,
        metadata: {
          source: "dingtalk-bridge",
          conversationID: task.conversation_id,
          projectAlias: project.alias,
        },
        permissions: project.permissions.length > 0 ? project.permissions : undefined,
      })
      setActiveSession(this.db, task.conversation_id, session.id, project.alias, title)
      log.info("session.created", { sessionId: session.id, project: project.alias })
      return session.id
    } catch (error) {
      log.error("session.create.failed", { error: (error as Error).message })
      this.outbox.enqueue({
        dedupeKey: `task:${task.task_id}:session_failed`,
        taskId: task.task_id,
        conversationId: task.conversation_id,
        kind: "ERROR",
        text: `❌ 无法创建会话（${task.task_id}）`,
      })
      return undefined
    }
  }

  // -------------------------------------------------------------- reconciler

  private async reconcile(): Promise<void> {
    if (!this.client) return

    for (const task of activeTasks(this.db)) {
      if (task.status === "PENDING") continue
      if (!task.session_id || !task.opencode_message_id) continue

      renewProjectLock(this.db, task.project_alias, task.task_id)
      touchSessionPoll(this.db, task.session_id)

      const window = await fetchTurnWindow(this.client, task.session_id, task.opencode_message_id)
      if (!window.found) {
        await this.syncApprovals(task)
        await this.syncForms(task)
        continue
      }

      if (window.started && !task.started_at) {
        updateTask(this.db, task.task_id, { status: "RUNNING", started_at: Date.now() })
      }

      // Accumulate assistant text idempotently so a restart cannot lose it.
      window.parts.forEach((part, ordinal) => {
        appendTaskText(this.db, task.task_id, part.messageId, ordinal, part.text)
      })

      if (!window.idleMessageId || !window.outcome) {
        await this.syncApprovals(task)
        await this.syncForms(task)
        continue
      }

      const duration = task.started_at
        ? Math.round((Date.now() - task.started_at) / 1000)
        : task.submitted_at
          ? Math.round((Date.now() - task.submitted_at) / 1000)
          : 0
      const text = taskTexts(this.db, task.task_id).join("\n\n").slice(
        0,
        this.opts.config.bridge.maxResultChars,
      )
      const outcome = window.outcome
      const succeeded = outcome === "succeeded"

      updateTask(this.db, task.task_id, {
        status: succeeded
          ? "SUCCEEDED"
          : outcome === "failed"
            ? "FAILED"
            : outcome === "interrupted"
              ? "INTERRUPTED"
              : "UNKNOWN",
        outcome,
        result_summary: text,
        started_at: task.started_at ?? task.submitted_at ?? Date.now(),
        finished_at: Date.now(),
        error_code: succeeded ? null : `EXECUTION_${outcome.toUpperCase()}`,
      })
      releaseProjectLock(this.db, task.project_alias, task.task_id)

      audit(this.db, {
        actorType: "BRIDGE",
        action: `task.${outcome}`,
        taskId: task.task_id,
        sessionId: task.session_id,
        conversationId: task.conversation_id,
        detail: { durationSeconds: duration, humanIntervened: Boolean(task.human_intervened) },
        result: outcome,
      })

      const truncated =
        taskTexts(this.db, task.task_id).join("\n\n").length > this.opts.config.bridge.maxResultChars
      this.outbox.enqueue({
        dedupeKey: `task:${task.task_id}:result`,
        taskId: task.task_id,
        conversationId: task.conversation_id,
        kind: succeeded ? "RESULT" : "ERROR",
        text:
          task.kind === "ask"
            ? succeeded
              ? `${text || "<无输出>"}${truncated ? "\n（结果已截断，完整内容见本机 TUI）" : ""}`
              : `❌ 问答失败（${task.task_id}，outcome=${outcome}）\n${text || "<无输出>"}`
            : succeeded
              ? `✅ 完成（${task.task_id}，用时 ${duration}s）${task.human_intervened ? " ⚠️ 本机有人工介入" : ""}\n${text || "<无输出>"}${truncated ? "\n（结果已截断，完整内容见本机 TUI）" : ""}`
              : `❌ 失败（${task.task_id}，outcome=${outcome}）\n${text || "<无输出>"}`,
      })
      log.info("task.finished", {
        taskId: task.task_id,
        outcome,
        durationSeconds: duration,
      })
      this.heartbeat?.update({ lastTaskFinishedAt: Date.now() })
    }
  }

  private async syncApprovals(task: Task): Promise<void> {
    if (!this.client || !task.session_id) return

    const pending = await this.client.permission.list({ sessionID: task.session_id })
    const rows = this.db
      .prepare("SELECT * FROM approvals WHERE task_id = ?")
      .all(task.task_id) as Array<{
      approval_id: string
      request_id: string
      status: string
      action: string
      resources: string | null
      message: string | null
      expires_at: number
    }>

    for (const request of pending) {
      const known = rows.find((row) => row.request_id === request.id)
      if (known) continue

      // Only one approval is kept open per session: a second request is
      // rejected so that the decision stays unambiguous (design §5.6).
      const openApproval = rows.find((row) => row.status === "PENDING")
      if (openApproval) {
        await this.client.permission.reply({
          sessionID: task.session_id,
          requestID: request.id,
          decision: "reject",
          message: "同一会话同时只允许一个待确认项",
        })
        this.outbox.enqueue({
          dedupeKey: `task:${task.task_id}:approval_extra:${request.id}`,
          taskId: task.task_id,
          conversationId: task.conversation_id,
          kind: "STATUS",
          text: `ℹ️ 额外的确认请求 ${request.action} 已自动拒绝（同一会话只保留一个待确认项）。`,
        })
        continue
      }

      const approvalId = newApprovalId(request.id)
      this.db
        .prepare(
          `INSERT OR IGNORE INTO approvals
             (approval_id, task_id, session_id, request_id, action, resources, message, status, requested_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
        )
        .run(
          approvalId,
          task.task_id,
          task.session_id,
          request.id,
          request.action,
          JSON.stringify(request.resources ?? []),
          request.message ?? null,
          Date.now(),
          Date.now() + this.opts.config.bridge.approvalTimeoutMs,
        )
      updateTask(this.db, task.task_id, { status: "WAITING_APPROVAL", approval_id: approvalId })
      this.outbox.enqueue({
        dedupeKey: `task:${task.task_id}:approval:${request.id}`,
        taskId: task.task_id,
        conversationId: task.conversation_id,
        kind: "APPROVAL",
        text: [
          `⚠️ 需要确认 [${approvalId}]`,
          `动作：${request.action}`,
          `资源：${(request.resources ?? []).join(", ").slice(0, 300)}`,
          request.message ? `说明：${request.message.slice(0, 200)}` : "",
          `回复：#approve ${approvalId}  或  #reject ${approvalId}`,
        ]
          .filter(Boolean)
          .join("\n"),
      })
      audit(this.db, {
        actorType: "BRIDGE",
        action: "approval.requested",
        taskId: task.task_id,
        sessionId: task.session_id,
        conversationId: task.conversation_id,
        detail: { approvalId, action: request.action },
        result: "PENDING",
      })

      // Native macOS dialog: approve without touching the phone. Shown at most
      // once per 3 minutes per approval so a dismissed dialog does not spam.
      this.offerMacDialog(task, {
        approval_id: approvalId,
        task_id: task.task_id,
        session_id: task.session_id!,
        request_id: request.id,
      }, request)
    }

    // Approvals that disappeared were answered elsewhere (e.g. in the TUI).
    for (const row of rows) {
      if (row.status !== "PENDING") continue
      if (pending.some((request) => request.id === row.request_id)) continue
      this.db
        .prepare("UPDATE approvals SET status = 'REMOTE_HANDLED', decided_at = ? WHERE approval_id = ?")
        .run(Date.now(), row.approval_id)
      updateTask(this.db, task.task_id, { status: "RUNNING", approval_id: null })
      this.outbox.enqueue({
        dedupeKey: `task:${task.task_id}:approval_remote:${row.approval_id}`,
        taskId: task.task_id,
        conversationId: task.conversation_id,
        kind: "STATUS",
        text: `ℹ️ 确认项 ${row.approval_id} 已在本机处理。`,
      })
    }
  }

  /**
   * Forms are not supported in the MVP: the agent's `question` permission is
   * denied, but a form may still show up. It is cancelled right away so the
   * task cannot hang silently (design §5.7).
   */
  private async syncForms(task: Task): Promise<void> {
    if (!this.client || !task.session_id) return
    const forms = await this.client.session.form.list({ sessionID: task.session_id })
    if (forms.length === 0) return

    for (const form of forms) {
      const dedupeKey = `task:${task.task_id}:form:${form.id}`
      const exists = this.db
        .prepare("SELECT 1 FROM outbox WHERE dedupe_key = ?")
        .get(dedupeKey)
      if (exists) continue
      this.outbox.enqueue({
        dedupeKey,
        taskId: task.task_id,
        conversationId: task.conversation_id,
        kind: "STATUS",
        text: `⚠️ 该任务需要交互式输入（MVP 不支持），已自动取消并继续。`,
      })
      try {
        await this.client.session.form.cancel({
          sessionID: task.session_id,
          formID: form.id,
        })
      } catch (error) {
        log.warn("form.cancel.failed", { formId: form.id, error: (error as Error).message })
      }
    }
  }

  /** Show the native macOS approval dialog (at most once per 3 minutes). */
  private offerMacDialog(
    task: Task,
    approval: {
      approval_id: string
      task_id: string
      session_id: string
      request_id: string
    },
    request: { action: string; resources?: string[]; message?: string },
  ): void {
    const last = this.dialogShownAt.get(approval.approval_id)
    if (last && Date.now() - last < 180_000) return
    this.dialogShownAt.set(approval.approval_id, Date.now())

    const resources = (request.resources ?? []).join(", ").slice(0, 300)
    showApprovalDialog({
      title: `任务 ${task.task_id} 需要确认 [${approval.approval_id}]`,
      detail: `动作：${request.action}\n资源：${resources}\n${request.message ?? ""}`,
      timeoutSeconds: Math.floor(this.opts.config.bridge.approvalTimeoutMs / 1000),
      log,
      onDecision: (choice) => {
        if (choice === "ignored") return
        void this.applyApproval(approval, choice, "mac").then((result) => {
          log.info("approval.macdialog", {
            approvalId: approval.approval_id,
            choice,
            ok: result.ok,
          })
        })
      },
    })
  }

  private async expireApprovals(): Promise<void> {
    if (!this.client) return
    const due = this.db
      .prepare("SELECT * FROM approvals WHERE status = 'PENDING' AND expires_at < ?")
      .all(Date.now()) as Array<{
      approval_id: string
      task_id: string
      session_id: string
      request_id: string
    }>

    for (const approval of due) {
      const claimed = this.db
        .prepare(
          "UPDATE approvals SET status = 'TIMEOUT', decided_at = ? WHERE approval_id = ? AND status = 'PENDING'",
        )
        .run(Date.now(), approval.approval_id)
      if (claimed.changes === 0) continue

      try {
        await this.client.permission.reply({
          sessionID: approval.session_id,
          requestID: approval.request_id,
          decision: "reject",
          message: "审批超时",
        })
      } catch (error) {
        log.warn("approval.timeout.reply.failed", {
          approvalId: approval.approval_id,
          error: (error as Error).message,
        })
      }
      const task = getTask(this.db, approval.task_id)
      if (task) {
        updateTask(this.db, task.task_id, { status: "RUNNING", approval_id: null })
        this.outbox.enqueue({
          dedupeKey: `task:${task.task_id}:approval_timeout:${approval.approval_id}`,
          taskId: task.task_id,
          conversationId: task.conversation_id,
          kind: "STATUS",
          text: `⌛ 确认项 ${approval.approval_id} 超时，已自动拒绝。`,
        })
      }
    }
  }

  /** Force-stop tasks that ran longer than `maxTaskDurationMs` (design §11.3). */
  private async enforceTaskTimeout(): Promise<void> {
    if (!this.client) return
    for (const task of overdueTasks(this.db, this.opts.config.bridge.maxTaskDurationMs)) {
      try {
        await this.client.session.interrupt({
          sessionID: task.session_id ?? "",
          resume: false,
        })
      } catch (error) {
        log.warn("task.interrupt.failed", { taskId: task.task_id, error: (error as Error).message })
      }
      updateTask(this.db, task.task_id, {
        status: "FAILED",
        outcome: "interrupted",
        error_code: "TASK_TIMEOUT",
        error_message: "任务超过最大时长，已自动中断",
        finished_at: Date.now(),
      })
      releaseProjectLock(this.db, task.project_alias, task.task_id)
      this.outbox.enqueue({
        dedupeKey: `task:${task.task_id}:timeout`,
        taskId: task.task_id,
        conversationId: task.conversation_id,
        kind: "ERROR",
        text: `⌛ 任务超时（${task.task_id}），已自动中断。`,
      })
      audit(this.db, {
        actorType: "BRIDGE",
        action: "task.timeout",
        taskId: task.task_id,
        sessionId: task.session_id ?? undefined,
        conversationId: task.conversation_id,
        result: "TASK_TIMEOUT",
      })
    }
  }

  private async cancelSessionTasks(sessionId: string, conversationId: string): Promise<number> {
    if (!this.client) return 0
    const tasks = activeTasks(this.db).filter(
      (task) => task.session_id === sessionId && task.status !== "PENDING",
    )
    const queued = activeTasks(this.db).filter(
      (task) => task.conversation_id === conversationId && task.status === "PENDING",
    )

    for (const task of tasks) {
      try {
        await this.client.session.interrupt({ sessionID: sessionId, resume: false })
      } catch (error) {
        log.warn("task.interrupt.failed", { taskId: task.task_id, error: (error as Error).message })
      }
    }

    const inbox = await this.client.session.inbox.list({ sessionID: sessionId })
    for (const item of inbox) {
      try {
        await this.client.session.inbox.cancel({ sessionID: sessionId, inboxID: item.id })
      } catch (error) {
        log.warn("inbox.cancel.failed", { inboxId: item.id, error: (error as Error).message })
      }
    }

    const now = Date.now()
    for (const task of [...tasks, ...queued]) {
      updateTask(this.db, task.task_id, {
        status: "CANCELLED",
        outcome: "interrupted",
        finished_at: now,
        error_code: "CANCELLED",
      })
      releaseProjectLock(this.db, task.project_alias, task.task_id)
      this.outbox.enqueue({
        dedupeKey: `task:${task.task_id}:cancelled`,
        taskId: task.task_id,
        conversationId: task.conversation_id,
        kind: "STATUS",
        text: `🚫 已取消（${task.task_id}）`,
      })
    }
    return tasks.length + queued.length
  }

  // ----------------------------------------------------------------- plumbing

  private async deliver(
    conversationId: string,
    text: string,
    taskId?: string | null,
  ): Promise<boolean> {
    const conversation = getConversation(this.db, conversationId)
    if (!conversation) return false
    const task = taskId ? getTask(this.db, taskId) : undefined
    const target: SendTarget = {
      conversationId,
      conversationType: conversation.conversation_type === 2 ? "2" : "1",
      senderStaffId: task?.sender_staff_id ?? "",
      webhook: conversation.session_webhook ?? undefined,
      webhookExpiresAt: conversation.webhook_expires_at ?? undefined,
    }
    return this.sender.send(target, text)
  }

  private async replyDirect(message: DingTalkInbound, text: string): Promise<void> {
    try {
      await this.replyFn(message, text)
    } catch (error) {
      log.warn("dingtalk.reply.failed", { error: (error as Error).message })
    }
  }

  private async watchGlobalEvents(): Promise<void> {
    if (!this.client) return
    for (;;) {
      try {
        for await (const event of this.client.event.subscribe()) {
          const type = (event as { type?: string }).type ?? ""
          const data = (event as { data?: Record<string, unknown> }).data ?? {}
          this.heartbeat?.update({ lastOpenCodeEventAt: Date.now() })
          if (type === "session.inbox.enqueued") {
            const item = data.item as { payload?: { metadata?: { source?: string } } } | undefined
            const source = item?.payload?.metadata?.source
            // A prompt is "ours" only if it carries a bridge source marker.
            // A prompt without metadata came from the TUI or another client:
            // that IS human input and must be reported.
            if (!BRIDGE_SOURCES.has(source ?? "")) {
              this.flagHumanIntervention(String(data.sessionID ?? ""))
            }
          }
          if (
            type === "session.execution.succeeded" ||
            type === "session.execution.failed" ||
            type === "session.execution.interrupted"
          ) {
            void this.reconcile()
            // Sessions the bridge does not own get a DingTalk notification.
            const outcome =
              type === "session.execution.succeeded"
                ? "succeeded"
                : type === "session.execution.failed"
                  ? "failed"
                  : "interrupted"
            void this.notifier?.notifyFinished(String(data.sessionID ?? ""), outcome)
          }
          if (type === "session.idle") {
            void this.reconcile()
          }
        }
      } catch (error) {
        log.warn("bridge.events.error", { error: (error as Error).message })
        await sleep(3000)
      }
    }
  }

  private flagHumanIntervention(sessionId: string): void {
    // Only the conversation's task session can be "taken over" by a human.
    // Chat sessions (/ask) are bridge-only and are never flagged.
    const session = getSession(this.db, sessionId)
    if (!session) return
    const task = sessionTask(this.db, sessionId)
    if (!task) return
    if (task.human_intervened) return
    updateTask(this.db, task.task_id, { human_intervened: 1 })
    setSessionControlMode(this.db, sessionId, "PAUSED")
    this.outbox.enqueue({
      dedupeKey: `task:${task.task_id}:human_intervened`,
      taskId: task.task_id,
      conversationId: task.conversation_id,
      kind: "STATUS",
      text: `ℹ️ 检测到本机 TUI 输入（${task.task_id}），结果仅供参考。发送 /resume 恢复自动派发。`,
    })
    audit(this.db, {
      actorType: "SYSTEM",
      action: "task.human_intervened",
      taskId: task.task_id,
      sessionId,
      conversationId: task.conversation_id,
      result: "HUMAN_INTERVENED",
    })
  }

  /** One scheduler iteration; used by the loop and by the tests. */
  async runOnce(): Promise<void> {
    await this.outbox.tick()
    await this.schedule()
    await this.reconcile()
    await this.expireApprovals()
    await this.enforceTaskTimeout()

    const now = Date.now()
    if (now - this.lastRetentionAt > 60 * 60_000) {
      this.lastRetentionAt = now
      const removed = applyRetention(this.db, now)
      log.info("retention.applied", removed)
    }

    const active = activeTasks(this.db)
    this.heartbeat?.update({
      queueDepth: pendingTasks(this.db).length,
      activeTasks: active.length,
    })
  }

  private async loop(): Promise<void> {
    let tick = 0
    while (this.running) {
      try {
        await this.runOnce()
        // The event stream is live-only: sweep for completions it may have missed.
        if (tick % 60 === 0) void this.notifier?.sweep()
        if (tick % 30 === 0 && this.outbox.pendingCount() > 0) {
          log.warn("outbox.backlog", { pending: this.outbox.pendingCount() })
        }
      } catch (error) {
        log.error("bridge.loop.error", { error: (error as Error).message })
      }
      tick += 1
      await sleep(1000)
    }
  }
}

export async function main(): Promise<void> {
  // A background daemon must not die because one request failed. Log and
  // keep serving (design §13.1): an unhandled rejection would otherwise take
  // the whole bridge down and lose in-flight work.
  process.on("unhandledRejection", (reason) => {
    log.error("bridge.unhandled_rejection", {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack?.slice(0, 400) : undefined,
    })
  })
  process.on("uncaughtException", (error) => {
    log.error("bridge.uncaught_exception", { error: error.message })
  })
  const config = loadConfig()
  const secret = await readClientSecret()
  const db = openDatabase(config.bridge.dataDir)
  const runtimeDir = join(config.bridge.dataDir, "runtime")
  const lock = acquireInstanceLock(runtimeDir)
  log.info("bridge.booting", { dataDir: config.bridge.dataDir, pid: process.pid })

  const heartbeat = new HeartbeatWriter(heartbeatPath(config.bridge.dataDir))
  const bridge = new Bridge({ config, db, secret, heartbeat })
  await bridge.start()

  const shutdown = () => {
    void bridge.stop().then(() => {
      lock.release()
      process.exit(0)
    })
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, shutdown)
  }
}


function basename(path: string): string {
  const parts = path.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/**
 * Describe what a session is doing right now from its last message:
 * a running/completed tool call, or the last narration.
 */
function describeLastActivity(message: Record<string, any> | undefined): string {
  if (!message) return ""
  if (message.type === "idle") return ""
  const content = (message.content ?? []) as Array<Record<string, any>>
  for (const part of content) {
    if (part.type === "tool") {
      const status = String(part.state?.status ?? "")
      const name = String(part.name ?? part.tool ?? "tool")
      if (status === "running" || status === "pending") return `正在跑 ${name}`
    }
  }
  for (const part of content) {
    if (part.type === "text" && part.text) {
      return String(part.text).replace(/\s+/g, " ").slice(0, 60)
    }
  }
  for (const part of content) {
    if (part.type === "reasoning" && part.text) {
      return `思考中：${String(part.text).replace(/\s+/g, " ").slice(0, 50)}`
    }
  }
  return ""
}
