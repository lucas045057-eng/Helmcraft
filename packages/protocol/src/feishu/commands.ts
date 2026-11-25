import { AdapterId, Profile, RunId, TaskRef, WorkerId, WorkspaceId } from '../common.js'
import { TaskStatus } from '../task.js'

// packages/protocol/src/feishu/commands.ts
export type ParsedCommand =
  | { name: 'handoff'; flags: { cli: AdapterId; from?: string }; prompt: string }
  | { name: 'run'; flags: { from?: string; cli?: AdapterId; ws?: string; worker?: string; profile?: Profile; priority?: number }; prompt: string }
  | { name: 'status'; taskRef?: TaskRef } | { name: 'tasks'; scope: 'mine' | 'all'; status?: TaskStatus[] }
  | { name: 'workers' } | { name: 'cancel' | 'retry' | 'approve'; taskRef: TaskRef }
  | { name: 'reject'; taskRef: TaskRef; reason?: string } | { name: 'drain'; workerId: string; on: boolean }
  | { name: 'help' } | { name: 'whoami' }

const usage = {
  handoff: '/handoff --cli <adapter> [--from <taskRef>] [需求]',
  run: '/run [--cli <adapter>] [--ws <workspace>] [--worker <id>] [--profile <profile>] [--priority <n>] <需求>',
  status: '/status [taskRef]',
  tasks: '/tasks [mine|all] [--status=<status,...>]',
  workers: '/workers',
  cancel: '/cancel <taskRef>',
  retry: '/retry <taskRef>',
  approve: '/approve <taskRef>',
  reject: '/reject <taskRef> [理由]',
  drain: '/drain <workerId> on|off',
  help: '/help',
  whoami: '/whoami',
} satisfies Record<ParsedCommand['name'], string>

const whitespace = /\s/u
const quotation = new Map([['"', '"'], ['“', '”'], ['＂', '＂']])

/** Tokenize the command prefix only, leaving the prompt's source text intact. */
class Scanner {
  position = 0

  constructor(readonly text: string) {}

  skipSpace(): void {
    while (whitespace.test(this.text.charAt(this.position))) this.position++
  }

  token(stopAtEquals = false): string | undefined {
    this.skipSpace()
    let result = ''
    const start = this.position
    while (this.position < this.text.length) {
      const char = this.text.charAt(this.position)
      if (whitespace.test(char) || (stopAtEquals && char === '=')) break
      this.position++
      const closer = quotation.get(char)
      if (!closer) {
        result += char
        continue
      }
      let closed = false
      while (this.position < this.text.length) {
        const content = this.text.charAt(this.position++)
        if (content === closer) {
          closed = true
          break
        }
        if (char === '"' && content === '\\' && this.text.charAt(this.position) === '"') {
          result += '"'
          this.position++
        } else {
          result += content
        }
      }
      if (!closed) throw new Error('引号未闭合')
    }
    return this.position > start ? result : undefined
  }

  flagValue(): string {
    if (this.text.charAt(this.position) === '=') {
      this.position++
      if (!this.text.charAt(this.position) || whitespace.test(this.text.charAt(this.position))) {
        throw new Error('选项缺少参数')
      }
    }
    this.skipSpace()
    if (this.text.startsWith('--', this.position)) throw new Error('选项缺少参数')
    const value = this.token()
    if (!value) throw new Error('选项缺少参数')
    return value
  }

  rest(): string {
    this.skipSpace()
    return this.text.slice(this.position)
  }

  end(): void {
    if (this.rest()) throw new Error('参数过多')
  }
}

