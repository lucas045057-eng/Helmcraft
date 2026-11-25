/**
 * Pi 独立验收 · 05 §5 飞书斜杠指令门禁 FS-1 ~ FS-6
 *
 * FS-1 全部指令正例的 AST
 * FS-2 英文/中文/全角引号、转义、全角空格、制表符
 * FS-3 未知指令 / 未知 flag / 缺参数 / 非法值 → 必须返回 error + usage 且不产出命令
 * FS-4 Requester 使用 Owner 专属 flag → 拒绝
 * FS-5 /run 多行 prompt 原样保留（含 CRLF）
 * FS-6 taskRef 三种形式（#123 / 123 / tsk_<ULID>）
 */
import { describe, expect, it } from 'vitest'
import { canUseCommand, parseCommand } from '../src/feishu/commands.js'
import type { ParsedCommand } from '../src/feishu/commands.js'

const tsk = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV'

function ok(text: string): ParsedCommand {
  const result = parseCommand(text)
  if (!result.ok) throw new Error('expected ' + JSON.stringify(text) + ' to parse, got ' + result.error)
  return result.cmd
}

function fail(text: string): { error: string; usage: string } {
  const result = parseCommand(text)
  if (result.ok) throw new Error('expected ' + JSON.stringify(text) + ' to fail, got ' + JSON.stringify(result.cmd))
  return result
}

describe('FS-1 每条指令的正例', () => {
  it('parses /run with every flag in = and space form', () => {
    const equals = ok('/run --cli=codex --ws=sandbox --worker=win-desktop --profile=edit --priority=3 修复登录')
    expect(equals).toEqual({
      name: 'run',
      flags: { cli: 'codex', ws: 'sandbox', worker: 'win-desktop', profile: 'edit', priority: 3 },
      prompt: '修复登录',
    })
    const spaced = ok('/run --cli codex --ws sandbox --worker win-desktop --profile edit --priority 3 修复登录')
    expect(spaced).toEqual(equals)
    expect(ok('/run 纯需求')).toEqual({ name: 'run', flags: {}, prompt: '纯需求' })
  })

  it('parses /status with and without a taskRef', () => {
    expect(ok('/status')).toEqual({ name: 'status' })
    expect(ok('/status #123')).toEqual({ name: 'status', taskRef: '#123' })
  })

  it('parses /tasks with scope and status filter', () => {
    expect(ok('/tasks')).toEqual({ name: 'tasks', scope: 'mine' })
    expect(ok('/tasks all')).toEqual({ name: 'tasks', scope: 'all' })
    expect(ok('/tasks mine')).toEqual({ name: 'tasks', scope: 'mine' })
    expect(ok('/tasks all --status=queued,running')).toEqual({
      name: 'tasks', scope: 'all', status: ['queued', 'running'],
    })
    expect(ok('/tasks --status running')).toEqual({ name: 'tasks', scope: 'mine', status: ['running'] })
  })

  it('parses /workers, /help and /whoami', () => {
    expect(ok('/workers')).toEqual({ name: 'workers' })
    expect(ok('/help')).toEqual({ name: 'help' })
    expect(ok('/whoami')).toEqual({ name: 'whoami' })
  })

  it('parses the task commands', () => {
    expect(ok('/cancel #12')).toEqual({ name: 'cancel', taskRef: '#12' })
    expect(ok('/retry 12')).toEqual({ name: 'retry', taskRef: '12' })
    expect(ok('/approve ' + tsk)).toEqual({ name: 'approve', taskRef: tsk })
    expect(ok('/reject #12 不行 需要改')).toEqual({ name: 'reject', taskRef: '#12', reason: '不行 需要改' })
    expect(ok('/reject #12')).toEqual({ name: 'reject', taskRef: '#12' })
  })

  it('parses /drain for both modes', () => {
    expect(ok('/drain win-desktop on')).toEqual({ name: 'drain', workerId: 'win-desktop', on: true })
    expect(ok('/drain win-desktop off')).toEqual({ name: 'drain', workerId: 'win-desktop', on: false })
  })
})

