const STORAGE_KEY = "openclaw-control-surface:v2";
const HEALTH_POLL_MS = 20000;

const state = {
  health: null,
  lastResult: null,
  installPrompt: null,
  online: navigator.onLine,
  loading: false,
};

const elements = {
  providerLine: document.querySelector("#provider-line"),
  subtitle: document.querySelector("#subtitle"),
  statusPill: document.querySelector("#status-pill"),
  runtimeCards: document.querySelector("#runtime-cards"),
  providers: document.querySelector("#providers"),
  skills: document.querySelector("#skills"),
  messages: document.querySelector("#messages"),
  composer: document.querySelector("#composer"),
  prompt: document.querySelector("#prompt"),
  send: document.querySelector("#send"),
  sessionId: document.querySelector("#session-id"),
  model: document.querySelector("#model"),
  autoTools: document.querySelector("#auto-tools"),
  activity: document.querySelector("#activity"),
  runtimeMeta: document.querySelector("#runtime-meta"),
  rawLog: document.querySelector("#raw-log"),
  installApp: document.querySelector("#install-app"),
  refreshHealth: document.querySelector("#refresh-health"),
  ensureRuntime: document.querySelector("#ensure-runtime"),
  toast: document.querySelector("#toast"),
};

restoreSettings();
applyQueryState();
initEvents();
registerSW();
await boot();

async function boot() {
  await Promise.all([refreshHealth(), loadSession()]);
  window.setInterval(() => {
    void refreshHealth({ silent: true });
  }, HEALTH_POLL_MS);
}

function initEvents() {
  elements.composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    await sendMessage();
  });

  elements.prompt.addEventListener("input", resizeTextarea);
  elements.prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      elements.composer.requestSubmit();
    }
  });

  for (const input of [elements.sessionId, elements.model, elements.autoTools]) {
    input.addEventListener("change", async () => {
      persistSettings();
      if (input === elements.sessionId) {
        await loadSession();
      }
    });
  }

  elements.refreshHealth.addEventListener("click", async () => {
    await Promise.all([refreshHealth(), loadSession()]);
    showToast("Runtime refreshed");
  });

  elements.ensureRuntime.addEventListener("click", async () => {
    await ensureRuntime();
  });

  elements.installApp.addEventListener("click", async () => {
    if (!state.installPrompt) return;
    await state.installPrompt.prompt();
    const outcome = await state.installPrompt.userChoice;
    if (outcome.outcome === "accepted") {
      showToast("PWA installation started");
    }
    state.installPrompt = null;
    updateInstallButton();
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event;
    updateInstallButton();
  });

  window.addEventListener("appinstalled", () => {
    state.installPrompt = null;
    updateInstallButton();
    showToast("PWA installed");
  });

  window.addEventListener("online", () => {
    state.online = true;
    updateConnectivity();
    void refreshHealth({ silent: true });
  });

  window.addEventListener("offline", () => {
    state.online = false;
    updateConnectivity();
  });
}

