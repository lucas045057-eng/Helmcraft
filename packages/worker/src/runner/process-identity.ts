import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Kept dependency-free: kill-tree.ts and test fixtures load this file as raw TypeScript.
// Mirrors psEnv() in ../windows-powershell.ts (drop an inherited PowerShell 7 PSModulePath).
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const psEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'))

export function processStartTime(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        "(Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid + "').CreationDate.ToUniversalTime().Ticks"],
      { encoding: 'utf8', timeout: 3000, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'], env: psEnv() }).trim()
      return /^\d+$/.test(out) ? out : undefined
    }
    if (process.platform === 'linux') {
      const stat = readFileSync('/proc/' + pid + '/stat', 'utf8')
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      return boot + ':' + stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
    }
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', timeout: 3000, shell: false,
    }).trim() || undefined
  } catch { return undefined }
}

export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}


export function windowsProcessTree(root: number, start: string): ReadonlyMap<number, string> {
  const found = new Map<number, string>()
  if (process.platform !== 'win32' || !processAlive(root)) return found
  try {
    const out = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process | ForEach-Object { '{0},{1},{2}' -f $_.ProcessId,$_.ParentProcessId,$_.CreationDate.ToUniversalTime().Ticks }"],
    { encoding: 'utf8', timeout: 3000, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'], env: psEnv() })
    const processes = out.trim().split(/\r?\n/).flatMap(line => {
      const match = /^(\d+),(\d+),(\d+)$/.exec(line)
      return match ? [{ pid: Number(match[1]), parent: Number(match[2]), start: match[3]! }] : []
    })
    if (processes.find(p => p.pid === root)?.start !== start) return found
    found.set(root, start)
    for (let progress = true; progress;) {
      progress = false
      for (const process of processes) {
        const parent = found.get(process.parent)
        if (!found.has(process.pid) && parent && process.start >= parent) {
          found.set(process.pid, process.start)
          progress = true
        }
      }
    }
  } catch { /* Identity verification fails closed on an unavailable process inventory. */ }
  return found
}
