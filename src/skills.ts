import { boolFromEnv, readResponseBody, responseError, trimTrailingSlash, withTimeout } from "./http";
import type { Env, SkillDefinition, ToolCall, ToolResult } from "./types";

export const skills: SkillDefinition[] = [
  {
    name: "ollama_chat",
    title: "Ollama Chat",
    description: "Send a direct chat request to local or remote Ollama.",
    risk: "low",
    enabled: true,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        messages: { type: "array" },
        model: { type: "string" },
      },
      required: ["messages"],
    },
  },
  {
    name: "ssh_exec",
    title: "SSH Exec",
    description: "Run an allowlisted SSH command through the local bridge.",
    risk: "high",
    enabled: true,
    requiresApproval: true,
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        user: { type: "string" },
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["host", "command"],
    },
  },
  {
    name: "openclaw_gateway",
    title: "OpenClaw Gateway",
    description: "Call an OpenClaw gateway endpoint through the local bridge or configured URL.",
    risk: "medium",
    enabled: true,
    requiresApproval: true,
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string" },
        path: { type: "string" },
        body: { type: "object" },
      },
      required: ["method", "path"],
    },
  },
  {
    name: "api_request",
    title: "API Request",
    description: "Call a configured REST API integration from API_INTEGRATIONS_JSON.",
    risk: "medium",
    enabled: true,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        integration: { type: "string" },
        method: { type: "string" },
        path: { type: "string" },
        query: { type: "object" },
        body: { type: "object" },
      },
      required: ["integration", "method", "path"],
    },
  },
];

