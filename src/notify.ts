import type { OpenCode } from "@opencode/client"
import type { Logger } from "./logger.js"
import type { Db } from "./store/db.js"

type Client = ReturnType<typeof OpenCode.make>

export type NotifyOutcome = "succeeded" | "failed" | "interrupted"

export type NotifyOptions = {
  client: Client
  db: Db
  log: Logger
  /** Where to send (conversation ids). Empty list = no notifications. */
  conversations: string[]
  /** Minimum seconds between two notifications for the same session. */
  minIntervalMs: number
  /** Called with the final message text; the caller enqueues it in the outbox. */
  deliver: (input: { dedupeKey: string; conversationId: string; text: string }) => void
}

/**
 * Notifications for sessions the bridge does not own.
 *
 * The user may be running several OpenCode sessions in parallel (other TUI
 * tabs, other projects). This notifies on DingTalk when one of them finishes,
 * so nothing has to be watched in the terminal.
 */
export class SessionNotifier {
  private lastNotified = new Map<string, number>()

  constructor(private readonly opts: NotifyOptions) {}

  /**
   * True when the session belongs to the bridge (its own task session or a
   * chat session) — those are reported through the task pipeline instead.
   */
  private isBridgeOwned(sessionId: string): boolean {
    const owned = this.opts.db
      .prepare("SELECT 1 FROM sessions WHERE session_id = ? UNION SELECT 1 FROM chat_sessions WHERE session_id = ?")
      .get(sessionId, sessionId)
    return owned !== undefined
  }

  /**
   * Notify that a session finished.
   *
   * The dedupe key is derived from the session's idle timestamp, so the
   * event-driven path and the periodic sweep collapse into one message.
   */
  async notifyFinished(sessionId: string, outcome: NotifyOutcome): Promise<void> {
    if (this.opts.conversations.length === 0) return
    if (this.isBridgeOwned(sessionId)) return

    const now = Date.now()
    const last = this.lastNotified.get(sessionId) ?? 0
    if (now - last < this.opts.minIntervalMs) return

    let session: Awaited<ReturnType<Client["session"]["get"]>> | undefined
    try {
      session = await this.opts.client.session.get({ sessionID: sessionId })
    } catch (error) {
      this.opts.log.warn("notify.session.get.failed", {
        sessionId,
        error: (error as Error).message,
      })
      return
    }
    if (!session) return

    // Sessions the bridge created carry its source marker, even when they were
    // made by another bridge instance (or a test with its own database).
    const source = (session as { metadata?: { source?: string } }).metadata?.source
    if (source === "dingtalk-bridge") return

    const idle = session.time?.idle
    const marker = idle ?? now
    const key = `notify:${sessionId}:${marker}`

    // Already queued? (the sweep and the event may both see it). The key must
    // match the one the outbox will store, otherwise the check never hits.
    const targets = this.opts.conversations
      .map((conversationId) => ({
        conversationId,
        dedupeKey: `${key}:${conversationId}`,
      }))
      .filter(
        (target) =>
          this.opts.db.prepare("SELECT 1 FROM outbox WHERE dedupe_key = ?").get(target.dedupeKey) ===
          undefined,
      )
    if (targets.length === 0) return

    const text = await this.format(session, outcome)
    if (!text) return

    this.lastNotified.set(sessionId, now)
    for (const target of targets) {
      this.opts.deliver({ dedupeKey: target.dedupeKey, conversationId: target.conversationId, text })
    }
    this.opts.log.info("notify.session.finished", { sessionId, outcome })
  }

  /**
   * Sweep for sessions that finished while the event stream was down.
   *
   * The global event stream is live-only, so a disconnect loses completions.
   * The sweep looks at recently updated sessions and relies on the idle
   * timestamp as the completion marker.
   */
  async sweep(lookbackMs = 10 * 60_000): Promise<void> {
    if (this.opts.conversations.length === 0) return
    let sessions: Array<{ id: string; time?: { idle?: number } }>
    try {
      const list = await this.opts.client.session.list({ limit: 20, order: "desc" })
      sessions = (list.data ?? []) as Array<{ id: string; time?: { idle?: number } }>
    } catch (error) {
      this.opts.log.warn("notify.sweep.failed", { error: (error as Error).message })
      return
    }

    const cutoff = Date.now() - lookbackMs
    for (const session of sessions) {
      const idle = session.time?.idle
      if (!idle || idle < cutoff) continue
      const outcome = await this.outcomeOf(session.id)
      if (!outcome) continue
      await this.notifyFinished(session.id, outcome)
    }
  }

  /** A session is "finished" when it is idle and not actively running. */
  private async outcomeOf(sessionId: string): Promise<NotifyOutcome | undefined> {
    try {
      const active = await this.opts.client.session.active()
      if (active[sessionId]) return undefined
      const session = await this.opts.client.session.get({ sessionID: sessionId })
      if (!session.time?.idle) return undefined
      const outcome = session.outcome
      if (outcome === "succeeded" || outcome === "failed" || outcome === "interrupted") {
        return outcome
      }
      return "succeeded"
    } catch {
      return undefined
    }
  }

  private async format(
    session: {
      id: string
      title?: string
      agent?: string
      location?: { directory?: string }
      time?: { updated?: number; idle?: number }
      outcome?: string
    },
    outcome: NotifyOutcome,
  ): Promise<string | undefined> {
    const icon = outcome === "succeeded" ? "✅" : outcome === "failed" ? "❌" : "🚫"
    const label =
      outcome === "succeeded" ? "完成" : outcome === "failed" ? "失败" : "被中断"

    let summary = ""
    try {
      const messages = await this.opts.client.message.list({
        sessionID: session.id,
        order: "desc",
        limit: 3,
      })
      const parts: string[] = []
      for (const message of messages.data ?? []) {
        if (message.type !== "assistant") continue
        for (const part of message.content ?? []) {
          if (part.type === "text" && part.text) parts.push(part.text)
        }
        if (parts.length > 0) break
      }
      summary = parts.join(" ").replace(/\s+/g, " ").slice(0, 300)
    } catch {
      summary = ""
    }

    const lines = [
      `${icon} OpenCode session ${label}`,
      `· 任务：${session.title ?? "(无标题)"}`,
      `· 目录：${session.location?.directory ?? "?"}`,
      `· agent：${session.agent ?? "?"}`,
    ]
    if (summary) lines.push(`· 摘要：${summary}`)
    return lines.join("\n")
  }
}
