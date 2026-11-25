import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, openSync, readFileSync, writeFileSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { PersonalPlan, PersonalPlanReceipt, PlanSources } from '@agent-hub/protocol'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

export function preparePlan(root: string, sources: string[], checks: string[], checksDigest = digest(JSON.stringify(checks))) {
  PlanSources.parse(sources)
  if (!checks.length) throw new Error('Configure at least one required verification command')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd()
  const target = join(root, 'TASKS.md')
  const assertClean = () => {
    if (git('status', '--porcelain', '--untracked-files=all') || lstatSync(target, { throwIfNoEntry: false })) {
      throw new Error('Planning requires a clean checkout and an unused TASKS.md')
    }
    const ignore = spawnSync('git', ['check-ignore', '-q', '--', 'TASKS.md'], { cwd: root, timeout: 5000 })
    if (ignore.status !== 1) throw new Error('Cannot confirm TASKS.md is eligible for commit')
  }
  assertClean()
  const head = git('rev-parse', '--verify', 'HEAD^{commit}')
  const refs = new Set<string>()
  const readSources = () => sources.map(name => {
    if (!/^100(?:644|755) /u.test(git('ls-files', '--stage', '--', name))) throw new Error('Requirement must be a tracked regular Markdown file')
    const fd = openSync(join(root, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let body: string
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > 80_000) throw new Error('Requirement exceeds the planning input limit')
      body = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fd))
    } finally { closeSync(fd) }
    return { name, body }
  })
  const files = readSources()
  const sourceDigest = digest(JSON.stringify(files))
  const text = files.flatMap(({ name, body }) => body.split(/\r?\n/u).flatMap((line, index) => {
    if (!line.trim()) return []
    const ref = name + ':L' + (index + 1)
    refs.add(ref)
    return [ref + ' ' + line]
  })).join('\n')
  if (!refs.size || text.length > 88_000) throw new Error('Empty or oversized requirement input')
  const prompt = [
    'Produce an ordered implementation plan for the requirements below. Return only JSON. Do not edit any files or execute commands.',
    'Schema: {"items":[{"id":"T01","title":"concrete implementation goal","requirements":["file.md:L1"],"acceptanceRefs":["file.md:L2"],"checks":["check-id"]}]}.',
    'Use stable unique IDs, exact source line references and required check IDs from the trusted list. Order items by dependency. Use the language of the requirements.',
    'Available required checks: ' + JSON.stringify(checks), text,
  ].join('\n')
  function install(result: string) {
    const plan = PersonalPlan.parse(JSON.parse(result))
    const markdown = ['# 项目任务计划', '', ...plan.items.flatMap((item, index) => {
      if (![...item.requirements, ...item.acceptanceRefs].every(ref => refs.has(ref)) || !item.checks.every(id => checks.includes(id))) {
        throw new Error('Unknown requirement, acceptance reference or required check')
      }
      return [`${index + 1}. **${item.id}** ${item.title}`, '   - 需求：' + item.requirements.join('、'),
        '   - 验收：' + item.acceptanceRefs.join('、'), '   - 必需测试：' + item.checks.join('、'), '']
    })].join('\n')
    const receipt = PersonalPlanReceipt.parse({ ...plan, head, sourceDigest, tasksDigest: digest(markdown), checksDigest })
    if (JSON.stringify(receipt).length > 20_000) throw new Error('The complete plan exceeds the result limit')
    assertClean()
    if (head !== git('rev-parse', 'HEAD') || sourceDigest !== digest(JSON.stringify(readSources()))) throw new Error('Planning baseline changed')
    writeFileSync(target, markdown, { flag: 'wx' })
    return receipt
  }
  return { prompt, install }
}
