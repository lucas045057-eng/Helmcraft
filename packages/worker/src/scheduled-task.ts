import { execFile } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { powershell, psArgs, psLiteral } from './windows-powershell.js'

const entry = fileURLToPath(new URL('../bin/agent-worker.mjs', import.meta.url))

function taskRunner(taskName: string, script: string) {
  if (process.platform !== 'win32') throw new Error('Scheduled tasks are only supported on Windows')
  if (!taskName.trim() || taskName.length > 200 || /[\\/:*?"<>|[\]\x00-\x1f]/u.test(taskName)) {
    throw new Error('Invalid Windows task name')
  }
  return new Promise<void>((resolve, reject) => {
    execFile(powershell, psArgs('$name = ' + psLiteral(taskName) + '\n' + script),
      { windowsHide: true, shell: false, timeout: 20_000 }, (error, _stdout, stderr) => {
        if (error) reject(new Error('Windows Task Scheduler failed', { cause: stderr.trim() || error }))
        else resolve()
      })
  })
}

export function installTask(configPath: string, taskName = 'AgentWorker') {
  const workerArgs = '"' + entry + '" run --config "' + configPath + '"'
  const workingDirectory = psLiteral(dirname(configPath))
  const launch = [
    '$child = Start-Process -FilePath ' + psLiteral(process.execPath) + ' -ArgumentList ' + psLiteral(workerArgs) +
      ' -WorkingDirectory ' + workingDirectory + ' -WindowStyle Hidden -Wait -PassThru',
    'exit $child.ExitCode',
  ].join('\n')
  const actionArgs = psLiteral(['-WindowStyle', 'Hidden', ...psArgs(launch)].join(' '))
  return taskRunner(taskName, `
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$action = New-ScheduledTaskAction -Execute ${psLiteral(powershell)} -Argument ${actionArgs} -WorkingDirectory ${workingDirectory}
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Hidden -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    + '-ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries\n'
    + "Register-ScheduledTask -TaskName $name -TaskPath '\\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null")
}

export function uninstallTask(taskName = 'AgentWorker') {
  return taskRunner(taskName, `
$task = Get-ScheduledTask -TaskPath '\\' | Where-Object TaskName -eq $name
if ($null -ne $task) { Unregister-ScheduledTask -InputObject $task -Confirm:$false }
`)
}
