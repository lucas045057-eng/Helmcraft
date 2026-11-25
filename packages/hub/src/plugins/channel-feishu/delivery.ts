import type { Context } from 'cordis'
import { eq } from 'drizzle-orm'
import { KeyedMutex, Lru, stableHash } from '@agent-hub/common'
import type { Actor, TaskDetailView } from '@agent-hub/protocol'
import type { HubConfig } from '../../config/schema.js'
import type { StoredEvent } from '../../services/store.js'
import { feishuMessages } from '../store-sqlite/schema.js'
import type { HarnessRecord } from '../orchestrator/harness.js'
import { guardAsync } from '../../kernel/safe.js'
import { CardUpdater, MessageSender, errorKind } from './card-updater.js'
import { displayText, extractProgress } from './cards/progress.js'
import type { Audience } from './cards/progress.js'
import { renderApprovalCard, renderOwnerReviewCard, renderProgressCard, terminal } from './cards/index.js'
import type { FeishuTransport, OutboundMessage } from './transport.js'

export type Binding = typeof feishuMessages.$inferSelect
type CardRole = 'approval_card' | 'progress_card' | 'review_card'
export class CardDelivery {
  readonly updater: CardUpdater
  readonly sender = new MessageSender()
  private readonly mutex = new KeyedMutex()
  readonly privateChats = new Lru<string, string>(2000)
  private readonly progress = new Map<string, { runId: string; at: number; owner: string[]; requester: string[] }>()
  private closed = false
  scrub: (value: string) => string = value => value
  constructor(readonly ctx: Context, readonly transport: FeishuTransport, public config: HubConfig['feishu'], readonly publicUrl: string) {
    this.updater = new CardUpdater(transport, config.card, {
      sent: (id, hash, version) => {
        this.update(id, { cardHash: hash, cardTaskVersion: version, lastPatchedAt: this.ctx.clock.now() })
        const row = this.binding(id)
        if (row?.role !== 'progress_card') return
        const task = this.ctx.store.repos.tasks.get(row.taskId)
        if (task?.status !== 'succeeded' || version !== task.version) return
        if (task.resultDeliveryStatus === 'delivered' && task.resultDeliveredAt === null) {
          // A late patch (e.g. after 429 or reconnect) can finish a previously timed-out delivery.
          void guardAsync(ctx, ctx.orchestrator.deliverResult(task.id, { type: 'owner', id: 'hub', channel: 'system' },
            { action: 'send' }), 'confirm Feishu result')
        } else if (task.resultDeliveryStatus === 'not_required') void guardAsync(ctx, this.ensure(task.id), 'supplement Feishu result')
      },
      dead: async id => {
        const row = this.binding(id)
        if (!row) return
        this.update(id, { dead: true })
        const task = this.ctx.orchestrator.getTask(row.taskId)
        if (task && (!terminal(task.status) || task.status === 'succeeded')) await this.ensure(task.id)
      },
      warn: () => ctx.logger.warn('飞书卡片更新失败'),
    })
  }
  binding(id: string) { return this.ctx.store.repos.select().from(feishuMessages).where(eq(feishuMessages.messageId, id)).get() }
  bind(row: typeof feishuMessages.$inferInsert) {
    this.ctx.store.repos.insert(feishuMessages).values(row).onConflictDoNothing().run()
  }
  private update(id: string, values: Partial<Binding>) {
    this.ctx.store.repos.update(feishuMessages).set(values).where(eq(feishuMessages.messageId, id)).run()
  }
  async reply(chat: string, message: string, body: OutboundMessage, uuid?: string) {
    const key = this.privateChats.get(chat) ?? chat
    try {
      return await this.sender.send(key, () => this.transport.replyMessage(message, body, uuid ? { uuid } : {}), Boolean(uuid))
    } catch (error) {
      if (!uuid || errorKind(error) !== 'dead') throw error
      return this.sender.send(key, () => this.transport.sendMessage({ idType: 'chat_id', id: chat }, body, { uuid }), true)
    }
  }
  dm(id: string, body: OutboundMessage, uuid?: string) {
    return this.sender.send(id, () => this.transport.sendMessage({ idType: 'open_id', id }, body, uuid ? { uuid } : {}), Boolean(uuid))
  }
  render(task: TaskDetailView, role: Binding['role'], audience: Audience) {
    const row = this.ctx.store.repos.tasks.get(task.id)
    const { id, taskNo, status, version, allowedActions, resultDeliveryStatus, attempt, profile, workspaceId, adapter,
      scheduleHint, errorCode, startedAt, finishedAt, updatedAt, inputRequest } = task
    const lines = this.progress.get(id)?.[audience] ?? (task.lastProgress ? [audience === 'requester' && task.lastProgress.startsWith('验证中 · ') ? '正在进行自动验证' : task.lastProgress] : [])
    const model = { id, taskNo, status, version, allowedActions, resultDeliveryStatus, attempt, profile, workspaceId, adapter,
      scheduleHint, errorCode, startedAt, finishedAt, updatedAt: Math.max(updatedAt, this.progress.get(id)?.at ?? 0), prompt: this.scrub(task.prompt),
      resultSummary: task.resultSummary && this.scrub(task.resultSummary), panelUrl: new URL('/tasks/' + id, this.publicUrl).href,
      inputRequest: inputRequest && { ...inputRequest, question: this.scrub(inputRequest.question),
        ...(inputRequest.options && { options: inputRequest.options.filter(option => this.scrub(option) === option) }) },
      ...(row?.rejectReason && { reason: this.scrub(row.rejectReason) }), ...this.config.card,
      progress: lines.map(this.scrub),
      ...(row?.requiredWorkerId && !this.ctx.orchestrator.listWorkers().some(w => w.id === row.requiredWorkerId && w.connection === 'online') && { requiredWorkerId: row.requiredWorkerId }) }
    const latest = this.ctx.store.repos.runs.forTask(task.id)[0]
    const files = latest?.filesChangedJson
    const run = task.runs[0]
    const info = audience === 'owner' ? run?.harness : undefined
    const worker = info && run && this.ctx.orchestrator.listWorkers().find(w => w.id === run.workerId)
    const record = latest?.harnessJson as HarnessRecord | null
    const continuity = record?.facts?.continuity
    const sourceRun = audience === 'owner' && task.handoff && this.ctx.store.repos.runs.get(task.handoff.fromRunId)
    const harness = info || sourceRun ? { fromRunId: run?.id ?? task.handoff!.fromRunId, board: info?.boardChanges ?? [], verification: info?.verification, tamperTotal: info?.tamper?.total ?? 0,
      warnings: [...(info?.boardWarnings ?? []).map(w => w === 'UNSAFE' ? 'BOARD_UNSAFE' : w),
        ...(info?.tamper ? ['TAMPER_RISK'] : []),
        ...(info?.readonlyCheck === 'violation' ? ['READONLY_VIOLATION：只读任务修改了工作区文件'] : []),
        ...(continuity ? ['工作区存在穿插或历史状态未知'] : [])],
      handoffTargets: worker?.adapters.filter(a => a.status === 'ready' && worker.workspaces.find(w => w.id === workspaceId)?.allowedAdapters.includes(a.id)).map(a => a.id) ?? [],
      ...(task.handoff && sourceRun && { handoffFrom: { taskNo: task.handoff.fromTaskNo, adapter: sourceRun.adapter, intent: task.handoff.intent } }) } : undefined
    if (role === 'review_card') return renderOwnerReviewCard({ ...model, ...(harness && { harness }) }, record?.gated)
    if (role === 'approval_card') {
      const workers = this.ctx.orchestrator.listWorkers()
      return renderApprovalCard(model, { harness: task.requester.type === 'requester' && workers.some(w => w.protocolCapabilities?.includes('blackboard.v1') && w.workspaces.some(ws => ws.id === workspaceId)),
        workspaces: workers.flatMap(w => w.workspaces.map(v => v.id)),
        adapters: workers.flatMap(w => w.adapters.map(v => v.id)), profiles: task.requester.type === 'owner' ? ['readonly', 'edit', 'full'] : ['readonly', 'edit'] })
    }
    return renderProgressCard({ ...model, ...(harness && { harness }), ...(Array.isArray(files) && { filesChanged: files.length }) }, audience)
  }
  desired(id: string, role: Binding['role'], audience: Audience) {
    const row = this.ctx.store.repos.tasks.get(id)!
    const actor: Actor = { type: audience, channel: 'feishu', id: row.requesterId }
    const task = this.ctx.orchestrator.getTask(id, actor)!
    return { card: this.render(task, role, audience), version: task.version, terminal: terminal(task.status) }
  }
  onProgress(id: string, runId: string, events: StoredEvent[]) {
    if (this.ctx.store.repos.tasks.get(id)?.source !== 'feishu') return
    const recent = this.progress.get(id)
    const state = recent?.runId === runId ? recent : { runId, at: 0, owner: [], requester: [] }
    let changed = false
    for (const audience of ['owner', 'requester'] as const) {
      const lines = extractProgress(events, audience)
      if (lines.length) { state[audience] = [...state[audience], ...lines].slice(-5); changed = true }
    }
    if (!changed) return
    state.at = this.ctx.clock.now()
    this.progress.delete(id)
    this.progress.set(id, state)
    if (this.progress.size > 2000) this.progress.delete(this.progress.keys().next().value!)
    this.refresh(id, false)
  }
  refresh(id: string, high: boolean) {
    for (const row of this.ctx.store.repos.feishu.messages(id)) {
      if (row.dead || !row.audience || !['progress_card', 'approval_card', 'review_card'].includes(row.role)) continue
      if ((row.role === 'approval_card' || row.role === 'review_card') && !this.config.ownerOpenIds.includes(row.chatId)) {
        this.updater.forget(row.messageId)
        continue
      }
      const desired = this.desired(id, row.role, row.audience)
      if (row.cardTaskVersion !== desired.version && row.cardHash === stableHash(desired.card)) {
        this.update(row.messageId, { cardTaskVersion: desired.version })
      }
      const age = this.ctx.clock.now() - (row.lastPatchedAt ?? row.createdAt)
      this.updater.desire(row.messageId, desired, high, row.cardHash, Date.now() - age)
    }
  }
  async ensure(id: string) {
    await this.mutex.runExclusive(id, async () => {
      if (this.closed) return
      const task = this.ctx.orchestrator.getTask(id)
      const source = task?.origin.feishu
      if (!task || !source) return
      if (source.chatType === 'p2p') this.privateChats.set(source.chatId, task.requester.id)
      const audience = task.requester.type === 'owner' && source.chatType === 'p2p' ? 'owner' : 'requester'
      this.bind({ ...source, taskId: id, role: 'request', senderOpenId: task.requester.id, audience, createdAt: task.createdAt })
      const messages = this.ctx.store.repos.feishu.messages(id)
      const sendCard = async (role: CardRole, to?: string) => {
        const chatId = to ?? source.chatId
        const previous = messages.filter(row => row.role === role && row.chatId === chatId)
        if (previous.some(row => !row.dead) || (previous.length && terminal(task.status))) return
        const target = to ? 'owner' : audience
        const desired = this.desired(id, role, target)
        const body = { type: 'interactive', card: desired.card } as const
        const uuid = stableHash([role, id, chatId, previous.length]).slice(0, 48)
        const sent = to ? await this.dm(to, body, uuid) : await this.reply(chatId, source.messageId, body, uuid)
        if (this.closed) return
        this.bind({ messageId: sent.messageId, taskId: id, role, chatId, chatType: to ? 'p2p' : source.chatType,
          audience: target, cardHash: stableHash(desired.card), cardTaskVersion: desired.version, createdAt: this.ctx.clock.now() })
      }
      await sendCard('progress_card')
      if (this.closed) return
      const latest = this.ctx.orchestrator.getTask(id)!
      const role = latest.status === 'awaiting_approval' ? 'approval_card' :
        latest.resultDeliveryStatus === 'pending_review' ? 'review_card' : undefined
      if (role) for (const to of new Set(this.config.ownerOpenIds)) await sendCard(role, to)
      const bindings = this.ctx.store.repos.feishu.messages(id)
      const progress = bindings.find(m => m.role === 'progress_card' && !m.dead)
      if (latest.status === 'succeeded' && ['not_required', 'delivered'].includes(latest.resultDeliveryStatus) &&
        (!progress || progress.cardTaskVersion === latest.version) && !bindings.some(row => row.role === 'result_text')) {
        const result = displayText(this.scrub(latest.resultSummary ?? ''), audience)
        if (!progress || result.length > this.config.card.cardResultMaxChars) {
          const link = result.length > 25000 && audience === 'owner' ? '\n' + this.publicUrl + '/tasks/' + id : ''
          const body = { type: 'text', text: result.slice(0, 25000 - link.length) + link } as const
          const sent = await this.reply(source.chatId, source.messageId, body, stableHash(['result', id]).slice(0, 48))
          if (this.closed) return
          this.bind({ messageId: sent.messageId, taskId: id, role: 'result_text', chatId: source.chatId, chatType: source.chatType, audience, createdAt: this.ctx.clock.now() })
        }
      }
      this.refresh(id, true)
    })
  }
  async deliver(id: string) {
    await this.ensure(id)
    // The orchestrator persists deliveredAt only after the target card was actually updated.
    const deadline = Date.now() + 5000
    while (!this.closed) {
      const bindings = this.ctx.store.repos.feishu.messages(id)
      const progress = bindings.find(m => m.role === 'progress_card' && !m.dead)
      if (progress && progress.cardTaskVersion === this.ctx.store.repos.tasks.get(id)?.version) {
        await this.ensure(id)
        return
      }
      if (!progress && bindings.some(row => row.role === 'result_text')) return
      if (Date.now() >= deadline) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('Feishu result delivery pending')
  }
  close() { this.closed = true; this.sender.close(); this.updater.close() }
}
