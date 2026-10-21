/**
 * Offline end-to-end test for the /task path (no DingTalk involved).
 *
 * Verifies that a task lands in a session whose location is the *configured
 * project directory* — the regression that a rebound conversation would
 * otherwise keep pointing at the previous project's session.
 *
 *   npx tsx scripts/test-task.ts
 */
import "../src/polyfills.js"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config.js"
import { openDatabase } from "../src/store/db.js"
import { Bridge } from "../src/runtime.js"
import type { DingTalkInbound } from "../src/dingtalk/adapter.js"

const config = loadConfig()
const endpoint = await Service.discover()
if (!endpoint) throw new Error("OpenCode service not running")
const headers = Service.headers(endpoint)
if (!headers) throw new Error("no service credentials")
const client = OpenCode.make({ baseUrl: endpoint.url, headers })

const dataDir = mkdtempSync(join(tmpdir(), "bridge-task-test-"))
const db = openDatabase(dataDir)

const replies: string[] = []
const sent: string[] = []

const bridge = new Bridge({
  config,
  db,
  secret: "test",
  client,
  reply: async (_message: DingTalkInbound, text: string) => {
    replies.push(text)
    console.log(`  [reply] ${text.slice(0, 140).replace(/\n/g, " | ")}`)
  },
  sender: { async send(_t: unknown, text: string) { sent.push(text); return true } } as never,
})

const project = config.projects[0]!
const message: DingTalkInbound = {
  msgId: `test-task-${Date.now()}`,
  conversationId: project.allowedConversations[0]!,
  conversationType: "2",
  senderStaffId: project.allowedUsers[0]!,
  senderNick: "tester",
  msgtype: "text",
  text: "/task 只读地看一下这个项目根目录有哪些文件，不要修改任何文件",
  isInAtList: true,
  sessionWebhook: "https://example.invalid/webhook",
  sessionWebhookExpiredTime: Date.now() + 600_000,
  atUsers: [],
}

console.log(`▶ 发送：${message.text}\n`)
await bridge.handleMessage(message)

const internals = bridge as unknown as {
  schedule: () => Promise<void>
  reconcile: () => Promise<void>
  outbox: { tick: () => Promise<void> }
}

const deadline = Date.now() + 240_000
let done: { status: string; outcome: string | null; session_id: string | null } | undefined
while (Date.now() < deadline) {
  await internals.outbox.tick()
  await internals.schedule()
  await internals.reconcile()
  done = db
    .prepare(
      "SELECT status, outcome, session_id FROM tasks WHERE kind='task' ORDER BY created_at DESC LIMIT 1",
    )
    .get() as typeof done
  if (done && ["SUCCEEDED", "FAILED", "INTERRUPTED"].includes(done.status)) break
  await new Promise((resolve) => setTimeout(resolve, 2000))
}

console.log(`\n▶ 任务终态：${done?.status} / ${done?.outcome}  session=${done?.session_id}`)

// The session must live in the configured project directory.
const session = done?.session_id
  ? await client.session.get({ sessionID: done.session_id })
  : undefined
const directory = session?.location?.directory
console.log(`▶ session 目录：${directory}`)
console.log(
  directory === project.directory
    ? `✅ 目录正确（${project.directory}）`
    : `❌ 目录错误！期望 ${project.directory}`,
)
console.log(`▶ outbox 发出 ${sent.length} 条`)
process.exit(0)
