import { describe, expect, it } from "vitest";

import {
  completeRequestPricing,
  freezeRequestPricing,
  pendingRequestPricing,
} from "../../src/pricing/index.js";

const prices = [
  {
    model_pattern: "gpt-5",
    input_per_million: "5",
    output_per_million: "30",
    cache_read_per_million: "0.5",
    cache_write_per_million: "6.25",
  },
];

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
