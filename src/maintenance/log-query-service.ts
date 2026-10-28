import {
  TrafficRepository,
  type RecordRow,
  type RecordSummaryRow,
  type TaskDecodeSpeedStats,
  type TaskPricingAggregate,
  type TaskTokenSeriesPoint,
  type TaskCostSeriesPoint,
  type TaskOutputTokenSeriesPoint,
  type TaskSummaryRow,
} from "../persistence/index.js";
import { formatLocalTimestamp, StructuredLogger } from "../shared/index.js";
import { createLogExportStream } from "./log-export.js";
import {
  cleanupLogsOlderThan,
  cleanupLogsKeepLatest,
  cleanupSelectedLogGroups,
  type LogCleanupResult,
} from "./log-cleanup.js";
import type { Readable } from "node:stream";
import type { SummaryModelConfig } from "../config/index.js";
import type { TaskTimeline } from "./summary-answer.js";
import type { TimelineEvent } from "./summary-input.js";
import { SummaryGenerationService } from "./summary-generation-service.js";
import { SummaryModelClient, type SummaryModelConnectionReport } from "./summary-model-client.js";
import { UsageStatisticsService } from "./usage-statistics-service.js";

export interface LogGroupSummary {
  readonly cost?: LogTaskCost;
  readonly decode_speed_tps?: number;
  readonly preview?: LogGroupLogs;
  readonly id: string;
  readonly last_activity_at: string;
  readonly model: string | null;
  readonly request_count: number;
  readonly started_at: string;
  readonly target: string | null;
}

export interface TaskBrief {
  readonly task_id: string;
  readonly text: string;
  /** The checked overview, steps and gaps; absent for a brief made before timelines. */
  readonly timeline?: TaskTimeline | undefined;
  /** The numbered events the timeline cites, so the console can show what each number is. */
  readonly events?: readonly TimelineEvent[] | undefined;
  /** Environment facts the summary model read out of the newest request. */
  readonly context?: Readonly<Record<string, string>> | undefined;
  readonly model: string | null;
  readonly generated_at: string;
  readonly source_record_id: string | null;
  /** The `sequence` the source request had inside its task. */
  readonly source_sequence: number | null;
  /** How many events the source was normalized into. */
  readonly source_event_count: number | null;
  /** Whether the task has produced a newer finished request since this was generated. */
  readonly stale: boolean;
}

export interface LogTaskCost {
  readonly currency: "CNY";
  readonly known_amount: string | null;
  readonly pending_request_count: number;
  readonly priced_request_count: number;
  readonly unpriced_request_count: number;
}

export interface LogGroupPage {
  readonly groups: readonly LogGroupSummary[];
  readonly has_more: boolean;
  readonly limit: number;
  readonly next_offset: number;
  readonly offset: number;
  readonly total: number;
}

/** How one request's price stands: measured, still waiting, or known to have no price. */
export type LogPricingStatus = "pending" | "priced" | "unpriced";

export interface LogListItem {
  readonly end_to_end_speed_tps?: number;
  readonly cost?: LogRequestCost;
  readonly decode_speed_tps?: number;
  readonly endpoint: string;
  readonly has_summary: boolean;
  readonly id: string;
  readonly message_count: number | null;
  readonly method: string;
  readonly path: string;
  readonly sequence: string;
  readonly status: number | null;
  readonly target: string;
  readonly timestamp: string;
  readonly request_token_count: number | null;
  readonly response_token_count: number | null;
}

export interface LogPendingRecord extends LogListItem {
  readonly pending: boolean;
}

export interface LogRequestCost {
  readonly amount: string | null;
  readonly currency: "CNY";
  readonly reason: string | null;
  readonly status: LogPricingStatus;
}

export interface LogGroupLogs {
  readonly has_more: boolean;
  readonly id: string;
  readonly limit: number;
  readonly logs: readonly LogListItem[];
  readonly next_offset: number;
  readonly offset: number;
  readonly total: number;
}

/**
 * The pricing block a record detail carries. The matched rule and the measured usage are
 * stored as they arrived, so the block stays open; only the columns this project wrote are
 * named. Money stays in `cost_nano_cny` as text to keep precision.
 */
