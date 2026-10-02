import { performance } from "node:perf_hooks";

import { joinTargetPath, parseTargetUrl } from "./target.js";

/**
 * Fetches the Prometheus /metrics exposition of a forwarding target so the
 * admin UI can render upstream serving statistics (vLLM, SGLang, etc.).
 */
export interface TargetMetricsRequest {
  readonly targetUrl: string;
  readonly timeoutMs?: number;
  readonly apiKey?: string;
}

export interface TargetMetricsResponse {
  readonly ok: boolean;
  readonly status?: number;
  readonly durationMs: number;
  readonly text?: string;
  readonly truncated?: boolean;
  readonly error?: string;
}

export const DEFAULT_TARGET_METRICS_TIMEOUT_MS = 15_000;
export const MAX_TARGET_METRICS_BYTES = 1_048_576;

async function readLimitedBody(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const stream = response.body;
  if (stream === null) {
    return { text: await response.text(), truncated: false };
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const decoder = new TextDecoder();
  let text = "";
  for (const chunk of chunks) {
    text += decoder.decode(chunk, { stream: true });
  }
  if (truncated) {
    text = text.slice(0, maxBytes);
  }
  return { text, truncated };
}

/**
 * Requests `GET /metrics` on the target host. Many servers (vLLM, SGLang)
 * expose metrics at the host root even when the proxy forwards to a base
 * path such as `/v1`, so the base-path variant is tried first and the root
 * variant is used as a fallback when it is not found.
 */
export async function fetchTargetMetrics(
  request: TargetMetricsRequest,
): Promise<TargetMetricsResponse> {
  const parsed = parseTargetUrl(request.targetUrl);
  const candidates = [
    joinTargetPath(parsed.basePath, "/metrics"),
    ...(parsed.basePath === "" ? [] : ["/metrics"]),
  ];
  const timeoutMs = request.timeoutMs ?? DEFAULT_TARGET_METRICS_TIMEOUT_MS;
  const apiKey = request.apiKey;
  const headers: Record<string, string> = {
    accept: "text/plain, */*",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
  const startedAt = performance.now();
  let lastError: string | undefined;
  for (const candidate of candidates) {
    const url = new URL(`${parsed.scheme}://${parsed.host}:${parsed.port}${candidate}`);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      if (response.status === 404 || response.status === 405) {
        await response.body?.cancel().catch(() => undefined);
        lastError = `HTTP ${response.status} for ${candidate}`;
        continue;
      }
      const body = await readLimitedBody(response, MAX_TARGET_METRICS_BYTES);
      const durationMs = Math.max(0, performance.now() - startedAt);
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          durationMs,
          error: `HTTP ${response.status}${body.text === "" ? "" : `: ${body.text.slice(0, 256)}`}`,
        };
      }
      return {
        ok: true,
        status: response.status,
        durationMs,
        text: body.text,
        ...(body.truncated ? { truncated: true } : {}),
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
  return {
    ok: false,
    durationMs: Math.max(0, performance.now() - startedAt),
    error: lastError ?? "metrics endpoint not found",
  };
}
