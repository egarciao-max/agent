import http from "node:http";
import { spawn } from "node:child_process";

const port = Number(process.env.PORT || 8789);
const token = process.env.BRIDGE_TOKEN || "";
const ollamaUrl = trim(process.env.OLLAMA_URL || "http://127.0.0.1:11434");
const openClawUrl = trim(process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789");
const openClawToken = process.env.OPENCLAW_GATEWAY_TOKEN || "";
const keepaliveEnabled = !matchesFalse(process.env.OPENCLAW_KEEPALIVE);
const keepaliveIntervalMs = Math.max(10_000, Number(process.env.OPENCLAW_KEEPALIVE_INTERVAL_MS || 30_000));
const allowedHosts = new Set(split(process.env.SSH_ALLOWED_HOSTS || "localhost,127.0.0.1"));
const allowedCommands = new Set(split(process.env.SSH_ALLOWED_COMMANDS || "whoami,hostname,pwd,ls,dir,git,node,npm"));

const state = {
  startedAt: new Date().toISOString(),
  keepaliveEnabled,
  keepaliveIntervalMs,
  openClaw: {
    healthy: false,
    lastCheckAt: null,
    lastHealthyAt: null,
    lastActionAt: null,
    lastAction: null,
    lastError: null,
    consecutiveFailures: 0,
    inFlight: false,
  },
  ollama: {
    healthy: false,
    lastCheckAt: null,
    lastHealthyAt: null,
    lastError: null,
    models: [],
  },
};

const server = http.createServer(async (request, response) => {
  try {
    if (!authorized(request)) {
      return send(response, 401, { error: "Unauthorized" });
    }

    if (request.method === "GET" && request.url === "/health") {
      void refreshBridgeState({ ensureOpenClaw: false, reason: "health-request" });
      return send(response, 200, bridgeHealthPayload());
    }

    if (request.method === "POST" && request.url === "/ssh/exec") {
      return send(response, 200, await runSsh(await readBody(request)));
    }

    if (request.method === "POST" && request.url === "/ollama/api/chat") {
      return proxyJson(response, `${ollamaUrl}/api/chat`, await readBody(request));
    }

    if (request.method === "POST" && request.url === "/openclaw") {
      return proxyOpenClaw(response, await readBody(request));
    }

    if (request.method === "POST" && request.url === "/openclaw/ensure") {
      await ensureOpenClawHealthy("manual");
      await refreshBridgeState({ ensureOpenClaw: false, reason: "manual-ensure" });
      return send(response, 200, bridgeHealthPayload());
    }

    return send(response, 404, { error: "Not found" });
  } catch (error) {
    return send(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`OpenClaw local bridge listening on http://127.0.0.1:${port}`);
  void refreshBridgeState({ ensureOpenClaw: keepaliveEnabled, reason: "startup" });
  if (keepaliveEnabled) {
    const timer = setInterval(() => {
      void refreshBridgeState({ ensureOpenClaw: true, reason: "interval" });
    }, keepaliveIntervalMs);
    timer.unref?.();
  }
});

function authorized(request) {
  if (!token) return false;
  return request.headers.authorization === `Bearer ${token}`;
}

async function refreshBridgeState({ ensureOpenClaw, reason }) {
  await Promise.all([
    refreshOpenClawState(ensureOpenClaw, reason),
    refreshOllamaState(),
  ]);
}

async function refreshOpenClawState(ensureOpenClaw, reason) {
  state.openClaw.lastCheckAt = new Date().toISOString();
  const health = await getJson(`${openClawUrl}/health`, 15_000, 2, openClawHeaders());

  if (health?.ok === true) {
    state.openClaw.healthy = true;
    state.openClaw.lastHealthyAt = new Date().toISOString();
    state.openClaw.consecutiveFailures = 0;
    state.openClaw.lastError = null;
    return;
  }

  state.openClaw.healthy = false;
  state.openClaw.consecutiveFailures += 1;
  state.openClaw.lastError = health?.error || "OpenClaw health probe failed";

  if (ensureOpenClaw && state.openClaw.consecutiveFailures >= 2) {
    await ensureOpenClawHealthy(reason);
  }
}

async function refreshOllamaState() {
  state.ollama.lastCheckAt = new Date().toISOString();
  const health = await getJson(`${ollamaUrl}/api/tags`, 8_000, 1);

  if (Array.isArray(health?.models)) {
    state.ollama.healthy = true;
    state.ollama.lastHealthyAt = new Date().toISOString();
    state.ollama.lastError = null;
    state.ollama.models = health.models.map((model) => model?.name).filter(Boolean);
    return;
  }

  state.ollama.healthy = false;
  state.ollama.lastError = health?.error || "Ollama health probe failed";
}

async function ensureOpenClawHealthy(reason) {
  if (state.openClaw.inFlight) {
    return;
  }

  state.openClaw.inFlight = true;
  try {
    state.openClaw.lastAction = "start";
    state.openClaw.lastActionAt = new Date().toISOString();
    await runProcess("cmd.exe", ["/d", "/s", "/c", "openclaw gateway start"], 45_000, true);

    if (await waitForHealthy(() => isOpenClawHealthy(), 30_000, 1_500)) {
      state.openClaw.healthy = true;
      state.openClaw.lastHealthyAt = new Date().toISOString();
      state.openClaw.consecutiveFailures = 0;
      state.openClaw.lastError = null;
      return;
    }

    state.openClaw.lastAction = "restart";
    state.openClaw.lastActionAt = new Date().toISOString();
    await runProcess("cmd.exe", ["/d", "/s", "/c", "openclaw gateway restart"], 60_000, true);

    if (await waitForHealthy(() => isOpenClawHealthy(), 35_000, 1_500)) {
      state.openClaw.healthy = true;
      state.openClaw.lastHealthyAt = new Date().toISOString();
      state.openClaw.consecutiveFailures = 0;
      state.openClaw.lastError = null;
      return;
    }

    state.openClaw.healthy = false;
    state.openClaw.lastError = `OpenClaw did not recover after ${reason}`;
  } catch (error) {
    state.openClaw.healthy = false;
    state.openClaw.lastError = error instanceof Error ? error.message : String(error);
  } finally {
    state.openClaw.inFlight = false;
  }
}

async function isOpenClawHealthy() {
  const health = await getJson(`${openClawUrl}/health`, 15_000, 2, openClawHeaders());
  return health?.ok === true;
}

async function proxyOpenClaw(response, input) {
  const method = String(input.method || "GET").toUpperCase();
  const path = normalizePath(String(input.path || "/"));
  const headers = { "content-type": "application/json" };
  if (openClawToken) {
    headers.authorization = `Bearer ${openClawToken}`;
  }
  const upstream = await fetch(`${openClawUrl}${path}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(input.body || {}),
  });
  const text = await upstream.text();
  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") || "text/plain; charset=utf-8",
  });
  response.end(text);
}

async function runSsh(input) {
  const host = String(input.host || "localhost");
  const user = input.user ? String(input.user) : "";
  const command = String(input.command || "");
  const args = Array.isArray(input.args) ? input.args.map(String) : [];

  if (!allowedHosts.has(host)) {
    throw new Error(`Host is not allowlisted: ${host}`);
  }

  const baseCommand = command.split(/\s+/)[0];
  if (!allowedCommands.has(baseCommand)) {
    throw new Error(`Command is not allowlisted: ${baseCommand}`);
  }

  const destination = user ? `${user}@${host}` : host;
  const remoteCommand = [command, ...args.map(shellQuote)].join(" ");
  const sshArgs = [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    destination,
    remoteCommand,
  ];

  const result = await runProcess("ssh", sshArgs, 30_000);
  return {
    host,
    command: remoteCommand,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function proxyJson(response, url, body) {
  const upstream = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await upstream.text();
  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
  });
  response.end(text);
}

function runProcess(command, args, timeoutMs, ignoreExitCode = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (!ignoreExitCode && exitCode !== 0) {
        reject(new Error(`${command} exited with code ${exitCode}: ${stderr || stdout}`.trim()));
        return;
      }
      resolve({ exitCode, stdout, stderr });
    });
  });
}

async function getJson(url, timeoutMs = 5_000, retries = 0, headers = undefined) {
  let lastError = "Unknown error";

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers,
      });
      const contentType = response.headers.get("content-type") || "";
      const body = contentType.includes("application/json") ? await response.json() : await response.text();
      if (!response.ok) {
        lastError = typeof body === "string" ? body : JSON.stringify(body);
      } else {
        return body;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (attempt < retries) {
      await delay(600);
    }
  }

  return { ok: false, error: lastError };
}

function openClawHeaders() {
  return openClawToken ? { authorization: `Bearer ${openClawToken}` } : undefined;
}

async function waitForHealthy(check, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return true;
    }
    await delay(intervalMs);
  }
  return false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function bridgeHealthPayload() {
  return {
    ok: true,
    startedAt: state.startedAt,
    keepaliveEnabled: state.keepaliveEnabled,
    keepaliveIntervalMs: state.keepaliveIntervalMs,
    openClawUrl,
    ollamaUrl,
    openClaw: { ...state.openClaw },
    ollama: { ...state.ollama },
    allowedHosts: [...allowedHosts],
    allowedCommands: [...allowedCommands],
  };
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

function split(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function trim(value) {
  return value.replace(/\/+$/, "");
}

function normalizePath(path) {
  if (!path.startsWith("/")) throw new Error("Path must start with /");
  if (path.includes("..")) throw new Error("Path must not contain ..");
  return path;
}

function shellQuote(value) {
  if (/^[a-zA-Z0-9_./:@=-]+$/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

function matchesFalse(value) {
  return value === "0" || value?.toLowerCase() === "false" || value?.toLowerCase() === "no";
}
