import { z } from 'zod'
import { AdapterId } from '../common.js'

/** 一个额度窗口：已用百分比 + 重置时间（毫秒时间戳，未知为 null）。 */
export const QuotaWindow = z.strictObject({
  label: z.string().min(1).max(64),                   // 「5 小时」「每周」「Gemini 模型」…
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.number().int().nullable(),
})
/** Worker 本机查到的某个 CLI 订阅额度。 */
export const AdapterQuota = z.strictObject({
  adapter: AdapterId,
  plan: z.string().max(64).optional(),                // pro、plus …
  windows: z.array(QuotaWindow).max(8),
  checkedAt: z.number().int(),                        // 这份数据的时间
  error: z.string().max(200).optional(),              // 最近一次查询失败的原因（windows 为上一次成功的结果）
})
export const QuotaOverviewResponse = z.array(AdapterQuota.extend({ workerId: z.string() }))

export type QuotaWindow = z.infer<typeof QuotaWindow>
export type AdapterQuota = z.infer<typeof AdapterQuota>
export type QuotaOverviewResponse = z.infer<typeof QuotaOverviewResponse>
