/** Throwaway probe: prompt id idempotency + timeline paging semantics. */
import "../src/polyfills.js"
import { loadConfig } from "../src/config.js"
import { connectOpenCode } from "../src/opencode/client.js"
import { createLogger } from "../src/logger.js"

const log = createLogger({ scope: "probe" })
const config = loadConfig()
const project = config.projects[0]!
const connection = await connectOpenCode({
  versionRange: config.opencode.versionRange,
  requiredRoutes: config.opencode.requiredRoutes,
  log,
})

const session = await connection.client.session.create({
  location: { directory: project.directory },
  title: "probe-idem",
  agent: project.agent,
  metadata: { source: "dingtalk-bridge", probe: "idem" },
})
console.log("session", session.id)

const myId = "msg_bridge_probe_fixed_id"
const inbox = await connection.client.session.prompt({
  sessionID: session.id,
  id: myId,
  text: "只回复 PONG。不要调用工具。",
  delivery: "queue",
  metadata: { source: "dingtalk", probe: "idem" },
})
console.log("prompt response id:", inbox.id, "delivered:", inbox.delivery)

// same id again -> idempotent?
try {
  const again = await connection.client.session.prompt({
    sessionID: session.id,
    id: myId,
    text: "只回复 PONG。不要调用工具。",
    delivery: "queue",
    metadata: { source: "dingtalk", probe: "idem" },
  })
  console.log("re-prompt response id:", again.id)
} catch (error) {
  console.log("re-prompt error:", (error as Error).message)
}

await new Promise((r) => setTimeout(r, 15000))

const list = await connection.client.message.list({
  sessionID: session.id,
  order: "asc",
  limit: 50,
})
console.log("timeline cursor:", JSON.stringify(list.cursor))
for (const m of list.data as any[]) {
  console.log(
    `  ${m.id} ${m.type}${m.outcome ? ` outcome=${m.outcome}` : ""} :: ${JSON.stringify(m.content ?? m.text ?? "").slice(0, 80)}`,
  )
}
console.log("anchor present:", (list.data as any[]).some((m) => m.id === myId))

// paging: does order=asc + limit return the FIRST n or the LAST n?
const paged = await connection.client.message.list({
  sessionID: session.id,
  order: "asc",
  limit: 1,
})
console.log("limit=1 asc ->", (paged.data as any[]).map((m) => `${m.id}:${m.type}`))
process.exit(0)
