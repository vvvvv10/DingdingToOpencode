export type LogLevel = "debug" | "info" | "warn" | "error"

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Keys whose values must never reach a log sink. */
const REDACT_KEY = /secret|token|authorization|password|webhook|cookie|credential/i

const MAX_STRING = 300

export type LogFields = Record<string, unknown>

export type Logger = {
  debug: (event: string, fields?: LogFields) => void
  info: (event: string, fields?: LogFields) => void
  warn: (event: string, fields?: LogFields) => void
  error: (event: string, fields?: LogFields) => void
}

export function createLogger(opts: { level?: LogLevel; scope?: string } = {}): Logger {
  const min = LEVEL_ORDER[opts.level ?? "info"]

  function emit(level: LogLevel, event: string, fields: LogFields = {}) {
    if (LEVEL_ORDER[level] < min) return
    const payload: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      event,
    }
    if (opts.scope) payload.scope = opts.scope
    for (const [key, value] of Object.entries(fields)) {
      if (REDACT_KEY.test(key)) {
        payload[key] = "[redacted]"
        continue
      }
      if (typeof value === "string" && value.length > MAX_STRING) {
        payload[key] = `${value.slice(0, MAX_STRING)}…(+${value.length - MAX_STRING})`
        continue
      }
      payload[key] = value
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`)
  }

  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  }
}
