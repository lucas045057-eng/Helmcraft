import { join } from 'node:path'

export const windowsSystemDir = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
export const powershell = join(windowsSystemDir, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
// Windows PowerShell 5.1 must not inherit PSModulePath from a PowerShell 7 parent (pwsh terminals, GitHub runners):
// it then resolves 7.x builds of Microsoft.PowerShell.Security / CimCmdlets, which fail to load, and Get-Acl or
// Get-CimInstance break. Without the variable, 5.1 rebuilds its own default module path.
export function psEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'))
}
export const psLiteral =(value: string) => "'" + value.replaceAll("'", "''") + "'"
export const psEncoded = (script: string) => Buffer.from(script, 'utf16le').toString('base64')
export const psArgs = (script: string) => ['-NoProfile', '-NonInteractive', '-EncodedCommand',
  psEncoded("$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n" + script)]
