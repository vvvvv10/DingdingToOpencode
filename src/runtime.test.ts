import { strict as assert } from "node:assert"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Bridge } from "./runtime.js"
import { openDatabase } from "./store/db.js"
import type { BridgeConfig } from "./config.js"
import type { DingTalkInbound } from "./dingtalk/adapter.js"

const CONVERSATION = "cid-test"
const USER = "user-1"

function makeConfig(dir: string): BridgeConfig {
  return {
    dingtalk: { clientId: "c", robotCode: "r" },
    opencode: {
      versionRange: ">=2.0.18 <2.1.0",
      autoStartService: false,
      requiredRoutes: [],
    },
    bridge: {
      dataDir: dir,
      approvalTimeoutMs: 600_000,
      maxTaskDurationMs: 7_200_000,
      maxPromptChars: 8000,
      maxResultChars: 3500,
      maxQueuePerSession: 10,
      maxTasksPerUserPerHour: 20,
      heartbeatMs: 300_000,
      approvalChannel: "group",
      taskMode: "prefix",
      askEnabled: true,
      notifyOtherSessions: false,
      notifyConversations: [],
      notifyMinIntervalMs: 60_000,
      logLevel: "error",
    },
    projects: [
      {
        alias: "test",
        directory: dir,
        agent: "dingtalk",
        permissionPreset: "default",
        allowedConversations: [CONVERSATION],
        allowedUsers: [USER],
        approvers: [USER],
        permissions: [],
      },
    ],
  } as BridgeConfig
}

/** Minimal fake of the OpenCode client: enough for the admission path. */
function makeClient() {
  return {
    session: {
      create: async () => ({
        id: "ses_test",
        projectID: "p",
        title: "t",
        agent: "dingtalk",
        cost: 0,
        tokens: {},
        time: { created: Date.now(), updated: Date.now() },
        location: { directory: "/tmp" },
      }),
      prompt: async () => ({
        id: "msg_test",
        sessionID: "ses_test",
        time: { created: Date.now() },
        type: "user",
        payload: { text: "x" },
        delivery: "queue",
      }),
      list: async () => ({ data: [], cursor: {} }),
      get: async () => ({
        id: "ses_test",
        title: "other session",
        agent: "build",
        location: { directory: "/tmp" },
        time: { created: Date.now(), updated: Date.now() },
      }),
      active: async () => ({}),
      inbox: { list: async () => [], cancel: async () => {} },
      interrupt: async () => ({ interrupted: false }),
      update: async () => {},
    },
    message: { list: async () => ({ data: [], cursor: {} }) },
    permission: { list: async () => [] },
  } as never
}

function makeMessage(text: string, id: string): DingTalkInbound {
  return {
    msgId: id,
    conversationId: CONVERSATION,
    conversationType: "2",
    senderStaffId: USER,
    senderNick: "tester",
    msgtype: "text",
    text,
    isInAtList: true,
    atUsers: [],
  }
}

async function run(
  text: string,
  id: string,
): Promise<{ replies: string[]; taskRows: Array<{ kind: string; status: string }> }> {
  const dir = mkdtempSync(join(tmpdir(), "bridge-intent-"))
  const db = openDatabase(dir)
  const replies: string[] = []
  const bridge = new Bridge({
    config: makeConfig(dir),
    db,
    secret: "test",
    client: makeClient(),
    reply: async (_message, replyText) => {
      replies.push(replyText)
    },
  })
  await bridge.handleMessage(makeMessage(text, id))
  const taskRows = db
    .prepare("SELECT kind, status FROM tasks ORDER BY created_at ASC")
    .all() as Array<{ kind: string; status: string }>
  return { replies, taskRows }
}

export const tests = [
  {
    name: "意图分流: 闲聊不建任务，只回本地状态",
    fn: async () => {
      const { replies, taskRows } = await run("你在干啥", "m-chat")
      assert.equal(taskRows.length, 0, "闲聊不应建任务")
      assert.equal(replies.length, 1)
      assert.match(replies[0]!, /桥接待命/)
    },
  },
  {
    name: "意图分流: /task 建任务并提交",
    fn: async () => {
      const { taskRows } = await run("/task 看看目录结构", "m-task")
      assert.equal(taskRows.length, 1)
      assert.equal(taskRows[0]!.kind, "task")
      assert.equal(taskRows[0]!.status, "SUBMITTED")
    },
  },
  {
    name: "意图分流: /ask 建只读任务",
    fn: async () => {
      const { taskRows } = await run("/ask 这个项目做什么的", "m-ask")
      assert.equal(taskRows.length, 1)
      assert.equal(taskRows[0]!.kind, "ask")
    },
  },
  {
    name: "意图分流: 重复 msgId 不重复建任务",
    fn: async () => {
      const dir = mkdtempSync(join(tmpdir(), "bridge-intent-"))
      const db = openDatabase(dir)
      const bridge = new Bridge({
        config: makeConfig(dir),
        db,
        secret: "test",
        client: makeClient(),
        reply: async () => {},
      })
      await bridge.handleMessage(makeMessage("/task 同一个任务", "m-dup"))
      await bridge.handleMessage(makeMessage("/task 同一个任务", "m-dup"))
      const rows = db.prepare("SELECT COUNT(*) AS c FROM tasks").get() as { c: number }
      assert.equal(rows.c, 1, "重复消息只应建一个任务")
    },
  },
]