export type LogRecordPricing = Readonly<Record<string, unknown>>;

export interface LogRecordDetail {
  readonly id: string;
  readonly pending: boolean;
  /** The client's request body, kept as the arbitrary JSON it is. */
  readonly request: unknown;
  readonly request_meta: Readonly<Record<string, unknown>>;
  /** The upstream answer, kept as the arbitrary JSON it is. */
  readonly response: unknown;
  readonly response_meta: Readonly<Record<string, unknown>>;
  /** Null when the row carries no pricing block at all. */
  readonly pricing: LogRecordPricing | null;
  /** The measured generation window; only a finished record carries it. */
  readonly decode_window_ms?: number;
}

/** The fields the summary prompt asks the model for. */
export interface HistorySummaryFields {
  /** The model may omit any of these; the console has a fallback for each. */
  readonly title?: unknown;
  readonly overview?: unknown;
  /** Stage segments; always an array, because `parseSummaryPayload` refuses anything else. */
  readonly segments?: readonly unknown[];
  readonly decisions?: unknown;
  readonly issues?: unknown;
}

/**
 * A stored smart summary. The payload is the summary model's own JSON kept verbatim, so
 * keys this model does not name stay readable through the open half; only the fields the
 * prompt asks for are declared. Undefined means no summary exists for that record.
 */
export type HistorySummary = HistorySummaryFields & Record<string, unknown>;

/**
 * The log-backed views the console reads, plus the summary and brief operations it
 * offers. Every log root is resolved when a query runs rather than once at creation, so
 * a committed configuration change is visible without rebuilding anything. Model calls
 * are not this service's work: it hands summary and brief requests to
 * `SummaryGenerationService` and never assembles an upstream HTTP request.
 */
export class LogQueryService {
  readonly #logRoots: () => readonly string[];
  readonly #summaryModelClient: SummaryModelClient;
  readonly #summaries: SummaryGenerationService;

