import { parseTargetUrl } from "./target.js";

/**
 * Minimal request used to verify that a target is reachable and serving.
 */
export type TargetCheckApiType = "chat" | "responses" | "anthropic";

export interface TargetCheckRequest {
  readonly targetUrl: string;
  readonly model: string;
  readonly apiType?: TargetCheckApiType;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
}

export interface TargetCheckResponse {
  readonly ok: boolean;
  readonly status?: number;
  readonly durationMs: number;
  readonly error?: string;
  readonly detail?: string;
}

export const DEFAULT_TARGET_CHECK_TIMEOUT_MS = 30_000;
const MAX_CHECK_RESPONSE_BYTES = 8_192;

async function readLimitedBody(response: Response, maxBytes: number): Promise<string | undefined> {
  const stream = response.body;
  if (stream === null) return undefined;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const decoder = new TextDecoder();
  let text = "";
  for (const chunk of chunks) {
    text += decoder.decode(chunk, { stream: true });
  }
  text = text.slice(0, maxBytes).trim();
  return text === "" ? undefined : text;
}

interface TargetCheckShape {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

function buildCheckRequest(request: TargetCheckRequest): TargetCheckShape {
  const apiKey = request.apiKey;
  switch (request.apiType ?? "chat") {
    case "responses":
      return {
        path: "/responses",
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        body: { model: request.model, input: "ping" },
      };
    case "anthropic":
      return {
        path: "/messages",
        headers: {
          "anthropic-version": "2023-06-01",
          ...(apiKey ? { "x-api-key": apiKey } : {}),
        },
        body: {
          model: request.model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        },
      };
    default:
      return {
        path: "/chat/completions",
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        body: {
          model: request.model,
          messages: [{ role: "user", content: "ping" }],
        },
      };
  }
}

/**
 * Sends a minimal chat completion request to the target's upstream endpoint
 * and reports whether a response was received. `ok` is true whenever the
 * server produced an HTTP response; the caller can then inspect `status`
 * for authentication or model errors.
 */
export async function checkTarget(request: TargetCheckRequest): Promise<TargetCheckResponse> {
  const parsed = parseTargetUrl(request.targetUrl);
  const shape = buildCheckRequest(request);
  const url = new URL(
    `${parsed.scheme}://${parsed.host}:${parsed.port}${parsed.basePath}${shape.path}`,
  );
  const timeoutMs = request.timeoutMs ?? DEFAULT_TARGET_CHECK_TIMEOUT_MS;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...shape.headers,
  };
  const body = JSON.stringify(shape.body);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    const detail = await readLimitedBody(response, MAX_CHECK_RESPONSE_BYTES);
    await response.body?.cancel().catch(() => undefined);
    return {
      ok: true,
      status: response.status,
      durationMs: Math.max(0, performance.now() - startedAt),
      ...(detail !== undefined ? { detail } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      durationMs: Math.max(0, performance.now() - startedAt),
      error: controller.signal.aborted
        ? `timeout after ${Math.round(timeoutMs)} ms`
        : error instanceof Error
          ? error.message
          : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
