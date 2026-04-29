@echo off
setlocal
cd /d "%~dp0.."

if not defined BRIDGE_TOKEN set "BRIDGE_TOKEN=oc-dev-bridge-secret-2026"
if not defined OPENCLAW_GATEWAY_URL set "OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789"
if not defined OPENCLAW_GATEWAY_TOKEN for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$cfg = Join-Path $env:USERPROFILE '.openclaw\\openclaw.json'; if (Test-Path $cfg) { try { (Get-Content -Raw $cfg | ConvertFrom-Json).gateway.auth.token } catch {} }"`) do set "OPENCLAW_GATEWAY_TOKEN=%%i"
if not defined OLLAMA_URL set "OLLAMA_URL=http://127.0.0.1:11434"
if not defined OPENCLAW_KEEPALIVE set "OPENCLAW_KEEPALIVE=false"
if not defined OPENCLAW_KEEPALIVE_INTERVAL_MS set "OPENCLAW_KEEPALIVE_INTERVAL_MS=30000"
if not defined SSH_ALLOWED_HOSTS set "SSH_ALLOWED_HOSTS=localhost,127.0.0.1"
if not defined SSH_ALLOWED_COMMANDS set "SSH_ALLOWED_COMMANDS=whoami,hostname,pwd,ls,dir,git,node,npm,cd,echo,type,cat,less,more,tail,head,find,grep,awk,sed,sort,uniq,wc,cut,tr,df,du,free,uptime,ps,top,tasklist,netstat,ipconfig,ifconfig,ping,tracert,nslookup,dig,curl,wget,ssh"

"C:\Program Files\nodejs\node.exe" local-bridge\server.mjs
