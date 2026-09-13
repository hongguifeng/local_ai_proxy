import type { RepositoryRecord } from "../persistence/repository.js";
interface StatisticsRepository {
  usageStatisticsRows(from: string, to: string): readonly RepositoryRecord[];
}

export type StatisticsMetric = "token" | "cost";

export interface UsageStatisticsOverview {
  readonly totals: Record<string, string | number>;
  readonly byTarget: readonly Record<string, unknown>[];
  readonly byModel: readonly Record<string, unknown>[];
  readonly unpriced: Record<string, number>;
  readonly dataVersion: 1;
}
export interface UsageStatisticsTrend {
  readonly dataVersion: 1;
  readonly granularity: string;
  readonly points: readonly Record<string, unknown>[];
}
type TrendBreakdown = "total" | "model" | "target";

const empty = () => ({
  input: 0n,
  output: 0n,
  cacheRead: 0n,
  cacheWrite: 0n,
  cost: 0n,
  requests: 0,
  unpriced: 0,
  tasks: new Map<string, number>(),
});

const MIN_TASK_REQUESTS = 5;

function countTasks(tasks: Map<string, number>): number {
  let count = 0;
  for (const requests of tasks.values()) if (requests > MIN_TASK_REQUESTS) count += 1;
  return count;
}

function mergeTasks(to: Map<string, number>, from: Map<string, number>): void {
  for (const [id, requests] of from) to.set(id, (to.get(id) ?? 0) + requests);
}

export class UsageStatisticsService {
  constructor(private readonly repository: StatisticsRepository) {}
  repositoryRows(from: string, to: string): readonly RepositoryRecord[] {
    return this.repository.usageStatisticsRows(from, to);
  }

