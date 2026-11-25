import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { it, expect } from 'vitest'
import { HubConfigSchema } from '../src/config/schema.js'
import { WorkerConfigSchema } from '../../worker/src/config/schema.js'

const deploy = new URL('../../../deploy/', import.meta.url)
it('loads both production examples using the real config schemas', () => {
  const example = (name: string) => parse(readFileSync(new URL(name + '.example.yaml', deploy), 'utf8'))
  const hub = HubConfigSchema.parse(example('hub'))
  expect(hub.logs.maxDbBytes).toBe(10 * 1024 ** 3)
  expect(hub.retention.sliceRows).toBe(5000)
  expect(hub.logs.retentionDays).toEqual({ succeeded: 30, other: 90 })
  const worker = WorkerConfigSchema.parse(example('worker'))
  expect(Object.keys(worker.adapters).filter(id => worker.adapters[id as keyof typeof worker.adapters].enabled)).toEqual(['codex'])
})
it.runIf(process.platform === 'win32')('parses both scheduled task wrappers with Windows PowerShell', () => {
  for (const action of ['install', 'uninstall']) {
    const script = fileURLToPath(new URL('windows/' + action + '-worker.ps1', deploy))
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$errors=$null; $tokens=$null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:WORKER_PS_FILE,[ref]$tokens,[ref]$errors); if ($errors.Count) { throw ($errors -join [Environment]::NewLine) }'],
    { env: { ...process.env, WORKER_PS_FILE: script }, windowsHide: true })
  }
})
