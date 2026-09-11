import { describe, expect, it } from "vitest";

import {
  AmountOverflowError,
  calculateCost,
  effectivePricingUnitPrice,
  nanoCnyToDecimal,
  productToCnyDecimal,
} from "../../src/pricing/index.js";

const userPrices = {
  input_per_million: "5",
  output_per_million: "30",
  cache_read_per_million: "0.5",
  cache_write_per_million: "6.25",
};

describe("calculateCost", () => {
  it("retains twelve decimal places in effective prices after multiplying", () => {
    const effective = effectivePricingUnitPrice({
      ...userPrices,
      price_multiplier: "0.000001",
      input_per_million: "0.000001",
    });
    expect(effective.input_per_million).toBe("0.000000000001");
    expect(
      calculateCost(
        {
          inputUncachedTokens: 1_000_000_000_000n,
          outputTokens: 0n,
          cacheReadTokens: 0n,
          cacheWriteTokens: 0n,
        },
        effective,
      ).costNanoCny,
    ).toBe(1_000n);
  });

  it("calculates all four token buckets as exact integer nanoyuan", () => {
    const result = calculateCost(
      {
        inputUncachedTokens: 1500n,
        outputTokens: 1000n,
        cacheReadTokens: 1000n,
        cacheWriteTokens: 500n,
      },
      userPrices,
    );

    expect(result.costNanoCny).toBe(41_125_000n);
    expect(nanoCnyToDecimal(result.costNanoCny)).toBe("0.041125");
    expect(productToCnyDecimal(result.breakdown.inputUncachedProduct)).toBe("0.0075");
    expect(productToCnyDecimal(result.breakdown.outputProduct)).toBe("0.03");
    expect(productToCnyDecimal(result.breakdown.cacheReadProduct)).toBe("0.0005");
    expect(productToCnyDecimal(result.breakdown.cacheWriteProduct)).toBe("0.003125");
  });

  it("handles zero, exact rounding boundaries, and values above Number precision", () => {
    expect(
      calculateCost(
        {
          inputUncachedTokens: 0n,
          outputTokens: 0n,
          cacheReadTokens: 0n,
          cacheWriteTokens: 0n,
        },
        userPrices,
      ).costNanoCny,
    ).toBe(0n);
    expect(
      calculateCost(
        {
          inputUncachedTokens: 1n,
          outputTokens: 0n,
          cacheReadTokens: 0n,
          cacheWriteTokens: 0n,
        },
        { ...userPrices, input_per_million: "0.0005" },
      ).costNanoCny,
    ).toBe(1n);
    expect(
      calculateCost(
        {
          inputUncachedTokens: 9_007_199_254_740_993n,
          outputTokens: 0n,
          cacheReadTokens: 0n,
          cacheWriteTokens: 0n,
        },
        { ...userPrices, input_per_million: "0.000001" },
      ).costNanoCny,
    ).toBe(9_007_199_254_741n);
  });

  it("reports costs outside SQLite signed 64-bit range instead of wrapping", () => {
    expect(() =>
      calculateCost(
        {
          inputUncachedTokens: 9_223_372_036_854_775_808n,
          outputTokens: 0n,
          cacheReadTokens: 0n,
          cacheWriteTokens: 0n,
        },
        { ...userPrices, input_per_million: "1000000" },
      ),
    ).toThrow(AmountOverflowError);
  });
});