  overview(from: string, to: string, metric: StatisticsMetric = "token"): UsageStatisticsOverview {
    const targets = new Map<string, ReturnType<typeof empty>>();
    const models = new Map<string, ReturnType<typeof empty>>();
    const total = empty();
    const unpriced: Record<string, number> = {};
    for (const row of this.repository.usageStatisticsRows(from, to)) {
      const bucket = this.rowBucket(row, unpriced);
      if (bucket === undefined) continue;
      this.add(total, bucket, row);
      const targetKey = String(
        row["target_name"] ?? row["target_id"] ?? row["target_url"] ?? "unknown",
      );
      const modelKey = String(row["billing_model"] ?? "unknown");
      const target = targets.get(targetKey) ?? empty();
      const model = models.get(modelKey) ?? empty();
      this.add(target, bucket, row);
      this.add(model, bucket, row);
      targets.set(targetKey, target);
      models.set(modelKey, model);
    }
    const project = (map: Map<string, ReturnType<typeof empty>>) => {
      const rows = [...map].sort((a, b) => Number(b[1].requests - a[1].requests));
      const visible = rows.slice(0, 9);
      const rest = rows.slice(9);
      if (rest.length) {
        const other = empty();
        for (const [, value] of rest) {
          other.requests += value.requests;
          other.input += value.input;
          other.output += value.output;
          other.cacheRead += value.cacheRead;
          other.cacheWrite += value.cacheWrite;
          other.cost += value.cost;
          other.unpriced += value.unpriced;
          mergeTasks(other.tasks, value.tasks);
        }
        visible.push(["other", other]);
      }
      return visible.map(([key, v]) => ({
        id: key,
        requests: v.requests,
        tasks: countTasks(v.tasks),
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
    };
    return {
      dataVersion: 1,
      totals: {
        requests: total.requests,
        tasks: countTasks(total.tasks),
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

  trend(
    from: string,
    to: string,
    targetId?: string,
    model?: string,
    granularity = "day",
    timezoneOffsetMinutes = 0,
    breakdown: TrendBreakdown = "total",
  ): UsageStatisticsTrend {
    const points = new Map<
      string,
      {
        total: ReturnType<typeof empty>;
        byModel: Map<string, ReturnType<typeof empty>>;
        byTarget: Map<string, ReturnType<typeof empty>>;
      }
    >();
    for (const row of this.repository.usageStatisticsRows(from, to)) {
      if (
        targetId !== undefined &&
        String(row["target_id"] ?? row["target_url"] ?? "") !== targetId
      )
        continue;
      if (model !== undefined && String(row["billing_model"] ?? "") !== model) continue;
      const key = bucketKey(String(row["timestamp"]), granularity, timezoneOffsetMinutes);
      const value = points.get(key) ?? { total: empty(), byModel: new Map(), byTarget: new Map() };
      const parsed = this.rowBucket(row, {});
      if (parsed !== undefined) {
        this.add(value.total, parsed, row);
        const modelKey = String(row["billing_model"] ?? "unknown");
        const targetKey = String(
          row["target_name"] ?? row["target_id"] ?? row["target_url"] ?? "unknown",
        );
        const model = value.byModel.get(modelKey) ?? empty();
        const target = value.byTarget.get(targetKey) ?? empty();
        this.add(model, parsed, row);
        this.add(target, parsed, row);
        value.byModel.set(modelKey, model);
        value.byTarget.set(targetKey, target);
      } else value.total.unpriced++;
      points.set(key, value);
    }
    return {
      dataVersion: 1,
      granularity,
      points: [...points]
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-366)
        .map(([bucket, groups]) => {
          const v = groups.total;
          const serialize = (m: Map<string, ReturnType<typeof empty>>) =>
            [...m].map(([id, x]) => ({
              id,
              requests: x.requests,
              tasks: countTasks(x.tasks),
              input: x.input.toString(),
              output: x.output.toString(),
              cache_read: x.cacheRead.toString(),
              cache_write: x.cacheWrite.toString(),
              cost: x.cost.toString(),
              unpriced: x.unpriced,
            }));
          return {
            bucket,
            requests: v.requests,
            tasks: countTasks(v.tasks),
            input: v.input.toString(),
            output: v.output.toString(),
            cache_read: v.cacheRead.toString(),
            cache_write: v.cacheWrite.toString(),
            cost: v.cost.toString(),
            unpriced: v.unpriced,
            by_model: breakdown === "model" ? serialize(groups.byModel) : [],
            by_target: breakdown === "target" ? serialize(groups.byTarget) : [],
          };
        }),
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
    const taskId = String(row["task_id"]);
    to.tasks.set(taskId, (to.tasks.get(taskId) ?? 0) + 1);
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
      const aliases: Record<string, string[]> = {
        input_uncached_tokens: ["input_uncached_tokens", "inputUncachedTokens"],
        output_tokens: ["output_tokens", "outputTokens"],
        cache_read_tokens: ["cache_read_tokens", "cacheReadTokens"],
        cache_write_tokens: ["cache_write_tokens", "cacheWriteTokens"],
      };
      const n = (k: string) =>
        BigInt(
          Number((aliases[k] ?? [k]).map((name) => u[name]).find((v) => v !== undefined) ?? 0),
        );
      return {
        input: n("input_uncached_tokens"),
        output: n("output_tokens"),
        cacheRead: n("cache_read_tokens"),
        cacheWrite: n("cache_write_tokens"),
        cost: BigInt(String(row["cost_nano_cny"] ?? 0)),
        requests: 0,
        unpriced: 0,
        tasks: new Map<string, number>(),
      };
    } catch {
      unpriced["invalid_pricing_record"] = (unpriced["invalid_pricing_record"] ?? 0) + 1;
      return undefined;
    }
  }
}

function bucketKey(timestamp: string, granularity: string, timezoneOffsetMinutes = 0): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return "invalid";
  d.setUTCMinutes(d.getUTCMinutes() + timezoneOffsetMinutes);
  if (granularity === "month")
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  if (granularity === "week") {
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() - day + 1);
  }
  return d.toISOString().slice(0, 10);
}
