import type { BoardFileDiff, ProjectBriefingView, RunHarnessSummary, CardActionValue, TaskDetailView, TaskView, WorkerView } from '@agent-hub/protocol'
import type { CardJson } from '../transport.js'
import { displayText } from './progress.js'
import type { Audience } from './progress.js'

export type TaskCardModel = Pick<TaskDetailView, 'id' | 'taskNo' | 'status' | 'version' | 'prompt' | 'resultSummary' |
  'attempt' | 'inputRequest' | 'errorCode' | 'allowedActions' | 'resultDeliveryStatus' | 'workspaceId' | 'profile' |
  'adapter' | 'scheduleHint' | 'startedAt' | 'finishedAt' | 'updatedAt'> & {
    harness?: { tamperTotal?: number; board?: BoardFileDiff[]; warnings?: string[]; verification?: RunHarnessSummary['verification']; fromRunId: string;
      handoffTargets: string[]; handoffFrom?: { taskNo: number; adapter: string; intent: 'relay' | 'fix' } }
    progress?: string[]; panelUrl?: string; requiredWorkerId?: string; filesChanged?: number; reason?: string
    verificationState?: NonNullable<RunHarnessSummary['verification']>['state'] | undefined
    resultVisible?: boolean; handoffAllowed?: boolean; fixRunId?: string
    cardMaxBytes?: number; cardResultMaxChars?: number
  }
