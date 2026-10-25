import { resolveUpstreamUrl, upstreamAuthHeaders, type UpstreamApiKind } from "./api-request.js";

/**
 * Minimal request used to verify that a target is reachable and serving.
 */
export type TargetCheckApiType = UpstreamApiKind;

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

/**
 * The check's own business parameters: a one-word prompt and the smallest answer
 * each protocol can produce. Protocol construction - endpoint path, auth headers and
 * URL - is not repeated here; `src/proxy/api-request.ts` owns it for every caller.
 * In particular a check asks for no temperature and no `stream` flag on the chat
 * protocol, and only the Anthropic protocol needs a token cap.
 */
function buildCheckBody(kind: UpstreamApiKind, model: string): Record<string, unknown> {
  const ping = { role: "user", content: "ping" };
  if (kind === "responses") {
    return { model, input: "ping" };
  }
  if (kind === "anthropic") {
    return { model, messages: [ping], max_tokens: 1, stream: false };
  }
  return { model, messages: [ping] };
}

/**
 * A check carries no credentials when the form left the key out or blank; a real
 * model call keeps a configured empty key as a credential. The two callers state
 * their own rule and share the same header construction for whatever they do send.
 */
function checkCredentials(apiKey: string | undefined): string | undefined {
  return apiKey === undefined || apiKey === "" ? undefined : apiKey;
}

/**
 * Sends a minimal chat completion request to the target's upstream endpoint
 * and reports whether a response was received. `ok` is true whenever the
 * server produced an HTTP response; the caller can then inspect `status`
 * for authentication or model errors.
 */
export async function checkTarget(request: TargetCheckRequest): Promise<TargetCheckResponse> {
  const kind = request.apiType ?? "chat";
  const url = resolveUpstreamUrl(request.targetUrl, kind);
  const timeoutMs = request.timeoutMs ?? DEFAULT_TARGET_CHECK_TIMEOUT_MS;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...upstreamAuthHeaders(kind, checkCredentials(request.apiKey)),
  };
  const body = JSON.stringify(buildCheckBody(kind, request.model));
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
