import { stripVTControlCharacters } from 'node:util'
import { createHash } from 'node:crypto'
import { scanManifest } from '../harness/manifest.js'
import { sensitivePaths, inspectCommandFiles } from '../harness/tamper.js'
import { verifyAttempt } from '../harness/verify-runner.js'
import { aggregateRound, nextRepair, type CliOutcome } from '../harness/autofix.js'
import { composeRun } from '../harness/compose-run.js'
import { readBoard, readAgentsMd } from '../harness/board-reader.js'
import { capturePost, computeApplied, type HarnessSession } from '../harness/session.js'
import { join } from 'node:path'
import { mapWorkspaceFile, projectBoardRoot, resolveWorkspaceSubdir, withinWorkspace, workspaceSubdirPath } from '../security/workspace.js'
import { boundLogLine, createRedactor, Lru, NdjsonLineSplitter, ulid } from '@agent-hub/common'
import type { Clock, SplitLine } from '@agent-hub/common'
import type { CmdAckPayload, ProjectPreflight, ProjectRebaseline, RunCancel, RunDispatch, RunInput, RunResumeState, VerificationSummary, VerifyCommandResult } from '@agent-hub/protocol'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { WorkerConfig } from '../config/schema.js'
import type { ParsedItem, OutputParser, Invocation } from '../adapters/types.js'
import { effectiveProfile } from '../security/profile.js'
import { buildEnvironment } from '../security/env.js'
import { filterExtraArgs } from '../security/args.js'
import { assertBinding, flexibleBinding, flexiblePreflight, isCommandBoundToProject, personalBinding, preflight } from '../personal/preflight.js'
import { checkPersonalRole, personalInvocation } from '../personal/roles.js'
import { PersonalResult } from '../personal/result.js'
import { preparePlan } from '../personal/plan.js'
import { computeChecksDigest, computeLegacyChecksDigest, planBaseline, requiredCommands } from '../personal/execution.js'
import { checkedCandidate, roleInput } from '../personal/review-input.js'
import { deliver, observeDelivery } from '../personal/delivery.js'
import { isVisualShotFailed, resolveVisualConfig, runVisualCheck, visualFailureTail, type VisualBackend } from '../harness/visual-runner.js'
import { type AdapterRegistry } from '../adapters/registry.js'
import { RunOutbox } from '../tunnel/outbox.js'
import { trackProcessTree } from './kill-tree.js'
import type { ProcessTree } from './kill-tree.js'
import { Journal } from './journal.js'
import { LocalLog, LocalLogStream } from './local-log.js'
import { spawnRun, writePrompt } from './spawn.js'
import { createRunTempDir, recoverRunTempFiles, removeRunTempDir, stageRunAttachments, writeRunTempFiles } from './temp-files.js'

type Code = NonNullable<CmdAckPayload['error']>['code']
type StopReason = 'TIMEOUT' | 'IDLE_TIMEOUT' | 'INPUT_TIMEOUT' | 'CANCELLED' | 'WORKER_SHUTDOWN'
interface ActiveRun {
  workspacePath: string
  harness?: HarnessSession
  command: RunDispatch
  state: Exclude<RunResumeState['state'], 'finished'>
  profile: NonNullable<ReturnType<typeof effectiveProfile>>
  started: number
  lastOutput: number
  child?: ChildProcessWithoutNullStreams
  tree?: ProcessTree
  requestId?: string
  stop?: StopReason
  aggregate?: CliOutcome
  pauseIdle?: boolean
  abort: AbortController
  grace: AbortController
  treeCleanupFailed?: boolean
  kill?: Promise<void>
  done: Promise<void>
  complete: () => void
  discard: boolean
}
export class WorkerError extends Error {
  constructor(readonly code: Code, message: string = code) { super(message) }
}

