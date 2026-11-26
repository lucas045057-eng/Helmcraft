import { redact } from '@agent-hub/common'
import type { StoredEvent } from '../../../services/store.js'

export type Audience = 'owner' | 'requester'
const hidden = '（内部信息已隐藏）'
const absolutePath = /[a-z]:[\\/]|\\\\|(?:^|[^a-z\d_.-])~?\/[^\s]/iu
const shellSyntax = /\x60|\$\(|(?:^|\s)[$>]\s|(?:^|\s)--?[\w-]+(?:[=\s]|$)|&&|\s\|\s|\b[\w.-]+\.(?:exe|cmd|bat|ps1|sh)\b/iu
const shellCommand = /\b(?:ba?sh|zsh|shell|pwsh|powershell|cmd|command|terminal|npm|pnpm|yarn|git|node|python\d*|curl|sudo|rm|cat|ls|echo|chmod|docker|make|cargo|go test|npx|pwd|whoami|touch|grep|kubectl)\b|执行命令|命令行/iu

export function displayText(value: string, audience: Audience) {
  const clean = redact(value)
  if (audience === 'owner') return clean
  // Strip whole code/output blocks so continuation lines cannot escape filtering.
  const prose = clean.replace(/\x60{3}[\s\S]*?(?:\x60{3}|$)/gu, hidden).replace(/\bstderr\s*[:：][\s\S]*/iu, hidden)
  return prose.split(/\r?\n/).map(line => absolutePath.test(line) || shellSyntax.test(line) ||
    shellCommand.test(line) || /\bstderr\b|https?:\/\//iu.test(line) ? hidden : line).join('\n')
}
export function extractProgress(events: readonly StoredEvent[], audience: Audience, limit = 5, scrub = redact): string[] {
  const lines: string[] = []
  for (const e of events) {
    let text: string
    if (e.kind === 'progress') text = e.detail || e.phase
    else if (e.kind === 'verify') {
      const failed = e.results?.filter(r => !['passed', 'not_run'].includes(r.status)).map(r => r.id) ?? []
      text = audience === 'requester' ? '正在进行自动验证' : '验证 #' + e.attempt +
        (failed.length ? ' 未通过：' + failed.join('、') : '：' + e.commands.join('、'))
    }
    else if (e.kind === 'agent' && e.event.type === 'command' && audience === 'owner') {
      const { command, exitCode } = e.event
      const summary = scrub(command).replace(/\s+/gu, ' ').trim().slice(0, 210)
      text = (exitCode === null ? '▶' : exitCode === 0 ? '✓' : '✗') + ' $ ' + summary +
        (exitCode !== null && exitCode !== 0 ? ' (exit ' + exitCode + ')' : '')
    }
    else if (e.kind === 'agent' && e.event.type === 'thinking' && audience === 'owner') {
      const first = scrub(e.event.text).trim().split(/\r?\n/u, 1)[0]
      if (!first) continue
      text = '💭 ' + first.trim().slice(0, 140)
    }
    else if (e.kind === 'agent' && e.event.type === 'tool_use') text = audience === 'owner' ? e.event.summary : '使用工具'
    else if (e.kind === 'agent' && e.event.type === 'file_change') text = '修改文件 ' + e.event.path
    else if (e.kind === 'agent' && e.event.type === 'message') text = audience === 'requester' ? '更新执行说明' : e.event.text
    else continue
    lines.push(...displayText(scrub(text), audience).split(/\r?\n/).filter(Boolean).slice(-limit).map(v => v.slice(0, 256)))
  }
  return lines.slice(-limit)
}
export const ProgressExtractor = extractProgress
