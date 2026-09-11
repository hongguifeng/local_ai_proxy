import { isRecord } from "../shared/index.js";

export type PricingEndpointKind = "responses" | "messages" | "chat" | "completions" | "other";
export type UsageNormalizationReason = "invalid_usage" | "missing_usage" | "unsupported_usage";

export interface NormalizedUsage {
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly inputUncachedTokens: number;
  readonly outputTokens: number;
  readonly source: PricingEndpointKind;
  readonly totalInputTokens: number;
}

export type UsageNormalization =
  | { readonly status: "complete"; readonly usage: NormalizedUsage }
  | {
      readonly diagnostics: readonly string[];
      readonly reason: UsageNormalizationReason;
      readonly status: "unavailable";
    };

/** Normalizes only documented protocol usage structures into four disjoint buckets. */
export function normalizeUsage(kind: PricingEndpointKind, payload: unknown): UsageNormalization {
  const usage = usageFromPayload(payload);
  if (usage === undefined) {
    return unavailable("missing_usage", "usage is missing");
  }
  if (kind === "other") {
    return unavailable("unsupported_usage", "endpoint does not have a supported usage protocol");
  }
  if (kind === "messages") {
    return normalizeMessagesUsage(usage);
  }
  return normalizeOpenAiUsage(kind, usage);
}

function normalizeOpenAiUsage(
  kind: Exclude<PricingEndpointKind, "messages" | "other">,
  usage: Readonly<Record<string, unknown>>,
): UsageNormalization {
  if (hasAny(usage, ["cache_read_input_tokens", "cache_creation_input_tokens"])) {
    return unavailable("unsupported_usage", "Anthropic cache fields conflict with OpenAI usage");
  }
  const inputKey = kind === "responses" ? "input_tokens" : "prompt_tokens";
  const outputKey = kind === "responses" ? "output_tokens" : "completion_tokens";
  const input = requiredToken(usage, inputKey);
  const output = requiredToken(usage, outputKey);
  if (input.error !== undefined || output.error !== undefined) {
    return unavailable(
      input.error ?? output.error ?? "invalid_usage",
      input.message ?? output.message ?? "invalid usage",
    );
  }
  const detailKey = kind === "responses" ? "input_tokens_details" : "prompt_tokens_details";
  const cached = optionalCachedToken(usage, detailKey);
  if (cached.error !== undefined) {
    return unavailable(cached.error, cached.message ?? "invalid cached token count");
  }
  if (cached.value > input.value) {
    return unavailable("invalid_usage", "cached token count exceeds input token count");
  }
  return complete(kind, input.value - cached.value, output.value, cached.value, 0);
}

function normalizeMessagesUsage(usage: Readonly<Record<string, unknown>>): UsageNormalization {
  if (hasAny(usage, ["prompt_tokens", "completion_tokens", "prompt_tokens_details"])) {
    return unavailable("unsupported_usage", "OpenAI usage fields conflict with Anthropic usage");
  }
  const input = requiredToken(usage, "input_tokens");
  const output = requiredToken(usage, "output_tokens");
  const read = optionalToken(usage, "cache_read_input_tokens");
  const write = cacheWriteTokens(usage);
  const firstError = input.error ?? output.error ?? read.error ?? write.error;
  if (firstError !== undefined) {
    return unavailable(
      firstError,
      input.message ?? output.message ?? read.message ?? write.message ?? "invalid usage",
    );
  }
  return complete("messages", input.value, output.value, read.value, write.value);
}

function usageFromPayload(payload: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(payload)) return undefined;
  const summary = payload["stream_summary"];
  if (isRecord(summary) && isRecord(summary["usage"])) return summary["usage"];
  if (isRecord(payload["usage"])) return payload["usage"];
  const response = payload["response"];
  if (isRecord(response) && isRecord(response["usage"])) return response["usage"];
  return undefined;
}

function complete(
  source: PricingEndpointKind,
  inputUncachedTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): UsageNormalization {
  return {
    status: "complete",
    usage: {
      source,
      inputUncachedTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalInputTokens: inputUncachedTokens + cacheReadTokens + cacheWriteTokens,
    },
  };
}

interface TokenResult {
  readonly error: UsageNormalizationReason | undefined;
  readonly message: string | undefined;
  readonly value: number;
}

function requiredToken(usage: Readonly<Record<string, unknown>>, key: string): TokenResult {
  if (!Object.hasOwn(usage, key)) return invalid("missing_usage", `${key} is missing`);
  return tokenValue(usage[key], key);
}

function optionalToken(usage: Readonly<Record<string, unknown>>, key: string): TokenResult {
  return Object.hasOwn(usage, key) ? tokenValue(usage[key], key) : valid(0);
}

function optionalCachedToken(
  usage: Readonly<Record<string, unknown>>,
  detailKey: string,
): TokenResult {
  if (!Object.hasOwn(usage, detailKey)) return valid(0);
  const details = usage[detailKey];
  if (!isRecord(details)) return invalid("invalid_usage", `${detailKey} must be an object`);
  return Object.hasOwn(details, "cached_tokens")
    ? tokenValue(details["cached_tokens"], `${detailKey}.cached_tokens`)
    : valid(0);
}

function cacheWriteTokens(usage: Readonly<Record<string, unknown>>): TokenResult {
  const total = optionalToken(usage, "cache_creation_input_tokens");
  const ttl5m = optionalToken(usage, "cache_creation_input_tokens_5m");
  const ttl1h = optionalToken(usage, "cache_creation_input_tokens_1h");
  const error = total.error ?? ttl5m.error ?? ttl1h.error;
  if (error !== undefined)
    return invalid(
      error,
      total.message ?? ttl5m.message ?? ttl1h.message ?? "invalid cache write tokens",
    );
  const hasTotal = Object.hasOwn(usage, "cache_creation_input_tokens");
  const hasTtl =
    Object.hasOwn(usage, "cache_creation_input_tokens_5m") ||
    Object.hasOwn(usage, "cache_creation_input_tokens_1h");
  if (hasTotal && hasTtl && total.value !== ttl5m.value + ttl1h.value) {
    return invalid("invalid_usage", "cache write total conflicts with TTL token counts");
  }
  return valid(hasTotal ? total.value : ttl5m.value + ttl1h.value);
}

function tokenValue(value: unknown, name: string): TokenResult {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? valid(value)
    : invalid("invalid_usage", `${name} must be a non-negative safe integer`);
}

function valid(value: number): TokenResult {
  return { value, error: undefined, message: undefined };
}

function invalid(reason: UsageNormalizationReason, message: string): TokenResult {
  return { value: 0, error: reason, message };
}

function unavailable(reason: UsageNormalizationReason, diagnostic: string): UsageNormalization {
  return { status: "unavailable", reason, diagnostics: [diagnostic] };
}

function hasAny(record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return keys.some((key) => Object.hasOwn(record, key));
}
