import { createHash, randomBytes } from 'node:crypto'
import { join, relative, sep } from 'node:path'
import { BOARD_FILES, composeHarnessPrompt, renderFactsJson } from '@agent-hub/protocol'
import type { BoardSnapshot, ComposeInput, RunDispatch, WorkerFacts } from '@agent-hub/protocol'
import type { HarnessSession } from './session.js'

const relativePath = (from: string, to: string) => relative(from, to).split(sep).join('/') || '.'
export function composeRun(command: RunDispatch, session: HarnessSession, root: string, cwd: string,
  agents: BoardSnapshot['agentsMd'], now: number, makeNonce = () => randomBytes(16).toString('base64url'),
  repair?: { facts: NonNullable<WorkerFacts['autofix']>; resumed: boolean; board?: BoardSnapshot }) {
  const { applied } = session
  const pre = repair?.board ?? session.pre
  const { inject, trust, board } = applied
  const facts = command.harness?.facts
  if (!repair && (inject === 'none' || (inject === 'resume' && !facts))) return
  const files = pre?.files ?? []
  let nonce = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = makeNonce()
    if (!command.prompt.includes(candidate) && !files.some(f => f.content?.includes(candidate))) { nonce = candidate; break }
  }
  if (!nonce) {
    applied.inject = 'none'
    applied.downgrades.push({ field: 'inject', reason: 'NONCE_COLLISION' })
    return
  }
  const dir = pre?.dir ?? 'absent'
  const worker: WorkerFacts = { ...(repair && { autofix: repair.facts }), capturedAt: pre?.capturedAt ?? now, cwd: relativePath(root, cwd), agentsMd: agents.status,
    board: { dir, files: files.map(f => ({ file: f.file, status: f.status, bytes: f.bytes, budget: BOARD_FILES[f.file].budgetBytes,
      overBudget: f.overBudget, schemaOk: f.schemaOk })) } }
  const input: ComposeInput = { adapter: command.adapter, mode: repair ? 'autofix' : inject === 'none' ? 'fresh' : inject, nonce, userPrompt: command.prompt, trust, board,
    boardDir: dir, bootstrap: applied.bootstrap && dir === 'absent', agentsMd: agents.status,
    paths: { agents: relativePath(cwd, join(root, 'AGENTS.md')), board: relativePath(cwd, join(root, '.board')) },
    factsJson: renderFactsJson(facts ?? null, worker), verifyCommandIds: session.verifyCommandIds ?? [],
    ...(repair && { autofix: { attempt: repair.facts.attempt, maxRetries: repair.facts.maxRetries, resumed: repair.resumed } }),
    boardFiles: files.flatMap(f => f.content === undefined ? [] : [{ file: f.file, content: f.content, bytes: f.bytes,
      truncated: f.truncated ?? false, overBudget: f.overBudget }]),
    ...(facts?.handoff && { handoff: { fromRunId: facts.handoff.from.runId, fromTaskNo: facts.handoff.from.taskNo,
      fromAdapter: facts.handoff.from.adapter, intent: facts.handoff.intent } }),
    ...(facts?.continuity && { continuity: { ...facts.continuity, interleavedUnknown: !!facts.continuity.interleavedUnknown } }) }
  const { text, sections } = composeHarnessPrompt(input, () => applied.downgrades.push({ field: 'inject', reason: 'PROMPT_TOO_LARGE' }))
  session.nonce = nonce
  if (repair || inject === 'none') return text
  session.prompt = { version: 1, mode: inject, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'),
    sections, boardFiles: sections.includes('board') ? input.boardFiles.map(f => f.file) : [] }
  return text
}
