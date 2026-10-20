/** Throwaway probe #2: cursor paging semantics. */
import "../src/polyfills.js"
import { loadConfig } from "../src/config.js"
import { connectOpenCode } from "../src/opencode/client.js"
import { createLogger } from "../src/logger.js"

const log = createLogger({ scope: "probe2" })
const config = loadConfig()
const project = config.projects[0]!
const connection = await connectOpenCode({
  versionRange: config.opencode.versionRange,
  requiredRoutes: config.opencode.requiredRoutes,
  log,
})
const client = connection.client

// reuse the session created by probe #1
const sessions = await client.session.list({})
const session = (sessions.data as any[]).find((s) => s.title === "probe-idem")
console.log("session", session.id)

const asc1 = await client.message.list({ sessionID: session.id, order: "asc", limit: 1 })
console.log("asc limit1:", (asc1.data as any[]).map((m) => m.id))
console.log("cursor:", JSON.stringify(asc1.cursor))

const asc2 = await client.message.list({
  sessionID: session.id,
  limit: 10,
  cursor: asc1.cursor.next!,
})
console.log("asc page2:", (asc2.data as any[]).map((m) => `${m.id}:${m.type}`))

const desc = await client.message.list({ sessionID: session.id, order: "desc", limit: 2 })
console.log("desc limit2:", (desc.data as any[]).map((m) => `${m.id}:${m.type}`))
console.log("desc cursor:", JSON.stringify(desc.cursor))

// cursor.previous from the desc page should walk back to older messages
if (desc.cursor.previous) {
  const older = await client.message.list({
    sessionID: session.id,
    limit: 10,
    cursor: desc.cursor.previous,
  })
  console.log("desc older:", (older.data as any[]).map((m) => `${m.id}:${m.type}`))
}
process.exit(0)
