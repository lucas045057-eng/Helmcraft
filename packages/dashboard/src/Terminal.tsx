import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { describeLog } from './logs.js'
import type { LogBuffer } from './logs.js'

function RawTerminal({ buffer }: { buffer: LogBuffer }) {
  const node = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const element = node.current!
    let disposed = false
    let destroy: (() => void) | undefined
    void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(([{ Terminal }, { FitAddon }]) => {
      if (disposed) return
      const terminal = new Terminal({ disableStdin: true, convertEol: true, scrollback: 100_000, fontSize: 12,
        fontFamily: 'Cascadia Code, Consolas, monospace', theme: { background: '#0b1018', foreground: '#c8d4e6' } })
      const fit = new FitAddon()
      terminal.loadAddon(fit)
      terminal.open(element)
      fit.fit()
      const observer = new ResizeObserver(() => fit.fit())
      observer.observe(element)
      let offset = 0
      let frame = 0
      let writing = false
      const schedule = () => {
        if (!disposed && !frame && !writing && offset < buffer.entries.length) frame = requestAnimationFrame(flush)
      }
      function flush() {
        frame = 0
        let output = ''
        while (offset < buffer.entries.length && output.length < 64 * 1024) {
          const entry = buffer.entries[offset++]!
          const log = describeLog(entry)
          const text = entry.text ?? (log.text.startsWith('▶ ') ? log.text : '[' + log.kind + '] ' + log.text)
          output += text.endsWith('\n') ? text : text + '\n'
        }
        if (!output) return
        writing = true
        terminal.write(output, () => { writing = false; schedule() })
      }
      const unsubscribe = buffer.subscribe(schedule)
      schedule()
      destroy = () => { cancelAnimationFrame(frame); unsubscribe(); observer.disconnect(); terminal.dispose() }
    }).catch(() => { if (!disposed) setError('无法初始化 Raw 终端') })
    return () => { disposed = true; destroy?.() }
  }, [buffer])
  return <><div ref={node} className="raw-terminal" data-testid="terminal-raw" aria-label="Raw 日志终端" />
    {error && <p role="alert" className="error">{error}</p>}</>
}

function StructuredLogs({ buffer }: { buffer: LogBuffer }) {
  useSyncExternalStore(buffer.subscribe, buffer.snapshot, buffer.snapshot)
  const node = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const count = buffer.entries.length
  const virtual = useVirtualizer({
    count, getScrollElement: () => node.current, estimateSize: () => 30, overscan: 12,
  })
  useLayoutEffect(() => {
    if (stick.current && count) virtual.scrollToIndex(count - 1, { align: 'end' })
  }, [count, virtual])
  return <div ref={node} className="structured-terminal" data-testid="terminal-structured" tabIndex={0}
    onScroll={event => {
      const target = event.currentTarget
      stick.current = target.scrollHeight - target.clientHeight - target.scrollTop < 80
    }}>
    {!count && <p className="empty-panel">等待日志…</p>}
    <div className="log-canvas" style={{ height: virtual.getTotalSize() }}>
      {virtual.getVirtualItems().map(item => {
        const entry = buffer.entries[item.index]!
        const log = describeLog(entry)
        return <div key={item.key} ref={virtual.measureElement} data-index={item.index} data-kind={log.kind}
          className="log-row" style={{ transform: 'translateY(' + item.start + 'px)' }}>
          <span>{entry.seq}</span><span className={'log-kind kind-' + log.kind}>{log.kind}</span><code>{log.text}</code>
        </div>
      })}
    </div>
  </div>
}

export function TerminalPane({ buffer }: { buffer: LogBuffer }) {
  const [mode, setMode] = useState<'structured' | 'raw'>('structured')
  useSyncExternalStore(buffer.subscribe, buffer.snapshot, buffer.snapshot)
  return <section className="terminal-pane">
    <div className="terminal-toolbar">
      <div className="segmented"><button type="button" data-testid="log-view-structured" aria-pressed={mode === 'structured'}
        onClick={() => setMode('structured')}>结构化</button>
      <button type="button" data-testid="log-view-raw" aria-pressed={mode === 'raw'} onClick={() => setMode('raw')}>Raw</button></div>
      <span className="mono muted" data-testid="log-count">{buffer.entries.length.toLocaleString()} 条记录</span>
    </div>
    {buffer.status && <p className="warning compact" role="status">{buffer.status}</p>}
    {mode === 'structured' ? <StructuredLogs buffer={buffer} /> : <RawTerminal buffer={buffer} />}
  </section>
}

