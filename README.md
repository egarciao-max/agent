# OpenClaw Cloud Agent

Cloudflare Worker agent with:

- Ollama-first routing through local Ollama, `http://ollama.oropezas.com`, then Gemini fallback.
- Durable Object chat sessions.
- Static frontend served by the Worker.
- Skill registry for Ollama, SSH, OpenClaw gateway, and manifest-driven REST API integrations.
- Local bridge for this Windows PC so the deployed Worker can reach local Ollama, OpenClaw, and SSH without putting private services directly on the internet.

## Run Locally

```powershell
npm install
npm run dev
```

Open the Wrangler URL and use the chat UI.

## Local Bridge

The deployed Worker cannot reach `127.0.0.1` on this computer. Run the bridge locally and expose it through Cloudflare Tunnel or another private tunnel.

```powershell
$env:BRIDGE_TOKEN="replace-with-long-random-secret"
$env:OPENCLAW_GATEWAY_URL="http://127.0.0.1:18789"
$env:OLLAMA_URL="http://127.0.0.1:11434"
$env:SSH_ALLOWED_HOSTS="localhost,127.0.0.1"
$env:SSH_ALLOWED_COMMANDS="whoami,hostname,pwd,ls,dir,git,node,npm"
npm run bridge
```

Then expose `http://127.0.0.1:8789` with Cloudflare Tunnel and set the Worker secrets:

```powershell
npx wrangler secret put LOCAL_BRIDGE_URL
npx wrangler secret put AGENT_SHARED_SECRET
```

Use the tunnel URL for `LOCAL_BRIDGE_URL` and the same value as `BRIDGE_TOKEN` for `AGENT_SHARED_SECRET`.

## Provider Secrets

```powershell
npx wrangler secret put GEMINI_API_KEY
```

Optional overrides:

```powershell
npx wrangler secret put OLLAMA_LOCAL_URL
npx wrangler secret put OLLAMA_REMOTE_URL
npx wrangler secret put OLLAMA_MODEL
npx wrangler secret put GEMINI_MODEL
```

`OLLAMA_REMOTE_URL` defaults to `http://ollama.oropezas.com`. `GEMINI_MODEL` defaults to `gemini-3-flash-preview`.

## SSH To This Computer

Install and start Windows OpenSSH Server before using `ssh_exec` against `localhost`.

```powershell
Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*'
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
```

The bridge only runs commands listed in `SSH_ALLOWED_COMMANDS`, against hosts listed in `SSH_ALLOWED_HOSTS`. Set `ALLOW_AGENT_TOOL_EXECUTION=true` on the Worker only when you want the agent to execute approval-gated skills.

```powershell
npx wrangler secret put ALLOW_AGENT_TOOL_EXECUTION
```

## API Integrations

Create API manifests like `config.integrations.example.json`, then store them in `API_INTEGRATIONS_JSON`.

```powershell
$json = Get-Content -Raw .\config.integrations.example.json
$json | npx wrangler secret put API_INTEGRATIONS_JSON
npx wrangler secret put GITHUB_TOKEN
```

The `api_request` skill can call only configured integrations, methods, and paths. Add new providers by adding entries to the manifest and setting the referenced secrets.

## Deploy

```powershell
npm run deploy
```

## Important Boundaries

- No keys are committed.
- The Worker does not directly expose arbitrary shell execution.
- SSH and OpenClaw calls go through the local bridge with a bearer token and allowlists.
- Local Ollama on `127.0.0.1:11434` works from deployed Cloudflare only through the bridge/tunnel.
