import { createHash } from "node:crypto"
import type { Db } from "./db.js"

export type TaskStatus =
  | "RECEIVED"
  | "PENDING"
  | "SUBMITTED"
  | "RUNNING"
  | "WAITING_APPROVAL"
  | "SUCCEEDED"
  | "FAILED"
  | "INTERRUPTED"
  | "CANCELLED"
  | "HUMAN_INTERVENED"
  | "UNKNOWN"

export type Task = {
  task_id: string
  msg_id: string
  conversation_id: string
  sender_staff_id: string
  project_alias: string
  session_id: string | null
  inbox_id: string | null
  opencode_message_id: string | null
  approval_id: string | null
  prompt_text: string | null
  /** "task" = executable task, "ask" = read-only question. */
  kind: "task" | "ask"
  status: TaskStatus
  outcome: string | null
  error_code: string | null
  error_message: string | null
  result_summary: string | null
  human_intervened: number
  created_at: number
  submitted_at: number | null
  started_at: number | null
  finished_at: number | null
}

export type InboundStatus = "ACCEPTED" | "REJECTED" | "DUPLICATE"

export function newTaskId(): string {
  // ULID-ish: time prefix + randomness, sortable and collision-safe enough.
  const stamp = Date.now().toString(36).padStart(9, "0").toUpperCase()
  const random = Math.random().toString(36).slice(2, 8).toUpperCase()
  return `T${stamp}${random}`
}

export function newApprovalId(requestID: string): string {
  const digest = createHash("sha1").update(requestID).digest("hex")
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  let out = ""
  for (let index = 0; index < 6; index += 1) {
    out += alphabet[Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16) % alphabet.length]
  }
  return out
}

/** Returns "ACCEPTED" | "DUPLICATE" | "REJECTED". */
export function recordInbound(
  db: Db,
  msgId: string,
  status: InboundStatus,
  reason?: string,
): InboundStatus {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO inbound_messages (msg_id, received_at, status, reason, processed_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
  const result = insert.run(msgId, Date.now(), status, reason ?? null, Date.now())
  if (result.changes === 0) return "DUPLICATE"
  return status
}

/** Mark an already recorded inbound message as rejected (keeps the dedupe row). */
export function markInboundRejected(db: Db, msgId: string, reason: string): void {
  db.prepare("UPDATE inbound_messages SET status = 'REJECTED', reason = ? WHERE msg_id = ?").run(
    reason,
    msgId,
  )
}

export function createTask(
  db: Db,
  input: {
    taskId: string
    msgId: string
    conversationId: string
    senderStaffId: string
    projectAlias: string
    promptText: string
    kind?: "task" | "ask"
  },
): Task {
  db.prepare(
    `INSERT INTO tasks (task_id, msg_id, conversation_id, sender_staff_id, project_alias,
                        prompt_text, kind, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
  ).run(
    input.taskId,
    input.msgId,
    input.conversationId,
    input.senderStaffId,
    input.projectAlias,
    input.promptText,
    input.kind ?? "task",
    Date.now(),
  )
  return getTask(db, input.taskId)!
}

export function getTask(db: Db, taskId: string): Task | undefined {
  return db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as Task | undefined
}

export function getTaskByMsgId(db: Db, msgId: string): Task | undefined {
  return db.prepare("SELECT * FROM tasks WHERE msg_id = ?").get(msgId) as Task | undefined
}

export function updateTask(db: Db, taskId: string, patch: Partial<Task>): void {
  const keys = Object.keys(patch) as Array<keyof Task>
  if (keys.length === 0) return
  const assignments = keys.map((key) => `${key} = ?`).join(", ")
  const values = keys.map((key) => patch[key] as unknown)
  db.prepare(`UPDATE tasks SET ${assignments} WHERE task_id = ?`).run(...values, taskId)
}

export function activeTasks(db: Db): Task[] {
  return db
    .prepare(
      `SELECT * FROM tasks
       WHERE status IN ('PENDING', 'SUBMITTED', 'RUNNING', 'WAITING_APPROVAL')
       ORDER BY created_at ASC`,
    )
    .all() as Task[]
}

export function pendingTasks(db: Db): Task[] {
  return db
    .prepare("SELECT * FROM tasks WHERE status = 'PENDING' ORDER BY created_at ASC")
    .all() as Task[]
}

/** The single task that is currently occupying a session. */
export function sessionTask(db: Db, sessionId: string): Task | undefined {
  return db
    .prepare(
      `SELECT * FROM tasks
       WHERE session_id = ? AND status IN ('SUBMITTED', 'RUNNING', 'WAITING_APPROVAL')
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(sessionId) as Task | undefined
}

/** Tasks waiting in the bridge admission queue for a conversation. */
export function queuedTaskCount(db: Db, conversationId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM tasks WHERE conversation_id = ? AND status = 'PENDING'")
    .get(conversationId) as { count: number }
  return row.count
}

/** Number of tasks a user started inside the given window (quota). */
export function userTaskCountSince(db: Db, senderStaffId: string, since: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM tasks WHERE sender_staff_id = ? AND created_at >= ?")
    .get(senderStaffId, since) as { count: number }
  return row.count
}

/** Running tasks that exceeded the configured maximum task duration. */
export function overdueTasks(db: Db, maxDurationMs: number, now = Date.now()): Task[] {
  return db
    .prepare(
      `SELECT * FROM tasks
       WHERE status IN ('SUBMITTED', 'RUNNING', 'WAITING_APPROVAL')
         AND COALESCE(started_at, submitted_at, created_at) < ?`,
    )
    .all(now - maxDurationMs) as Task[]
}

export function appendTaskText(
  db: Db,
  taskId: string,
  messageId: string,
  ordinal: number,
  text: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO task_messages (task_id, message_id, ordinal, kind, text, created_at)
     VALUES (?, ?, ?, 'assistant_text', ?, ?)`,
  ).run(taskId, messageId, ordinal, text, Date.now())
}

export function taskTexts(db: Db, taskId: string): string[] {
  return (
    db
      .prepare(
        "SELECT text FROM task_messages WHERE task_id = ? ORDER BY created_at ASC, ordinal ASC",
      )
      .all(taskId) as Array<{ text: string }>
  ).map((row) => row.text)
}

// ---------------------------------------------------------------- project lock

export function acquireProjectLock(
  db: Db,
  projectAlias: string,
  taskId: string,
  ownerPid: number,
  leaseMs = 90_000,
): boolean {
  const now = Date.now()
  const result = db
    .prepare(
      `INSERT INTO project_locks (project_alias, task_id, owner_pid, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_alias) DO UPDATE SET
         task_id = excluded.task_id,
         owner_pid = excluded.owner_pid,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at
       WHERE project_locks.expires_at < ?`,
    )
    .run(projectAlias, taskId, ownerPid, now + leaseMs, now, now)
  return result.changes > 0
}

export function releaseProjectLock(db: Db, projectAlias: string, taskId: string): void {
  db.prepare("DELETE FROM project_locks WHERE project_alias = ? AND task_id = ?").run(
    projectAlias,
    taskId,
  )
}

export function renewProjectLock(db: Db, projectAlias: string, taskId: string, leaseMs = 90_000) {
  db.prepare(
    "UPDATE project_locks SET expires_at = ?, updated_at = ? WHERE project_alias = ? AND task_id = ?",
  ).run(Date.now() + leaseMs, Date.now(), projectAlias, taskId)
}

export function clearExpiredLocks(db: Db): void {
  db.prepare("DELETE FROM project_locks WHERE expires_at < ?").run(Date.now())
}
