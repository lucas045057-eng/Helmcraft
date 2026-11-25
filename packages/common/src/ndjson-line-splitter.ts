export interface SplitLine {
  text: string
  truncatedBytes?: number
}

const LF = 10
const CR = 13

function completeUtf8Prefix(bytes: Uint8Array, length: number): number {
  let start = length - 1
  while (start >= 0 && start >= length - 3 && (bytes[start]! & 0xc0) === 0x80) start--
  if (start < 0 || start < length - 3) return length
  const lead = bytes[start]!
  const width = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0
  if (length - start >= width) return length
  const second = bytes[start + 1]!
  if (start + 1 < length && (
    (lead === 0xe0 && second < 0xa0) || (lead === 0xed && second >= 0xa0)
    || (lead === 0xf0 && second < 0x90) || (lead === 0xf4 && second >= 0x90)
  )) return length
  return start
}

/** Retains a bounded byte prefix and decodes only on complete lines. */
export class NdjsonLineSplitter {
  private readonly prefix: Uint8Array
  private length = 0
  private lastByte = -1

  constructor(readonly maxLineBytes = 16 * 1024) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new RangeError('invalid line limit')
    this.prefix = new Uint8Array(maxLineBytes)
  }

  private append(bytes: Uint8Array): void {
    if (!bytes.length) return
    const retained = this.prefix.length - this.length
    if (retained > 0) this.prefix.set(bytes.subarray(0, retained), this.length)
    this.length += bytes.length
    this.lastByte = bytes[bytes.length - 1]!
  }

  private line(stripCR: boolean): SplitLine {
    const length = this.length - (stripCR && this.lastByte === CR ? 1 : 0)
    const retained = length > this.maxLineBytes ? completeUtf8Prefix(this.prefix, this.maxLineBytes) : length
    const truncatedBytes = length - retained
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
    const text = decoder.decode(this.prefix.subarray(0, retained))
    this.length = 0
    this.lastByte = -1
    return truncatedBytes ? { text: `${text}…[truncated ${truncatedBytes} bytes]`, truncatedBytes } : { text }
  }

  push(chunk: Uint8Array): SplitLine[] {
    const lines: SplitLine[] = []
    let start = 0
    for (let i = chunk.indexOf(LF, start); i !== -1; i = chunk.indexOf(LF, start)) {
      this.append(chunk.subarray(start, i))
      lines.push(this.line(true))
      start = i + 1
    }
    this.append(chunk.subarray(start))
    return lines
  }

  finish(): SplitLine[] {
    return this.length ? [this.line(false)] : []
  }
}

export function boundLogLine(line: SplitLine, maxBytes: number): SplitLine {
  const bytes = Buffer.from(line.text)
  if (bytes.length <= maxBytes) return line
  const existing = line.truncatedBytes ?? 0
  const previousMarker = existing ? '…[truncated ' + existing + ' bytes]' : ''
  const raw = previousMarker && line.text.endsWith(previousMarker)
    ? bytes.subarray(0, bytes.length - Buffer.byteLength(previousMarker)) : bytes
  let reserved = Math.min(maxBytes, 48)
  for (;;) {
    const keep = completeUtf8Prefix(raw, Math.min(raw.length, maxBytes - reserved))
    const truncatedBytes = raw.length - keep + existing
    const marker = '…[truncated ' + truncatedBytes + ' bytes]'
    const markerBytes = Buffer.byteLength(marker)
    if (markerBytes === reserved) return { text: raw.subarray(0, keep).toString('utf8') + marker, truncatedBytes }
    if (markerBytes > maxBytes) return { text: '', truncatedBytes: raw.length + existing }
    reserved = markerBytes
  }
}
