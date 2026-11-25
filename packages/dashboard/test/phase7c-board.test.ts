import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { BoardPanel } from '../src/harness/BoardPanel.js'
import { readBoard } from '../../worker/src/harness/board-reader.js'

it('F3 disables whole-file restore for a truncated first line', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pre-board-'))
  try {
    mkdirSync(join(root, '.board'))
    writeFileSync(join(root, '.board', 'HANDOFF.md'), 'x'.repeat(17000))
    const pre = await readBoard(root)
    const html = renderToStaticMarkup(createElement(BoardPanel, { board: { pre, post: pre, postRound: 0, diff: [] }, restore: () => {} }))
    expect(html).toMatch(/data-testid="board-copy-restore" disabled/)
    expect(html).toMatch(/data-testid="board-restore-task" disabled/)
    expect(html).not.toMatch(/data-testid="board-copy-pre" disabled/)
    expect(html).toContain('仅保存前 0 字节')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
