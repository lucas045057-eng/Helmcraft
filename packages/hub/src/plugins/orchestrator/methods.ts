import { ulid } from '@agent-hub/common'
import { MethodExampleInput, MethodInput, methodReferences, renderMethodBlock, suggestMethods } from '@agent-hub/protocol'
import type { Actor, MethodCard, MethodExample, MethodSuggestion, TaskMethod } from '@agent-hub/protocol'
import { HubError } from '../../services/errors.js'
import type { Repos } from '../../services/store.js'

// 个人方法库存储与渲染（docs/specs/10-method-library.md）。方法卡只影响 AI「怎么做」，不改变权限与审批。
type CardRow = { id: string; name: string; kind: 'skill' | 'sop'; scenario: string; avoid: string; keywords_json: string; steps: string;
  done: string; status: 'self_confirmed'; revision: number; created_at: number; updated_at: number }
type ExampleRow = { id: string; method_id: string; title: string; content: string; task_id: string | null; revision: number; created_at: number;
  task_no: number | null }
export type SuggestionRow = { id: string; method_id: string; actor_json: string; input_json: string; chat_id: string; message_id: string;
  created_at: number; expires_at: number; consumed_at: number | null }

const valid = <T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, input: unknown): T => {
  const result = schema.safeParse(input)
  if (!result.success) throw new HubError('VALIDATION_FAILED', 400, { issues: result.error.issues.map(issue => ({ path: issue.path.map(String).join('.'), message: issue.message })) })
  return result.data
}
const notFound = () => new HubError('VALIDATION_FAILED', 404, { reason: 'METHOD_NOT_FOUND' })
const examplesOf = (db: Repos, ids: string[]) => {
  if (!ids.length) return new Map<string, MethodExample[]>()
  const rows = db.prepare(`SELECT e.*, t.task_no FROM method_examples e LEFT JOIN tasks t ON t.id = e.task_id
    WHERE e.method_id IN (${ids.map(() => '?').join(',')}) ORDER BY e.created_at DESC, e.rowid DESC`).all(...ids) as ExampleRow[]
  const map = new Map<string, MethodExample[]>()
  for (const row of rows) map.set(row.method_id, [...map.get(row.method_id) ?? [], { id: row.id, title: row.title, content: row.content,
    taskId: row.task_id, taskNo: row.task_no, revision: row.revision, createdAt: row.created_at }])
  return map
}
const toCard = (row: CardRow, examples: MethodExample[]): MethodCard => ({ id: row.id, name: row.name, kind: row.kind, scenario: row.scenario,
  avoid: row.avoid, keywords: JSON.parse(row.keywords_json) as string[], steps: row.steps, done: row.done, status: row.status,
  revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, examples })

export function listMethods(db: Repos, q?: string): MethodCard[] {
  const term = q?.trim()
  const rows = (term
    ? db.prepare(`SELECT * FROM method_cards WHERE name LIKE @q ESCAPE '\\' OR scenario LIKE @q ESCAPE '\\'
        OR keywords_json LIKE @q ESCAPE '\\' OR steps LIKE @q ESCAPE '\\' ORDER BY updated_at DESC`).all({ q: '%' + term.replace(/[\\%_]/g, '\\$&') + '%' })
    : db.prepare('SELECT * FROM method_cards ORDER BY updated_at DESC').all()) as CardRow[]
  const examples = examplesOf(db, rows.map(row => row.id))
  return rows.map(row => toCard(row, examples.get(row.id) ?? []))
}
export function getMethod(db: Repos, id: string): MethodCard {
  const row = db.prepare('SELECT * FROM method_cards WHERE id = ?').get(id) as CardRow | undefined
  if (!row) throw notFound()
  return toCard(row, examplesOf(db, [id]).get(id) ?? [])
}
export function findMethodByName(db: Repos, name: string): MethodCard | undefined {
  const row = db.prepare('SELECT id FROM method_cards WHERE name = ? COLLATE NOCASE').get(name.trim()) as { id: string } | undefined
  return row && getMethod(db, row.id)
}

const audit = (db: Repos, actor: Actor, action: string, id: string, now: number, detail: Record<string, unknown> = {}) =>
  db.audit.append({ ts: now, actorType: actor.type, actorId: actor.id, channel: actor.channel, action, targetType: 'method', targetId: id, detailJson: detail })
function checkName(db: Repos, name: string, self?: string) {
  const other = db.prepare('SELECT id FROM method_cards WHERE name = ? COLLATE NOCASE').get(name) as { id: string } | undefined
  if (other && other.id !== self) throw new HubError('VALIDATION_FAILED', 409, { reason: 'METHOD_NAME_TAKEN' })
}

