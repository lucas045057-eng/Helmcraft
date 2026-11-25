/**
 * Pi 独立验收 · 06 §6.5 日志脱敏门禁 SEC-10 ~ SEC-14
 *
 * 覆盖范围（逐条对应规格表）：
 *  SEC-10 每条规则的正例：已知密钥值 / Anthropic / OpenAI / Google / GitHub / Slack / AWS /
 *         飞书 / JWT / 私钥块 / 通用赋值 / 连接串
 *  SEC-11 负例不误伤：UUID、SHA-256/SHA-1、base64 图片片段、普通长 hex、路径、正常英文
 *  SEC-12 已知密钥值精确替换（[REDACTED:<KEY>]、最短值门限、最长优先、幂等）
 *  SEC-13 私钥块跨行整块屏蔽（RSA / EC / OPENSSH、双块、流式跨行、未闭合）
 *  SEC-14 每条正则 100 KiB 病态输入 < 50 ms（含 warm-up，取 3 次中位数）
 */
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { createRedactor, redact } from '../src/redact.js'

const long = 'A'.repeat(60)

/** 200 KiB 级病态输入的单次耗时（ms，取 3 次中位数，含 warm-up）。 */
function elapsed(run: () => void): number {
  run()
  const samples = [0, 1, 2].map(() => {
    const start = performance.now()
    run()
    return performance.now() - start
  })
  return samples.sort((a, b) => a - b)[1]!
}

describe('SEC-10 每条规则的正例', () => {
  const positives: [string, string][] = [
    ['Anthropic sk-ant-', 'sk-ant-' + long],
    ['OpenAI sk-', 'sk-' + long],
    ['OpenAI sk-proj-', 'sk-proj-' + long],
    ['Google AIza', 'AIza' + 'A'.repeat(35)],
    ['GitHub PAT classic', 'ghp_' + long],
    ['GitHub oauth', 'gho_' + long],
    ['GitHub user', 'ghu_' + long],
    ['GitHub server', 'ghs_' + long],
    ['GitHub refresh', 'ghr_' + long],
    ['GitHub fine-grained', 'github_pat_' + 'A'.repeat(50)],
    ['Slack bot', 'xoxb-' + long],
    ['Slack user', 'xoxp-' + long],
    ['Slack app', 'xoxa-' + long],
    ['Slack refresh', 'xoxr-' + long],
    ['Slack app-level', 'xoxs-' + long],
    ['AWS access key id', 'AKIA' + 'A'.repeat(16)],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBVJsV4h0F2Y'],
  ]

  for (const [rule, token] of positives) {
    it('masks ' + rule + ' completely', () => {
      const result = redact(token)
      expect(result).toContain('[REDACTED')
      expect(result).not.toContain(token)
      /* 不得残留在同一个 token 中的任何 >8 字符原片段 */
      expect(result).toBe('[REDACTED]')
    })
  }

  it('masks AWS secret access keys while keeping the key name', () => {
    for (const input of ['aws_secret_access_key = wJalrXUtnFEMI/K7MDENG', 'aws_secret_access_key:wJalrXUtnFEMI/K7MDENG']) {
      const result = redact(input)
      expect(result).toMatch(/^aws_secret_access_key ?[:=] ?\[REDACTED\]$/)
      expect(result).not.toContain('wJalrXUtnFEMI')
    }
  })

  it('masks Feishu app secrets and tenant tokens', () => {
    expect(redact('app_secret=abcdefghijklmnop')).toBe('app_secret=[REDACTED]')
    expect(redact('app_secret = abcdefghijklmnop')).toBe('app_secret = [REDACTED]')
    expect(redact('app_secret  =  abcdefghijklmnop')).toBe('app_secret  =  [REDACTED]')
    expect(redact('tenant_access_token: abcdefghijklmnop')).toBe('tenant_access_token: [REDACTED]')
    expect(redact('"app_secret":"abcdefghijklmnop"')).not.toContain('abcdefghijklmnop')
  })

  it('masks generic assignments but keeps the key name and quoting', () => {
    const cases: [string, string][] = [
      ['api_key=abcdefgh', 'api_key=[REDACTED]'],
      ['api-key: abcdefgh', 'api-key: [REDACTED]'],
      ['apikey=abcdefgh', 'apikey=[REDACTED]'],
      ['secret=abcdefgh', 'secret=[REDACTED]'],
      ['token: abcdefgh', 'token: [REDACTED]'],
      ['passwd=abcdefgh', 'passwd=[REDACTED]'],
      ['password="abcdefgh"', 'password="[REDACTED]"'],
      ['PASSWORD = abcdefgh', 'PASSWORD = [REDACTED]'],
    ]
    for (const [input, expected] of cases) expect(redact(input), input).toBe(expected)
  })

  it('masks connection string passwords for every documented scheme', () => {
    for (const scheme of ['postgres', 'mysql', 'mongodb', 'mongodb+srv', 'redis']) {
      const result = redact(scheme + '://user:hunter2hunter2@db.local:5432/app')
      expect(result, scheme).toBe(scheme + '://user:[REDACTED]@db.local:5432/app')
    }
  })

  it('masks secrets that appear mid-line without destroying context', () => {
    const line = '07:12 INFO running with sk-ant-' + long + ' and db postgres://u:p4ssw0rd@h/x (done)'
    const result = redact(line)
    expect(result).toBe('07:12 INFO running with [REDACTED] and db postgres://u:[REDACTED]@h/x (done)')
  })
})

