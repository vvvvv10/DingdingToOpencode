import type { Db } from "./db.js"

/** Retention windows from design §9.3. */
export const RETENTION = {
  inboundMessagesMs: 7 * 24 * 60 * 60_000,
  tasksMs: 30 * 24 * 60 * 60_000,
  auditLogMs: 90 * 24 * 60 * 60_000,
  outboxMs: 14 * 24 * 60 * 60_000,
} as const

export type RetentionResult = {
  inboundMessages: number
  tasks: number
  taskMessages: number
  auditLog: number
  outbox: number
}

const TERMINAL = "('SUCCEEDED', 'FAILED', 'INTERRUPTED', 'CANCELLED', 'UNKNOWN')"

/**
 * Delete data that fell out of its retention window.
 *
 * Only terminal tasks are removed: a task that is still queued or running
 * keeps its rows even when they are older than the window.
 */
export function applyRetention(db: Db, now = Date.now()): RetentionResult {
  const inbound = db
    .prepare("DELETE FROM inbound_messages WHERE received_at < ?")
    .run(now - RETENTION.inboundMessagesMs).changes

  const taskMessages = db
    .prepare(
      `DELETE FROM task_messages
       WHERE task_id IN (
         SELECT task_id FROM tasks
         WHERE status IN ${TERMINAL} AND finished_at IS NOT NULL AND finished_at < ?
       )`,
    )
    .run(now - RETENTION.tasksMs).changes

  const tasks = db
    .prepare(
      `DELETE FROM tasks
       WHERE status IN ${TERMINAL} AND finished_at IS NOT NULL AND finished_at < ?`,
    )
    .run(now - RETENTION.tasksMs).changes

  const auditLog = db
    .prepare("DELETE FROM audit_log WHERE ts < ?")
    .run(now - RETENTION.auditLogMs).changes

  const outbox = db
    .prepare("DELETE FROM outbox WHERE status IN ('SENT', 'FAILED') AND created_at < ?")
    .run(now - RETENTION.outboxMs).changes

  return { inboundMessages: inbound, tasks, taskMessages, auditLog, outbox }
}
