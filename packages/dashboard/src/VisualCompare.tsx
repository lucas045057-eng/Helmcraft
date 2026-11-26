import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { RunArtifactView } from '@agent-hub/protocol'
import { errorText, listRunArtifacts } from './api.js'

interface VisualMeta {
  routeIndex?: number
  route?: string
  url?: string
  statusCode?: number | null
  blankPage?: boolean
  consoleErrors?: string[]
  pageErrors?: string[]
}

export interface VisualRouteGroup {
  key: string
  label: string
  before?: RunArtifactView
  after?: RunArtifactView
}

function readMeta(art: RunArtifactView): VisualMeta {
  return art.meta && typeof art.meta === 'object' && !Array.isArray(art.meta)
    ? (art.meta as VisualMeta)
    : {}
}

export function groupVisualArtifacts(visual: RunArtifactView[]): VisualRouteGroup[] {
  const byKey = new Map<string, { key: string; baseLabel: string; routeIndex?: number; before?: RunArtifactView; after?: RunArtifactView }>()
  for (const art of visual) {
    const meta = readMeta(art)
    const rawIdx = typeof meta.routeIndex === 'number' && Number.isInteger(meta.routeIndex) && meta.routeIndex >= 0
      ? meta.routeIndex
      : undefined
    const baseLabel = typeof meta.route === 'string' && meta.route ? meta.route : art.label
    const key = rawIdx !== undefined ? `idx:${rawIdx}` : `route:${baseLabel}`
    const slot = byKey.get(key) ?? { key, baseLabel, ...(rawIdx !== undefined && { routeIndex: rawIdx }) }
    if (art.kind === 'visual_before' && !slot.before) slot.before = art
    else if (art.kind === 'visual_after') slot.after = art
    byKey.set(key, slot)
  }
  const labelCounts = new Map<string, number>()
  for (const slot of byKey.values()) {
    labelCounts.set(slot.baseLabel, (labelCounts.get(slot.baseLabel) ?? 0) + 1)
  }
  return [...byKey.values()].map(slot => ({
    key: slot.key,
    label: (labelCounts.get(slot.baseLabel) ?? 0) > 1 && slot.routeIndex !== undefined
      ? `${slot.baseLabel} (#${slot.routeIndex + 1})`
      : slot.baseLabel,
    ...(slot.before && { before: slot.before }),
    ...(slot.after && { after: slot.after }),
  }))
}

export function VisualCompare({ taskId, runId, showEmpty = false }: { taskId: string; runId: string; showEmpty?: boolean }) {
  const [mode, setMode] = useState<'both' | 'before' | 'after'>('both')
  const [zoom, setZoom] = useState<RunArtifactView | null>(null)
  const query = useQuery({
    queryKey: ['run-artifacts', taskId, runId],
    queryFn: ({ signal }) => listRunArtifacts(taskId, runId, signal),
    enabled: Boolean(taskId && runId),
  })
  const visual = (query.data ?? []).filter(a => a.kind === 'visual_before' || a.kind === 'visual_after')
  if (!visual.length && !showEmpty) return null

  const groups = groupVisualArtifacts(visual)
  return <section className="visual-panel" data-testid="visual-compare">
    <div className="section-heading">
      <h4>📸 真机视觉验收对比</h4>
      {visual.length > 0 && <div className="segmented">
        {([['both', '改前 / 改后并排'], ['before', '仅改前'], ['after', '仅改后']] as const).map(([id, label]) =>
          <button key={id} type="button" aria-pressed={mode === id} onClick={() => setMode(id)}>{label}</button>)}
      </div>}
    </div>
    {query.error && <p className="error compact" role="alert">{errorText(query.error)}</p>}
    {!visual.length && showEmpty && <p className="empty-panel">最近一次运行暂无视觉验收截图（在 worker.yaml 开启 harness.visual 后将自动截取页面改前/改后对比图）。</p>}
    {groups.map(group => {
      const shots = [
        ...(mode !== 'after' && group.before ? [{ tag: '改前', item: group.before }] : []),
        ...(mode !== 'before' && group.after ? [{ tag: '改后', item: group.after }] : []),
      ]
      return <div key={group.key} className="visual-route-group">
        <div className="visual-route-title"><code className="mono">{group.label}</code></div>
        <div className={'visual-grid' + (shots.length === 1 ? ' single' : '')}>
          {shots.map(({ tag, item }) => {
            const meta = readMeta(item)
            const errors = (meta.consoleErrors?.length ?? 0) + (meta.pageErrors?.length ?? 0)
            return <figure key={item.id} className="visual-shot">
              <figcaption>
                <span className="pill">{tag}</span>
                {meta.statusCode !== undefined && meta.statusCode !== null && <span className="pill">HTTP {meta.statusCode}</span>}
                {meta.blankPage && <span className="pill offline">白屏告警</span>}
                {errors > 0 ? <span className="pill offline">{errors} 条页面报错</span> : <span className="pill online">0 报错</span>}
              </figcaption>
              <button type="button" className="visual-thumb-btn" onClick={() => setZoom(item)}>
                <img src={item.url} alt={`${group.label} ${tag}`} loading="lazy" />
              </button>
              {errors > 0 && <pre className="visual-errors">{[...(meta.consoleErrors ?? []), ...(meta.pageErrors ?? [])].join('\n')}</pre>}
            </figure>
          })}
        </div>
      </div>
    })}
    {zoom && <div className="dialog-layer center" role="dialog" aria-modal="true" aria-label="视觉截图放大预览">
      <button type="button" className="backdrop" onClick={() => setZoom(null)} aria-label="关闭大图" />
      <div className="visual-lightbox surface">
        <header className="drawer-header">
          <strong>{zoom.kind === 'visual_before' ? '改前' : '改后'} · {zoom.label}</strong>
          <button type="button" onClick={() => setZoom(null)}>×</button>
        </header>
        <img src={zoom.url} alt={zoom.label} />
      </div>
    </div>}
  </section>
}
