import { describe, expect, it } from "vitest";

import {
  completeRequestPricing,
  freezeRequestPricing,
  pendingRequestPricing,
} from "../../src/pricing/index.js";

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
});
