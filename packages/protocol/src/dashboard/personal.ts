import { z } from 'zod'

export const PersonalProjectView = z.object({
  id:z.string(), phase:z.string(), control:z.string(), reason:z.string().nullable(), currentItem:z.string().nullable(),
  taskId:z.string(), runId:z.string().nullable(), lastCommit:z.string().nullable(), branch:z.string(), activeMs:z.number(),
})
export type PersonalProjectView = z.infer<typeof PersonalProjectView>
export const PersonalReports = z.strictObject({
  'ACCEPTANCE.md':z.string(), 'ADVISOR_FINAL.md':z.string(), 'UNRESOLVED.md':z.string(),
})
export type PersonalReports = z.infer<typeof PersonalReports>
