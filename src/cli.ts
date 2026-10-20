/**
 * Local CLI: `bridge status`.
 *
 * The bridge has no inbound port, so the heartbeat file and the database are
 * the health surface (design §13.3). The command never talks to the network.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "./config.js"
import { readHeartbeat, heartbeatPath } from "./runtime/heartbeat.js"
import { openDatabase } from "./store/db.js"
import { activeTasks, pendingTasks } from "./store/tasks.js"

function age(ms: number | null): string {
  if (!ms) return "-"
  const seconds = Math.round((Date.now() - ms) / 1000)
  if (seconds < 60) return `${seconds}s 前`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m 前`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h 前`
  return `${Math.round(seconds / 86400)}d 前`
}

export function statusReport(configPath?: string): string {
  const config = loadConfig(configPath)
  const file = heartbeatPath(config.bridge.dataDir)
  const lines: string[] = []
  lines.push(`数据目录 : ${config.bridge.dataDir}`)
  lines.push(`OpenCode : 版本区间 ${config.opencode.versionRange}`)
  lines.push(`项目     : ${config.projects.map((project) => project.alias).join(", ")}`)

  const heartbeat = readHeartbeat(file)
  if (!heartbeat) {
    lines.push(`状态     : 未运行（没有找到心跳文件 ${file}）`)
    return lines.join("\n")
  }

  lines.push(`状态     : 运行中 (pid ${heartbeat.pid}，启动于 ${new Date(heartbeat.startedAt).toLocaleString()})`)
  lines.push(`心跳     : ${age(heartbeat.updatedAt)}`)
  lines.push(`OpenCode : ${heartbeat.opencodeVersion} / ${heartbeat.opencodeAvailable ? "可用" : "不可用"}`)
  lines.push(`钉钉     : ${heartbeat.dingtalkConnected ? "已连接" : "未连接"}`)
  lines.push(`最近消息 : ${age(heartbeat.lastDingTalkMessageAt)}`)
  lines.push(`最近事件 : ${age(heartbeat.lastOpenCodeEventAt)}`)
  lines.push(`最近完成 : ${age(heartbeat.lastTaskFinishedAt)}`)
  lines.push(`队列     : 排队 ${heartbeat.queueDepth} / 活动 ${heartbeat.activeTasks}`)

  if (existsSync(join(config.bridge.dataDir, "bridge.db"))) {
    const db = openDatabase(config.bridge.dataDir)
    lines.push(`任务     : 活动 ${activeTasks(db).length} / 排队 ${pendingTasks(db).length}`)
    const last = db
      .prepare("SELECT task_id, status, outcome, created_at FROM tasks ORDER BY created_at DESC LIMIT 5")
      .all() as Array<{ task_id: string; status: string; outcome: string | null; created_at: number }>
    for (const row of last) {
      lines.push(
        `  - ${row.task_id} ${row.status}${row.outcome ? ` (${row.outcome})` : ""} ${age(row.created_at)}`,
      )
    }
    db.close()
  }

  return lines.join("\n")
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "status"
  if (command !== "status") {
    console.error(`未知命令：${command}（可用：status）`)
    process.exit(2)
  }
  console.log(statusReport(process.env.BRIDGE_CONFIG))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error((error as Error).message)
    process.exit(1)
  })
}
