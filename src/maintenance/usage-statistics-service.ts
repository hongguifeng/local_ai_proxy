import { recordText, type RepositoryRecord } from "../persistence/repository.js";
interface StatisticsRepository {
  usageStatisticsRows(from: string, to: string): readonly RepositoryRecord[];
}

export type StatisticsMetric = "token" | "cost";

/** How a trend is split inside each bucket. */
export type UsageStatisticsBreakdown = "total" | "model" | "target";

/** Why requests were left out of the totals, and how many of each reason. */
export type UsageStatisticsUnpriced = Readonly<Record<string, number>>;

/** The token and money totals of everything priced in the window. */
export interface UsageStatisticsTotals {
  readonly requests: number;
  readonly tasks: number;
  readonly input: string;
  readonly output: string;
  readonly cache_read: string;
  readonly cache_write: string;
  readonly cost: string;
}

/** One target or model with its own totals, ranked by request count. */
export interface UsageStatisticsBucket {
  readonly id: string;
  readonly requests: number;
  readonly tasks: number;
  readonly input: string;
  readonly output: string;
  readonly cache_read: string;
  readonly cache_write: string;
  readonly cost: string;
  /** The size of this bucket in the metric the caller asked for. */
  readonly value: string;
}

export interface UsageStatisticsOverview {
  readonly dataVersion: 1;
  readonly totals: UsageStatisticsTotals;
  readonly byTarget: readonly UsageStatisticsBucket[];
  readonly byModel: readonly UsageStatisticsBucket[];
  readonly unpriced: UsageStatisticsUnpriced;
}

/** One model or target inside a trend bucket, when the breakdown asked for one. */
export interface UsageStatisticsBreakdownEntry {
  readonly id: string;
  readonly requests: number;
  readonly tasks: number;
  readonly input: string;
  readonly output: string;
  readonly cache_read: string;
  readonly cache_write: string;
  readonly cost: string;
  readonly unpriced: number;
}

/** One bucket of the trend; tokens and money are text to keep large values exact. */
export interface UsageStatisticsTrendPoint {
  readonly bucket: string;
  readonly requests: number;
  readonly tasks: number;
  readonly input: string;
  readonly output: string;
  readonly cache_read: string;
  readonly cache_write: string;
  readonly cost: string;
  readonly unpriced: number;
  readonly by_model: readonly UsageStatisticsBreakdownEntry[];
  readonly by_target: readonly UsageStatisticsBreakdownEntry[];
}

export interface UsageStatisticsTrend {
  readonly dataVersion: 1;
  readonly granularity: string;
  readonly points: readonly UsageStatisticsTrendPoint[];
}

/** What one bucket accumulates while its rows are read; counters are exact. */
interface StatisticsAccumulator {
  input: bigint;
  output: bigint;
  cacheRead: bigint;
  cacheWrite: bigint;
  cost: bigint;
  requests: number;
  unpriced: number;
  tasks: Map<string, number>;
}

interface TrendPointGroup {
  total: StatisticsAccumulator;
  byModel: Map<string, StatisticsAccumulator>;
  byTarget: Map<string, StatisticsAccumulator>;
}

const empty = (): StatisticsAccumulator => ({
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
    const targets = new Map<string, StatisticsAccumulator>();
    const models = new Map<string, StatisticsAccumulator>();
    const total = empty();
    const unpriced: Record<string, number> = {};
    for (const row of this.repository.usageStatisticsRows(from, to)) {
      const bucket = this.rowBucket(row, unpriced);
      if (bucket === undefined) continue;
      this.add(total, bucket, row);
      const targetKey = recordText(row, "unknown", "target_name", "target_id", "target_url");
      const modelKey = recordText(row, "unknown", "billing_model");
      const target = targets.get(targetKey) ?? empty();
      const model = models.get(modelKey) ?? empty();
      this.add(target, bucket, row);
      this.add(model, bucket, row);
      targets.set(targetKey, target);
      models.set(modelKey, model);
    }
    const project = (map: Map<string, StatisticsAccumulator>) => {
      const rows = [...map].sort((a, b) => b[1].requests - a[1].requests);
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
    breakdown: UsageStatisticsBreakdown = "total",
  ): UsageStatisticsTrend {
    const points = new Map<string, TrendPointGroup>();
    for (const row of this.repository.usageStatisticsRows(from, to)) {
      if (targetId !== undefined && recordText(row, "", "target_id", "target_url") !== targetId)
        continue;
      if (model !== undefined && recordText(row, "", "billing_model") !== model) continue;
      const key = bucketKey(String(row["timestamp"]), granularity, timezoneOffsetMinutes);
      const value = points.get(key) ?? {
        total: empty(),
        byModel: new Map<string, StatisticsAccumulator>(),
        byTarget: new Map<string, StatisticsAccumulator>(),
      };
      const parsed = this.rowBucket(row, {});
      if (parsed !== undefined) {
        this.add(value.total, parsed, row);
        const modelKey = recordText(row, "unknown", "billing_model");
        const targetKey = recordText(row, "unknown", "target_name", "target_id", "target_url");
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
          const serialize = (m: Map<string, StatisticsAccumulator>) =>
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

  private add(to: StatisticsAccumulator, from: StatisticsAccumulator, row: RepositoryRecord): void {
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
  ): StatisticsAccumulator | undefined {
    if (row["pricing_status"] !== "priced") {
      const r = recordText(row, "unknown", "pricing_reason", "pricing_status");
      unpriced[r] = (unpriced[r] ?? 0) + 1;
      return undefined;
    }
    try {
      const rawUsage: unknown = JSON.parse(recordText(row, "{}", "billing_usage_json"));
      const u = (typeof rawUsage === "object" && rawUsage !== null ? rawUsage : {}) as Record<
        string,
        unknown
      >;
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
        cost: BigInt(recordText(row, "0", "cost_nano_cny")),
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
