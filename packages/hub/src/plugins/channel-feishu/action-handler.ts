import { KeyedMutex, stableHash } from '@agent-hub/common'
import { AdapterId, ApprovalOverrides, CardActionValue, MethodSuggestionAction } from '@agent-hub/protocol'
import type { Actor, TaskDetailView } from '@agent-hub/protocol'
import type { CardDelivery } from './delivery.js'
import type { CardActionResponse, FeishuCardActionEvent } from './transport.js'
import { identity } from './router.js'
import { HubError } from '../../services/errors.js'
import type { CreateTaskInput } from '../../services/orchestrator.js'
import { claimSuggestion, getMethod, releaseSuggestion } from '../orchestrator/methods.js'
import { renderMethodSuggestionCard } from './cards/index.js'

const toast = (content: string, type: CardActionResponse['toast']['type'] = 'info'): CardActionResponse => ({ toast: { content, type } })
const actionKeys = { handoff: 'followup', fix: 'followup', approve: 'approve', reject: 'reject', cancel: 'cancel', retry: 'retry', input_option: 'input',
  publish_result: 'deliver_result', suppress_result: 'deliver_result' } as const
const done = { approve: '已批准', reject: '已驳回', cancel: '已取消', retry: '已提交重试', input_option: '已提交回答',
  publish_result: '结果已发送', suppress_result: '已选择不发送' }

