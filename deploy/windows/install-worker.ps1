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
    throw 'worker.yaml is missing. Enroll this worker and configure its workspaces first.'
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
$configPath = (Resolve-Path -LiteralPath $Config).Path
& $cli @prefix doctor --config $configPath --check-hub
if ($LASTEXITCODE -ne 0) { throw 'Worker doctor failed. Review its JSON report.' }
& $cli @prefix install-task --config $configPath --task-name $TaskName
if ($LASTEXITCODE -ne 0) { throw 'Worker task registration change failed.' }
