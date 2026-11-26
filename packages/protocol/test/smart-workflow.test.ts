import { describe, expect, it } from 'vitest'
import {
  AutopilotPreflightRequest,
  AutopilotPreflightResponse,
  AutopilotStartRequest,
  canUseCommand,
  DeliveryReceipt,
  KNOWN_CAPABILITIES,
  negotiateCapabilities,
  parseCommand,
  ProjectBriefingView,
  ProjectPreflight,
  ProposalCardAction,
  RunAttachment,
  RunBriefingRequest,
  RunDispatch,
  RunEvent,
  VisualCheckShot,
} from '../src/index.js'

describe('smart-workflow protocol contracts', () => {
  it('parses /project, /briefing, and /auto commands and enforces role permissions', () => {
    expect(parseCommand('/project')).toEqual({ ok: true, cmd: { name: 'project' } })
    expect(parseCommand('/project Forma')).toEqual({ ok: true, cmd: { name: 'project', target: 'Forma' } })
    expect(parseCommand('/project alpha/web')).toEqual({ ok: true, cmd: { name: 'project', target: 'alpha/web' } })
    expect(parseCommand('/project clear')).toEqual({ ok: true, cmd: { name: 'project', target: 'clear' } })
    expect(parseCommand('/project ../escape').ok).toBe(false)
    expect(parseCommand('/project a/b/c').ok).toBe(false)

    expect(parseCommand('/briefing')).toEqual({ ok: true, cmd: { name: 'briefing' } })
    expect(parseCommand('/briefing Forma')).toEqual({ ok: true, cmd: { name: 'briefing', target: 'Forma' } })
    expect(parseCommand('/briefing alpha/web')).toEqual({ ok: true, cmd: { name: 'briefing', target: 'alpha/web' } })
    expect(parseCommand('/briefing a/b/c').ok).toBe(false)
    expect(parseCommand('/briefing ../escape').ok).toBe(false)

    expect(parseCommand('/auto status')).toEqual({ ok: true, cmd: { name: 'auto', action: 'status' } })
    expect(parseCommand('/auto stop p_1')).toEqual({ ok: true, cmd: { name: 'auto', action: 'stop', targetId: 'p_1' } })
    expect(parseCommand('/auto --dir Forma --doc=PRD.md --push 实现导出')).toEqual({
      ok: true,
      cmd: { name: 'auto', action: 'start', dir: 'Forma', doc: 'PRD.md', push: true, prompt: '实现导出' },
    })

    const autoCmd = parseCommand('/auto 修复登录')
    const projectCmd = parseCommand('/project Forma')
    const briefingCmd = parseCommand('/briefing')
    if (!autoCmd.ok || !projectCmd.ok || !briefingCmd.ok) throw new Error('expected commands to parse')

    expect(canUseCommand(autoCmd.cmd, 'owner', 'p2p')).toBe(true)
    expect(canUseCommand(autoCmd.cmd, 'requester', 'p2p')).toBe(false)
    expect(canUseCommand(autoCmd.cmd, 'requester', 'group', { allowRequesterCommands: true, allowGroupCommands: true })).toBe(false)
    expect(canUseCommand(projectCmd.cmd, 'requester', 'group')).toBe(true)
    expect(canUseCommand(briefingCmd.cmd, 'requester', 'p2p')).toBe(false)
    expect(canUseCommand(briefingCmd.cmd, 'requester', 'p2p', { allowRequesterCommands: true })).toBe(true)
    expect(canUseCommand(briefingCmd.cmd, 'owner', 'p2p')).toBe(true)
    expect(KNOWN_CAPABILITIES).toEqual(['attachments.v1', 'blackboard.v1', 'checks-digest.v2', 'preflight.v1', 'verify.v1', 'visual.v1'])
    expect(negotiateCapabilities(['visual.v1', 'verify.v1'], KNOWN_CAPABILITIES)).toEqual([])
    expect(negotiateCapabilities(['blackboard.v1', 'visual.v1'], KNOWN_CAPABILITIES)).toEqual(['blackboard.v1', 'visual.v1'])
  })

  it('validates ProposalCardAction strictly', () => {
    const validId = 'prp_' + '0'.repeat(26)
    expect(ProposalCardAction.safeParse({ v: 1, a: 'proposal_accept', p: validId }).success).toBe(true)
    expect(ProposalCardAction.safeParse({ v: 1, a: 'proposal_direct', p: validId }).success).toBe(true)
    expect(ProposalCardAction.safeParse({ v: 1, a: 'proposal_dismiss', p: validId }).success).toBe(true)
    expect(ProposalCardAction.safeParse({ v: 1, a: 'briefing_run', p: validId, idx: 1 }).success).toBe(true)

    expect(ProposalCardAction.safeParse({ v: 1, a: 'proposal_accept', p: 'bad' }).success).toBe(false)
    expect(ProposalCardAction.safeParse({ v: 1, a: 'briefing_run', p: validId, idx: 0 }).success).toBe(false)
    expect(ProposalCardAction.safeParse({ v: 1, a: 'briefing_run', p: validId, idx: 11 }).success).toBe(false)
    expect(ProposalCardAction.safeParse({ v: 1, a: 'proposal_accept', p: validId, extra: true }).success).toBe(false)
  })

  it('validates visual events, inbound attachments, preflight, autopilot, and steward DTOs', () => {
    const shot = VisualCheckShot.parse({
      route: '/dashboard',
      url: 'http://127.0.0.1:4173/dashboard',
      statusCode: 200,
      blankPage: false,
      consoleErrors: [],
      pageErrors: [],
      durationMs: 120,
      mimeType: 'image/jpeg',
      imageBase64: Buffer.from('jpeg-bytes').toString('base64'),
      artifactId: 'art_' + '0'.repeat(26),
    })
    const visualEvt = RunEvent.parse({
      kind: 'visual',
      seq: 3,
      ts: 1700000000000,
      phase: 'after',
      status: 'passed',
      shots: [shot],
    })
    expect(visualEvt.kind).toBe('visual')

    const att = RunAttachment.parse({
      id: 'art_' + '1'.repeat(26),
      kind: 'image',
      name: 'ui-bug_1.png',
      mimeType: 'image/png',
      encoding: 'base64',
      data: Buffer.from('png').toString('base64'),
    })
    expect(att.name).toBe('ui-bug_1.png')
    expect(RunAttachment.safeParse({ ...att, name: '../evil.png' }).success).toBe(false)

    expect(ProjectPreflight.parse({ workspaceId: 'soren', subdir: 'Forma', mode: 'flexible' }).mode).toBe('flexible')
    expect(AutopilotPreflightRequest.parse({ workspaceId: 'soren' }).mode).toBe('flexible')
    expect(AutopilotPreflightResponse.parse({ ok: true, workerId: 'w1', checks: ['unit'] }).ok).toBe(true)
    expect(AutopilotStartRequest.safeParse({ workspaceId: 'soren' }).success).toBe(false)
    expect(AutopilotStartRequest.safeParse({ workspaceId: 'soren', inlinePrompt: '完成导出' }).success).toBe(true)

    const briefing = ProjectBriefingView.parse({
      id: 'brf_' + '0'.repeat(26),
      workerId: 'w1',
      workspaceId: 'soren',
      subdir: 'Forma',
      kind: 'manual',
      health: 'attention',
      summary: 'Forma 存在待处理项',
      findings: [{ severity: 'warning', category: 'board_stale', message: '超过 7 天未更新' }],
      actions: [{ index: 1, title: '同步黑板', prompt: '更新 .board/HANDOFF.md', adapter: 'claude-code', profile: 'edit' }],
      createdAt: 1700000000000,
    })
    expect(briefing.actions[0]?.index).toBe(1)
    expect(RunBriefingRequest.parse({ workspaceId: 'soren', notifyFeishu: true }).notifyFeishu).toBe(true)

    // P2 #4 & P1 #7: RunDispatch supports 64-char SHA-256 expectedTree and DeliveryReceipt supports no-commit verify_final
    const sha256 = 'a'.repeat(64)
    expect(RunDispatch.parse({
      taskId: 'tsk_' + '0'.repeat(26),
      runId: 'run_' + '0'.repeat(26),
      taskNo: 1,
      attempt: 1,
      adapter: 'codex',
      workspaceId: 'soren',
      profile: 'edit',
      prompt: 'test',
      timeoutMs: 60_000,
      idleTimeoutMs: 20_000,
      notAfter: 120_000,
      origin: { source: 'dashboard', actorType: 'owner' },
      personal: {
        role: 'main',
        binding: {
          workerId: 'w1', workspaceId: 'soren', root: '/ws', branch: 'main', remote: 'local', ref: 'refs/heads/main',
          destination: sha256, executables: { main: 'codex', reviewer: 'claude', advisor: 'agy' }, mode: 'flexible',
        },
        expectedTree: sha256,
      },
    }).personal?.expectedTree).toBe(sha256)
    expect(DeliveryReceipt.parse({
      kind: 'verify_final', taskId: 'tsk_1', runId: 'run_1', itemId: 'T01', parent: sha256, tree: sha256,
    }).commit).toBeUndefined()
  })
})
