/**
 * Pi 独立验收 · 飞书注入器（Phase 5）
 *
 * 与 `test/fake-feishu-transport.ts` 相互独立：额外记录发送/补丁时间线、
 * 可按“第 N 次补丁”注入错误（429 / 99991400 / 卡片不可更新），并允许
 * 自定义 event_id 以便测试 event_id / message_id 双重去重。
 */
import type { CardActionResponse, CardJson, ConnectionState, FeishuCardActionEvent, FeishuHandlers,
  FeishuMessageEvent, FeishuTransport, OutboundMessage, Recipient } from '../../src/plugins/channel-feishu/transport.js'

export interface RecordedMessage {
  id: string
  target: string
  chatId?: string
  reply: boolean
  body: OutboundMessage
  at: number
  opts?: unknown
}
export interface PatchAttempt { id: string; attempt: number; at: number }
export interface PatchRecord { id: string; card: CardJson; at: number }

export interface MessageInput {
  /** 平台事件 ID（默认 event:msg，可显式指定以测试 event_id 去重）。 */
  eventId?: string
  messageId?: string
  text?: string
  user?: string
  senderType?: string
  chatId?: string
  chatType?: 'group' | 'p2p'
  messageType?: string
  content?: string
  createTime?: number
  parentId?: string
  rootId?: string
  mentions?: Array<{ id: { open_id?: string } }>
}

export class PiFeishuTransport implements FeishuTransport {
  handlers!: FeishuHandlers
  readonly messages = new Map<string, RecordedMessage>()
  /** 按发送顺序记录的消息 ID。 */
  readonly order: string[] = []
  /** 成功完成的 patch。 */
  readonly patches: PatchRecord[] = []
  /** 全部 patch 尝试（含失败），用于断言退避间隔。 */
  readonly patchCalls: PatchAttempt[] = []
  readonly statuses: ConnectionState[] = []
  readonly bot = { openId: 'ou_bot', name: 'Pi Bot' }
  /** 返回非 undefined 即让该次 patch 失败（按消息 ID 与第几次尝试）。 */
  failPatch: ((id: string, attempt: number) => unknown | undefined) | undefined
  patchDelayMs = 0
  closes = 0
  private counter = 0
  private actions = 0
  private state: ConnectionState = 'connecting'

  async start(handlers: FeishuHandlers) {
    this.handlers = handlers
    this.state = 'connected'
    handlers.onStatus('connected')
  }

  async close() { this.closes++; this.state = 'connecting' }
  status() { return this.state }
  async botInfo() { return this.bot }

  private record(target: string, body: OutboundMessage, reply: boolean, chatId?: string, opts?: unknown) {
    const id = 'om_pi_' + ++this.counter
    this.messages.set(id, { id, target, ...(chatId && { chatId }), reply, body, at: Date.now(), ...(opts && { opts }) })
    this.order.push(id)
    return { messageId: id }
  }

  async replyMessage(target: string, body: OutboundMessage, opts?: unknown) {
    return this.record(target, body, true, this.messages.get(target)?.chatId, opts)
  }

  async sendMessage(to: Recipient, body: OutboundMessage, opts?: unknown) {
    return this.record(to.id, body, false, undefined, opts)
  }

  async patchCard(id: string, card: CardJson) {
    const attempt = this.patchCalls.filter(call => call.id === id).length + 1
    const failure = this.failPatch?.(id, attempt)
    if (this.patchDelayMs) await new Promise(resolve => setTimeout(resolve, this.patchDelayMs))
    this.patchCalls.push({ id, attempt, at: Date.now() })
    if (failure) throw failure
    this.patches.push({ id, card, at: Date.now() })
    const row = this.messages.get(id)
    if (row) row.body = { type: 'interactive', card }
  }

  setStatus(state: ConnectionState) {
    this.state = state
    this.statuses.push(state)
    this.handlers.onStatus(state)
  }

  event(input: MessageInput): FeishuMessageEvent {
    const messageId = input.messageId ?? 'om_msg_' + ++this.counter
    const chatType = input.chatType ?? 'group'
    return {
      event_id: input.eventId ?? 'evt:' + messageId,
      sender: { sender_type: input.senderType ?? 'user', sender_id: { open_id: input.user ?? 'ou_req' } },
      message: {
        message_id: messageId,
        create_time: input.createTime ?? Date.now(),
        chat_id: input.chatId ?? (chatType === 'group' ? 'oc_group' : 'oc_p2p_' + (input.user ?? 'ou_req')),
        chat_type: chatType,
        message_type: input.messageType ?? 'text',
        content: input.content ?? JSON.stringify({ text: input.text ?? '' }),
        ...(input.parentId && { parent_id: input.parentId }),
        ...(input.rootId && { root_id: input.rootId }),
        mentions: input.mentions ?? (chatType === 'group' ? [{ id: { open_id: this.bot.openId } }] : []),
      },
    }
  }

  async emit(input: MessageInput) { await this.handlers.onMessage(this.event(input)) }

  /** 群聊消息：默认 @ 机器人。 */
  group(text: string, over: MessageInput = {}) {
    return this.emit({ text, chatType: 'group', chatId: 'oc_group', user: 'ou_req',
      mentions: [{ id: { open_id: this.bot.openId } }], ...over })
  }

  /** 私聊消息。 */
  p2p(text: string, over: MessageInput = {}) {
    return this.emit({ text, chatType: 'p2p', user: 'ou_owner', ...over })
  }

  async click(messageId: string, actor: string, value: unknown, options: { eventId?: string; form?: Record<string, unknown> } = {}) {
    const row = this.messages.get(messageId)
    const event: FeishuCardActionEvent = {
      event_id: options.eventId ?? 'act_pi_' + ++this.actions,
      operator: { open_id: actor },
      action: { value, ...(options.form && { form_value: options.form }) },
      context: { open_message_id: messageId, ...(row?.chatId && { open_chat_id: row.chatId }) },
    }
    const startedAt = Date.now()
    const result: CardActionResponse = await this.handlers.onCardAction(event)
    if (result.card) {
      const target = this.messages.get(messageId)
      if (target) target.body = { type: 'interactive', card: result.card.data }
    }
    return { ...result, elapsed: Date.now() - startedAt }
  }

  /** 指定消息（角色）的最后一次成功 patch 内容。 */
  lastPatch(id: string) { return this.patches.filter(patch => patch.id === id).at(-1) }

  /** 文本消息体（非卡片）拼接。 */
  text(id: string) { const body = this.messages.get(id)?.body; return body?.type === 'text' ? body.text : undefined }

  json(id: string) { return JSON.stringify(this.messages.get(id)?.body ?? {}) }
}

export const cardText = (item: unknown) => JSON.stringify(item)

export function cardButtons(card: CardJson): Array<Record<string, unknown>> {
  const elements = ((card.body as { elements?: unknown[] } | undefined)?.elements ?? []) as Array<Record<string, unknown>>
  const found: Array<Record<string, unknown>> = []
  const walk = (nodes: unknown[]) => {
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue
      const value = node as Record<string, unknown>
      if (value.tag === 'button') found.push(value)
      if (Array.isArray(value.elements)) walk(value.elements)
    }
  }
  walk(elements)
  return found
}

export function cardHeader(card: CardJson) {
  return (card.header as { title?: { content?: string }; template?: string } | undefined) ?? {}
}
