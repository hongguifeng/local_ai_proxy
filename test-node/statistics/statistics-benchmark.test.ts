import { describe, expect, it } from "vitest";
import { UsageStatisticsService } from "../../src/maintenance/usage-statistics-service.js";

describe("usage statistics benchmark", () => {
  it("aggregates 10000 lightweight rows without reading bodies", () => {
    const rows = Array.from({ length: 10000 }, (_, i) => ({
      task_id: `t${i}`,
      target_id: `target-${i % 10}`,
      billing_model: "model",
      timestamp: "2026-01-01T00:00:00Z",
      pricing_status: "priced",
      billing_usage_json: '{"input_uncached_tokens":1}',
      cost_nano_cny: "1",
    }));
    const result = new UsageStatisticsService({ usageStatisticsRows: () => rows }).overview(
      "2026-01-01",
      "2026-01-02",
    );
    expect(result.totals["requests"]).toBe(10000);
    expect(result.totals["input"]).toBe("10000");
  });
});
