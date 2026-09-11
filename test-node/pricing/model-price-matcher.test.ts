import { describe, expect, it } from "vitest";

import type { ModelPrice } from "../../src/config/index.js";
import { matchModelPrice } from "../../src/pricing/index.js";

const exact = price("gpt-5.6-sol", "5");
const fallback = price("*", "9");
const family = price("gpt-5.6-*", "6");

describe("matchModelPrice", () => {
  it("chooses exact patterns before earlier overlapping wildcard rules", () => {
    expect(matchModelPrice([fallback, exact, family], "gpt-5.6-sol")).toEqual({
      model: "gpt-5.6-sol",
      rule: exact,
      ruleIndex: 1,
    });
  });

  it("uses the first matching wildcard in configuration order", () => {
    expect(matchModelPrice([fallback, family], "gpt-5.6-sol-preview")?.rule).toBe(fallback);
    expect(matchModelPrice([family, fallback], "gpt-5.6-sol-preview")?.rule).toBe(family);
  });

  it.each([
    ["case-sensitive", "GPT-*", "gpt-5.6", false],
    ["wildcard matches empty text", "gpt-*", "gpt-", true],
    ["question mark is literal", "gpt-?", "gpt-x", false],
    ["brackets are literal", "gpt-[ab]", "gpt-a", false],
  ])("keeps routing wildcard semantics for %s", (_name, pattern, model, expected) => {
    expect(matchModelPrice([price(pattern, "1")], model) !== undefined).toBe(expected);
  });

  it("does not select a price from another target rule list", () => {
    expect(matchModelPrice([price("other", "1")], "model")).toBeUndefined();
    expect(matchModelPrice([price("model", "2")], "model")?.rule.input_per_million).toBe("2");
  });
});

function price(modelPattern: string, input: string): ModelPrice {
  return {
    model_pattern: modelPattern,
    input_per_million: input,
    output_per_million: input,
    cache_read_per_million: input,
    cache_write_per_million: input,
  };
}
