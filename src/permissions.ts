import type { PermissionRuleConfig, ProjectConfig } from "./config.js"

/**
 * Permission presets.
 *
 * `default` mirrors OpenCode's own default policy (everything allowed) and
 * only blocks the two things the bridge genuinely cannot support:
 *   - question : the agent would wait for a form reply, MVP has no answer path
 *   - subagent : child sessions have their own permissions, the bridge would
 *                not see their approval requests
 * Both are hard denies, so they never raise an approval prompt.
 *
 * `strict` is the original hardening profile: shell and web access ask for
 * confirmation, paths outside the project are denied.
 */
export const PERMISSION_PRESETS: Record<string, PermissionRuleConfig[]> = {
  default: [
    { action: "question", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" },
  ],
  strict: [
    { action: "external_directory", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "ask" },
    { action: "edit", resource: "*", effect: "allow" },
    { action: "webfetch", resource: "*", effect: "ask" },
    { action: "websearch", resource: "*", effect: "ask" },
    { action: "question", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" },
  ],
}

export function resolvePermissions(project: ProjectConfig): PermissionRuleConfig[] {
  if (project.permissions.length > 0) return project.permissions
  return PERMISSION_PRESETS[project.permissionPreset] ?? PERMISSION_PRESETS.default!
}