export function createMethod(db: Repos, input: unknown, actor: Actor, now: number): MethodCard {
  const data = valid(MethodInput, input)
  checkName(db, data.name)
  const id = 'mtd_' + ulid(now)
  db.prepare(`INSERT INTO method_cards (id, name, kind, scenario, avoid, keywords_json, steps, done, revision, created_at, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(id, data.name, data.kind, data.scenario, data.avoid, JSON.stringify(data.keywords),
    data.steps, data.done, now, now, actor.id)
  audit(db, actor, 'method.created', id, now, { name: data.name })
  return getMethod(db, id)
}
export function updateMethod(db: Repos, id: string, input: unknown, actor: Actor, now: number, expectedRevision?: number): MethodCard {
  const current = getMethod(db, id)
  if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new HubError('VERSION_CONFLICT', 409, { current: current.revision })
  const data = valid(MethodInput, input)
  checkName(db, data.name, id)
  db.prepare(`UPDATE method_cards SET name = ?, kind = ?, scenario = ?, avoid = ?, keywords_json = ?, steps = ?, done = ?,
    revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?`).run(data.name, data.kind, data.scenario, data.avoid,
    JSON.stringify(data.keywords), data.steps, data.done, now, actor.id, id)
  audit(db, actor, 'method.updated', id, now, { revision: current.revision + 1 })
  return getMethod(db, id)
}
export function deleteMethod(db: Repos, id: string, actor: Actor, now: number) {
  if (!db.prepare('DELETE FROM method_cards WHERE id = ?').run(id).changes) throw notFound()
  audit(db, actor, 'method.deleted', id, now)
}
export function addMethodExample(db: Repos, id: string, input: unknown, actor: Actor, now: number): MethodCard {
  const card = getMethod(db, id)
  const data = valid(MethodExampleInput, input)
  let title: string, content: string, taskId: string | null = null
  if ('taskId' in data) {
    const task = db.prepare('SELECT id, task_no, title, status, result_summary FROM tasks WHERE id = ? OR task_no = ?')
      .get(data.taskId, Number(data.taskId.replace(/^#/, '')) || -1) as { id: string; task_no: number; title: string; status: string; result_summary: string | null } | undefined
    if (!task) throw new HubError('TASK_NOT_FOUND', 404)
    if (task.status !== 'succeeded' || !task.result_summary) throw new HubError('VALIDATION_FAILED', 400, { reason: 'TASK_HAS_NO_RESULT' })
    title = data.title ?? '#' + task.task_no + ' ' + task.title
    content = task.result_summary.slice(0, 4000)
    taskId = task.id
  } else ({ title, content } = data)
  if (card.examples.length >= 10) throw new HubError('VALIDATION_FAILED', 400, { reason: 'TOO_MANY_EXAMPLES' })
  db.prepare('INSERT INTO method_examples (id, method_id, title, content, task_id, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('mex_' + ulid(now), id, title, content, taskId, card.revision, now)
  audit(db, actor, 'method.example_added', id, now, { taskId })
  return getMethod(db, id)
}
export function removeMethodExample(db: Repos, id: string, exampleId: string, actor: Actor, now: number): MethodCard {
  if (!db.prepare('DELETE FROM method_examples WHERE id = ? AND method_id = ?').run(exampleId, id).changes) throw notFound()
  audit(db, actor, 'method.example_removed', id, now, { exampleId })
  return getMethod(db, id)
}

export function suggestFor(db: Repos, prompt: string): MethodSuggestion[] {
  return suggestMethods(prompt, listMethods(db))
}

/** 生成写入任务的快照：渲染方法块，SOP 中 『名字』 引用的其他卡展开一层。 */
export function snapshotMethod(db: Repos, id: string, via: TaskMethod['via']): TaskMethod {
  const card = getMethod(db, id)
  const refs = methodReferences(card.steps).filter(name => name !== card.name)
    .flatMap(name => { const ref = findMethodByName(db, name); return ref ? [ref] : [] })
  return { id: card.id, name: card.name, revision: card.revision, via, block: renderMethodBlock(card, refs) }
}
/** 派发时把方法块放在用户需求之前。 */
export const withMethod = (prompt: string, method: TaskMethod | null | undefined) =>
  method ? method.block + '\n\n<request>\n' + prompt + '\n</request>' : prompt

export function createSuggestion(db: Repos, row: Omit<SuggestionRow, 'id' | 'consumed_at'>): string {
  const id = 'mss_' + ulid(row.created_at)
  db.prepare(`INSERT INTO method_suggestions (id, method_id, actor_json, input_json, chat_id, message_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, row.method_id, row.actor_json, row.input_json, row.chat_id, row.message_id, row.created_at, row.expires_at)
  db.prepare('DELETE FROM method_suggestions WHERE expires_at < ?').run(row.created_at - 86_400_000)
  return id
}
/** 原子领取：同一推荐只能被确认一次。 */
export function claimSuggestion(db: Repos, id: string, now: number): SuggestionRow | 'expired' | 'used' | undefined {
  const row = db.prepare('SELECT * FROM method_suggestions WHERE id = ?').get(id) as SuggestionRow | undefined
  if (!row) return undefined
  if (row.consumed_at) return 'used'
  if (row.expires_at < now) return 'expired'
  db.prepare('UPDATE method_suggestions SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(now, id)
  return row
}
/** 创建任务失败时退回领取，让用户可以再点一次。 */
export function releaseSuggestion(db: Repos, id: string) {
  db.prepare('UPDATE method_suggestions SET consumed_at = NULL WHERE id = ?').run(id)
}
