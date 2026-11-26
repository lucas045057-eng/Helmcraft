import { z } from 'zod'

// 个人方法库（docs/specs/10-method-library.md）
export const MethodId = z.string().regex(/^mtd_[0-9A-HJKMNP-TV-Z]{26}$/)
export const MethodKind = z.enum(['skill', 'sop'])
const text = (max: number) => z.string().trim().max(max)
export const MethodInput = z.strictObject({
  name: text(60).min(1).refine(name => !/[『』「」\s]/u.test(name), '名字不能包含空白或『』「」'),
  kind: MethodKind.default('skill'),
  scenario: text(500).default(''),
  avoid: text(300).default(''),
  keywords: z.array(text(30).min(1)).max(12).default([]),
  steps: text(4000).min(1),
  done: text(1000).default(''),
})
export const MethodExample = z.strictObject({
  id: z.string(), title: z.string(), content: z.string(), taskId: z.string().nullable(), taskNo: z.number().int().nullable(),
  revision: z.number().int(), createdAt: z.number().int(),
})
export const MethodCard = MethodInput.extend({
  id: MethodId, status: z.literal('self_confirmed'), revision: z.number().int(),
  createdAt: z.number().int(), updatedAt: z.number().int(), examples: z.array(MethodExample),
})
export const MethodListResponse = z.array(MethodCard)
export const MethodExampleInput = z.union([
  z.strictObject({ taskId: z.string().min(1), title: text(80).optional() }),
  z.strictObject({ title: text(80).min(1), content: text(4000).min(1) }),
])
export const MethodSuggestRequest = z.strictObject({ prompt: z.string().min(1).max(32_000) })
export const MethodSuggestion = z.strictObject({ id: MethodId, name: z.string(), score: z.number(), scenario: z.string() })
export const MethodSuggestResponse = z.array(MethodSuggestion)
/** 写入任务的方法快照：执行时使用的是快照，不随卡片后续修改而变化。 */
export const TaskMethod = z.strictObject({ id: MethodId, name: z.string(), revision: z.number().int(), block: z.string(), via: z.enum(['named', 'suggested']) })

export type MethodKind = z.infer<typeof MethodKind>
export type MethodInput = z.input<typeof MethodInput>
export type MethodCard = z.infer<typeof MethodCard>
export type MethodExample = z.infer<typeof MethodExample>
export type MethodExampleInput = z.infer<typeof MethodExampleInput>
export type MethodSuggestion = z.infer<typeof MethodSuggestion>
export type TaskMethod = z.infer<typeof TaskMethod>

/** 从飞书文本中识别点名：`用『名字』正文` / `用「名字」正文` / `/m 名字 正文`。 */
export function parseMethodMention(raw: string): { name: string; prompt: string } | undefined {
  const text = raw.trim()
  const quoted = /^用\s*[『「]([^』」\n]{1,60})[』」]\s*([\s\S]*)$/u.exec(text)
  if (quoted) return { name: quoted[1]!.trim(), prompt: text }
  const slash = /^\/m\s+(\S{1,60})\s+([\s\S]+)$/u.exec(text)
  if (slash) return { name: slash[1]!, prompt: slash[2]!.trim() }
  return undefined
}

const bigrams = (value: string) => {
  const chars = [...value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()]
  const grams = new Set<string>()
  for (let i = 0; i < chars.length - 1; i++) if (chars[i] !== ' ' && chars[i + 1] !== ' ') grams.add(chars[i]! + chars[i + 1]!)
  for (const word of value.toLowerCase().match(/[a-z0-9][a-z0-9_-]+/g) ?? []) grams.add('w:' + word)
  return grams
}
const overlap = (query: Set<string>, target: Set<string>) => {
  if (!query.size || !target.size) return 0
  let hit = 0
  for (const gram of target) if (query.has(gram)) hit++
  return hit / Math.min(target.size, 24)
}
export const SUGGEST_THRESHOLD = 0.3

/** 确定性推荐：名字/关键词/适用场景加权重叠，命中「不适合」的卡不推荐。 */
export function suggestMethods(prompt: string, cards: Pick<MethodCard, 'id' | 'name' | 'scenario' | 'avoid' | 'keywords'>[],
  limit = 3): MethodSuggestion[] {
  const query = bigrams(prompt)
  return cards.flatMap(card => {
    if (!card.scenario && !card.keywords.length) return []
    const avoid = card.avoid ? overlap(query, bigrams(card.avoid)) : 0
    if (avoid >= 0.5) return []
    const keyword = card.keywords.length ? Math.max(...card.keywords.map(word => overlap(query, bigrams(word)))) : 0
    const score = Math.min(1, 0.6 * overlap(query, bigrams(card.scenario)) + 0.25 * keyword + 0.15 * overlap(query, bigrams(card.name)))
    return score >= SUGGEST_THRESHOLD ? [{ id: card.id, name: card.name, scenario: card.scenario, score: Math.round(score * 1000) / 1000 }] : []
  }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit)
}

/** 渲染注入给 CLI 的方法块。SOP 中引用的其他方法会展开一层（只取「怎么做」与「什么算做好」）。 */
export function renderMethodBlock(card: Pick<MethodCard, 'name' | 'kind' | 'steps' | 'done' | 'revision'> & { examples?: Pick<MethodExample, 'title' | 'content'>[] },
  refs: Pick<MethodCard, 'name' | 'steps' | 'done'>[] = []): string {
  const clip = (value: string, max: number) => value.length > max ? value.slice(0, max) + '…（已截断）' : value
  const parts = ['<method name="' + card.name.replaceAll('"', '') + '" kind="' + card.kind + '" revision="' + card.revision + '">',
    '本次任务指定使用下面这套方法。按「怎么做」执行，按「什么算做好」自检后再交付。', '', '## 怎么做', clip(card.steps, 4000)]
  if (card.done) parts.push('', '## 什么算做好', clip(card.done, 1000))
  for (const ref of refs.slice(0, 5)) {
    parts.push('', '## 引用的方法『' + ref.name + '』', clip(ref.steps, 1500), ...(ref.done ? ['做好的标准：' + clip(ref.done, 500)] : []))
  }
  const examples = (card.examples ?? []).slice(0, 2)
  if (examples.length) {
    parts.push('', '## 参照（之前满意的结果，用来对齐风格和粒度，不要照抄内容）')
    for (const example of examples) parts.push('### ' + example.title, clip(example.content, 1500))
  }
  parts.push('</method>')
  return parts.join('\n')
}

/** SOP「怎么做」里以 『名字』 引用的其他方法名。 */
export const methodReferences = (steps: string) => [...new Set([...steps.matchAll(/『([^』\n]{1,60})』/gu)].map(match => match[1]!.trim()))]
