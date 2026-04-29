import { json, notFound, readJson, readResponseBody, trimTrailingSlash } from "./http";
import { runAgent } from "./agent";
import { getBridgeHealth, providerHealth } from "./providers";
import { executeToolCall, skills } from "./skills";
import type { ChatMessage, ChatRequest, Env, ToolCall } from "./types";

interface SessionRecord {
  messages: ChatMessage[];
}

const SESSION_MESSAGE_LIMIT = 12;

export class AgentSession {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET") {
      return json(await this.load());
    }

    if (request.method === "POST" && url.pathname.endsWith("/chat")) {
      const payload = await readJson<ChatRequest>(request);
      const record = await this.load();
      const history = record.messages.slice(-SESSION_MESSAGE_LIMIT);
      const messages = [...history, ...payload.messages];
      const result = await runAgent(this.env, { ...payload, messages });
      const assistantMessage: ChatMessage = { role: "assistant", content: result.text };
      const nextMessages: ChatMessage[] = [...messages, assistantMessage].slice(-SESSION_MESSAGE_LIMIT);
      await this.state.storage.put<SessionRecord>("record", { messages: nextMessages });
      return json({ ...result, messages: nextMessages });
    }

    return notFound();
  }

  private async load(): Promise<SessionRecord> {
    return (await this.state.storage.get<SessionRecord>("record")) ?? { messages: [] };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return json({});
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        const bridge = await getBridgeHealth(env);
        return json({
          ok: true,
          checkedAt: new Date().toISOString(),
          app: {
            name: "OpenClaw Cloud Agent",
            version: "0.2.0",
            mode: env.LOCAL_BRIDGE_URL ? "bridge-enabled" : "remote-only",
          },
          providers: providerHealth(env),
          bridge,
          skills: skills.map(({ name, title, enabled, risk, requiresApproval }) => ({
            name,
            title,
            enabled,
            risk,
            requiresApproval,
          })),
        });
      }

      if (url.pathname === "/api/runtime/ensure" && request.method === "POST") {
        if (!env.LOCAL_BRIDGE_URL || !env.AGENT_SHARED_SECRET) {
          return json({ error: "Local bridge is not configured" }, { status: 400 });
        }

        const response = await fetch(`${trimTrailingSlash(env.LOCAL_BRIDGE_URL)}/openclaw/ensure`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.AGENT_SHARED_SECRET}`,
          },
        });

        const payload = await readResponseBody(response);
        return json(payload, { status: response.status });
      }

      if (url.pathname === "/api/skills" && request.method === "GET") {
        return json({ skills });
      }

      if (url.pathname === "/api/chat" && request.method === "POST") {
        const body = await readJson<ChatRequest>(request);
        return json(await runAgent(env, body));
      }

      if (url.pathname === "/api/skills/run" && request.method === "POST") {
        return json(await executeToolCall(env, await readJson<ToolCall>(request)));
      }

      const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/chat)?$/.exec(url.pathname);
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        if (!/^[a-zA-Z0-9._-]{1,96}$/.test(sessionId)) {
          return json({ error: "Invalid session id" }, { status: 400 });
        }
        const durableId = env.AGENT_SESSIONS.idFromName(sessionId);
        return env.AGENT_SESSIONS.get(durableId).fetch(request);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      return json(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      );
    }
  },
};
