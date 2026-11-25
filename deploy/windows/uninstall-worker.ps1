[CmdletBinding()]
param(
    [string]$Config = (Join-Path $env:APPDATA 'agent-worker\worker.yaml'),
    [string]$TaskName = 'AgentWorker'
)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
$version = & $node -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [version]$version -lt [version]'22.12.0') {
    throw 'Node.js 22.12.0 or later is required.'
}
if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) {
    Write-Warning 'worker.yaml is missing. Removing the scheduled task by name.'
}

# Prefer the built checkout containing this script. The task records absolute paths.
$entry = Join-Path $PSScriptRoot '..\..\packages\worker\bin\agent-worker.mjs'
if (Test-Path -LiteralPath $entry -PathType Leaf) {
    $cli = $node
    $prefix = @((Resolve-Path -LiteralPath $entry).Path)
} else {
    $cli = (Get-Command agent-worker.cmd -CommandType Application -ErrorAction Stop).Source
    $prefix = @()
}
& $cli @prefix uninstall-task --task-name $TaskName
if ($LASTEXITCODE -ne 0) { throw 'Worker task registration change failed.' }