export async function executeToolCall(env: Env, toolCall: ToolCall): Promise<ToolResult> {
  const definition = skills.find((skill) => skill.name === toolCall.skill && skill.enabled);
  if (!definition) {
    return { skill: toolCall.skill, ok: false, error: "Unknown or disabled skill" };
  }

  if (definition.requiresApproval && !boolFromEnv(env.ALLOW_AGENT_TOOL_EXECUTION)) {
    return {
      skill: toolCall.skill,
      ok: false,
      error: "Skill requires ALLOW_AGENT_TOOL_EXECUTION=true before it can run",
    };
  }

  try {
    switch (toolCall.skill) {
      case "ssh_exec":
        return { skill: toolCall.skill, ok: true, output: await runSsh(env, toolCall.input) };
      case "openclaw_gateway":
        return { skill: toolCall.skill, ok: true, output: await callOpenClaw(env, toolCall.input) };
      case "api_request":
        return { skill: toolCall.skill, ok: true, output: await callConfiguredApi(env, toolCall.input) };
      case "ollama_chat":
        return { skill: toolCall.skill, ok: true, output: await callBridgeOllama(env, toolCall.input) };
      default:
        return { skill: toolCall.skill, ok: false, error: "Skill is not implemented" };
    }
  } catch (error) {
    return {
      skill: toolCall.skill,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runSsh(env: Env, input: Record<string, unknown>): Promise<unknown> {
  const bridgeUrl = requireString(env.LOCAL_BRIDGE_URL, "LOCAL_BRIDGE_URL");
  const secret = requireString(env.AGENT_SHARED_SECRET, "AGENT_SHARED_SECRET");
  return postJson(`${trimTrailingSlash(bridgeUrl)}/ssh/exec`, input, secret);
}

async function callBridgeOllama(env: Env, input: Record<string, unknown>): Promise<unknown> {
  if (env.LOCAL_BRIDGE_URL) {
    return postJson(`${trimTrailingSlash(env.LOCAL_BRIDGE_URL)}/ollama/api/chat`, input, env.AGENT_SHARED_SECRET);
  }

  const baseUrl = requireString(env.OLLAMA_REMOTE_URL, "OLLAMA_REMOTE_URL");
  return postJson(`${trimTrailingSlash(baseUrl)}/api/chat`, input);
}

async function callOpenClaw(env: Env, input: Record<string, unknown>): Promise<unknown> {
  const method = String(input.method ?? "GET").toUpperCase();
  const path = normalizePath(String(input.path ?? "/"));

  if (env.LOCAL_BRIDGE_URL) {
    const secret = requireString(env.AGENT_SHARED_SECRET, "AGENT_SHARED_SECRET");
    return postJson(
      `${trimTrailingSlash(env.LOCAL_BRIDGE_URL)}/openclaw`,
      {
        method,
        path,
        body: input.body,
      },
      secret,
    );
  }

  const gatewayUrl = requireString(env.OPENCLAW_GATEWAY_URL, "OPENCLAW_GATEWAY_URL");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.OPENCLAW_GATEWAY_TOKEN) {
    headers.authorization = `Bearer ${env.OPENCLAW_GATEWAY_TOKEN}`;
  }

  const response = await fetch(`${trimTrailingSlash(gatewayUrl)}${path}`, {
    method,
    signal: withTimeout(30_000),
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(input.body ?? {}),
  });
  return responsePayload(response);
}

async function callConfiguredApi(env: Env, input: Record<string, unknown>): Promise<unknown> {
  const integrations = parseIntegrations(env.API_INTEGRATIONS_JSON);
  const integrationName = String(input.integration ?? "");
  const integration = integrations[integrationName];
  if (!integration) {
    throw new Error(`Unknown integration: ${integrationName}`);
  }

  const method = String(input.method ?? "GET").toUpperCase();
  if (integration.allowedMethods && !integration.allowedMethods.includes(method)) {
    throw new Error(`Method ${method} is not allowed for ${integrationName}`);
  }

  const path = normalizePath(String(input.path ?? "/"));
  if (!pathAllowed(path, integration.allowedPaths ?? ["/"])) {
    throw new Error(`Path ${path} is not allowed for ${integrationName}`);
  }

  const url = new URL(`${trimTrailingSlash(integration.baseUrl)}${path}`);
  const query = isRecord(input.query) ? input.query : {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = resolveHeaders(env, integration.headers ?? {});
  if (method !== "GET" && method !== "HEAD") {
    headers["content-type"] ??= "application/json";
  }

  const response = await fetch(url, {
    method,
    signal: withTimeout(30_000),
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(input.body ?? {}),
  });

  return responsePayload(response);
}

async function postJson(url: string, body: unknown, bearerToken?: string): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    signal: withTimeout(30_000),
    headers: {
      "content-type": "application/json",
      ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return responsePayload(response);
}

async function responsePayload(response: Response): Promise<unknown> {
  const payload = await readResponseBody(response);
  if (!response.ok) {
    throw responseError(response, payload);
  }
  return payload;
}

function requireString(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

function normalizePath(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error("Path must start with /");
  }
  if (path.includes("..")) {
    throw new Error("Path must not contain ..");
  }
  return path;
}

function pathAllowed(path: string, allowedPaths: string[]): boolean {
  return allowedPaths.some((pattern) => {
    if (pattern === "*" || pattern === "/*") return true;
    if (pattern.endsWith("*")) return path.startsWith(pattern.slice(0, -1));
    return path === pattern;
  });
}

interface ApiIntegration {
  baseUrl: string;
  allowedMethods?: string[];
  allowedPaths?: string[];
  headers?: Record<string, string | { env: string; prefix?: string }>;
}

function parseIntegrations(value: string | undefined): Record<string, ApiIntegration> {
  if (!value) return {};
  const parsed = JSON.parse(value) as Record<string, ApiIntegration>;
  for (const [name, integration] of Object.entries(parsed)) {
    if (!integration.baseUrl) {
      throw new Error(`Integration ${name} is missing baseUrl`);
    }
  }
  return parsed;
}

function resolveHeaders(env: Env, headers: Record<string, string | { env: string; prefix?: string }>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      resolved[key] = value;
      continue;
    }

    const secret = env[value.env];
    if (typeof secret !== "string" || !secret) {
      throw new Error(`Missing secret for header ${key}: ${value.env}`);
    }
    resolved[key] = `${value.prefix ?? ""}${secret}`;
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
