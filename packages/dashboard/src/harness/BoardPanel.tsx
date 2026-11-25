import { useState } from 'react'
import { BOARD_FILES, BoardFileName, diffLines } from '@agent-hub/protocol'
import type { RunHarnessView } from '@agent-hub/protocol'

export function BoardPanel({ board, restore }: { board: RunHarnessView['board']; restore?: ((prompt: string) => void) | undefined }) {
  const [file, setFile] = useState<BoardFileName>('HANDOFF.md')
  const [tab, setTab] = useState<'pre' | 'post' | 'diff'>('post')
  const [feedback, setFeedback] = useState('')
  const pre = board.pre?.files.find(f => f.file === file)
  const post = board.post?.files.find(f => f.file === file)
  const current = tab === 'pre' ? pre : post
  const canRestore = pre?.status === 'present' && !pre.truncated && pre.content !== undefined
  const restorePrompt = '把 .board/' + file + ' 恢复为以下内容：\n\n' + (pre?.content ?? '')
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setFeedback('已复制') } catch { setFeedback('复制失败') }
  }
  const comparable = (pre?.content !== undefined || pre?.status === 'absent') && (post?.content !== undefined || post?.status === 'absent')
  return <section data-testid="board-panel"><h3>黑板快照</h3>
    <div className="action-list">{BoardFileName.options.map(f => <button key={f} data-testid={'board-file-' + f} aria-pressed={file === f} onClick={() => { setFile(f); setFeedback('') }}>{f}</button>)}</div>
    <div className="segmented">{(['pre', 'post', 'diff'] as const).map(t => <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>{t.toUpperCase()}</button>)}</div>
    {current && <p>{current.status} · {current.bytes}/{BOARD_FILES[file].budgetBytes} B · {current.lines}/{BOARD_FILES[file].budgetLines} 行
      <meter aria-label="字节预算" value={current.bytes} max={BOARD_FILES[file].budgetBytes} /> {current.overBudget && '超出预算'}
      {current.truncated && ' 仅保存前 ' + new TextEncoder().encode(current.content ?? '').length + ' 字节'}
      {current.missingSections?.length ? ' 缺少标题 ' + current.missingSections.join('、') : ''}</p>}
    <pre>{tab === 'diff' ? comparable ? diffLines(pre?.content ?? '', post?.content ?? '').map(l => l.op + l.text).join('\n') : '缺少可比较的快照' :
      current?.content ?? '无快照正文'}</pre>
    {pre?.truncated && current !== pre && <p>Pre 快照仅保存前 {new TextEncoder().encode(pre.content ?? '').length} 字节</p>}
    <div className="action-list"><button data-testid="board-copy-pre" disabled={pre?.content === undefined} onClick={() => void copy(pre!.content!)}>复制 Pre 内容</button>
      <button data-testid="board-copy-restore" disabled={!canRestore} onClick={() => void copy(restorePrompt)}>复制恢复指令</button>
      {restore && <button data-testid="board-restore-task" disabled={!canRestore} onClick={() => restore(restorePrompt)}>创建恢复任务</button>}</div>
    {feedback && <p role="status">{feedback}</p>}
  </section>
}
