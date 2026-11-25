import { Context, Service } from 'cordis'
import { z } from 'zod'
import { PolicyRule, Profile } from '@agent-hub/protocol'
import type { Actor } from '@agent-hub/protocol'
import type { PolicyInput, PolicyOutcome, PolicyService } from '../../services/policy.js'
import { policyRules } from '../store-sqlite/schema.js'
import { HubError } from '../../services/errors.js'
import type { Repos } from '../../services/store.js'
import { onHotUpdate } from '../../kernel/hot-update.js'

export interface PolicyConfig { ownerOpenIds: string[]; requesterAllowlist: string[]; requesterPolicy?: 'allowlist' | 'chat'; allowedChatIds?: string[] }
type Cached = { rule: PolicyRule; pattern?: RegExp }
const readRevision = (db: Repos) => Number((db.prepare("SELECT value FROM meta WHERE key='policy_revision'").get() as { value: string } | undefined)?.value ?? 0)
export class Policy extends Service implements PolicyService {
  static inject = ['store', 'clock']
  static Config = z.strictObject({ ownerOpenIds: z.array(z.string()), requesterAllowlist: z.array(z.string()),
    requesterPolicy: z.enum(['allowlist', 'chat']).optional(), allowedChatIds: z.array(z.string()).optional() })
  private rules: Cached[] = []
  constructor(ctx: Context, private config: PolicyConfig) { super(ctx, 'policy') }
  [Service.init]() {
    this.refresh()
    onHotUpdate<PolicyConfig>(this.ctx, ['ownerOpenIds', 'requesterAllowlist', 'requesterPolicy', 'allowedChatIds'], next => { this.config = next })
  }
  private refresh() {
    this.rules = this.ctx.store.repos.select().from(policyRules).all().map(row => {
      const rule = PolicyRule.parse({ id: row.id, name: row.name, enabled: row.enabled, priority: row.priority,
        match: row.matchJson, effect: row.effectJson })
      return { rule, ...(rule.match.promptPattern && { pattern: new RegExp(rule.match.promptPattern, 'i') }) }
    }).sort((a, b) => a.rule.priority - b.rule.priority || a.rule.id.localeCompare(b.rule.id))
  }
  listRules() { return this.rules.map(({ rule }) => structuredClone(rule)) }
  revision() { return readRevision(this.ctx.store.repos) }
  replaceRules(rules: PolicyRule[], actor: Actor, expectedRevision?: number) {
    const validated = rules.map(rule => PolicyRule.parse(rule))
    if (new Set(validated.map(rule => rule.id)).size !== validated.length) throw new HubError('VALIDATION_FAILED', 400)
    const revision = this.ctx.store.tx(db => {
      const current = readRevision(db)
      if (expectedRevision !== undefined && expectedRevision !== current) {
        throw new HubError('VERSION_CONFLICT', 409, { current })
      }
      db.delete(policyRules).run()
      for (const rule of validated) db.insert(policyRules).values({ id: rule.id, name: rule.name, priority: rule.priority,
        enabled: rule.enabled, matchJson: rule.match, effectJson: rule.effect, updatedAt: this.ctx.clock.now(), updatedBy: actor.id }).run()
      db.prepare("INSERT INTO meta VALUES ('policy_revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1").run()
      db.audit.append({ ts: this.ctx.clock.now(), actorType: actor.type, actorId: actor.id, channel: actor.channel,
        action: 'policy.replaced', targetType: 'policy', targetId: 'rules', detailJson: { revision: current + 1 } })
      return current + 1
    })
    this.refresh()
    return revision
  }
  evaluate(input: PolicyInput): PolicyOutcome {
    const owner = input.actor.type === 'owner'
    const hardApproval = !owner && input.profile === 'full'
    if (input.source === 'feishu' && !this.config.ownerOpenIds.includes(input.actor.id) &&
        !this.config.requesterAllowlist.includes(input.actor.id) && !(input.actor.type === 'requester' && input.chatId &&
        this.config.requesterPolicy === 'chat' && this.config.allowedChatIds?.includes(input.chatId))) return { ruleId: null, decision: 'deny' }
    const profile = input.actor.type === 'requester' && input.profile === 'full' ? 'edit' : input.profile
    const fits = (values: readonly string[] | undefined, value: string | undefined) => !values || (value !== undefined && values.includes(value))
    const found = this.rules.find(({ rule, pattern }) => {
      const m = rule.match
      return rule.enabled && fits(m.actorType, input.actor.type) && fits(m.actorIds, input.actor.id) &&
        fits(m.source, input.source) && fits(m.chatIds, input.chatId) && fits(m.workspaceIds, input.workspaceId) &&
        fits(m.adapters, input.adapter) && fits(m.profiles, profile) && (!pattern || pattern.test(input.prompt))
    })?.rule
    const clamp = found?.effect.clampProfile
    const effective = clamp && Profile.options.indexOf(clamp) < Profile.options.indexOf(profile) ? clamp : profile
    const decision = found?.effect.decision ?? (owner ? 'auto_approve' : 'require_approval')
    return { ...found?.effect, ruleId: found?.id ?? null, decision: hardApproval && decision !== 'deny' ? 'require_approval' : decision,
      ...(effective !== input.profile && { clampedProfile: effective }) }
  }
}