async function sendMessage() {
  const content = elements.prompt.value.trim();
  if (!content || state.loading) {
    return;
  }

  persistSettings();
  elements.prompt.value = "";
  resizeTextarea();
  setLoading(true);

  const optimisticMessages = currentMessages();
  optimisticMessages.push({ role: "user", content });
  renderMessages(optimisticMessages);

  try {
    const sessionId = encodeURIComponent(elements.sessionId.value.trim() || "main");
    const response = await fetch(`/api/sessions/${sessionId}/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content }],
        model: elements.model.value.trim() || undefined,
        autoExecuteTools: elements.autoTools.checked,
      }),
    });
    const body = await readJsonResponse(response);
    if (!response.ok || body.error) {
      throw new Error(body.error || `${response.status}`);
    }

    state.lastResult = body;
    renderMessages(body.messages || optimisticMessages);
    renderActivity(body);
    elements.rawLog.textContent = JSON.stringify(body, null, 2);
    await refreshHealth({ silent: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    renderMessages([...optimisticMessages, { role: "assistant", content: message, error: true }]);
    renderActivity({
      providerFailures: [{ provider: "ui", error: message }],
      toolCalls: [],
      toolResults: [],
      text: message,
    });
    showToast("Request failed");
  } finally {
    setLoading(false);
  }
}

async function loadSession() {
  const sessionId = encodeURIComponent(elements.sessionId.value.trim() || "main");
  try {
    const session = await getJson(`/api/sessions/${sessionId}`);
    renderMessages(session.messages || []);
  } catch (error) {
    renderEmptyState(error instanceof Error ? error.message : String(error));
  }
}

async function refreshHealth({ silent = false } = {}) {
  try {
    const health = await getJson("/api/health");
    state.health = health;
    renderHealth(health);
    updateConnectivity();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.health = { ok: false, error: message };
    renderHealth(state.health);
    updateConnectivity();
    if (!silent) {
      showToast("Health check failed");
    }
  }
}

async function ensureRuntime() {
  elements.ensureRuntime.disabled = true;
  try {
    const response = await fetch("/api/runtime/ensure", { method: "POST" });
    const body = await readJsonResponse(response);
    if (!response.ok || body.error) {
      throw new Error(body.error || `${response.status}`);
    }
    showToast("Runtime recovery requested");
    await refreshHealth();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  } finally {
    elements.ensureRuntime.disabled = false;
  }
}

function renderHealth(health) {
  const bridge = health.bridge;
  const openClawHealthy = bridge?.openClaw?.healthy === true;
  const ollamaHealthy = bridge?.ollama?.healthy === true;
  const geminiConfigured = health.providers?.geminiFallback === true;
  const runtimeHealthy = openClawHealthy || ollamaHealthy || geminiConfigured;

  elements.providerLine.textContent = runtimeHealthy
    ? "Runtime paths available"
    : "No healthy runtime path detected";
  elements.subtitle.textContent = bridge?.keepaliveEnabled
    ? `Bridge watchdog active every ${Math.round((bridge.keepaliveIntervalMs || 30000) / 1000)}s`
    : "Bridge watchdog not detected";

  elements.statusPill.className = `pill ${runtimeHealthy ? "ok" : "warn"}`;
  elements.statusPill.textContent = runtimeHealthy ? "Operational" : "Attention";

  elements.runtimeCards.innerHTML = "";
  appendRuntimeCard("OpenClaw Gateway", openClawHealthy, bridge?.openClaw?.lastError || "Waiting for bridge data");
  appendRuntimeCard(
    "Local Ollama",
    ollamaHealthy,
    bridge?.ollama?.models?.length ? bridge.ollama.models.join(", ") : bridge?.ollama?.lastError || "No models detected",
  );
  appendRuntimeCard("Gemini Fallback", geminiConfigured, geminiConfigured ? "Configured" : "Not configured");

  elements.providers.innerHTML = "";
  for (const [name, value] of Object.entries(health.providers || {})) {
    const item = document.createElement("div");
    item.className = `stack-item ${value === true ? "ok" : value === false ? "off" : "neutral"}`;
    item.innerHTML = `<strong>${escapeHtml(readableName(name))}</strong><span>${escapeHtml(String(value))}</span>`;
    elements.providers.append(item);
  }

  elements.skills.innerHTML = "";
  for (const skill of health.skills || []) {
    const item = document.createElement("div");
    item.className = `stack-item ${skill.risk === "high" ? "warn" : skill.enabled ? "ok" : "off"}`;
    item.innerHTML = `
      <strong>${escapeHtml(skill.title)}</strong>
      <span>${escapeHtml(skill.name)} | ${escapeHtml(skill.risk)}${skill.requiresApproval ? " | approval" : ""}</span>
    `;
    elements.skills.append(item);
  }

  renderRuntimeMeta(health);
  if (!state.lastResult) {
    renderActivity(null);
    elements.rawLog.textContent = JSON.stringify(health, null, 2);
  }
}

function appendRuntimeCard(title, healthy, detail) {
  const card = document.createElement("article");
  card.className = `runtime-card ${healthy ? "ok" : "warn"}`;
  card.innerHTML = `
    <div class="runtime-card-head">
      <strong>${escapeHtml(title)}</strong>
      <span class="mini-pill ${healthy ? "ok" : "warn"}">${healthy ? "Ready" : "Issue"}</span>
    </div>
    <p>${escapeHtml(detail || "No detail")}</p>
  `;
  elements.runtimeCards.append(card);
}

function renderRuntimeMeta(health) {
  const bridge = health.bridge || {};
  const items = [
    ["Mode", health.app?.mode || "unknown"],
    ["Checked", formatDateTime(health.checkedAt)],
    ["Bridge Started", formatDateTime(bridge.startedAt)],
    ["Keepalive", bridge.keepaliveEnabled ? `Every ${Math.round((bridge.keepaliveIntervalMs || 30000) / 1000)}s` : "Disabled"],
    ["OpenClaw Last Healthy", formatDateTime(bridge.openClaw?.lastHealthyAt)],
    ["Ollama Last Healthy", formatDateTime(bridge.ollama?.lastHealthyAt)],
  ];

  elements.runtimeMeta.innerHTML = "";
  for (const [label, value] of items) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value || "n/a";
    elements.runtimeMeta.append(dt, dd);
  }
}

function renderActivity(result) {
  const providerFailures = result?.providerFailures || [];
  const toolCalls = result?.toolCalls || [];
  const toolResults = result?.toolResults || [];
  const items = [
    {
      title: "Last Provider",
      detail: result?.provider ? `${result.provider} / ${result.model}` : "No assistant response yet",
      state: result?.provider ? "ok" : "neutral",
    },
    {
      title: "Tool Calls",
      detail: toolCalls.length ? toolCalls.map((call) => call.skill).join(", ") : "None",
      state: toolCalls.length ? "warn" : "neutral",
    },
    {
      title: "Tool Results",
      detail: toolResults.length ? `${toolResults.filter((item) => item.ok).length}/${toolResults.length} succeeded` : "No tool execution",
      state: toolResults.some((item) => item.ok === false) ? "warn" : "ok",
    },
    {
      title: "Provider Failures",
      detail: providerFailures.length ? providerFailures.map((item) => `${item.provider}: ${item.error}`).join(" | ") : "None",
      state: providerFailures.length ? "warn" : "ok",
    },
  ];

  elements.activity.innerHTML = "";
  for (const item of items) {
    const row = document.createElement("div");
    row.className = `stack-item ${item.state}`;
    row.innerHTML = `<strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail)}</span>`;
    elements.activity.append(row);
  }
}

function renderMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    renderEmptyState();
    return;
  }

  elements.messages.innerHTML = "";
  const latestAssistantIndex = findLatestAssistantIndex(messages);

  messages.forEach((message, index) => {
    const article = document.createElement("article");
    article.className = `message ${message.error ? "error" : message.role}`;

    const header = document.createElement("div");
    header.className = "message-header";
    header.textContent = message.role === "assistant" ? "Agent" : message.role === "user" ? "You" : readableName(message.role);

    if (message.role === "assistant" && index === latestAssistantIndex && state.lastResult?.provider) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = `${state.lastResult.provider} / ${state.lastResult.model}`;
      header.append(badge);
    }

    const body = document.createElement("div");
    body.className = "message-body";
    body.innerHTML = renderMarkdown(message.content || "");
    wireCopyButtons(body);

    article.append(header, body);
    elements.messages.append(article);
  });

  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function renderEmptyState(detail = "Start a session with a message.") {
  elements.messages.innerHTML = `
    <section class="empty-state">
      <strong>Ready for a new task</strong>
      <p>${escapeHtml(detail)}</p>
    </section>
  `;
}

function setLoading(loading) {
  state.loading = loading;
  elements.send.disabled = loading;
  elements.prompt.disabled = loading;
  document.querySelector("#typing")?.remove();

  if (!loading) {
    elements.prompt.focus();
    return;
  }

  const typing = document.createElement("article");
  typing.id = "typing";
  typing.className = "message assistant";
  typing.innerHTML = `
    <div class="message-header">Agent <span class="badge">working</span></div>
    <div class="typing">
      <span></span>
      <span></span>
      <span></span>
    </div>
  `;
  elements.messages.append(typing);
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function currentMessages() {
  const messages = [];
  elements.messages.querySelectorAll(".message").forEach((node) => {
    if (node.id === "typing") return;
    const roleText = node.querySelector(".message-header")?.childNodes?.[0]?.textContent?.trim() || "assistant";
    const role = roleText === "You" ? "user" : roleText === "Agent" ? "assistant" : "assistant";
    const content = node.querySelector(".message-body")?.textContent || "";
    messages.push({ role, content });
  });
  return messages;
}

function updateConnectivity() {
  if (!state.online) {
    elements.statusPill.className = "pill warn";
    elements.statusPill.textContent = "Offline";
    return;
  }

  if (!state.health?.ok) {
    elements.statusPill.className = "pill warn";
    elements.statusPill.textContent = "Attention";
  }
}

function updateInstallButton() {
  elements.installApp.hidden = !state.installPrompt;
}

function restoreSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (stored.sessionId) elements.sessionId.value = stored.sessionId;
    if (stored.model) elements.model.value = stored.model;
    elements.autoTools.checked = Boolean(stored.autoTools);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

function applyQueryState() {
  const params = new URLSearchParams(window.location.search);
  const session = params.get("session");
  if (session) {
    elements.sessionId.value = session.slice(0, 96);
  }
}

function persistSettings() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      sessionId: elements.sessionId.value.trim() || "main",
      model: elements.model.value.trim() || "qwen3.5:9b",
      autoTools: elements.autoTools.checked,
    }),
  );
}

function resizeTextarea() {
  elements.prompt.style.height = "auto";
  elements.prompt.style.height = `${Math.min(elements.prompt.scrollHeight, 220)}px`;
}

function renderMarkdown(text) {
  let html = escapeHtml(text);

  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const label = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : "";
    return `<div class="code-block">${label}<button class="copy-btn" type="button">Copy</button><pre><code>${escapeHtml(code.trim())}</code></pre></div>`;
  });
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/^[-*]\s+(.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*?<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);

  return html
    .split(/\n\n+/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("<")) return trimmed;
      return `<p>${trimmed.replace(/\n/g, "<br />")}</p>`;
    })
    .join("");
}

function wireCopyButtons(container) {
  container.querySelectorAll(".copy-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      const code = button.nextElementSibling?.textContent || "";
      try {
        await navigator.clipboard.writeText(code);
        showToast("Copied");
      } catch {
        showToast("Copy failed");
      }
    });
  });
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    elements.toast.classList.remove("visible");
  }, 2200);
}

function readableName(value) {
  return String(value)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDateTime(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function findLatestAssistantIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant") {
      return index;
    }
  }
  return -1;
}

async function getJson(url) {
  const response = await fetch(url);
  const body = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(body.error || `${response.status}`);
  }
  return body;
}

async function readJsonResponse(response) {
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";

  if (!text) {
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return {};
  }

  if (!contentType.includes("application/json")) {
    throw new Error(
      `${response.status} ${response.statusText}: expected JSON but received ${contentType || "unknown"}: ${snippet(text)}`,
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${response.status} ${response.statusText}: invalid JSON response from server: ${snippet(text)}`,
    );
  }
}

function registerSW() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function snippet(value) {
  return String(value).replace(/\s+/g, " ").trim().slice(0, 240);
}