describe('SEC-11 负例不误伤', () => {
  const negatives = [
    '0f44cb17-d588-4f75-80bc-cb74a6dd76e6',
    '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    'commit 3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f40',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'C:\\Users\\me\\code\\src\\pages\\Login.tsx:42',
    '/home/me/.local/share/app.log',
    '2026-01-02T03:04:05.678Z INFO GET /api/v1/tasks 200 12ms',
    'resolved 3 files, 12 insertions(+), 4 deletions(-)',
    'npm warn deprecated request@2.88.2: request has been deprecated',
    'Authorization: Bearer abcdefghijklmnop',
    'the token: abc',
    'sha256=abc',
    '',
  ]

  for (const text of negatives) {
    it('keeps ' + JSON.stringify(text.slice(0, 40)) + ' untouched', () => {
      expect(redact(text)).toBe(text)
    })
  }

  it('keeps values shorter than the 8 character threshold visible', () => {
    expect(redact('password=1234567')).toBe('password=1234567')
    expect(redact('AIza' + 'A'.repeat(34))).toBe('AIza' + 'A'.repeat(34))
  })

  it('keeps an already redacted placeholder idempotent', () => {
    const line = 'password=[REDACTED] token=[REDACTED:KEY]'
    expect(redact(line)).toBe(line)
    expect(redact(redact(line))).toBe(line)
  })

  it('does not leak a known secret through a UUID-shaped value', () => {
    const uuid = '0f44cb17-d588-4f75-80bc-cb74a6dd76e6'
    expect(redact(uuid, { KNOWN: 'local-secret' })).toBe(uuid)
  })

  it('does not over-match ordinary words containing sk- without a word boundary', () => {
    expect(redact('disk-usage-report-for-week-1')).toBe('disk-usage-report-for-week-1')
    expect(redact('task-sku-mapping-inventory')).toBe('task-sku-mapping-inventory')
  })
})

describe('SEC-12 已知密钥值精确替换', () => {
  it('replaces every occurrence with a named placeholder', () => {
    const result = redact('a local-secret b local-secret c', { ANTHROPIC_API_KEY: 'local-secret' })
    expect(result).toBe('a [REDACTED:ANTHROPIC_API_KEY] b [REDACTED:ANTHROPIC_API_KEY] c')
  })

  it('replaces values containing regex metacharacters and spaces', () => {
    expect(redact('x a+b.c$dd y', { KEY: 'a+b.c$dd' })).toBe('x [REDACTED:KEY] y')
    expect(redact('pre super secret value post', { KEY: 'super secret value' }))
      .toBe('pre [REDACTED:KEY] post')
  })

  it('ignores values shorter than 8 characters as the spec requires', () => {
    expect(redact('abc', { KEY: 'abc' })).toBe('abc')
    expect(redact('abcdefg', { KEY: 'abcdefg' })).toBe('abcdefg')
    expect(redact('abcdefgh', { KEY: 'abcdefgh' })).toBe('[REDACTED:KEY]')
  })

  it('prefers the longest known value so no suffix leaks', () => {
    expect(redact('abcdefgh ab', { SHORT: 'abcdefgh', LONG: 'abcdefgh ab' })).toBe('[REDACTED:LONG]')
  })

  it('falls back to an unnamed placeholder for non identifier key names', () => {
    expect(redact('v a+b.c$dd y', { 'weird-key': 'a+b.c$dd' })).toBe('v [REDACTED] y')
  })

  it('is idempotent and does not re-mask its own placeholder', () => {
    const once = redact('local-secret', { K: 'local-secret' })
    expect(once).toBe('[REDACTED:K]')
    expect(redact(once, { K: 'local-secret' })).toBe('[REDACTED:K]')
  })
})