  constructor(
    logRoots: readonly string[] | (() => readonly string[]),
    logger: Pick<StructuredLogger, "warn"> = new StructuredLogger({
      service: "llm-proxy-maintenance",
    }),
  ) {
    this.#logRoots = typeof logRoots === "function" ? logRoots : () => logRoots;
    // Model calls are a separate service that works in the same log roots this service
    // resolves when a query runs, so a committed configuration change reaches both at once.
    // It also owns the diagnostics of those calls, which is where every warn goes.
    this.#summaryModelClient = new SummaryModelClient();
    this.#summaries = new SummaryGenerationService({
      logRoots: () => this.#configuredRoots(),
      logger,
      generator: this.#summaryModelClient,
    });
  }

  /**
   * Usage statistics resolve their log roots when a query runs instead of freezing them when the
   * service is created, so a committed configuration change takes effect without rebuilding the
   * service. With no roots the queries answer empty results of the same shape.
   */
  usageStatisticsService(): UsageStatisticsService {
    return new UsageStatisticsService({
      usageStatisticsRows: (from, to) =>
        this.#configuredRoots().flatMap((root) => {
          const repository = new TrafficRepository(root);
          try {
            return repository.usageStatisticsRows(from, to);
          } finally {
            repository.close();
          }
        }),
    });
  }

  /** The roots to query: blank paths dropped and duplicates removed. */
  #configuredRoots(): readonly string[] {
    return [...new Set(this.#logRoots().filter((root) => root !== ""))];
  }

  listGroups(query = "", limit = 100, offset = 0): LogGroupPage {
    const boundedLimit = Math.max(1, Math.min(integer(limit, 100), 500));
    const boundedOffset = Math.max(0, integer(offset, 0));
    const roots = this.#configuredRoots();
    if (roots.length === 0) {
      return emptyPage(boundedLimit, boundedOffset);
    }
    if (roots.length > 1) {
      return this.#listMergedGroups(roots, query, boundedLimit, boundedOffset);
    }
    const root = roots[0];
    if (root === undefined) {
      return emptyPage(boundedLimit, boundedOffset);
    }
    const repository = new TrafficRepository(root);
    try {
      const page = repository.listTaskSummaries(query, boundedLimit, boundedOffset);
      const pricing = repository.taskPricingForTasks(page.items.map((item) => item.id));
      const decodeStats = repository.taskDecodeSpeedStats(page.items.map((item) => item.id));
      return {
        groups: groupsWithPreviews(repository, page.items, query, pricing, decodeStats),
        total: page.total,
        limit: page.limit,
        offset: page.offset,
        next_offset: page.nextOffset,
        has_more: page.hasMore,
      };
    } finally {
      repository.close();
    }
  }

  getGroupLogs(
    groupId: string,
    query = "",
    limit = TASK_RECORD_LIMIT,
    offset = 0,
  ): LogGroupLogs | undefined {
    const boundedLimit = Math.max(1, Math.min(integer(limit, TASK_RECORD_LIMIT), 500));
    const boundedOffset = Math.max(0, integer(offset, 0));
    for (const root of this.#configuredRoots()) {
      const repository = new TrafficRepository(root);
      try {
        if (!repository.hasTask(groupId)) {
          continue;
        }
        const page = repository.listTaskRecordSummaries(
          groupId,
          query,
          boundedLimit,
          boundedOffset,
        );
        return {
          id: groupId,
          logs: page.items.map(logListItem),
          total: page.total,
          limit: page.limit,
          offset: page.offset,
          next_offset: page.nextOffset,
          has_more: page.hasMore,
        };
      } finally {
        repository.close();
      }
    }
    return undefined;
  }

  /**
   * Body-free rows for the given record ids, in descending sequence order, so
   * the admin UI can refresh in-flight records without decoding their bodies.
   * Ids that are not present in any log root are simply omitted.
   */
  listRecordsByIds(
    ids: readonly string[],
    limit = PENDING_RECORD_LIMIT,
  ): { records: readonly LogPendingRecord[] } {
    const boundedIds = ids.slice(0, Math.max(1, integer(limit, PENDING_RECORD_LIMIT)));
    if (boundedIds.length === 0) return { records: [] };
    const records: LogPendingRecord[] = [];
    const seen = new Set<string>();
    for (const root of this.#configuredRoots()) {
      const repository = new TrafficRepository(root);
      try {
        for (const row of repository.listRecordsByIds(boundedIds)) {
          const id = row.id;
          if (seen.has(id)) continue;
          seen.add(id);
          records.push({
            ...logListItem(row),
            pending: row.event === "request_pending_response",
          });
        }
      } finally {
        repository.close();
      }
    }
    return { records };
  }

  getRecordDetail(recordId: string): LogRecordDetail | undefined {
    for (const root of this.#configuredRoots()) {
      const repository = new TrafficRepository(root);
      try {
        const record = repository.getRecord(recordId);
        if (record !== undefined) {
          return recordDetail(record);
        }
      } finally {
        repository.close();
      }
    }
    return undefined;
  }

  /**
   * Generate a record's summary, store it, and hand back the model's own payload. The
   * generation service owns the cache, the concurrency guard, the storage write and the
   * model call; this service answers from the log roots and builds no request itself.
   */
  async summarizeRecord(
    recordId: string,
    config: SummaryModelConfig,
  ): Promise<HistorySummary | undefined> {
    return this.#summaries.summarizeRecord(recordId, config);
  }

  /** The stored summary for a record, or undefined when none was ever generated. */
  getSummary(recordId: string): HistorySummary | undefined {
    return this.#summaries.cachedSummary(recordId);
  }

  /**
   * The stored task brief: one short paragraph describing what the task is
   * working on, or undefined when it was never generated.
   */
  getTaskBrief(groupId: string): TaskBrief | undefined {
    return this.#summaries.cachedBrief(groupId);
  }

  /**
   * Generate the task brief by sending the task's newest complete request to
   * the configured summary model. Manual only: nothing generates a brief until
   * the user clicks the button, so no hidden model cost is incurred.
   */
  async generateTaskBrief(groupId: string, config: SummaryModelConfig): Promise<TaskBrief> {
    return this.#summaries.generateTaskBrief(groupId, config);
  }

  /**
   * Ask the configured summary model a one-word question and report what came back.
   * The client owns the URL, the headers, the timeout and the reading; this only hands
   * over the configuration the caller was given.
   */
  testSummaryModel(config: SummaryModelConfig): Promise<SummaryModelConnectionReport> {
    return this.#summaryModelClient.testConnection(config);
  }
  getGroupPricing(groupId: string): TaskPricingAggregate | undefined {
    for (const root of this.#configuredRoots()) {
      const repository = new TrafficRepository(root);
      try {
        const pricing = repository.taskPricing(groupId);
        if (pricing !== undefined) return pricing;
      } finally {
        repository.close();
      }
    }
    return undefined;
  }

  getGroupTokenSeries(groupId: string): readonly TaskTokenSeriesPoint[] | undefined {
    for (const root of this.#configuredRoots()) {
      const repository = new TrafficRepository(root);
      try {
        const series = repository.taskTokenSeries(groupId);
        if (series !== undefined) return series;
      } finally {
        repository.close();
      }
    }
    return undefined;
  }

  getGroupCostSeries(groupId: string): readonly TaskCostSeriesPoint[] | undefined {
    for (const root of this.#configuredRoots()) {
      const repository = new TrafficRepository(root);
      try {
        const series = repository.taskCostSeries(groupId);
        if (series !== undefined) return series;
      } finally {
        repository.close();
      }
    }
    return undefined;
  }

  getGroupOutputTokenSeries(groupId: string): readonly TaskOutputTokenSeriesPoint[] | undefined {
    for (const root of this.#configuredRoots()) {
      const repository = new TrafficRepository(root);
      try {
        const series = repository.taskOutputTokenSeries(groupId);
        if (series !== undefined) return series;
      } finally {
        repository.close();
      }
    }
    return undefined;
  }

  exportLogs(): Readable {
    return createLogExportStream(this.#configuredRoots());
  }

  cleanupSelectedGroups(groupIds: readonly string[]): LogCleanupResult {
    return cleanupSelectedLogGroups(this.#configuredRoots(), groupIds);
  }

  cleanupOlderThan(olderThanDays: number): LogCleanupResult {
    return cleanupLogsOlderThan(this.#configuredRoots(), olderThanDays);
  }

  cleanupKeepLatest(keepLatest: number): LogCleanupResult {
    return cleanupLogsKeepLatest(this.#configuredRoots(), keepLatest);
  }

  #listMergedGroups(
    roots: readonly string[],
    query: string,
    limit: number,
    offset: number,
  ): LogGroupPage {
    const tasks: TaskSummaryRow[] = [];
    const taskRoots = new Map<string, string>();
    let total = 0;
    const fetchLimit = offset + limit;
    for (const root of roots) {
      const repository = new TrafficRepository(root);
      try {
        const page = repository.listTaskSummaries(query, fetchLimit, 0);
        total += page.total;
        tasks.push(...page.items);
        for (const task of page.items) taskRoots.set(task.id, root);
      } finally {
        repository.close();
      }
    }
    tasks.sort((left, right) => taskSortTime(right) - taskSortTime(left));
    const visibleTasks = tasks.slice(offset, offset + limit);
    const summaries = new Map<string, LogGroupSummary>();
    for (const root of roots) {
      const rootTasks = visibleTasks.filter((task) => taskRoots.get(task.id) === root);
      if (!rootTasks.length) continue;
      const repository = new TrafficRepository(root);
      try {
        const pricing = repository.taskPricingForTasks(rootTasks.map((task) => task.id));
        const decodeStats = repository.taskDecodeSpeedStats(rootTasks.map((task) => task.id));
        if (!query.trim()) {
          for (const task of rootTasks) {
            const group = taskGroupSummary(task, pricing.get(task.id), decodeStats);
            summaries.set(group.id, group);
          }
          continue;
        }
        for (const group of groupsWithPreviews(
          repository,
          rootTasks,
          query,
          pricing,
          decodeStats,
        )) {
          summaries.set(group.id, group);
        }
      } finally {
        repository.close();
      }
    }
    const groups = visibleTasks.map((task) => summaries.get(task.id) ?? taskGroupSummary(task));
    const nextOffset = offset + groups.length;
    return {
      groups,
      total,
      limit,
      offset,
      next_offset: nextOffset,
      has_more: nextOffset < total,
    };
  }
}

export const TASK_RECORD_LIMIT = 200;
export const PENDING_RECORD_LIMIT = 200;

function groupsWithPreviews(
  repository: TrafficRepository,
  tasks: readonly TaskSummaryRow[],
  query: string,
  pricing = new Map<string, TaskPricingAggregate>(),
  decodeStats = new Map<string, TaskDecodeSpeedStats>(),
): LogGroupSummary[] {
  const previews = repository.listTaskSearchPreviews(
    tasks.map((task) => task.id),
    query,
  );
  return tasks.map((task) => {
    const group = taskGroupSummary(task, pricing.get(task.id), decodeStats);
    const page = previews.get(group.id);
    return page === undefined
      ? group
      : {
          ...group,
          preview: {
            id: group.id,
            logs: page.items.map(logListItem),
            total: page.total,
            limit: page.limit,
            offset: page.offset,
            next_offset: page.nextOffset,
            has_more: page.hasMore,
          },
        };
  });
}

function recordDetail(record: Readonly<RecordRow>): LogRecordDetail {
  const proxyName = record.proxy_name ?? "";
  const pending = record.event !== "request_finished";
  return {
    id: record.id,
    pending,
    request: record.request_body ?? null,
    response: record.response_body ?? null,
    pricing: isRecord(record.pricing) ? record.pricing : null,
    ...(pending
      ? {}
      : {
          decode_window_ms: recordDecodeMs(record) ?? 0,
        }),
    request_meta: compactMeta({
      id: record.id,
      task_id: record.task_id,
      sequence: record.sequence,
      timestamp: displayTimestamp(record.timestamp) || record.timestamp,
      duration_ms: record.duration_ms,
      method: record.method,
      path: record.path,
      endpoint: record.endpoint,
      target: record.target_url,
      proxy: proxyName === "" ? record.proxy_id : proxyName,
      client: clientAddress(record),
      message_count: record.message_count,
      model_route: record.model_route,
      stripped_fields: record.stripped_fields,
      injected_fields: record.injected_fields,
      added_upstream_headers: record.added_upstream_headers,
      headers: record.request_headers,
    }),
    response_meta: compactMeta({
      decode_window_ms: pending ? undefined : record.decode_window_ms,
      status: record.status,
      first_token_ms: pending ? undefined : record.first_token_ms,
      duration_ms: pending ? undefined : record.duration_ms,
      request_token_count: record.request_token_count,
      response_token_count: record.response_token_count,
      cached_token_count: cachedTokenCount(record),
      error: record.error,
      headers: record.response_headers,
    }),
  };
}

/**
 * Returns the part of the request prompt that hit the upstream prompt cache, or
 * undefined when the record has no persisted usage. Unpriced records keep their
 * measured usage, so a missing price rule no longer hides the cache hit.
 */
function cachedTokenCount(record: Readonly<RecordRow>): number | undefined {
  const usage = record.pricing.usage;
  const value = isRecord(usage) ? usage["cacheReadTokens"] : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function clientAddress(record: Readonly<RecordRow>): string {
  const host = record.client_host ?? "";
  const port = record.client_port;
  return host === "" ? "" : port === null ? host : `${host}:${port}`;
}

function compactMeta(values: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => !emptyMetaValue(value)));
}

function emptyMetaValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)
  );
}

