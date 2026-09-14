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
      tasks: 0,
      input: "10",
      output: "5",
      cache_read: "2",
      cache_write: "1",
    });
    expect(result.unpriced["legacy_record"]).toBe(1);
    expect(result.byModel[0]).toMatchObject({ id: "m", value: "18" });
  });

  it("only counts tasks with more than five requests", () => {
    const service = new UsageStatisticsService({
      usageStatisticsRows: () => [
        ...Array.from({ length: 6 }, () => ({
          task_id: "big",
          target_id: "a",
          billing_model: "m",
          pricing_status: "priced",
          billing_usage_json: "{}",
          cost_nano_cny: "1",
        })),
        ...Array.from({ length: 5 }, () => ({
          task_id: "small",
          target_id: "a",
          billing_model: "m",
          pricing_status: "priced",
          billing_usage_json: "{}",
          cost_nano_cny: "1",
        })),
      ],
    });
    const overview = service.overview("2026-01-01", "2026-01-02");
    const trend = service.trend(
      "2026-01-01",
      "2026-01-02",
      undefined,
      undefined,
      "day",
      0,
      "model",
    );
    expect(overview.totals).toMatchObject({ requests: 11, tasks: 1 });
    expect(overview.byTarget[0]).toMatchObject({ id: "a", requests: 11, tasks: 1 });
    const point = trend.points[0];
    expect(point).toMatchObject({ requests: 11, tasks: 1 });
    expect(point?.["by_model"]).toEqual([
      expect.objectContaining({ id: "m", requests: 11, tasks: 1 }),
    ]);
  });

  it("filters trend rows by target and model", () => {
    const service = new UsageStatisticsService({
      usageStatisticsRows: () => [
        ...Array.from({ length: 6 }, () => ({
          task_id: "t1",
          target_id: "a",
          billing_model: "m1",
          timestamp: "2026-01-01T01:00:00Z",
          pricing_status: "priced",
          billing_usage_json: "{}",
          cost_nano_cny: "7",
        })),
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
    expect(result.points[0]).toMatchObject({ requests: 6, tasks: 1, cost: "42" });
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
    const firstPoint = trend.points[0];
    if (firstPoint === undefined) throw new Error("First trend point is missing");
    expect(overview.byTarget.reduce((sum, row) => sum + Number(row["value"]), 0)).toBe(
      Number(firstPoint["input"]),
    );
  });

  it("buckets timestamps using the requested local timezone and returns breakdowns", () => {
    const service = new UsageStatisticsService({
      usageStatisticsRows: () => [
        {
          task_id: "t1",
          target_id: "a",
          target_name: "Alpha",
          billing_model: "m1",
          timestamp: "2026-09-12T16:30:00Z",
          pricing_status: "priced",
          billing_usage_json: JSON.stringify({ input_uncached_tokens: 3 }),
          cost_nano_cny: "5",
        },
        {
          task_id: "t2",
          target_id: "b",
          target_name: "Beta",
          billing_model: "m2",
          timestamp: "2026-09-12T17:30:00Z",
          pricing_status: "priced",
          billing_usage_json: JSON.stringify({ input_uncached_tokens: 4 }),
          cost_nano_cny: "6",
        },
      ],
    });
    const result = service.trend(
      "2026-09-12",
      "2026-09-14",
      undefined,
      undefined,
      "day",
      480,
      "model",
    );
    const firstPoint = result.points[0];
    if (firstPoint === undefined) throw new Error("First trend point is missing");
    expect(firstPoint).toMatchObject({ bucket: "2026-09-13", input: "7" });
    expect(firstPoint["by_model"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "m1", input: "3" }),
        expect.objectContaining({ id: "m2", input: "4" }),
      ]),
    );
  });
});