describe('SEC-13 私钥块跨行', () => {
  const blocks = [
    ['RSA', '-----BEGIN RSA PRIVATE KEY-----', '-----END RSA PRIVATE KEY-----'],
    ['EC', '-----BEGIN EC PRIVATE KEY-----', '-----END EC PRIVATE KEY-----'],
    ['OPENSSH', '-----BEGIN OPENSSH PRIVATE KEY-----', '-----END OPENSSH PRIVATE KEY-----'],
    ['PRIVATE KEY', '-----BEGIN PRIVATE KEY-----', '-----END PRIVATE KEY-----'],
    ['ENCRYPTED', '-----BEGIN ENCRYPTED PRIVATE KEY-----', '-----END ENCRYPTED PRIVATE KEY-----'],
  ] as const

  for (const [label, begin, end] of blocks) {
    it('masks a multi line ' + label + ' block as a whole', () => {
      const text = 'before ' + begin + '\nMIIEow' + long + '\nqqqq\n' + end + ' after'
      expect(redact(text)).toBe('before [REDACTED] after')
    })
  }

  it('masks two blocks in the same string and keeps the text between them', () => {
    const text = '-----BEGIN PRIVATE KEY-----\nA\n-----END PRIVATE KEY-----\nmid\n'
      + '-----BEGIN OPENSSH PRIVATE KEY-----\nB\n-----END OPENSSH PRIVATE KEY-----\nend'
    expect(redact(text)).toBe('[REDACTED]\nmid\n[REDACTED]\nend')
  })

  it('keeps PEM state across per-line calls of one redactor', () => {
    const line = createRedactor()
    expect(line('x -----BEGIN PRIVATE KEY-----')).toBe('x [REDACTED]')
    expect(line('key body')).toBe('')
    expect(line('-----END PRIVATE KEY----- y')).toBe(' y')
    // 之后的普通文本恢复正常
    expect(line('normal log line')).toBe('normal log line')
  })

  it('fails closed when the block is never closed', () => {
    const result = redact('-----BEGIN PRIVATE KEY-----\nsecret body here')
    expect(result).toBe('[REDACTED]')
    expect(result).not.toContain('secret')
  })

  it('does not leak key material into an unrelated stateless call', () => {
    expect(redact('-----BEGIN PRIVATE KEY-----')).toBe('[REDACTED]')
    expect(redact('other source')).toBe('other source')
  })
})

describe('SEC-14 ReDoS：每条正则 100 KiB 病态输入 < 50 ms', () => {
  const kib100 = 100 * 1024
  const pathological: [string, string][] = [
    ['anthropic/openai prefix flood', 'sk-ant-' + 'a'.repeat(kib100)],
    ['openai bare prefix flood', 'sk-' + 'a'.repeat(kib100)],
    ['openai near miss repeats', 'sk-' + 'a'.repeat(19) + '-'.repeat(64) + ('sk-' + 'a'.repeat(19)).repeat(3_000)],
    ['google prefix flood', 'AIza' + 'A'.repeat(kib100)],
    ['github_pat underscore flood', 'github_pat_' + '_'.repeat(kib100)],
    ['github classic flood', 'ghp_' + 'a'.repeat(kib100)],
    ['slack flood', 'xoxb-' + 'a-'.repeat(kib100 / 2)],
    ['aws secret assignment flood', 'aws_secret_access_key=' + ' '.repeat(kib100)],
    ['feishu non word flood', 'app_secret' + ' '.repeat(kib100)],
    ['feishu token flood', 'tenant_access_token' + '!'.repeat(kib100)],
    ['generic assignment flood', 'password' + ' '.repeat(kib100)],
    ['generic assignment value flood', 'password=' + 'a'.repeat(kib100)],
    ['assignment key repeats', 'password=short '.repeat(kib100 / 15)],
    ['connection string colon flood', 'postgres://user:' + ':'.repeat(kib100)],
    ['connection string repeats', 'postgres://user:'.repeat(6_400)],
    ['connection string no at', 'mysql://user:' + 'p'.repeat(kib100)],
    ['jwt eyJ repeat', 'eyJ'.repeat(kib100 / 3)],
    ['jwt dot flood', 'eyJ' + 'a'.repeat(kib100) + '.'],
    ['jwt dotted near miss', ('eyJ' + 'a'.repeat(12) + '.').repeat(kib100 / 16)],
    ['pem begin flood', '-----BEGIN ' + ' '.repeat(kib100)],
    ['pem begin repeat', '-----BEGIN '.repeat(kib100 / 11)],
    ['pem upper flood', '-----BEGIN ' + 'A'.repeat(kib100)],
    ['pem unterminated lines', ('-----BEGIN PRIVATE KEY-----\n' + 'A'.repeat(40) + '\n').repeat(2_000)],
    ['base64 no separators', 'A'.repeat(kib100)],
    ['mixed rule salad', ['sk-ant-', 'AIza', 'ghp_', 'AKIA', 'eyJ', 'password=', 'postgres://u:'].join('').repeat(kib100 / 40)],
  ]

  for (const [label, input] of pathological) {
    it('stays under 50 ms for ' + label, () => {
      expect(input.length).toBeGreaterThan(0)
      const ms = elapsed(() => { redact(input) })
      expect(ms, label + ' took ' + ms.toFixed(2) + 'ms').toBeLessThan(50)
    })
  }

  it('stays under 50 ms with known-secret replacement enabled', () => {
    const known = { ANTHROPIC_API_KEY: 'a'.repeat(32) }
    const input = 'sk-ant-' + 'a'.repeat(kib100) + 'app_secret=' + ':'.repeat(1_000)
    const ms = elapsed(() => { redact(input, known) })
    expect(ms, 'known secrets took ' + ms.toFixed(2) + 'ms').toBeLessThan(50)
  })

  it('stays under 50 ms per 16 KiB line (Worker line cap) in a batch', () => {
    const line = 16 * 1024
    const text = 'postgres://user:' + 'p'.repeat(line - 20)
    const ms = elapsed(() => { for (let i = 0; i < 100; i++) redact(text) })
    expect(ms / 100, 'per 16 KiB line').toBeLessThan(50)
  })
})
