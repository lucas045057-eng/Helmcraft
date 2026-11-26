import type { BoardSnapshot, HarnessApplied, HarnessDirective, Profile, PromptDigest, RunEvent } from '@agent-hub/protocol'

import { relative, sep } from 'node:path'
import type { Workspace } from '../config/schema.js'
import { scanManifest, diffManifest, type Manifest } from './manifest.js'
import { sensitivePaths } from './tamper.js'
import { readBoard } from './board-reader.js'

export interface HarnessSession {
  applied: HarnessApplied
  nonce?: string
  pre?: BoardSnapshot
  prompt?: PromptDigest
  epochPre: number
  writerActive: boolean
  manifest?: Manifest
  sensitive?: (path: string) => boolean
  verifyCommandIds?: string[]
  round: number
}
export function computeApplied(directive: HarnessDirective, local: { blackboard: boolean; verify?: Workspace['harness']['verify'] }, effectiveProfile: Profile, configExposed = false): HarnessApplied {
  const { trust, inject } = directive
  const reason = !local.blackboard && directive.board !== 'off' ? 'LOCAL_DISABLED'
    : directive.board === 'write' && effectiveProfile === 'readonly' ? 'PROFILE_CLAMPED' : undefined
  const board = reason === 'LOCAL_DISABLED' ? 'off' : reason === 'PROFILE_CLAMPED' ? 'read' : directive.board
  const bootstrap = directive.bootstrap && board === 'write'
  const downgrades: HarnessApplied['downgrades'] = []
  if (reason) downgrades.push({ field: 'board', reason })
  if (directive.bootstrap && !bootstrap && reason) downgrades.push({ field: 'bootstrap', reason })
  const verify = !!directive.verify && effectiveProfile !== 'readonly' && !!local.verify?.commands.length && !configExposed
  if (directive.verify && !verify) downgrades.push({ field: 'verify', reason: configExposed ? 'CONFIG_EXPOSED' : 'NO_COMMANDS' })
  return { board, inject, trust, bootstrap, verify, autoFixMaxRetries: verify && trust === 'owner' ? Math.min(local.verify!.maxAutoFixRetries, directive.verify!.autoFixMaxRetries) : 0, downgrades }
}

type Post = Omit<Extract<RunEvent, { kind: 'workspace' }>, 'seq' | 'ts'>
export async function capturePost(session: HarnessSession, root: string, localHarness: Workspace['harness'],
  knownSecrets: Record<string, string>, patterns: string[], profile: Profile, writerChanged: () => boolean, boardRoot = root): Promise<Post> {
  const post = session.pre && await readBoard(boardRoot, knownSecrets, patterns)
  const boardPrefix = relative(root, boardRoot).split(sep).join('/')
  const event: Post = { kind: 'workspace', round: session.round, ...(post && { board: post }) }
  if (session.manifest && session.sensitive) {
    const current = sensitivePaths(root, localHarness)
    const sensitive = (path: string) => session.sensitive!(path) || current(path)
    const manifest = await scanManifest(root, localHarness.manifest, sensitive)
    Object.assign(event, diffManifest(session.manifest, manifest, sensitive))
  }
  if (profile === 'readonly' && (post || event.changes)) {
    const paths = new Set(event.changes?.sample.map(p => p.path))
    for (const [i, file] of (post?.files ?? []).entries()) {
      const before = session.pre?.files[i]
      if (before?.status !== file.status || before.sha256 !== file.sha256) paths.add((boardPrefix ? boardPrefix + '/' : '') + '.board/' + file.file)
    }
    if (session.writerActive || writerChanged() || event.changes?.truncated) event.readonlyCheck = 'inconclusive'
    else {
      event.readonlyCheck = paths.size ? 'violation' : 'clean'
      if (paths.size) event.readonlyPaths = [...paths].slice(0, 20)
    }
  }
  return event
}
