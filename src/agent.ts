import { completeWithFallback } from "./providers";
import { executeToolCall, skills } from "./skills";
import type { AgentResult, ChatMessage, ChatRequest, Env, ToolCall, ToolResult } from "./types";

const agentSystemPrompt = `You are an OpenClaw cloud agent running on Cloudflare Workers.
Your primary model provider is OpenClaw, with Ollama as secondary, and Gemini as the final fallback.
You can propose skills, but you must not invent secrets, tokens, hosts, or credentials.
When a skill is needed, respond with a compact JSON object:
{"message":"short user-facing explanation","toolCalls":[{"skill":"skill_name","input":{}}]}
When no skill is needed, answer normally.
Available skills are:
${skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")}`;

export async function runAgent(env: Env, request: ChatRequest): Promise<AgentResult> {
  const baseMessages = normalizeMessages(request.messages);
  const firstPassMessages = [{ role: "system" as const, content: agentSystemPrompt }, ...baseMessages];
  const first = await completeWithFallback(env, firstPassMessages, request);
  const plan = parseToolPlan(first.result.text);

  if (plan.toolCalls.length === 0 || !request.autoExecuteTools) {
    return {
      text: plan.message || first.result.text,
      provider: first.result.provider,
      model: first.result.model,
      toolCalls: plan.toolCalls,
      toolResults: [],
      providerFailures: first.failures,
    };
  }

  const toolResults: ToolResult[] = [];
  for (const toolCall of plan.toolCalls) {
    toolResults.push(await executeToolCall(env, toolCall));
  }

  const finalMessages: ChatMessage[] = [
    { role: "system", content: agentSystemPrompt },
    ...baseMessages,
    { role: "assistant", content: plan.message || first.result.text },
    {
      role: "tool",
      name: "tool_results",
      content: JSON.stringify(toolResults),
    },
    {
      role: "user",
      content: "Use the tool results to answer the user. Be direct about any failed tool calls.",
    },
  ];
  const second = await completeWithFallback(env, finalMessages, request);

  return {
    text: second.result.text,
    provider: second.result.provider,
    model: second.result.model,
    toolCalls: plan.toolCalls,
    toolResults,
    providerFailures: [...first.failures, ...second.failures],
  };
}

function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("At least one chat message is required");
  }
  return messages.map((message) => ({
    role: message.role,
    content: String(message.content ?? ""),
    name: message.name,
  }));
}

function parseToolPlan(text: string): { message: string; toolCalls: ToolCall[] } {
  const candidate = extractJson(text);
  if (!candidate) {
    return { message: text, toolCalls: [] };
  }

  try {
    const parsed = JSON.parse(candidate) as {
      message?: unknown;
      toolCalls?: Array<{ skill?: unknown; input?: unknown }>;
    };
    const toolCalls =
      parsed.toolCalls
        ?.filter((item) => typeof item.skill === "string")
        .map((item) => ({
          skill: item.skill as string,
          input: isRecord(item.input) ? item.input : {},
        })) ?? [];

    return {
      message: typeof parsed.message === "string" ? parsed.message : "",
      toolCalls,
    };
  } catch {
    return { message: text, toolCalls: [] };
  }
}

function extractJson(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last <= first) {
    return null;
  }
  return text.slice(first, last + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
