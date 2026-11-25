/**
 * Pi 独立验收 · 03 协议契约门禁 P-1 ~ P-8（协议层可验证部分）
 *
 * 说明：P-3 / P-8 的网关行为（4400 / 4426）依赖 Phase 2 的 `worker-gateway-ws`，
 * 本文件把可在 protocol 包内独立验证的契约断言到极限：帧分类、严格拒绝多余字段、
 * 序号连续性、关闭码/子协议常量、上下行共用的 fixtures。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as protocol from '../src/index.js'

const frame = z.union([protocol.HubToWorkerFrame, protocol.WorkerToHubFrame])

function fixtures(domain: string, valid: boolean): { name: string; payload: unknown }[] {
  const directory = new URL('../fixtures/' + domain + '/' + (valid ? 'valid' : 'invalid') + '/', import.meta.url)
  return readdirSync(directory).filter((file) => file.endsWith('.json')).sort()
    .map((file) => ({ name: file.slice(0, -5), payload: JSON.parse(readFileSync(new URL(file, directory), 'utf8')) as unknown }))
}

const validFrames = fixtures('worker', true)
const frameType = (payload: unknown): string => (payload as { type: string }).type

function clone<T>(value: T): T {
  return structuredClone(value)
}

function frameOf(name: string): Record<string, unknown> {
  const found = validFrames.find((entry) => entry.name === name)
  if (!found) throw new Error('missing fixture ' + name)
  return clone(found.payload) as Record<string, unknown>
}

function payloadOf(name: string): Record<string, unknown> {
  return frameOf(name).payload as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// P-1 / P-7 fixtures 正例与上下行共用
// ---------------------------------------------------------------------------

describe('P-1 每个 Worker 帧的 valid fixture', () => {
  for (const { name, payload } of validFrames) {
    it('parses ' + name + ' losslessly and round trips', () => {
      const parsed = frame.safeParse(payload)
      expect(parsed.success, parsed.success ? '' : parsed.error.message).toBe(true)
      if (!parsed.success) return
      /* 1) 解析结果不得注入/丢弃字段 */
      expect(parsed.data).toEqual(payload)
      /* 2) JSON 往返稳定 */
      expect(JSON.parse(JSON.stringify(parsed.data))).toEqual(parsed.data)
      expect(frame.parse(JSON.parse(JSON.stringify(parsed.data)))).toEqual(parsed.data)
    })
  }

  it('covers every declared frame type with a valid fixture', () => {
    const types = (schema: unknown): string[] => {
      const candidate = schema as { options?: unknown[]; shape?: { type: { value: string } } }
      if (Array.isArray(candidate.options)) return candidate.options.flatMap(types)
      return [candidate.shape!.type.value]
    }
    const declared = [...types(protocol.HubToWorkerFrame), ...types(protocol.WorkerToHubFrame)].sort()
    expect(validFrames.map((entry) => entry.name).sort()).toEqual(declared)
  })
})

describe('P-7 上下行共用同一份 fixtures', () => {
  it('classifies every fixture into exactly one direction', () => {
    for (const { name, payload } of validFrames) {
      const up = protocol.HubToWorkerFrame.safeParse(payload).success
      const down = protocol.WorkerToHubFrame.safeParse(payload).success
      expect(up !== down, name + ' must belong to exactly one direction').toBe(true)
    }
  })

  it('accepts every HubCommand through the HubToWorkerFrame union', () => {
    for (const option of protocol.HubCommand.options) {
      const type = option.shape.type.value
      const { name, payload } = validFrames.find((entry) => frameType(entry.payload) === type)!
      expect(protocol.HubCommand.safeParse(payload).success, name).toBe(true)
      expect(protocol.HubToWorkerFrame.safeParse(payload).success, name).toBe(true)
    }
  })

  it('re-serialises to identical JSON when crossing directions', () => {
    for (const { name, payload } of validFrames) {
      const serialised = JSON.stringify(frame.parse(payload))
      expect(JSON.parse(serialised), name).toEqual(payload)
    }
  })
})

