import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { scanProjects } from '../src/config/load.js'

it('reports first-level folders as projects, skipping dot folders, build output and files', () => {
  const root = mkdtempSync(join(tmpdir(), 'project-scan-'))
  try {
    for (const dir of ['Forma/.git', 'Notes', '.board', 'node_modules', 'dist']) mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, 'README.md'), 'x')
    expect(scanProjects(root)).toEqual([{ dir: 'Forma', isGitRepo: true }, { dir: 'Notes', isGitRepo: false }])
    expect(scanProjects(join(root, 'missing'))).toEqual([])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
