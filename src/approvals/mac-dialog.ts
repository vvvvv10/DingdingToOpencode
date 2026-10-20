import { spawn } from "node:child_process"
import type { Logger } from "../logger.js"

export type MacDialogChoice = "approve" | "reject" | "ignored"

const SCRIPT_LINES = [
  "on run argv",
  "set theMsg to item 1 of argv",
  'display dialog theMsg with title "OpenCode 任务审批" buttons {"拒绝", "允许一次"} default button "允许一次" with icon caution giving up after 600',
  "end run",
]

/**
 * Show a native macOS approval dialog.
 *
 * Runs detached so the bridge loop is never blocked. The dialog closes itself
 * after `timeoutSeconds`; the DingTalk approval then falls back to its own
 * timeout. Requires a GUI session (LaunchAgent runs in the user's session).
 */
export function showApprovalDialog(opts: {
  title: string
  detail: string
  timeoutSeconds?: number
  log: Logger
  onDecision: (choice: MacDialogChoice) => void
}): void {
  const timeout = opts.timeoutSeconds ?? 600
  const script = SCRIPT_LINES.map((line) =>
    line.includes("giving up after 600") ? line.replace("giving up after 600", `giving up after ${timeout}`) : line,
  )
  const message = `${opts.title}\n\n${opts.detail}`

  const args: string[] = []
  for (const line of script) args.push("-e", line)
  args.push(message)

  const child = spawn("/usr/bin/osascript", args, {
    stdio: ["ignore", "pipe", "pipe"],
  })

  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  child.on("error", (error) => {
    opts.log.warn("macdialog.error", { error: error.message })
    opts.onDecision("ignored")
  })
  child.on("close", (code) => {
    if (code !== 0) {
      // -128 = user closed the dialog or it timed out
      opts.log.info("macdialog.dismissed", { code, stderr: stderr.slice(0, 120) })
      opts.onDecision("ignored")
      return
    }
    const choice = stdout.includes("允许一次") ? "approve" : stdout.includes("拒绝") ? "reject" : "ignored"
    opts.log.info("macdialog.decision", { choice })
    opts.onDecision(choice)
  })
}
