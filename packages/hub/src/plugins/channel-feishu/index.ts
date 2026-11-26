import type { Context } from 'cordis'
import { createRedactor } from '@agent-hub/common'
import { and, eq, or, gte, isNull, lt, inArray, sql } from 'drizzle-orm'
import type { HubConfig } from '../../config/schema.js'
import { guardAsync, safeOn } from '../../kernel/safe.js'
import { onHotUpdate } from '../../kernel/hot-update.js'
import { tasks, feishuMessages } from '../store-sqlite/schema.js'
import type { ConnectionState, FeishuTransport } from './transport.js'
import { CardDelivery } from './delivery.js'
import { ActionHandler } from './action-handler.js'
import { MessageRouter } from './router.js'
import { renderBriefingCard } from './cards/index.js'
import { claimProposal, createProposal, setProposalMessageId } from './smart-router.js'

export type ChannelConfig = HubConfig['feishu'] & { permissions: HubConfig['permissions']; appId: string; appSecret: string; maxPromptChars: number; redactionPatterns: string[]; stewardNotifyChatIds?: string[] }
export function channelFeishu(publicUrl: string, injected?: FeishuTransport, hubStatus?: () => { configError: string | null; restartRequired: boolean }) {
  let failed = false
  return { name: 'channel-feishu', inject: ['orchestrator', 'store', 'clock'],
    async apply(ctx: Context, config: ChannelConfig) {
      // A terminal SDK callback arrives outside Cordis initialization. Latch it
      // into the next initialization so the supervisor observes a failed fiber.
      if (failed) { failed = false; throw new Error('Feishu connection failed') }
      let closed = false, initialized = false, draining = false
      let drain: (() => Promise<void>) | undefined
      safeOn(ctx, 'hub/drain', async () => { draining = true; await drain?.() })
      let state: ConnectionState | undefined
      const status = (next: ConnectionState) => {
        if (state === next || closed) return
        state = next
        const feishu = { state: next, since: ctx.clock.now() }
        ctx.emit('feishu/status', feishu)
        ctx.emit('hub/status', { ...ctx.orchestrator.overview().hub, ...hubStatus?.(), feishu })
      }
      ctx.provide('feishu', { status: () => state ?? 'connecting' })
      status('connecting')
      try {
        const transport = injected ?? (await import('./transport.js')).createFeishuTransport(ctx, config)
        const delivery = new CardDelivery(ctx, transport, config, publicUrl)
        ctx.effect(() => () => { closed = true; delivery.close(); return transport.close() }, 'feishu:connection')
        let current = config
        delivery.scrub = text => createRedactor({ FEISHU_APP_SECRET: current.appSecret }, current.redactionPatterns)(text)
        const bot = await transport.botInfo()
        if (closed) return
        const router = new MessageRouter(delivery, bot.openId, ctx.orchestrator.overview().hub.startedAt, config.maxPromptChars)
        ctx.effect(() => () => router.close(), 'feishu:messages')
        const actions = new ActionHandler(delivery)
        const sync = async (id: string) => {
          if (ctx.store.repos.tasks.get(id)?.source !== 'feishu') return
          delivery.refresh(id, true)
          await delivery.ensure(id)
        }
        safeOn(ctx, 'task/transitioned', ({ task }) => sync(task.id))
        safeOn(ctx, 'task/result-delivery', sync)
        safeOn(ctx, 'run/events', (runId, id, events) => delivery.onProgress(id, runId, events))
        safeOn(ctx, 'personal/phase', async evt => {
          const targets = evt.notifyFeishuChatId ? [evt.notifyFeishuChatId] : current.autopilot.notifyChatIds
          if (!targets.length || closed) return
          const notable = new Set(['plan_ready', 'implementing', 'reviewing', 'blocked', 'done', 'stopped'])
          if (!notable.has(evt.phase)) return
          const labels: Record<string, string> = {
            plan_ready: '📝 规划完成，等待顾问评估',
            implementing: `🔨 开始实现 ${evt.currentItem ?? ''}`.trim(),
            reviewing: `🔍 进入代码审查 ${evt.currentItem ?? ''}`.trim(),
            blocked: `⚠️ 自动交付已阻塞：${evt.reason ?? '需人工查看'}`,
            done: '✅ 自动交付已完成并生成验收报告！',
            stopped: '🛑 自动交付已停止',
          }
          const msg = `[${evt.label}] ${labels[evt.phase] ?? evt.phase}`
          for (const chatId of new Set(targets)) {
            await transport.sendMessage({ idType: 'chat_id', id: chatId }, { type: 'text', text: msg }).catch(() => undefined)
          }
        })
        safeOn(ctx, 'steward/briefing', async (briefings, notifyFeishu) => {
          if (!notifyFeishu || closed) return
          const chatIds = current.stewardNotifyChatIds?.length
            ? current.stewardNotifyChatIds
            : current.autopilot.notifyChatIds.length
              ? current.autopilot.notifyChatIds
              : []
          const now = ctx.clock.now()
          for (const b of briefings.slice(0, 5)) {
            for (const chatId of new Set(chatIds)) {
              const audience = delivery.groupAudience(chatId)
              const propId = audience === 'owner' && b.actions.length
                ? ctx.store.tx(db => createProposal(db, { kind: 'briefing', chatId, actorOpenId: current.ownerOpenIds[0] ?? '', payload: { briefingId: b.id, chatType: 'group' }, now }))
                : undefined
              const sent = await transport.sendMessage({ idType: 'chat_id', id: chatId }, { type: 'interactive', card: renderBriefingCard(b, propId, audience) }).catch(() => undefined)
              if (propId) {
                if (sent?.messageId) ctx.store.tx(db => setProposalMessageId(db, propId, sent.messageId))
                else ctx.store.tx(db => claimProposal(db, propId, now, 'dismissed'))
              }
            }
          }
        })
        router.draining = draining
        drain = async () => { router.draining = true; await delivery.updater.flush() }
        onHotUpdate<ChannelConfig>(ctx, ['card', 'ownerOpenIds', 'requesterAllowlist', 'allowedChatIds', 'requesterPolicy',
          'permissions', 'deliveryMode', 'groupAudience', 'allowGroupCommands', 'defaultProfile', 'requesterReplyPolicy', 'defaultWorkspaceId', 'methodSuggestions', 'chatDefaults', 'multimodal', 'smartRouting', 'autopilot', 'stewardNotifyChatIds', 'maxPromptChars', 'staleMessageMs', 'redactionPatterns'], next => {
          current = next
          delivery.config = next
          router.maxChars = next.maxPromptChars
          delivery.updater.configure(next.card)
          recover()
        })
        function recover() {
          const staleBinding = sql`exists (select 1 from ${feishuMessages} where ${feishuMessages.taskId} = ${tasks.id}
            and ${feishuMessages.dead} = 0 and ${feishuMessages.role} in ('progress_card', 'approval_card', 'review_card')
            and coalesce(${feishuMessages.cardTaskVersion}, -1) < ${tasks.version})`
          const missingResult = current.deliveryMode === 'hybrid' ? and(lt(tasks.feishuResultVersion, tasks.version),
            inArray(tasks.resultDeliveryStatus, ['not_required', 'delivered'])) : undefined
          const pending = ctx.store.repos.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.source, 'feishu'),
            or(isNull(tasks.finishedAt), gte(tasks.finishedAt, ctx.clock.now() - 600000), staleBinding, missingResult,
              eq(tasks.resultDeliveryStatus, 'pending_review')))).all()
          for (const task of pending) void guardAsync(ctx, sync(task.id), 'recover Feishu card')
        }
        const onStatus = (next: ConnectionState) => {
          if (closed) return
          const reconnect = state === 'reconnecting' && next === 'connected'
          status(next)
          if (reconnect) recover()
          delivery.updater.setPaused(next !== 'connected')
          if (next === 'failed' && initialized) {
            failed = true
            void guardAsync(ctx, ctx.fiber.restart(), 'Feishu connection restart')
          }
        }
        delivery.updater.setPaused(true)
        await transport.start({ onMessage: async evt => { if (!closed) await router.handle(evt) },
          onCardAction: async evt => closed || draining ? { toast: { type: 'info', content: '系统维护中，请稍后重试' } } : actions.handle(evt), onStatus })
        if (closed) return
        onStatus(transport.status())
        if (transport.status() === 'failed') throw new Error('Feishu connection failed')
        initialized = true
        ctx.effect(() => ctx.orchestrator.setResultSender(row => delivery.deliver(row.id)), 'feishu:results')
        recover()
      } catch {
        status('failed')
        throw new Error('Feishu channel unavailable')
      }
    },
  }
}