describe('FS-2 引号与空白', () => {
  it('accepts ASCII, Chinese and full width quotes as flag values', () => {
    for (const quoted of ['--cli="codex"', '--cli=“codex”', '--cli=＂codex＂']) {
      expect(ok('/run ' + quoted + ' 需求').flags, quoted).toEqual({ cli: 'codex' })
    }
  })

  it('accepts quotes that span whitespace inside the value', () => {
    // workspace / adapter / worker 取值有字符集限制，含空格的值只能在自由文本参数上验证
    expect(ok('/reject #1 "理由 有 空格"')).toEqual({ name: 'reject', taskRef: '#1', reason: '理由 有 空格' })
    expect(ok('/reject #1 “理由 全角 引号”')).toEqual({ name: 'reject', taskRef: '#1', reason: '理由 全角 引号' })
    expect(ok('/run --ws "sandbox.v2" 需求').flags.ws).toBe('sandbox.v2')
  })

  it('handles escaped double quotes inside ASCII quotes', () => {
    const cmd = ok('/reject #1 "理由 \\"引号\\" 结束"')
    expect(cmd).toEqual({ name: 'reject', taskRef: '#1', reason: '理由 "引号" 结束' })
  })

  it('accepts full width and ideographic spaces as separators', () => {
    expect(ok('/run　--cli=codex　需求')).toEqual({ name: 'run', flags: { cli: 'codex' }, prompt: '需求' })
    expect(ok('/cancel　#12')).toEqual({ name: 'cancel', taskRef: '#12' })
    expect(ok('/drain\twin-desktop\ton')).toEqual({ name: 'drain', workerId: 'win-desktop', on: true })
  })

  it('reports an unterminated quote instead of silently truncating', () => {
    expect(fail('/run --ws="unclosed')).toMatchObject({ error: '引号未闭合' })
    expect(fail('/reject #1 "理由')).toMatchObject({ error: '引号未闭合' })
  })

  it('keeps quotes that belong to the raw prompt', () => {
    expect(ok('/run "需求" 与 “引号”')).toEqual({ name: 'run', flags: {}, prompt: '"需求" 与 “引号”' })
  })
})

describe('FS-3 解析错误：报错 + 用法，且不产出命令', () => {
  const cases = [
    '',
    '/',
    '/nope',
    '/RUN x',
    '/run',
    '/run    ',
    '/run --bad=1 x',
    '/run --cli',
    '/run --cli --ws sandbox x',
    '/run --cli=notacli x',
    '/run --profile=nope x',
    '/run --ws=BAD! x',
    '/run --worker=UPPER x',
    '/run --priority=99 x',
    '/run --priority=-11 x',
    '/run --priority=1.5 x',
    '/run --cli=codex --cli=codex x',
    '/help extra',
    '/whoami extra',
    '/workers extra',
    '/drain win-desktop maybe',
    '/drain win-desktop',
    '/drain',
    '/cancel',
    '/retry',
    '/approve',
    '/status 12a',
    '/status #',
    '/status tsk_short',
    '/tasks all extra',
    '/tasks --status=nope',
    '/tasks --status=queued --status=running',
    '/tasks mine mine',
  ]

  for (const text of cases) {
    it('rejects ' + JSON.stringify(text), () => {
      const result = fail(text)
      expect(result.error.length).toBeGreaterThan(0)
      expect(result.usage.startsWith('/')).toBe(true)
    })
  }

  it('points at the matching usage string', () => {
    expect(fail('/run --bad=1 x').usage).toContain('/run')
    expect(fail('/cancel').usage).toContain('/cancel')
    expect(fail('/drain win-desktop maybe').usage).toContain('/drain')
    expect(fail('/tasks --status=nope').usage).toContain('/tasks')
    expect(fail('/nope').usage).toBe('/help')
  })
})

