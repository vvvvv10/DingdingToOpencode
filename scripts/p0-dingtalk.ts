/**
 * DingTalk-only probe: waits for a real robot message and prints every field
 * the bridge relies on (plus a sessionWebhook reply).
 *
 * Usage: npm run probe:dingtalk [-- --seconds 600]
 */
import { loadConfig } from "../src/config.js"
import { readClientSecret } from "../src/credentials.js"
import { createLogger } from "../src/logger.js"
import { DingTalkAdapter, type DingTalkInbound } from "../src/dingtalk/adapter.js"

const log = createLogger({ scope: "probe:dingtalk" })

const index = process.argv.indexOf("--seconds")
const seconds = Number.parseInt(process.argv[index + 1] ?? "", 10) || 600
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const config = loadConfig()
  const secret = await readClientSecret()

  let received: DingTalkInbound | undefined
  const adapter = new DingTalkAdapter({
    clientId: config.dingtalk.clientId,
    clientSecret: secret,
    robotCode: config.dingtalk.robotCode,
    log,
    onMessage: (message) => {
      received = message
    },
  })

  await adapter.connect()
  console.log(`\n\x1b[1m钉钉 Stream 已连接\x1b[0m  (clientId=${config.dingtalk.clientId})`)
  console.log(`请在钉钉里 @机器人 发一条消息（单聊直接发）。等待 ${seconds}s ...\n`)

  const deadline = Date.now() + seconds * 1000
  while (!received && Date.now() < deadline) {
    await sleep(1000)
  }

  if (!received) {
    console.log("⚠️  超时：没有收到钉钉消息")
    adapter.disconnect()
    process.exit(2)
  }

  console.log("\x1b[1m✅ 收到消息\x1b[0m")
  console.log(`   msgId             : ${received.msgId}`)
  console.log(`   conversationId    : ${received.conversationId}`)
  console.log(`   conversationType  : ${received.conversationType}`)
  console.log(`   conversationTitle : ${received.conversationTitle ?? "-"}`)
  console.log(`   senderStaffId    : ${received.senderStaffId || "<空：外部成员>"}`)
  console.log(`   senderNick       : ${received.senderNick}`)
  console.log(`   isInAtList       : ${received.isInAtList}`)
  console.log(`   msgtype          : ${received.msgtype}`)
  console.log(`   atUsers          : ${received.atUsers.join(", ") || "-"}`)
  console.log(`   text             : ${received.text}`)
  console.log(`   webhookExpiresAt : ${received.sessionWebhookExpiredTime ?? "-"}`)
  console.log(`   hasWebhook       : ${Boolean(received.sessionWebhook)}`)

  await adapter.reply(received, "钉钉回环测试成功 ✅")
  console.log("\n已通过 sessionWebhook 回复。")
  adapter.disconnect()
  process.exit(0)
}

main().catch((error) => {
  console.error(`\n\x1b[31m失败: ${(error as Error).message}\x1b[0m`)
  process.exit(1)
})
