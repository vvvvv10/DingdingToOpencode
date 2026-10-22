import { strict as assert } from "node:assert"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionNotifier } from "./notify.js"
import { openDatabase } from "./store/db.js"
import { createLogger } from "./logger.js"

const log = createLogger({ level: "error" })

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    session: {
      get: async () => ({
        id: "ses_other",
        title: "别的任务",
        agent: "build",
        location: { directory: "/tmp/project" },
        time: { created: 1, updated: 2, idle: 1_700_000_000_000 },
        outcome: "succeeded",
      }),
      list: async () => ({ data: [], cursor: {} }),
      active: async () => ({}),
    },
    message: {
      list: async () => ({
        data: [
          {
            id: "a1",
            type: "assistant",
            content: [{ type: "text", text: "干完了，收工" }],
          },
        ],
        cursor: {},
      }),
    },
    ...overrides,
  } as never
}

export const tests = [
  {
    name: "notify: 非桥接 session 会生成通知并投递",
    fn: async () => {
      const db = openDatabase(mkdtempSync(join(tmpdir(), "db-")))
      const sent: string[] = []
      const notifier = new SessionNotifier({
        client: fakeClient(),
        db,
        log,
        conversations: ["c1"],
        minIntervalMs: 0,
        deliver: ({ text }) => {
          sent.push(text)
        },
      })
      await notifier.notifyFinished("ses_other", "succeeded")
      assert.equal(sent.length, 1)
      assert.match(sent[0]!, /别的任务/)
      assert.match(sent[0]!, /干完了，收工/)
    },
  },
  {
    name: "notify: 桥接自己的 session 不通知",
    fn: async () => {
      const db = openDatabase(mkdtempSync(join(tmpdir(), "db-")))
      db.prepare(
        "INSERT INTO sessions (session_id, conversation_id, project_alias, control_mode, created_at) VALUES ('ses_own', 'c', 'p', 'BRIDGE', 1)",
      ).run()
      const sent: string[] = []
      const notifier = new SessionNotifier({
        client: fakeClient(),
        db,
        log,
        conversations: ["c1"],
        minIntervalMs: 0,
        deliver: ({ text }) => {
          sent.push(text)
        },
      })
      await notifier.notifyFinished("ses_own", "succeeded")
      assert.equal(sent.length, 0, "桥接自己的 session 不该走通知通道")
    },
  },
  {
    name: "notify: 同一 session 的同一次完成只通知一次",
    fn: async () => {
      const db = openDatabase(mkdtempSync(join(tmpdir(), "db-")))
      const sent: string[] = []
      const notifier = new SessionNotifier({
        client: fakeClient(),
        db,
        log,
        conversations: ["c1"],
        minIntervalMs: 0,
        deliver: ({ text, dedupeKey }) => {
          sent.push(text)
          // 模拟 outbox 入队（去重键唯一）
          db.prepare(
            "INSERT OR IGNORE INTO outbox (outbox_id, dedupe_key, conversation_id, kind, payload, status, attempts, next_attempt_at, created_at) VALUES ('id', ?, 'c1', 'STATUS', '{}', 'PENDING', 0, 0, 0)",
          ).run(dedupeKey)
        },
      })
      await notifier.notifyFinished("ses_other", "succeeded")
      // 第二次：dedupe 键已存在 → 不再投递
      const second = new SessionNotifier({
        client: fakeClient(),
        db,
        log,
        conversations: ["c1"],
        minIntervalMs: 0,
        deliver: () => {
          sent.push("dup")
        },
      })
      await second.notifyFinished("ses_other", "succeeded")
      assert.equal(sent.length, 1, "重复完成不应重复通知")
    },
  },
  {
    name: "notify: 没有配置目标会话时不通知",
    fn: async () => {
      const db = openDatabase(mkdtempSync(join(tmpdir(), "db-")))
      const sent: string[] = []
      const notifier = new SessionNotifier({
        client: fakeClient(),
        db,
        log,
        conversations: [],
        minIntervalMs: 0,
        deliver: ({ text }) => {
          sent.push(text)
        },
      })
      await notifier.notifyFinished("ses_other", "succeeded")
      assert.equal(sent.length, 0)
    },
  },
]
