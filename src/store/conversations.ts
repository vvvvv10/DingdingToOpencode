import type { Db } from "./db.js"

export type Conversation = {
  conversation_id: string
  conversation_type: number
  title: string | null
  project_alias: string
  active_session_id: string | null
  session_webhook: string | null
  webhook_expires_at: number | null
  last_msg_at: number | null
  created_at: number
}

export type SessionRow = {
  session_id: string
  conversation_id: string
  project_alias: string
  title: string | null
  control_mode: string
  last_seq: number
  last_poll_at: number | null
  created_at: number
  last_active_at: number | null
}

export function upsertConversation(
  db: Db,
  input: {
    conversationId: string
    conversationType: number
    title?: string
    projectAlias: string
    webhook?: string
    webhookExpiresAt?: number
  },
): void {
  db.prepare(
    `INSERT INTO conversations
       (conversation_id, conversation_type, title, project_alias, session_webhook, webhook_expires_at, last_msg_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET
       conversation_type = excluded.conversation_type,
       title = COALESCE(excluded.title, conversations.title),
       project_alias = excluded.project_alias,
       session_webhook = COALESCE(excluded.session_webhook, conversations.session_webhook),
       webhook_expires_at = COALESCE(excluded.webhook_expires_at, conversations.webhook_expires_at),
       last_msg_at = excluded.last_msg_at`,
  ).run(
    input.conversationId,
    input.conversationType,
    input.title ?? null,
    input.projectAlias,
    input.webhook ?? null,
    input.webhookExpiresAt ?? null,
    Date.now(),
    Date.now(),
  )
}

export function getConversation(db: Db, conversationId: string): Conversation | undefined {
  return db
    .prepare("SELECT * FROM conversations WHERE conversation_id = ?")
    .get(conversationId) as Conversation | undefined
}

export function setActiveSession(
  db: Db,
  conversationId: string,
  sessionId: string,
  projectAlias: string,
  title?: string,
): void {
  db.prepare("UPDATE conversations SET active_session_id = ? WHERE conversation_id = ?").run(
    sessionId,
    conversationId,
  )
  db.prepare(
    `INSERT INTO sessions (session_id, conversation_id, project_alias, title, control_mode, created_at)
     VALUES (?, ?, ?, ?, 'BRIDGE', ?)
     ON CONFLICT(session_id) DO UPDATE SET last_active_at = ?`,
  ).run(sessionId, conversationId, projectAlias, title ?? null, Date.now(), Date.now())
}

export function getSession(db: Db, sessionId: string): SessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as
    | SessionRow
    | undefined
}

export function setSessionControlMode(db: Db, sessionId: string, mode: string): void {
  db.prepare("UPDATE sessions SET control_mode = ? WHERE session_id = ?").run(mode, sessionId)
}

/** Record the last timeline poll so the status command can show freshness. */
export function touchSessionPoll(db: Db, sessionId: string, at = Date.now()): void {
  db.prepare("UPDATE sessions SET last_poll_at = ? WHERE session_id = ?").run(at, sessionId)
}
