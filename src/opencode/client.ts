import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import type { Logger } from "../logger.js"

export type OpenCodeConnection = {
  client: ReturnType<typeof OpenCode.make>
  url: string
  version: string
  pid: number
}

export class OpenCodeUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: "not_running" | "unauthorized" | "version_mismatch" | "contract",
  ) {
    super(message)
    this.name = "OpenCodeUnavailableError"
  }
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === "127.0.0.1" || host === "::1" || host === "localhost"
  } catch {
    return false
  }
}

function parseVersion(value: string): number[] {
  const core = value.split("-")[0] ?? "0"
  return core.split(".").map((part) => Number.parseInt(part, 10) || 0)
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

/** Supports the `>=x.y.z <a.b.c` style used in the bridge config. */
export function satisfiesRange(version: string, range: string): boolean {
  const clauses = range.split(/\s+/).filter(Boolean)
  for (const clause of clauses) {
    const match = /^(>=|<=|>|<|=)?\s*(\d+(?:\.\d+)*)$/.exec(clause)
    if (!match) throw new Error(`Unsupported version clause: ${clause}`)
    const op = match[1] ?? "="
    const target = match[2] ?? ""
    if (!target) throw new Error(`Unsupported version clause: ${clause}`)
    const cmp = compareVersions(version, target)
    if (op === ">=" && cmp < 0) return false
    if (op === ">" && cmp <= 0) return false
    if (op === "<=" && cmp > 0) return false
    if (op === "<" && cmp >= 0) return false
    if (op === "=" && cmp !== 0) return false
  }
  return true
}

/**
 * Discover the shared local OpenCode service and authenticate against it.
 *
 * Uses Service.discover() on purpose: Service.ensure() would start a second
 * server, which would break the "TUI and bridge share one session" invariant.
 */
export async function connectOpenCode(opts: {
  versionRange: string
  requiredRoutes: string[]
  log: Logger
}): Promise<OpenCodeConnection> {
  const { log } = opts

  const endpoint = await Service.discover()
  if (!endpoint) {
    throw new OpenCodeUnavailableError(
      "OpenCode service is not running (no healthy local service found)",
      "not_running",
    )
  }

  if (!isLoopback(endpoint.url)) {
    throw new OpenCodeUnavailableError(
      `Refusing to use a non-loopback OpenCode endpoint: ${endpoint.url}`,
      "not_running",
    )
  }

  const headers = Service.headers(endpoint)
  if (!headers) {
    throw new OpenCodeUnavailableError(
      "OpenCode service registration carries no credentials",
      "unauthorized",
    )
  }
  const client = OpenCode.make({ baseUrl: endpoint.url, headers })

  let info: { version: string; pid: number }
  try {
    info = await client.server.info()
  } catch (error) {
    throw new OpenCodeUnavailableError(
      `OpenCode service did not answer /api/info: ${(error as Error).message}`,
      "unauthorized",
    )
  }

  if (!satisfiesRange(info.version, opts.versionRange)) {
    throw new OpenCodeUnavailableError(
      `OpenCode version ${info.version} does not satisfy ${opts.versionRange}`,
      "version_mismatch",
    )
  }

  const missing = await missingRoutes(endpoint.url, headers, opts.requiredRoutes)
  if (missing.length > 0) {
    throw new OpenCodeUnavailableError(
      `OpenCode API is missing required routes: ${missing.join(", ")}`,
      "contract",
    )
  }

  log.info("opencode.connected", {
    url: endpoint.url,
    version: info.version,
    pid: info.pid,
    routes: opts.requiredRoutes.length,
  })

  return { client, url: endpoint.url, version: info.version, pid: info.pid }
}

/**
 * Contract check by "METHOD /path" rather than operationId.
 *
 * operationIds are renamed between OpenCode releases (2.0.18 exposes
 * `session.permission.reply`, 2.0.32 exposes `permission.reply`) while the
 * routes stay identical, so routes are the stable contract.
 */
async function missingRoutes(
  url: string,
  headers: Record<string, string>,
  required: string[],
): Promise<string[]> {
  let document: { paths?: Record<string, Record<string, unknown>> }
  try {
    const response = await fetch(new URL("/openapi.json", url), { headers })
    if (!response.ok) return required
    document = (await response.json()) as typeof document
  } catch {
    return required
  }

  const available = new Set<string>()
  for (const [path, methods] of Object.entries(document.paths ?? {})) {
    for (const method of Object.keys(methods)) {
      available.add(`${method.toUpperCase()} ${path}`)
    }
  }
  return required.filter((route) => !available.has(route))
}
