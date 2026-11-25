import { execFile, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { processAlive, processStartTime, windowsProcessTree } from './process-identity.ts'

const require = createRequire(import.meta.url)
const KILL_ON_JOB_CLOSE = 0x2000
const EXTENDED_LIMIT_INFORMATION = 9
const PROCESS_TERMINATE_AND_SET_QUOTA = 0x0001 | 0x0100

interface Job {
  terminate(): void
  empty(): boolean
  close(): void
}

function loadJobApi() {
  const ffi: typeof import('koffi') = require('koffi')
  const kernel = ffi.load('kernel32.dll')
  const basic = ffi.struct({
    PerProcessUserTimeLimit: 'int64_t',
    PerJobUserTimeLimit: 'int64_t',
    LimitFlags: 'uint32_t',
    MinimumWorkingSetSize: 'size_t',
    MaximumWorkingSetSize: 'size_t',
    ActiveProcessLimit: 'uint32_t',
    Affinity: 'uintptr_t',
    PriorityClass: 'uint32_t',
    SchedulingClass: 'uint32_t',
  })
  const io = ffi.struct({
    ReadOperationCount: 'uint64_t',
    WriteOperationCount: 'uint64_t',
    OtherOperationCount: 'uint64_t',
    ReadTransferCount: 'uint64_t',
    WriteTransferCount: 'uint64_t',
    OtherTransferCount: 'uint64_t',
  })
  const extended = ffi.struct({
    BasicLimitInformation: basic, IoInfo: io,
    ProcessMemoryLimit: 'size_t', JobMemoryLimit: 'size_t',
    PeakProcessMemoryUsed: 'size_t', PeakJobMemoryUsed: 'size_t',
  })
  const size = ffi.sizeof(extended)
  const flagsOffset = ffi.offsetof(basic, 'LimitFlags')
  const ioOffset = ffi.offsetof(extended, 'IoInfo')
  if (process.arch === 'x64' && (size !== 144 || ffi.alignof(extended) !== 8 || ffi.sizeof(basic) !== 64
    || flagsOffset !== 16 || ioOffset !== 64 || ffi.offsetof(extended, 'ProcessMemoryLimit') !== 112
    || ffi.offsetof(extended, 'PeakJobMemoryUsed') !== 136)) {
    throw new Error('Unexpected Windows x64 Job Object structure layout')
  }
  // Pass a zeroed native-layout buffer so unspecified limits and reserved fields stay zero.
  const limits = Buffer.alloc(size)
  limits.writeUInt32LE(KILL_ON_JOB_CLOSE, flagsOffset)
  const create = kernel.func('void * __stdcall CreateJobObjectW(void *, const char16_t *)')
  const setInfo = kernel.func('int __stdcall SetInformationJobObject(void *, int, void *, uint32_t)')
  const open = kernel.func('void * __stdcall OpenProcess(uint32_t, int, uint32_t)')
  const assign = kernel.func('int __stdcall AssignProcessToJobObject(void *, void *)')
  const terminate = kernel.func('int __stdcall TerminateJobObject(void *, uint32_t)')
  const query = kernel.func('int __stdcall QueryInformationJobObject(void *, int, void *, uint32_t, void *)')
  const closeHandle = kernel.func('int __stdcall CloseHandle(void *)')
  const lastError = kernel.func('uint32_t __stdcall GetLastError()')
  const fail = (operation: string): never => { throw new Error(operation + ' failed with Win32 error ' + lastError()) }

  return (pid?: number): Job => {
    const handle: unknown = create(null, null)
    if (!handle) fail('CreateJobObjectW')
    let closed = false
    const close = () => {
      if (closed) return
      if (!closeHandle(handle)) fail('CloseHandle')
      closed = true
    }
    try {
      if (!setInfo(handle, EXTENDED_LIMIT_INFORMATION, limits, size)) fail('SetInformationJobObject')
      if (pid !== undefined) {
        const child: unknown = open(PROCESS_TERMINATE_AND_SET_QUOTA, 0, pid)
        if (!child) fail('OpenProcess')
        try {
          if (!assign(handle, child)) fail('AssignProcessToJobObject')
        } finally {
          closeHandle(child)
        }
      }
      return {
        empty() {
          // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION.ActiveProcesses follows four
          // LARGE_INTEGER fields and two DWORD counters.
          const accounting = Buffer.alloc(48)
          if (!query(handle, 1, accounting, accounting.length, null)) fail('QueryInformationJobObject')
          return accounting.readUInt32LE(40) === 0
        },
        terminate() {
          if (!closed && !terminate(handle, 1)) fail('TerminateJobObject')
        },
        close,
      }
    } catch (error) {
      close()
      throw error
    }
  }
}

let createJob: ReturnType<typeof loadJobApi> | undefined

export function checkWindowsJobObject() {
  createJob ??= loadJobApi()
  createJob().close()
}

function taskkill(pid: number, force: boolean): Promise<void> {
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
  const args = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])]
  return new Promise((resolve, reject) => {
    execFile(executable, args, { windowsHide: true, shell: false }, (error) => {
      if (!error || error.code === 128) resolve()
      else reject(error)
    })
  })
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

