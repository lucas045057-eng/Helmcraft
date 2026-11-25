import { and, desc, eq, lt, sql } from 'drizzle-orm'
import type { AuditQuery, AuditResponse } from '@agent-hub/protocol'
import type { Repos } from '../../services/store.js'
import { auditLogs } from '../store-sqlite/schema.js'
import { HubError } from '../../services/errors.js'

export function listAudit(db: Repos, query: AuditQuery): AuditResponse {
  let before: number | undefined
  if (query.cursor !== undefined) {
    const decoded = Buffer.from(query.cursor, 'base64url').toString('utf8')
    before = Number(decoded)
    if (!/^\d+$/.test(decoded) || !Number.isSafeInteger(before) || before < 1) throw new HubError('VALIDATION_FAILED', 400)
  }
  const rows = db.select().from(auditLogs).where(and(
    query.targetType === undefined ? undefined : sql`${auditLogs.targetType} = ${query.targetType}`,
    query.targetId === undefined ? undefined : eq(auditLogs.targetId, query.targetId),
    query.actorId === undefined ? undefined : eq(auditLogs.actorId, query.actorId),
    query.action === undefined ? undefined : eq(auditLogs.action, query.action),
    before === undefined ? undefined : lt(auditLogs.id, before),
  )).orderBy(desc(auditLogs.id)).limit(query.limit + 1).all()
  const more = rows.length > query.limit
  if (more) rows.pop()
  return {
    items: rows.map(row => ({ ts: row.ts, actor: { type: row.actorType, id: row.actorId, channel: row.channel },
      action: row.action, targetType: row.targetType, targetId: row.targetId,
      ...(row.detailJson != null && { details: row.detailJson as NonNullable<AuditResponse['items'][number]['details']> }) })),
    ...(more && { nextCursor: Buffer.from(String(rows.at(-1)!.id)).toString('base64url') }),
  }
}

