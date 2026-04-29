$ErrorActionPreference = "Stop"

$startupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
$runner = Join-Path $PSScriptRoot "start-bridge.ps1"
$launcherPath = Join-Path $startupDir "OpenClaw Local Bridge.cmd"

if (-not (Test-Path $runner)) {
  throw "Bridge runner not found: $runner"
}

@"
@echo off
powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File "$runner"
"@ | Set-Content -LiteralPath $launcherPath -Encoding ASCII

Start-Process -FilePath "powershell.exe" -ArgumentList "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", "`"$runner`""

Write-Host "Startup launcher installed: $launcherPath"
