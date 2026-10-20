/**
 * Local CLI for the bridge: inspect tasks and approve/reject from the Mac
 * terminal (no phone required).
 *
 *   npm run cli -- status
 *   npm run cli -- approvals
 *   npm run cli -- approve A-7F3K
 *   npm run cli -- reject A-7F3K "不想跑这个命令"
 */
import "../src/polyfills.js"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { loadConfig } from "../src/config.js"
import { openDatabase } from "../src/store/db.js"

const [, , command = "status", ...rest] = process.argv

async function main() {
  const config = loadConfig()
  const db = openDatabase(config.bridge.dataDir)

  const endpoint = await Service.discover()
  if (!endpoint) throw new Error("本机 OpenCode 未运行")
  const headers = Service.headers(endpoint)
  if (!headers) throw new Error("OpenCode 服务注册信息缺少凭据")
  const client = OpenCode.make({ baseUrl: endpoint.url, headers })

  if (command === "status" || command === "tasks") {
    const tasks = db
      .prepare(
        `SELECT task_id, status, project_alias, created_at, error_code, substr(result_summary,1,60) AS result
         FROM tasks ORDER BY created_at DESC LIMIT 10`,
      )
      .all() as Array<Record<string, unknown>>
    console.log("最近任务：")
    for (const task of tasks) {
      console.log(
        `  ${task.task_id}  ${String(task.status).padEnd(16)} ${String(task.project_alias).padEnd(10)} ${
          task.error_code ? `err=${task.error_code} ` : ""
        }${task.result ?? ""}`,
      )
    }
    return
  }

  if (command === "approvals") {
    const rows = db
      .prepare(
        `SELECT a.approval_id, a.task_id, a.action, a.resources, a.status, a.expires_at
         FROM approvals a WHERE a.status = 'PENDING' ORDER BY a.requested_at ASC`,
      )
      .all() as Array<Record<string, unknown>>
    if (rows.length === 0) {
      console.log("没有待确认项。")
      return
    }
    console.log("待确认项：")
    for (const row of rows) {
      console.log(
        `  ${row.approval_id}  ${row.task_id}  ${row.action}  ${row.resources}  (${new Date(
          Number(row.expires_at),
        ).toLocaleTimeString()} 过期)`,
      )
    }
    return
  }

  if (command === "approve" || command === "reject") {
    const approvalId = (rest[0] ?? "").toUpperCase()
    const note = rest.slice(1).join(" ") || undefined
    if (!approvalId) throw new Error("用法: approve|reject <编号> [原因]")

    const approval = db
      .prepare("SELECT * FROM approvals WHERE approval_id = ?")
      .get(approvalId) as
      | { approval_id: string; task_id: string; session_id: string; request_id: string; status: string }
      | undefined
    if (!approval) throw new Error(`找不到待确认项 ${approvalId}`)
    if (approval.status !== "PENDING") throw new Error(`${approvalId} 状态为 ${approval.status}，无需处理`)

    const claimed = db
      .prepare(
        "UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, decision_note = ? WHERE approval_id = ? AND status = 'PENDING'",
      )
      .run(
        command === "approve" ? "APPROVED" : "REJECTED",
        Date.now(),
        "cli",
        note ?? null,
        approvalId,
      )
    if (claimed.changes === 0) throw new Error(`${approvalId} 已被其他方式处理`)

    await client.permission.reply({
      sessionID: approval.session_id,
      requestID: approval.request_id,
      decision: command === "approve" ? "once" : "reject",
      message: note,
    })
    console.log(`${approvalId} 已${command === "approve" ? "批准" : "拒绝"}。`)
    return
  }

  console.log("用法: status | tasks | approvals | approve <编号> | reject <编号> [原因]")
}

main().catch((error) => {
  console.error(`失败: ${(error as Error).message}`)
  process.exit(1)
})