function parseRun(scanner: Scanner, name: 'run' | 'handoff'): ParsedCommand {
  const flags: Extract<ParsedCommand, { name: 'run' }>['flags'] = {}
  const seen = new Set<string>()
  scanner.skipSpace()
  while (scanner.text.startsWith('--', scanner.position)) {
    const key = scanner.token(true)!
    if (seen.has(key)) throw new Error('选项重复')
    seen.add(key)
    if (name === 'handoff' && key !== '--cli' && key !== '--from') throw new Error('未知选项')
    if (!['--cli', '--from', '--ws', '--worker', '--profile', '--priority'].includes(key)) throw new Error('未知选项')
    const value = scanner.flagValue()
    switch (key) {
      case '--cli': {
        const result = AdapterId.safeParse(value)
        if (!result.success) throw new Error('无效 CLI')
        flags.cli = result.data
        break
      }
      case '--from':
        if (!TaskRef.safeParse(value).success && !RunId.safeParse(value).success) throw new Error('无效来源任务')
        flags.from = value
        break
      case '--ws':
        if (!WorkspaceId.safeParse(value).success) throw new Error('无效工作区')
        flags.ws = value
        break
      case '--worker':
        if (!WorkerId.safeParse(value).success) throw new Error('无效 Worker')
        flags.worker = value
        break
      case '--profile': {
        const result = Profile.safeParse(value)
        if (!result.success) throw new Error('无效权限档位')
        flags.profile = result.data
        break
      }
      case '--priority': {
        const priority = Number(value)
        if (!/^-?\d+$/.test(value) || priority < -10 || priority > 10) throw new Error('无效优先级')
        flags.priority = priority
        break
      }
    }
    scanner.skipSpace()
  }
  const prompt = scanner.rest()
  if (name === 'handoff') {
    if (!flags.cli) throw new Error('缺少 --cli')
    return { name, flags: { cli: flags.cli, ...(flags.from && { from: flags.from }) }, prompt }
  }
  if (flags.from && flags.ws) throw new Error('--from 与 --ws 不能同时使用')
  if (!prompt) throw new Error('缺少需求')
  return { name: 'run', flags, prompt }
}

function parseTasks(scanner: Scanner): Extract<ParsedCommand, { name: 'tasks' }> {
  let scope: 'mine' | 'all' | undefined
  let status: TaskStatus[] | undefined
  while (scanner.rest()) {
    const token = scanner.token(true)
    if ((token === 'mine' || token === 'all') && scope === undefined) {
      scope = token
    } else if (token === '--status' && status === undefined) {
      status = scanner.flagValue().split(',').map((part) => {
        const result = TaskStatus.safeParse(part)
        if (!result.success) throw new Error('无效任务状态')
        return result.data
      })
    } else {
      throw new Error('无效或重复的参数')
    }
  }
  return { name: 'tasks', scope: scope ?? 'mine', ...(status && { status }) }
}

export type CommandParseResult = { ok: true; cmd: ParsedCommand } | { ok: false; error: string; usage: string }

export function canUseCommand(
  command: ParsedCommand, role: 'owner' | 'requester' | 'unauthorized', chatType: 'p2p' | 'group',
): boolean {
  if (command.name === 'whoami') return chatType === 'p2p'
  if (command.name === 'handoff' || (command.name === 'run' && command.flags.from)) return role === 'owner' && chatType === 'p2p'
  if (role === 'owner') return true
  if (role !== 'requester') return false
  switch (command.name) {
    case 'approve':
    case 'reject':
    case 'retry':
    case 'drain':
    case 'workers': return false
    case 'tasks': return command.scope === 'mine'
    case 'run': return command.flags.worker === undefined && command.flags.priority === undefined && command.flags.profile !== 'full'
    default: return true
  }
}

export function parseCommand(text: string): CommandParseResult {
  const scanner = new Scanner(text)
  const command = /^\/([a-z]+)(?=\s|$)/u.exec(scanner.rest())
  const name = command?.[1] as ParsedCommand['name'] | undefined
  if (!name || !Object.hasOwn(usage, name)) return { ok: false, error: '未知指令', usage: '/help' }
  scanner.position += name.length + 1
  try {
    switch (name) {
      case 'handoff':
      case 'run': return { ok: true, cmd: parseRun(scanner, name) }
      case 'tasks': return { ok: true, cmd: parseTasks(scanner) }
      case 'help':
      case 'whoami':
      case 'workers':
        scanner.end()
        return { ok: true, cmd: { name } }
      case 'drain': {
        const workerId = scanner.token()
        const mode = scanner.token()
        if (!workerId || !WorkerId.safeParse(workerId).success || (mode !== 'on' && mode !== 'off')) {
          throw new Error('需要 Worker ID 及 on 或 off')
        }
        scanner.end()
        return { ok: true, cmd: { name, workerId, on: mode === 'on' } }
      }
      default: {
        const taskRef = scanner.token()
        if (name === 'status' && taskRef === undefined) return { ok: true, cmd: { name } }
        if (!taskRef || !TaskRef.safeParse(taskRef).success) throw new Error('无效或缺少任务编号')
        if (name === 'reject') {
          const words: string[] = []
          for (let word = scanner.token(); word !== undefined; word = scanner.token()) words.push(word)
          return { ok: true, cmd: { name, taskRef, ...(words.length && { reason: words.join(' ') }) } }
        }
        scanner.end()
        return { ok: true, cmd: { name, taskRef } }
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '无效指令', usage: usage[name] }
  }
}
