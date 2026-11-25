import type { Profile } from '@agent-hub/protocol'
const order: Profile[] = ['readonly', 'edit', 'full']
export function effectiveProfile(requested: Profile, max: Profile, strict = false) {
  if (order.indexOf(requested) <= order.indexOf(max)) return { effectiveProfile: requested }
  if (strict) return null
  return { effectiveProfile: max, clampedFrom: requested }
}
