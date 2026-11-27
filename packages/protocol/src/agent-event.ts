import { z } from 'zod'

export const AgentEvent = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('init'), model: z.string().optional(), tools: z.array(z.string()).max(200).optional() }),
  z.strictObject({ type: z.literal('thinking'), text: z.string().max(8000) }),
  z.strictObject({ type: z.literal('message'), role: z.enum(['assistant', 'user']), text: z.string().max(16000),
    final: z.boolean() }),
  z.strictObject({ type: z.literal('tool_use'), id: z.string().optional(), name: z.string().max(128),
    summary: z.string().max(1000) }),                 // 例如 "Bash: npm test"、"Read: src/a.ts"
  z.strictObject({ type: z.literal('tool_result'), id: z.string().optional(), ok: z.boolean(),
    summary: z.string().max(2000) }),
  z.strictObject({ type: z.literal('command'), command: z.string().max(2000), exitCode: z.number().int().nullable(),
    outputTail: z.string().max(4000).optional() }),
  z.strictObject({ type: z.literal('file_change'), path: z.string().max(512),       // 相对工作区
    change: z.enum(['add', 'modify', 'delete', 'rename']) }),
  z.strictObject({ type: z.literal('usage'), inputTokens: z.number().int().optional(), outputTokens: z.number().int().optional(),
    costUsd: z.number().optional() }),
  z.strictObject({ type: z.literal('error'), message: z.string().max(4000), fatal: z.boolean() }),
])

export type AgentEvent = z.infer<typeof AgentEvent>
