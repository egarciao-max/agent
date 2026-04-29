export const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
};

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders,
      ...init.headers,
    },
  });
}

export function text(data: string, init: ResponseInit = {}): Response {
  return new Response(data, {
    ...init,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...corsHeaders,
      ...init.headers,
    },
  });
}

export function notFound(): Response {
  return json({ error: "Not found" }, { status: 404 });
}

export async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("Expected application/json request body");
  }
  return (await request.json()) as T;
}

export async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";

  if (!text) {
    return null;
  }

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Expected JSON response but received invalid JSON (${contentType}): ${snippet(text)}`);
    }
  }

  return text;
}

export function responseError(response: Response, payload: unknown): Error {
  const detail =
    typeof payload === "string"
      ? payload
      : payload === null
        ? "Empty response body"
        : JSON.stringify(payload);
  const contentType = response.headers.get("content-type") ?? "unknown";
  return new Error(`${response.status} ${response.statusText} (${contentType}): ${snippet(detail)}`);
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function boolFromEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

export function withTimeout(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort("Request timed out"), ms);
  return controller.signal;
}

function snippet(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}
