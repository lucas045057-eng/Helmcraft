import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { PersonalBinding, PersonalDelivery } from '@agent-hub/protocol'
import { planBaseline } from './execution.js'
import { checkedCandidate } from './review-input.js'
import { PersonalPlanReceipt } from '@agent-hub/protocol'

const exec = promisify(execFile)

// An interrupted Git write can already have taken effect. Record observations without repeating it.
export async function observeDelivery(binding: PersonalBinding, checkBinding: () => void) {
  const read = async (...args: string[]) => (await exec('git', args, { cwd:binding.root, timeout:5000,
    env:{...process.env,GIT_TERMINAL_PROMPT:'0'},encoding:'utf8',maxBuffer:65536 })).stdout.trimEnd()
  let local: ReturnType<typeof checkedCandidate> | null = null
  let remoteSha: string | null = null
  try { local = checkedCandidate(binding.root) } catch { /* Unreadable worktree. */ }
  try {
    checkBinding()
    const url = await read('remote','get-url','--push','--all',binding.remote)
    const [oid, ref] = (await read('ls-remote','--exit-code','--refs','--',url,binding.ref)).split(/\s+/u)
    if (ref === binding.ref && PersonalPlanReceipt.shape.head.safeParse(oid).success) remoteSha = oid!
  } catch { /* Unknown remote result is retained for inspection. */ }
  return {local,remoteSha}
}

// Keep commit and push in distinct Runs. Every write has a known precondition and an independent readback.
export async function deliver(binding: PersonalBinding, action: PersonalDelivery, signal: AbortSignal,
  checkBinding: () => void, verifyCore: () => Promise<void>, inlinePrompt?: string) {
  const { root, remote, ref } = binding
  const { kind, spec, candidate } = action
  const flexibleLocalOnly = binding.mode === 'flexible' && binding.autoPush === false
  const flexibleNoCommit = binding.mode === 'flexible' && binding.autoCommit === false
  const baselineOpts = {
    ...(binding.mode && { mode: binding.mode }),
    ...(binding.autoCommit !== undefined && { autoCommit: binding.autoCommit }),
    ...(inlinePrompt !== undefined && { inlinePrompt }),
  }
  const git = async (...args: string[]) => (await exec('git', args, { cwd: root, signal, timeout: 30000,
    maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8' })).stdout.trimEnd()
  const guard = () => { signal.throwIfAborted(); checkBinding() }
  const tip = async () => {
    guard()
    const url = await git('remote', 'get-url', '--push', '--all', remote)
    if (!url || /[\r\n]/u.test(url) || url.startsWith('-')) throw new Error('AMBIGUOUS_PUSH_TARGET')
    const response = (await git('ls-remote', '--exit-code', '--refs', '--', url, ref)).split(/\s+/u)
    if (response.length !== 2 || response[1] !== ref) throw new Error('REMOTE_REF_UNKNOWN')
    return { sha: response[0], url }
  }
  const cleanCommit = async (sha: string) => {
    guard()
    const current = checkedCandidate(root)
    if (current.head !== sha || current.indexTree !== candidate.tree || current.tree !== candidate.tree ||
        await git('show', '-s', '--format=%P %T', sha) !== candidate.head + ' ' + candidate.tree) throw new Error('COMMIT_CONTENT_CHANGED')
    planBaseline(root, { ...spec, head: sha }, false, baselineOpts)
  }
  guard()
  if (kind === 'commit') {
    if (action.commit || spec.head !== candidate.head) throw new Error('COMMIT_BASELINE_UNKNOWN')
    planBaseline(root, spec, false, baselineOpts)
    if (!flexibleLocalOnly && (await tip()).sha !== candidate.head) throw new Error('REMOTE_PARENT_CHANGED')
    for (const marker of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer']) {
      if (existsSync(await git('rev-parse','--path-format=absolute','--git-path',marker))) throw new Error('GIT_OPERATION_IN_PROGRESS')
    }
    guard()
    checkedCandidate(root, candidate)
    await git('add', '-A', '--', '.')
    guard()
    checkedCandidate(root, { ...candidate, indexTree: candidate.tree })
    // On any error the index and worktree remain available for inspection.
    await git('commit', '-m', spec.item.id + ': ' + spec.item.title)
    const commit = await git('rev-parse','HEAD')
    await cleanCommit(commit)
    return { parent: candidate.head, tree: candidate.tree, commit }
  }
  if (kind === 'verify_final' && flexibleNoCommit) {
    if (action.commit || spec.head !== candidate.head) throw new Error('COMMIT_BASELINE_UNKNOWN')
    guard()
    planBaseline(root, spec, false, baselineOpts)
    checkedCandidate(root, candidate)
    await verifyCore()
    guard()
    planBaseline(root, spec, false, baselineOpts)
    checkedCandidate(root, candidate)
    return { parent: candidate.head, tree: candidate.tree }
  }
  if (!action.commit) throw new Error('COMMIT_UNKNOWN')
  const commit = action.commit
  await cleanCommit(commit)
  if (flexibleLocalOnly) {
    if (kind === 'verify_final') await verifyCore()
    await cleanCommit(commit)
    return { parent: candidate.head, tree: candidate.tree, commit }
  }
  const remoteBefore = await tip()
  if (kind === 'push') {
    if (remoteBefore.sha !== candidate.head) throw new Error('REMOTE_PARENT_CHANGED')
    guard()
    await git('-c','push.followTags=false','push','--recurse-submodules=no','--',remoteBefore.url,commit+':'+ref)
  } else {
    if (remoteBefore.sha !== commit) throw new Error('REMOTE_COMMIT_CHANGED')
    await verifyCore()
  }
  await cleanCommit(commit)
  const remoteSha = (await tip()).sha
  if (remoteSha !== commit) throw new Error('REMOTE_COMMIT_UNCONFIRMED')
  return { parent: candidate.head, tree: candidate.tree, commit, remoteSha }
}
