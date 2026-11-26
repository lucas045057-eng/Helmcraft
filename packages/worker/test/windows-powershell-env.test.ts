import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { powershell, psArgs, psEnv } from '../src/windows-powershell.js'

describe('psEnv', () => {
  it('drops PSModulePath in any letter case and keeps everything else', () => {
    const env = psEnv({ PSModulePath: 'C:\\pwsh7\\Modules', psmodulepath: 'x', PATH: 'C:\\bin', SystemRoot: 'C:\\Windows' })
    expect(env).toEqual({ PATH: 'C:\\bin', SystemRoot: 'C:\\Windows' })
  })

  it.skipIf(process.platform !== 'win32')('lets Windows PowerShell load Get-Acl even when a PowerShell 7 module path is inherited', () => {
    // Simulate a pwsh 7 parent: its module directories come first in PSModulePath.
    const poisoned = { ...process.env, PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules;' + (process.env.PSModulePath ?? '') }
    const out = execFileSync(powershell, psArgs("(Get-Acl -LiteralPath $env:SystemRoot).GetType().Name"),
      { encoding: 'utf8', windowsHide: true, timeout: 20_000, env: psEnv(poisoned) }).trim()
    expect(out).toBe('DirectorySecurity')
  })
})
