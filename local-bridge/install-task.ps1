$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot "run-bridge.cmd"
$taskName = "OpenClaw Local Bridge"

if (-not (Test-Path $runner)) {
  throw "Bridge runner not found: $runner"
}

$escapedRunner = '"' + $runner + '"'

schtasks /Create /TN $taskName /SC ONLOGON /TR $escapedRunner /RL LIMITED /F | Out-Null
schtasks /Run /TN $taskName | Out-Null

Write-Host "Scheduled task installed: $taskName"
Write-Host "Runner: $runner"
