import { describe, expect, it } from 'vitest'
import { parseMethodMention, renderMethodBlock, suggestMethods } from '@agent-hub/protocol'
import { PiFeishuTransport } from './pi/feishu.js'
import { eventually, FakeWorker, openHarness } from './pi/harness.js'
import { dispatch } from './pi/phase7.js'

// docs/specs/10-method-library.md
const flowchart = { name: '给外行画流程图', kind: 'skill', scenario: '想让不懂技术的人看懂一条流程：消息从哪里进来、经过谁、最后到哪里',
  avoid: '写代码 修bug', keywords: ['流程图', 'archify'], steps: '调用 archify。先核对代码里的真实入口，再画出每条路径，在分岔处写清条件',
  done: '一张能直接打开的图，外行顺着箭头能读懂' }
const card = (over: Record<string, unknown> = {}) => ({ id: 'mtd_' + '0'.repeat(26), keywords: [] as string[], avoid: '', scenario: '', name: 'x', ...over })

describe('method helpers', () => {
  it('parses named use in both quote styles and the /m shortcut', () => {
    expect(parseMethodMention('用『给外行画流程图』解释一下退款流程')).toEqual({ name: '给外行画流程图', prompt: '用『给外行画流程图』解释一下退款流程' })
    expect(parseMethodMention('用「新人讲解包」给 Forma 出一份')?.name).toBe('新人讲解包')
    expect(parseMethodMention('/m 给外行画流程图 解释登录流程')).toEqual({ name: '给外行画流程图', prompt: '解释登录流程' })
    expect(parseMethodMention('用户说要加流程图')).toBeUndefined()
    expect(parseMethodMention('/m 只有名字')).toBeUndefined()
  })

  it('recommends by scenario and keywords, and stays quiet for unrelated or excluded requests', () => {
    const cards = [card({ ...flowchart, id: 'mtd_' + '1'.repeat(26) }), card({ id: 'mtd_' + '2'.repeat(26), name: '比赛调研',
      scenario: '找近期黑客松和编程比赛，核对报名截止日期', keywords: ['黑客松'] })]
    expect(suggestMethods('帮我给新同事画个流程图，让不懂技术的人看懂退款是怎么走的', cards)[0]?.name).toBe('给外行画流程图')
    expect(suggestMethods('最近有什么黑客松可以报名', cards)[0]?.name).toBe('比赛调研')
    expect(suggestMethods('把登录按钮改成蓝色', cards)).toEqual([])
    expect(suggestMethods('帮我修bug，写代码把流程图组件修好', cards).map(s => s.name)).not.toContain('给外行画流程图')
    expect(suggestMethods('任何东西', [card({ name: '无场景', steps: 'x' })])).toEqual([])
  })

  it('renders the method block with expanded references and clipped examples', () => {
    const block = renderMethodBlock({ ...flowchart, kind: 'sop', revision: 3, examples: [{ title: '上次', content: 'y'.repeat(2000) }] },
      [{ name: '读黑板', steps: '读取 .board/PROJECT_STATE.md', done: '' }])
    expect(block).toMatch(/^<method name="给外行画流程图" kind="sop" revision="3">/u)
    expect(block).toContain('## 引用的方法『读黑板』')
    expect(block).toContain('…（已截断）')
    expect(block.endsWith('</method>')).toBe(true)
  })
})

const settings = { server: { port: 0, allowInsecureWorker: true } }
type Hub = Awaited<ReturnType<typeof openHarness>>['hub']
type TestCall = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => ReturnType<Hub['ctx']['http']['app']['inject']>
async function withApi(run: (call: TestCall,
  hub: Awaited<ReturnType<typeof openHarness>>['hub']) => Promise<void>, config: Record<string, unknown> = settings, options: Record<string, unknown> = { listen: false }) {
  const { hub, cleanup } = await openHarness(config, options)
  try {
    const authorization = 'Bearer ' + hub.ctx.auth.createApiToken('test', ['admin'])
    await run((method, url, payload) => hub.ctx.http.app.inject({ method, url: '/api/v1' + url, headers: { authorization }, ...(payload && { payload }) }), hub)
  } finally { await cleanup() }
}

