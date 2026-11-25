import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { preparePlan } from '../src/personal/plan.js'

it('binds the requirement and checks, rejects drift and installs only the validated ordered plan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  try {
    git('init', '-q')
    writeFileSync(join(dir, 'REQ.md'), 'F01 Export commits\nAC-01 Render Markdown\n')
    git('add', 'REQ.md')
    git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'requirements')
    const plan = preparePlan(dir, ['REQ.md'], ['unit'])
    expect(plan.prompt).toContain('AC-01 Render Markdown')
    const item = { id: 'T01', title: 'Export commits', requirements: ['REQ.md:L1'], acceptanceRefs: ['REQ.md:L2'], checks: ['unit'] }
    const reply = (items: unknown[]) => JSON.stringify({ items })
    expect(() => plan.install(reply([item, item]))).toThrow()
    expect(() => plan.install(reply([{ ...item, checks: ['invented'] }]))).toThrow()
    expect(() => plan.install(reply([{ ...item, acceptanceRefs: ['REQ.md:L99'] }]))).toThrow()
    writeFileSync(join(dir, 'REQ.md'), 'changed\n')
    expect(() => plan.install(reply([item]))).toThrow()
    writeFileSync(join(dir, 'REQ.md'), 'F01 Export commits\nAC-01 Render Markdown\n')
    const receipt = plan.install(reply([item, { ...item, id: 'T02', title: 'Print summary' }]))
    expect(receipt.items.map(i => i.id)).toEqual(['T01', 'T02'])
    expect(readFileSync(join(dir, 'TASKS.md'), 'utf8')).toContain('T02')
    expect(() => plan.install(reply([item]))).toThrow()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
