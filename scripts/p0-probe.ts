/**
 * P0 probe: proves both halves of the bridge work against the real machine.
 *
 *   1. discover + authenticate the local OpenCode service (no service is started)
 *   2. check the API contract (required routes present)
 *   3. create a session, submit a prompt, wait for the turn via the message timeline
 *   4. print the resulting timeline
 *   5. connect to the DingTalk Stream and wait for one real robot message
 *
 * Usage: npm run probe -- [--no-prompt] [--dingtalk-seconds 300]
 */
import "../src/polyfills.js"
import { loadConfig } from "../src/config.js"
import { readClientSecret } from "../src/credentials.js"
import { createLogger } from "../src/logger.js"
import { connectOpenCode } from "../src/opencode/client.js"
import { fetchTimeline, waitForTurn } from "../src/opencode/timeline.js"
import { DingTalkAdapter, type DingTalkInbound } from "../src/dingtalk/adapter.js"

const log = createLogger({ scope: "p0" })

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = Number.parseInt(process.argv[index + 1] ?? "", 10)
  return Number.isFinite(value) ? value : fallback
}

const hasFlag = (name: string) => process.argv.includes(`--${name}`)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const stamp = () => new Date().toISOString().slice(11, 19)

function step(title: string) {
  console.log(`\n\x1b[1m▶ ${title}\x1b[0m`)
}

async function main() {
  step("1/5 加载配置与凭证")
  const config = loadConfig()
  const secret = await readClientSecret()
  const project = config.projects[0]!
  console.log(`   clientId/robotCode : ${config.dingtalk.clientId}`)
  console.log(`   secret             : 已从 Keychain 读取 (长度 ${secret.length})`)
  console.log(`   project            : ${project.alias} → ${project.directory}`)

  step("2/5 发现 OpenCode 服务（不会启动新服务）")
  const connection = await connectOpenCode({
    versionRange: config.opencode.versionRange,
    requiredRoutes: config.opencode.requiredRoutes,
    log,
  })
  console.log(`   url                : ${connection.url}`)
  console.log(`   version            : ${connection.version}`)
  console.log(`   contract           : ${config.opencode.requiredRoutes.length} routes OK`)

  step("3/5 创建 session")
  const session = await connection.client.session.create({
    location: { directory: project.directory },
    title: `P0 probe ${new Date().toISOString()}`,
    agent: project.agent,
    metadata: { source: "dingtalk-bridge", probe: "p0" },
  })
  console.log(`   sessionID          : ${session.id}`)
  console.log(`   在 TUI 中可用 /sessions 打开该 session 观察`)

  let userMessageId: string | undefined
  if (!hasFlag("no-prompt")) {
    const inbox = await connection.client.session.prompt({
      sessionID: session.id,
      text: "这是一次 P0 探针自检任务。请只回复一行：PONG。不要调用任何工具。",
      delivery: "queue",
      metadata: { source: "dingtalk", probe: "p0" },
    })
    userMessageId = inbox.id
    console.log(`   userMessageId      : ${inbox.id}`)
    console.log(`   delivery           : ${inbox.delivery}`)
  } else {
    console.log("   --no-prompt        : 跳过任务提交")
  }

  if (userMessageId) {
    step("4/5 等待回合结束（消息时间线判定）")
    const turn = await waitForTurn(connection.client, session.id, userMessageId, {
      timeoutMs: 180_000,
      onTick: ({ elapsedMs, timelineSize }) =>
        process.stdout.write(`\r   [${stamp()}] 等待中 ${Math.round(elapsedMs / 1000)}s (timeline ${timelineSize})   `),
    })
    process.stdout.write("\r")
    if (turn) {
      console.log(`   outcome            : ${turn.outcome}`)
      console.log(`   assistant messages : ${turn.assistantMessageIds.length}`)
      console.log(`   result             : ${turn.text.slice(0, 200) || "<empty>"}`)
    } else {
      console.log("   ⏱  超时：未观察到 idle 回合标记")
    }

    const timeline = await fetchTimeline(connection.client, session.id)
    console.log("   timeline:")
    for (const message of timeline) {
      const text =
        message.type === "assistant"
          ? (message.content ?? [])
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("")
          : (message.text ?? "")
      console.log(
        `     ${message.id} ${message.type}${message.outcome ? ` outcome=${message.outcome}` : ""} :: ${text.slice(0, 90)}`,
      )
    }
  }

  step("5/5 钉钉 Stream 回环")
  const dingtalkSeconds = arg("dingtalk-seconds", 300)
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
  console.log("   已连接。请在钉钉里 @机器人 发一条消息（单聊直接发）。")
  console.log(`   等待 ${dingtalkSeconds}s ...`)
  const deadline = Date.now() + dingtalkSeconds * 1000
  while (!received && Date.now() < deadline) {
    await sleep(1000)
  }

  if (received) {
    console.log("   ✅ 收到消息")
    console.log(`      msgId             : ${received.msgId}`)
    console.log(`      conversationId    : ${received.conversationId}`)
    console.log(`      conversationType  : ${received.conversationType}`)
    console.log(`      conversationTitle : ${received.conversationTitle ?? "-"}`)
    console.log(`      senderStaffId    : ${received.senderStaffId || "<空：外部成员>"}`)
    console.log(`      senderNick       : ${received.senderNick}`)
    console.log(`      isInAtList       : ${received.isInAtList}`)
    console.log(`      text             : ${received.text}`)
    await adapter.reply(received, "P0 探针收到 ✅")
    console.log("   已通过 sessionWebhook 回复")
  } else {
    console.log("   ⚠️  超时：没有收到钉钉消息")
  }
  adapter.disconnect()

  console.log(`\n\x1b[1mP0 探针结束\x1b[0m`)
  process.exit(0)
}

main().catch((error) => {
  console.error(`\n\x1b[31m探针失败: ${(error as Error).message}\x1b[0m`)
  if ((error as { reason?: string }).reason) {
    console.error(`   reason: ${(error as { reason?: string }).reason}`)
  }
  process.exit(1)
})
