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
import { OpenCode } from "@opencode/client"
import { loadConfig, type BridgeConfig, type ProjectConfig } from "./config.js"
import { readClientSecret } from "./credentials.js"
import { createLogger, type Logger } from "./logger.js"
import { connectOpenCode, OpenCodeUnavailableError } from "./opencode/client.js"
import { fetchTurn } from "./opencode/timeline.js"
import { DingTalkAdapter, type DingTalkInbound } from "./dingtalk/adapter.js"
import { DingTalkSenderImpl, type SendTarget } from "./dingtalk/send.js"
import { Outbox } from "./outbox.js"
import { showApprovalDialog } from "./approvals/mac-dialog.js"
import { resolvePermissions } from "./permissions.js"
import { audit, openDatabase, type Db } from "./store/db.js"
import {
  getConversation,
  getSession,
  setActiveSession,
  setSessionControlMode,
  upsertConversation,
} from "./store/conversations.js"
import {
  acquireProjectLock,
  activeTasks,
  clearExpiredLocks,
  createTask,
  getTask,
  newApprovalId,
  newTaskId,
  pendingTasks,
  recordInbound,
  releaseProjectLock,
  renewProjectLock,
  sessionTask,
  updateTask,
  type Task,
} from "./store/tasks.js"

const log = createLogger({ scope: "bridge" })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Client = ReturnType<typeof OpenCode.make>

class Bridge {
  private client: Client | undefined
  private openCodeVersion = "unknown"
  private outbox: Outbox
  private sender: DingTalkSenderImpl
  private adapter: DingTalkAdapter
  private running = false
  /** approvalId -> last time a macOS dialog was shown for it. */
  private dialogShownAt = new Map<string, number>()
  /** sessions whose permission ruleset was already pushed to OpenCode. */
  private permissionsSynced = new Set<string>()
  /** taskId -> last heartbeat notification. */
  private heartbeatAt = new Map<string, number>()

  constructor(
    private readonly config: BridgeConfig,
    private readonly db: Db,
    private readonly secret: string,
  ) {
    this.sender = new DingTalkSenderImpl({
      clientId: config.dingtalk.clientId,
      clientSecret: secret,
      robotCode: config.dingtalk.robotCode,
      log,
    })
    this.outbox = new Outbox(
      this.db,
      (item, text) => this.deliver(item.conversation_id, text, item.task_id),
      log,
    )
    this.adapter = new DingTalkAdapter({
      clientId: config.dingtalk.clientId,
      clientSecret: secret,
      robotCode: config.dingtalk.robotCode,
      log,
      onMessage: (message) => this.handleMessage(message),
    })
  }

  // ------------------------------------------------------------------ startup

  async start(): Promise<void> {
    this.running = true
    clearExpiredLocks(this.db)
    await this.connectOpenCode()
    await this.adapter.connect()
    void this.watchGlobalEvents()
    void this.loop()
    log.info("bridge.started", {
      projects: this.config.projects.map((project) => project.alias),
      opencode: this.openCodeVersion,
    })
  }

  async stop(): Promise<void> {
    this.running = false
    this.adapter.disconnect()
    log.info("bridge.stopped")
  }

