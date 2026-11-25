import { randomBytes } from 'node:crypto'
import { RUN_ID_PATTERN, TASK_ID_PATTERN } from '@agent-hub/protocol/common'
import type { RunId, TaskId, UlidGenerator } from '@agent-hub/protocol/common'
import { SystemClock } from './clock.js'

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const MAX_TIME = 2 ** 48 - 1
const MAX_ENTROPY = 2n ** 80n - 1n
const clock = new SystemClock()

function encode(value: bigint, width: number): string {
  let encoded = ''
  for (let i = 0; i < width; i++) {
    encoded = alphabet.charAt(Number(value & 31n)) + encoded
    value >>= 5n
  }
  return encoded
}

export function createUlidGenerator(): UlidGenerator {
  let previousTime = -1
  let entropy = 0n
  return (now) => {
    if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) throw new RangeError('invalid ULID timestamp')
    if (now > previousTime) {
      entropy = BigInt('0x' + randomBytes(10).toString('hex'))
      previousTime = now
    } else {
      if (entropy === MAX_ENTROPY) throw new RangeError('ULID entropy overflow')
      entropy++
    }
    return encode(BigInt(previousTime), 10) + encode(entropy, 16)
  }
}

const generate = createUlidGenerator()
export const ulid = (now = clock.now()): string => generate(now)
export const taskId = (now?: number): TaskId => `tsk_${ulid(now)}`
export const runId = (now?: number): RunId => `run_${ulid(now)}`
export const isTaskId = (value: string): boolean => TASK_ID_PATTERN.test(value)
export const isRunId = (value: string): boolean => RUN_ID_PATTERN.test(value)
