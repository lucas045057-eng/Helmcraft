import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { readCommits } from './history.mjs'

test('reads the current repository in reverse chronological order', async () => {
  for (const limit of [1, 2]) {
    const output = execFileSync('git', ['log', '-n', String(limit), '--format=%H%x09%s'], { encoding: 'utf8' })
    const expected = output.trimEnd().split('\n').map(line => {
      const tab = line.indexOf('\t')
      return { sha: line.slice(0, tab), subject: line.slice(tab + 1) }
    })
    assert.deepEqual(await readCommits(limit), expected)
  }
})
