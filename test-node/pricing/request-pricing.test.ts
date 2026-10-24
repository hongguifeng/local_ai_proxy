import { describe, expect, it } from "vitest";

import {
  completeRequestPricing,
  freezeRequestPricing,
  pendingRequestPricing,
} from "../../src/pricing/index.js";
import { isRecord } from "../../src/shared/index.js";

const price = {
  model_pattern: "gpt-5",
  input_per_million: "5",
  output_per_million: "30",
  cache_read_per_million: "0.5",
  cache_write_per_million: "6.25",
};
const prices = [price];

describe("request pricing lifecycle", () => {
  it("freezes the matched rule and prices a complete usage result", () => {
    const context = freezeRequestPricing("gpt-5", prices);
    expect(pendingRequestPricing(context)).toMatchObject({
      pricing_status: "pending",
      billing_model: "gpt-5",
    });
    expect(
      completeRequestPricing(
        context,
        "chat",
        {
          usage: {
            prompt_tokens: 1500,
            completion_tokens: 1000,
            prompt_tokens_details: { cached_tokens: 1000 },
          },
        },
        undefined,
      ),
    ).toMatchObject({ pricing_status: "priced", cost_nano_cny: "33000000" });
  });

  it("freezes multiplied effective prices for both calculation and history display", () => {
    const context = freezeRequestPricing("gpt-5", [{ ...price, price_multiplier: "1.2" }]);
    const result = completeRequestPricing(
      context,
      "chat",
      {
        usage: {
          prompt_tokens: 1500,
          completion_tokens: 1000,
          prompt_tokens_details: { cached_tokens: 1000 },
        },
      },
      undefined,
    );
    expect(result).toMatchObject({
      pricing_status: "priced",
      cost_nano_cny: "39600000",
      pricing_snapshot: {
        model_pattern: "gpt-5",
        input_per_million: "6",
        output_per_million: "36",
        cache_read_per_million: "0.6",
        cache_write_per_million: "7.5",
      },
    });
    expect(result.pricing_snapshot).not.toHaveProperty("price_multiplier");
  });

  it("prices OpenAI-compatible servers that send prompt_tokens_details as null", () => {
    expect(
      completeRequestPricing(
        freezeRequestPricing("gpt-5", prices),
        "chat",
        {
          usage: {
            prompt_tokens: 1500,
            completion_tokens: 1000,
            prompt_tokens_details: null,
            completion_tokens_details: { reasoning_tokens: 0 },
          },
        },
        undefined,
      ),
    ).toMatchObject({
      pricing_status: "priced",
      pricing_reason: null,
      cost_nano_cny: "37500000",
      usage: { inputUncachedTokens: 1500, cacheReadTokens: 0, totalInputTokens: 1500 },
    });
  });

  it("freezes missing-model and no-match facts without treating them as free", () => {
    expect(
      completeRequestPricing(freezeRequestPricing(undefined, prices), "chat", {}, undefined),
    ).toMatchObject({
      pricing_status: "unpriced",
      pricing_reason: "missing_model",
      cost_nano_cny: null,
    });
    expect(
      completeRequestPricing(freezeRequestPricing("other", prices), "chat", {}, undefined),
    ).toMatchObject({
      pricing_status: "unpriced",
      pricing_reason: "no_matching_price",
    });
  });

  it("keeps measured usage on unpriced records so cache counts survive", () => {
    const usage = {
      usage: {
        prompt_tokens: 1500,
        completion_tokens: 1000,
        prompt_tokens_details: { cached_tokens: 1000 },
      },
    };
    for (const model of [undefined, "other"]) {
      const result = completeRequestPricing(
        freezeRequestPricing(model, prices),
        "chat",
        usage,
        undefined,
      );
      expect(result).toMatchObject({
        pricing_status: "unpriced",
        pricing_reason: model === undefined ? "missing_model" : "no_matching_price",
        cost_nano_cny: null,
        pricing_snapshot: null,
        usage: {
          source: "chat",
          inputUncachedTokens: 500,
          outputTokens: 1000,
          cacheReadTokens: 1000,
          cacheWriteTokens: 0,
          totalInputTokens: 1500,
        },
      });
    }
  });

  it("prefers the completed SSE capture over the buffered payload for unpriced usage", () => {
    const result = completeRequestPricing(
      freezeRequestPricing("other", prices),
      "responses",
      { usage: { input_tokens: 10, output_tokens: 5 } },
      {
        status: "complete",
        usage: {
          source: "responses",
          inputUncachedTokens: 4,
          outputTokens: 5,
          cacheReadTokens: 6,
          cacheWriteTokens: 0,
          totalInputTokens: 10,
        },
        terminalSeen: true,
        eventTruncated: false,
      },
    );
    expect(result.usage).toMatchObject({ cacheReadTokens: 6, inputUncachedTokens: 4 });
  });

  it("leaves usage absent when an unpriced record has no usable usage", () => {
    expect(
      completeRequestPricing(freezeRequestPricing("other", prices), "chat", {}, undefined),
    ).toMatchObject({ pricing_status: "unpriced", usage: null });
    expect(
      completeRequestPricing(
        freezeRequestPricing("other", prices),
        "chat",
        {},
        {
          status: "unavailable",
          reason: "incomplete_usage",
          terminalSeen: false,
          eventTruncated: false,
        },
      ),
    ).toMatchObject({
      pricing_status: "unpriced",
      pricing_reason: "no_matching_price",
      usage: null,
    });
  });

  it("LB06-06 freezes the same amounts on every member of a load balancing group", () => {
    // The configuration save already rejects members whose price rules differ, so the
    // only thing a node switch can change is which card the snapshot names.
    const left = freezeRequestPricing("gpt-5", prices, {
      frozenAt: "2026-10-22T10:00:00.000+08:00",
      targetId: "node-a",
      targetName: "GPU-1",
    });
    const right = freezeRequestPricing("gpt-5", prices, {
      frozenAt: "2026-10-22T10:00:00.000+08:00",
      targetId: "node-b",
      targetName: "GPU-2",
    });

    const usage = { usage: { prompt_tokens: 1_000, completion_tokens: 500 } };
    const leftPending = pendingRequestPricing(left);
    const rightPending = pendingRequestPricing(right);
    const leftFinished = completeRequestPricing(left, "chat", usage, undefined);
    const rightFinished = completeRequestPricing(right, "chat", usage, undefined);

    expect(leftFinished).toMatchObject({ pricing_status: "priced", cost_nano_cny: "20000000" });
    expect(rightFinished).toMatchObject({ pricing_status: "priced", cost_nano_cny: "20000000" });
    expect({ ...leftPending, pricing_snapshot: null }).toEqual({
      ...rightPending,
      pricing_snapshot: null,
    });
    expect({ ...leftFinished, pricing_snapshot: null }).toEqual({
      ...rightFinished,
      pricing_snapshot: null,
    });

    const leftSnapshot = isRecord(leftPending.pricing_snapshot) ? leftPending.pricing_snapshot : {};
    const rightSnapshot = isRecord(rightPending.pricing_snapshot)
      ? rightPending.pricing_snapshot
      : {};
    expect({ ...leftSnapshot, target_id: null, target_name: null }).toEqual({
      ...rightSnapshot,
      target_id: null,
      target_name: null,
    });
    expect(leftSnapshot).toMatchObject({ target_id: "node-a", target_name: "GPU-1" });
    expect(rightSnapshot).toMatchObject({ target_id: "node-b", target_name: "GPU-2" });
  });
});
