import { canUseCommand, parseCommand, parseMethodMention } from '@agent-hub/protocol'
import type { Actor, AdapterId, MethodSuggestion, ParsedCommand, TaskOrigin, TaskStatus } from '@agent-hub/protocol'
import { lt, eq, and } from 'drizzle-orm'
import type { HubConfig } from '../../config/schema.js'
import { guardAsync } from '../../kernel/safe.js'
import { HubError } from '../../services/errors.js'
import { feishuEventDedupe } from '../store-sqlite/schema.js'
import type { CardDelivery } from './delivery.js'
import type { FeishuMessageEvent } from './transport.js'
import { renderAutopilotProposalCard, renderBriefingCard, renderMethodSuggestionCard, renderWorkersCard, renderTaskListCard, terminal } from './cards/index.js'
import { createSuggestion, findMethodByName, listMethods, suggestFor } from '../orchestrator/methods.js'
import { controlProject } from '../orchestrator/personal-controls.js'
import { projectViews } from '../orchestrator/personal-status.js'
import type { CreateTaskInput, InitialArtifact } from '../../services/orchestrator.js'
import { extractInboundContent, resolveInboundMedia } from './multimodal.js'
import { claimProposal, classifyAndRoute, createProposal, getChatState, getProposalByMessageId, latestPendingProposal, releaseProposal, resolveExplicitProjectTarget, resolveProjectFromText, saveChatState, setProposalMessageId } from './smart-router.js'

export const METHOD_SUGGESTION_TTL_MS = 600_000

export function identity(config: HubConfig['feishu'], openId: string, chatId: string, group: boolean) {
  if (config.ownerOpenIds.includes(openId)) return 'owner'
  if (config.requesterAllowlist.includes(openId) || (group && config.requesterPolicy === 'chat' && config.allowedChatIds.includes(chatId))) return 'requester'
  return 'unauthorized'
}
const help = (owner: boolean) => '直接发送需求，或使用 /run、/status、/tasks、/cancel、/project、/briefing、/help、/whoami' +
  (owner ? '、/auto、/workers、/approve、/reject、/retry、/drain、/handoff、/fix、/accept' : '')
const active: TaskStatus[] = ['awaiting_approval', 'queued', 'dispatching', 'running', 'awaiting_input', 'cancelling']
type RunFlags = Extract<ParsedCommand, { name: 'run' }>['flags']

