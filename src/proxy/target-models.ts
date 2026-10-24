import { performance } from "node:perf_hooks";

import { fetchUpstreamModelIds } from "../pricing/index.js";

/**
 * Reads the model ids a forwarding address really serves so the target check
 * dialog can offer them instead of a hand-written guess list.
 */
export interface TargetModelsRequest {
  readonly targetUrl: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
}

export interface TargetModelsResponse {
  readonly ok: boolean;
  readonly models: readonly string[];
  readonly durationMs: number;
  readonly truncated?: boolean;
  readonly error?: string;
}

export const DEFAULT_TARGET_MODELS_TIMEOUT_MS = 30_000;
export const MAX_TARGET_MODEL_IDS = 1_000;
export const MAX_TARGET_MODEL_ID_CHARS = 4_096;

/**
 * Wraps `fetchUpstreamModelIds` into the `{ ok, models, durationMs }` shape the
 * dialog already uses for the target check: an address that cannot be reached
 * is an ordinary answer, not an admin API error. An unusable address stays a
 * `TypeError` so the route can still answer 400 `invalid_target_url`.
 */
export async function fetchTargetModels(
  request: TargetModelsRequest,
): Promise<TargetModelsResponse> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TARGET_MODELS_TIMEOUT_MS;
  const apiKey = request.apiKey;
  const startedAt = performance.now();
  try {
    const ids = await fetchUpstreamModelIds(
      request.targetUrl,
      apiKey === undefined || apiKey === "" ? undefined : apiKey,
      timeoutMs,
    );
    const usable = ids.filter((id) => id.length <= MAX_TARGET_MODEL_ID_CHARS);
    const models = usable.slice(0, MAX_TARGET_MODEL_IDS);
    return {
      ok: true,
      models,
      durationMs: Math.max(0, performance.now() - startedAt),
      ...(models.length < usable.length ? { truncated: true } : {}),
    };
  } catch (error) {
    if (error instanceof TypeError) {
      throw error;
    }
    return {
      ok: false,
      models: [],
      durationMs: Math.max(0, performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