describe('FS-4 Requester 越权 flag', () => {
  it('denies Owner-only flags for requesters but allows them for the owner', () => {
    const ownerOnly = [
      '/run --worker win-desktop 需求',
      '/run --profile=full 需求',
      '/run --priority=1 需求',
    ]
    for (const text of ownerOnly) {
      const cmd = ok(text)
      expect(canUseCommand(cmd, 'requester', 'p2p'), text).toBe(false)
      expect(canUseCommand(cmd, 'requester', 'group'), text).toBe(false)
      expect(canUseCommand(cmd, 'owner', 'p2p'), text).toBe(true)
      expect(canUseCommand(cmd, 'unauthorized', 'p2p'), text).toBe(false)
    }
  })

  it('keeps requester-allowed run flags working', () => {
    for (const text of ['/run --cli=codex 需求', '/run --ws=sandbox 需求', '/run --profile=edit 需求', '/run --profile=readonly 需求']) {
      expect(canUseCommand(ok(text), 'requester', 'p2p'), text).toBe(true)
    }
  })

  it('restricts Owner-only commands for requesters', () => {
    const denied = ['/workers', '/tasks all', '/retry #1', '/approve #1', '/reject #1', '/drain win-desktop on']
    for (const text of denied) {
      expect(canUseCommand(ok(text), 'requester', 'p2p'), text).toBe(false)
      expect(canUseCommand(ok(text), 'owner', 'p2p'), text).toBe(true)
    }
    for (const text of ['/status', '/status #1', '/tasks mine', '/cancel #1', '/help']) {
      expect(canUseCommand(ok(text), 'requester', 'p2p'), text).toBe(true)
    }
  })

  it('only answers /whoami in private chats', () => {
    expect(canUseCommand(ok('/whoami'), 'unauthorized', 'p2p')).toBe(true)
    expect(canUseCommand(ok('/whoami'), 'owner', 'group')).toBe(false)
    expect(canUseCommand(ok('/whoami'), 'requester', 'group')).toBe(false)
  })
})

describe('FS-5 /run 多行 prompt', () => {
  it('preserves newlines, indentation and trailing spaces verbatim', () => {
    const prompt = '第一行\n第二行带 空格\n  indented\n\n结尾 '
    expect(ok('/run ' + prompt).prompt).toBe(prompt)
  })

  it('preserves CRLF and does not normalise it', () => {
    const prompt = 'line1\r\nline2\r\n'
    expect(ok('/run ' + prompt).prompt).toBe(prompt)
  })

  it('keeps newlines that follow flags', () => {
    const cmd = ok('/run --cli=codex\n需求\n第二行')
    expect(cmd).toEqual({ name: 'run', flags: { cli: 'codex' }, prompt: '需求\n第二行' })
  })

  it('does not treat a leading single dash as a flag', () => {
    expect(ok('/run -abc 需求')).toEqual({ name: 'run', flags: {}, prompt: '-abc 需求' })
  })
})

describe('FS-6 taskRef 三种形式', () => {
  const forms = ['#123', '123', tsk]
  for (const ref of forms) {
    it('accepts ' + ref + ' for every task command', () => {
      expect(ok('/status ' + ref)).toEqual({ name: 'status', taskRef: ref })
      expect(ok('/cancel ' + ref)).toEqual({ name: 'cancel', taskRef: ref })
      expect(ok('/retry ' + ref)).toEqual({ name: 'retry', taskRef: ref })
      expect(ok('/approve ' + ref)).toEqual({ name: 'approve', taskRef: ref })
      expect(ok('/reject ' + ref + ' 理由')).toEqual({ name: 'reject', taskRef: ref, reason: '理由' })
    })
  }

  it('rejects malformed references', () => {
    for (const ref of ['#', '#12a', '12a', 'tsk_', 'tsk_01arz3ndektsv4rrffq69g5fav', '##12']) {
      expect(fail('/cancel ' + ref).error.length).toBeGreaterThan(0)
    }
  })
})
