import { canUseCommand, parseCommand, parseMethodMention } from '@agent-hub/protocol'
import type { Actor, MethodSuggestion, ParsedCommand, TaskOrigin, TaskStatus } from '@agent-hub/protocol'
import { lt, eq, and } from 'drizzle-orm'
import type { HubConfig } from '../../config/schema.js'
import { guardAsync } from '../../kernel/safe.js'
import { HubError } from '../../services/errors.js'
import { feishuEventDedupe } from '../store-sqlite/schema.js'
import type { CardDelivery } from './delivery.js'
import type { FeishuMessageEvent } from './transport.js'
import { renderMethodSuggestionCard, renderWorkersCard, renderTaskListCard, terminal } from './cards/index.js'
import { createSuggestion, findMethodByName, listMethods, suggestFor } from '../orchestrator/methods.js'
import type { CreateTaskInput } from '../../services/orchestrator.js'

export const METHOD_SUGGESTION_TTL_MS = 600_000

export function identity(config: HubConfig['feishu'], openId: string, chatId: string, group: boolean) {
  if (config.ownerOpenIds.includes(openId)) return 'owner'
  if (config.requesterAllowlist.includes(openId) || (group && config.requesterPolicy === 'chat' && config.allowedChatIds.includes(chatId))) return 'requester'
  return 'unauthorized'
}
function content(message: FeishuMessageEvent['message']) {
  let value: unknown
  try { value = JSON.parse(message.content) } catch { return '' }
  if (message.message_type === 'text') {
    const text = (value as { text?: unknown } | null)?.text
    return typeof text === 'string' ? text : ''
  }
  if (message.message_type !== 'post') return undefined
  // Rich text may be localized or provided directly as a list of paragraphs.
  function visit(node: unknown): string {
    if (!node || typeof node !== 'object') return ''
    if (Array.isArray(node)) return node.map(visit).join(node.some(Array.isArray) ? '\n' : '')
    if ('tag' in node) return ['a', 'text'].includes(String(node.tag)) && 'text' in node && typeof node.text === 'string' ? node.text : ''
    if ('content' in node) return visit(node.content)
    return visit(Object.values(node)[0])
  }
  return visit(value)
}
const help = (owner: boolean) => '直接发送需求，或使用 /run、/status、/tasks、/cancel、/help、/whoami' +
  (owner ? '、/workers、/approve、/reject、/retry、/drain、/handoff、/fix、/accept' : '')
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
    const text = content(m)?.replace(/@_user_\d+\b/g, '').trim()
    const role = identity(config, id, m.chat_id, group)
    const parsed = text?.startsWith('/') && !/^\/m\s/u.test(text) ? parseCommand(text) : undefined
    if (parsed?.ok && parsed.cmd.name === 'whoami' && canUseCommand(parsed.cmd, role, m.chat_type)) return reply(id)
    if (role === 'unauthorized') {
      if (!group && ctx.store.tx(db => {
        const key = 'denied:' + id
        db.delete(feishuEventDedupe).where(and(eq(feishuEventDedupe.key, key), lt(feishuEventDedupe.receivedAt, now - 86400000 + 1))).run()
        return db.feishu.recordEvent({ key, receivedAt: now })
      })) await reply('暂无使用权限，请联系管理员')
      return
    }
    if (text === undefined) return reply('暂仅支持文本需求')
    const privileged = role === 'owner' || config.permissions.allowRequesterCommands
    if (!text) return reply(help(privileged))
    if (text.length > this.maxChars) return reply('需求过长')
    const actor: Actor = { id, type: role, channel: 'feishu' }
    const origin: TaskOrigin = { source: 'feishu', feishu: { chatId: m.chat_id, chatType: m.chat_type, messageId: m.message_id } }
    const api = ctx.orchestrator
    const buildInput = (prompt: string, flags: RunFlags): CreateTaskInput | string => {
      const defaults = config.chatDefaults[m.chat_id]
      if (!privileged && flags.profile) return '仅负责人可指定权限档位'
      const workspaceId = flags.ws ?? defaults?.workspaceId ?? config.defaultWorkspaceId
      if (!workspaceId) return '请指定工作区。可用工作区：' + [...new Set(api.listWorkers().flatMap(w => w.workspaces.map(ws => ws.id)))].join('、')
      const adapter = flags.cli ?? defaults?.adapter
      // 项目文件夹：--dir 优先；只有沿用群默认工作区时才沿用群默认项目
      const subdir = flags.dir ?? (flags.ws ? undefined : defaults?.subdir)
      return { prompt, origin, workspaceId, ...(subdir && { subdir }), profile: flags.profile ?? defaults?.profile ?? config.defaultProfile ?? 'edit',
        ...(adapter && { adapter }), ...(flags.worker && { requiredWorkerId: flags.worker }),
        ...(flags.priority !== undefined && { priority: flags.priority }) }
    }
    const create = async (prompt: string, flags: RunFlags = {}, method?: { id: string; via: 'named' | 'suggested' }) => {
      const input = buildInput(prompt, flags)
      if (typeof input === 'string') return reply(input)
      const task = await api.createTask({ ...input, ...(method && { methodId: method.id }) }, actor, method ? { methodVia: method.via } : {})
      await delivery.ensure(task.id)
    }
    // 方法库推荐（docs/specs/10）：先发确认卡，用户点「用 / 不用」后才创建任务
    const suggest = async (top: MethodSuggestion, prompt: string) => {
      const input = buildInput(prompt, {})
      if (typeof input === 'string') return reply(input)
      const now = ctx.clock.now()
      const id = ctx.store.tx(db => createSuggestion(db, { method_id: top.id, actor_json: JSON.stringify(actor), input_json: JSON.stringify(input),
        chat_id: m.chat_id, message_id: m.message_id, created_at: now, expires_at: now + METHOD_SUGGESTION_TTL_MS }))
      await delivery.reply(m.chat_id, m.message_id, { type: 'interactive', card: renderMethodSuggestionCard({ id, name: top.name, scenario: top.scenario, prompt }) })
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
      if (config.methodSuggestions) {
        const [top] = ctx.store.tx(db => suggestFor(db, prompt))
        if (top) return suggest(top, prompt)
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
              ...(cmd.name === 'run' && cmd.flags.profile && { profile: cmd.flags.profile }) })
            await delivery.ensure(child.id)
            return await reply('已创建接力任务 #' + child.taskNo)
          }
          case 'fix': {
            const source = get(cmd.taskRef)
            const child = await api.handoff(source.id, actor, { intent: 'fix', expectedVersion: source.version, origin })
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
      const child = await api.followUp(task.id, actor, { expectedVersion: task.version, prompt: text, origin })
      await delivery.ensure(child.id)
      if (!task.runs.some(run => run.cliSessionId)) await reply('无法续接上下文，已新建关联任务')
    } catch (error) {
      if (!(error instanceof HubError)) throw error
      await reply(error.message)
    }
  }
}
