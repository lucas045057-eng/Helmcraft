import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'

test('prints two Markdown entries from the current Git history', () => {
  const log = execFileSync('git', ['log', '-n', '2', '--format=%H%x09%s'], { encoding: 'utf8' })
  const expected = log.trimEnd().split('\n').map(line => '- [x] ' + line.slice(0, 7) + ' ' + line.slice(line.indexOf('\t') + 1))
  const output = execFileSync(process.execPath, ['checklist.mjs', '2'], { encoding: 'utf8' })
  assert.equal(output, expected.join('\n') + '\n')
})
