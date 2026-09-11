import type { ModelPrice } from "../config/index.js";

import { calculateCost, AmountOverflowError } from "./money.js";
import { matchModelPrice } from "./model-price-matcher.js";
import { normalizeUsage, type PricingEndpointKind } from "./usage-normalizer.js";
import type { UsageCaptureResult } from "./usage-accumulator.js";

export interface RequestPricingContext {
  readonly billingModel: string | undefined;
  readonly frozenAt: string | undefined;
  readonly matchedRule: ModelPrice | undefined;
  readonly reason: "missing_model" | "no_matching_price" | undefined;
  readonly targetId: string | undefined;
  readonly targetName: string | undefined;
}

export function freezeRequestPricing(
  model: unknown,
  prices: readonly ModelPrice[],
  metadata: {
    readonly frozenAt?: string;
    readonly targetId?: string;
    readonly targetName?: string;
  } = {},
): RequestPricingContext {
  const shared = {
    frozenAt: metadata.frozenAt,
    targetId: metadata.targetId,
    targetName: metadata.targetName,
  };
  if (typeof model !== "string" || model === "") {
    return { ...shared, billingModel: undefined, matchedRule: undefined, reason: "missing_model" };
  }
  const match = matchModelPrice(prices, model);
  return match === undefined
    ? { ...shared, billingModel: model, matchedRule: undefined, reason: "no_matching_price" }
    : { ...shared, billingModel: model, matchedRule: match.rule, reason: undefined };
}

export interface RequestPricingResult {
  readonly billing_model: string | null;
  readonly cost_nano_cny: string | null;
  readonly pricing_reason: string | null;
  readonly pricing_snapshot: Record<string, unknown> | null;
  readonly pricing_status: "pending" | "priced" | "unpriced";
  readonly usage: Record<string, unknown> | null;
}

export function pendingRequestPricing(context: RequestPricingContext): RequestPricingResult {
  return {
    pricing_status: "pending",
    pricing_reason: context.reason ?? null,
    billing_model: context.billingModel ?? null,
    pricing_snapshot: snapshot(context),
    cost_nano_cny: null,
    usage: null,
  };
}

export function completeRequestPricing(
  context: RequestPricingContext,
  endpoint: PricingEndpointKind,
  responsePayload: unknown,
  streamCapture: UsageCaptureResult | undefined,
): RequestPricingResult {
  const pending = pendingRequestPricing(context);
  if (context.reason !== undefined) return { ...pending, pricing_status: "unpriced" };
  const normalized =
    streamCapture?.status === "complete"
      ? { status: "complete" as const, usage: streamCapture.usage }
      : streamCapture === undefined
        ? normalizeUsage(endpoint, responsePayload)
        : { status: "unavailable" as const, reason: streamCapture.reason };
  if (normalized.status !== "complete") {
    return { ...pending, pricing_status: "unpriced", pricing_reason: normalized.reason };
  }
  if (context.matchedRule === undefined) {
    return { ...pending, pricing_status: "unpriced", pricing_reason: "no_matching_price" };
  }
  try {
    const calculated = calculateCost(
      {
        inputUncachedTokens: BigInt(normalized.usage.inputUncachedTokens),
        outputTokens: BigInt(normalized.usage.outputTokens),
        cacheReadTokens: BigInt(normalized.usage.cacheReadTokens),
        cacheWriteTokens: BigInt(normalized.usage.cacheWriteTokens),
      },
      context.matchedRule,
    );
    return {
      ...pending,
      pricing_status: "priced",
      pricing_reason: null,
      cost_nano_cny: calculated.costNanoCny.toString(),
      usage: { ...normalized.usage },
    };
  } catch (error) {
    if (error instanceof AmountOverflowError) {
      return { ...pending, pricing_status: "unpriced", pricing_reason: error.code };
    }
    throw error;
  }
}

function snapshot(context: RequestPricingContext): Record<string, unknown> | null {
  if (context.matchedRule === undefined) return null;
  return {
    ...context.matchedRule,
    currency: "CNY",
    algorithm_version: 1,
    frozen_at: context.frozenAt ?? null,
    target_id: context.targetId ?? null,
    target_name: context.targetName ?? null,
  };
}
