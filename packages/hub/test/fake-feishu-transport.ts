import type { CardJson, ConnectionState, FeishuCardActionEvent, FeishuHandlers, FeishuMessageEvent,
  FeishuTransport, OutboundMessage, Recipient } from '../src/plugins/channel-feishu/transport.js'

export class FakeFeishuTransport implements FeishuTransport {
  handlers!: FeishuHandlers
  readonly messages = new Map<string, { target: string; reply: boolean; body: OutboundMessage }>()
  readonly patches: { id: string; card: CardJson }[] = []
  readonly resources = new Map<string, { data: Buffer; mimeType: string }>()
  readonly uploadedImages: { imageKey: string; data: Buffer; mimeType?: string }[] = []
  private seq = 0
  private state: ConnectionState = 'connecting'
  closes = 0
  async start(handlers: FeishuHandlers) { this.handlers = handlers; this.setStatus('connected') }
  setStatus(state: ConnectionState) { this.state = state; this.handlers.onStatus(state) }
  status() { return this.state }
  async close() { this.closes++ }
  async botInfo() { return { openId: 'ou_bot', name: 'Hub' } }
  private record(target: string, body: OutboundMessage, reply: boolean) {
    const messageId = 'om_bot_' + ++this.seq
    this.messages.set(messageId, { target, body, reply })
    return { messageId }
  }
  async replyMessage(target: string, body: OutboundMessage) { return this.record(target, body, true) }
  async sendMessage(to: Recipient, body: OutboundMessage) { return this.record(to.id, body, false) }
  async patchCard(id: string, card: CardJson) {
    this.patches.push({ id, card })
    this.messages.get(id)!.body = { type: 'interactive', card }
  }
  async downloadResource(_messageId: string, fileKey: string) {
    const found = this.resources.get(fileKey)
    if (!found) throw new Error('Missing fake resource: ' + fileKey)
    return found
  }
  async uploadImage(data: Buffer, mimeType?: string) {
    const imageKey = 'img_fake_' + (this.uploadedImages.length + 1)
    this.uploadedImages.push({ imageKey, data, ...(mimeType && { mimeType }) })
    return { imageKey }
  }
  message(id: string, text: string, user = 'ou_req', opts: Partial<FeishuMessageEvent['message']> = {}) {
    return this.handlers.onMessage({ event_id: 'evt_' + id, sender: { sender_type: 'user', sender_id: { open_id: user } },
      message: { message_id: id, create_time: Date.now(), chat_id: 'oc_group', chat_type: 'group', message_type: 'text',
        mentions: [{ id: { open_id: 'ou_bot' } }], content: JSON.stringify({ text }), ...opts } })
  }
  async click(id: string, actor: string, value: unknown, form?: FeishuCardActionEvent['action']['form_value']) {
    const result = await this.handlers.onCardAction({ event_id: 'act_' + ++this.seq, operator: { open_id: actor },
      context: { open_message_id: id }, action: { value, form_value: form } })
    if (result.card) this.messages.get(id)!.body = { type: 'interactive', card: result.card.data }
    return result
  }
}
