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
