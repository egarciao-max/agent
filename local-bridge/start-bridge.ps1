$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $env:USERPROFILE ".openclaw\openclaw.json"

if (-not $env:BRIDGE_TOKEN) {
  $env:BRIDGE_TOKEN = "oc-dev-bridge-secret-2026"
}

if (-not $env:OPENCLAW_GATEWAY_URL) {
  $env:OPENCLAW_GATEWAY_URL = "http://127.0.0.1:18789"
}

if (-not $env:OLLAMA_URL) {
  $env:OLLAMA_URL = "http://127.0.0.1:11434"
}

if (-not $env:OPENCLAW_KEEPALIVE) {
  $env:OPENCLAW_KEEPALIVE = "false"
}

if (-not $env:OPENCLAW_KEEPALIVE_INTERVAL_MS) {
  $env:OPENCLAW_KEEPALIVE_INTERVAL_MS = "30000"
}

if (-not $env:SSH_ALLOWED_HOSTS) {
  $env:SSH_ALLOWED_HOSTS = "localhost,127.0.0.1"
}

if (-not $env:SSH_ALLOWED_COMMANDS) {
  $env:SSH_ALLOWED_COMMANDS = "whoami,hostname,pwd,ls,dir,git,node,npm"
}

if (-not $env:OPENCLAW_GATEWAY_TOKEN -and (Test-Path $configPath)) {
  try {
    $config = Get-Content -Raw $configPath | ConvertFrom-Json
    if ($config.gateway.auth.token) {
      $env:OPENCLAW_GATEWAY_TOKEN = [string]$config.gateway.auth.token
    }
  } catch {
  }
}

Start-Process -FilePath "node" -ArgumentList "local-bridge/server.mjs" -WorkingDirectory $repoRoot -WindowStyle Hidden
