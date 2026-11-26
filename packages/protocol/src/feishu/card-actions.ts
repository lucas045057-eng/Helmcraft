import { z } from 'zod'
import { RunId, TaskId } from '../common.js'
export const CardActionValue = z.strictObject({
  v: z.literal(1),
  a: z.enum(['approve', 'reject', 'cancel', 'retry', 'input_option', 'publish_result', 'suppress_result', 'handoff', 'fix']),
  t: TaskId,
  r: RunId.optional(),
  ver: z.number().int(),              // 渲染卡片时的 task.version
  opt: z.string().max(200).optional(),// input_option 的选项文本
  req: z.string().optional(),         // input requestId
})

export type CardActionValue = z.infer<typeof CardActionValue>

/** 方法库推荐确认卡的按钮（docs/specs/10）：确认前不创建任务。 */
export const MethodSuggestionAction = z.strictObject({
  v: z.literal(1),
  a: z.enum(['method_use', 'method_skip']),
  s: z.string().regex(/^mss_[0-9A-HJKMNP-TV-Z]{26}$/),
})
export type MethodSuggestionAction = z.infer<typeof MethodSuggestionAction>
