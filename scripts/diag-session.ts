/**
 * Session diagnostics: documents what OpenCode 2.0.18 actually exposes.
 *
 *   A-6  GET /api/experimental/session/{id}/log   (durable log)
 *   A-7  GET /api/event                          (global event stream)
 *   A-8  GET /api/session/{id}/message           (message timeline)
 *   A-9  POST /api/experimental/session/{id}/wait (idle long poll)
 *
 * Run: npm run diag
 */
import "../src/polyfills.js"
import { Service } from "@opencode/client/service"

const endpoint = await Service.discover()
if (!endpoint) throw new Error("no OpenCode service found")
const headers = Service.headers(endpoint)!
const base = endpoint.url

const created = (await fetch(new URL("/api/session", base), {
  method: "POST",
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify({
    location: { directory: process.cwd() },
    title: "diag",
    agent: "dingtalk",
  }),
}).then((r) => r.json())) as { data: { id: string } }
const sessionID = created.data.id
console.log("session", sessionID)

await fetch(new URL(`/api/session/${sessionID}/prompt`, base), {
  method: "POST",
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify({ text: "只回复 PONG。", delivery: "queue" }),
})
await new Promise((resolve) => setTimeout(resolve, 12000))

console.log("\n=== A-6  per-session durable log ===")
for (const after of [0, 1, 2, 5, 10]) {
  const url = new URL(`/api/experimental/session/${sessionID}/log`, base)
  url.searchParams.set("after", String(after))
  const text = await fetch(url, { headers: { ...headers, accept: "text/event-stream" } }).then((r) =>
    r.text(),
  )
  const events = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as { type: string; seq?: number })
  console.log(
    `  after=${String(after).padStart(2)} -> ${events.length} event(s): ` +
      (events.map((event) => `${event.type}@${event.seq ?? "-"}`).join(", ") || "(none)"),
  )
}

console.log("\n=== A-8  message timeline (authoritative) ===")
const messages = (await fetch(
  new URL(`/api/session/${sessionID}/message?order=asc&limit=50`, base),
  { headers },
).then((r) => r.json())) as { data: Array<Record<string, any>> }
for (const message of messages.data ?? []) {
  const text =
    message.type === "assistant"
      ? (message.content ?? [])
          .filter((part: { type: string }) => part.type === "text")
          .map((part: { text: string }) => part.text)
          .join("")
      : (message.text ?? "")
  console.log(
    `  ${message.id} ${message.type}${message.outcome ? ` outcome=${message.outcome}` : ""} :: ${String(text).slice(0, 80)}`,
  )
}

console.log("\n=== A-9  /wait (idle long poll) ===")
for (const label of ["idle", "after-prompt"]) {
  if (label === "after-prompt") {
    await fetch(new URL(`/api/session/${sessionID}/prompt`, base), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ text: "再回复一次 PONG。", delivery: "queue" }),
    })
  }
  const started = Date.now()
  const response = await fetch(new URL(`/api/experimental/session/${sessionID}/wait`, base), {
    method: "POST",
    headers,
  })
  console.log(`  ${label}: status=${response.status} waited=${Date.now() - started}ms`)
}

console.log("\n=== A-7  global event stream (live) ===")
const global = await fetch(new URL("/api/event", base), {
  headers: { ...headers, accept: "text/event-stream" },
})
const reader = global.body!.getReader()
const decoder = new TextDecoder()
void (async () => {
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      for (const line of decoder.decode(value, { stream: true }).split("\n")) {
        if (!line.startsWith("data: ")) continue
        const event = JSON.parse(line.slice(6)) as { type: string; data?: { sessionID?: string } }
        if (event.data?.sessionID === sessionID) console.log(`  ${event.type}`)
      }
    }
  } catch {
    /* closed */
  }
})()
await new Promise((resolve) => setTimeout(resolve, 15000))
process.exit(0)
