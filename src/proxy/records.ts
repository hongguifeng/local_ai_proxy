import { normalizeUsage } from "../pricing/usage-normalizer.js";
import { isRecord } from "../shared/index.js";

import { isPythonTruthy, type EndpointKind } from "./protocol/analysis.js";

/**
 * Token accounting for recorded responses. It reads the usage block of a response payload
 * (including the summary a stream left behind) and turns it into the input and output token
 * counts the traffic record stores. Nothing else owns this conversion.
 */

export function responseTokenCount(payload: unknown): number | undefined {
  const usage = responseUsage(payload);
  if (!isRecord(usage)) {
    return undefined;
  }
  const total = usage["total_tokens"];
  if (typeof total === "number" && Number.isInteger(total)) {
    return total;
  }
  const counts = responseTokenCounts(payload);
  const values = [counts.request, counts.response].filter(
    (value): value is number => value !== undefined,
  );
  return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0);
}

export interface ResponseTokenCounts {
  readonly request: number | undefined;
  readonly response: number | undefined;
}

export function responseTokenCounts(payload: unknown, kind?: EndpointKind): ResponseTokenCounts {
  if (kind !== undefined) {
    const normalized = normalizeUsage(kind, payload);
    if (normalized.status === "complete") {
      return {
        request: normalized.usage.totalInputTokens,
        response: normalized.usage.outputTokens,
      };
    }
  }
  const usage = responseUsage(payload);
  if (!isRecord(usage)) {
    return { request: undefined, response: undefined };
  }
  const input = tokenValue(usage, "input_tokens") ?? tokenValue(usage, "prompt_tokens");
  const cachedInputValues = ["cache_creation_input_tokens", "cache_read_input_tokens"]
    .map((key) => tokenValue(usage, key))
    .filter((value): value is number => value !== undefined);
  const cachedInput = cachedInputValues.reduce((sum, value) => sum + value, 0);
  return {
    request:
      input === undefined && cachedInputValues.length === 0
        ? undefined
        : (input ?? 0) + cachedInput,
    response: tokenValue(usage, "output_tokens") ?? tokenValue(usage, "completion_tokens"),
  };
}

function responseUsage(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return undefined;
  }
  const streamSummary = payload["stream_summary"];
  if (isRecord(streamSummary) && isPythonTruthy(streamSummary["usage"])) {
    return streamSummary["usage"];
  }
  if (isPythonTruthy(payload["usage"])) {
    return payload["usage"];
  }
  const response = payload["response"];
  return isRecord(response) && isPythonTruthy(response["usage"]) ? response["usage"] : undefined;
}

function tokenValue(usage: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = usage[key];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}
