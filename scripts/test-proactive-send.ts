/**
 * Verify the OpenAPI proactive-send fallback (used when the session webhook
 * has expired). Sends one real message to the group.
 *
 *   npx tsx scripts/test-proactive-send.ts
 */
import "../src/polyfills.js"
import { loadConfig } from "../src/config.js"
import { readClientSecret } from "../src/credentials.js"
import { createLogger } from "../src/logger.js"
import { DingTalkSenderImpl } from "../src/dingtalk/send.js"

const config = loadConfig()
const secret = await readClientSecret()
const log = createLogger({ scope: "proactive" })

const sender = new DingTalkSenderImpl({
  clientId: config.dingtalk.clientId,
  clientSecret: secret,
  robotCode: config.dingtalk.robotCode,
  log,
})

const conversationId = process.argv[2] ?? config.projects[0]!.allowedConversations[0]!
const text = process.argv[3] ?? "（测试）OpenCode 桥接 · 主动发送通道验证"

console.log(`→ 群 ${conversationId}`)

// 1) sessionWebhook 路径（正常回复）
const viaWebhook = await sender.sendViaWebhook(
  {
    conversationId,
    conversationType: "2",
    senderStaffId: "",
    webhook: "https://invalid.example/webhook",
  },
  text,
)
console.log(`  sessionWebhook（故意给无效地址）: ${viaWebhook ? "sent" : "未发送（预期）"}`)

// 2) OpenAPI 主动发送（webhook 过期后的兜底）
const viaApi = await sender.sendProactive(
  { conversationId, conversationType: "2", senderStaffId: "" },
  text,
)
console.log(`  OpenAPI 主动发送: ${viaApi ? "✅ 成功" : "❌ 失败"}`)
process.exit(viaApi ? 0 : 1)
