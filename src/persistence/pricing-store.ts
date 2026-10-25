import type Database from "better-sqlite3";

import { calculateCost, productToCnyDecimal } from "../pricing/index.js";
import {
  integerValue,
  optionalBigInt,
  optionalFloat,
  optionalInteger,
  optionalString,
  pricingStatus,
  recordTimestampMs,
  storedJsonObject,
  type PricingState,
} from "./column-codec.js";

/**
 * The pricing aggregation: what the stored records add up to for a group.
 *
 * This module changes when the money or timing口径 changes — a new billing bucket,
 * a different way to group frozen prices, a different span for the task wall time.
 * It only ever reads the `records` table; it writes nothing, so a change here
 * cannot move a stored row.
 */

export interface TaskPricingAggregate {
  readonly active_request_ms: number;
  readonly breakdown: TaskPricingBreakdown;
  /**
   * Wall-clock span from the first request's start to the last finished
   * request's end (last start + last duration), in milliseconds. Null when
   * the task has no finished request. Gap time between requests is included.
   */
  readonly total_request_ms: number | null;
  readonly cost_nano_cny: string | null;
  readonly groups: readonly TaskPricingGroup[];
  readonly pending_request_count: number;
  readonly priced_request_count: number;
  readonly target: string | null;
  readonly unpriced_reasons: Readonly<Record<string, number>>;
  readonly unpriced_request_count: number;
}

export interface TaskPricingBreakdown {
  readonly cache_read: PricingBucket;
  readonly cache_write: PricingBucket;
  readonly input_uncached: PricingBucket;
  readonly output: PricingBucket;
}

export interface PricingBucket {
  readonly amount: string;
  readonly tokens: string;
}

export interface TaskPricingGroup {
  readonly algorithm_version: number | null;
  readonly billing_model: string | null;
  readonly breakdown: TaskPricingBreakdown;
  readonly cost_nano_cny: string;
  readonly price: PricingPrice;
  readonly request_count: number;
}

export interface PricingPrice {
  readonly cache_read_per_million: string;
  readonly cache_write_per_million: string;
  readonly input_per_million: string;
  readonly output_per_million: string;
}

export interface TaskDecodeSpeedStats {
  readonly decode_ms: number;
  readonly output_tokens: number;
}

export interface TaskTokenSeriesPoint {
  readonly sequence: number;
  readonly request_tokens: number | null;
  readonly response_tokens: number | null;
  readonly total_tokens: number | null;
}

export interface TaskCostSeriesPoint {
  readonly sequence: number;
  /**
   * This request's own cost in nano-CNY. Only priced requests appear in the
   * series, in request-sequence order; unpriced/pending requests are skipped.
   */
  readonly cost_nano_cny: string;
}

export interface TaskOutputTokenSeriesPoint {
  readonly sequence: number;
  /**
   * This request's own output (response) tokens. Only requests with a known
   * output token count appear in the series, in request-sequence order;
   * requests whose output count is still unknown (pending or usage missing)
   * are skipped.
   */
  readonly output_tokens: number;
}

/** The record columns a task cost aggregate is built from; no body is read. */
export interface PricingRecordRowFields {
  readonly task_id: string;
  readonly event: string;
  readonly duration_ms: number;
  readonly started_at: string;
  readonly pricing_status: PricingState;
  readonly pricing_reason: string | null;
  readonly billing_model: string | null;
  readonly pricing_snapshot_json: string | null;
  readonly billing_usage_json: string | null;
  /** Money in nano-cent, as text so a large cost keeps every digit. */
  readonly cost_nano_cny: string | null;
}

/** One record as the pricing aggregation reads it. */
export type PricingRecordRow = PricingRecordRowFields & Record<string, unknown>;

/** The four money buckets a task aggregate adds up. */
type PricingBucketKey = "input_uncached" | "output" | "cache_read" | "cache_write";

interface MutablePricingBucket {
  amountProduct: bigint;
  tokens: bigint;
}

interface MutablePricingGroup {
  algorithmVersion: number | null;
  billingModel: string | null;
  breakdown: Record<PricingBucketKey, MutablePricingBucket>;
  costNanoCny: bigint;
  price: PricingPrice;
  requestCount: number;
}

interface MutableTaskPricingAggregate {
  activeRequestMs: number;
  firstStartMs: number | null;
  lastFinishedEndMs: number | null;
  breakdown: Record<PricingBucketKey, MutablePricingBucket>;
  costNanoCny: bigint;
  groups: Map<string, MutablePricingGroup>;
  pendingRequestCount: number;
  pricedRequestCount: number;
  target: string | null;
  unpricedReasons: Record<string, number>;
  unpricedRequestCount: number;
}