function logListItem(record: Readonly<RecordSummaryRow>): LogListItem {
  const decodeSpeed = recordDecodeSpeedTps(record);
  const totalMs = optionalNumber(record.duration_ms) ?? 0;
  const output = optionalInteger(record.response_token_count) ?? 0;
  const fallback =
    decodeSpeed === undefined && record.event === "request_finished" && totalMs > 0 && output > 0;
  return {
    cost: requestCost(record),
    ...(fallback ? { end_to_end_speed_tps: (output * 1000) / totalMs } : {}),
    ...(decodeSpeed !== undefined ? { decode_speed_tps: decodeSpeed } : {}),
    has_summary: record.has_summary === 1,
    id: record.id,
    timestamp: displayTimestamp(record.timestamp) || record.timestamp,
    sequence: String(record.sequence),
    method: record.method,
    path: record.path,
    endpoint: record.endpoint,
    message_count: optionalInteger(record.message_count),
    status: optionalInteger(record.status),
    request_token_count: optionalInteger(record.request_token_count),
    response_token_count: optionalInteger(record.response_token_count),
    target: record.target_url ?? "",
  };
}

/**
 * The columns the console reads off a record: timing and money are present on both the
 * list projection and the detail projection.
 */
type RecordTimingRow = Readonly<RecordRow> | Readonly<RecordSummaryRow>;

