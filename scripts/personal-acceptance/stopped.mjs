import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Inspect the retained project without replaying the rejected push.
export function verifyStoppedDelivery(directory) {
  const read = name => readFileSync(join(directory, name), 'utf8')
  const git = (...args) => execFileSync('git', args, { cwd: join(directory, 'project'), encoding: 'utf8', timeout: 30000 }).trimEnd()
  const { phase, control, baseline, tip, remoteSha, items, steps } = JSON.parse(read('execution.json'))
  assert.equal(phase, 'blocked')
  assert.equal(control, 'inspect')
  assert.equal(items.length, 2)
  assert.equal(steps.at(-1).kind, 'push')
  assert.equal(steps.at(-1).result.status, 'failed')
  assert.equal(steps.filter(step => step.kind === 'push').length, 1)
  assert.ok(!steps.some(step => step.item_id === items[1].item_id))
  assert.equal(git('rev-parse', 'HEAD'), tip)
  assert.equal(git('rev-parse', 'HEAD^'), baseline)
  assert.equal(remoteSha, baseline)
  assert.equal(git('ls-remote', '--exit-code', '--refs', 'origin', 'refs/heads/main').split(/\s+/u)[0], remoteSha)
  const unresolved = read('UNRESOLVED.md')
  assert.ok(unresolved.includes(tip) && unresolved.includes(remoteSha))
  const acceptance = read('ACCEPTANCE.md')
  assert.ok(acceptance.includes('结论：未完成。'))
  const rows = Array.from(acceptance.matchAll(/^- \[([ x!])\] (\S+) /gmu), match => [match[1], match[2]])
  assert.deepEqual(rows, items.map(item => [' ', item.item_id]))
}
