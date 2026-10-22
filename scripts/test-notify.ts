/**
 * Live check of the "other sessions finished" notification.
 *
 * Picks the most recently updated session the bridge does NOT own and sends
 * one real notification to the configured group.
 *
 *   npx tsx scripts/test-notify.ts
 */
import "../src/polyfills.js"
import { Service } from "@opencode/client/service"
import { loadConfig } from "../src/config.js"
import { readClientSecret } from "../src/credentials.js"
import { createLogger } from "../src/logger.js"
import { openDatabase } from "../src/store/db.js"
import { SessionNotifier } from "../src/notify.js"
import { DingTalkSenderImpl } from "../src/dingtalk/send.js"

const config = loadConfig()
const secret = await readClientSecret()
const log = createLogger({ scope: "notify-test" })

const endpoint = await Service.discover()
if (!endpoint) throw new Error("OpenCode service not running")
const headers = Service.headers(endpoint)
if (!headers) throw new Error("no service credentials")
const { OpenCode } = await import("@opencode/client")
const client = OpenCode.make({ baseUrl: endpoint.url, headers })

const db = openDatabase(config.bridge.dataDir)
const conversationId = config.projects[0]!.allowedConversations[0]!

const sender = new DingTalkSenderImpl({
  clientId: config.dingtalk.clientId,
  clientSecret: secret,
  robotCode: config.dingtalk.robotCode,
  log,
})

const sent: string[] = []
const notifier = new SessionNotifier({
  client,
  db,
  log,
  conversations: [conversationId],
  minIntervalMs: 0,
  deliver: ({ text }) => {
    sent.push(text)
  },
})

// Pick a session the bridge does not own.
const list = await client.session.list({ limit: 20, order: "desc" })
const owned = new Set<string>()
for (const row of db.prepare("SELECT session_id FROM sessions").all() as Array<{ session_id: string }>) {
  owned.add(row.session_id)
}
for (const row of db.prepare("SELECT session_id FROM chat_sessions").all() as Array<{ session_id: string }>) {
  owned.add(row.session_id)
}
const candidates = (list.data ?? []).filter((session) => !owned.has(session.id))
console.log(`非桥接 session 共 ${candidates.length} 个，候选：`)
for (const session of candidates.slice(0, 5)) {
  console.log(`  ${session.id}  ${session.title}  [${session.location?.directory}]`)
}

const target = candidates[0]
if (!target) {
  console.log("没有可通知的 session")
  process.exit(0)
}

console.log(`\n→ 通知：${target.title}\n`)
await notifier.notifyFinished(target.id, "succeeded")

if (sent.length === 0) {
  console.log("❌ 没有生成通知")
  process.exit(1)
}
console.log(sent[0])
console.log("\n→ 发送到群", conversationId)
const ok = await sender.sendProactive(
  { conversationId, conversationType: "2", senderStaffId: "" },
  sent[0]!,
)
console.log(ok ? "✅ 已发送" : "❌ 发送失败")
process.exit(ok ? 0 : 1)
