import { appendFileSync, closeSync, mkdirSync, openSync, readSync, renameSync, statSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

const COPY_CHUNK = 64 * 1024

export class LocalLog {
  private readonly path: string
  private bytes = 0
  private pending: Buffer[] = []
  private pendingBytes = 0
  constructor(root: string, runId: string, private readonly maxBytes: number) {
    this.path = join(root, runId, 'output.log')
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    this.bytes = statSync(this.path, { throwIfNoEntry: false })?.size ?? 0
  }
  append(text: string) {
    const bytes = Buffer.from(text)
    this.pending.push(bytes)
    this.pendingBytes += bytes.length
    if (this.pendingBytes >= Math.min(64 * 1024, this.maxBytes)) this.flush()
  }
  flush() {
    if (!this.pendingBytes) return
    const raw = this.pending.length === 1 ? this.pending[0]! : Buffer.concat(this.pending, this.pendingBytes)
    this.pending = []
    this.pendingBytes = 0
    const data = raw.subarray(Math.max(0, raw.length - this.maxBytes))
    if (this.bytes + data.length > this.maxBytes) {
      const retain = Math.min(this.bytes, this.maxBytes - data.length, Math.floor(this.maxBytes / 2))
      const tmp = this.path + '.tmp'
      const dst = openSync(tmp, 'w', 0o600)
      try {
        if (retain > 0) {
          const src = openSync(this.path, 'r')
          const chunk = Buffer.allocUnsafe(Math.min(COPY_CHUNK, retain))
          try {
            let offset = this.bytes - retain
            let remaining = retain
            while (remaining > 0) {
              const n = readSync(src, chunk, 0, Math.min(chunk.length, remaining), offset)
              if (n <= 0) break
              writeSync(dst, chunk, 0, n)
              offset += n
              remaining -= n
            }
          } finally { closeSync(src) }
        }
        writeSync(dst, data, 0, data.length)
      } finally { closeSync(dst) }
      renameSync(tmp, this.path)
      this.bytes = retain + data.length
      return
    }
    appendFileSync(this.path, data, { mode: 0o600 })
    this.bytes += data.length
  }
}

/** Full local stream, independent of the 16 KiB protocol line cap. */
export class LocalLogStream {
  private readonly decoder = new StringDecoder('utf8')
  private pending = ''
  private fragmented = false
  constructor(private readonly scrub: (text: string) => string, private readonly write: (text: string) => void) {}
  push(data: Buffer) { this.accept(this.decoder.write(data)) }
  finish() {
    this.accept(this.decoder.end())
    if (this.pending) this.write(this.clean(this.pending))
    this.pending = ''
  }
  private clean(text: string) {
    const clean = this.scrub(text)
    if (this.fragmented) return '[REDACTED]' + (text.endsWith('\n') ? '\n' : '')
    return clean
  }
  private accept(text: string) {
    let start = 0
    for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
      this.write(this.clean(this.pending + text.slice(start, end + 1)))
      this.pending = ''
      this.fragmented = false
      start = end + 1
    }
    this.pending += text.slice(start)
    if (this.pending.length >= 2 * 1024 * 1024) {
      // Prefer a whitespace boundary so common credentials remain in the same scrub block.
      const boundary = this.pending.lastIndexOf(' ', this.pending.length - 4096)
      const at = boundary > 128 * 1024 ? boundary + 1 : this.pending.length - 4096
      const fragment = this.pending.slice(0, at)
      const clean = this.scrub(fragment)
      this.fragmented = this.fragmented || boundary <= 128 * 1024 || clean !== fragment
      this.write(this.fragmented ? '[REDACTED]' : clean)
      this.pending = this.pending.slice(at)
    }
  }
}
