import { z } from 'zod'
import { AdapterId } from '../common.js'

/** CLI 的模型名：别名（opus、sonnet）或完整 ID（claude-opus-5-5、gpt-6.2-astra）。 */
export const ModelName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/u, '模型名只能包含字母、数字和 . _ : / - [ ]')

/** CLI 上报的订阅额度窗口，utilization 为 0–1 的已用比例。 */
export const QuotaWindow = z.strictObject({
  name: z.string().min(1).max(32),                    // five_hour、seven_day …
  utilization: z.number().min(0).max(10),
  resetsAt: z.number().int().nullable(),              // 毫秒时间戳
  status: z.string().max(32).optional(),
})
export const AgentQuota = z.strictObject({
  workerId: z.string(), windows: z.array(QuotaWindow).max(8), updatedAt: z.number().int(),
})

export const UsageTotals = z.strictObject({
  runs: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(), costUsd: z.number().nonnegative(),
})
export const AgentModelUsage = UsageTotals.extend({ model: z.string() })     // '' = CLI 未报告
export const AgentOverview = z.strictObject({
  adapter: AdapterId,
  ready: z.boolean(),                                 // 至少一个在线 Worker 上可用
  defaultModel: z.string().nullable(),
  suggestedModels: z.array(z.string()).max(32),       // 常用别名 + 实际出现过的模型
  quota: z.array(AgentQuota).max(16),
  usage: z.strictObject({ today: UsageTotals, week: UsageTotals, month: UsageTotals }),
  byModel: z.array(AgentModelUsage).max(32),          // 近 30 天
})
export const AgentOverviewResponse = z.array(AgentOverview)
export const SetAgentModelRequest = z.strictObject({ model: ModelName.nullable() })
export const SetAgentModelResponse = z.strictObject({ adapter: AdapterId, defaultModel: z.string().nullable() })

export type QuotaWindow = z.infer<typeof QuotaWindow>
export type AgentQuota = z.infer<typeof AgentQuota>
export type UsageTotals = z.infer<typeof UsageTotals>
export type AgentOverview = z.infer<typeof AgentOverview>