  private async connectOpenCode(): Promise<void> {
    for (;;) {
      try {
        const connection = await connectOpenCode({
          versionRange: this.config.opencode.versionRange,
          requiredRoutes: this.config.opencode.requiredRoutes,
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
        // Keep serving DingTalk: commands still work, tasks are rejected with a
        // clear message. The service may come back at any time.
        await sleep(10_000)
      }
    }
  }

  // ------------------------------------------------------------- message flow

  private async handleMessage(message: DingTalkInbound): Promise<void> {
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
          knownConversations: this.config.projects.flatMap((project) => project.allowedConversations),
        },
        result: route.code,
      })
      await this.replyDirect(message, route.message)
      return
    }

    const project = route.project
    const text = message.text

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

    if (text.length > this.config.bridge.maxPromptChars) {
      await this.replyDirect(message, `任务过长（上限 ${this.config.bridge.maxPromptChars} 字符）。`)
      return
    }

    const dedupe = recordInbound(this.db, message.msgId, "ACCEPTED")
    if (dedupe === "DUPLICATE") {
      log.info("dingtalk.message.duplicate", { msgId: message.msgId })
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
      recordInbound(this.db, message.msgId, "REJECTED", "opencode_unavailable")
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
      text: `✅ 已接收（任务 ${task.task_id}）\n项目：${project.alias}\n状态：排队中`,
    })

    await this.schedule()
  }

  private resolveRoute(
    message: DingTalkInbound,
  ): { ok: true; project: ProjectConfig } | { ok: false; code: string; message: string } {
    if (!message.senderStaffId) {
      return { ok: false, code: "AUTH_DENIED", message: "⛔ 无权限（仅限企业内部成员）" }
    }
    const project = this.config.projects.find((candidate) =>
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
          "/status 查看当前任务与会话",
          "/cancel 取消当前任务与排队任务",
          "/resume 恢复被本机输入暂停的会话",
          "/new 开启新会话",
          "/help 本帮助",
        ].join("\n"),
      )
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

  /**
   * Apply a decision to a pending approval and forward it to OpenCode.
   * Shared by the DingTalk command, the macOS dialog and the local CLI.
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

    const applied = await this.applyApproval(
      approval,
      decision,
      message.senderStaffId,
      undefined,
    )
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

  // ----------------------------------------------------------------- scheduler

  private async schedule(): Promise<void> {
    if (!this.client) return

    for (const task of pendingTasks(this.db)) {
      if (!this.config.projects.some((project) => project.alias === task.project_alias)) continue
      const project = this.config.projects.find(
        (candidate) => candidate.alias === task.project_alias,
      )!

      const conversation = getConversation(this.db, task.conversation_id)
      if (!conversation) continue

      let sessionId = conversation.active_session_id ?? undefined
      if (sessionId) {
        const active = sessionTask(this.db, sessionId)
        if (active) continue // session busy: keep this task queued
        const session = getSession(this.db, sessionId)
        if (session && session.control_mode === "PAUSED") continue // human took over
      } else {
        sessionId = await this.ensureSession(task, project, conversation.conversation_type)
        if (!sessionId) continue
      }

      if (!acquireProjectLock(this.db, task.project_alias, task.task_id, process.pid)) {
        continue // project busy
      }

      try {
        const inbox = await this.client.session.prompt({
          sessionID: sessionId,
          text: `${task.prompt_text}\n\n---\n[Bridge] 完成后请用不超过 ${
            this.config.bridge.maxResultChars
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
        permissions: resolvePermissions(project),
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

  /**
   * Keep a live session's permission ruleset in sync with the project preset,
   * so changing the policy does not require a new session.
   */
  private async syncSessionPermissions(sessionId: string, project: ProjectConfig): Promise<void> {
    if (!this.client) return
    if (this.permissionsSynced.has(sessionId)) return
    this.permissionsSynced.add(sessionId)
    try {
      await this.client.session.update({
        sessionID: sessionId,
        permissions: resolvePermissions(project),
      })
      log.info("session.permissions.synced", {
        sessionId,
        preset: project.permissionPreset,
      })
    } catch (error) {
      this.permissionsSynced.delete(sessionId)
      log.warn("session.permissions.sync.failed", {
        sessionId,
        error: (error as Error).message,
      })
    }
  }

  private async reconcile(): Promise<void> {
    if (!this.client) return

    for (const task of activeTasks(this.db)) {
      if (task.status === "PENDING") continue
      if (!task.session_id || !task.opencode_message_id) continue

      renewProjectLock(this.db, task.project_alias, task.task_id)

      const project = this.config.projects.find(
        (candidate) => candidate.alias === task.project_alias,
      )
      if (project) await this.syncSessionPermissions(task.session_id, project)

      const turn = await fetchTurn(this.client, task.session_id, task.opencode_message_id)

      if (!turn) {
        await this.syncApprovals(task)
        this.sendHeartbeat(task)
        continue
      }

      const duration = task.started_at ? Math.round((Date.now() - task.started_at) / 1000) : 0
      const text = turn.text.slice(0, this.config.bridge.maxResultChars)
      const succeeded = turn.outcome === "succeeded"

      updateTask(this.db, task.task_id, {
        status: succeeded ? "SUCCEEDED" : turn.outcome === "failed" ? "FAILED" : "INTERRUPTED",
        outcome: turn.outcome,
        result_summary: text,
        started_at: task.started_at ?? task.submitted_at ?? Date.now(),
        finished_at: Date.now(),
        error_code: succeeded ? null : "EXECUTION_" + turn.outcome.toUpperCase(),
      })
      releaseProjectLock(this.db, task.project_alias, task.task_id)

      audit(this.db, {
        actorType: "BRIDGE",
        action: `task.${turn.outcome}`,
        taskId: task.task_id,
        sessionId: task.session_id,
        conversationId: task.conversation_id,
        detail: { durationSeconds: duration, humanIntervened: Boolean(task.human_intervened) },
        result: turn.outcome,
      })

      this.outbox.enqueue({
        dedupeKey: `task:${task.task_id}:result`,
        taskId: task.task_id,
        conversationId: task.conversation_id,
        kind: succeeded ? "RESULT" : "ERROR",
        text: succeeded
          ? `✅ 完成（${task.task_id}，用时 ${duration}s）${task.human_intervened ? " ⚠️ 本机有人工介入" : ""}\n${text || "<无输出>"}`
          : `❌ 失败（${task.task_id}，outcome=${turn.outcome}）\n${text || "<无输出>"}`,
      })
      log.info("task.finished", {
        taskId: task.task_id,
        outcome: turn.outcome,
        durationSeconds: duration,
      })
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
      if (known) {
        // Already tracked: still pending, so (re)offer the local dialog.
        this.offerMacDialog(task, {
          approval_id: known.approval_id,
          task_id: task.task_id,
          session_id: task.session_id!,
          request_id: request.id,
        }, request)
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
          Date.now() + this.config.bridge.approvalTimeoutMs,
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

      // Native macOS dialog: approve without touching the phone.
      this.offerMacDialog(
        task,
        {
          approval_id: approvalId,
          task_id: task.task_id,
          session_id: task.session_id!,
          request_id: request.id,
        },
        request,
      )
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

  /** Periodic "still running" notice for long tasks. */
  private sendHeartbeat(task: Task): void {
    const started = task.started_at ?? task.submitted_at ?? task.created_at
    const elapsed = Date.now() - started
    if (elapsed < 60_000) return
    const last = this.heartbeatAt.get(task.task_id) ?? started
    if (Date.now() - last < this.config.bridge.heartbeatMs) return
    this.heartbeatAt.set(task.task_id, Date.now())
    this.outbox.enqueue({
      dedupeKey: `task:${task.task_id}:heartbeat:${Math.floor(Date.now() / 300_000)}`,
      taskId: task.task_id,
      conversationId: task.conversation_id,
      kind: "STATUS",
      text: `⏳ 仍在执行（${task.task_id}，已用时 ${Math.round(elapsed / 1000)}s）`,
    })
  }

  /**
   * Show the native macOS approval dialog, at most once per 3 minutes per
   * approval so a dismissed dialog does not spam the desktop.
   */
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
      timeoutSeconds: Math.floor(this.config.bridge.approvalTimeoutMs / 1000),
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
      await this.adapter.reply(message, text)
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
          if (type === "session.inbox.enqueued") {
            const item = data.item as { payload?: { metadata?: { source?: string } } } | undefined
            const source = item?.payload?.metadata?.source
            if (source && source !== "dingtalk") {
              this.flagHumanIntervention(String(data.sessionID ?? ""))
            }
          }
          if (
            type === "session.execution.succeeded" ||
            type === "session.execution.failed" ||
            type === "session.idle"
          ) {
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

  private async loop(): Promise<void> {
    let tick = 0
    while (this.running) {
      try {
        await this.outbox.tick()
        await this.schedule()
        if (tick % 2 === 0) await this.reconcile()
        if (tick % 5 === 0) await this.expireApprovals()
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

async function main() {
  const config = loadConfig()
  const secret = await readClientSecret()
  const db = openDatabase(config.bridge.dataDir)
  log.info("bridge.booting", { dataDir: config.bridge.dataDir })

  const bridge = new Bridge(config, db, secret)
  await bridge.start()

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void bridge.stop().then(() => process.exit(0))
    })
  }
}

main().catch((error) => {
  log.error("bridge.fatal", { error: (error as Error).message })
  process.exit(1)
})
