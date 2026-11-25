import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { WorkerView } from '@agent-hub/protocol'
import { emptyResponse, errorText, json, request } from './api.js'
import { bytes } from './format.js'
import { useDashboard } from './store.js'

const stateLabels = { online: '在线', suspect: '可疑', offline: '离线' }
function Meter({ label, value, total, caption }: { label: string; value?: number | undefined; total: number; caption: string }) {
  return <div className="meter"><span>{label}</span><progress aria-label={label} value={value ?? 0} max={total || 1} /><b>{caption}</b></div>
}

function WorkerCard({ worker, now }: { worker: WorkerView; now: number }) {
  const [receipt, setReceipt] = useState('')
  const root = '/workers/' + encodeURIComponent(worker.id)
  const drain = useMutation({ mutationFn: (value: boolean) => request(root + '/drain', WorkerView, json('POST', { drain: value })),
    onSuccess: value => useDashboard.setState(state => {
      const current = state.workers[value.id]
      return current ? { workers: { ...state.workers, [value.id]: { ...current, drain: value.drain, drainSource: value.drainSource } } } : state
    }) })
  const probe = useMutation({ mutationFn: () => request(root + '/probe', emptyResponse, json('POST')),
    onSuccess: () => setReceipt('探测已发送') })
  const draining = drain.isPending ? drain.variables : worker.drain
  const grace = worker.graceUntil !== null && worker.activeRunIds.length > 0 && worker.connection === 'offline'
    ? Math.max(0, Math.ceil((worker.graceUntil - now) / 1000)) : null
  const cpu = worker.load?.cpuPercent
  const ram = worker.load === null ? null : worker.load.memTotalMb - worker.load.memFreeMb
  return <article className="worker-card" data-testid={'worker-card-' + worker.id}>
    <div className="worker-heading"><div className="node-icon" aria-hidden="true">▤</div><div><h3>{worker.displayName}</h3>
      <span className="mono muted">{worker.hostname ?? worker.id} · {[worker.os, worker.arch].filter(Boolean).join('/') || '—'}</span></div>
      <span className={'pill ' + worker.connection} data-testid="worker-connection"><i className="dot" />{worker.status === 'revoked' ? '已吊销' : stateLabels[worker.connection]}</span>
    </div>
    {grace !== null && <p className="warning compact" data-testid="worker-grace">离线宽限期 · {grace}s</p>}
    <div className="worker-meta"><span>RTT <b>{worker.rttMs === null ? '—' : worker.rttMs + ' ms'}</b></span><span>Agent <b>{worker.agentVersion ?? '—'}</b></span></div>
    <Meter label="CPU" value={cpu} total={100} caption={cpu === undefined ? '—' : Math.round(cpu) + '%'} />
    <Meter label="内存" value={ram ?? undefined} total={worker.load?.memTotalMb ?? 1}
      caption={ram === null ? '—' : Math.round(ram) + ' MB'} />
    <Meter label="槽位" value={worker.slotsUsed} total={worker.maxConcurrency} caption={worker.slotsUsed + '/' + worker.maxConcurrency} />
    <div className="tag-list">{worker.adapters.map(adapter => <span className={'pill adapter ' + adapter.status} key={adapter.id} title={adapter.error}>
      <i className="dot" />{adapter.id} <small>{adapter.status}{adapter.version && ' · ' + adapter.version}</small>
    </span>)}</div>
    <div className="tag-list">{worker.workspaces.map(workspace => <span className="pill workspace" key={workspace.id} title={workspace.id}>{workspace.label || workspace.id}</span>)}</div>
    <p className="worker-meta mono"><span>缓冲 {bytes(worker.bufferedBytes)}</span><span>丢弃 {bytes(worker.droppedLogBytesTotal)}</span></p>
    <div className="worker-footer">
      <button type="button" role="switch" aria-checked={Boolean(draining)} className="drain" data-testid="worker-drain"
        disabled={drain.isPending || worker.status === 'revoked'} onClick={() => drain.mutate(!draining)}>
        <span className="switch-track" />{draining ? '排空中' : 'Drain'}
      </button>
      <button type="button" data-testid="worker-probe" disabled={probe.isPending || worker.connection !== 'online'} onClick={() => probe.mutate()}>Probe</button>
    </div>
    {(drain.error || probe.error) && <p role="alert" className="error compact">{errorText(drain.error || probe.error)}</p>}
    {receipt && <p role="status" className="muted compact">{receipt}</p>}
  </article>
}

export function WorkerFleet({ workers, now }: { workers: WorkerView[]; now: number }) {
  return <section data-testid="worker-fleet">
    <div className="section-heading"><h2>Worker 节点</h2><span className="mono muted">{workers.length} 个节点</span></div>
    {workers.length ? <div className="worker-fleet">{workers.map(worker => <WorkerCard key={worker.id} worker={worker} now={now} />)}</div>
      : <div className="empty-panel">暂无已注册节点</div>}
  </section>
}

