import { z } from 'zod'
export const CAPABILITY_HEADER = 'x-agent-hub-capabilities' as const       // Node 读取时为小写；Worker 发送 'X-Agent-Hub-Capabilities'
export const Capability = z.string().regex(/^[a-z][a-z0-9-]{0,31}\.v[1-9]\d{0,2}$/)
export const KNOWN_CAPABILITIES = ['attachments.v1', 'blackboard.v1', 'checks-digest.v2', 'preflight.v1', 'verify.v1', 'visual.v1'] as const
export type Capability = z.infer<typeof Capability>
export function parseCapabilityHeader(value: string | readonly string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined
  const header = typeof value === 'string' ? value : value.join(',')
  const caps = new Set<string>()
  let bytes = 0
  for (const part of header.split(',')) {
    bytes += new TextEncoder().encode(part).length
    if (bytes > 256 || caps.size === 16) break
    const token = part.trim()
    if (Capability.safeParse(token).success) caps.add(token)
    bytes++
  }
  return [...caps].sort()
}
export function negotiateCapabilities(offered: readonly string[], supported: readonly string[]): string[] {
  const common = [...new Set(offered)].filter(cap => supported.includes(cap))
  return common.filter(cap => (cap !== 'verify.v1' && cap !== 'visual.v1') || common.includes('blackboard.v1')).sort()
}
export function formatCapabilityHeader(caps: readonly string[]): string { return caps.join(',') }
