import type { AdapterId } from '@agent-hub/protocol'
const windowsBase = 'SystemRoot SystemDrive windir ComSpec PATHEXT PATH TEMP TMP USERPROFILE USERNAME HOMEDRIVE HOMEPATH APPDATA LOCALAPPDATA ProgramData ProgramFiles ProgramFiles(x86) CommonProgramFiles NUMBER_OF_PROCESSORS PROCESSOR_ARCHITECTURE OS COMPUTERNAME'
const posixBase = 'PATH HOME USER LOGNAME SHELL TMPDIR LANG LC_ALL TZ'
export const adapterPassEnv: Record<AdapterId, string[]> = {
  'claude-code': ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_*'],
  codex: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS'],
  opencode: ['OPENCODE_*'],
  antigravity: ['ANTIGRAVITY_*'],
  mock: [],
}
const forced = { NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb', CI: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
const forbidden = /^(?:AGENT_WORKER_|HUB_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$|WORKER_(?:IDENTITY|PRIVATE_KEY))/iu

export function buildEnvironment(source: NodeJS.ProcessEnv, adapter: { passEnv: string[]; env: Record<string, string> },
  overrides: Record<string, string> = {}, allowedOverrideKeys: string[] = [], platform = process.platform) {
  const base = new Set(((platform === 'win32' ? windowsBase : posixBase) + ' HTTP_PROXY HTTPS_PROXY NO_PROXY').toUpperCase().split(' '))
  const env: NodeJS.ProcessEnv = {}
  const knownSecrets: Record<string, string> = {}
  const adapterKeys = adapter.passEnv.map(key => key.toUpperCase())
  const put = (key: string, value: string) => {
    if (forbidden.test(key)) return
    const normalized = platform === 'win32' ? key.toUpperCase() : key
    env[normalized] = value
  }
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || forbidden.test(key)) continue
    const upper = key.toUpperCase()
    const passed = adapterKeys.some(rule => rule.endsWith('*') ? upper.startsWith(rule.slice(0, -1)) : upper === rule)
    if (base.has(upper) || passed) put(key, value)
    if (passed && value.length >= 8) knownSecrets[key] = value
  }
  for (const [key, value] of Object.entries(adapter.env)) {
    put(key, value)
    if (!forbidden.test(key) && value.length >= 8) knownSecrets[key] = value
  }
  const overrideKeys = new Set(allowedOverrideKeys.map(key => key.toUpperCase()))
  for (const [key, value] of Object.entries(overrides)) {
    if ((!overrideKeys.has('*') && !overrideKeys.has(key.toUpperCase())) || forbidden.test(key)) continue
    put(key, value)
    if (value.length >= 8) knownSecrets[key] = value
  }
  for (const [key, value] of Object.entries(forced)) {
    for (const existing of Object.keys(env)) if (existing.toUpperCase() === key) delete env[existing]
    put(key, value)
  }
  return { env, knownSecrets }
}