export class MessageRouter {
  draining = false
  private staleCount = 0
  private staleTimer?: ReturnType<typeof setTimeout>
  constructor(private delivery: CardDelivery, private botId: string, private startedAt: number, public maxChars: number) {}
  close() { clearTimeout(this.staleTimer) }
  private stale() {
    this.staleCount++
    if (this.staleTimer) return
    this.staleTimer = setTimeout(() => {
      const count = this.staleCount
      this.staleCount = 0
      delete this.staleTimer
      for (const id of new Set(this.delivery.config.ownerOpenIds)) void guardAsync(this.delivery.ctx,
        this.delivery.dm(id, { type: 'text', text: '已忽略 ' + count + ' 条启动前积压消息' }), 'stale message summary')
    }, 100)
  }
  async handle(event: FeishuMessageEvent) {
    const { delivery } = this
    const { ctx, config } = delivery
    const { sender, message: m } = event
    const now = ctx.clock.now()
    const fresh = ctx.store.tx(db => {
      const first = db.feishu.recordEvent({ key: 'evt:' + event.event_id, receivedAt: now })
      if (!first) return false
      return db.feishu.recordEvent({ key: 'msg:' + m.message_id, receivedAt: now })
    })
    const id = sender.sender_id.open_id
    if (!fresh || sender.sender_type !== 'user' || !id) return
    if (m.create_time < this.startedAt - config.staleMessageMs) { this.stale(); return }
    const group = m.chat_type === 'group'
    if (group && !m.mentions?.some(mention => mention.id.open_id === this.botId)) return
    if (!group) delivery.privateChats.set(m.chat_id, id)
    const reply = async (text: string) => { await delivery.reply(m.chat_id, m.message_id, { type: 'text', text }) }
    if (this.draining) return reply('系统维护中，请稍后重试')
    const inbound = extractInboundContent(m)
    const rawText = inbound.text?.replace(/@_user_\d+\b/g, '').trim()
    const role = identity(config, id, m.chat_id, group)
    const parsed = rawText?.startsWith('/') && !/^\/m\s/u.test(rawText) ? parseCommand(rawText) : undefined
    if (parsed?.ok && parsed.cmd.name === 'whoami' && canUseCommand(parsed.cmd, role, m.chat_type)) return reply(id)
    if (role === 'unauthorized') {
      if (!group && ctx.store.tx(db => {
        const key = 'denied:' + id
        db.delete(feishuEventDedupe).where(and(eq(feishuEventDedupe.key, key), lt(feishuEventDedupe.receivedAt, now - 86400000 + 1))).run()
        return db.feishu.recordEvent({ key, receivedAt: now })
      })) await reply('暂无使用权限，请联系管理员')
      return
    }
    let text = rawText
    let inboundArtifacts: InitialArtifact[] = []
    if (config.multimodal.enabled && (rawText === undefined || inbound.resources.length > 0)) {
      const media = await resolveInboundMedia(delivery.transport, m, inbound, config.multimodal, delivery.scrub)
      if (media.error) return reply(media.error)
      text = media.prompt
      inboundArtifacts = media.attachments.map(a => ({
        kind: a.kind,
        label: a.name,
        mimeType: a.mimeType,
        data: a.data,
        ...(a.transcript && { meta: { transcript: a.transcript } }),
      }))
    }
    if (text === undefined) return reply('暂仅支持文本需求')
    const privileged = role === 'owner' || config.permissions.allowRequesterCommands
    if (!text) return reply(help(privileged))
    if (text.length > this.maxChars) return reply('需求过长')
    const actor: Actor = { id, type: role, channel: 'feishu' }
    const origin: TaskOrigin = { source: 'feishu', feishu: { chatId: m.chat_id, chatType: m.chat_type, messageId: m.message_id } }
    const api = ctx.orchestrator
    const smart = config.smartRouting
    const threadKey = m.root_id ?? ''
    const remembered = smart.enabled ? getChatState(ctx.store.repos, m.chat_id, threadKey) : undefined
    let cachedProjects: ReturnType<typeof api.listProjects> | undefined
    const getProjects = () => (cachedProjects ??= api.listProjects())
    const resolveTarget = (prompt: string, flags: RunFlags): { input?: CreateTaskInput; error?: string; routeInfo?: { intent: string; workspaceId: string; subdir?: string; adapter?: AdapterId; profile: CreateTaskInput['profile'] } } => {
      const defaults = config.chatDefaults[m.chat_id]
      if (!privileged && flags.profile) return { error: '仅负责人可指定权限档位' }
      const resolvedMatch = smart.enabled && !flags.ws && !flags.dir ? resolveProjectFromText(prompt, getProjects()) : {}
      if (resolvedMatch.ambiguous?.length) {
        return { error: '项目名称存在歧义，请使用完整路径指定：' + resolvedMatch.ambiguous.join('、') }
      }
      const matched = resolvedMatch.match
      let targetWs: string | undefined
      let targetSubdir: string | undefined
      if (flags.ws) {
        targetWs = flags.ws
        targetSubdir = flags.dir
      } else if (flags.dir) {
        targetWs = matched?.workspaceId ?? remembered?.workspaceId ?? defaults?.workspaceId ?? config.defaultWorkspaceId
        targetSubdir = flags.dir
      } else if (matched) {
        targetWs = matched.workspaceId
        targetSubdir = matched.subdir
      } else if (remembered?.workspaceId) {
        targetWs = remembered.workspaceId
        targetSubdir = remembered.subdir ?? undefined
      } else if (defaults?.workspaceId) {
        targetWs = defaults.workspaceId
        targetSubdir = defaults.subdir ?? undefined
      } else {
        targetWs = config.defaultWorkspaceId
        targetSubdir = undefined
      }
      const workspaceId = targetWs
      if (!workspaceId) {
        return { error: '请指定工作区。可用工作区：' + [...new Set(api.listWorkers().flatMap(w => w.workspaces.map(ws => ws.id)))].join('、') }
      }
      const subdir = targetSubdir
      let decision: ReturnType<typeof classifyAndRoute> | undefined
      if (smart.enabled) {
        const wsProjects = getProjects()
        const projectMeta = wsProjects.find(p => p.workspaceId === workspaceId && (p.subdir ?? undefined) === subdir) ??
          wsProjects.find(p => p.workspaceId === workspaceId && !p.subdir)
        const rawAllowed = projectMeta?.allowedAdapters ?? []
        const onlineReady = new Set(
          api.listWorkers()
            .filter(w => w.connection === 'online' && w.workspaces.some(ws => ws.id === workspaceId))
            .flatMap(w => w.adapters.filter(a => a.status === 'ready').map(a => a.id)),
        )
        const allowedAdapters = onlineReady.size ? rawAllowed.filter(a => onlineReady.has(a)) : rawAllowed
        if (!flags.cli && !defaults?.adapter) {
          decision = classifyAndRoute(prompt, allowedAdapters, role === 'owner', { autoSelectAdapter: smart.autoSelectAdapter, proposeAutopilot: smart.proposeAutopilot })
        } else if (smart.proposeAutopilot) {
          decision = classifyAndRoute(prompt, allowedAdapters, role === 'owner', { autoSelectAdapter: false, proposeAutopilot: true })
        }
      }
      const adapter = flags.cli ?? defaults?.adapter ?? decision?.recommendedAdapter
      const profile = flags.profile ?? defaults?.profile ?? (smart.enabled ? decision?.recommendedProfile : undefined) ?? config.defaultProfile ?? 'edit'
      return {
        input: {
          prompt, origin, workspaceId, ...(subdir && { subdir }), profile,
          ...(adapter && { adapter }), ...(flags.worker && { requiredWorkerId: flags.worker }),
          ...(flags.priority !== undefined && { priority: flags.priority }),
        },
        routeInfo: { intent: decision?.intent ?? 'standard', workspaceId, ...(subdir && { subdir }), ...(adapter && { adapter }), profile },
      }
    }
    const buildInput = (prompt: string, flags: RunFlags): CreateTaskInput | string => {
      const resolved = resolveTarget(prompt, flags)
      return resolved.error ?? resolved.input!
    }
    const create = async (prompt: string, flags: RunFlags = {}, method?: { id: string; via: 'named' | 'suggested' }) => {
      const resolved = resolveTarget(prompt, flags)
      if (resolved.error || !resolved.input) return reply(resolved.error ?? '无法解析目标项目')
      const input = resolved.input
      const opts = {
        ...(method && { methodVia: method.via }),
        ...(inboundArtifacts.length && { initialArtifacts: inboundArtifacts }),
      }
      const task = await api.createTask({ ...input, ...(method && { methodId: method.id }) }, actor, opts)
      if (smart.enabled && smart.rememberProject) {
        saveChatState(ctx.store.repos, m.chat_id, threadKey, {
          workspaceId: input.workspaceId,
          subdir: input.subdir ?? null,
          lastTaskId: task.id,
          lastMessageId: m.message_id,
        }, now)
      }
      await delivery.ensure(task.id)
    }
    // 方法库推荐（docs/specs/10）：先发确认卡，用户点「用 / 不用」后才创建任务
    const suggest = async (top: MethodSuggestion, prompt: string) => {
      const input = buildInput(prompt, {})
      if (typeof input === 'string') return reply(input)
      const serialized = inboundArtifacts.length
        ? { ...input, _initialArtifacts: inboundArtifacts.map(a => ({ kind: a.kind, label: a.label, mimeType: a.mimeType, dataBase64: a.data.toString('base64'), ...(a.meta !== undefined && { meta: a.meta }) })) }
        : input
      const now = ctx.clock.now()
      const suggestionId = ctx.store.tx(db => createSuggestion(db, { method_id: top.id, actor_json: JSON.stringify(actor), input_json: JSON.stringify(serialized),
        chat_id: m.chat_id, message_id: m.message_id, created_at: now, expires_at: now + METHOD_SUGGESTION_TTL_MS }))
      await delivery.reply(m.chat_id, m.message_id, { type: 'interactive', card: renderMethodSuggestionCard({ id: suggestionId, name: top.name, scenario: top.scenario, prompt }) })
    }
    const startNew = async (prompt: string) => {
      const mention = parseMethodMention(prompt)
      if (mention) {
        const card = ctx.store.tx(db => findMethodByName(db, mention.name))
        if (!card) {
          const names = ctx.store.tx(db => listMethods(db)).map(item => '『' + item.name + '』').slice(0, 10)
          return reply('没有找到方法『' + mention.name + '』' + (names.length ? '。现有方法：' + names.join('、') : '，方法库还是空的'))
        }
        return create(mention.prompt, {}, { id: card.id, via: 'named' })
      }
      if (smart.enabled) {
        const parentProp = m.parent_id ? getProposalByMessageId(ctx.store.repos, m.chat_id, m.parent_id) : undefined
        const latest = parentProp ? { proposal: parentProp } : latestPendingProposal(ctx.store.repos, m.chat_id, now, threadKey)
        const pending = latest.proposal
        if (latest.ambiguous && /^(干|开始|确认|行|go|yes|ok|启动|不用|算了|取消|no|cancel|[1-9])$/iu.test(prompt)) {
          return await reply('当前有多个待确认建议，请直接引用对应卡片回复或点击卡片按钮')
        }
        if (pending && pending.kind === 'autopilot' && pending.actorOpenId === id && (!pending.expiresAt || pending.expiresAt >= now)) {
          if (/^(干|开始|确认|行|go|yes|ok|启动)$/iu.test(prompt)) {
            const claim = ctx.store.tx(db => claimProposal(db, pending.id, now, 'accepted'))
            if (claim === 'claimed') {
              const p = pending.payload as { workspaceId: string; subdir?: string; prompt: string }
              let res: Awaited<ReturnType<typeof api.startAutopilot>>
              try {
                res = await api.startAutopilot({
                  projectId: 'aut_' + pending.id.slice(-16).toLowerCase(),
                  workspaceId: p.workspaceId, ...(p.subdir && { subdir: p.subdir }),
                  inlinePrompt: p.prompt, autoCommit: true, autoPush: false, notifyFeishuChatId: m.chat_id, boardSync: true,
                }, actor, origin)
              } catch (error) {
                ctx.store.tx(db => releaseProposal(db, pending.id))
                throw error
              }
              await delivery.ensure(res.task.id).catch(() => undefined)
              return await reply(`🚀 已启动自动交付 (${res.projectId})，规划任务 #${res.task.taskNo}`)
            }
          } else if (/^(不用|算了|取消|no|cancel)$/iu.test(prompt)) {
            ctx.store.tx(db => claimProposal(db, pending.id, now, 'dismissed'))
            return await reply('好的，已取消自动交付建议')
          }
        }
        if (pending && pending.kind === 'briefing' && /^[1-9]$/u.test(prompt) && (!pending.expiresAt || pending.expiresAt >= now)) {
          if (!privileged || (group && !config.allowGroupCommands && role !== 'owner')) {
            return await reply('无权执行此指令')
          }
          const idx = Number(prompt)
          const p = pending.payload as { briefingId: string }
          const dispatched = await api.dispatchBriefingAction(p.briefingId, idx, actor, {
            origin,
            idempotencyKey: 'brf:' + p.briefingId + ':' + idx,
          })
          await delivery.ensure(dispatched.id).catch(() => undefined)
          return await reply(`✅ 已按简报建议 #${idx} 派发任务 #${dispatched.taskNo}`)
        }
      }
      if (config.methodSuggestions) {
        const [top] = ctx.store.tx(db => suggestFor(db, prompt))
        if (top) return suggest(top, prompt)
      }
      if (smart.enabled && !inboundArtifacts.length) {
        const resolved = resolveTarget(prompt, {})
        if (resolved.error || !resolved.input || !resolved.routeInfo) return reply(resolved.error ?? '无法解析项目')
        if (resolved.routeInfo.intent === 'autopilot_candidate') {
          const proposalId = ctx.store.tx(db => createProposal(db, {
            kind: 'autopilot',
            chatId: m.chat_id,
            actorOpenId: id,
            payload: {
              workspaceId: resolved.routeInfo!.workspaceId,
              ...(resolved.routeInfo!.subdir && { subdir: resolved.routeInfo!.subdir }),
              prompt,
              ...(resolved.routeInfo!.adapter && { adapter: resolved.routeInfo!.adapter }),
              profile: resolved.routeInfo!.profile,
              chatType: m.chat_type,
              threadId: threadKey,
            },
            now,
          }))
          try {
            const sent = await delivery.reply(m.chat_id, m.message_id, {
              type: 'interactive',
              card: renderAutopilotProposalCard({ id: proposalId, workspaceId: resolved.routeInfo.workspaceId, ...(resolved.routeInfo.subdir && { subdir: resolved.routeInfo.subdir }), prompt, ...(resolved.routeInfo.adapter && { adapter: resolved.routeInfo.adapter }) }),
            })
            if (sent?.messageId) ctx.store.tx(db => setProposalMessageId(db, proposalId, sent.messageId))
            else ctx.store.tx(db => claimProposal(db, proposalId, now, 'dismissed'))
          } catch (error) {
            ctx.store.tx(db => claimProposal(db, proposalId, now, 'dismissed'))
            throw error
          }
          return
        }
      }
      return create(prompt)
    }
    const get = (ref: string) => {
      const task = api.getTask(ref, actor)
      if (!task) throw new HubError('TASK_NOT_FOUND', 404)
      if (role !== 'owner' && task.requester.id !== id) throw new HubError('FORBIDDEN', 403)
      return task
    }
    try {
      if (parsed) {
        if (!parsed.ok) return await reply(parsed.error + '。用法：' + parsed.usage)
        const cmd = parsed.cmd
        if (!canUseCommand(cmd, role, m.chat_type, { ...config.permissions, allowGroupCommands: config.allowGroupCommands })) return await reply(cmd.name === 'whoami' ? '请私聊使用 /whoami' : '无权执行此指令')
        const audience = group ? delivery.groupAudience(m.chat_id) : role
        switch (cmd.name) {
          case 'help': return await reply(help(privileged))
          case 'whoami': return
          case 'run':
          case 'handoff': {
            if (cmd.name === 'run' && !cmd.flags.from) return await create(cmd.prompt, cmd.flags)
            const binding = (m.parent_id && delivery.binding(m.parent_id)) || (m.root_id && delivery.binding(m.root_id))
            const ref = cmd.flags.from ?? (binding && binding.taskId)
            if (!ref) return await reply('请引用任务卡片或指定 --from')
            const from = ref.startsWith('run_') ? ctx.store.repos.runs.get(ref) : undefined
            if (ref.startsWith('run_') && !from) throw new HubError('RUN_NOT_FOUND', 404)
            const child = await api.handoff(from?.taskId ?? ref, actor, { intent: 'relay', origin, ...(from && { fromRunId: from.id }),
              ...(cmd.flags.cli && { adapter: cmd.flags.cli }), ...(cmd.prompt && { prompt: cmd.prompt }),
              ...(cmd.name === 'run' && cmd.flags.priority !== undefined && { priority: cmd.flags.priority }),
              ...(cmd.name === 'run' && cmd.flags.worker && { requiredWorkerId: cmd.flags.worker }),
              ...(cmd.name === 'run' && cmd.flags.profile && { profile: cmd.flags.profile }) },
              inboundArtifacts.length ? { initialArtifacts: inboundArtifacts } : undefined)
            await delivery.ensure(child.id)
            return await reply('已创建接力任务 #' + child.taskNo)
          }
          case 'fix': {
            const source = get(cmd.taskRef)
            const child = await api.handoff(source.id, actor, { intent: 'fix', expectedVersion: source.version, origin },
              inboundArtifacts.length ? { initialArtifacts: inboundArtifacts } : undefined)
            await delivery.ensure(child.id)
            return await reply('已创建修复任务 #' + child.taskNo)
          }
          case 'accept': {
            const task = get(cmd.taskRef)
            const run = task.runs[0]
            if (!run) throw new HubError('RUN_NOT_FOUND', 404)
            const pointer = ctx.store.repos.pointers.get(run.workerId, run.workspaceId)
            await api.acceptRun(run.workerId, run.workspaceId, actor, { runId: run.id, expectedAcceptedRunId: pointer?.lastAcceptedRunId ?? null })
            return await reply('已采纳任务 #' + task.taskNo)
          }
          case 'workers':
            await delivery.reply(m.chat_id, m.message_id, { type: 'interactive', card: renderWorkersCard(api.listWorkers(), config.card.cardMaxBytes) })
            return
          case 'drain': await api.setWorkerDrain(cmd.workerId, cmd.on, actor); return await reply('已更新节点 Drain 状态')
          case 'project': {
            const projects = api.listProjects()
            if (!cmd.target) {
              const cur = getChatState(ctx.store.repos, m.chat_id, threadKey)
              const list = projects.filter(p => p.subdir).map(p => `${p.workspaceId}/${p.subdir}`).join('、') ||
                projects.map(p => p.workspaceId).join('、')
              return await reply(`当前锁定：${cur?.workspaceId ? (cur.subdir ? `${cur.workspaceId}/${cur.subdir}` : cur.workspaceId) : '未锁定'}\n可用项目：${list || '暂无'}`)
            }
            if (cmd.target === 'clear') {
              ctx.store.tx(db => saveChatState(db, m.chat_id, threadKey, { workspaceId: null, subdir: null }, now))
              return await reply('已清除当前会话的项目锁定')
            }
            const resolvedTarget = resolveExplicitProjectTarget(cmd.target, projects)
            if (resolvedTarget.ambiguous?.length) {
              return await reply('项目名称存在歧义，请使用完整路径指定：' + resolvedTarget.ambiguous.join('、'))
            }
            const matched = resolvedTarget.match
            if (!matched) return await reply('未找到项目：' + cmd.target)
            ctx.store.tx(db => saveChatState(db, m.chat_id, threadKey, { workspaceId: matched.workspaceId, subdir: matched.subdir ?? null }, now))
            return await reply('已锁定当前会话项目：' + (matched.subdir ? `${matched.workspaceId}/${matched.subdir}` : matched.workspaceId))
          }
          case 'briefing': {
            const projects = api.listProjects()
            let filterWorkspace: string | undefined
            let filterSubdir: string | undefined
            if (cmd.target) {
              const resolvedTarget = resolveExplicitProjectTarget(cmd.target, projects)
              if (resolvedTarget.ambiguous?.length) {
                return await reply('项目名称存在歧义，请使用完整路径指定：' + resolvedTarget.ambiguous.join('、'))
              }
              const matched = resolvedTarget.match
              if (!matched) return await reply('未找到项目：' + cmd.target)
              filterWorkspace = matched.workspaceId
              filterSubdir = matched.subdir ?? ''
            } else if (role !== 'owner') {
              const defaults = config.chatDefaults[m.chat_id]
              const chatLock = getChatState(ctx.store.repos, m.chat_id, threadKey)
              const fallback = chatLock?.workspaceId
                ? { workspaceId: chatLock.workspaceId, subdir: chatLock.subdir ?? undefined }
                : defaults?.workspaceId
                  ? { workspaceId: defaults.workspaceId, subdir: defaults.subdir ?? undefined }
                  : config.defaultWorkspaceId
                    ? { workspaceId: config.defaultWorkspaceId, subdir: undefined }
                    : undefined
              if (!fallback?.workspaceId) return await reply('请指定项目名称：/briefing <项目名>')
              filterWorkspace = fallback.workspaceId
              filterSubdir = fallback.subdir
            }
            const briefings = api.runBriefing('manual', {
              ...(filterWorkspace && { workspaceId: filterWorkspace }),
              ...(filterSubdir !== undefined && { subdir: filterSubdir }),
            })
            if (!briefings.length) return await reply('暂无可巡检的项目')
            for (const b of briefings.slice(0, 3)) {
              const propId = b.actions.length && audience === 'owner'
                ? ctx.store.tx(db => createProposal(db, { kind: 'briefing', chatId: m.chat_id, actorOpenId: id, payload: { briefingId: b.id, chatType: m.chat_type, threadId: threadKey }, now }))
                : undefined
              try {
                const sent = await delivery.reply(m.chat_id, m.message_id, { type: 'interactive', card: renderBriefingCard(b, propId, audience) })
                if (propId) {
                  if (sent?.messageId) ctx.store.tx(db => setProposalMessageId(db, propId, sent.messageId))
                  else ctx.store.tx(db => claimProposal(db, propId, now, 'dismissed'))
                }
              } catch (error) {
                if (propId) ctx.store.tx(db => claimProposal(db, propId, now, 'dismissed'))
                throw error
              }
            }
            return
          }
          case 'auto': {
            if (cmd.action === 'status') {
              const views = projectViews(ctx.store.repos)
              if (!views.length) return await reply('暂无自动交付项目')
              const lines = views.slice(0, 5).map(v => `• ${v.id} [${v.subdir ?? v.workspaceId}]：${v.phase}${v.currentItem ? ' · ' + v.currentItem : ''}${v.reason ? ' (' + v.reason + ')' : ''}`)
              return await reply(lines.join('\n'))
            }
            if (cmd.action === 'pause' || cmd.action === 'resume' || cmd.action === 'stop') {
              const views = projectViews(ctx.store.repos)
              const activeViews = views.filter(v => !['done', 'stopped'].includes(v.phase))
              let target = cmd.targetId
              if (!target) {
                const defaults = config.chatDefaults[m.chat_id]
                const scopeSource = remembered?.workspaceId
                  ? { workspaceId: remembered.workspaceId, subdir: remembered.subdir ?? null }
                  : defaults?.workspaceId
                    ? { workspaceId: defaults.workspaceId, subdir: defaults.subdir ?? null }
                    : config.defaultWorkspaceId
                      ? { workspaceId: config.defaultWorkspaceId, subdir: null }
                      : undefined
                const wsScope = scopeSource?.workspaceId
                const dirScope = scopeSource?.subdir ?? null
                const scoped = wsScope
                  ? activeViews.filter(v => v.workspaceId === wsScope && (v.subdir ?? null) === dirScope)
                  : activeViews
                if (wsScope && scoped.length === 0) {
                  if (activeViews.length) {
                    return await reply(`当前项目下暂无运行中的自动交付项目；其他活跃项目：${activeViews.map(v => v.id).join('、')}，请使用 /auto ${cmd.action} <projectId>`)
                  }
                  return await reply('当前没有运行中的自动交付项目')
                }
                if (scoped.length > 1) {
                  return await reply(`当前有多个进行中的自动交付项目：${scoped.map(v => v.id).join('、')}，请使用 /auto ${cmd.action} <projectId>`)
                }
                target = scoped[0]?.id
              }
              if (!target) return await reply('当前没有运行中的自动交付项目')
              await controlProject(ctx, target, cmd.action, actor)
              return await reply(`已发送指令：${cmd.action} (${target})`)
            }
            if (cmd.doc && cmd.prompt) return await reply('参数 --doc 与文字目标不可同时使用，请二选一')
            const resolved = resolveTarget(cmd.prompt ?? cmd.doc ?? '', cmd.dir ? { dir: cmd.dir } : {})
            if (resolved.error || !resolved.input) return await reply(resolved.error ?? '请先指定工作区或项目')
            const started = await api.startAutopilot({
              workspaceId: resolved.input.workspaceId,
              ...(resolved.input.subdir && { subdir: resolved.input.subdir }),
              ...(cmd.doc ? { sources: [cmd.doc] } : { inlinePrompt: cmd.prompt! }),
              autoCommit: true,
              autoPush: !!cmd.push,
              notifyFeishuChatId: m.chat_id,
              boardSync: true,
            }, actor, origin)
            await delivery.ensure(started.task.id).catch(() => undefined)
            return await reply(`🚀 已启动自动交付 ${started.projectId}，规划任务 #${started.task.taskNo}`)
          }
          case 'tasks': case 'status': {
            if (cmd.name === 'status' && cmd.taskRef) {
              const task = get(cmd.taskRef)
              const sent = await delivery.reply(m.chat_id, m.message_id, { type: 'interactive', card: delivery.render(task, 'reply', audience, m.chat_type) })
              delivery.bind({ ...origin.feishu!, messageId: sent.messageId, taskId: task.id, role: 'reply', audience, createdAt: now })
            } else {
              const status = cmd.name === 'tasks' ? cmd.status : active
              const mine = cmd.name === 'tasks' ? cmd.scope === 'mine' : role !== 'owner'
              const list = api.listTasks({ limit: 10, ...(status && { status }), ...(mine && { requesterId: id }) }, actor)
              await delivery.reply(m.chat_id, m.message_id, { type: 'interactive', card: renderTaskListCard(list.items, audience, config.card.cardMaxBytes) })
            }
            return
          }
          default: {
            const task = get(cmd.taskRef)
            const opts = { expectedVersion: task.version }
            if (cmd.name === 'reject') await api.reject(task.id, actor, { ...opts, reason: cmd.reason })
            else await api[cmd.name](task.id, actor, opts)
            return await reply('操作已完成')
          }
        }
      }
      const binding = (m.parent_id && delivery.binding(m.parent_id)) || (m.root_id && delivery.binding(m.root_id))
      if (!binding) return await startNew(text)
      const task = get(binding.taskId)
      if (task.status === 'awaiting_input' && task.inputRequest) {
        await api.provideInput(task.id, actor, { expectedVersion: task.version, requestId: task.inputRequest.requestId, answer: text })
        return await reply('已提交回答')
      }
      if (task.status === 'awaiting_approval' || task.status === 'rejected') return await reply('任务未执行，请直接发送新需求')
      if (!terminal(task.status)) return await reply('任务进行中，完成后再回复可继续对话')
      const child = await api.followUp(task.id, actor, { expectedVersion: task.version, prompt: text, origin },
        inboundArtifacts.length ? { initialArtifacts: inboundArtifacts } : undefined)
      await delivery.ensure(child.id)
      if (!task.runs.some(run => run.cliSessionId)) await reply('无法续接上下文，已新建关联任务')
    } catch (error) {
      if (!(error instanceof HubError)) throw error
      await reply(error.message)
    }
  }
}
