import { describe, expect, it } from "vitest";

import { runPricingBenchmark } from "../../scripts/pricing_benchmark.js";

describe("pricing benchmark fixture", () => {
  it("builds multiple roots and a task larger than 2,500 records", async () => {
    const result = await runPricingBenchmark(40, 2);
    expect(result.roots).toBe(4);
    expect(result.taskRecords).toBe(2500);
    expect(result.recordCount).toBe(10_000);
    expect(result.runs).toBe(2);
    expect(result.medianListMs).toBeGreaterThanOrEqual(0);
    expect(result.medianSearchMs).toBeGreaterThanOrEqual(0);
    expect(result.medianDetailMs).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
