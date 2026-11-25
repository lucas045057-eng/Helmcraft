import { join } from 'node:path'

export const windowsSystemDir = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
export const powershell = join(windowsSystemDir, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
export const psLiteral = (value: string) => "'" + value.replaceAll("'", "''") + "'"
export const psEncoded = (script: string) => Buffer.from(script, 'utf16le').toString('base64')
export const psArgs = (script: string) => ['-NoProfile', '-NonInteractive', '-EncodedCommand',
  psEncoded("$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n" + script)]
