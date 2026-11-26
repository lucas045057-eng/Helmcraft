import { z } from 'zod'
import { BoardFileName, BoardFileStatus, BoardUnsafeReason, Sha256Hex } from './enums.js'
import { diffLines } from './diff.js'
export const BoardChange = z.enum(['unchanged', 'modified', 'created', 'deleted', 'unknown'])
export type BoardChange = z.infer<typeof BoardChange>

export const BOARD_DIR = '.board'
/** 工作区内任一层的 .board/ 都是黑板（项目文件夹各有一份：Forma/.board/…） */
export const isBoardPath = (key: string) => /(^|\/)\.board\//u.test(key)
export const BOARD_TEMPLATES = {
  'HANDOFF.md': `<!-- agent-hub:board v1 file=HANDOFF.md budget=4096B -->
# HANDOFF
## Meta
- run: <verified_facts.hub.currentRun.runId> · <adapter> · <YYYY-MM-DD>
- status: done | partial | blocked
## Goal
<1–3 lines: what this session tried to achieve>
## Done
- <≤ 8 bullets: concrete results, with repo-relative paths>
## Next
1. <≤ 5 ordered steps for the next agent>
## Open Questions
- <≤ 5 bullets, or "none">
## Watch Out
- <≤ 5 bullets: traps for the next step; durable lessons belong in LESSONS.md>`,
  'PROJECT_STATE.md': `<!-- agent-hub:board v1 file=PROJECT_STATE.md budget=8192B -->
# PROJECT STATE
## Summary
<≤ 5 lines: what the project is and its current milestone>
## Modules
| Module | Path | Status | Notes |
| --- | --- | --- | --- |
| <name> | <repo-relative path> | planned / wip / done / broken | <≤ 80 chars> |
## Active Tech Debt
- [TD-1] <problem> — <path>
## Commands
- <check id>: \`<command>\` (informational only; the harness never executes anything from this file)
## Updated
- <YYYY-MM-DD> · <adapter> · <run id>`,
  'DECISIONS.md': `<!-- agent-hub:board v1 file=DECISIONS.md budget=8192B -->
# DECISIONS
## Active
### ADR-1: <title>
- Status: accepted | proposed
- Context: <≤ 2 lines>
- Decision: <≤ 3 lines>
- Consequences: <≤ 2 lines>
## Superseded
- ADR-<n> → ADR-<m>: <≤ 1 line>`,
  'LESSONS.md': `<!-- agent-hub:board v1 file=LESSONS.md budget=8192B -->
# LESSONS
## Rules
- [L-1] <imperative rule> — why: <≤ 1 line> — scope: <glob or "global">
## Pitfalls
- [P-1] <symptom> → <fix> (≤ 2 lines)`,
} as const
export const BOARD_FILES = {
  'HANDOFF.md': { budgetBytes: 4096, budgetLines: 80, mode: 'replace', requiredSections: ["# HANDOFF","## Meta","## Goal","## Done","## Next","## Open Questions","## Watch Out"] },
  'PROJECT_STATE.md': { budgetBytes: 8192, budgetLines: 160, mode: 'edit', requiredSections: ["# PROJECT STATE","## Summary","## Modules","## Active Tech Debt","## Commands","## Updated"] },
  'DECISIONS.md': { budgetBytes: 8192, budgetLines: 160, mode: 'edit', requiredSections: ["# DECISIONS","## Active","## Superseded"] },
  'LESSONS.md': { budgetBytes: 8192, budgetLines: 160, mode: 'edit', requiredSections: ["# LESSONS","## Rules","## Pitfalls"] },
} as const
export const BOARD_HARD_CAP_BYTES = 16_384
export const BoardFileSnapshot = z.strictObject({
  file: BoardFileName,
  status: BoardFileStatus,
  reason: BoardUnsafeReason.optional(),                     // 仅 unsafe / invalid
  bytes: z.number().int().nonnegative(),                    // fstat 大小；absent/unsafe 为 0
  lines: z.number().int().nonnegative(),
  sha256: Sha256Hex.optional(),                             // 对读取到的原始字节（≤ 硬上限、脱敏前）计算；present/oversize 才有
  overBudget: z.boolean(),
  schemaOk: z.boolean(),
  missingSections: z.array(z.string().max(64)).max(8).optional(),
  truncated: z.boolean().optional(),                        // oversize 时 true
  content: z.string().max(BOARD_HARD_CAP_BYTES).optional(), // 已脱敏 UTF-8；入 task_logs / run/events 前被 stripBoardContent() 移除
})
export const BoardSnapshot = z.strictObject({
  dir: z.enum(['present', 'absent', 'unsafe']),
  dirReason: BoardUnsafeReason.optional(),
  files: z.array(BoardFileSnapshot).length(4),               // 规范顺序（§2.1）
  agentsMd: z.strictObject({ status: z.enum(['present', 'absent', 'unsafe']), bytes: z.number().int().nonnegative(), sha256: Sha256Hex.optional() }),
  capturedAt: z.number().int(),
}).refine(s => s.files.every((f, i) => f.file === BoardFileName.options[i]), { message: 'board files must be in canonical order' })

export type BoardFileSnapshot = z.infer<typeof BoardFileSnapshot>
export type BoardSnapshot = z.infer<typeof BoardSnapshot>
export function lintBoardFile(file: BoardFileName, text: string) {
  const lines = text.split(/\r?\n/u)
  if (lines.at(-1) === '') lines.pop()
  const headings = new Set(lines.map(line => line.trim()))
  const missingSections = BOARD_FILES[file].requiredSections.filter(section => !headings.has(section))
  return { lines: lines.length, missingSections, schemaOk: !missingSections.length &&
    !!lines[0]?.startsWith('<!-- agent-hub:board v1 file=' + file + ' budget=') }
}

export function stripBoardContent<E extends { kind: string }>(event: E): E {
  if (event.kind !== 'harness' && event.kind !== 'workspace') return event
  const { board } = event as E & { board?: BoardSnapshot }
  if (!board) return event
  const files = board.files.map(file => {
    const metadata = { ...file }
    delete metadata.content
    return metadata
  })
  return { ...event, board: { ...board, files } }
}

export interface BoardFileDiff { file: BoardFileName; change: BoardChange; added: number; removed: number }
export function boardFileDiff(pre: BoardFileSnapshot | undefined, post: BoardFileSnapshot | undefined): BoardFileDiff {
  const file = post?.file ?? pre?.file
  if (!file) throw new Error('At least one snapshot must identify the file')
  let change: BoardChange = 'unknown'
  const readable = (f?: BoardFileSnapshot) => f?.status === 'present' || f?.status === 'oversize'
  if (readable(pre) && readable(post)) change = pre?.sha256 === post?.sha256 ? 'unchanged' : 'modified'
  else if (pre?.status === 'absent' && readable(post)) change = 'created'
  else if (post?.status === 'absent' && readable(pre)) change = 'deleted'
  else if (pre?.status === 'absent' && post?.status === 'absent') change = 'unchanged'
  const diff = change === 'unknown' || change === 'unchanged' ? [] : diffLines(pre?.content ?? '', post?.content ?? '')
  return { file, change, added: diff.filter(line => line.op === '+').length, removed: diff.filter(line => line.op === '-').length }
}