export class ActionHandler {
  private readonly mutex = new KeyedMutex()
  constructor(private delivery: CardDelivery) {}
  async handle(event: FeishuCardActionEvent): Promise<CardActionResponse> {
    const { delivery } = this
    const { ctx } = delivery
    const started = Date.now()
    if (!ctx.store.repos.feishu.recordEvent({ key: 'act:' + event.event_id, receivedAt: ctx.clock.now() })) return toast('已处理')
    const method = MethodSuggestionAction.safeParse(event.action.value)
    if (method.success) return this.handleMethodSuggestion(event, method.data)
    const parsed = CardActionValue.safeParse(event.action.value)
    if (!parsed.success) return toast('卡片已过期', 'error')
    const { a, t, ver, opt, req } = parsed.data
    const handoff = a === 'handoff' || a === 'fix'
    const id = event.operator.open_id
    const row = delivery.binding(event.context.open_message_id)
    const role = identity(delivery.config, id, event.context.open_chat_id ?? row?.chatId ?? '', row?.chatType === 'group')
    const ownerOnly = handoff || ['approve', 'reject', 'publish_result', 'suppress_result'].includes(a)
    const delegated = role === 'requester' && (handoff ? delivery.config.permissions.allowRequesterHandoff :
      (a === 'approve' || a === 'reject') && delivery.config.permissions.allowRequesterCommands)
    if (ownerOnly && role !== 'owner' && !delegated) return toast('仅负责人可操作', 'error')
    if (handoff && (row?.chatType === 'group' ? !delivery.config.allowGroupCommands : row?.audience !== 'owner' && !delegated)) return toast('仅负责人可操作', 'error')
    if (role === 'unauthorized') return toast('暂无操作权限', 'error')
    if (!row || row.dead || row.taskId !== t || !row.audience ||
      !['approval_card', 'review_card', 'progress_card', 'reply'].includes(row.role)) return toast('卡片已过期', 'error')
    const actor: Actor = { type: role, id, channel: 'feishu' }
    const audience = row.chatType === 'group' ? delivery.groupAudience(row.chatId) : row.audience
    const key = 'card:' + t
    const immediate = await this.mutex.tryLock(key)
    const release = immediate ?? await this.mutex.tryLock(key, 200)
    if (!release) return toast('正在处理，请稍候')
    const resumePatch = delivery.updater.hold(row.messageId)
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const render = (message: string, success: boolean) => {
      const desired = delivery.desired(t, row.role, row.chatType === 'group' ? delivery.groupAudience(row.chatId) : audience, row.chatType)
      if (!timedOut) delivery.updater.markSent(row.messageId, desired)
      return { ...toast(message, success ? 'success' : 'info'), card: { type: 'raw' as const, data: desired.card } }
    }
    const execute = async (): Promise<CardActionResponse> => {
      const api = ctx.orchestrator
      const task = api.getTask(t, actor)
      if (!task || (role !== 'owner' && task.requester.id !== id)) return toast('无权操作此任务', 'error')
      if (row.chatType === 'p2p' && row.audience === 'owner' && role !== 'owner') return toast('仅负责人可操作', 'error')
      if (!task.allowedActions.includes(actionKeys[a])) {
        if (task.version !== ver || (ownerOnly && task.resultDeliveryStatus !== 'pending_review'))
          return render(immediate && !['suppress_result', 'publish_result'].includes(a) ? '任务状态已变化' : '已处理', false)
        return toast('当前状态不允许此操作', 'error')
      }
      const version = { expectedVersion: task.version }
      switch (a) {
        case 'handoff': case 'fix': {
          const values = event.action.form_value ?? {}
          const adapter = values.cli ? AdapterId.safeParse(values.cli) : undefined
          if (adapter && !adapter.success) return toast('目标 CLI 无效', 'error')
          if (values.prompt !== undefined && (typeof values.prompt !== 'string' || values.prompt.length > 1000)) return toast('补充说明无效', 'error')
          const child = await api.handoff(t, actor, { intent: a === 'fix' ? 'fix' : 'relay', expectedVersion: ver,
            ...(parsed.data.r && { fromRunId: parsed.data.r }), ...(adapter?.success && { adapter: adapter.data }),
            ...(typeof values.prompt === 'string' && values.prompt && { prompt: values.prompt }),
            origin: { source: 'feishu', feishu: { chatType: row.chatType, chatId: row.chatId, messageId: row.messageId } } },
          { idempotencyKey: stableHash([row.messageId, a, ver, parsed.data.r, values.cli, values.prompt]) })
          await delivery.ensure(child.id)
          return toast('已创建接力任务 #' + child.taskNo, 'success')
        }
        case 'approve': {
          const values = event.action.form_value ?? {}
          const modes = { board: { blackboard: true }, board_verify: { blackboard: true, verify: true }, off: { blackboard: false, verify: false } }
          const mode = values.harness
          if (mode !== undefined && mode !== 'default' && (typeof mode !== 'string' || !Object.hasOwn(modes, mode))) return toast('审批选项无效', 'error')
          const overrides = ApprovalOverrides.safeParse({
            ...(mode && mode !== 'default' ? { harness: modes[mode as keyof typeof modes] } : {}),
            ...(values.adapter && values.adapter !== 'auto' && values.adapter !== task.adapter ? { adapter: values.adapter } : {}),
            ...(values.workspace && values.workspace !== task.workspaceId ? { workspaceId: values.workspace } : {}),
            ...(values.profile && values.profile !== task.profile ? { profile: values.profile } : {}),
          })
          if (!overrides.success) return toast('审批选项无效', 'error')
          await api.approve(t, actor, { ...version, overrides: overrides.data })
          break
        }
        case 'reject': case 'cancel': case 'retry': await api[a](t, actor, version); break
        case 'input_option': {
          const answer = option(task, req, opt)
          if (!answer || !req) return render('任务状态已变化', false)
          await api.provideInput(t, actor, { ...version, requestId: req, answer })
          break
        }
        case 'publish_result': case 'suppress_result':
          await api.deliverResult(t, actor, { ...version, action: a === 'publish_result' ? 'send' : 'suppress' })
          break
      }
      ctx.store.repos.audit.append({ ts: ctx.clock.now(), actorType: actor.type, actorId: id, channel: 'feishu', action: 'card.' + a,
        targetType: 'task', targetId: t, detailJson: { eventId: event.event_id } })
      if (timedOut) delivery.refresh(t, true)
      return timedOut ? toast('已提交') : render(done[a], true)
    }
    const work = execute().catch(error => {
      if (error instanceof HubError && ['VERSION_CONFLICT', 'INVALID_TRANSITION'].includes(error.code)) return render('任务状态已变化', false)
      if (!(error instanceof HubError)) ctx.logger.warn('飞书卡片操作失败')
      return toast(error instanceof HubError ? error.message : '操作失败，请重试', 'error')
    }).finally(release)
    try {
      return await Promise.race([work, new Promise<CardActionResponse>(resolve => {
        timer = setTimeout(() => { timedOut = true; resolve(toast('已提交')) }, Math.max(0, 2000 - (Date.now() - started)))
      })])
    } finally { clearTimeout(timer); resumePatch() }
  }
  /** 方法库推荐卡：只有原需求人能确认；领取是原子的，重复点击只生效一次（docs/specs/10）。 */
  private async handleMethodSuggestion(event: FeishuCardActionEvent, value: MethodSuggestionAction): Promise<CardActionResponse> {
    const { ctx } = this.delivery
    const now = ctx.clock.now()
    const peek = ctx.store.tx(db => db.prepare('SELECT actor_json, method_id, input_json FROM method_suggestions WHERE id = ?').get(value.s)) as
      { actor_json: string; method_id: string; input_json: string } | undefined
    if (!peek) return toast('卡片已过期', 'error')
    const actor = JSON.parse(peek.actor_json) as Actor
    const input = JSON.parse(peek.input_json) as CreateTaskInput
    const name = ctx.store.tx(db => { try { return getMethod(db, peek.method_id).name } catch { return undefined } })
    const view = (state: Parameters<typeof renderMethodSuggestionCard>[1]) => ({ type: 'raw' as const,
      data: renderMethodSuggestionCard({ id: value.s, name: name ?? '已删除的方法', scenario: '', prompt: input.prompt }, state) })
    if (event.operator.open_id !== actor.id) return toast('只有发起需求的人可以选择', 'error')
    const claimed = ctx.store.tx(db => claimSuggestion(db, value.s, now))
    if (claimed === 'used') return toast('已处理')
    if (claimed === 'expired' || !claimed) return { ...toast('推荐已过期，请重新发送需求', 'error'), card: view('expired') }
    const use = value.a === 'method_use' && name !== undefined
    try {
      const task = await ctx.orchestrator.createTask(use ? { ...input, methodId: peek.method_id } : input, actor, use ? { methodVia: 'suggested' } : {})
      await this.delivery.ensure(task.id)
    } catch (error) {
      ctx.store.tx(db => releaseSuggestion(db, value.s))
      if (!(error instanceof HubError)) throw error
      return toast(error.message, 'error')
    }
    if (value.a === 'method_use' && !use) return { ...toast('方法已被删除，已按原需求创建任务', 'info'), card: view('skipped') }
    return { ...toast(use ? '已按『' + name + '』创建任务' : '已按原需求创建任务', 'success'), card: view(use ? 'used' : 'skipped') }
  }
}
function option(task: TaskDetailView, request?: string, opt?: string) {
  const input = task.inputRequest
  if (!input || input.requestId !== request || opt === undefined) return
  return input.options?.find(v => v === opt)
}
