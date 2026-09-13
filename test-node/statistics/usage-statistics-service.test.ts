import { describe, expect, it } from "vitest";
import { UsageStatisticsService } from "../../src/maintenance/usage-statistics-service.js";

describe("UsageStatisticsService", () => {
  it("aggregates priced buckets and excludes unpriced rows", () => {
    const service = new UsageStatisticsService({
      usageStatisticsRows: () => [
        {
          task_id: "t1",
          target_id: "a",
          target_name: "A",
          billing_model: "m",
          pricing_status: "priced",
          billing_usage_json: JSON.stringify({
            input_uncached_tokens: 10,
            output_tokens: 5,
            cache_read_tokens: 2,
            cache_write_tokens: 1,
          }),
          cost_nano_cny: "100",
        },
        {
          task_id: "t1",
          target_id: "a",
          billing_model: "m",
          pricing_status: "unpriced",
          pricing_reason: "legacy_record",
        },
      ],
    });
    const result = service.overview("2026-01-01", "2026-01-02");
    expect(result.totals).toMatchObject({
      requests: 1,
      tasks: 1,
      input: "10",
      output: "5",
      cache_read: "2",
      cache_write: "1",
    });
    expect(result.unpriced["legacy_record"]).toBe(1);
    expect(result.byModel[0]).toMatchObject({ id: "m", value: "18" });
  });

  it("filters trend rows by target and model", () => {
    const service = new UsageStatisticsService({
      usageStatisticsRows: () => [
        {
          task_id: "t1",
          target_id: "a",
          billing_model: "m1",
          timestamp: "2026-01-01T01:00:00Z",
          pricing_status: "priced",
          billing_usage_json: "{}",
          cost_nano_cny: "7",
        },
        {
          task_id: "t2",
          target_id: "b",
          billing_model: "m2",
          timestamp: "2026-01-01T02:00:00Z",
          pricing_status: "priced",
          billing_usage_json: "{}",
          cost_nano_cny: "9",
        },
      ],
    });
    const result = service.trend("2026-01-01", "2026-01-02", "a", "m1");
    expect(result.points).toHaveLength(1);
    expect(result.points[0]).toMatchObject({ requests: 1, tasks: 1, cost: "7" });
  });

  it("keeps overview distribution aligned with trend token totals", () => {
    const service = new UsageStatisticsService({
      usageStatisticsRows: () =>
        Array.from({ length: 10 }, (_, i) => ({
          task_id: `t${i}`,
          target_id: `target-${i}`,
          billing_model: "m",
          timestamp: "2026-01-01T00:00:00Z",
          pricing_status: "priced",
          billing_usage_json: JSON.stringify({ input_uncached_tokens: 1 }),
          cost_nano_cny: "1",
        })),
    });
    const overview = service.overview("2026-01-01", "2026-01-02");
    const trend = service.trend("2026-01-01", "2026-01-02");
    expect(overview.byTarget).toHaveLength(10);
    expect(overview.byTarget.reduce((sum, row) => sum + Number(row.value), 0)).toBe(
      Number(trend.points[0].input),
    );
  });
});
