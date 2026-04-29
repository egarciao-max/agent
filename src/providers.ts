import type { BridgeHealth, ChatMessage, Env, ProviderFailure, ProviderResult } from "./types";
import { readResponseBody, responseError, trimTrailingSlash, withTimeout } from "./http";

interface ProviderCandidate {
  name: string;
  type: "ollama" | "gemini";
  model: string;
  url: string;
  bearerToken?: string;
  apiKey?: string;
}

interface CompleteOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export async function completeWithFallback(
  env: Env,
  messages: ChatMessage[],
  options: CompleteOptions = {},
): Promise<{ result: ProviderResult; failures: ProviderFailure[] }> {
  const failures: ProviderFailure[] = [];
  const candidates = providerCandidates(env, options.model);

  if (candidates.length === 0) {
    throw new Error("No model providers are configured");
  }

  for (const candidate of candidates) {
    try {
      console.log(`Trying candidate: ${candidate.name} (${candidate.url})`);
      const result =
        candidate.type === "ollama"
          ? await ollamaChat(candidate, messages, options)
          : await geminiChat(candidate, messages, options);
      console.log(`Success with: ${candidate.name}`);
      return { result, failures };
    } catch (error) {
      console.error(`Failure with: ${candidate.name}`, error);
      failures.push({
        provider: candidate.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw new Error(`All model providers failed: ${failures.map((item) => `${item.provider}: ${item.error}`).join("; ")}`);
}

export function providerHealth(env: Env): Record<string, unknown> {
  return {
    openclawGatewayConfigured: Boolean(env.OPENCLAW_GATEWAY_URL),
    localBridgeConfigured: Boolean(env.LOCAL_BRIDGE_URL),
    localBridgeSecured: Boolean(env.LOCAL_BRIDGE_URL && env.AGENT_SHARED_SECRET),
    ollamaLocalDirect: Boolean(env.OLLAMA_LOCAL_URL),
    ollamaRemote: Boolean(env.OLLAMA_REMOTE_URL),
    geminiFallback: Boolean(env.GEMINI_API_KEY),
    defaultOllamaModel: env.OLLAMA_MODEL ?? "qwen3.5:9b",
    defaultGeminiModel: env.GEMINI_MODEL ?? "gemini-3-flash-preview",
  };
}

export async function getBridgeHealth(env: Env): Promise<BridgeHealth | null> {
  if (!env.LOCAL_BRIDGE_URL || !env.AGENT_SHARED_SECRET) {
    return null;
  }

  try {
    const response = await fetch(`${trimTrailingSlash(env.LOCAL_BRIDGE_URL)}/health`, {
      method: "GET",
      signal: withTimeout(8_000),
      headers: {
        authorization: `Bearer ${env.AGENT_SHARED_SECRET}`,
      },
    });

    if (!response.ok) {
      return {
        ok: false,
        error: `${response.status} ${await response.text()}`,
      };
    }

    const payload = await readResponseBody(response);
    if (!response.ok) {
      return {
        ok: false,
        error: responseError(response, payload).message,
      };
    }
    return payload as BridgeHealth;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function providerCandidates(env: Env, requestedModel?: string): ProviderCandidate[] {
  const ollamaModel = requestedModel || env.OLLAMA_MODEL || "qwen3.5:9b";
  const candidates: ProviderCandidate[] = [];

  if (env.OLLAMA_LOCAL_URL) {
    candidates.push({
      name: "ollama-local-direct",
      type: "ollama",
      model: ollamaModel,
      url: chatUrl(env.OLLAMA_LOCAL_URL),
    });
  }

  if (env.LOCAL_BRIDGE_URL) {
    candidates.push({
      name: "ollama-local-bridge",
      type: "ollama",
      model: ollamaModel,
      url: `${trimTrailingSlash(env.LOCAL_BRIDGE_URL)}/ollama/api/chat`,
      bearerToken: env.AGENT_SHARED_SECRET,
    });
  }

  if (env.OLLAMA_REMOTE_URL) {
    candidates.push({
      name: "ollama-remote",
      type: "ollama",
      model: ollamaModel,
      url: chatUrl(env.OLLAMA_REMOTE_URL),
    });
  }

  if (env.GEMINI_API_KEY) {
    const model = requestedModel?.startsWith("gemini-") ? requestedModel : env.GEMINI_MODEL || "gemini-3-flash-preview";
    candidates.push({
      name: "gemini",
      type: "gemini",
      model,
      apiKey: env.GEMINI_API_KEY,
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    });
  }

  return candidates;
}

function chatUrl(baseOrUrl: string): string {
  const trimmed = trimTrailingSlash(baseOrUrl);
  return trimmed.endsWith("/api/chat") ? trimmed : `${trimmed}/api/chat`;
}

async function ollamaChat(
  candidate: ProviderCandidate,
  messages: ChatMessage[],
  options: CompleteOptions,
): Promise<ProviderResult> {
  const payload = {
    model: candidate.model,
    messages: messages.map((message) => ({
      role: message.role === "tool" ? "user" : message.role,
      content: message.content,
    })),
    stream: false,
    think: false,
    options: {
      temperature: options.temperature ?? 0.2,
      num_predict: options.maxTokens ?? 1024,
      num_ctx: 4096,
    },
  };

  const response = await fetch(candidate.url, {
    method: "POST",
    signal: withTimeout(60_000),
    headers: {
      "content-type": "application/json",
      ...(candidate.bearerToken ? { authorization: `Bearer ${candidate.bearerToken}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  const body = await readResponseBody(response);
  if (!response.ok) {
    if ((response.status === 404 || response.status === 405) && candidate.url.endsWith("/api/chat")) {
      return ollamaGenerate(candidate, messages, options);
    }
    throw responseError(response, body);
  }
  if (!body || typeof body !== "object") {
    throw new Error(`Expected JSON object from ${candidate.name}, received ${typeof body === "string" ? "text/html or text response" : "empty body"}`);
  }
  const parsed = body as {
    message?: { content?: string };
    response?: string;
  };
  const text = parsed.message?.content ?? parsed.response ?? "";
  if (!text) {
    throw new Error("Ollama returned an empty response");
  }

  return {
    provider: candidate.name,
    model: candidate.model,
    text,
    raw: parsed,
  };
}

async function ollamaGenerate(
  candidate: ProviderCandidate,
  messages: ChatMessage[],
  options: CompleteOptions,
): Promise<ProviderResult> {
  const url = candidate.url.replace(/\/api\/chat$/, "/api/generate");
  const response = await fetch(url, {
    method: "POST",
    signal: withTimeout(60_000),
    headers: {
      "content-type": "application/json",
      ...(candidate.bearerToken ? { authorization: `Bearer ${candidate.bearerToken}` } : {}),
    },
    body: JSON.stringify({
      model: candidate.model,
      prompt: toTranscript(messages),
      stream: false,
      think: false,
      options: {
        temperature: options.temperature ?? 0.2,
        num_predict: options.maxTokens ?? 1024,
        num_ctx: 4096,
      },
    }),
  });

  const body = await readResponseBody(response);
  if (!response.ok) {
    throw responseError(response, body);
  }
  if (!body || typeof body !== "object") {
    throw new Error(`Expected JSON object from ${candidate.name}-generate, received ${typeof body === "string" ? "text/html or text response" : "empty body"}`);
  }
  const parsed = body as {
    response?: string;
  };
  const text = parsed.response ?? "";
  if (!text) {
    throw new Error("Ollama generate returned an empty response");
  }

  return {
    provider: `${candidate.name}-generate`,
    model: candidate.model,
    text,
    raw: parsed,
  };
}

async function geminiChat(
  candidate: ProviderCandidate,
  messages: ChatMessage[],
  options: CompleteOptions,
): Promise<ProviderResult> {
  if (!candidate.apiKey) {
    throw new Error("Gemini API key is missing");
  }

  const systemInstruction = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const contents = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    }));

  const response = await fetch(candidate.url, {
    method: "POST",
    signal: withTimeout(60_000),
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": candidate.apiKey,
    },
    body: JSON.stringify({
      ...(systemInstruction ? { system_instruction: { parts: [{ text: systemInstruction }] } } : {}),
      contents,
      generationConfig: {
        temperature: options.temperature ?? 0.2,
        maxOutputTokens: options.maxTokens,
      },
    }),
  });

  const body = await readResponseBody(response);
  if (!response.ok) {
    throw responseError(response, body);
  }
  if (!body || typeof body !== "object") {
    throw new Error(`Expected JSON object from Gemini, received ${typeof body === "string" ? "text/html or text response" : "empty body"}`);
  }
  const parsed = body as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = parsed.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
  if (!text) {
    throw new Error("Gemini returned an empty response");
  }

  return {
    provider: candidate.name,
    model: candidate.model,
    text,
    raw: parsed,
  };
}

function toTranscript(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      const role = message.role === "assistant" ? "Assistant" : message.role === "system" ? "System" : "User";
      return `${role}: ${message.content}`;
    })
    .join("\n\n");
}