const states = {
  awaiting_approval: ['等待负责人审批', 'grey'], queued: ['排队中', 'blue'], dispatching: ['分配中', 'blue'],
  running: ['执行中', 'wathet'], cancelling: ['正在中止', 'wathet'], awaiting_input: ['等待补充信息', 'orange'],
  succeeded: ['已完成', 'green'], failed: ['执行失败', 'red'], timed_out: ['执行超时', 'red'],
  rejected: ['已驳回', 'grey'], cancelled: ['已取消', 'grey'],
} as const
export const terminal = (status: TaskView['status']) => ['succeeded', 'failed', 'timed_out', 'cancelled', 'rejected'].includes(status)
const plain = (content: string) => ({ tag: 'plain_text', content })
const line = (value: string) => ({ tag: 'div', text: plain(value) })
function card(title: string, color: string, elements: object[]) {
  return { schema: '2.0', config: { update_multi: true, width_mode: 'fill' }, header: { title: plain(title), template: color }, body: { elements } }
}
const bytes = (value: object) => Buffer.byteLength(JSON.stringify(value))
function fit(title: string, color: string, fixed: object[], fields: string[], limit: number, field: (value: string) => object = line) {
  const build = () => card(title, color, [...fields.filter(Boolean).map(field), ...fixed])
  // Fields are displayed in reverse truncation priority: prompt, result, progress.
  for (let i = fields.length - 1; i >= 0 && bytes(build()) > limit; i--) {
    const original = fields[i]!
    let lo = 0, hi = original.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      fields[i] = original.slice(0, mid)
      if (bytes(build()) <= limit) lo = mid
      else hi = mid - 1
    }
    fields[i] = original.slice(0, lo)
  }
  while (fixed.length && bytes(build()) > limit) fixed.pop()
  return build()
}
function button(m: TaskCardModel, a: CardActionValue['a'], label: string, extra: Partial<Pick<CardActionValue, 'req' | 'opt' | 'r'>> = {}) {
  return { tag: 'button', text: plain(label), type: a === 'reject' || a === 'cancel' ? 'danger' : 'primary',
    behaviors: [{ type: 'callback', value: { v: 1, a, t: m.id, ver: m.version, ...extra } }] }
}
function verificationBadge(info: NonNullable<RunHarnessSummary['verification']>, total: number) {
  if (info.state === 'running') return '⏳ 验证中'
  if (info.state === 'pending') return '等待验证'
  if (info.state === 'passed') return '✅ 验证通过'
  if (info.state === 'failed') return '❌ 验证失败：' + info.failed.join('、')
  if (info.reason === 'TAMPER_RISK') return '⚠️ 已跳过：修改敏感文件 ' + total + ' 个'
  if (info.reason === 'NO_CHANGES') return 'ℹ️ 未改动代码，已跳过验证'
  const reasons = { CONFIG_EXPOSED: '工作区包含节点配置', NO_COMMANDS: '未配置验证命令', CLI_NOT_SUCCEEDED: 'CLI 未成功',
    WORKER_RESTARTED: '节点已重启', WORKER_SHUTDOWN: '节点已关闭', CANCELLED: '已取消', BUDGET_EXHAUSTED: '验证时间已耗尽',
    MANIFEST_INCOMPLETE: '文件清单不完整', COMMAND_UNAVAILABLE: '验证命令不可用', RUN_LOST: '节点失联', INTERNAL: '内部错误' }
  return (info.state === 'skipped' ? '⚠️ 已跳过：' : '⚠️ 未验证：') + (info.reason ? reasons[info.reason] : '未知原因')
}
export function renderStreamingCard(m: TaskCardModel, audience: Audience): CardJson {
  const [label, color] = states[m.status]
  const ended = terminal(m.status)
  const title: string[] = [m.adapter ?? '自动', label]
  const fields: string[] = []
  const actions: object[] = []
  const h = audience === 'owner' ? m.harness : undefined
  if (ended) {
    if (m.finishedAt !== null && m.startedAt !== null) title.push(Math.max(0, Math.floor((m.finishedAt - m.startedAt) / 1000)) + 's')
    if ((m.filesChanged ?? 0) > 0) title.push('改动 ' + m.filesChanged + ' 个文件')
    if (m.resultDeliveryStatus === 'pending_review') fields.push('结果等待负责人审核')
    if (m.resultDeliveryStatus === 'suppressed') fields.push('负责人未发送结果')

    const changes = h?.board?.filter(item => ['created', 'modified', 'deleted'].includes(item.change))
    if (changes?.length) fields.push('黑板：' + changes.map(item => item.file + ' ' + item.change).join(' · '))
    if (m.allowedActions.includes('retry')) actions.push(button(m, 'retry', '重试'))
    const fix = m.fixRunId ?? (h?.verification?.state === 'failed' ? h.fromRunId : undefined)
    if (fix && m.handoffAllowed !== false && m.allowedActions.includes('followup')) {
      actions.push(button(m, 'fix', '带报错修复', { r: fix }))
    }
  } else {
    const lines = (m.progress ?? []).slice(-8)
    if (m.status === 'awaiting_input' && m.inputRequest) lines.push(m.inputRequest.question, '直接回复本卡片作答')
    fields.push(lines.length ? lines.join('\n') : m.scheduleHint || label)
    if (m.allowedActions.includes('cancel')) actions.push(button(m, 'cancel', '中止'))
    if (audience === 'owner' && m.panelUrl) actions.push({ tag: 'button', text: plain('打开面板'),
      behaviors: [{ type: 'open_url', default_url: m.panelUrl }] })
  }
  const info = h?.verification
  const state = info?.state ?? m.verificationState
  if (state && (ended || state === 'running')) {
    if (info) {
      if (state !== 'skipped' || !['NO_COMMANDS', 'NO_CHANGES', 'CLI_NOT_SUCCEEDED'].includes(info.reason ?? ''))
        fields.push(verificationBadge(info, h?.tamperTotal ?? 0))
    } else if (state !== 'skipped') {
      const badges = { passed: '✅ 验证通过', failed: '❌ 验证失败', unverified: '未验证', pending: '等待验证', running: '验证中' }
      fields.push(badges[state])
    }
  }
  const markdown = (content: string) => ({ tag: 'markdown', content: content.replace(/([\\`*_\[\]<>])/gu, '\\$1') })
  return fit(title.join(' · '), color, actions, fields.map(text => displayText(text, audience)), m.cardMaxBytes ?? 28672, markdown)
}

export function renderProgressCard(m: TaskCardModel, audience: Audience): CardJson {
  const [label, color] = states[m.status]
  const fields = [displayText(m.prompt, audience)]
  const elements: object[] = []
  const safe = (s: string) => displayText(s, audience)
  const allowed = m.allowedActions
  switch (m.status) {
    case 'queued': case 'dispatching':
      if (m.requiredWorkerId) elements.push(line('等待 ' + safe(m.requiredWorkerId) + ' 节点上线'))
      else if (m.scheduleHint) elements.push(line(safe(m.scheduleHint)))
      break
    case 'running': case 'cancelling':
      fields.push(...(m.progress ?? []).slice(-5).map(safe))
      if (audience === 'owner' && m.panelUrl) elements.push({ tag: 'button', text: plain('打开面板'),
        behaviors: [{ type: 'open_url', default_url: m.panelUrl }] })
      break
    case 'awaiting_input': {
      const input = m.inputRequest
      if (input) {
        fields.push(safe(input.question))
        if (allowed.includes('input') && safe(input.requestId) === input.requestId) {
          for (const opt of input.options ?? []) {
            if (safe(opt) === opt) elements.push(button(m, 'input_option', opt, { req: input.requestId, opt }))
          }
        }
      }
      elements.push(line('直接回复本卡片作答'))
      break
    }
    case 'succeeded':
      if (m.resultVisible ?? (audience === 'owner' || ['not_required', 'delivered'].includes(m.resultDeliveryStatus)))
        fields.push(safe(m.resultSummary ?? '').slice(0, m.cardResultMaxChars ?? 2000))
      else fields.push(m.resultDeliveryStatus === 'pending_review' ? '结果等待负责人审核' : '负责人未发送结果')
      elements.push(line('回复本卡片可继续对话'))
      if (m.filesChanged !== undefined) elements.push(line('改动文件 ' + m.filesChanged + ' 个'))
      break
    case 'failed': case 'timed_out':
      fields.push(m.errorCode === 'WORKER_LOST' ? '节点离线' : label)
      elements.push(line('尝试次数 ' + m.attempt))
      if (allowed.includes('retry')) elements.push(button(m, 'retry', '重试'))
      break
    case 'rejected': case 'cancelled': fields.push(safe(m.reason || label)); break
  }
  if (m.startedAt !== null) elements.push(line('耗时 ' + Math.max(0, Math.floor(((m.finishedAt ?? m.updatedAt) - m.startedAt) / 1000)) + ' 秒'))
  if (allowed.includes('cancel')) elements.push(button(m, 'cancel', m.status === 'running' ? '中止' : '取消'))
  const h = audience === 'owner' ? m.harness : undefined
  if (!h && m.handoffAllowed && allowed.includes('followup')) elements.push(button(m, 'handoff', '接力'))
  if (!h && m.fixRunId && allowed.includes('followup')) elements.push(button(m, 'fix', '带报错修复', { r: m.fixRunId }))
  if (h) {
    if (h.handoffFrom) fields.push('接力自 #' + h.handoffFrom.taskNo + '（' + h.handoffFrom.adapter + ' → ' + (m.adapter ?? '自动') + '）')
    const optional: object[] = []
    if (h.verification && (terminal(m.status) || h.verification.state === 'running')) optional.push(line(verificationBadge(h.verification, h.tamperTotal ?? 0)))
    if (terminal(m.status)) {
      const board = h.board?.filter(f => ['created', 'modified', 'deleted'].includes(f.change))
      if (board?.length) optional.push(line('黑板：' + board.map(f => f.change === 'deleted' ? '⚠️ ' + f.file + ' 已删除' : f.file + ' +' + f.added + '/−' + f.removed).join(' · ')))
      if (h.warnings?.length) optional.push(line(h.warnings.join(' · ')))
      if (m.handoffAllowed !== false && allowed.includes('followup') && h.verification?.state === 'failed') optional.push(button(m, 'fix', '带报错修复', { r: h.fromRunId }))
      if (m.handoffAllowed !== false && allowed.includes('followup') && h.handoffTargets.length) {
        optional.push({ tag: 'form', name: 'handoff', elements: [
          { tag: 'select_static', name: 'cli', initial_option: h.handoffTargets[0], options: h.handoffTargets.map(value => ({ value, text: plain(value) })) },
          { tag: 'input', name: 'prompt', placeholder: plain('补充说明'), max_length: 1000 },
          { ...button(m, 'handoff', '换 CLI 接力', { r: h.fromRunId }), form_action_type: 'submit', name: 'relay' },
          ...(h.verification?.state === 'failed' ? [{ ...button(m, 'fix', '换 CLI 修复', { r: h.fromRunId }), form_action_type: 'submit', name: 'fix' }] : []),
        ] })
      }
    }
    while (optional.length && bytes(card('#' + m.taskNo + ' · ' + label, color, [...fields.filter(Boolean).map(line), ...elements, ...optional])) > (m.cardMaxBytes ?? 28672)) optional.pop()
    elements.push(...optional)
  }
  return fit('#' + m.taskNo + ' · ' + label, color, elements, fields, m.cardMaxBytes ?? 28672)
}
export interface ApprovalChoices { harness?: boolean; adapters: string[]; workspaces: string[]; profiles?: string[] }
export function renderApprovalCard(m: TaskCardModel, choices: ApprovalChoices): CardJson {
  const pending = m.status === 'awaiting_approval'
  const elements: object[] = []
  if (pending) {
    const select = (name: string, values: string[], initial: string) => ({ tag: 'select_static', name, initial_option: initial,
      options: [...new Set([initial, ...values])].slice(0, 50).map(value => ({ text: plain(value), value })) })
    elements.push({ tag: 'form', name: 'approval', elements: [
      select('adapter', choices.adapters, m.adapter ?? 'auto'), select('workspace', choices.workspaces, m.workspaceId),
      select('profile', choices.profiles ?? ['readonly', 'edit'], m.profile),
      ...(choices.harness ? [select('harness', ['board', 'board_verify', 'off'], 'default')] : []),
      ...(['approve', 'reject'] as const).map(a => ({ ...button(m, a, a === 'approve' ? '批准' : '驳回'), name: a, form_action_type: 'submit' })),
    ] })
  }
  return fit('#' + m.taskNo + ' · ' + (pending ? '审批需求' : m.status === 'rejected' ? '已驳回' : m.status === 'cancelled' ? '已取消' : '已批准'),
    'grey', elements, [displayText(m.prompt, 'owner')], m.cardMaxBytes ?? 28672)
}
const reviewReasons = { VERIFICATION: '验证未通过或未完成', TAMPER_RISK: '敏感文件或节点配置存在风险', BOARD_DELETED: '黑板文件已删除或无法安全读取' }
export function renderOwnerReviewCard(m: TaskCardModel, gate?: keyof typeof reviewReasons): CardJson {
  const pending = m.resultDeliveryStatus === 'pending_review'
  const h = m.harness
  const actions = pending ? [button(m, 'publish_result', '发送给对方'), button(m, 'suppress_result', '不发送')] : []
  const fields = gate ? ['送审原因：' + reviewReasons[gate]] : []
  if (h?.verification) fields.push(verificationBadge(h.verification, h.tamperTotal ?? 0))
  if (h?.warnings?.length) fields.push(h.warnings.join(' · '))
  if (pending && h && m.allowedActions.includes('followup')) actions.push(button(m, 'fix', '派修复任务', { r: h.fromRunId }))
  fields.push(displayText(m.resultSummary ?? '', 'owner'))
  return fit('#' + m.taskNo + ' · ' + (pending ? '审核结果' : m.resultDeliveryStatus === 'delivered' ? '结果已发送' : '结果未发送'), 'green',
    actions, fields, m.cardMaxBytes ?? 28672)
}
/** 方法库推荐：只有点「用」或「不用」后才创建任务。state 为已处理时去掉按钮。 */
export function renderMethodSuggestionCard(s: { id: string; name: string; scenario: string; prompt: string },
  state: 'pending' | 'used' | 'skipped' | 'expired' = 'pending'): CardJson {
  const action = (a: 'method_use' | 'method_skip', label: string) => ({ tag: 'button', text: plain(label), type: a === 'method_use' ? 'primary' : 'default',
    behaviors: [{ type: 'callback', value: { v: 1, a, s: s.id } }] })
  const status = { used: '✅ 已按『' + s.name + '』创建任务', skipped: '已按原需求创建任务（不使用方法）', expired: '推荐已过期，请重新发送需求', pending: '' }[state]
  return fit('要不要用『' + s.name + '』？', state === 'pending' ? 'blue' : 'grey',
    state === 'pending' ? [{ tag: 'column_set', columns: [{ tag: 'column', elements: [action('method_use', '用')] },
      { tag: 'column', elements: [action('method_skip', '不用')] }] }] : [],
    ['需求：' + s.prompt, '适用场景：' + s.scenario, state === 'pending' ? '10 分钟内有效，不点不执行。' : status], 8192)
}
export function renderWorkersCard(workers: WorkerView[], limit = 28672): CardJson {
  return fit('Worker 列表', 'blue', [], workers.map(w => w.displayName + ' · ' + w.connection + ' · ' + w.slotsUsed + '/' +
    w.maxConcurrency + ' · ' + w.adapters.map(a => a.id).join('、')), limit)
}
export function renderTaskListCard(tasks: TaskView[], audience: Audience, limit = 28672): CardJson {
  return fit('任务列表', 'blue', [], tasks.length ? tasks.map(t => '#' + t.taskNo + ' · ' + states[t.status][0] + ' · ' +
    displayText(t.title, audience)) : ['暂无任务'], limit)
}

export function renderAutopilotProposalCard(
  p: { id: string; workspaceId: string; subdir?: string; prompt: string; adapter?: string },
  state: 'pending' | 'accepted' | 'direct' | 'dismissed' | 'expired' = 'pending',
): CardJson {
  const btn = (a: 'proposal_accept' | 'proposal_direct' | 'proposal_dismiss', label: string, primary = false) => ({
    tag: 'button',
    text: plain(label),
    type: primary ? 'primary' : a === 'proposal_dismiss' ? 'danger' : 'default',
    behaviors: [{ type: 'callback', value: { v: 1, a, p: p.id } }],
  })
  const scope = p.subdir ? `${p.workspaceId}/${p.subdir}` : p.workspaceId
  const statusText = {
    pending: '💡 这项改动较大，已为你准备好「规划 → 开发 → 测试 → 审查」自动交付，直接回复“干”或点击下方按钮启动。',
    accepted: '🚀 已启动三角色自动交付流水线。',
    direct: '⚡ 已按单次普通任务立即执行。',
    dismissed: '已取消。',
    expired: '建议卡已过期，可重新发送需求。',
  }[state]
  return fit(
    `是否启动自动交付 · ${scope}`,
    state === 'pending' ? 'blue' : 'grey',
    state === 'pending'
      ? [{ tag: 'column_set', columns: [
          { tag: 'column', elements: [btn('proposal_accept', '🚀 启动自动交付', true)] },
          { tag: 'column', elements: [btn('proposal_direct', '⚡ 直接单次执行')] },
          { tag: 'column', elements: [btn('proposal_dismiss', '取消')] },
        ] }]
      : [],
    [
      '目标：' + p.prompt.slice(0, 600),
      ...(p.adapter ? ['推荐执行器：' + p.adapter] : []),
      statusText,
    ],
    8192,
  )
}

export function renderBriefingCard(briefing: ProjectBriefingView, proposalId?: string, audience: Audience = 'owner'): CardJson {
  const color = briefing.health === 'warning' ? 'red' : briefing.health === 'attention' ? 'orange' : 'green'
  const label = briefing.subdir ? `${briefing.workspaceId}/${briefing.subdir}` : briefing.workspaceId
  if (audience === 'requester') {
    const statusText = briefing.health === 'healthy' ? '项目状态良好' : briefing.health === 'attention' ? '存在待关注事项，请联系负责人处理' : '存在阻塞或失败项，请联系负责人处理'
    return fit(`📋 项目状态 · ${label}`, color, [], [statusText], 4096)
  }
  const fields: string[] = [briefing.summary]
  for (const f of briefing.findings.slice(0, 5)) {
    const icon = f.severity === 'error' ? '❌' : f.severity === 'warning' ? '⚠️' : 'ℹ️'
    fields.push(`${icon} ${f.message}`)
  }
  if (briefing.actions.length) {
    fields.push('推荐下一步（直接回复数字即可执行）：')
    for (const a of briefing.actions) fields.push(`${a.index}. ${a.title}${a.adapter ? ` [${a.adapter}]` : ''}`)
  }
  const actions: object[] = proposalId && briefing.actions.length
    ? [{
        tag: 'column_set',
        columns: briefing.actions.slice(0, 3).map(a => ({
          tag: 'column',
          elements: [{
            tag: 'button',
            text: plain(`执行 #${a.index}`),
            type: a.index === 1 ? 'primary' : 'default',
            behaviors: [{ type: 'callback', value: { v: 1, a: 'briefing_run', p: proposalId, idx: a.index } }],
          }],
        })),
      }]
    : []
  return fit(`📋 项目简报 · ${label}`, color, actions, fields, 12_288)
}
