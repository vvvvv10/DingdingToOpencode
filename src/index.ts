/**
 * Bridge entry point.
 *
 * The process is a single instance (design §11.4): the lock file prevents two
 * bridges from competing for the same tasks. Nothing listens on an inbound
 * port — the only outbound connections are the DingTalk Stream WSS and the
 * local OpenCode HTTP API.
 */
import "./polyfills.js"
import { main } from "./runtime.js"

main().catch((error) => {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      event: "bridge.fatal",
      error: (error as Error).message,
    }),
  )
  process.exit(1)
})