it('manages method cards over REST with revisions, unique names, examples and audit', async () => {
  await withApi(async call => {
    const created = await call('POST', '/methods', flowchart)
    expect(created.statusCode).toBe(201)
    const id = created.json().id as string
    expect(created.json()).toMatchObject({ name: '给外行画流程图', revision: 1, status: 'self_confirmed', examples: [] })
    expect((await call('POST', '/methods', flowchart)).statusCode).toBe(409)
    expect((await call('POST', '/methods', { ...flowchart, name: '有 空格' })).statusCode).toBe(400)
    expect((await call('POST', '/methods', { name: 'x' })).statusCode).toBe(400)
    const updated = await call('PUT', '/methods/' + id, { ...flowchart, done: '更清楚', expectedRevision: 1 })
    expect(updated.json()).toMatchObject({ revision: 2, done: '更清楚' })
    expect((await call('PUT', '/methods/' + id, { ...flowchart, expectedRevision: 1 })).statusCode).toBe(409)
    const withExample = await call('POST', '/methods/' + id + '/examples', { title: '上周那张图', content: '用户报名 → 支付 → 通知' })
    expect(withExample.json().examples).toMatchObject([{ title: '上周那张图', taskId: null, revision: 2 }])
    expect((await call('POST', '/methods/' + id + '/examples', { taskId: '#99' })).statusCode).toBe(404)
    expect((await call('GET', '/methods?q=archify')).json()).toHaveLength(1)
    expect((await call('GET', '/methods?q=不存在')).json()).toHaveLength(0)
    expect((await call('POST', '/methods/suggest', { prompt: '让不懂技术的人看懂退款流程，画个流程图' })).json()[0]).toMatchObject({ id, name: '给外行画流程图' })
    const exampleId = withExample.json().examples[0].id as string
    expect((await call('DELETE', '/methods/' + id + '/examples/' + exampleId)).json().examples).toEqual([])
    expect((await call('DELETE', '/methods/' + id)).statusCode).toBe(204)
    expect((await call('GET', '/methods/' + id)).statusCode).toBe(404)
    expect((await call('GET', '/audit?action=method.deleted&limit=1')).json().items[0]).toMatchObject({ targetId: id })
  })
})

it('snapshots the method into the task and prepends it to the dispatched prompt only for that task', async () => {
  await withApi(async (call, hub) => {
    const id = (await call('POST', '/methods', flowchart)).json().id as string
    const w = await FakeWorker.connect(hub, { workerId: 'methods' })
    const task = await call('POST', '/tasks', { prompt: '解释退款流程', workspaceId: 'sandbox', methodId: id })
    expect(task.statusCode).toBe(201)
    expect(task.json().method).toEqual({ id, name: '给外行画流程图', revision: 1, via: 'named' })
    // 之后修改卡片不影响已创建任务的快照
    await call('PUT', '/methods/' + id, { ...flowchart, steps: '新的做法' })
    const run = await dispatch(w, task.json().id)
    expect(run.prompt).toMatch(/^<method name="给外行画流程图" kind="skill" revision="1">/u)
    expect(run.prompt).toContain('调用 archify')
    expect(run.prompt).not.toContain('新的做法')
    expect(run.prompt).toContain('<request>\n解释退款流程\n</request>')
    const plain = await call('POST', '/tasks', { prompt: '普通任务', workspaceId: 'sandbox' })
    expect(plain.json().method).toBeUndefined()
    expect((await call('POST', '/tasks', { prompt: 'x', workspaceId: 'sandbox', methodId: 'mtd_' + 'Z'.repeat(26) })).statusCode).toBe(404)
  }, settings, {})
}, 15000)

const permissions = { autoApproveAll: true }
const feishu = { enabled: true, ownerOpenIds: ['ou_owner'], defaultWorkspaceId: 'sandbox', requesterAllowlist: ['ou_req'] }
async function withBot(run: (bot: PiFeishuTransport, hub: Awaited<ReturnType<typeof openHarness>>['hub']) => Promise<void>, extra: Record<string, unknown> = {}) {
  const bot = new PiFeishuTransport()
  const { hub, cleanup } = await openHarness({ permissions, feishu: { ...feishu, ...extra } }, { feishuTransport: bot })
  try {
    hub.ctx.store.tx(db => db.prepare(`INSERT INTO method_cards (id, name, kind, scenario, avoid, keywords_json, steps, done, revision, created_at, updated_at, updated_by)
      VALUES ('mtd_${'1'.repeat(26)}', ?, 'skill', ?, ?, ?, ?, ?, 1, 0, 0, 'test')`).run(flowchart.name, flowchart.scenario, flowchart.avoid,
      JSON.stringify(flowchart.keywords), flowchart.steps, flowchart.done))
    await run(bot, hub)
  } finally { await cleanup() }
}
const suggestionCard = (bot: PiFeishuTransport) => [...bot.messages.entries()].find(([, m]) => JSON.stringify(m.body).includes('要不要用'))

