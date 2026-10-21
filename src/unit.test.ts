import { strict as assert } from "node:assert"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "./config.js"
import { openDatabase } from "./store/db.js"
import {
  acquireProjectLock,
  activeTasks,
  createTask,
  getTask,
  newApprovalId,
  pendingTasks,
  recordInbound,
  releaseProjectLock,
  renewProjectLock,
  sessionTask,
  updateTask,
} from "./store/tasks.js"
import { resolvePermissions } from "./permissions.js"
import { extractTurn } from "./opencode/timeline.js"
import { Outbox } from "./outbox.js"
import { createLogger } from "./logger.js"
import { satisfiesRange } from "./opencode/client.js"

const log = createLogger({ level: "error" })

export const tests = [
  {
    name: "config: 目录不存在时 fail closed",
    fn: () => {
      const dir = mkdtempSync(join(tmpdir(), "cfg-"))
      const file = join(dir, "config.json")
      writeFileSync(
        file,
        JSON.stringify({
          dingtalk: { clientId: "x", robotCode: "x" },
          opencode: {},
          bridge: { dataDir: dir },
          projects: [{ alias: "p", directory: "/definitely/not/here" }],
        }),
      )
      assert.throws(() => loadConfig(file), /directory does not exist/)
    },
  },
  {
    name: "config: 重复 alias 被拒绝",
    fn: () => {
      const dir = mkdtempSync(join(tmpdir(), "cfg-"))
      const file = join(dir, "config.json")
      writeFileSync(
        file,
        JSON.stringify({
          dingtalk: { clientId: "x", robotCode: "x" },
          opencode: {},
          bridge: { dataDir: dir },
          projects: [
            { alias: "p", directory: dir },
            { alias: "p", directory: dir },
          ],
        }),
      )
      assert.throws(() => loadConfig(file), /duplicate project alias/)
    },
  },
  {
    name: "config: taskMode 默认 prefix",
    fn: () => {
      const dir = mkdtempSync(join(tmpdir(), "cfg-"))
      const file = join(dir, "config.json")
      writeFileSync(
        file,
        JSON.stringify({
          dingtalk: { clientId: "x", robotCode: "x" },
          opencode: {},
          bridge: { dataDir: dir },
          projects: [{ alias: "p", directory: dir }],
        }),
      )
      const config = loadConfig(file)
      assert.equal(config.bridge.taskMode, "prefix")
      assert.equal(config.bridge.askEnabled, true)
    },
  },
  {
    name: "permissions: default 预设只 deny question/subagent",
    fn: () => {
      const rules = resolvePermissions({
        alias: "p",
        directory: "/tmp",
        agent: "dingtalk",
        permissionPreset: "default",
        allowedConversations: [],
        allowedUsers: [],
        approvers: [],
        permissions: [],
      })
      assert.deepEqual(
        rules.map((r) => r.action).sort(),
        ["question", "subagent"],
      )
      assert.ok(rules.every((r) => r.effect === "deny"))
    },
  },
  {
    name: "permissions: strict 预设对 shell 提问",
    fn: () => {
      const rules = resolvePermissions({
        alias: "p",
        directory: "/tmp",
        agent: "dingtalk",
        permissionPreset: "strict",
        allowedConversations: [],
        allowedUsers: [],
        approvers: [],
        permissions: [],
      })
      const shell = rules.find((r) => r.action === "shell")
      assert.equal(shell?.effect, "ask")
    },
  },
  {
    name: "tasks: msgId 去重",
    fn: () => {
      const db = openDatabase(mkdtempSync(join(tmpdir(), "db-")))
      assert.equal(recordInbound(db, "m1", "ACCEPTED"), "ACCEPTED")
      assert.equal(recordInbound(db, "m1", "ACCEPTED"), "DUPLICATE")
    },
  },
  {
    name: "tasks: 状态迁移与 session 占用",
    fn: () => {
      const db = openDatabase(mkdtempSync(join(tmpdir(), "db-")))
      const task = createTask(db, {
        taskId: "T1",
        msgId: "m1",
        conversationId: "c1",
        senderStaffId: "u1",
        projectAlias: "p",
        promptText: "hello",
      })
      assert.equal(task.status, "PENDING")
      assert.equal(pendingTasks(db).length, 1)
      updateTask(db, "T1", { status: "RUNNING", session_id: "s1" })
      assert.equal(getTask(db, "T1")?.status, "RUNNING")
      assert.equal(sessionTask(db, "s1")?.task_id, "T1")
      assert.equal(activeTasks(db).length, 1)
    },
  },
  {
    name: "tasks: 项目锁互斥 + 释放后重获",
    fn: () => {
      const db = openDatabase(mkdtempSync(join(tmpdir(), "db-")))
      assert.equal(acquireProjectLock(db, "p", "T1", 111), true)
      assert.equal(acquireProjectLock(db, "p", "T2", 222), false)
      renewProjectLock(db, "p", "T1")
      releaseProjectLock(db, "p", "T1")
      assert.equal(acquireProjectLock(db, "p", "T2", 222), true)
    },
  },
  {
    name: "tasks: 审批短码稳定且无歧义字符",
    fn: () => {
      const a = newApprovalId("req-1")
      const b = newApprovalId("req-2")
      assert.equal(a, newApprovalId("req-1"))
      assert.equal(a.length, 6)
      assert.notEqual(a, b)
      assert.match(a, /^[A-Z2-9]{6}$/)
    },
  },
  {
    name: "timeline: 回合以带 outcome 的 idle 结束",
    fn: () => {
      const turn = extractTurn(
        [
          { id: "u1", type: "user", text: "hi" },
          { id: "a1", type: "assistant", content: [{ type: "text", text: "hello" }] },
          { id: "i1", type: "idle", outcome: "succeeded" },
        ],
        "u1",
      )
      assert.equal(turn?.outcome, "succeeded")
      assert.equal(turn?.text, "hello")
    },
  },
  {
    name: "timeline: 没有 idle 标记则不算完成",
    fn: () => {
      const turn = extractTurn(
        [
          { id: "u1", type: "user", text: "hi" },
          { id: "a1", type: "assistant", content: [{ type: "text", text: "working" }] },
        ],
        "u1",
      )
      assert.equal(turn, undefined)
    },
  },
  {
    name: "timeline: 无 outcome 的 idle 不会提前结束回合",
    fn: () => {
      const turn = extractTurn(
        [
          { id: "u1", type: "user", text: "hi" },
          { id: "i0", type: "idle" },
          { id: "a1", type: "assistant", content: [{ type: "text", text: "done" }] },
          { id: "i1", type: "idle", outcome: "succeeded" },
        ],
        "u1",
      )
      assert.equal(turn?.outcome, "succeeded")
      assert.equal(turn?.text, "done")
    },
  },
  {
    name: "outbox: dedupe_key 防止重复入队",
    fn: () => {
      const db = openDatabase(mkdtempSync(join(tmpdir(), "db-")))
      const outbox = new Outbox(db, async () => true, log)
      outbox.enqueue({ dedupeKey: "k1", conversationId: "c1", kind: "STATUS", text: "a" })
      outbox.enqueue({ dedupeKey: "k1", conversationId: "c1", kind: "STATUS", text: "a" })
      const rows = db.prepare("SELECT COUNT(*) AS c FROM outbox").get() as { c: number }
      assert.equal(rows.c, 1)
    },
  },
  {
    name: "outbox: 发送失败进入退避重试",
    fn: () => {
      const db = openDatabase(mkdtempSync(join(tmpdir(), "db-")))
      const outbox = new Outbox(db, async () => false, log)
      outbox.enqueue({ dedupeKey: "k1", conversationId: "c1", kind: "STATUS", text: "a" })
      return outbox.tick().then(() => {
        const row = db.prepare("SELECT status, attempts FROM outbox").get() as {
          status: string
          attempts: number
        }
        assert.equal(row.status, "PENDING")
        assert.equal(row.attempts, 1)
      })
    },
  },
  {
    name: "version: 版本区间判定",
    fn: () => {
      assert.equal(satisfiesRange("2.0.18", ">=2.0.18 <2.1.0"), true)
      assert.equal(satisfiesRange("2.1.0", ">=2.0.18 <2.1.0"), false)
      assert.equal(satisfiesRange("2.0.9", ">=2.0.18 <2.1.0"), false)
    },
  },
]