// ---------------------------------------------------------------------------
// P-2 严格拒绝
// ---------------------------------------------------------------------------

describe('P-2 每个 Worker 帧的 invalid fixture 全部被拒', () => {
  for (const { name, payload } of fixtures('worker', false)) {
    it('rejects ' + name, () => {
      const parsed = frame.safeParse(payload)
      expect(parsed.success, name + ' should be rejected').toBe(false)
    })
  }

  it('provides at least one invalid fixture for every declared frame type', () => {
    const negatives = fixtures('worker', false).map((entry) => frameType(entry.payload))
    const types = (schema: unknown): string[] => {
      const candidate = schema as { options?: unknown[]; shape?: { type: { value: string } } }
      if (Array.isArray(candidate.options)) return candidate.options.flatMap(types)
      return [candidate.shape!.type.value]
    }
    for (const type of [...types(protocol.HubToWorkerFrame), ...types(protocol.WorkerToHubFrame)]) {
      expect(negatives, 'no invalid fixture for ' + type).toContain(type)
    }
  })
})

describe('P-2 补充：缺字段 / 多余字段 / 类型错误 / 超长字符串 / 越界数字', () => {
  /** 每个帧类型中「删除后必须失败」的必填字段。 */
  const required: Record<string, string[]> = {
    'hub.challenge': ['nonce', 'hubBootId', 'serverTime', 'protocolVersions'],
    'hub.welcome': ['sessionId', 'connectionEpoch', 'serverTime', 'heartbeatIntervalMs', 'heartbeatTimeoutMs',
      'ackIntervalMs', 'maxFrameBytes', 'maxInFlightBytes', 'maxLogEntryBytes', 'resume', 'drain', 'redactionPatterns'],
    'hub.reject': ['code', 'message'],
    'hub.heartbeat_ack': ['serverTime'],
    'cmd.ack': ['refId', 'ok'],
    'worker.hello': ['auth', 'agent', 'maxConcurrency', 'adapters', 'workspaces', 'runs', 'drain'],
    'worker.heartbeat': ['activeRuns', 'slotsUsed', 'load', 'adapters', 'bufferedBytes', 'droppedLogBytesTotal'],
    'worker.state': ['drain'],
    'worker.bye': ['reason', 'runningRuns'],
    'run.dispatch': ['taskId', 'runId', 'taskNo', 'attempt', 'adapter', 'workspaceId', 'profile', 'prompt',
      'timeoutMs', 'idleTimeoutMs', 'notAfter', 'origin'],
    'run.cancel': ['runId', 'reason', 'force', 'graceMs'],
    'run.input': ['runId', 'requestId', 'answer'],
    'worker.drain': ['drain'],
    'worker.probe': [],
    'run.events': ['runId', 'taskId', 'events'],
    'run.gap': ['runId', 'fromSeq', 'toSeq'],
    'run.ack': ['acks'],
    'run.resend': ['runId', 'fromSeq'],
  }

  for (const [name, keys] of Object.entries(required)) {
    if (!keys.length) continue
    it('rejects ' + name + ' with any required field removed', () => {
      const original = payloadOf(name)
      for (const key of keys) {
        const mutated = clone(original)
        delete mutated[key]
        expect(frame.safeParse({ ...frameOf(name), payload: mutated }).success, name + ' minus ' + key).toBe(false)
      }
    })
  }

  it('rejects the envelope with a missing or misshapen field', () => {
    const original = frameOf('hub.heartbeat_ack')
    for (const key of ['v', 'id', 'type', 'ts', 'payload']) {
      const mutated = clone(original)
      delete mutated[key]
      expect(frame.safeParse(mutated).success, 'envelope minus ' + key).toBe(false)
    }
    for (const [key, value] of [['v', 2], ['id', 'not-a-ulid'], ['ts', -1], ['ts', 1.5], ['type', 7], ['payload', undefined]] as const) {
      expect(frame.safeParse({ ...original, [key]: value }).success, 'envelope ' + key + '=' + String(value)).toBe(false)
    }
  })

  it('rejects extra fields at every nesting level (.strict())', () => {
    const mutations: [string, (payload: Record<string, unknown>) => void][] = [
      ['hub.welcome', (p) => { (p.resume as Record<string, unknown>[])[0]!.extra = true }],
      ['hub.reject', (p) => { p.retryAfterMsLabel = 'x' }],
      ['cmd.ack', (p) => { p.error = { code: 'INVALID', message: 'x', extra: 1 } }],
      ['worker.hello', (p) => { (p.auth as Record<string, unknown>).extra = true }],
      ['worker.hello', (p) => { ((p.adapters as Record<string, unknown>[])[0]!.features as Record<string, unknown>).extra = true }],
      ['worker.hello', (p) => { ((p.workspaces as Record<string, unknown>[])[0]!).path = 'C:\\secret' }],
      ['worker.hello', (p) => { ((p.agent as Record<string, unknown>).extra) = 1 }],
      ['worker.heartbeat', (p) => { ((p.load as Record<string, unknown>).extra) = 1 }],
      ['run.dispatch', (p) => { ((p.origin as Record<string, unknown>).extra) = 1 }],
      ['run.events', (p) => { ((p.events as Record<string, unknown>[])[0]!).extra = 1 }],
      ['run.ack', (p) => { ((p.acks as Record<string, unknown>[])[0]!).extra = 1 }],
    ]
    for (const [name, mutate] of mutations) {
      const original = frameOf(name)
      mutate(original.payload as Record<string, unknown>)
      expect(frame.safeParse(original).success, 'extra field in ' + name).toBe(false)
    }
    /* 信封本身同样严格 */
    expect(frame.safeParse({ ...frameOf('worker.state'), extra: true }).success).toBe(false)
  })

  it('rejects wrong types, out of range numbers and oversized strings', () => {
    const cases: [string, (payload: Record<string, unknown>) => void, string][] = [
      ['run.dispatch', (p) => { p.prompt = 42 }, 'prompt not a string'],
      ['run.dispatch', (p) => { p.prompt = 'x'.repeat(100_001) }, 'prompt too long'],
      ['run.dispatch', (p) => { p.prompt = '' }, 'prompt empty'],
      ['run.dispatch', (p) => { p.timeoutMs = 9_999 }, 'timeout below minimum'],
      ['run.dispatch', (p) => { p.timeoutMs = 24 * 3_600_000 + 1 }, 'timeout above maximum'],
      ['run.dispatch', (p) => { p.attempt = 0 }, 'attempt not positive'],
      ['run.dispatch', (p) => { p.adapter = 'unknown-cli' }, 'unknown adapter'],
      ['run.dispatch', (p) => { p.profile = 'root' }, 'unknown profile'],
      ['run.dispatch', (p) => { p.env = { lowercase: 'x' } }, 'invalid env key'],
      ['run.dispatch', (p) => { p.extraArgs = Array.from({ length: 33 }, () => '-x') }, 'too many extraArgs'],
      ['run.dispatch', (p) => { p.runId = 'run_not-a-ulid' }, 'malformed runId'],
      ['run.dispatch', (p) => { p.origin = { source: 'wechat', actorType: 'owner' } }, 'unknown origin source'],
      ['run.cancel', (p) => { p.graceMs = 60_001 }, 'graceMs above maximum'],
      ['run.cancel', (p) => { p.reason = 'because' }, 'unknown cancel reason'],
      ['run.input', (p) => { p.answer = 'x'.repeat(20_001) }, 'answer too long'],
      ['worker.bye', (p) => { p.reason = 'bye' }, 'unknown bye reason'],
      ['worker.heartbeat', (p) => { p.load = { memFreeMb: 1, memTotalMb: 2, cpuPercent: 101 } }, 'cpu above maximum'],
      ['worker.hello', (p) => { p.maxConcurrency = 0 }, 'maxConcurrency below minimum'],
      ['worker.hello', (p) => { p.maxConcurrency = 33 }, 'maxConcurrency above maximum'],
      ['hub.challenge', (p) => { p.nonce = 'short' }, 'nonce wrong length'],
      ['hub.challenge', (p) => { p.protocolVersions = [] }, 'empty protocolVersions'],
      ['hub.welcome', (p) => { p.connectionEpoch = 0 }, 'non-positive connectionEpoch'],
      ['hub.welcome', (p) => { p.redactionPatterns = Array.from({ length: 65 }, () => 'x') }, 'too many redaction patterns'],
      ['run.ack', (p) => { p.acks = Array.from({ length: 65 }, () => ({ runId: 'run_01ARZ3NDEKTSV4RRFFQ69G5FAV', ackSeq: 1 })) }, 'too many acks'],
    ]
    for (const [name, mutate, label] of cases) {
      const original = frameOf(name)
      mutate(original.payload as Record<string, unknown>)
      expect(frame.safeParse(original).success, label).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// P-3 未知 type
// ---------------------------------------------------------------------------

describe('P-3 未知 type', () => {
  it('is still a structurally valid envelope so the gateway can decide 4400 vs ignore', () => {
    const base = frameOf('hub.heartbeat_ack')
    const unknown = { ...base, type: 'worker.future_frame' }
    expect(protocol.Envelope.safeParse(unknown).success).toBe(true)
    expect(protocol.HubToWorkerFrame.safeParse(unknown).success).toBe(false)
    expect(protocol.WorkerToHubFrame.safeParse(unknown).success).toBe(false)
    expect(frame.safeParse(unknown).success).toBe(false)
  })

  it('maps unknown/invalid frames to the 4400 BAD_FRAME close code', () => {
    expect(protocol.WorkerCloseCode.BAD_FRAME).toBe(4400)
    expect(protocol.HubReject.shape.code.safeParse('BAD_FRAME').success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// P-4 run.events 序号
// ---------------------------------------------------------------------------

describe('P-4 run.events seq 必须严格连续递增', () => {
  const styled = (seqs: number[]) => ({
    v: 1, id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', type: 'run.events', ts: 1_700_000_000_000,
    payload: {
      runId: 'run_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      events: seqs.map((seq) => ({ seq, ts: 1_700_000_000_000, kind: 'log', stream: 'stdout', text: 'x' })),
    },
  })

  it('accepts contiguous sequences starting anywhere', () => {
    for (const seqs of [[1], [1, 2, 3], [41, 42, 43], Array.from({ length: 500 }, (_, i) => i + 1)]) {
      const parsed = frame.safeParse(styled(seqs))
      expect(parsed.success, JSON.stringify(seqs.slice(0, 3))).toBe(true)
    }
  })

  it('rejects duplicates, gaps and descending sequences', () => {
    for (const seqs of [[1, 1], [1, 3], [2, 1], [1, 2, 4], [5, 4, 3], [1, 2, 2]]) {
      expect(frame.safeParse(styled(seqs)).success, JSON.stringify(seqs)).toBe(false)
    }
  })

  it('rejects empty, oversized and non positive sequences', () => {
    expect(frame.safeParse(styled([])).success).toBe(false)
    expect(frame.safeParse(styled(Array.from({ length: 501 }, (_, i) => i + 1))).success).toBe(false)
    expect(frame.safeParse(styled([0])).success).toBe(false)
    expect(frame.safeParse(styled([-1])).success).toBe(false)
    expect(frame.safeParse(styled([1.5])).success).toBe(false)
  })

  it('requires finished to be the last event and carries clamp metadata', () => {
    const frame500 = frameOf('run.events')
    const payload = frame500.payload as { events: Record<string, unknown>[] }
    const finished = { seq: 99, ts: 1, kind: 'finished', status: 'succeeded', exitCode: 0, signal: null, summary: 's', durationMs: 1 }
    payload.events = [finished, { seq: 100, ts: 1, kind: 'log', stream: 'stdout', text: 'late' }]
    expect(frame.safeParse(frame500).success).toBe(false)

    const started = payloadOf('run.events').events as Record<string, unknown>[]
    expect(started[0]).toMatchObject({ kind: 'started', effectiveProfile: 'edit', clampedFrom: 'full' })
    expect(protocol.RunEvent.safeParse({ seq: 1, ts: 1, kind: 'started', pid: 1, adapter: 'mock', commandSummary: 'x' }).success).toBe(false)
    /* effectiveProfile 必填；clampedFrom 可选但必须是合法档位 */
    expect(protocol.RunEvent.safeParse({
      seq: 1, ts: 1, kind: 'started', pid: 1, adapter: 'mock', effectiveProfile: 'edit', clampedFrom: 'root', commandSummary: 'x',
    }).success).toBe(false)
    expect(protocol.RunEvent.safeParse({
      seq: 1, ts: 1, kind: 'started', pid: 1, adapter: 'mock', effectiveProfile: 'edit', clampedFrom: 'full', commandSummary: 'x',
    }).success).toBe(true)
    expect(protocol.RunEvent.safeParse({
      seq: 1, ts: 1, kind: 'started', pid: 1, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'x'.repeat(513),
    }).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// P-5 Dashboard DTO / WS 帧
// ---------------------------------------------------------------------------

describe('P-5 Dashboard DTO / WS 帧', () => {
  const exportsByName = protocol as Record<string, unknown>

  for (const { name, payload } of fixtures('dashboard', false)) {
    it('rejects invalid ' + name, () => {
      const schema = name.startsWith('client-')
        ? protocol.DashClientFrame
        : name.startsWith('server-')
          ? protocol.DashServerFrame
          : exportsByName[name] as z.ZodType
      expect(schema.safeParse(payload).success).toBe(false)
    })
  }

  for (const { name, payload } of fixtures('dashboard', true)) {
    it('accepts valid ' + name, () => {
      const schema = name.startsWith('client-')
        ? protocol.DashClientFrame
        : name.startsWith('server-')
          ? protocol.DashServerFrame
          : exportsByName[name] as z.ZodType
      expect(schema.safeParse(payload).success).toBe(true)
    })
  }

  it('rejects unknown client frame types, unknown events and bad topics', () => {
    expect(protocol.DashClientFrame.safeParse({ t: 'nope' }).success).toBe(false)
    expect(protocol.DashClientFrame.safeParse({ t: 'ping', n: 1, extra: true }).success).toBe(false)
    expect(protocol.DashServerFrame.safeParse({ t: 'event', eventSeq: 1, topic: 'tasks', type: 'task.exploded', data: {} }).success).toBe(false)
    for (const topic of ['task:tsk_bad', 'task:', 'tasks ']) {
      expect(protocol.DashClientFrame.safeParse({ t: 'subscribe', topics: [topic] }).success, topic).toBe(false)
    }
    expect(protocol.DashClientFrame.safeParse({ t: 'subscribe', topics: Array.from({ length: 33 }, () => 'tasks') }).success).toBe(false)
  })

  it('rejects extra fields inside TaskSummary / WorkerView / Overview', () => {
    for (const name of ['TaskSummary', 'TaskDetail', 'WorkerView', 'Overview']) {
      const payload = fixtures('dashboard', true).find((entry) => entry.name === name)!.payload as Record<string, unknown>
      expect((exportsByName[name] as z.ZodType).safeParse({ ...payload, extra: 1 }).success, name).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// P-6 CardActionValue
// ---------------------------------------------------------------------------

describe('P-6 CardActionValue', () => {
  const value = {
    v: 1, a: 'approve', t: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV', ver: 5,
  }

  it('accepts every declared action', () => {
    for (const action of ['approve', 'reject', 'cancel', 'retry', 'input_option', 'publish_result', 'suppress_result']) {
      expect(protocol.CardActionValue.safeParse({ ...value, a: action }).success, action).toBe(true)
    }
  })

  it('validates the v2 result delivery fields', () => {
    expect(protocol.CardActionValue.safeParse({ ...value, a: 'publish_result' }).success).toBe(true)
    expect(protocol.CardActionValue.safeParse({ ...value, a: 'suppress_result' }).success).toBe(true)
    expect(protocol.CardActionValue.safeParse({ ...value, a: 'publish_result', ver: '5' }).success).toBe(false)
    expect(protocol.DeliverResultRequest.safeParse({ action: 'send' }).success).toBe(true)
    expect(protocol.DeliverResultRequest.safeParse({ action: 'suppress', summaryOverride: 'x' }).success).toBe(true)
    expect(protocol.DeliverResultRequest.safeParse({ action: 'publish' }).success).toBe(false)
    expect(protocol.DeliverResultRequest.safeParse({ action: 'send', extra: 1 }).success).toBe(false)
  })

  it('rejects wrong version, unknown action, bad task id, extra fields', () => {
    expect(protocol.CardActionValue.safeParse({ ...value, v: 2 }).success).toBe(false)
    expect(protocol.CardActionValue.safeParse({ ...value, a: 'publish' }).success).toBe(false)
    expect(protocol.CardActionValue.safeParse({ ...value, t: '123' }).success).toBe(false)
    expect(protocol.CardActionValue.safeParse({ ...value, ver: 5.5 }).success).toBe(false)
    expect(protocol.CardActionValue.safeParse({ ...value, extra: 1 }).success).toBe(false)
    expect(protocol.CardActionValue.safeParse({ v: 1, a: 'approve', ver: 5 }).success).toBe(false)
    expect(protocol.CardActionValue.safeParse({ ...value, opt: 'x'.repeat(201) }).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// P-8 协议版本
// ---------------------------------------------------------------------------

describe('P-8 协议版本', () => {
  it('exposes the single documented subprotocol and version', () => {
    expect(protocol.PROTOCOL_VERSION).toBe(1)
    expect(protocol.WORKER_SUBPROTOCOL).toBe('agent-hub.worker.v1')
    expect(protocol.DASHBOARD_SUBPROTOCOL).toBe('agent-hub.dashboard.v1')
  })

  it('rejects any envelope version other than 1', () => {
    const base = frameOf('worker.heartbeat')
    for (const v of [0, 2, '1', 1.5]) {
      expect(frame.safeParse({ ...base, v }).success, 'v=' + String(v)).toBe(false)
    }
  })

  it('maps protocol version failures to 4426 and pins the whole close code table', () => {
    expect(protocol.WorkerCloseCode.UNSUPPORTED_VERSION).toBe(4426)
    expect(protocol.WorkerCloseCode).toEqual({
      NORMAL: 1000, GOING_AWAY: 1001, FRAME_TOO_LARGE: 1009, BAD_FRAME: 4400, AUTH_FAILED: 4401,
      WORKER_REVOKED: 4403, TIMEOUT: 4408, SUPERSEDED: 4409, UNSUPPORTED_VERSION: 4426,
      RATE_LIMITED: 4429, HUB_ERROR: 4500, HUB_SHUTTING_DOWN: 4503,
    })
    expect(protocol.DashboardCloseCode).toEqual({ GOING_AWAY: 1001, SESSION_EXPIRED: 4001, TIMEOUT: 4008, RATE_LIMITED: 4029 })
  })

  it('announces supported protocol versions in hub.challenge', () => {
    const challenge = payloadOf('hub.challenge')
    expect(challenge.protocolVersions).toEqual([1])
    expect(protocol.HubChallenge.safeParse({ ...challenge, protocolVersions: [1, 2] }).success).toBe(true)
  })
})