it('runs a named method from Feishu and explains unknown names', async () => {
  await withBot(async (bot, hub) => {
    await bot.p2p('用『给外行画流程图』解释退款流程')
    await eventually(() => hub.ctx.store.repos.tasks.getByNo(1))
    expect(hub.ctx.store.repos.tasks.getByNo(1)!.methodJson).toMatchObject({ name: '给外行画流程图', via: 'named' })
    await bot.p2p('/m 不存在的方法 做点什么')
    await eventually(() => [...bot.messages.values()].some(m => m.body.type === 'text' && m.body.text.includes('没有找到方法『不存在的方法』')))
    expect(hub.ctx.store.repos.tasks.getByNo(2)).toBeUndefined()
  })
})

it('asks before using a recommended method and creates exactly one task per confirmation', async () => {
  await withBot(async (bot, hub) => {
    await bot.p2p('帮我画个流程图，让不懂技术的人看懂退款是怎么走的', { user: 'ou_req' })
    await eventually(() => suggestionCard(bot))
    expect(hub.ctx.store.repos.tasks.getByNo(1)).toBeUndefined()
    const [messageId, message] = suggestionCard(bot)!
    const value = (JSON.stringify(message.body).match(/"value":(\{"v":1,"a":"method_use","s":"mss_[0-9A-Z]+"\})/u))![1]!
    const action = JSON.parse(value)
    expect((await bot.click(messageId, 'ou_owner', action)).toast.content).toBe('只有发起需求的人可以选择')
    const used = await bot.click(messageId, 'ou_req', action)
    expect(used.toast).toMatchObject({ type: 'success', content: '已按『给外行画流程图』创建任务' })
    expect(JSON.stringify(used.card)).not.toContain('method_use')
    expect(hub.ctx.store.repos.tasks.getByNo(1)!.methodJson).toMatchObject({ via: 'suggested' })
    expect((await bot.click(messageId, 'ou_req', { ...action, a: 'method_skip' })).toast.content).toBe('已处理')
    expect(hub.ctx.store.repos.tasks.getByNo(2)).toBeUndefined()
  })
})

it('creates a plain task when the suggestion is declined, expires stale cards and can be switched off', async () => {
  await withBot(async (bot, hub) => {
    await bot.p2p('帮我画个流程图，让不懂技术的人看懂退款是怎么走的', { user: 'ou_req' })
    await eventually(() => suggestionCard(bot))
    const [messageId, message] = suggestionCard(bot)!
    const s = JSON.stringify(message.body).match(/"s":"(mss_[0-9A-Z]+)"/u)![1]!
    expect((await bot.click(messageId, 'ou_req', { v: 1, a: 'method_skip', s })).toast.content).toBe('已按原需求创建任务')
    expect(hub.ctx.store.repos.tasks.getByNo(1)!.methodJson).toBeNull()
    await bot.p2p('再画一个流程图，让不懂技术的人看懂登录流程', { user: 'ou_req' })
    await eventually(() => [...bot.messages.values()].filter(m => JSON.stringify(m.body).includes('要不要用')).length === 2)
    const second = [...bot.messages.entries()].filter(([, m]) => JSON.stringify(m.body).includes('要不要用')).at(-1)!
    const s2 = JSON.stringify(second[1].body).match(/"s":"(mss_[0-9A-Z]+)"/u)![1]!
    hub.ctx.store.tx(db => db.prepare('UPDATE method_suggestions SET expires_at = 0 WHERE id = ?').run(s2))
    expect((await bot.click(second[0], 'ou_req', { v: 1, a: 'method_use', s: s2 })).toast.content).toBe('推荐已过期，请重新发送需求')
    expect(hub.ctx.store.repos.tasks.getByNo(2)).toBeUndefined()
  })
  await withBot(async (bot, hub) => {
    await bot.p2p('帮我画个流程图，让不懂技术的人看懂退款是怎么走的', { user: 'ou_req' })
    await eventually(() => hub.ctx.store.repos.tasks.getByNo(1))
    expect(suggestionCard(bot)).toBeUndefined()
  }, { methodSuggestions: false })
})
