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
  it("caps trend output at 366 points", () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({
      task_id: String(i),
      timestamp: `2025-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
      pricing_status: "priced",
      billing_usage_json: "{}",
      cost_nano_cny: "0",
    }));
    const result = new UsageStatisticsService({ usageStatisticsRows: () => rows }).trend(
      "2025-01-01",
      "2026-02-01",
    );
    expect(result.points.length).toBeLessThanOrEqual(366);
  });
  it("does not access request or response bodies", () => {
    const row = new Proxy(
      { task_id: "t", pricing_status: "priced", billing_usage_json: "{}", cost_nano_cny: "0" },
      {
        get(target, key) {
          if (key === "request_body" || key === "response_body") throw new Error("body accessed");
          return Reflect.get(target, key) as unknown;
        },
      },
    );
    expect(() =>
      new UsageStatisticsService({ usageStatisticsRows: () => [row] }).overview(
        "2025-01-01",
        "2025-01-02",
      ),
    ).not.toThrow();
  });
});
