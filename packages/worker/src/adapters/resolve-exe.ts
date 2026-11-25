import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { delimiter, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'

export interface ResolvedExe {
  command: string
  prefixArgs: string[]
}

export type ResolveResult =
  | { status: 'ready'; exe: ResolvedExe }
  | { status: 'missing' }
  | { status: 'error'; error: string }

const windows = process.platform === 'win32'
const npmTargets = /"%_prog%"\s+"%(?:dp0%|~dp0)[\\/]([^"%!:\r\n]+\.(?:js|cjs|mjs))"\s+%\*/gim
const legacyTargets = /(?:"(?:node(?:\.exe)?|%(?:dp0%|~dp0)[\\/]node\.exe)"|node(?:\.exe)?)\s+"%(?:dp0%|~dp0)[\\/]([^"%!:\r\n]+\.(?:js|cjs|mjs))"\s+%\*/gim
const nativeTargets = /^[ \t]*"%(?:dp0%|~dp0)[\\/]([^"%!:\r\n]+\.exe)"[ \t]+%\*[ \t]*\r?$/gim

function isFile(path: string, executable = false): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (executable && !windows) accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function ready(command: string, prefixArgs: string[] = []): ResolveResult {
  return { status: 'ready', exe: { command, prefixArgs } }
}

function resolveShim(shim: string): ResolveResult {
  const error: ResolveResult = {
    status: 'error',
    error: 'Unsupported npm .cmd shim. Configure an absolute executable path in adapters.<id>.command.',
  }
  try {
    if (statSync(shim).size > 64 * 1024) return error
    const source = readFileSync(shim, 'utf8')
    const targets = new Set(
      [...source.matchAll(npmTargets), ...source.matchAll(legacyTargets), ...source.matchAll(nativeTargets)]
        .map(match => match[1]!),
    )
    if (targets.size !== 1) return error
    const dir = dirname(shim)
    const target = resolve(dir, [...targets][0]!)
    const rel = relative(dir, target)
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) || !isFile(target)) return error
    if (extname(target).toLowerCase() === '.exe') return ready(target)
    const localNode = resolve(dir, 'node.exe')
    return ready(isFile(localNode) ? localNode : process.execPath, [target])
  } catch {
    return error
  }
}

export function resolveExe(name: string, options: { command?: string; path?: string } = {}): ResolveResult {
  if (options.command !== undefined) {
    const command = options.command
    if (!isAbsolute(command) || !isFile(command, true)) {
      return { status: 'error', error: 'Configured command must be an existing absolute executable path.' }
    }
    const extension = extname(command).toLowerCase()
    if (windows && extension === '.cmd') return resolveShim(command)
    if (windows && extension !== '.exe') return { status: 'error', error: 'Expected a Windows .exe or npm .cmd shim.' }
    return ready(command)
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..') {
    return { status: 'error', error: 'Executable name must be a filename.' }
  }
  const path = options.path ?? process.env.PATH ?? ''
  const directories = path.split(delimiter).map((part) => part.replace(/^"|"$/g, '')).filter(isAbsolute)
  const nativeName = windows && !name.toLowerCase().endsWith('.exe') ? name + '.exe' : name
  for (const dir of directories) {
    const command = resolve(dir, nativeName)
    if (isFile(command, true)) return ready(command)
  }
  if (windows && !name.toLowerCase().endsWith('.exe')) {
    const shimName = name.toLowerCase().endsWith('.cmd') ? name : name + '.cmd'
    for (const dir of directories) {
      const shim = resolve(dir, shimName)
      if (isFile(shim)) return resolveShim(shim)
    }
  }
  return { status: 'missing' }
}
