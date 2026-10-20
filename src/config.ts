import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { z } from "zod"

const PermissionRule = z.object({
  action: z.string().min(1),
  resource: z.string().min(1),
  effect: z.enum(["allow", "deny", "ask"]),
})

const Project = z.object({
  alias: z.string().min(1),
  directory: z.string().min(1),
  agent: z.string().min(1).default("dingtalk"),
  /** "default" = OpenCode's own allow-everything policy; "strict" = ask/deny. */
  permissionPreset: z.enum(["default", "strict"]).default("default"),
  allowedConversations: z.array(z.string()).default([]),
  allowedUsers: z.array(z.string()).default([]),
  approvers: z.array(z.string()).default([]),
  /** Explicit rules; when present they override the preset. */
  permissions: z.array(PermissionRule).default([]),
})

const Config = z.object({
  dingtalk: z.object({
    clientId: z.string().min(1),
    robotCode: z.string().min(1),
  }),
  opencode: z.object({
    versionRange: z.string().default(">=2.0.18 <2.1.0"),
    /**
     * Start the SHARED local service when it is not running.
     *
     * This is `opencode service start` — the same service the TUI uses, not a
     * second private instance. Without it the bridge would stay idle after a
     * reboot until somebody opens the TUI.
     */
    autoStartService: z.boolean().default(true),
    /**
     * Contract check by "METHOD /path". operationIds are renamed between
     * OpenCode releases while routes stay stable, so routes are the contract.
     */
    requiredRoutes: z
      .array(z.string().regex(/^(GET|POST|PATCH|DELETE|PUT) \/api\//))
      .default([
        "POST /api/session",
        "GET /api/session/{sessionID}",
        "GET /api/session/active",
        "POST /api/session/{sessionID}/prompt",
        "GET /api/session/{sessionID}/inbox",
        "DELETE /api/session/{sessionID}/inbox/{inboxID}",
        "GET /api/experimental/session/{sessionID}/log",
        "POST /api/session/{sessionID}/interrupt",
        "GET /api/session/{sessionID}/permission",
        "POST /api/session/{sessionID}/permission/{requestID}/reply",
        "GET /api/session/{sessionID}/form",
        "POST /api/session/{sessionID}/form/{formID}/reply",
        "DELETE /api/session/{sessionID}/form/{formID}",
      ]),
  }),
  bridge: z.object({
    dataDir: z.string().min(1),
    approvalTimeoutMs: z.number().int().positive().default(600_000),
    maxTaskDurationMs: z.number().int().positive().default(7_200_000),
    maxPromptChars: z.number().int().positive().default(8000),
    maxResultChars: z.number().int().positive().default(3500),
    maxQueuePerSession: z.number().int().positive().default(10),
    maxTasksPerUserPerHour: z.number().int().positive().default(20),
    heartbeatMs: z.number().int().positive().default(300_000),
    approvalChannel: z.enum(["group", "dm"]).default("group"),
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  }),
  projects: z.array(Project).min(1),
})

export type PermissionRuleConfig = z.infer<typeof PermissionRule>
export type ProjectConfig = z.infer<typeof Project>
export type BridgeConfig = z.infer<typeof Config>

export function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2))
  return path
}

export function configPath(): string {
  return process.env.BRIDGE_CONFIG ?? resolve(process.cwd(), "config/config.json")
}

/** Load and validate the bridge configuration. Fails closed on any problem. */
export function loadConfig(path = configPath()): BridgeConfig {
  if (!existsSync(path)) {
    throw new Error(`Config not found: ${path}. Copy config/config.example.json and fill it in.`)
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new Error(`Config is not valid JSON: ${path} (${(error as Error).message})`)
  }

  const parsed = Config.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ")
    throw new Error(`Config validation failed: ${issues}`)
  }

  const config = parsed.data
  config.bridge.dataDir = expandHome(config.bridge.dataDir)

  const aliases = new Set<string>()
  for (const project of config.projects) {
    if (aliases.has(project.alias)) {
      throw new Error(`Config validation failed: duplicate project alias "${project.alias}"`)
    }
    aliases.add(project.alias)

    project.directory = expandHome(project.directory)
    if (!existsSync(project.directory)) {
      throw new Error(
        `Config validation failed: project "${project.alias}" directory does not exist: ${project.directory}`,
      )
    }
  }

  return config
}
