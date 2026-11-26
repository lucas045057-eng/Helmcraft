import { useState } from 'react'
import type { BoardFileName, BoardSnapshot } from '@agent-hub/protocol'

const tabs = [
  ['PROJECT_STATE.md', '项目现状'], ['HANDOFF.md', '交接与下一步'],
  ['DECISIONS.md', '架构决策'], ['LESSONS.md', '踩坑与规则'],
] as const

const headings: Record<string, string> = {
  Summary: '项目摘要', Modules: '模块', 'Active Tech Debt': '待处理技术债', Commands: '常用命令', Updated: '最近更新',
  Meta: '交接信息', Goal: '本轮目标', Done: '已完成', Next: '下一步', 'Open Questions': '待确认', 'Watch Out': '注意事项',
  Active: '现行决策', Superseded: '已替代决策', Rules: '规则', Pitfalls: '踩坑记录',
}

function sections(content: string) {
  const result = [{ name: '', lines: [] as string[] }]
  let fence = ''
  for (const line of content.replace(/^<!-- agent-hub:board[^\n]*-->\s*/u, '').split(/\r?\n/u)) {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1]
    if (marker && (!fence || marker.startsWith(fence))) fence = fence ? '' : marker
    const heading = !fence && /^##\s+(.+?)\s*$/u.exec(line)
    if (heading) result.push({ name: heading[1]!, lines: [] })
    else if (fence || result.length > 1 || !/^#\s+/u.test(line)) result.at(-1)!.lines.push(line)
  }
  return result.filter(section => section.name || section.lines.some(line => line.trim()))
}

export function projectHeadline(board: BoardSnapshot | null) {
  const state = board?.files.find(file => file.file === 'PROJECT_STATE.md')?.content
  return state && sections(state).find(section => section.name === 'Summary')?.lines.find(line => line.trim())?.trim()
}

function inline(line: string) {
  return line.split(/(`[^`]+`|\*\*[^*]+\*\*)/u).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>
    return part
  })
}

function Modules({ lines }: { lines: string[] }) {
  const cells = (line: string) => line.trim().replace(/^\||\|$/gu, '').split(/(?<!\\)\|/u).map(cell => cell.replace(/\\\|/gu, '|').trim())
  const rows = lines.filter(line => line.trim()).map(cells)
  const [header, divider, ...body] = rows
  if (!header || !divider?.every(cell => /^:?-{3,}:?$/u.test(cell)) ||
      !rows.every(row => row.length === header.length)) return <pre>{lines.join('\n')}</pre>
  const status = header.findIndex(cell => /^(status|状态)$/iu.test(cell))
  return <div className="table-wrap"><table aria-label="项目模块"><thead><tr>
    {header.map((cell, i) => <th key={i}>{inline(cell)}</th>)}
  </tr></thead><tbody>{body.map((row, i) => <tr key={i}>{row.map((cell, col) => {
    const value = cell.replace(/[`*]/gu, '').toLowerCase()
    return <td key={col}>{col === status && ['done', 'planned', 'broken', 'wip'].includes(value)
      ? <span className={'pill module-' + value}>{value}</span> : inline(cell)}</td>
  })}</tr>)}</tbody></table></div>
}

function sectionBody(name: string, lines: string[]) {
  if (name === 'Modules') return <Modules lines={lines} />
  if (!Object.hasOwn(headings, name) || lines.some(line => /^\s*(`{3,}|~{3,})/u.test(line))) return <pre>{lines.join('\n').trim()}</pre>
  const groups: { kind: 'ul' | 'ol' | 'h5' | 'p'; items: string[] }[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    const match = /^\s*(?:([-*+])\s+|(\d+)[.)]\s+|(###)\s+)/u.exec(line)
    const kind = match?.[1] ? 'ul' : match?.[2] ? 'ol' : match?.[3] ? 'h5' : 'p'
    const value = line.slice(match?.[0].length ?? 0)
    const last = groups.at(-1)
    if (last?.kind === kind && (kind === 'ul' || kind === 'ol')) last.items.push(value)
    else groups.push({ kind, items: [value] })
  }
  return groups.map(({ kind: Tag, items }, i) => <Tag key={i}>{Tag === 'ol' || Tag === 'ul'
    ? items.map((item, j) => <li key={j}>{inline(item)}</li>) : inline(items[0]!)}</Tag>)
}

export function ProjectBoard({ board }: { board: BoardSnapshot }) {
  const [file, setFile] = useState<BoardFileName>('PROJECT_STATE.md')
  const content = board.files.find(entry => entry.file === file)?.content
  return <div className="project-board">
    <div className="board-tabs" data-testid="project-board-tabs" aria-label="项目黑板">
      {tabs.map(([id, title]) => <button type="button" key={id} aria-pressed={file === id} onClick={() => setFile(id)}>{title}</button>)}
    </div>
    <div className="board-content" aria-label={file}>{content ? sections(content).map(({ name, lines }, i) =>
      <section key={i} className={name === 'Summary' ? 'board-summary' : name === 'Commands' ? 'board-commands' : undefined}>
        {name && <h4>{Object.hasOwn(headings, name) ? headings[name] : name}</h4>}{sectionBody(name, lines)}
      </section>) : <p className="muted">快照中暂无 {file} 正文</p>}</div>
  </div>
}
