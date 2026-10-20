import { DWClient, TOPIC_ROBOT } from "dingtalk-stream"
import type { DWClientDownStream } from "dingtalk-stream"
import type { Logger } from "../logger.js"

export type DingTalkInbound = {
  msgId: string
  conversationId: string
  conversationType: string
  conversationTitle?: string
  senderStaffId: string
  senderNick: string
  msgtype: string
  text: string
  isInAtList: boolean
  sessionWebhook?: string
  sessionWebhookExpiredTime?: number
  robotCode?: string
  createAt?: number
  atUsers: string[]
}

export type InboundHandler = (message: DingTalkInbound) => Promise<void> | void

export class DingTalkAdapter {
  private client: DWClient | undefined
  private connected = false

  constructor(
    private readonly opts: {
      clientId: string
      clientSecret: string
      robotCode: string
      log: Logger
      onMessage: InboundHandler
    },
  ) {}

  get isConnected(): boolean {
    return this.connected
  }

  async connect(): Promise<void> {
    const { log, clientId, clientSecret, robotCode } = this.opts

    const client = new DWClient({
      clientId,
      clientSecret,
      keepAlive: true,
      debug: false,
      ua: "opencode-dingtalk-bridge/0.1.0",
      // The SDK merges opts into its config; subscriptions are required for the
      // gateway handshake but are not part of the published constructor type.
      subscriptions: [{ type: "CALLBACK", topic: TOPIC_ROBOT }],
    } as ConstructorParameters<typeof DWClient>[0] & {
      subscriptions: Array<{ type: string; topic: string }>
    })

    client.registerCallbackListener(TOPIC_ROBOT, (downstream: DWClientDownStream) => {
      void this.handleDownstream(client, downstream)
    })

    await client.connect()
    this.client = client
    this.connected = true
    log.info("dingtalk.connected", { clientId, robotCode })
  }

  disconnect(): void {
    this.client?.disconnect()
    this.client = undefined
    this.connected = false
  }

  /** Reply through the session webhook carried by the triggering message. */
  async reply(
    message: DingTalkInbound,
    text: string,
    opts: { atUserIds?: string[] } = {},
  ): Promise<void> {
    if (!message.sessionWebhook) {
      this.opts.log.warn("dingtalk.reply.skipped", { reason: "no sessionWebhook" })
      return
    }
    if (
      message.sessionWebhookExpiredTime &&
      message.sessionWebhookExpiredTime < Date.now()
    ) {
      this.opts.log.warn("dingtalk.reply.skipped", { reason: "sessionWebhook expired" })
      return
    }

    const body: Record<string, unknown> = {
      msgtype: "text",
      text: { content: text },
    }
    if (opts.atUserIds?.length) {
      body.at = { atUserIds: opts.atUserIds, isAtAll: false }
    }

    const response = await fetch(message.sessionWebhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      throw new Error(`DingTalk reply failed: ${response.status} ${await response.text()}`)
    }
    this.opts.log.info("dingtalk.reply.sent", {
      msgId: message.msgId,
      conversationId: message.conversationId,
      bytes: text.length,
    })
  }

  private async handleDownstream(
    client: DWClient,
    downstream: DWClientDownStream,
  ): Promise<void> {
    const log = this.opts.log
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(downstream.data) as Record<string, unknown>
    } catch {
      log.warn("dingtalk.message.unparsable")
      client.socketCallBackResponse(downstream.headers.messageId, {})
      return
    }

    const message = normalize(payload)

    // Ack first: the handler owns durability. A handler that throws must not
    // make DingTalk redeliver forever, so the failure is logged instead.
    client.socketCallBackResponse(downstream.headers.messageId, {})

    if (!message) {
      log.debug("dingtalk.message.ignored", { reason: "unsupported shape" })
      return
    }

    log.info("dingtalk.message", {
      msgId: message.msgId,
      conversationId: message.conversationId,
      conversationType: message.conversationType,
      senderStaffId: message.senderStaffId || "<none>",
      msgtype: message.msgtype,
      isInAtList: message.isInAtList,
      chars: message.text.length,
    })

    try {
      await this.opts.onMessage(message)
    } catch (error) {
      log.error("dingtalk.handler.failed", {
        msgId: message.msgId,
        error: (error as Error).message,
      })
    }
  }
}

export function normalize(payload: Record<string, unknown>): DingTalkInbound | undefined {
  const msgId = typeof payload.msgId === "string" ? payload.msgId : undefined
  const conversationId =
    typeof payload.conversationId === "string" ? payload.conversationId : undefined
  if (!msgId || !conversationId) return undefined

  const text =
    typeof payload.text === "object" && payload.text !== null
      ? String((payload.text as { content?: unknown }).content ?? "")
      : ""

  const atUsers = Array.isArray(payload.atUsers)
    ? (payload.atUsers as Array<{ staffId?: string; dingtalkId?: string }>)
        .map((user) => user.staffId ?? user.dingtalkId ?? "")
        .filter(Boolean)
    : []

  return {
    msgId,
    conversationId,
    conversationType: String(payload.conversationType ?? ""),
    conversationTitle:
      typeof payload.conversationTitle === "string" ? payload.conversationTitle : undefined,
    senderStaffId: typeof payload.senderStaffId === "string" ? payload.senderStaffId : "",
    senderNick: typeof payload.senderNick === "string" ? payload.senderNick : "",
    msgtype: String(payload.msgtype ?? ""),
    text: text.trim(),
    isInAtList: payload.isInAtList === true,
    sessionWebhook:
      typeof payload.sessionWebhook === "string" ? payload.sessionWebhook : undefined,
    sessionWebhookExpiredTime:
      typeof payload.sessionWebhookExpiredTime === "number"
        ? payload.sessionWebhookExpiredTime
        : undefined,
    robotCode: typeof payload.robotCode === "string" ? payload.robotCode : undefined,
    createAt: typeof payload.createAt === "number" ? payload.createAt : undefined,
    atUsers,
  }
}
