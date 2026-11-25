import * as lark from '@larksuiteoapi/node-sdk'
import { z } from 'zod'
import type { Context } from 'cordis'
import { guardAsync } from '../../kernel/safe.js'

export type CardJson = Record<string, unknown>
export type OutboundMessage = { type: 'text'; text: string } | { type: 'interactive'; card: CardJson }
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'failed'
export type Recipient = { idType: 'chat_id' | 'open_id'; id: string }
export interface CardActionResponse {
  toast: { type: 'info' | 'success' | 'error'; content: string }
  card?: { type: 'raw'; data: CardJson }
}

// EventDispatcher flattens v2 header and event into the same object.
const messageEvent = z.object({ event_id: z.string().min(1),
  sender: z.object({ sender_type: z.string(), sender_id: z.object({ open_id: z.string().optional() }) }),
  message: z.object({ message_id: z.string().min(1), create_time: z.coerce.number().finite(),
    chat_id: z.string(), chat_type: z.enum(['group', 'p2p']), message_type: z.string(), content: z.string(),
    parent_id: z.string().optional(), root_id: z.string().optional(),
    mentions: z.array(z.object({ id: z.object({ open_id: z.string().optional() }) })).optional() }) })
const actionEvent = z.object({ event_id: z.string().min(1), operator: z.object({ open_id: z.string().min(1) }),
  action: z.object({ value: z.unknown(), form_value: z.record(z.string(), z.unknown()).optional() }),
  context: z.object({ open_message_id: z.string(), open_chat_id: z.string().optional() }) })
export type FeishuMessageEvent = z.output<typeof messageEvent>
export type FeishuCardActionEvent = z.output<typeof actionEvent>
export interface FeishuHandlers {
  onMessage(event: FeishuMessageEvent): Promise<void>
  onCardAction(event: FeishuCardActionEvent): Promise<CardActionResponse>
  onStatus(state: ConnectionState): void
}
export interface FeishuTransport {
  start(handlers: FeishuHandlers): Promise<void>
  close(): Promise<void>
  status(): ConnectionState
  botInfo(): Promise<{ openId: string; name: string }>
  replyMessage(messageId: string, msg: OutboundMessage, opts?: { replyInThread?: boolean; uuid?: string }): Promise<{ messageId: string }>
  sendMessage(receive: Recipient, msg: OutboundMessage, opts?: { uuid?: string }): Promise<{ messageId: string }>
  patchCard(messageId: string, card: CardJson): Promise<void>
}

function payload(msg: OutboundMessage) {
  return { msg_type: msg.type, content: JSON.stringify(msg.type === 'text' ? { text: msg.text } : msg.card) }
}
function check(result: { code?: number | undefined; msg?: string | undefined }) {
  if (result.code) throw Object.assign(new Error(result.msg ?? 'Feishu API error'), { code: result.code })
}
function sent(result: { code?: number | undefined; data?: { message_id?: string | undefined } | undefined }) {
  check(result)
  if (!result.data?.message_id) throw new Error('Feishu response missing message_id')
  return { messageId: result.data.message_id }
}
export function createFeishuTransport(ctx: Context, credentials: { appId: string; appSecret: string; domain: 'feishu' | 'lark' }): FeishuTransport {
  if (!credentials.appId || !credentials.appSecret) throw new Error('Missing Feishu credentials')
  const options = { appId: credentials.appId, appSecret: credentials.appSecret, loggerLevel: lark.LoggerLevel.fatal,
    domain: credentials.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu }
  const client = new lark.Client(options)
  let state: ConnectionState = 'connecting'
  let ws: lark.WSClient | undefined
  return {
    status: () => state,
    async botInfo() {
      const result = await client.request<{ bot?: { open_id: string; app_name: string } }>({ method: 'GET', url: '/open-apis/bot/v3/info', timeout: 10000 })
      if (!result.bot?.open_id) throw new Error('Feishu bot identity unavailable')
      return { openId: result.bot.open_id, name: result.bot.app_name }
    },
    async start(handlers) {
      const status = (next: ConnectionState) => { state = next; handlers.onStatus(next) }
      const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.fatal }).register({
        'im.message.receive_v1': async raw => {
          setImmediate(() => {
            void guardAsync(ctx, Promise.resolve().then(() => handlers.onMessage(messageEvent.parse(raw))), 'feishu message')
          })
        },
        'card.action.trigger': async (raw: unknown) => {
          const parsed = actionEvent.safeParse(raw)
          return parsed.success ? handlers.onCardAction(parsed.data) : { toast: { type: 'error', content: '卡片已过期' } }
        },
      })
      ws = new lark.WSClient({ ...options, autoReconnect: true, handshakeTimeoutMs: 10000,
        onReady: () => status('connected'), onReconnecting: () => status('reconnecting'),
        onReconnected: () => status('connected'), onError: () => status('failed') })
      await ws.start({ eventDispatcher: dispatcher })
    },
    async close() { ws?.close({ force: true }) },
    async sendMessage(to, msg, opts) {
      return sent(await client.im.message.create({ params: { receive_id_type: to.idType },
        data: { receive_id: to.id, ...payload(msg), ...opts } }))
    },
    async replyMessage(id, msg, opts) {
      return sent(await client.im.message.reply({ path: { message_id: id },
        data: { ...payload(msg), ...(opts?.replyInThread && { reply_in_thread: true }), ...(opts?.uuid && { uuid: opts.uuid }) } }))
    },
    async patchCard(id, card) {
      check(await client.im.message.patch({ path: { message_id: id }, data: { content: JSON.stringify(card) } }))
    },
  }
}
