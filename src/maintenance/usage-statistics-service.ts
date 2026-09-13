import type { TrafficRepository, RepositoryRecord } from "../persistence/repository.js";

export type StatisticsMetric = "token" | "cost";

export interface UsageStatisticsOverview {
  readonly totals: Record<string, string | number>;
  readonly byTarget: readonly Record<string, unknown>[];
  readonly byModel: readonly Record<string, unknown>[];
  readonly unpriced: Record<string, number>;
  readonly dataVersion: 1;
}

const empty = () => ({
  input: 0n,
  output: 0n,
  cacheRead: 0n,
  cacheWrite: 0n,
  cost: 0n,
  requests: 0,
  tasks: new Set<string>(),
});

export class UsageStatisticsService {
  constructor(private readonly repository: TrafficRepository) {}

  overview(from: string, to: string, metric: StatisticsMetric = "token"): UsageStatisticsOverview {
    const targets = new Map<string, ReturnType<typeof empty>>();
    const models = new Map<string, ReturnType<typeof empty>>();
    const total = empty();
    const unpriced: Record<string, number> = {};
    for (const row of this.repository.usageStatisticsRows(from, to)) {
      const bucket = this.rowBucket(row, unpriced);
      if (bucket === undefined) continue;
      this.add(total, bucket, row);
      const targetKey = String(row["target_id"] ?? row["target_url"] ?? "unknown");
      const modelKey = String(row["billing_model"] ?? "unknown");
      const target = targets.get(targetKey) ?? empty();
      const model = models.get(modelKey) ?? empty();
      this.add(target, bucket, row);
      this.add(model, bucket, row);
      targets.set(targetKey, target);
      models.set(modelKey, model);
    }
    const project = (map: Map<string, ReturnType<typeof empty>>) =>
      [...map].map(([key, v]) => ({
        id: key,
        requests: v.requests,
        tasks: v.tasks.size,
        input: v.input.toString(),
        output: v.output.toString(),
        cache_read: v.cacheRead.toString(),
        cache_write: v.cacheWrite.toString(),
        cost: (Number(v.cost) / 1e9).toFixed(9),
        value:
          metric === "cost"
            ? v.cost.toString()
            : (v.input + v.output + v.cacheRead + v.cacheWrite).toString(),
      }));
    return {
      dataVersion: 1,
      totals: {
        requests: total.requests,
        tasks: total.tasks.size,
        input: total.input.toString(),
        output: total.output.toString(),
        cache_read: total.cacheRead.toString(),
        cache_write: total.cacheWrite.toString(),
        cost: (Number(total.cost) / 1e9).toFixed(9),
      },
      byTarget: project(targets),
      byModel: project(models),
      unpriced,
    };
  }

  private add(
    to: ReturnType<typeof empty>,
    from: ReturnType<typeof empty>,
    row: RepositoryRecord,
  ): void {
    to.input += from.input;
    to.output += from.output;
    to.cacheRead += from.cacheRead;
    to.cacheWrite += from.cacheWrite;
    to.cost += from.cost;
    to.requests++;
    to.tasks.add(String(row["task_id"]));
  }
  private rowBucket(
    row: RepositoryRecord,
    unpriced: Record<string, number>,
  ): ReturnType<typeof empty> | undefined {
    if (row["pricing_status"] !== "priced") {
      const r = String(row["pricing_reason"] ?? row["pricing_status"] ?? "unknown");
      unpriced[r] = (unpriced[r] ?? 0) + 1;
      return undefined;
    }
    try {
      const u = JSON.parse(String(row["billing_usage_json"] ?? "{}")) as Record<string, unknown>;
      const n = (k: string) => BigInt(Number(u[k] ?? 0));
      return {
        input: n("input_uncached_tokens"),
        output: n("output_tokens"),
        cacheRead: n("cache_read_tokens"),
        cacheWrite: n("cache_write_tokens"),
        cost: BigInt(String(row["cost_nano_cny"] ?? 0)),
        requests: 0,
        tasks: new Set(),
      };
    } catch {
      unpriced["invalid_pricing_record"] = (unpriced["invalid_pricing_record"] ?? 0) + 1;
      return undefined;
    }
  }
}
