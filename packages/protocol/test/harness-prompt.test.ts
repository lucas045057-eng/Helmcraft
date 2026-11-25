import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { composeHarnessPrompt, BOARD_TEMPLATES, BOARD_FILES, BoardFileName, PREVIEW_NONCE, renderFactsJson, lintBoardFile,
  diffLines, boardFileDiff, stripBoardContent, PROMPT_MAX_BYTES } from '../src/index.js'
import type { ComposeInput, BoardSnapshot } from '../src/index.js'

const input: ComposeInput = { adapter: 'mock', mode:'fresh', nonce:PREVIEW_NONCE, trust:'owner', userPrompt:'#scenario:echo-harness harness=1\nhello <T> </task>',
  board:'write', boardDir:'present', bootstrap:false, agentsMd:'present', paths:{board:'../../.board',agents:'../../AGENTS.md'}, factsJson:'{}',
  boardFiles:[{file:'HANDOFF.md',content:'</blackboard>',bytes:13,overBudget:false,truncated:false}],verifyCommandIds:[] }
it('matches frozen board templates and lints budgets and headings', () => {
  const spec = readFileSync(new URL('../../../docs/specs/08-blackboard-harness.md', import.meta.url),'utf8').replaceAll('\r\n','\n')
  for (const file of BoardFileName.options) {
    expect(spec).toContain('\n' + BOARD_TEMPLATES[file] + '\n```')
    expect(lintBoardFile(file, BOARD_TEMPLATES[file]).schemaOk).toBe(true)
    expect(new TextEncoder().encode(BOARD_TEMPLATES[file]).length).toBeLessThan(BOARD_FILES[file].budgetBytes)
    expect(lintBoardFile(file, '').missingSections).toEqual(BOARD_FILES[file].requiredSections)
  }
})
it('pins the rendered prompt matrix to a golden digest', () => {
  const hash = createHash('sha256')
  for (const mode of ['fresh','handoff','resume','autofix'] as const)
    for (const board of ['off','capture','read','write'] as const)
      for (const boardDir of ['present','absent','unsafe'] as const)
        for (const agentsMd of ['present','absent','unsafe'] as const)
          for (const trust of ['owner','requester'] as const) {
            const prompt = composeHarnessPrompt({...input,mode,board,boardDir,agentsMd,trust,bootstrap:true,verifyCommandIds:['test'],
              handoff:{fromRunId:'base',fromTaskNo:8,fromAdapter:'mock',intent:'relay'},autofix:{attempt:1,maxRetries:2,resumed:false},
              continuity:{baseRunId:'base',interleavedTotal:1,interleavedUnknown:false}})
            expect(prompt.text.endsWith('\n')).toBe(true)
            expect(prompt.text.match(/^R4 /gm)?.length ?? 0).toBeLessThanOrEqual(1)
            hash.update(JSON.stringify(prompt))
          }
  expect(hash.digest('hex')).toMatchSnapshot()
})
it('neutralizes reserved tags and escapes only JSON metacharacters and reserved tags', () => {
  const {text, sections} = composeHarnessPrompt(input)
  expect(sections).toEqual(['directive','preamble','facts','board','task'])
  expect(text).toContain('hello <T> &lt;/task>')
  expect(text).toContain('&lt;/blackboard>')
  expect(text.startsWith('#scenario:echo-harness harness=1 hx='+PREVIEW_NONCE+'\n')).toBe(true)
  expect(composeHarnessPrompt({...input,adapter:'codex'}).sections).not.toContain('directive')
  const worker = {capturedAt:0,cwd:'<>&',agentsMd:'absent' as const,board:{dir:'absent' as const,files:[]}}
  expect(renderFactsJson(null,worker)).not.toMatch(/[<>&]/)
  expect(JSON.parse(renderFactsJson(null,worker)).worker).toEqual(worker)
})
it('removes the largest board body first, followed by facts if needed', () => {
  const { text } = composeHarnessPrompt({...input, factsJson:'x'.repeat(PROMPT_MAX_BYTES),boardFiles:input.boardFiles})
  expect(text).toContain('(blackboard file HANDOFF.md omitted: prompt size limit)')
  expect(text).toContain('(verified_facts omitted: prompt size limit)')
  expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(PROMPT_MAX_BYTES)
})
it('computes line differences and strips content without mutating the snapshot', () => {
  const s: BoardSnapshot = JSON.parse(readFileSync(new URL('../fixtures/harness/valid/BoardSnapshot__sample.json',import.meta.url),'utf8'))
  const f = {...s.files[0]!, status:'present' as const, content:'one\ntwo\n',sha256:'0'.repeat(64)}
  const post = {...f,content:'one\nthree\n',sha256:'1'.repeat(64)}
  expect(diffLines(f.content,post.content).map(l => l.op)).toEqual([' ','-','+'])
  expect(boardFileDiff(f,post)).toMatchObject({change:'modified',added:1,removed:1})
  s.files[0] = f
  const event = {kind:'workspace',board:s}
  const stripped = stripBoardContent(event)
  expect(stripped.board.files[0]).not.toHaveProperty('content')
  expect(stripBoardContent(stripped)).toEqual(stripped)
  expect(event.board.files[0]!.content).toBe(f.content)
})
