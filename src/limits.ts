import type { Db } from "./store/db.js"
import { queuedTaskCount, userTaskCountSince } from "./store/tasks.js"

export type AdmissionDecision =
  | { ok: true }
  | { ok: false; code: "RATE_LIMITED" | "QUEUE_FULL"; message: string }

/**
 * Admission control for a new task (design §6.3 step 8, §11.3).
 *
 * - per session queue depth: `maxQueuePerSession` (pending tasks)
 * - per user hourly quota: `maxTasksPerUserPerHour`
 */
export function checkAdmission(
  db: Db,
  opts: {
    conversationId: string
    senderStaffId: string
    maxQueuePerSession: number
    maxTasksPerUserPerHour: number
    now?: number
  },
): AdmissionDecision {
  const now = opts.now ?? Date.now()

  const used = userTaskCountSince(db, opts.senderStaffId, now - 60 * 60_000)
  if (used >= opts.maxTasksPerUserPerHour) {
    return {
      ok: false,
      code: "RATE_LIMITED",
      message: `请求过于频繁：你最近一小时内已提交 ${used} 个任务（上限 ${opts.maxTasksPerUserPerHour}）。`,
    }
  }

  const depth = queuedTaskCount(db, opts.conversationId)
  if (depth >= opts.maxQueuePerSession) {
    return {
      ok: false,
      code: "QUEUE_FULL",
      message: `排队已满：当前会话已有 ${depth} 个任务在排队（上限 ${opts.maxQueuePerSession}）。`,
    }
  }

  return { ok: true }
}
