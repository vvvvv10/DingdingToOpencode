/**
 * Offline end-to-end test for the /ask path (no DingTalk involved).
 *
 * Injects a fake reply channel and a fake sender, then drives the bridge the
 * same way the runtime does: handleMessage -> schedule -> reconcile -> outbox.
 *
 *   npx tsx scripts/test-ask.ts
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
const headers = Service.headers(endpoint)!
const client = OpenCode.make({ baseUrl: endpoint.url, headers })

const dataDir = mkdtempSync(join(tmpdir(), "bridge-ask-test-"))
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
    console.log(`  [reply] ${text.slice(0, 160).replace(/\n/g, " | ")}`)
  },
  sender: {
    async send(_target: unknown, text: string) {
      sent.push(text)
      return true
    },
  } as never,
})

const project = config.projects[0]!
const message: DingTalkInbound = {
  msgId: `test-ask-${Date.now()}`,
  conversationId: project.allowedConversations[0]!,
  conversationType: "2",
  senderStaffId: project.allowedUsers[0]!,
  senderNick: "tester",
  msgtype: "text",
  text: "/ask 用一句话说明 tms-web 这个项目是做什么的",
  isInAtList: true,
  sessionWebhook: "https://example.invalid/webhook",
  sessionWebhookExpiredTime: Date.now() + 600_000,
  atUsers: [],
}

console.log(`▶ 发送：${message.text}\n`)
await bridge.handleMessage(message)

// Drive the pipeline like the runtime loop does.
const internals = bridge as unknown as {
  schedule: () => Promise<void>
  reconcile: () => Promise<void>
  outbox: { tick: () => Promise<void> }
}

const deadline = Date.now() + 180_000
while (Date.now() < deadline) {
  await internals.outbox.tick()
  await internals.schedule()
  await internals.reconcile()
  const done = db
    .prepare("SELECT status, outcome, result_summary FROM tasks ORDER BY created_at DESC LIMIT 1")
    .get() as { status: string; outcome: string | null; result_summary: string | null }
  if (done.status === "SUCCEEDED" || done.status === "FAILED" || done.status === "INTERRUPTED") {
    console.log(`\n▶ 任务终态：${done.status} / ${done.outcome}`)
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 2000))
}

console.log(`\n▶ 收到 ${replies.length} 条回复，outbox 发出 ${sent.length} 条`)
console.log("▶ 最终结果：")
console.log(
  (
    db.prepare("SELECT result_summary FROM tasks ORDER BY created_at DESC LIMIT 1").get() as {
      result_summary: string | null
    }
  ).result_summary?.slice(0, 500) ?? "<none>",
)
process.exit(0)
