import { chmodSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import Database from "better-sqlite3"

export const SCHEMA_VERSION = 2

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  conversation_id    TEXT PRIMARY KEY,
  conversation_type  INTEGER NOT NULL,
  title              TEXT,
  project_alias      TEXT NOT NULL,
  active_session_id  TEXT,
  session_webhook    TEXT,
  webhook_expires_at INTEGER,
  last_msg_at        INTEGER,
  created_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id      TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  project_alias   TEXT NOT NULL,
  title           TEXT,
  control_mode    TEXT NOT NULL DEFAULT 'BRIDGE',
  last_seq        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  last_active_at  INTEGER
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id             TEXT PRIMARY KEY,
  msg_id              TEXT NOT NULL UNIQUE,
  conversation_id     TEXT NOT NULL,
  sender_staff_id     TEXT NOT NULL,
  project_alias       TEXT NOT NULL,
  session_id          TEXT,
  inbox_id            TEXT UNIQUE,
  opencode_message_id TEXT,
  approval_id         TEXT,
  prompt_text         TEXT,
  status              TEXT NOT NULL,
  outcome             TEXT,
  error_code          TEXT,
  error_message       TEXT,
  result_summary      TEXT,
  human_intervened    INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  submitted_at        INTEGER,
  started_at          INTEGER,
  finished_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_tasks_conv    ON tasks(conversation_id);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_sender  ON tasks(sender_staff_id, created_at);

CREATE TABLE IF NOT EXISTS task_messages (
  task_id    TEXT NOT NULL,
  message_id TEXT NOT NULL,
  ordinal    INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  text       TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, message_id, ordinal)
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id   TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  request_id    TEXT NOT NULL,
  action        TEXT NOT NULL,
  resources     TEXT,
  message       TEXT,
  status        TEXT NOT NULL,
  requested_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  decided_at    INTEGER,
  decided_by    TEXT,
  decision_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(status, expires_at);

CREATE TABLE IF NOT EXISTS outbox (
  outbox_id       TEXT PRIMARY KEY,
  dedupe_key      TEXT NOT NULL UNIQUE,
  task_id         TEXT,
  conversation_id TEXT NOT NULL,
  kind            TEXT NOT NULL,
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS inbound_messages (
  msg_id       TEXT PRIMARY KEY,
  received_at  INTEGER NOT NULL,
  status       TEXT NOT NULL,
  reason       TEXT,
  processed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_inbound_received ON inbound_messages(received_at);

CREATE TABLE IF NOT EXISTS chat_sessions (
  conversation_id TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_locks (
  project_alias TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  owner_pid     INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  actor_type     TEXT NOT NULL,
  actor_id       TEXT,
  action         TEXT NOT NULL,
  task_id        TEXT,
  session_id     TEXT,
  conversation_id TEXT,
  detail         TEXT,
  result         TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
`

const SCHEMA_V2 = `
ALTER TABLE sessions ADD COLUMN last_poll_at INTEGER;
`

/**
 * v3: task kinds + read-only chat sessions.
 *
 * `kind` separates executable tasks from read-only questions ("/ask"), so
 * both can share the same durable pipeline (task row → timeline → outbox)
 * and survive a bridge restart.
 */
const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS chat_sessions (
  conversation_id TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task';
CREATE INDEX IF NOT EXISTS idx_tasks_kind ON tasks(kind, status);
`

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: 1, sql: SCHEMA_V1 },
  { version: 2, sql: SCHEMA_V2 },
  { version: 3, sql: SCHEMA_V3 },
]

export type Db = Database.Database

export function openDatabase(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const file = join(dataDir, "bridge.db")
  const db = new Database(file)
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  db.pragma("busy_timeout = 5000")
  migrate(db)
  // The database may contain prompts, results and session webhooks: keep it
  // readable by the owner only (design §9.3).
  for (const path of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      chmodSync(path, 0o600)
    } catch {
      // The -wal/-shm files may not exist yet; the main file is what matters.
    }
  }
  return db
}

export function migrate(db: Db): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )`,
  )
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map(
      (row) => row.version,
    ),
  )
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue
    const run = db.transaction(() => {
      db.exec(migration.sql)
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        Date.now(),
      )
    })
    run()
  }
}

export function audit(
  db: Db,
  entry: {
    actorType: "USER" | "BRIDGE" | "SYSTEM"
    actorId?: string
    action: string
    taskId?: string
    sessionId?: string
    conversationId?: string
    detail?: Record<string, unknown>
    result?: string
  },
): void {
  db.prepare(
    `INSERT INTO audit_log (ts, actor_type, actor_id, action, task_id, session_id, conversation_id, detail, result)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Date.now(),
    entry.actorType,
    entry.actorId ?? null,
    entry.action,
    entry.taskId ?? null,
    entry.sessionId ?? null,
    entry.conversationId ?? null,
    entry.detail ? JSON.stringify(entry.detail) : null,
    entry.result ?? null,
  )
}