/** Non-blocking tree operations for the verification deadline. The ordinary CLI
 * tracker also inventories Windows processes, which can block on PowerShell. */
export function trackVerificationTree(child: ChildProcess, useJobObject: boolean, warn: (error: unknown) => void) {
  const pid = child.pid!
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new RangeError('invalid child PID')
  let job: Job | undefined
  if (process.platform === 'win32') {
    if (useJobObject) {
      try {
        createJob ??= loadJobApi()
        job = createJob(pid)
      } catch (error) { warn(error) }
    } else {
      warn(new Error('Verification Job Object disabled'))
    }
  }
  const startTime = processStartTime(pid)
  return {
    startTime,
    terminate(force: boolean) {
      if (process.platform === 'win32') {
        if (job) job.terminate()
        else child.kill() // Node retains the original Windows process handle.
      } else {
        // While the leader is still running its PID cannot have been reused.
        // After exit a newly-created leader must never receive this group's signal.
        if (child.exitCode !== null || child.signalCode !== null) {
          if (processAlive(pid)) throw new Error('Verification process group identity changed')
        }
        killGroup(pid, force ? 'SIGKILL' : 'SIGTERM')
      }
    },
    empty() {
      if (process.platform === 'win32') return job?.empty() ?? false
      try { process.kill(-pid, 0); return false }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
        throw error
      }
    },
    close() { job?.close() },
  }
}

export interface ProcessTree {
  readonly mode: 'job' | 'taskkill' | 'process-group'
  readonly startTime: string | undefined
  observe(pid: number): void
  kill(options?: { force?: boolean; graceMs?: number; signal?: AbortSignal }): Promise<void>
  close(): void
}

/** Call synchronously immediately after spawn. POSIX requires detached: true. */
export function trackProcessTree(pid: number, options: { useJobObject?: boolean; onWarning?: (error: unknown) => void } = {}): ProcessTree {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fff_ffff || pid === process.pid) throw new RangeError('invalid child PID')
  const windows = process.platform === 'win32'
  let job: Job | undefined
  let closed = false
  if (windows && options.useJobObject !== false) {
    try {
      createJob ??= loadJobApi()
      job = createJob(pid)
    } catch (error) {
      options.onWarning?.(error)
    }
  }
  // Attach the Job before querying the process creation time.
  const startTime = processStartTime(pid)
  const observed = new Map<number, string>()
  if (startTime && windows) observed.set(pid, startTime)
  const warned = new Set<number>()
  const sameIdentity = (id: number, start: string) => processAlive(id) && processStartTime(id) === start
  const verify = () => {
    for (const [id, start] of observed) {
      if (warned.has(id) || !sameIdentity(id, start)) continue
      warned.add(id)
      options.onWarning?.({ code: 'ORPHAN_SURVIVED', pid: id })
    }
  }
  const stopWindowsTree = async (force: boolean) => {
    if (startTime && sameIdentity(pid, startTime)) await taskkill(pid, force)
  }

  return {
    startTime,
    observe(id) {
      if (!windows || job || id === process.pid || observed.has(id) || observed.size >= 128 || !startTime) return
      const start = processStartTime(id)
      if (start && start >= startTime) observed.set(id, start)
    },
    get mode() { return job ? 'job' : windows ? 'taskkill' : 'process-group' },
    async kill({ force = false, graceMs = 5000, signal } = {}) {
      if (closed) return
      if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > 60_000) throw new RangeError('invalid grace period')
      if (windows && !job && startTime && options.onWarning && processAlive(pid)) {
        for (const [id, start] of windowsProcessTree(pid, startTime)) observed.set(id, start)
      }
      if (!force) {
        if (windows) await stopWindowsTree(false).catch(() => undefined)
        else killGroup(pid, 'SIGTERM')
        await sleep(graceMs, undefined, { signal }).catch(error => {
          if (!signal?.aborted) throw error
        })
      }
      if (closed) return
      if (!windows) {
        killGroup(pid, 'SIGKILL')
      } else if (job) {
        try {
          job.terminate()
        } catch (error) {
          options.onWarning?.(error)
          try { job.close() } catch (closeError) { options.onWarning?.(closeError) }
          await stopWindowsTree(true)
        }
      } else await stopWindowsTree(true)
      if (windows && options.onWarning) {
        for (let elapsed = 0; elapsed < 3000 && [...observed.keys()].some(processAlive); elapsed += 50) await sleep(50)
        verify()
      }
    },
    close() {
      if (closed) return
      closed = true
      job?.close()
      if (windows && options.onWarning) verify()
    },
  }
}
