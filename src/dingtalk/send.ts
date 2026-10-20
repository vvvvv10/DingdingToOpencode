import type { Logger } from "../logger.js"

export type SendTarget = {
  conversationId: string
  conversationType: "1" | "2"
  senderStaffId: string
  webhook?: string
  webhookExpiresAt?: number
}

export type DingTalkSender = {
  clientId: string
  clientSecret: string
  robotCode: string
  log: Logger
}

const TOKEN_URL = "https://api.dingtalk.com/v1.0/oauth2/accessToken"
const GROUP_SEND_URL = "https://api.dingtalk.com/v1.0/robot/groupMessages/send"
const OTO_SEND_URL = "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend"

export class DingTalkSenderImpl {
  private token: { value: string; expiresAt: number } | undefined

  constructor(private readonly opts: DingTalkSender) {}

  /** Reply through the session webhook of the triggering message (preferred). */
  async sendViaWebhook(target: SendTarget, text: string): Promise<boolean> {
    if (!target.webhook) return false
    if (target.webhookExpiresAt && target.webhookExpiresAt < Date.now()) {
      this.opts.log.warn("dingtalk.webhook.expired", { conversationId: target.conversationId })
      return false
    }
    const response = await fetch(target.webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content: text } }),
    })
    if (!response.ok) {
      this.opts.log.warn("dingtalk.webhook.failed", {
        conversationId: target.conversationId,
        status: response.status,
      })
      return false
    }
    return true
  }

  /**
   * Proactive send via the robot OpenAPI (fallback when the session webhook
   * expired). Not yet verified against a live tenant — treat failures as
   * non-fatal and let the outbox retry.
   */
  async sendProactive(target: SendTarget, text: string): Promise<boolean> {
    const accessToken = await this.getAccessToken()
    const body =
      target.conversationType === "2"
        ? {
            robotCode: this.opts.robotCode,
            openConversationId: target.conversationId,
            msgKey: "sampleText",
            msgParam: JSON.stringify({ content: text }),
          }
        : {
            robotCode: this.opts.robotCode,
            userIds: [target.senderStaffId],
            msgKey: "sampleText",
            msgParam: JSON.stringify({ content: text }),
          }
    const url = target.conversationType === "2" ? GROUP_SEND_URL : OTO_SEND_URL

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      this.opts.log.warn("dingtalk.proactive.failed", {
        conversationId: target.conversationId,
        status: response.status,
        body: (await response.text()).slice(0, 200),
      })
      return false
    }
    return true
  }

  async send(target: SendTarget, text: string): Promise<boolean> {
    if (await this.sendViaWebhook(target, text)) return true
    return this.sendProactive(target, text)
  }

  private async getAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appKey: this.opts.clientId,
        appSecret: this.opts.clientSecret,
      }),
    })
    if (!response.ok) {
      throw new Error(`DingTalk accessToken request failed: ${response.status}`)
    }
    const payload = (await response.json()) as { accessToken?: string; expireIn?: number }
    if (!payload.accessToken) throw new Error("DingTalk accessToken response had no token")
    this.token = {
      value: payload.accessToken,
      expiresAt: Date.now() + (payload.expireIn ?? 7200) * 1000,
    }
    return payload.accessToken
  }
}