/** Observed generation window; only old records fall back to historical timing. */
function recordDecodeMs(record: Readonly<RecordTimingRow>): number | undefined {
  if (record.event !== "request_finished") return undefined;
  const durationMs = optionalNumber(record.duration_ms);
  if (durationMs === null || durationMs < 1) return undefined;
  return (
    optionalNumber(record.decode_window_ms) ??
    durationMs - (optionalNumber(record.first_token_ms) ?? 0)
  );
}

function recordDecodeSpeedTps(record: Readonly<RecordTimingRow>): number | undefined {
  const outputTokens = optionalInteger(record.response_token_count) ?? 0;
  const decodeMs = recordDecodeMs(record);
  if (outputTokens <= 0 || decodeMs === undefined || decodeMs < 1) return undefined;
  return outputTokens / (decodeMs / 1000);
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : null;
}

function requestCost(record: Readonly<RecordSummaryRow>): LogRequestCost {
  const pricingStatus = record.pricing_status;
  const nano = record.cost_nano_cny;
  return {
    currency: "CNY",
    status: pricingStatus,
    reason: record.pricing_reason,
    amount: pricingStatus === "priced" && nano !== null ? nanoToCny(nano) : null,
  };
}

function taskSortTime(task: Readonly<TaskSummaryRow>): number {
  const timestamp = Date.parse(task.last_seen_at);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function taskGroupSummary(
  task: Readonly<TaskSummaryRow>,
  pricing?: TaskPricingAggregate,
  decodeStats = new Map<string, TaskDecodeSpeedStats>(),
): LogGroupSummary {
  const requestCount = integer(task.request_count, 0);
  const rawModel = optionalString(task.model);
  const model = rawModel === null ? null : basename(rawModel);
  const target = optionalString(task.target);
  const decode = decodeStats.get(task.id);
  const decodeSpeed =
    decode !== undefined && decode.decode_ms > 0 && decode.output_tokens > 0
      ? decode.output_tokens / (decode.decode_ms / 1000)
      : undefined;
  return {
    cost: taskCost(pricing),
    ...(decodeSpeed !== undefined ? { decode_speed_tps: decodeSpeed } : {}),
    id: task.id,
    last_activity_at: displayTimestamp(task.last_seen_at),
    model,
    request_count: requestCount,
    started_at: displayTimestamp(task.started_at),
    target,
  };
}

function taskCost(pricing: TaskPricingAggregate | undefined): LogTaskCost {
  return {
    currency: "CNY",
    known_amount:
      pricing?.cost_nano_cny === null || pricing === undefined
        ? null
        : nanoToCny(pricing.cost_nano_cny),
    priced_request_count: pricing?.priced_request_count ?? 0,
    unpriced_request_count: pricing?.unpriced_request_count ?? 0,
    pending_request_count: pricing?.pending_request_count ?? 0,
  };
}

function nanoToCny(nano: string): string {
  const value = BigInt(nano);
  const integer = value / 1_000_000_000n;
  const fraction = (value % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/u, "");
  return fraction === "" ? integer.toString() : `${integer}.${fraction}`;
}

function displayTimestamp(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    return "";
  }
  try {
    return formatLocalTimestamp(value);
  } catch {
    return value;
  }
}

function basename(value: string): string {
  return value.split(/[\\/]/u).at(-1) ?? value;
}

function string(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function optionalString(value: unknown): string | null {
  const text = string(value);
  return text === "" ? null : text;
}

function integer(value: unknown, fallback: number): number {
  const converted = typeof value === "number" ? value : Number(value);
  return Number.isInteger(converted) ? converted : fallback;
}

function optionalInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : integer(value, 0);
}

function emptyPage(limit: number, offset: number): LogGroupPage {
  return { groups: [], total: 0, limit, offset, next_offset: offset, has_more: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
