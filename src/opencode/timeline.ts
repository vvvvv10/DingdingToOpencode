import type { OpenCode } from "@opencode/client"

export type TimelineMessage = {
  id: string
  type: string
  time?: { created?: number; completed?: number; streamed?: number }
  text?: string
  outcome?: string
  content?: Array<{ type: string; text?: string }>
}

export type TurnOutcome = "succeeded" | "failed" | "interrupted" | "unknown"

export type TurnResult = {
  outcome: TurnOutcome
  text: string
  assistantMessageIds: string[]
  idleMessageId?: string
}

/**
 * What is known about a turn at a point in time.
 *
 * `started` means the agent produced output for the task; `idleMessageId`
 * means the turn reached its terminator and `outcome` is the verdict.
 */
export type TurnWindow = {
  found: boolean
  started: boolean
  text: string
  parts: Array<{ messageId: string; text: string }>
  assistantMessageIds: string[]
  idleMessageId?: string
  outcome?: TurnOutcome
}

type Client = ReturnType<typeof OpenCode.make>

/**
 * The message timeline is the durable, authoritative view of a session.
 *
 * Shape (asc order), one entry per turn:
 *   user      :: the task prompt
 *   assistant :: content[].text
 *   idle      :: outcome = succeeded | failed | interrupted
 *
 * The `idle` marker is the turn terminator and the only reliable completion
 * signal: OpenCode 2.0.18 does not replay business events from
 * GET /api/experimental/session/{id}/log, and the global event stream is
 * live-only.
 */
export async function fetchTimeline(
  client: Client,
  sessionID: string,
  limit = 200,
): Promise<TimelineMessage[]> {
  const response = await client.message.list({ sessionID, order: "asc", limit })
  return (response.data ?? []) as TimelineMessage[]
}

/**
 * Extract the turn anchored at `userMessageId` from an ascending window.
 *
 * Only an `idle` message that carries an `outcome` terminates the turn; an
 * outcome-less idle is ignored so that a stray marker cannot end a task
 * early.
 */
export function extractTurn(
  timeline: TimelineMessage[],
  userMessageId: string,
): TurnResult | undefined {
  const summary = summarizeTurn(timeline, userMessageId)
  if (!summary.idleMessageId || !summary.outcome) return undefined
  return {
    outcome: summary.outcome,
    text: summary.text,
    assistantMessageIds: summary.assistantMessageIds,
    idleMessageId: summary.idleMessageId,
  }
}

function normalizeOutcome(value: string | undefined): TurnOutcome {
  if (value === "succeeded" || value === "failed" || value === "interrupted") return value
  return "unknown"
}

/**
 * Find the turn anchored at `anchorId`, paging through the timeline.
 *
 * `GET /api/session/{id}/message?order=asc&limit=N` returns the *oldest* N
 * messages, so a long-lived session would push the anchor out of the window
 * and the task would never be resolved. The lookup therefore starts from the
 * newest page (`order=desc`) and walks backwards with the cursor until the
 * anchor shows up.
 *
 * Note: the API rejects `cursor` combined with `order` ("Cursor cannot be
 * combined with order"), so the cursor carries the direction on its own.
 */
export async function fetchTurnWindow(
  client: Client,
  sessionID: string,
  anchorId: string,
  options: { limit?: number; maxPages?: number } = {},
): Promise<TurnWindow> {
  const limit = options.limit ?? 200
  const maxPages = options.maxPages ?? 10

  const pages: TimelineMessage[][] = []
  let cursor: string | undefined

  for (let page = 0; page < maxPages; page += 1) {
    const response = cursor
      ? await client.message.list({ sessionID, limit, cursor })
      : await client.message.list({ sessionID, limit, order: "desc" })
    const data = (response.data ?? []) as TimelineMessage[]
    pages.push(data)

    const all = pages.flat()
    const index = all.findIndex((message) => message.id === anchorId)
    if (index !== -1) {
      // `all` is newest-first; keep the messages that are newer than the
      // anchor and flip them into ascending order.
      const window = all.slice(0, index + 1).reverse()
      return summarizeTurn(window, anchorId)
    }

    const previous = response.cursor?.previous
    if (!previous) break
    cursor = previous
  }

  return { found: false, started: false, text: "", parts: [], assistantMessageIds: [] }
}

/** Collect everything known about the turn anchored at `userMessageId`. */
export function summarizeTurn(
  timeline: TimelineMessage[],
  userMessageId: string,
): TurnWindow {
  const start = timeline.findIndex((message) => message.id === userMessageId)
  if (start === -1) return { found: false, started: false, text: "", parts: [], assistantMessageIds: [] }

  const parts: Array<{ messageId: string; text: string }> = []
  const assistantMessageIds: string[] = []
  let idleMessageId: string | undefined
  let outcome: TurnOutcome | undefined

  for (const message of timeline.slice(start + 1)) {
    if (message.type === "idle" && message.outcome) {
      idleMessageId = message.id
      outcome = normalizeOutcome(message.outcome)
      break
    }
    if (message.type === "assistant") {
      assistantMessageIds.push(message.id)
      const chunks: string[] = []
      for (const part of message.content ?? []) {
        if (part.type === "text" && part.text) chunks.push(part.text)
      }
      if (chunks.length > 0) parts.push({ messageId: message.id, text: chunks.join("\n\n") })
    }
  }

  return {
    found: true,
    started: assistantMessageIds.length > 0,
    text: parts.map((part) => part.text).join("\n\n").trim(),
    parts,
    assistantMessageIds,
    idleMessageId,
    outcome,
  }
}

export async function fetchTurn(
  client: Client,
  sessionID: string,
  anchorId: string,
  options: { limit?: number; maxPages?: number } = {},
): Promise<TurnResult | undefined> {
  const window = await fetchTurnWindow(client, sessionID, anchorId, options)
  if (!window.idleMessageId || !window.outcome) return undefined
  return {
    outcome: window.outcome,
    text: window.text,
    assistantMessageIds: window.assistantMessageIds,
    idleMessageId: window.idleMessageId,
  }
}

export type WaitOptions = {
  timeoutMs?: number
  pollIntervalMs?: number
  signal?: AbortSignal
  onTick?: (info: { elapsedMs: number; timelineSize: number }) => void
}

/**
 * Block until the turn anchored at `userMessageId` is finished.
 *
 * Uses POST /api/experimental/session/{id}/wait as a long poll, but never
 * trusts its return value on its own: the session may still be idle before
 * the agent loop starts, so the verdict always comes from the timeline.
 */
export async function waitForTurn(
  client: Client,
  sessionID: string,
  userMessageId: string,
  options: WaitOptions = {},
): Promise<TurnResult | undefined> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000
  const pollIntervalMs = options.pollIntervalMs ?? 2_000
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    if (options.signal?.aborted) return undefined

    const turn = await fetchTurn(client, sessionID, userMessageId)
    options.onTick?.({ elapsedMs: Date.now() - started, timelineSize: 0 })
    if (turn) return turn

    // Long poll until the agent loop goes idle (or the wait budget expires).
    const waitBudget = Math.max(1_000, Math.min(15_000, timeoutMs - (Date.now() - started)))
    try {
      await client.session.wait(
        { sessionID },
        { signal: AbortSignal.timeout(waitBudget) },
      )
    } catch {
      // 503 / abort / transport error: fall through to a plain interval wait.
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }
  }

  return undefined
}
