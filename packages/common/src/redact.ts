const MASK = '[REDACTED]'
const privateBegin = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g
const privateEnd = /-----END [A-Z ]*PRIVATE KEY-----/g
const scheme = /\b(?:postgres|mysql|mongodb(?:\+srv)?|redis):\/\//gi
const username = /[^:\s@]+:/y
const password = /[^@\s]+/y
const assignments = /(\b(?:api[_-]?key|secret|token|passwd|password)\b\s*[:=]\s*["']?)([^\s"']{8,})/gi
const awsSecret = /(\baws_secret_access_key\s*[=:]\s*["']?)([^\s"']+)/gi
const feishuSecret = /(\b(?:app_secret|tenant_access_token)(?:\s*[:=]\s*["']?|\W{0,3}))([A-Za-z0-9]{16,})/gi
const token = /\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{35}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/g
const base64url = /[A-Za-z0-9_-]+/g
const placeholder = /^\[REDACTED(?::[A-Za-z_][A-Za-z0-9_]*)?\]$/

export type KnownSecrets = Readonly<Record<string, string | undefined>>

function maskPasswords(text: string): string {
  let result = ''
  let copied = 0
  scheme.lastIndex = 0
  for (let match = scheme.exec(text); match; match = scheme.exec(text)) {
    username.lastIndex = scheme.lastIndex
    if (!username.exec(text)) continue
    const start = username.lastIndex
    password.lastIndex = start
    if (!password.exec(text)) continue
    const end = password.lastIndex
    // A later URL inside the same non-space segment cannot end before this one.
    scheme.lastIndex = end
    if (text.charAt(end) !== '@') continue
    const value = text.slice(start, end)
    result += text.slice(copied, start) + (placeholder.test(value) ? value : MASK)
    copied = end
  }
  return result + text.slice(copied)
}

function maskJwt(text: string): string {
  let first: RegExpExecArray | undefined
  let second: RegExpExecArray | undefined
  let result = ''
  let copied = 0
  base64url.lastIndex = 0
  // Walking maximal segments keeps repeated eyJ prefixes linear even without dots.
  for (let third = base64url.exec(text); third; third = base64url.exec(text)) {
    if (first && second && third[0].length >= 10 && second[0].length >= 13 && second[0].startsWith('eyJ')
      && second.index === first.index + first[0].length + 1 && text.charAt(second.index - 1) === '.'
      && third.index === second.index + second[0].length + 1 && text.charAt(third.index - 1) === '.') {
      const start = first[0].indexOf('eyJ')
      if (start >= 0 && first[0].length - start >= 13) {
        result += text.slice(copied, first.index + start) + MASK
        copied = base64url.lastIndex
        first = undefined
        second = undefined
        continue
      }
    }
    first = second
    second = third
  }
  return result + text.slice(copied)
}

function maskPrivateKeys(text: string, state: { inside: boolean }): string {
  let result = ''
  let copied = 0
  while (copied < text.length) {
    if (state.inside) {
      privateEnd.lastIndex = copied
      if (!privateEnd.exec(text)) return result
      state.inside = false
      copied = privateEnd.lastIndex
    } else {
      privateBegin.lastIndex = copied
      const begin = privateBegin.exec(text)
      if (!begin) return result + text.slice(copied)
      result += text.slice(copied, begin.index) + MASK
      copied = privateBegin.lastIndex
      state.inside = true
    }
  }
  return result
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function maskAssignment(_match: string, key: string, value: string): string {
  return key + (placeholder.test(value) ? value : MASK)
}

/** Reuse per stream so PEM blocks stay masked across line boundaries. */
export function createRedactor(knownSecrets: KnownSecrets = {}, extraPatterns: readonly string[] = []): (text: string) => string {
  const values = new Map<string, string>()
  for (const [key, value] of Object.entries(knownSecrets)) {
    if (value && value.length >= 8 && !values.has(value)) {
      values.set(value, /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? '[REDACTED:' + key + ']' : MASK)
    }
  }
  const escaped = [...values.keys()].sort((a, b) => b.length - a.length).map(escapeRegex)
  const known = escaped.length ? new RegExp(escaped.join('|'), 'g') : undefined
  const extras: RegExp[] = []
  for (const pattern of extraPatterns) {
    if (!pattern) continue
    try {
      extras.push(new RegExp(pattern, 'g'))
    } catch {
      // Ignore invalid dynamic patterns so redaction never crashes log delivery.
    }
  }
  const state = { inside: false }
  return (text) => {
    let masked = maskPrivateKeys(text, state)
    if (known) masked = masked.replace(known, (match) => values.get(match)!)
    masked = masked.replace(awsSecret, maskAssignment)
      .replace(feishuSecret, maskAssignment)
      .replace(assignments, maskAssignment)
      .replace(token, MASK)
    for (const extra of extras) masked = masked.replace(extra, MASK)
    return maskPasswords(maskJwt(masked))
  }
}

const defaultRedactor = createRedactor()

export function redact(text: string, knownSecrets?: KnownSecrets): string {
  // Stateless calls never share PEM state with unrelated log sources.
  if (knownSecrets || text.includes('-----BEGIN ')) return createRedactor(knownSecrets)(text)
  return defaultRedactor(text)
}