/** The per-request token counts of a group, as the detail chart reads them. */
export interface TokenSeriesRow {
  readonly sequence: number;
  readonly request_token_count: number | null;
  readonly response_token_count: number | null;
}

/** The per-request money of a group, as the detail chart reads it. */
export interface CostSeriesRow {
  readonly sequence: number;
  readonly cost_nano_cny: string;
}

/** The per-request output tokens of a group, as the detail chart reads them. */
export interface OutputTokenSeriesRow {
  readonly sequence: number;
  readonly response_token_count: number;
}

export class PricingStore {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  /** The cost, timing and price-group breakdown of each of the given tasks. */
  forTasks(taskIds: readonly string[]): Map<string, TaskPricingAggregate> {
    const ids = [...new Set(taskIds.filter((id) => id !== ""))];
    if (ids.length === 0) return new Map();
    const aggregates = new Map<string, MutableTaskPricingAggregate>();
    for (const id of ids) aggregates.set(id, newTaskPricingAggregate(null));
    const rows = this.#database
      .prepare(
        `SELECT task_id, event, duration_ms, started_at, pricing_status, pricing_reason, billing_model, pricing_snapshot_json,
          billing_usage_json, CAST(cost_nano_cny AS TEXT) AS cost_nano_cny
         FROM records WHERE task_id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids) as readonly PricingRecordRow[];
    for (const row of rows) {
      const aggregate = aggregates.get(row.task_id);
      if (aggregate !== undefined) addPricingRow(aggregate, row);
    }
    return new Map(
      [...aggregates].map(([id, aggregate]) => [id, finalizeTaskPricingAggregate(aggregate)]),
    );
  }

  /**
   * Aggregate observable generation windows, excluding buffered responses (0).
   * NULL windows retain the historical calculation for pre-v11 records.
   */
  decodeSpeedStats(taskIds: readonly string[]): Map<string, TaskDecodeSpeedStats> {
    const ids = [...new Set(taskIds.filter((id) => id !== ""))];
    if (ids.length === 0) return new Map();
    const rows = this.#database
      .prepare(
        `SELECT task_id,
          SUM(CASE WHEN response_token_count > 0 AND COALESCE(decode_window_ms, duration_ms - COALESCE(first_token_ms, 0)) >= 1
               THEN response_token_count ELSE 0 END) AS output_tokens,
          SUM(CASE WHEN response_token_count > 0 AND COALESCE(decode_window_ms, duration_ms - COALESCE(first_token_ms, 0)) >= 1
               THEN COALESCE(decode_window_ms, duration_ms - COALESCE(first_token_ms, 0)) ELSE 0 END) AS decode_ms
         FROM records
         WHERE event = 'request_finished'
           AND task_id IN (${ids.map(() => "?").join(",")})
         GROUP BY task_id`,
      )
      .all(...ids) as readonly {
      task_id: string;
      output_tokens: number | null;
      decode_ms: number | null;
    }[];
    const stats = new Map<string, TaskDecodeSpeedStats>();
    for (const row of rows) {
      stats.set(row.task_id, {
        output_tokens: row.output_tokens ?? 0,
        decode_ms: row.decode_ms ?? 0,
      });
    }
    return stats;
  }

  /**
   * Per-request token counts for the task-detail chart, ordered by request
   * sequence. `total_tokens` is request + response when at least one side is
   * known; pending requests (no counts yet) carry nulls and are skipped by
   * the chart.
   */
  tokenSeries(taskId: string): readonly TaskTokenSeriesPoint[] {
    const rows = this.#database
      .prepare(
        `SELECT sequence, request_token_count, response_token_count
         FROM records WHERE task_id = ? ORDER BY sequence`,
      )
      .all(taskId) as readonly TokenSeriesRow[];
    return rows.map((row) => {
      const request = row.request_token_count;
      const response = row.response_token_count;
      return {
        sequence: integerValue(row.sequence, 0),
        request_tokens: request,
        response_tokens: response,
        total_tokens:
          request === null && response === null ? null : (request ?? 0) + (response ?? 0),
      };
    });
  }

  /**
   * Per-request cost for the task-detail chart, ordered by request sequence.
   * Each point carries that request's own cost; unpriced/pending requests
   * without a cost are skipped.
   */
  costSeries(taskId: string): readonly TaskCostSeriesPoint[] {
    const rows = this.#database
      .prepare(
        `SELECT sequence, CAST(cost_nano_cny AS TEXT) AS cost_nano_cny
         FROM records
         WHERE task_id = ? AND cost_nano_cny IS NOT NULL
         ORDER BY sequence`,
      )
      .all(taskId) as readonly CostSeriesRow[];
    return rows.map((row) => ({
      sequence: integerValue(row.sequence, 0),
      cost_nano_cny: row.cost_nano_cny,
    }));
  }

  /**
   * Per-request output tokens for the task-detail chart, ordered by request
   * sequence. Each point carries this request's own output (response)
   * tokens; requests without a known output token count are skipped.
   */
  outputTokenSeries(taskId: string): readonly TaskOutputTokenSeriesPoint[] {
    const rows = this.#database
      .prepare(
        `SELECT sequence, response_token_count
         FROM records
         WHERE task_id = ? AND response_token_count IS NOT NULL
         ORDER BY sequence`,
      )
      .all(taskId) as readonly OutputTokenSeriesRow[];
    return rows.map((row) => ({
      sequence: integerValue(row.sequence, 0),
      output_tokens: row.response_token_count,
    }));
  }
}

function newTaskPricingAggregate(target: string | null): MutableTaskPricingAggregate {
  return {
    target,
    activeRequestMs: 0,
    firstStartMs: null,
    lastFinishedEndMs: null,
    costNanoCny: 0n,
    pricedRequestCount: 0,
    unpricedRequestCount: 0,
    pendingRequestCount: 0,
    unpricedReasons: {},
    groups: new Map(),
    breakdown: pricingBreakdownMutable(),
  };
}

function addPricingRow(
  aggregate: MutableTaskPricingAggregate,
  row: Readonly<PricingRecordRow>,
): void {
  // Wall time a request spent inside the proxy, from send to finish. Only
  // finished requests carry a measured duration; gap time between requests
  // never lands in a record, so summing is exactly the requested total.
  if (row.event === "request_finished") {
    aggregate.activeRequestMs += optionalFloat(row.duration_ms) ?? 0;
    // Task span: the first request's start and the last request's end. A
    // request is "last" only once finished, so an in-flight request does
    // not extend the span until it ends.
    const startedMs = recordTimestampMs(row.started_at);
    if (startedMs !== null) {
      aggregate.firstStartMs =
        aggregate.firstStartMs === null ? startedMs : Math.min(aggregate.firstStartMs, startedMs);
    }
    const endedMs = startedMs !== null ? startedMs + (optionalFloat(row.duration_ms) ?? 0) : null;
    if (endedMs !== null) {
      aggregate.lastFinishedEndMs =
        aggregate.lastFinishedEndMs === null
          ? endedMs
          : Math.max(aggregate.lastFinishedEndMs, endedMs);
    }
  }
  const status = pricingStatus(row.pricing_status);
  if (status === "pending") {
    aggregate.pendingRequestCount += 1;
    return;
  }
  if (status !== "priced") {
    aggregate.unpricedRequestCount += 1;
    const reason = optionalString(row.pricing_reason) ?? "unknown";
    aggregate.unpricedReasons[reason] = (aggregate.unpricedReasons[reason] ?? 0) + 1;
    return;
  }
  const cost = optionalBigInt(row.cost_nano_cny);
  const usage = storedJsonObject(row.billing_usage_json);
  const snapshot = storedJsonObject(row.pricing_snapshot_json);
  const price = pricingPrice(snapshot);
  const buckets = usageBuckets(usage);
  if (cost === null || price === undefined || buckets === undefined) {
    aggregate.unpricedRequestCount += 1;
    aggregate.unpricedReasons["invalid_pricing_record"] =
      (aggregate.unpricedReasons["invalid_pricing_record"] ?? 0) + 1;
    return;
  }
  const calculated = calculateCost(buckets, price);
  aggregate.pricedRequestCount += 1;
  aggregate.costNanoCny += cost;
  const billingModel = optionalString(row.billing_model);
  const algorithmVersion = optionalInteger(snapshot["algorithm_version"]);
  const groupKey = JSON.stringify({ billingModel, algorithmVersion, ...price });
  let group = aggregate.groups.get(groupKey);
  if (group === undefined) {
    group = {
      billingModel,
      algorithmVersion,
      price,
      requestCount: 0,
      costNanoCny: 0n,
      breakdown: pricingBreakdownMutable(),
    };
    aggregate.groups.set(groupKey, group);
  }
  group.requestCount += 1;
  group.costNanoCny += cost;
  addBuckets(aggregate.breakdown, buckets, calculated.breakdown);
  addBuckets(group.breakdown, buckets, calculated.breakdown);
}

/** The four token buckets of a stored usage document, or nothing when a bucket is missing. */
function usageBuckets(usage: Readonly<Record<string, unknown>>):
  | {
      cacheReadTokens: bigint;
      cacheWriteTokens: bigint;
      inputUncachedTokens: bigint;
      outputTokens: bigint;
    }
  | undefined {
  const read = optionalBigInt(usage["cacheReadTokens"]);
  const write = optionalBigInt(usage["cacheWriteTokens"]);
  const input = optionalBigInt(usage["inputUncachedTokens"]);
  const output = optionalBigInt(usage["outputTokens"]);
  if (read === null || write === null || input === null || output === null) return undefined;
  return {
    cacheReadTokens: read,
    cacheWriteTokens: write,
    inputUncachedTokens: input,
    outputTokens: output,
  };
}

/** The per-million prices a frozen pricing snapshot carries, or nothing when it has none. */
function pricingPrice(snapshot: Readonly<Record<string, unknown>>): PricingPrice | undefined {
  const input = snapshot["input_per_million"];
  const output = snapshot["output_per_million"];
  const cacheRead = snapshot["cache_read_per_million"];
  const cacheWrite = snapshot["cache_write_per_million"];
  return typeof input === "string" &&
    typeof output === "string" &&
    typeof cacheRead === "string" &&
    typeof cacheWrite === "string"
    ? {
        input_per_million: input,
        output_per_million: output,
        cache_read_per_million: cacheRead,
        cache_write_per_million: cacheWrite,
      }
    : undefined;
}

function pricingBreakdownMutable(): Record<PricingBucketKey, MutablePricingBucket> {
  return {
    input_uncached: { tokens: 0n, amountProduct: 0n },
    output: { tokens: 0n, amountProduct: 0n },
    cache_read: { tokens: 0n, amountProduct: 0n },
    cache_write: { tokens: 0n, amountProduct: 0n },
  };
}

function addBuckets(
  target: MutableTaskPricingAggregate["breakdown"],
  usage: NonNullable<ReturnType<typeof usageBuckets>>,
  calculated: ReturnType<typeof calculateCost>["breakdown"],
): void {
  target.input_uncached.tokens += usage.inputUncachedTokens;
  target.input_uncached.amountProduct += calculated.inputUncachedProduct;
  target.output.tokens += usage.outputTokens;
  target.output.amountProduct += calculated.outputProduct;
  target.cache_read.tokens += usage.cacheReadTokens;
  target.cache_read.amountProduct += calculated.cacheReadProduct;
  target.cache_write.tokens += usage.cacheWriteTokens;
  target.cache_write.amountProduct += calculated.cacheWriteProduct;
}

function finalizeTaskPricingAggregate(
  aggregate: MutableTaskPricingAggregate,
): TaskPricingAggregate {
  const firstStart = aggregate.firstStartMs;
  const lastEnd = aggregate.lastFinishedEndMs;
  return {
    target: aggregate.target,
    active_request_ms: aggregate.activeRequestMs,
    total_request_ms:
      firstStart === null || lastEnd === null ? null : Math.max(0, lastEnd - firstStart),
    cost_nano_cny: aggregate.pricedRequestCount === 0 ? null : aggregate.costNanoCny.toString(),
    priced_request_count: aggregate.pricedRequestCount,
    unpriced_request_count: aggregate.unpricedRequestCount,
    pending_request_count: aggregate.pendingRequestCount,
    unpriced_reasons: aggregate.unpricedReasons,
    breakdown: pricingBreakdown(aggregate.breakdown),
    groups: [...aggregate.groups.values()].map((group) => ({
      billing_model: group.billingModel,
      algorithm_version: group.algorithmVersion,
      price: group.price,
      request_count: group.requestCount,
      cost_nano_cny: group.costNanoCny.toString(),
      breakdown: pricingBreakdown(group.breakdown),
    })),
  };
}

function pricingBreakdown(mutable: MutableTaskPricingAggregate["breakdown"]): TaskPricingBreakdown {
  const bucket = (value: MutablePricingBucket): PricingBucket => ({
    tokens: value.tokens.toString(),
    amount: productToCnyDecimal(value.amountProduct),
  });
  return {
    input_uncached: bucket(mutable.input_uncached),
    output: bucket(mutable.output),
    cache_read: bucket(mutable.cache_read),
    cache_write: bucket(mutable.cache_write),
  };
}
