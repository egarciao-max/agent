export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  autoExecuteTools?: boolean;
}

export interface ProviderResult {
  provider: string;
  model: string;
  text: string;
  raw?: unknown;
}

export interface ProviderFailure {
  provider: string;
  error: string;
}

export interface AgentResult {
  text: string;
  provider: string;
  model: string;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  providerFailures: ProviderFailure[];
}

export interface BridgeHealth {
  ok: boolean;
  startedAt?: string;
  keepaliveEnabled?: boolean;
  keepaliveIntervalMs?: number;
  openClawUrl?: string;
  ollamaUrl?: string;
  openClaw?: {
    healthy?: boolean;
    lastCheckAt?: string | null;
    lastHealthyAt?: string | null;
    lastActionAt?: string | null;
    lastAction?: string | null;
    lastError?: string | null;
    consecutiveFailures?: number;
    inFlight?: boolean;
  };
  ollama?: {
    healthy?: boolean;
    lastCheckAt?: string | null;
    lastHealthyAt?: string | null;
    lastError?: string | null;
    models?: string[];
  };
  error?: string;
}

export interface ToolCall {
  skill: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  skill: string;
  ok: boolean;
  output?: unknown;
  error?: string;
}

export interface SkillDefinition {
  name: string;
  title: string;
  description: string;
  risk: "low" | "medium" | "high";
  enabled: boolean;
  requiresApproval: boolean;
  inputSchema: Record<string, unknown>;
}

export interface Env {
  ASSETS: Fetcher;
  AGENT_SESSIONS: DurableObjectNamespace;
  OLLAMA_LOCAL_URL?: string;
  OLLAMA_REMOTE_URL?: string;
  OLLAMA_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  LOCAL_BRIDGE_URL?: string;
  AGENT_SHARED_SECRET?: string;
  ALLOW_AGENT_TOOL_EXECUTION?: string;
  API_INTEGRATIONS_JSON?: string;
  OPENCLAW_GATEWAY_URL?: string;
  OPENCLAW_GATEWAY_TOKEN?: string;
  [key: string]: unknown;
}
