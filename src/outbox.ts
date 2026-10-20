import { randomUUID } from "node:crypto"
import type { Db } from "./store/db.js"
import type { Logger } from "./logger.js"

export type OutboxKind = "STATUS" | "APPROVAL" | "RESULT" | "ERROR"

export type OutboxItem = {
  outbox_id: string
  dedupe_key: string
  task_id: string | null
  conversation_id: string
  kind: OutboxKind
  payload: string
  status: string
  attempts: number
  next_attempt_at: number
  created_at: number
  sent_at: number | null
}

export type OutboxDelivery = (item: OutboxItem, text: string) => Promise<boolean>

const MAX_ATTEMPTS = 8

export class Outbox {
  constructor(
    private readonly db: Db,
    private readonly deliver: OutboxDelivery,
    private readonly log: Logger,
  ) {}

  enqueue(input: {
    dedupeKey: string
    taskId?: string
    conversationId: string
    kind: OutboxKind
    text: string
  }): void {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO outbox
           (outbox_id, dedupe_key, task_id, conversation_id, kind, payload, status, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.dedupeKey,
        input.taskId ?? null,
        input.conversationId,
        input.kind,
        JSON.stringify({ text: input.text }),
        Date.now(),
        Date.now(),
      )
    if (result.changes > 0) {
      this.log.debug("outbox.enqueued", { kind: input.kind, taskId: input.taskId })
    }
  }

  pendingCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM outbox WHERE status IN ('PENDING', 'SENDING')")
      .get() as { count: number }
    return row.count
  }

  async tick(): Promise<void> {
    const now = Date.now()
    const items = this.db
      .prepare(
        `SELECT * FROM outbox
         WHERE status = 'PENDING' AND next_attempt_at <= ?
         ORDER BY created_at ASC LIMIT 10`,
      )
      .all(now) as OutboxItem[]

    for (const item of items) {
      const claimed = this.db
        .prepare("UPDATE outbox SET status = 'SENDING' WHERE outbox_id = ? AND status = 'PENDING'")
        .run(item.outbox_id)
      if (claimed.changes === 0) continue

      let text = ""
      try {
        text = (JSON.parse(item.payload) as { text?: string }).text ?? ""
      } catch {
        text = ""
      }

      try {
        const ok = await this.deliver(item, text)
        if (ok) {
          this.db
            .prepare("UPDATE outbox SET status = 'SENT', sent_at = ?, attempts = attempts + 1 WHERE outbox_id = ?")
            .run(Date.now(), item.outbox_id)
          this.log.info("outbox.sent", { kind: item.kind, taskId: item.task_id })
          continue
        }
        this.fail(item, "delivery returned false")
      } catch (error) {
        this.fail(item, (error as Error).message)
      }
    }
  }

  private fail(item: OutboxItem, reason: string): void {
    const attempts = item.attempts + 1
    if (attempts >= MAX_ATTEMPTS) {
      this.db
        .prepare("UPDATE outbox SET status = 'FAILED', attempts = ? WHERE outbox_id = ?")
        .run(attempts, item.outbox_id)
      this.log.error("outbox.dead", { kind: item.kind, taskId: item.task_id, reason })
      return
    }
    const backoff = Math.min(30 * 60_000, 60_000 * 2 ** (attempts - 1))
    this.db
      .prepare(
        "UPDATE outbox SET status = 'PENDING', attempts = ?, next_attempt_at = ? WHERE outbox_id = ?",
      )
      .run(attempts, Date.now() + backoff, item.outbox_id)
    this.log.warn("outbox.retry", {
      kind: item.kind,
      taskId: item.task_id,
      attempts,
      reason,
    })
  }
}