export class RunManager {
  readonly outbox: RunOutbox
  private readonly active = new Map<string, ActiveRun>()
  private readonly writeEpoch = new Map<string, number>()
  private readonly completed: Lru<string, true>
  private readonly deliveredInputs: Lru<string, true>
  private readonly reporting = new Set<string>()
  private cleanupRecordFailed = false
  private patterns: string[] = []
  hubDrain = false
  localDrain = false
  constructor(private config: WorkerConfig, private readonly registry: AdapterRegistry,
    private readonly clock: Clock, private readonly journal: Journal, private readonly logRoot: string,
    private readonly warn: (message: string, code?: string) => void, private readonly tempRoot = join(logRoot, '.tmp'),
    private readonly visualBackend?: VisualBackend) {
    this.completed = new Lru(10_000, Infinity, clock)
    this.deliveredInputs = new Lru(10_000, 3_600_000, clock)
    this.outbox = new RunOutbox(clock, config.tunnel, id => {
      this.journal.acked(id)
      this.reporting.delete(id)
    })
  }
  update(config: WorkerConfig) { this.config = config; this.outbox.updateLimits(config.tunnel) }
  setRedactionPatterns(patterns: string[]) { this.patterns = patterns }
  get slotsUsed() { return this.active.size }
  get drained() { return this.hubDrain || this.localDrain }
  async recover() {
    for (const entry of await this.journal.recover(() => this.warn('Startup process tree cleanup failed'))) {
      if (!entry.finished) continue
      this.outbox.recover(entry.runId, entry.taskId, entry.finished)
      this.completed.set(entry.runId, true)
      this.reporting.add(entry.runId)
    }
    try { recoverRunTempFiles(this.tempRoot) }
    catch { this.warn('Startup Run temp file cleanup failed') }
  }
  report(): RunResumeState[] {
    return [...this.reporting].flatMap(id => {
      const entry = this.outbox.describe(id, this.active.get(id)?.state ?? 'finished')
      return entry ? [entry] : []
    }).slice(0, 64)
  }
  seen(id: string): RunResumeState['state'] | undefined {
    return this.active.get(id)?.state ?? (this.completed.has(id) || this.reporting.has(id) ? 'finished' : undefined)
  }
  // Wire admission verifies physical paths and persists acceptance before cmd.ack.
  accept(command: RunDispatch, hubNow: number): () => void {
    const plan = this.planReservation(command, hubNow, resolveWorkspaceSubdir)
    this.recordAcceptance(command, plan.run.workspacePath)
    return plan.activate()
  }
  private recordAcceptance(command: RunDispatch, workspaceRoot: string) {
    if (command.personal?.projectId) this.journal.projectOccupation.claim(command.personal.binding.root ?? workspaceRoot, command.personal.projectId)
    this.journal.accepted({ runId: command.runId, taskId: command.taskId, workspaceId: command.workspaceId, workspaceRoot })
  }
  // An in-process reservation claims the slot synchronously. Its launch owns all I/O.
  reserve(command: RunDispatch, hubNow: number): () => void {
    const plan = this.planReservation(command, hubNow, workspaceSubdirPath)
    const launch = plan.activate()
    return () => {
      try { this.recordAcceptance(command, plan.run.workspacePath) }
      catch {
        this.finish(plan.run, { kind: 'finished', status: 'failed', errorCode: 'SPAWN_ERROR', exitCode: null,
          signal: null, durationMs: 0, summary: 'Could not persist run acceptance' })
        return
      }
      launch()
    }
  }
  private planReservation(command: RunDispatch, hubNow: number, resolveDirectory: typeof resolveWorkspaceSubdir) {
    if (hubNow > command.notAfter) throw new WorkerError('EXPIRED')
    if (this.drained) throw new WorkerError('DRAINING')
    if (this.slotsUsed >= this.config.maxConcurrency || this.reporting.size >= 64) throw new WorkerError('NO_SLOT')
    const workspace = this.config.workspaces.find(item => item.id === command.workspaceId)
    if (!workspace) throw new WorkerError('WORKSPACE_UNKNOWN')
    let cwd: string
    try { cwd = resolveDirectory(workspace.path, command.subdir) }
    catch { this.warn('Rejected unsafe working directory', 'PATH_REJECTED'); throw new WorkerError('PATH_REJECTED') }
    const probe = this.registry.get(command.adapter)
    if (!probe?.adapter || probe.result.status !== 'ready' || !probe.result.exe ||
      !workspace.allowedAdapters.includes(command.adapter) || (command.resume && !probe.adapter.features.resume)) throw new WorkerError('ADAPTER_UNAVAILABLE')
    const profile = effectiveProfile(command.profile, workspace.maxProfile, workspace.strictProfile)
    if (!profile) throw new WorkerError('PROFILE_NOT_ALLOWED')
    const personal = command.personal
    const checkBinding = () => {
      if (!personal) return
      try {
        checkPersonalRole(personal.role, command)
        if (personal.gate && (!personal.projectId || personal.execution || personal.planSources || command.harness ||
          personal.role !== (personal.gate.kind === 'review' ? 'reviewer' : personal.gate.kind === 'debug' ? 'main' : 'advisor'))) throw new Error('Invalid role gate')
        if (personal.delivery && (personal.role !== 'main' || !personal.projectId || personal.planSources || personal.execution ||
          personal.repair || personal.gate || !!command.harness !== (personal.delivery.kind === 'verify_final'))) throw new Error('Invalid delivery')
        if (personal.repair && !personal.execution) throw new Error('Missing repair baseline')
        if (personal.execution && (!personal.projectId || personal.role !== 'main' || personal.planSources ||
          (!command.harness?.verify && !personal.noChecks) || !this.config.harness.enabled)) throw new Error('Invalid item execution')
        if (personal.planSources && (personal.role !== 'main' || command.harness)) throw new Error('Invalid plan dispatch')
        if ((personal.binding.mode !== 'flexible' && profile.effectiveProfile !== command.profile) || (personal.role !== 'main' && command.harness) ||
          command.harness?.verify?.autoFixMaxRetries) throw new Error('Invalid role profile')
        const expected = personal.binding.mode === 'flexible'
          ? flexibleBinding(this.config, workspace.id, this.registry, personal.binding)
          : personalBinding(this.config, workspace.id, this.registry)
        assertBinding(personal.binding, expected)
      } catch { throw new WorkerError('INVALID', 'Personal role or repository binding rejected') }
    }
    checkBinding()
    if (profile.effectiveProfile !== 'readonly') {
      this.checkWriter(workspace.id, workspace.path)
      if (!this.journal.projectOccupation.permits(personal?.binding.root ?? workspace.path, personal?.projectId)) throw new WorkerError('WORKSPACE_BUSY', 'PROJECT_OCCUPIED')
    }
    const other = [...this.active.values()].filter(run => run.command.workspaceId === workspace.id ||
      (profile.effectiveProfile !== 'readonly' &&
        (withinWorkspace(run.workspacePath, workspace.path) || withinWorkspace(workspace.path, run.workspacePath))))
    if (profile.effectiveProfile === 'readonly'
      ? other.filter(run => run.profile.effectiveProfile === 'readonly').length >= workspace.maxConcurrent
      : other.some(run => run.profile.effectiveProfile !== 'readonly')) throw new WorkerError('WORKSPACE_BUSY')
    const adapter = probe.adapter, adapterConfig = this.config.adapters[command.adapter]
    if (command.model?.startsWith('-') || command.resume?.cliSessionId.startsWith('-')) throw new WorkerError('INVALID')
    const extraArgs = filterExtraArgs(command.extraArgs ?? [], adapterConfig.allowedExtraArgs, count => this.warn('Ignored ' + count + ' disallowed arguments'))
    const invocationInput = { exe: probe.result.exe, prompt: command.prompt, cwd,
      profile: profile.effectiveProfile, extraArgs, adapterConfig, ...(command.resume && { resumeSessionId: command.resume.cliSessionId }),
      ...(command.model && { model: command.model }) }
    const build = (prompt: string, repair?: { resume?: string }) => {
      const input = { ...invocationInput, prompt }
      if (repair) {
        delete input.resumeSessionId
        if (repair.resume) input.resumeSessionId = repair.resume
      }
      return personal ? personalInvocation(personal.role, adapter, input, !!personal.planSources || personal.gate?.kind === 'debug', personal.binding) : adapter.buildInvocation(input)
    }
    const invocation = build(command.prompt)
    const reservedEnv = new Set(Object.keys(invocation.env).map(key => key.toUpperCase()))
    const { env, knownSecrets } = buildEnvironment(process.env, { ...adapterConfig, env: { ...adapterConfig.env, ...invocation.env } },
      Object.fromEntries(Object.entries(command.env ?? {}).filter(([key]) => !reservedEnv.has(key.toUpperCase()))),
      this.config.security.allowedEnvOverrideKeys)
    const run: ActiveRun = { command, profile, workspacePath: workspace.path, state: 'starting', started: this.clock.monotonic(), lastOutput: this.clock.monotonic(),
      abort: new AbortController(), grace: new AbortController(), discard: false, ...this.completion() }
    if (command.harness && this.config.harness.enabled) {
      run.harness = { applied: computeApplied(command.harness, workspace.harness, profile.effectiveProfile, workspace.configExposed), round: 0, epochPre: 0, writerActive: false }
    }
    const activate = () => {
      if (profile.effectiveProfile !== 'readonly') this.advanceEpoch(workspace.id)
      this.active.set(command.runId, run)
      this.reporting.add(command.runId)
      this.outbox.register(command.runId, command.taskId)
      return () => void this.launch(run, invocation, build, workspace.path, cwd, env, knownSecrets, adapter.createParser(),
        adapter.features.liveInput, probe.result.version, adapterConfig.stderrEncoding, checkBinding)
    }
    return { run, activate }
  }
  private completion() {
    let complete!: () => void
    const done = new Promise<void>(resolve => { complete = resolve })
    return { done, complete }
  }
  private advanceEpoch(id: string) { this.writeEpoch.set(id, (this.writeEpoch.get(id) ?? 0) + 1) }
  private async launch(run: ActiveRun, invocation: Invocation, build: (prompt: string, repair?: { resume?: string }) => Invocation, root: string, cwd: string, env: NodeJS.ProcessEnv,
    knownSecrets: Record<string, string>, parser: OutputParser, liveInput: boolean, cliVersion: string | undefined, stderrEncoding: 'utf8' | 'gbk',
    checkBinding: () => void = () => {}) {
    const id = run.command.runId
    const stopped = () => {
      if (run.harness && this.clock.monotonic() - run.started >= run.command.timeoutMs) run.stop ??= 'TIMEOUT'
      if (!run.stop) return false
      if (run.aggregate?.status === 'succeeded') {
        const reason = run.stop === 'CANCELLED' || run.stop === 'WORKER_SHUTDOWN' ? run.stop : 'BUDGET_EXHAUSTED'
        const attempts = run.harness?.round ?? 0
        this.finish(run, { ...run.aggregate, durationMs: Math.floor(this.clock.monotonic() - run.started),
          verification: { status: 'unverified', reason, attempts, failed: [], autoFix: { attempts, stoppedBy: 'ABORTED' } } })
        return true
      }
      const status = run.harness && (run.stop === 'TIMEOUT' || run.stop === 'IDLE_TIMEOUT') ? 'timed_out' : 'cancelled'
      this.finish(run, { kind: 'finished', status, errorCode: run.stop, exitCode: null, signal: null, durationMs: 0, summary: '' })
      return true
    }
    if (stopped()) return
    const session = run.harness
    const workspace = run.command.workspaceId
    const personalRoot = run.command.personal?.binding.root ?? root
    const flexiblePersonal = run.command.personal?.binding.mode === 'flexible'
    const workspaceMeta = this.config.workspaces.find(ws => ws.id === workspace)!
    const localHarness = workspaceMeta.harness
    const visualConfig = resolveVisualConfig(localHarness.visual, run.command.subdir)
    const visualEligible = !!session && session.applied.trust === 'owner' && !run.command.personal &&
      !workspaceMeta.configExposed && run.profile.effectiveProfile !== 'readonly' &&
      visualConfig.enabled && !!visualConfig.url
    const baselineOpts = {
      ...(run.command.personal?.binding.mode && { mode: run.command.personal.binding.mode }),
      ...(run.command.personal?.binding.autoCommit !== undefined && { autoCommit: run.command.personal.binding.autoCommit }),
      ...(run.command.personal?.inlinePrompt !== undefined && { inlinePrompt: run.command.personal.inlinePrompt }),
      ...(run.command.personal?.expectedTree !== undefined && { expectedTree: run.command.personal.expectedTree }),
    }
    // 黑板与 AGENTS.md 跟着项目走：任务在项目文件夹（Forma、Forma/src）里时用 Forma/.board，否则用工作区根目录
    const boardRoot = projectBoardRoot(root, run.command.subdir)
    const personalVerifyCommands = flexiblePersonal && personalRoot !== root
      ? localHarness.verify.commands.filter(c => isCommandBoundToProject(root, personalRoot, c))
      : localHarness.verify.commands
    const execution = run.command.personal?.execution
    let verificationConfig = localHarness.verify
    if (execution) {
      try {
        planBaseline(personalRoot, execution, !run.command.personal?.repair, baselineOpts)
        verificationConfig = { ...verificationConfig, commands: requiredCommands(execution, personalVerifyCommands, flexiblePersonal && !!run.command.personal?.noChecks, root) }
      } catch (err) {
        const msg = err instanceof Error && err.message === 'CHECKS_REBASELINE_REQUIRED'
          ? 'CHECKS_REBASELINE_REQUIRED'
          : 'PROJECT_BASELINE_OR_REQUIRED_CHECK_CHANGED'
        this.finish(run, { kind: 'finished', status: 'failed', errorCode: 'ADAPTER_ERROR', exitCode: null, signal: null,
          durationMs: Math.floor(this.clock.monotonic() - run.started), summary: msg })
        return
      }
    }
    const effectiveVisual: typeof localHarness.visual = { ...localHarness.visual, subdirOverrides: {} }
    if (visualEligible && visualConfig.startCommand) effectiveVisual.startCommand = visualConfig.startCommand
    else delete effectiveVisual.startCommand
    const effectiveHarness: typeof localHarness = {
      ...localHarness,
      verify: {
        ...localHarness.verify,
        commands: run.command.personal
          ? (execution ? verificationConfig.commands : [])
          : (session?.applied.verify ? verificationConfig.commands : []),
      },
      visual: effectiveVisual,
    }
    let plan: ReturnType<typeof preparePlan> | undefined
    let gate: ReturnType<typeof roleInput> | undefined
    if (run.command.personal?.delivery) {
      const action = run.command.personal.delivery
      let verification: VerificationSummary | undefined
      try {
        checkBinding()
        this.checkWriter(workspace, root)
        if (!this.journal.projectOccupation.permits(personalRoot, run.command.personal.projectId)) throw new Error('PROJECT_OCCUPIED')
        const commands = requiredCommands(action.spec, personalVerifyCommands, flexiblePersonal && !!run.command.personal?.noChecks, root)
        const verified = await deliver(run.command.personal.binding, action, run.abort.signal, checkBinding, async () => {
          if (!commands.length && flexiblePersonal && run.command.personal?.noChecks) return
          if (!session?.applied.verify) throw new Error('CORE_CHECKS_UNAVAILABLE')
          requiredCommands(action.spec, personalVerifyCommands, false, root)
          const confirm = this.journal.verificationHolds.begin(id, workspace, root)
          run.pauseIdle = true
          const result = await verifyAttempt({ clock:this.clock, root, runId:id, deadline:run.started+run.command.timeoutMs,
            signal:run.abort.signal, force:run.grace.signal, warn:this.warn, knownSecrets, patterns:this.patterns, journal:this.journal,
            useJobObject:this.config.security.useJobObject, emit:ev=>this.outbox.push(id,ev),
            log:(stream,text)=>this.outbox.push(id,{kind:'log',stream,...boundLogLine({text},this.maxLogEntryBytes)}) },
          {...localHarness.verify,commands},1)
          verification = result.summary
          if (!result.cleanupUnconfirmed) confirm()
          if (result.cleanupUnconfirmed || verification.status !== 'passed') throw new Error('FINAL_CHECKS_NOT_PASSED')
          requiredCommands(action.spec, personalVerifyCommands, false, root)
        }, run.command.personal.inlinePrompt)
        const summary = JSON.stringify({...verified,kind:action.kind,itemId:action.spec.item.id,taskId:run.command.taskId,runId:id})
        this.finish(run,{kind:'finished',status:'succeeded',exitCode:0,signal:null,summary,personalResultDigest:createHash('sha256').update(summary).digest('hex'),
          durationMs:Math.floor(this.clock.monotonic()-run.started),...(verification && {verification})})
      } catch (error) {
        const reason = error instanceof Error && /^[A-Z_]{1,80}$/u.test(error.message) ? error.message : 'GIT_OR_CHECK_RESULT_UNCONFIRMED'
        const observation = await observeDelivery(run.command.personal.binding,checkBinding)
        this.outbox.push(id,{kind:'log',stream:'system',text:JSON.stringify({step:action.kind,reason,...observation})})
        this.finish(run,{kind:'finished',status:'failed',exitCode:null,signal:null,errorCode:'ADAPTER_ERROR',summary:reason,
          durationMs:Math.floor(this.clock.monotonic()-run.started),...(verification && {verification})})
      }
      return
    }
    if (run.command.personal?.gate) {
      try {
        checkBinding()
        requiredCommands(run.command.personal.gate.spec, personalVerifyCommands, flexiblePersonal && !!run.command.personal?.noChecks, root)
        gate = roleInput(personalRoot, run.command)
        invocation = build(gate.prompt)
      } catch (err) {
        const msg = err instanceof Error && err.message === 'CHECKS_REBASELINE_REQUIRED'
          ? 'CHECKS_REBASELINE_REQUIRED'
          : 'Complete role input or repository binding unavailable'
        this.finish(run,{ kind:'finished',status:'failed',errorCode:'ADAPTER_ERROR',exitCode:null,signal:null,
          durationMs:Math.floor(this.clock.monotonic()-run.started),summary:msg })
        return
      }
    }
    if (run.command.personal?.planSources) {
      try {
        checkBinding()
        const checks = personalVerifyCommands
        plan = preparePlan(personalRoot, run.command.personal.planSources, checks.map(c => c.id),
          computeChecksDigest(root, checks), {
            ...(run.command.personal.binding.mode && { mode: run.command.personal.binding.mode }),
            ...(run.command.personal.binding.autoCommit !== undefined && { autoCommit: run.command.personal.binding.autoCommit }),
            ...(run.command.personal.inlinePrompt !== undefined && { inlinePrompt: run.command.personal.inlinePrompt }),
            ...(run.command.personal.boardContext !== undefined && { boardContext: run.command.personal.boardContext }),
            ...(run.command.personal.methodBlock !== undefined && { methodBlock: run.command.personal.methodBlock }),
          })
        invocation = build(plan.prompt)
      } catch {
        this.finish(run, { kind: 'finished', status: 'failed', errorCode: 'ADAPTER_ERROR', exitCode: null, signal: null,
          durationMs: Math.floor(this.clock.monotonic() - run.started), summary: 'Planning requires tracked requirements, configured checks, a clean checkout and an unused TASKS.md' })
        return
      }
    }
    let stagedTempDir: string | undefined
    let effectiveCommand = run.command
    if (!session?.round && run.command.attachments?.length && !run.command.personal) {
      try {
        stagedTempDir = createRunTempDir(this.tempRoot)
        const staged = stageRunAttachments(stagedTempDir, run.command.attachments)
        const lines = ['[用户附件（已暂存到本地临时目录，请直接查看或分析以下文件）]',
          ...staged.map(a => `- ${a.kind} (${a.mimeType}) ${a.name}: ${a.path}`)]
        const annotatedPrompt = run.command.prompt + '\n\n' + lines.join('\n')
        effectiveCommand = { ...run.command, prompt: annotatedPrompt }
        invocation = build(annotatedPrompt)
      } catch {
        if (stagedTempDir) removeRunTempDir(stagedTempDir)
        this.finish(run, { kind: 'finished', status: 'failed', errorCode: 'ADAPTER_ERROR', exitCode: null, signal: null, durationMs: 0, summary: 'Failed to stage run attachments' })
        return
      }
    }
    let visualHeld = false
    const visualCtx = () => ({
      root, runId: id, clock: this.clock, signal: run.abort.signal, force: run.grace.signal,
      warn: this.warn, journal: this.journal, useJobObject: this.config.security.useJobObject,
      patterns: this.patterns, knownSecrets,
      beginHold: () => this.journal.verificationHolds.begin(id, workspace, root),
      onCleanupUnconfirmed: () => { visualHeld = true },
    })
    const emitVisual = (vis: Omit<Extract<Parameters<RunOutbox['push']>[1], { kind: 'visual' }>, 'seq' | 'ts'>) => {
      if (vis.shots.length <= 1) {
        this.outbox.push(id, vis)
        return
      }
      const failedFlags = vis.shots.map(shot => isVisualShotFailed(shot, visualConfig))
      const preserveGroupFailure = vis.status === 'failed' && !failedFlags.some(Boolean)
      for (const [i, shot] of vis.shots.entries()) {
        const shotFailed = preserveGroupFailure || failedFlags[i]!
        this.outbox.push(id, { ...vis, status: shotFailed ? 'failed' : 'passed', shots: [shot] })
      }
    }
    let preVisual: Omit<Extract<Parameters<RunOutbox['push']>[1], { kind: 'visual' }>, 'seq' | 'ts'> | undefined
    const probe = this.registry.get(run.command.adapter)!
    if (session && !session.round) {
      try {
        session.epochPre = this.writeEpoch.get(workspace) ?? 0
        session.writerActive = [...this.active.values()].some(other => other.command.workspaceId === workspace && other.profile.effectiveProfile !== 'readonly')
        if (session.applied.board !== 'off') {
          session.pre = await readBoard(boardRoot, knownSecrets, this.patterns)
          if (stopped()) { if (stagedTempDir) removeRunTempDir(stagedTempDir); return }
          if (session.applied.bootstrap && session.pre.dir === 'unsafe') {
            session.applied.bootstrap = false
            session.applied.downgrades.push({ field: 'bootstrap', reason: 'BOARD_UNSAFE' })
          }
        }
        if (session.applied.verify || visualEligible || (!!execution && flexiblePersonal && !!run.command.personal?.noChecks) || (run.profile.effectiveProfile === 'readonly' && localHarness.manifest.readonlyCheck)) {
          session.sensitive = sensitivePaths(root, effectiveHarness)
          const preCmd = inspectCommandFiles(root, effectiveHarness)
          session.pinnedPaths = preCmd.paths
          session.manifest = await scanManifest(root, effectiveHarness.manifest, session.sensitive, session.pinnedPaths, preCmd.unbaselined)
          if (stopped()) { if (stagedTempDir) removeRunTempDir(stagedTempDir); return }
        }
        if (session.applied.verify) session.verifyCommandIds = verificationConfig.commands.map(c => c.id)
        const agents = session.pre?.agentsMd ?? await readAgentsMd(boardRoot)
        if (stopped()) { if (stagedTempDir) removeRunTempDir(stagedTempDir); return }
        const prompt = composeRun(effectiveCommand, session, boardRoot, cwd, agents, this.clock.now())
        if (prompt !== undefined) invocation = build(prompt)
      } catch {
        if (stagedTempDir) removeRunTempDir(stagedTempDir)
        this.finish(run, { kind: 'finished', status: 'failed', errorCode: 'ADAPTER_ERROR', exitCode: null, signal: null, durationMs: 0, summary: 'Harness preparation failed' })
        return
      }
      if (visualEligible && visualConfig.captureBefore) {
        if (session.manifest && !session.manifest.summary.truncated) {
          preVisual = await runVisualCheck(visualCtx(), visualConfig, 'before', this.visualBackend)
          if (stopped()) { if (stagedTempDir) removeRunTempDir(stagedTempDir); return }
        } else {
          preVisual = { kind: 'visual', phase: 'before', status: 'skipped', reason: 'MANIFEST_INCOMPLETE', shots: [] }
        }
      }
    }
    let lineRedactor = createRedactor(knownSecrets, this.patterns)
    let stderrRedactor = createRedactor(knownSecrets, this.patterns)
    let currentPatterns = this.patterns
    // Streams have independent PEM state so interleaved stderr cannot end stdout masking.
    const scrub = (stream: 'stdout' | 'stderr', line: string) => {
      if (currentPatterns !== this.patterns) {
        const next = createRedactor(knownSecrets, this.patterns)
        const oldOut = lineRedactor, oldErr = stderrRedactor
        lineRedactor = value => next(oldOut(value))
        const nextErr = createRedactor(knownSecrets, this.patterns)
        stderrRedactor = value => nextErr(oldErr(value))
        currentPatterns = this.patterns
      }
      return (stream === 'stdout' ? lineRedactor : stderrRedactor)(line.includes('\x1b') ? stripVTControlCharacters(line) : line)
    }
    let finalPatterns = this.patterns
    let finalRedactor = createRedactor(knownSecrets, finalPatterns)
    const freshScrub = (text: string) => {
      if (finalPatterns !== this.patterns) { finalPatterns = this.patterns; finalRedactor = createRedactor(knownSecrets, finalPatterns) }
      return finalRedactor(text)
    }
    const mapFile = (file: string) => {
      try { return mapWorkspaceFile(root, cwd, file).slice(0, 512) }
      catch { this.warn('Run reported a file outside the workspace', 'PATH_REJECTED'); return '<outside-workspace>' }
    }
    const logLimit = Math.min(16 * 1024, this.maxLogEntryBytes)
    const personalResult = run.command.personal && new PersonalResult(run.command.personal.role, run.command.adapter, flexiblePersonal)
    const stdout = new NdjsonLineSplitter(personalResult ? 256 * 1024 : Math.max(1, logLimit - 64))
    const stderr = new NdjsonLineSplitter(Math.max(1, logLimit - 64))
    const stderrDecoder = stderrEncoding === 'gbk' ? new TextDecoder('gbk') : undefined
    let local: LocalLog | undefined
    const append = (text: string) => {
      try { local?.append(text) }
      catch { this.warn('Local run log write failed'); local = undefined }
    }
    const localFilter = () => {
      const redact = createRedactor(knownSecrets, this.patterns)
      return (text: string) => redact(text.includes('\x1b') ? stripVTControlCharacters(text) : text)
    }
    const fullOut = new LocalLogStream(localFilter(), append)
    const fullErr = new LocalLogStream(localFilter(), append)
    let spawnError = false
    let tempDir: string | undefined = stagedTempDir
    let stopParserTimer: (() => void) | undefined
    let cliExited = false
    let stopAtExit: StopReason | undefined
    let started = false
    const finish = async (code: number | null, signal: NodeJS.Signals | null, treeClosed = true) => {
      stopParserTimer?.()
      if (tempDir) {
        try { removeRunTempDir(tempDir) }
        catch { this.warn('Run temp file cleanup failed') }
      }
      if (personalResult && !treeClosed) {
        try { this.journal.verificationHolds.recover(id,workspace,root) }
        catch { this.cleanupRecordFailed = true; this.warn('Could not persist personal cleanup hold') }
      }
      const stop = cliExited ? stopAtExit : run.stop
      const outcome = parser.finish({ code, signal, timedOut: stop === 'TIMEOUT' || stop === 'IDLE_TIMEOUT', cancelled: !!stop }, item)
      if (personalResult && outcome.status === 'succeeded') {
        const text = personalResult.finish()
        if (text !== undefined && treeClosed && !run.stop) {
          try {
            if (plan || gate) checkBinding()
            outcome.summary = plan ? JSON.stringify(plan.install(freshScrub(text))) : gate ? JSON.stringify(gate.finish(freshScrub(text))) : text
          } catch {
            outcome.status = 'failed'
            outcome.errorCode = 'ADAPTER_ERROR'
            outcome.summary = 'Role output or repository baseline failed validation; inspect the workspace'
          }
        }
        else {
          outcome.status = 'failed'
          outcome.errorCode = 'ADAPTER_ERROR'
          outcome.summary = 'Personal role result or process cleanup unconfirmed'
        }
      }
      const { filesChanged, ...result } = outcome
      const scrubbedSummary = freshScrub(result.summary)
      const finished: Extract<Parameters<RunOutbox['push']>[1], { kind: 'finished' }> = { kind: 'finished', ...result, exitCode: code, signal, durationMs: Math.floor(this.clock.monotonic() - run.started),
        summary: scrubbedSummary.slice(0, 20_000),
        ...(personalResult && result.status === 'succeeded' &&
          { personalResultDigest: createHash('sha256').update(scrubbedSummary).digest('hex') }),
        ...(result.errorMessage && { errorMessage: freshScrub(result.errorMessage).slice(0, 2000) }),
        ...(filesChanged && { filesChanged: filesChanged.slice(0, 200).map(mapFile) }),
        ...(stop && { errorCode: stop }), ...(spawnError && !stop && { status: 'failed', errorCode: 'SPAWN_ERROR' }) }
      if (!session) { this.finish(run, finished); return }
      const round = session.round
      const requested = !!run.command.harness?.verify
      run.aggregate = aggregateRound(run.aggregate, finished)
      const aggregate = run.aggregate
      let verification: VerificationSummary | undefined
      let verificationHeld = false
      let attempts = round
      const deadline = run.started + run.command.timeoutMs
      const interrupted = (): VerificationSummary | undefined => {
        if (!run.stop && this.clock.monotonic() < deadline) return
        const reason = run.stop === 'WORKER_SHUTDOWN' ? 'WORKER_SHUTDOWN' : run.stop === 'CANCELLED' ? 'CANCELLED' : 'BUDGET_EXHAUSTED'
        return { status: 'unverified', reason, attempts, failed: [] }
      }
      const checkpoint = () => this.journal.cliExited(id, { round, verifyRequested: requested, verifyAttempts: attempts, outcome: finished })
      run.pauseIdle = true
      try {
        checkpoint()
        if ((!started && !round) || !treeClosed || run.treeCleanupFailed) throw new Error('CLI tree unavailable')
        if (round && finished.status !== 'succeeded') {
          this.outbox.push(id, { kind: 'log', stream: 'system', text: 'Repair round ' + round + ' ended with ' + (code ?? signal ?? finished.status) })
        }
        const event = await capturePost(session, root, effectiveHarness, knownSecrets, this.patterns, run.profile.effectiveProfile,
          () => (this.writeEpoch.get(workspace) ?? 0) !== session.epochPre, boardRoot)
        const post = event.board
        this.outbox.push(id, event)
        let afterVisual: Omit<Extract<Parameters<RunOutbox['push']>[1], { kind: 'visual' }>, 'seq' | 'ts'> | undefined
        if (visualEligible && aggregate.status === 'succeeded' && !event.tamper && !!event.changes &&
            !event.changes.truncated && !(round === 0 && (!event.changes.total || event.changes.boardOnly)) && !interrupted()) {
          run.grace = new AbortController()
          afterVisual = await runVisualCheck(visualCtx(), visualConfig, 'after', this.visualBackend)
          emitVisual(afterVisual)
        }
        if (requested && aggregate.status === 'succeeded') {
          if (execution) { checkBinding(); planBaseline(personalRoot, execution, false, baselineOpts) }
          if (execution && flexiblePersonal && run.command.personal?.noChecks && !session.applied.verify) {
            if (event.tamper) verification = { status: 'skipped', reason: 'TAMPER_RISK', attempts, failed: [] }
            else if (!event.changes || event.changes.truncated) verification = { status: 'unverified', reason: 'MANIFEST_INCOMPLETE', attempts, failed: [] }
            else {
              const candidate = checkedCandidate(personalRoot)
              if (candidate.head !== execution.head) throw new Error('CANDIDATE_CHANGED')
              aggregate.testedCandidate = candidate
              verification = { status: 'skipped', reason: 'NO_COMMANDS', attempts: 0, failed: [] }
            }
          } else if (!session.applied.verify && afterVisual?.status !== 'failed') {
            verification = afterVisual?.status === 'passed'
              ? { status: 'passed', attempts: attempts + 1, failed: [] }
              : { status: 'skipped', reason: session.applied.downgrades.some(d => d.reason === 'CONFIG_EXPOSED') ? 'CONFIG_EXPOSED' : 'NO_COMMANDS', attempts, failed: [] }
          } else if (!event.changes || event.changes.truncated) verification = { status: 'unverified', reason: 'MANIFEST_INCOMPLETE', attempts, failed: [] }
          else if (event.tamper) verification = { status: 'skipped', reason: 'TAMPER_RISK', attempts, failed: [] }
          else if (round === 0 && (!event.changes.total || event.changes.boardOnly)) verification = { status: 'skipped', reason: 'NO_CHANGES', attempts, failed: [] }
          else if (!interrupted()) {
            const candidate = execution ? checkedCandidate(personalRoot) : undefined
            attempts++
            checkpoint()
            run.grace = new AbortController()
            let summary: VerificationSummary
            let results: VerifyCommandResult[]
            if (session.applied.verify) {
              const confirmCleanup = this.journal.verificationHolds.begin(id, workspace, root)
              verificationHeld = true
              const ran = await verifyAttempt({ clock: this.clock, root, runId: id, deadline, signal: run.abort.signal,
                force: run.grace.signal, warn: this.warn, knownSecrets, patterns: this.patterns, journal: this.journal, useJobObject: this.config.security.useJobObject,
                emit: ev => this.outbox.push(id, ev), log: (stream, text) => {
                  append(text + '\n')
                  this.outbox.push(id, { kind: 'log', stream, ...boundLogLine({ text }, logLimit) })
                } }, verificationConfig, attempts)
              summary = ran.summary
              results = ran.results
              if (!ran.cleanupUnconfirmed) {
                confirmCleanup()
                verificationHeld = false
              }
            } else {
              summary = { status: 'passed', attempts, failed: [] }
              results = []
            }
            if (!execution && afterVisual?.status === 'failed') {
              const visualResult: VerifyCommandResult = {
                id: 'visual-check', status: 'failed', exitCode: 1, signal: null,
                durationMs: afterVisual.shots.reduce((sum, s) => sum + s.durationMs, 0),
                tail: visualFailureTail({ seq: 1, ts: this.clock.now(), ...afterVisual }),
              }
              results = [...results, visualResult]
              if (summary.status === 'passed') summary = { status: 'failed', attempts, failed: ['visual-check'] }
              else if (!summary.failed.includes('visual-check')) summary.failed.push('visual-check')
            }
            try { local?.flush() } catch { this.warn('Local verification log flush failed') }
            verification = summary
            if (execution && candidate) {
              checkBinding()
              planBaseline(personalRoot, execution, false, baselineOpts)
              if (candidate.head !== execution.head) throw new Error('CANDIDATE_CHANGED')
              checkedCandidate(personalRoot, candidate)
              aggregate.testedCandidate = candidate
            }
            const visualOnlyMaxRetries = !session.applied.verify
              ? (session.applied.trust === 'owner'
                ? Math.min(localHarness.verify.maxAutoFixRetries, run.command.harness?.verify?.autoFixMaxRetries ?? 0)
                : 0)
              : session.applied.autoFixMaxRetries
            const facts = !(verificationHeld || visualHeld) && nextRepair(summary, results, event.changes, round, visualOnlyMaxRetries, deadline - this.clock.monotonic(), run.command.timeoutMs)
            if (facts && !interrupted()) {
              const resume = probe.adapter?.features.resume && aggregate.cliSessionId && !aggregate.cliSessionId.startsWith('-') ? aggregate.cliSessionId : undefined
              const repairBoard = !resume && session.applied.board !== 'off' ? await readBoard(boardRoot, knownSecrets, this.patterns) : post
              const agents = repairBoard?.agentsMd ?? await readAgentsMd(boardRoot)
              if (!interrupted()) {
                const prompt = composeRun(run.command, session, boardRoot, cwd, agents, this.clock.now(), undefined, { facts, resumed: !!resume, ...(repairBoard && { board: repairBoard }) })
                if (!prompt) throw new Error('Could not compose repair prompt')
                const next = build(prompt, resume ? { resume } : {})
                session.round++
                run.pauseIdle = false
                run.lastOutput = this.clock.monotonic()
                run.grace = new AbortController()
                await this.launch(run, next, build, root, cwd, env, knownSecrets, probe.adapter!.createParser(), liveInput, cliVersion, stderrEncoding, checkBinding)
                return
              }
            }
          }
          verification = interrupted() ?? verification
        }
      } catch {
        this.warn('Harness post capture, verification or journal write failed')
        if (requested && aggregate.status === 'succeeded') verification = interrupted() ?? { status: 'unverified', reason: 'INTERNAL', attempts, failed: [] }
      }
      if (verificationHeld || visualHeld) {
        this.outbox.push(id, { kind: 'log', stream: 'system', text: 'VERIFY_CLEANUP_UNCONFIRMED: workspace quarantined; new writers blocked' })
      }
      if (round && verification && !verification.autoFix) {
        const stoppedBy = verification.status === 'passed' ? 'PASSED' : verification.reason === 'TAMPER_RISK' ? 'TAMPER_RISK'
          : verification.reason === 'MANIFEST_INCOMPLETE' ? 'MANIFEST_INCOMPLETE' : verification.status === 'failed' ? 'MAX_RETRIES' : 'ABORTED'
        verification.autoFix = { attempts: round, stoppedBy }
      }
      this.finish(run, { ...aggregate, durationMs: Math.floor(this.clock.monotonic() - run.started), ...(verification && { verification }) })
    }
    const item = (entry: ParsedItem, truncatedBytes?: number) => {
      if (entry.kind === 'input_request') {
        if (!liveInput || run.state === 'cancelling' || run.requestId) return
        run.requestId = ulid(this.clock.now())
        run.state = 'awaiting_input'
        this.outbox.push(id, { ...entry, requestId: run.requestId })
      } else if (entry.kind === 'agent') {
        const event = entry.event
        // Reassembled messages and decoded JSON strings can expose secrets split or escaped in the input.
        const limits = { text: event.type === 'thinking' ? 8000 : 16000, command: 2000, outputTail: 4000,
          name: 128, summary: event.type === 'tool_use' ? 1000 : 2000, message: 4000 }
        const scrubbed = { ...event }
        for (const [key, limit] of Object.entries(limits)) {
          const value = Reflect.get(event, key)
          if (typeof value === 'string') Reflect.set(scrubbed, key, freshScrub(value).slice(0, limit))
        }
        if (scrubbed.type === 'file_change') scrubbed.path = mapFile(scrubbed.path)
        this.outbox.push(id, { ...entry, event: scrubbed })
      } else this.outbox.push(id, entry.kind === 'log' ? { ...entry, ...boundLogLine({ text: entry.text, ...(truncatedBytes && { truncatedBytes }) }, logLimit) } : entry)
    }
    const processLine = (stream: 'stdout' | 'stderr', line: SplitLine) => {
      if (stream === 'stdout') personalResult?.observe(line.text, !!line.truncatedBytes)
      const clean = scrub(stream, line.text)
      if (stream === 'stdout' && run.command.adapter === 'mock' && run.tree?.mode === 'taskkill') {
        const tracked = /^\{"type":"pid","pid":(\d+),"ppid":\d+\}$/.exec(clean)
        if (tracked) run.tree.observe(Number(tracked[1]))
      }
      const parsed = stream === 'stdout' ? parser.onStdout(clean) : parser.onStderr(clean)
      for (const entry of parsed) item(entry, line.truncatedBytes)
    }
    try {
      local = new LocalLog(this.logRoot, id, this.config.localLogs.maxBytesPerRun)
      const verified = resolveWorkspaceSubdir(root, run.command.subdir)
      if (verified !== cwd) throw new Error('Working directory changed before spawn')
      checkBinding()
      if (run.profile.effectiveProfile !== 'readonly') this.checkWriter(run.command.workspaceId, root)
      if (run.profile.effectiveProfile !== 'readonly' && !this.journal.projectOccupation.permits(personalRoot, run.command.personal?.projectId)) {
        throw new WorkerError('WORKSPACE_BUSY', 'PROJECT_OCCUPIED')
      }
      if (invocation.tempFiles?.length) {
        tempDir ??= createRunTempDir(this.tempRoot)
        writeRunTempFiles(tempDir, invocation, env)
      }
      const child = spawnRun(invocation, verified, env)
      run.child = child
      child.once('error', () => { spawnError = true })
      let drainTimer: NodeJS.Timeout | undefined
      let finalized = false
      const stopTree = () => run.kill ??= run.tree?.kill({ force: true }).catch(() => {
        run.treeCleanupFailed = true
        this.warn('Process tree cleanup failed')
      }) ?? Promise.resolve()
      child.once('exit', (code, signal) => {
        cliExited = true
        stopAtExit = run.stop
        if (session) run.pauseIdle = true
        run.grace.abort()
        void stopTree()
        drainTimer = setTimeout(() => {
          if (personalResult) run.treeCleanupFailed = true
          this.outbox.push(id, { kind: 'log', stream: 'system', text: 'CLI pipe drain timed out; closing stdout and stderr' })
          child.stdout.destroy()
          child.stderr.destroy()
          finalize(code, signal)
        }, this.config.shutdown.pipeDrainTimeoutMs)
      })
      const finalize = (code: number | null, signal: NodeJS.Signals | null) => {
        if (finalized) return
        finalized = true
        clearTimeout(drainTimer)
        if (stderrDecoder) {
          const remaining = Buffer.from(stderrDecoder.decode())
          fullErr.push(remaining)
          for (const line of stderr.push(remaining)) processLine('stderr', line)
        }
        fullOut.finish()
        fullErr.finish()
        try { local?.flush() } catch { this.warn('Local run log flush failed') }
        for (const line of stdout.finish()) processLine('stdout', line)
        for (const line of stderr.finish()) processLine('stderr', line)
        void stopTree().then(() => {
          try { run.tree?.close() } catch { this.warn('Process tree close failed') }
          delete run.tree
          delete run.child
          delete run.kill
          return finish(code, signal, !run.treeCleanupFailed)
        })
      }
      child.once('close', finalize)
      if (child.pid) {
        run.tree = trackProcessTree(child.pid, { useJobObject: this.config.security.useJobObject, onWarning: warning => {
          const code = typeof warning === 'object' && warning && 'code' in warning ? String(warning.code) : 'PROCESS_TREE_FALLBACK'
          if (code === 'ORPHAN_SURVIVED') run.treeCleanupFailed = true
          const text = code === 'ORPHAN_SURVIVED' ? 'Process tree survived forced termination' : 'Using process tree fallback'
          this.warn(text, code)
          this.outbox.push(id, { kind: 'log', stream: 'system', text: code + ' ' + text })
        } })
        const pidStartTime = run.tree.startTime
        this.journal.process({ runId: id, role: 'cli',
          pid: child.pid, ...(pidStartTime && { pidStartTime }) })
        run.state = 'running'
        const { effectiveProfile, clampedFrom } = run.profile
        if (!session?.round) this.outbox.push(id, { kind: 'started', pid: child.pid, adapter: run.command.adapter, effectiveProfile,
          ...(clampedFrom && { clampedFrom }), ...(cliVersion && { cliVersion }),
          commandSummary: freshScrub(run.command.adapter + (clampedFrom ? ' (profile clamped)' : '')) })
        started = true
        if (session && !session.round) this.outbox.push(id, { kind: 'harness', ...(session.manifest && { manifest: session.manifest.summary }), applied: session.applied, ...(session.pre && { board: session.pre }), ...(session.prompt && { prompt: session.prompt }) })
        if (preVisual) emitVisual(preVisual)
        writePrompt(child, invocation.stdin, liveInput)
      }
      child.stdout.on('data', (chunk: Buffer) => {
        run.lastOutput = this.clock.monotonic()
        fullOut.push(chunk)
        for (const line of stdout.push(chunk)) processLine('stdout', line)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        run.lastOutput = this.clock.monotonic()
        const bytes = stderrDecoder ? Buffer.from(stderrDecoder.decode(chunk, { stream: true })) : chunk
        fullErr.push(bytes)
        for (const line of stderr.push(bytes)) processLine('stderr', line)
      })
      if (parser.flushPending) stopParserTimer = this.clock.setInterval(() => {
        for (const entry of parser.flushPending?.() ?? []) item(entry)
      }, 100)
    } catch {
      spawnError = true
      if (run.child) { void run.tree?.kill({ force: true }).catch(() => undefined); run.child.kill() }
      else finish(null, null)
    }
  }
  maxLogEntryBytes = 16 * 1024
  private finish(run: ActiveRun, event: Extract<Parameters<RunOutbox['push']>[1], { kind: 'finished' }>) {
    const id = run.command.runId
    if (run.command.harness?.verify && !event.verification) {
      event.verification = { status: 'skipped', reason: event.status === 'succeeded' ? 'NO_COMMANDS' : 'CLI_NOT_SUCCEEDED', attempts: 0, failed: [] }
    }
    if (run.profile.effectiveProfile !== 'readonly') this.advanceEpoch(run.command.workspaceId)
    this.active.delete(id)
    this.completed.set(id, true)
    if (run.discard) this.outbox.discard(id)
    else this.outbox.push(id, event, stored => {
      if (stored.kind === 'finished') {
        try { this.journal.finished(id, stored) }
        catch { this.warn('Terminal event could not be written to the journal') }
      }
    })
    run.complete()
  }
  provide(input: RunInput) {
    const run = this.active.get(input.runId)
    const inputKey = input.runId + '\0' + input.requestId
    if (this.deliveredInputs.has(inputKey)) return
    if (!run?.child || run.state !== 'awaiting_input' || run.requestId !== input.requestId || !run.child.stdin.writable) throw new WorkerError('INVALID')
    const answer = /[\r\n]/.test(input.answer) && run.command.adapter === 'mock'
      ? '\x1e' + Buffer.from(input.answer).toString('base64url') : input.answer
    run.child.stdin.write(answer + '\n')
    this.deliveredInputs.set(inputKey, true)
    delete run.requestId
    run.state = 'running'
  }
  cancel(input: RunCancel) {
    if (!this.seen(input.runId)) throw new WorkerError('RUN_NOT_FOUND')
    const run = this.active.get(input.runId)
    if (run) this.stop(run, input.reason === 'input_timeout' ? 'INPUT_TIMEOUT' : 'CANCELLED', input.force, input.graceMs)
  }
  private stop(run: ActiveRun, reason: StopReason, force: boolean, graceMs = 5000) {
    if (run.stop && run.kill && !force) return
    run.stop ??= reason
    if (force) run.grace.abort()
    run.abort.abort(reason === 'WORKER_SHUTDOWN' || reason === 'CANCELLED' ? reason : 'BUDGET_EXHAUSTED')
    run.state = 'cancelling'
    run.child?.stdin.end()
    if (run.kill && !force) return
    run.kill = run.tree?.kill({ force, graceMs, signal: run.grace.signal }).catch(() => {
      run.treeCleanupFailed = true
      this.warn('Process tree termination failed')
    }) ?? Promise.resolve()
  }
  discard(id: string, cancel: boolean) {
    const run = this.active.get(id)
    if (run) { run.discard = true; if (cancel) this.stop(run, 'CANCELLED', true) }
    this.outbox.discard(id)
  }
  tick() {
    const time = this.clock.monotonic()
    for (const run of this.active.values()) {
      if (run.state === 'cancelling') continue
      if (time - run.started >= run.command.timeoutMs) this.stop(run, 'TIMEOUT', false)
      else if (!run.pauseIdle && time - run.lastOutput >= run.command.idleTimeoutMs) this.stop(run, 'IDLE_TIMEOUT', false)
    }
  }
  private checkWriter(workspaceId: string, path: string) {
    if (this.journal.verificationHolds.blocks(workspaceId, path)) {
      throw new WorkerError('WORKSPACE_BUSY', 'VERIFY_CLEANUP_UNCONFIRMED: workspace held pending cleanup confirmation')
    }
  }
  async preflightProject(payload: ProjectPreflight) {
    try {
      if (payload.mode === 'strict') {
        const binding = await preflight(this.config, payload.workspaceId, this.registry)
        const ws = this.config.workspaces.find(w => w.id === payload.workspaceId)!
        return { ok: true, binding, checks: ws.harness.verify.commands.map(c => c.id), noChecks: !ws.harness.verify.commands.length }
      }
      const res = await flexiblePreflight(this.config, payload.workspaceId, this.registry, {
        ...(payload.subdir && { subdir: payload.subdir }),
        ...(payload.autoCommit !== undefined && { autoCommit: payload.autoCommit }),
        ...(payload.autoPush !== undefined && { autoPush: payload.autoPush }),
      })
      return { ok: true, ...res }
    } catch (error) {
      return { ok: false, error: (error instanceof Error ? error.message : 'Preflight failed').slice(0, 500) }
    }
  }
  releaseProject({ projectId, workspaceId, root, subdir }: { projectId: string; workspaceId: string; root: string; subdir?: string | undefined }) {
    const workspace = this.config.workspaces.find(w => w.id === workspaceId)
    if (!workspace || resolveWorkspaceSubdir(workspace.path, subdir) !== root) throw new WorkerError('INVALID', 'PROJECT_BINDING_CHANGED')
    if (this.active.size || this.cleanupRecordFailed || this.journal.verificationHolds.blocks(workspaceId, root)) throw new WorkerError('WORKSPACE_BUSY', 'PROJECT_CLEANUP_UNCONFIRMED')
    this.journal.projectOccupation.release(root, projectId)
  }
  rebaselineProject(payload: ProjectRebaseline): { checksDigest: string; checksDigestVersion: 2 } {
    const workspace = this.config.workspaces.find(w => w.id === payload.binding.workspaceId)
    if (!workspace) throw new WorkerError('WORKSPACE_UNKNOWN')
    try {
      const expected = payload.binding.mode === 'flexible'
        ? flexibleBinding(this.config, workspace.id, this.registry, payload.binding)
        : personalBinding(this.config, workspace.id, this.registry)
      assertBinding(payload.binding, expected)
    } catch {
      throw new WorkerError('INVALID', 'PROJECT_BINDING_CHANGED')
    }
    const personalRoot = payload.binding.root
    const commands = payload.binding.mode === 'flexible' && personalRoot !== workspace.path
      ? workspace.harness.verify.commands.filter(c => isCommandBoundToProject(workspace.path, personalRoot, c))
      : workspace.harness.verify.commands
    if (payload.noChecks && commands.length) {
      throw new WorkerError('INVALID', 'LEGACY_CHECKS_MISMATCH')
    }
    if (computeLegacyChecksDigest(commands) !== payload.legacyChecksDigest) {
      throw new WorkerError('INVALID', 'LEGACY_CHECKS_MISMATCH')
    }
    try {
      return { checksDigest: computeChecksDigest(workspace.path, commands), checksDigestVersion: 2 }
    } catch (err) {
      const code = err instanceof Error && /^[A-Z0-9_]{1,64}$/u.test(err.message) ? err.message : 'COMMAND_FILES_UNBASELINED'
      throw new WorkerError('INVALID', code)
    }
  }
  activeIds() { return [...this.active.keys()] }
  awaitRuns() { return Promise.all([...this.active.values()].map(run => run.done)) }
  cancelAll() { for (const run of this.active.values()) this.stop(run, 'WORKER_SHUTDOWN', false) }
  checkpoint(runId: string, seq: number) { this.journal.progress(runId, seq) }
}
