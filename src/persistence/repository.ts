import type Database from "better-sqlite3";

import { calculateCost, productToCnyDecimal } from "../pricing/index.js";
import { formatLocalTimestamp, localNowIso } from "../shared/index.js";
import { loadRecordBody, replaceRecordBody } from "./body-storage.js";
import { connectLogDatabase } from "./database.js";

export type RepositoryRecord = Record<string, unknown>;

/**
 * Returns the first non-null cell of `row` as text, or `fallback` when every
 * listed key is null, undefined, or not a primitive value.
 */
export function recordText(row: RepositoryRecord, fallback: string, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value === null || value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      return String(value);
  }
  return fallback;
}

export interface TrafficRepositoryOptions {
  readonly now?: () => string;
}

export interface RepositoryPage<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly nextOffset: number;
  readonly hasMore: boolean;
}

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
   * Cumulative output (response) tokens from the task start through this
   * request; requests whose output token count is unknown (pending or
   * usage missing) count as zero, so the series is non-decreasing.
   */
  readonly output_tokens: number;
}

export class TrafficRepository {
  get database(): Database.Database {
    return this.#database;
  }
  readonly #database: Database.Database;
  readonly #now: () => string;

  constructor(logRoot: string, options: TrafficRepositoryOptions = {}) {
    this.#database = connectLogDatabase(logRoot);
    this.#now = options.now ?? localNowIso;
    this.#database.function("_search_text", { varargs: true }, (...values: unknown[]) =>
      searchText(...values),
    );
  }

  close(): void {
    this.#database.close();
  }

  transaction<T>(work: () => T): T {
    return this.#database.transaction(work)();
  }

  upsertTask(task: Readonly<RepositoryRecord>): RepositoryRecord {
    const now = this.#now();
    const values = {
      id: String(requiredValue(task, "id")),
      kind: stringValue(task["kind"]) || "request",
      endpoint: optionalString(task["endpoint"]),
      anchor: optionalString(task["anchor"]),
      model: optionalString(task["model"]),
      target: optionalString(task["target"]),
      started_at: stringValue(task["started_at"] ?? task["last_seen_at"]) || now,
      last_seen_at: stringValue(task["last_seen_at"] ?? task["started_at"]) || now,
      last_response_at: optionalString(task["last_response_at"]),
      request_count: integerValue(task["request_count"], 0),
      pending_request_only: task["pending_request_only"] ? 1 : 0,
      match_confidence: floatValue(task["match_confidence"] ?? task["last_match_confidence"], 1),
      match_strategy_version: integerValue(task["match_strategy_version"], 1),
      fingerprints_json: jsonText(task["fingerprints"], {}),
      boundary_fingerprints_json: jsonText(task["boundary_fingerprints"], {}),
      last_user_messages_json: jsonText(task["last_user_messages"], []),
      created_at: stringValue(task["created_at"]) || now,
      updated_at: stringValue(task["updated_at"]) || now,
    };
    this.#database
      .prepare(
        `
        INSERT INTO tasks(
          id, kind, endpoint, anchor, model, target, started_at, last_seen_at, last_response_at,
          request_count, pending_request_only, match_confidence, match_strategy_version,
          fingerprints_json, boundary_fingerprints_json, last_user_messages_json,
          created_at, updated_at
        ) VALUES (
          @id, @kind, @endpoint, @anchor, @model, @target, @started_at, @last_seen_at, @last_response_at,
          @request_count, @pending_request_only, @match_confidence, @match_strategy_version,
          @fingerprints_json, @boundary_fingerprints_json, @last_user_messages_json,
          @created_at, @updated_at
        )
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          endpoint = excluded.endpoint,
          anchor = excluded.anchor,
          model = excluded.model,
          target = excluded.target,
          started_at = excluded.started_at,
          last_seen_at = excluded.last_seen_at,
          last_response_at = excluded.last_response_at,
          request_count = excluded.request_count,
          pending_request_only = excluded.pending_request_only,
          match_confidence = excluded.match_confidence,
          match_strategy_version = excluded.match_strategy_version,
          fingerprints_json = excluded.fingerprints_json,
          boundary_fingerprints_json = excluded.boundary_fingerprints_json,
          last_user_messages_json = excluded.last_user_messages_json,
          updated_at = excluded.updated_at
      `,
      )
      .run(values);
    const loaded = this.getTask(values.id);
    if (loaded === undefined) {
      throw new Error(`Task ${values.id} was not saved.`);
    }
    return loaded;
  }

  getTask(taskId: string): RepositoryRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    return row === undefined ? undefined : decodeTaskRow(row as RepositoryRecord);
  }

  hasTask(taskId: string): boolean {
    return this.#database.prepare("SELECT 1 FROM tasks WHERE id = ?").get(taskId) !== undefined;
  }

  recentTasks(limit = 200): RepositoryRecord[] {
    const boundedLimit = Math.max(1, Math.min(integerValue(limit, 200), 1_000));
    const rows = this.#database
      .prepare(
        `
        SELECT *
        FROM tasks
        WHERE pending_request_only = 0
        ORDER BY COALESCE(last_seen_at, last_response_at, started_at) DESC
        LIMIT ?
      `,
      )
      .all(boundedLimit) as RepositoryRecord[];
    return rows.map((row) => decodeTaskRow(row));
  }

  listTasks(query = "", limit = 100, offset = 0): RepositoryPage<RepositoryRecord> {
    const boundedLimit = Math.max(1, Math.min(integerValue(limit, 100), 500));
    const boundedOffset = Math.max(0, integerValue(offset, 0));
    const terms = searchTerms(query);
    const clauses = terms.map(
      () => `(
          lower(_search_text(
            id, kind, endpoint, anchor, model, target, started_at, last_seen_at, last_response_at,
            request_count, pending_request_only, match_confidence, match_strategy_version,
            fingerprints_json, boundary_fingerprints_json, last_user_messages_json, created_at, updated_at
          )) LIKE ? ESCAPE '\\'
          OR tasks.id IN (
            SELECT record_search_map.task_id
            FROM record_search_fts
            JOIN record_search_map ON record_search_map.search_rowid = record_search_fts.rowid
            WHERE record_search_fts MATCH ?
          )
        )`,
    );
    const whereSql = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const parameters = terms.flatMap((term) => [likePattern(term), ftsQuery(term)]);
    const total = this.#database
      .prepare(`SELECT COUNT(*) AS count FROM tasks ${whereSql}`)
      .pluck()
      .get(...parameters) as number;
    const rows = this.#database
      .prepare(
        `
        SELECT tasks.*,
          COALESCE(
            NULLIF(tasks.target, ''),
            (
              SELECT records.target_url
              FROM records
              WHERE records.task_id = tasks.id
                AND records.target_url IS NOT NULL
                AND records.target_url != ''
              ORDER BY records.sequence DESC
              LIMIT 1
            )
          ) AS target
        FROM tasks
        ${whereSql}
        ORDER BY COALESCE(last_seen_at, last_response_at, started_at) DESC
        LIMIT ? OFFSET ?
      `,
      )
      .all(...parameters, boundedLimit, boundedOffset) as RepositoryRecord[];
    const items = rows.map((row) => decodeTaskRow(row));
    const nextOffset = boundedOffset + items.length;
    return {
      items,
      total,
      limit: boundedLimit,
      offset: boundedOffset,
      nextOffset,
      hasMore: nextOffset < total,
    };
  }

  listTaskSummaries(query = "", limit = 100, offset = 0): RepositoryPage<RepositoryRecord> {
    const boundedLimit = Math.max(1, Math.min(integerValue(limit, 100), 500));
    const boundedOffset = Math.max(0, integerValue(offset, 0));
    const terms = searchTerms(query);
    // Keep the group predicate identical to the record predicate used by
    // listTaskRecordSummaries: one FTS row of the task must match every
    // term, so a listed group always contains at least one expandable record.
    // The subquery must stay uncorrelated: a correlated EXISTS makes SQLite
    // full-scan the contentless FTS table once per group row (minutes on a
    // real database), while this form evaluates the FTS query exactly once
    // and then resolves groups by primary key.
    const whereSql =
      terms.length === 0
        ? ""
        : `WHERE tasks.id IN (
          SELECT record_search_map.task_id
          FROM record_search_fts
          JOIN record_search_map ON record_search_map.search_rowid = record_search_fts.rowid
          WHERE record_search_fts MATCH ?
        )`;
    const parameters = terms.length ? [terms.map((term) => ftsQuery(term)).join(" AND ")] : [];
    const total = this.#database
      .prepare(`SELECT COUNT(*) AS count FROM tasks ${whereSql}`)
      .pluck()
      .get(...parameters) as number;
    const items = this.#database
      .prepare(
        `
        SELECT id, model, started_at, last_seen_at, last_response_at, request_count,
          COALESCE(
            NULLIF(tasks.target, ''),
            (
              SELECT records.target_url
              FROM records
              WHERE records.task_id = tasks.id
                AND records.target_url IS NOT NULL
                AND records.target_url != ''
              ORDER BY records.sequence DESC
              LIMIT 1
            )
          ) AS target
        FROM tasks
        ${whereSql}
        ORDER BY COALESCE(last_seen_at, last_response_at, started_at) DESC
        LIMIT ? OFFSET ?
      `,
      )
      .all(...parameters, boundedLimit, boundedOffset) as RepositoryRecord[];
    const nextOffset = boundedOffset + items.length;
    return {
      items,
      total,
      limit: boundedLimit,
      offset: boundedOffset,
      nextOffset,
      hasMore: nextOffset < total,
    };
  }

  upsertRecord(record: Readonly<RepositoryRecord>): RepositoryRecord {
    const now = this.#now();
    const pricing = recordValue(record["pricing"]);
    const values = {
      id: String(requiredValue(record, "id")),
      task_id: String(requiredValue(record, "task_id")),
      sequence: integerValue(record["sequence"], 1),
      event: stringValue(record["event"]) || "request_finished",
      timestamp: stringValue(record["timestamp"]) || now,
      started_at:
        stringValue(record["started_at"] ?? record["started_timestamp"] ?? record["timestamp"]) ||
        now,
      duration_ms: floatValue(record["duration_ms"], 0),
      first_token_ms: optionalFloat(record["first_token_ms"]),
      proxy_id: optionalString(record["proxy_id"]),
      proxy_name: optionalString(record["proxy_name"]),
      client_host: optionalString(record["client_host"]),
      client_port: optionalInteger(record["client_port"]),
      target_id: optionalString(record["target_id"]),
      target_name: optionalString(record["target_name"]),
      target_url: optionalString(record["target_url"]),
      method: stringValue(record["method"]),
      path: stringValue(record["path"]),
      endpoint: stringValue(record["endpoint"] ?? record["path"]),
      status: optionalInteger(record["status"]),
      error: optionalString(record["error"]),
      message_count: optionalInteger(record["message_count"]),
      token_count: optionalInteger(record["token_count"]),
      request_token_count: optionalInteger(record["request_token_count"]),
      response_token_count: optionalInteger(record["response_token_count"]),
      pricing_status: pricingStatus(pricing["pricing_status"]),
      pricing_reason: optionalString(pricing["pricing_reason"]),
      billing_model: optionalString(pricing["billing_model"]),
      pricing_snapshot_json: optionalJsonText(pricing["pricing_snapshot"]),
      billing_usage_json: optionalJsonText(pricing["usage"]),
      cost_nano_cny: optionalBigInt(pricing["cost_nano_cny"]),
      request_headers_json: jsonText(record["request_headers"], {}),
      response_headers_json: jsonText(record["response_headers"], {}),
      request_body_json: optionalJsonText(record["request_body"]),
      original_request_body_json: optionalJsonText(record["original_request_body"]),
      response_body_json: optionalJsonText(record["response_body"]),
      model_route_json: optionalJsonText(record["model_route"]),
      stripped_fields_json: jsonText(record["stripped_fields"], []),
      injected_fields_json: jsonText(record["injected_fields"], []),
      added_upstream_headers_json: jsonText(record["added_upstream_headers"], []),
      created_at: stringValue(record["created_at"]) || now,
      updated_at: stringValue(record["updated_at"]) || now,
    };
    const save = this.#database.transaction(() => {
      this.#database
        .prepare(
          `
      INSERT INTO records(
        id, task_id, sequence, event, timestamp, started_at, duration_ms, first_token_ms,
        proxy_id, proxy_name, client_host, client_port, target_id, target_name, target_url,
        method, path, endpoint, status, error, message_count, token_count,
        request_token_count, response_token_count,
        pricing_status, pricing_reason, billing_model, pricing_snapshot_json, billing_usage_json, cost_nano_cny,
        request_headers_json, response_headers_json, request_body_json, original_request_body_json,
        response_body_json,
        model_route_json, stripped_fields_json, injected_fields_json, added_upstream_headers_json,
        created_at, updated_at
      ) VALUES (
        @id, @task_id, @sequence, @event, @timestamp, @started_at, @duration_ms, @first_token_ms,
        @proxy_id, @proxy_name, @client_host, @client_port, @target_id, @target_name, @target_url,
        @method, @path, @endpoint, @status, @error, @message_count, @token_count,
        @request_token_count, @response_token_count,
        @pricing_status, @pricing_reason, @billing_model, @pricing_snapshot_json, @billing_usage_json, @cost_nano_cny,
        @request_headers_json, @response_headers_json, NULL,
        NULL, NULL,
        @model_route_json, @stripped_fields_json, @injected_fields_json, @added_upstream_headers_json,
        @created_at, @updated_at
      ) ON CONFLICT(id) DO UPDATE SET
        task_id=excluded.task_id, sequence=excluded.sequence, event=excluded.event,
        timestamp=excluded.timestamp, started_at=excluded.started_at, duration_ms=excluded.duration_ms,
        first_token_ms=excluded.first_token_ms,
        proxy_id=excluded.proxy_id, proxy_name=excluded.proxy_name,
        client_host=excluded.client_host, client_port=excluded.client_port,
        target_id=excluded.target_id, target_name=excluded.target_name, target_url=excluded.target_url,
        method=excluded.method, path=excluded.path, endpoint=excluded.endpoint,
        status=excluded.status, error=excluded.error,
        message_count=excluded.message_count, token_count=excluded.token_count,
        request_token_count=excluded.request_token_count,
        response_token_count=excluded.response_token_count,
        pricing_status=CASE WHEN records.pricing_status = 'priced' AND excluded.pricing_status != 'priced'
          THEN records.pricing_status ELSE excluded.pricing_status END,
        pricing_reason=CASE WHEN records.pricing_status = 'priced' AND excluded.pricing_status != 'priced'
          THEN records.pricing_reason ELSE excluded.pricing_reason END,
        billing_model=COALESCE(records.billing_model, excluded.billing_model),
        pricing_snapshot_json=COALESCE(records.pricing_snapshot_json, excluded.pricing_snapshot_json),
        billing_usage_json=CASE WHEN records.pricing_status = 'priced' AND excluded.pricing_status != 'priced'
          THEN records.billing_usage_json ELSE excluded.billing_usage_json END,
        cost_nano_cny=CASE WHEN records.pricing_status = 'priced' AND excluded.pricing_status != 'priced'
          THEN records.cost_nano_cny ELSE excluded.cost_nano_cny END,
        request_headers_json=excluded.request_headers_json,
        response_headers_json=excluded.response_headers_json,
        request_body_json=NULL,
        original_request_body_json=NULL,
        response_body_json=NULL,
        model_route_json=excluded.model_route_json, stripped_fields_json=excluded.stripped_fields_json,
        injected_fields_json=excluded.injected_fields_json,
        added_upstream_headers_json=excluded.added_upstream_headers_json,
        updated_at=excluded.updated_at
    `,
        )
        .run(values);
      replaceRecordBody(this.#database, values.id, "request", values.request_body_json);
      replaceRecordBody(
        this.#database,
        values.id,
        "original_request",
        values.original_request_body_json,
      );
      replaceRecordBody(this.#database, values.id, "response", values.response_body_json);
      this.#syncRecordSearch(values);
    });
    save();
    const loaded = this.getRecord(values.id);
    if (loaded === undefined) {
      throw new Error(`Record ${values.id} was not saved.`);
    }
    return loaded;
  }

  getRecord(recordId: string): RepositoryRecord | undefined {
    const row = this.#database
      .prepare(
        "SELECT records.*, CAST(cost_nano_cny AS TEXT) AS cost_nano_cny FROM records WHERE id = ?",
      )
      .get(recordId);
    return row === undefined ? undefined : this.#decodeRecordRow(row as RepositoryRecord);
  }

  taskIdForRecord(recordId: string): string | undefined {
    const taskId = this.#database
      .prepare("SELECT task_id FROM records WHERE id = ?")
      .pluck()
      .get(recordId);
    return typeof taskId === "string" ? taskId : undefined;
  }

  nextRecordSequence(taskId: string): number {
    const value = this.#database
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 FROM records WHERE task_id = ?")
      .pluck()
      .get(taskId);
    return typeof value === "number" ? value : 1;
  }

  recordCount(taskId: string): number {
    const value = this.#database
      .prepare("SELECT COUNT(*) FROM records WHERE task_id = ?")
      .pluck()
      .get(taskId);
    return typeof value === "number" ? value : 0;
  }

  markPendingPricingInterrupted(now = new Date().toISOString()): number {
    const result = this.#database
      .prepare(
        `UPDATE records
         SET pricing_status = 'unpriced', pricing_reason = 'incomplete_usage', updated_at = ?
         WHERE pricing_status = 'pending'`,
      )
      .run(now);
    return result.changes;
  }

  taskPricing(taskId: string): TaskPricingAggregate | undefined {
    const task = this.getTask(taskId);
    if (task === undefined) return undefined;
    const aggregate = this.taskPricingForTasks([taskId]).get(taskId);
    return aggregate === undefined
      ? undefined
      : { ...aggregate, target: optionalString(task["target"]) };
  }

  taskPricingForTasks(taskIds: readonly string[]): Map<string, TaskPricingAggregate> {
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
      .all(...ids) as RepositoryRecord[];
    for (const row of rows) {
      const aggregate = aggregates.get(stringValue(row["task_id"]));
      if (aggregate !== undefined) addPricingRow(aggregate, row);
    }
    return new Map(
      [...aggregates].map(([id, aggregate]) => [id, finalizeTaskPricingAggregate(aggregate)]),
    );
  }

  /**
   * Per-request token counts for the task-detail chart, ordered by request
   * sequence. `total_tokens` is request + response when at least one side is
   * known; pending requests (no counts yet) carry nulls and are skipped by
   * the chart.
   */
  taskTokenSeries(taskId: string): readonly TaskTokenSeriesPoint[] | undefined {
    if (this.getTask(taskId) === undefined) return undefined;
    const rows = this.#database
      .prepare(
        `SELECT sequence, request_token_count, response_token_count
         FROM records WHERE task_id = ? ORDER BY sequence`,
      )
      .all(taskId) as {
      sequence: number;
      request_token_count: number | null;
      response_token_count: number | null;
    }[];
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
  taskCostSeries(taskId: string): readonly TaskCostSeriesPoint[] | undefined {
    if (this.getTask(taskId) === undefined) return undefined;
    const rows = this.#database
      .prepare(
        `SELECT sequence, CAST(cost_nano_cny AS TEXT) AS cost_nano_cny
         FROM records
         WHERE task_id = ? AND cost_nano_cny IS NOT NULL
         ORDER BY sequence`,
      )
      .all(taskId) as { sequence: number; cost_nano_cny: string }[];
    return rows.map((row) => ({
      sequence: integerValue(row.sequence, 0),
      cost_nano_cny: row.cost_nano_cny,
    }));
  }

  /**
   * Per-request cumulative output tokens for the task-detail chart, ordered
   * by request sequence. Each point carries the total output (response)
   * tokens from the task start through that request; requests without a
   * known output token count keep the running total unchanged.
   */
  taskOutputTokenSeries(taskId: string): readonly TaskOutputTokenSeriesPoint[] | undefined {
    if (this.getTask(taskId) === undefined) return undefined;
    const rows = this.#database
      .prepare(
        "SELECT sequence, response_token_count FROM records WHERE task_id = ? ORDER BY sequence",
      )
      .all(taskId) as { sequence: number; response_token_count: number | null }[];
    let running = 0;
    return rows.map((row) => {
      running += row.response_token_count ?? 0;
      return {
        sequence: integerValue(row.sequence, 0),
        output_tokens: running,
      };
    });
  }

  /**
   * Aggregate decode timing per task. The decode window runs from the first
   * token to the end of the response; only finished requests with a window of
   * at least 1ms contribute, because non-streaming responses arrive in a single
   * chunk (a near-zero window) and failed requests carry no output tokens.
   */
  taskDecodeSpeedStats(taskIds: readonly string[]): Map<string, TaskDecodeSpeedStats> {
    const ids = [...new Set(taskIds.filter((id) => id !== ""))];
    if (ids.length === 0) return new Map();
    const rows = this.#database
      .prepare(
        `SELECT task_id,
          SUM(CASE WHEN response_token_count > 0 AND duration_ms - COALESCE(first_token_ms, 0) >= 1
               THEN response_token_count ELSE 0 END) AS output_tokens,
          SUM(CASE WHEN response_token_count > 0 AND duration_ms - COALESCE(first_token_ms, 0) >= 1
               THEN duration_ms - COALESCE(first_token_ms, 0) ELSE 0 END) AS decode_ms
         FROM records
         WHERE event = 'request_finished'
           AND task_id IN (${ids.map(() => "?").join(",")})
         GROUP BY task_id`,
      )
      .all(...ids) as {
      task_id: string;
      output_tokens: number | null;
      decode_ms: number | null;
    }[];
    const stats = new Map<string, TaskDecodeSpeedStats>();
    for (const row of rows) {
      stats.set(stringValue(row.task_id), {
        output_tokens: row.output_tokens ?? 0,
        decode_ms: row.decode_ms ?? 0,
      });
    }
    return stats;
  }

  listTaskRecords(
    taskId: string,
    query = "",
    limit = 200,
    offset = 0,
  ): RepositoryPage<RepositoryRecord> {
    const boundedLimit = Math.max(1, Math.min(integerValue(limit, 200), 500));
    const boundedOffset = Math.max(0, integerValue(offset, 0));
    const terms = searchTerms(query);
    // The compound query must match every term in the record's own FTS row,
    // exactly like the previous per-term EXISTS clauses. The subquery must
    // stay uncorrelated: a correlated EXISTS full-scans the contentless FTS
    // table once per record row (minutes on a real database), while this
    // form evaluates the FTS query exactly once.
    const querySql =
      terms.length === 0
        ? ""
        : `AND records.id IN (
          SELECT record_search_map.record_id
          FROM record_search_fts
          JOIN record_search_map ON record_search_map.search_rowid = record_search_fts.rowid
          WHERE record_search_fts MATCH ?
        )`;
    const parameters = [
      taskId,
      ...(terms.length ? [terms.map((term) => ftsQuery(term)).join(" AND ")] : []),
    ];
    const total = this.#database
      .prepare(`SELECT COUNT(*) FROM records WHERE task_id = ? ${querySql}`)
      .pluck()
      .get(...parameters) as number;
    const rows = this.#database
      .prepare(
        `
        SELECT * FROM records
        WHERE task_id = ? ${querySql}
        ORDER BY sequence DESC
        LIMIT ? OFFSET ?
      `,
      )
      .all(...parameters, boundedLimit, boundedOffset) as RepositoryRecord[];
    const items = rows.map((row) => this.#decodeRecordRow(row));
    const nextOffset = boundedOffset + items.length;
    return {
      items,
      total,
      limit: boundedLimit,
      offset: boundedOffset,
      nextOffset,
      hasMore: nextOffset < total,
    };
  }

  listTaskRecordSummaries(
    taskId: string,
    query = "",
    limit = 200,
    offset = 0,
  ): RepositoryPage<RepositoryRecord> {
    const boundedLimit = Math.max(1, Math.min(integerValue(limit, 200), 500));
    const boundedOffset = Math.max(0, integerValue(offset, 0));
    const terms = searchTerms(query);
    // The compound query must match every term in the record's own FTS row,
    // exactly like the previous per-term EXISTS clauses. The subquery must
    // stay uncorrelated: a correlated EXISTS full-scans the contentless FTS
    // table once per record row (minutes on a real database), while this
    // form evaluates the FTS query exactly once.
    const querySql =
      terms.length === 0
        ? ""
        : `AND records.id IN (
          SELECT record_search_map.record_id
          FROM record_search_fts
          JOIN record_search_map ON record_search_map.search_rowid = record_search_fts.rowid
          WHERE record_search_fts MATCH ?
        )`;
    const parameters = [
      taskId,
      ...(terms.length ? [terms.map((term) => ftsQuery(term)).join(" AND ")] : []),
    ];
    const total = this.#database
      .prepare(`SELECT COUNT(*) FROM records WHERE task_id = ? ${querySql}`)
      .pluck()
      .get(...parameters) as number;
    const items = this.#database
      .prepare(
        `
        SELECT id, sequence, timestamp, method, path, endpoint, status,
          message_count, request_token_count, response_token_count, target_url,
          event, first_token_ms, duration_ms,
          pricing_status, pricing_reason, CAST(cost_nano_cny AS TEXT) AS cost_nano_cny,
          EXISTS (
            SELECT 1 FROM history_summaries
            WHERE history_summaries.record_id = records.id
              AND history_summaries.status = 'ready'
          ) AS has_summary
        FROM records
        WHERE task_id = ? ${querySql}
        ORDER BY sequence DESC
        LIMIT ? OFFSET ?
      `,
      )
      .all(...parameters, boundedLimit, boundedOffset) as RepositoryRecord[];
    const nextOffset = boundedOffset + items.length;
    return {
      items,
      total,
      limit: boundedLimit,
      offset: boundedOffset,
      nextOffset,
      hasMore: nextOffset < total,
    };
  }

  listTaskSearchPreviews(
    taskIds: readonly string[],
    query: string,
    limit = 20,
  ): Map<string, RepositoryPage<RepositoryRecord>> {
    const pages = new Map<string, RepositoryPage<RepositoryRecord>>();
    const terms = searchTerms(query);
    if (!taskIds.length || !terms.length) return pages;
    const boundedLimit = Math.max(1, Math.min(integerValue(limit, 20), 200));
    // Rank only matching record IDs before reading summary columns. One FTS
    // evaluation serves the whole visible group page, without loading bodies.
    const rows = this.#database
      .prepare(
        `WITH matches AS MATERIALIZED (
          SELECT records.id, records.task_id, records.sequence
          FROM records
          WHERE records.task_id IN (${taskIds.map(() => "?").join(",")})
            AND records.id IN (
              SELECT record_search_map.record_id
              FROM record_search_fts
              JOIN record_search_map ON record_search_map.search_rowid = record_search_fts.rowid
              WHERE record_search_fts MATCH ?
            )
        ), ranked AS (
          SELECT id, task_id,
            ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY sequence DESC) AS position,
            COUNT(*) OVER (PARTITION BY task_id) AS total
          FROM matches
        )
        SELECT records.id, records.task_id, records.sequence, records.timestamp,
          records.method, records.path, records.endpoint, records.status,
          records.message_count, records.request_token_count, records.response_token_count,
          records.event, records.first_token_ms, records.duration_ms,
          records.target_url, records.pricing_status, records.pricing_reason,
          CAST(records.cost_nano_cny AS TEXT) AS cost_nano_cny, ranked.total,
          EXISTS (
            SELECT 1 FROM history_summaries
            WHERE history_summaries.record_id = records.id
              AND history_summaries.status = 'ready'
          ) AS has_summary
        FROM ranked JOIN records ON records.id = ranked.id
        WHERE ranked.position <= ?
        ORDER BY ranked.task_id, ranked.position`,
      )
      .all(
        ...taskIds,
        terms.map((term) => ftsQuery(term)).join(" AND "),
        boundedLimit,
      ) as RepositoryRecord[];
    for (const taskId of taskIds) {
      const items = rows.filter((row) => row["task_id"] === taskId);
      const total = Number(items[0]?.["total"] ?? 0);
      pages.set(taskId, {
        items,
        total,
        limit: boundedLimit,
        offset: 0,
        nextOffset: items.length,
        hasMore: items.length < total,
      });
    }
    return pages;
  }

  upsertResponseLink(responseId: string, taskId: string): void {
    if (responseId.trim() === "") {
      return;
    }
    this.#database
      .prepare(
        `
        INSERT INTO response_links(response_id, task_id, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(response_id) DO UPDATE SET task_id = excluded.task_id
      `,
      )
      .run(responseId, taskId, this.#now());
  }

  taskIdForResponse(responseId: string): string | undefined {
    const taskId = this.#database
      .prepare("SELECT task_id FROM response_links WHERE response_id = ?")
      .pluck()
      .get(responseId);
    return typeof taskId === "string" ? taskId : undefined;
  }

  upsertContextLink(contextKey: string, taskId: string): void {
    if (contextKey.trim() === "") {
      return;
    }
    this.#database
      .prepare(
        `
        INSERT INTO context_links(context_key, task_id, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(context_key) DO UPDATE SET task_id = excluded.task_id
      `,
      )
      .run(contextKey, taskId, this.#now());
  }

  taskIdForContext(contextKey: string): string | undefined {
    const taskId = this.#database
      .prepare("SELECT task_id FROM context_links WHERE context_key = ?")
      .pluck()
      .get(contextKey);
    return typeof taskId === "string" ? taskId : undefined;
  }

  deleteTasks(taskIds: readonly string[]): number {
    const selected = taskIds.filter((taskId) => taskId.trim() !== "");
    if (selected.length === 0) {
      return 0;
    }
    const placeholders = selected.map(() => "?").join(",");
    const remove = this.#database.transaction(() => {
      const rowids = this.#database
        .prepare(`SELECT search_rowid FROM record_search_map WHERE task_id IN (${placeholders})`)
        .pluck()
        .all(...selected) as number[];
      const deleteSearch = this.#database.prepare("DELETE FROM record_search_fts WHERE rowid = ?");
      for (const rowid of rowids) deleteSearch.run(rowid);
      return this.#database
        .prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`)
        .run(...selected).changes;
    });
    return remove();
  }

  #syncRecordSearch(values: Readonly<RepositoryRecord>): void {
    const task = this.#database
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(values["task_id"]) as RepositoryRecord | undefined;
    const document = recordSearchDocument(values, task);
    let searchRowid = this.#database
      .prepare("SELECT search_rowid FROM record_search_map WHERE record_id = ?")
      .pluck()
      .get(document.recordId) as number | undefined;
    if (searchRowid === undefined) {
      searchRowid = Number(
        this.#database
          .prepare("INSERT INTO record_search_map(record_id, task_id) VALUES (?, ?)")
          .run(document.recordId, document.taskId).lastInsertRowid,
      );
    } else {
      this.#database.prepare("DELETE FROM record_search_fts WHERE rowid = ?").run(searchRowid);
      this.#database
        .prepare("UPDATE record_search_map SET task_id = ? WHERE search_rowid = ?")
        .run(document.taskId, searchRowid);
    }
    this.#database
      .prepare(
        `
        INSERT INTO record_search_fts(rowid, task_text, request_text, response_text, error_text)
        VALUES (@searchRowid, @taskText, @requestText, @responseText, @errorText)
      `,
      )
      .run({ ...document, searchRowid });
  }

  #decodeRecordRow(row: Readonly<RepositoryRecord>): RepositoryRecord {
    const recordId = stringValue(row["id"]);
    return decodeRecordRow({
      ...row,
      request_body_json: loadRecordBody(this.#database, recordId, "request"),
      original_request_body_json: loadRecordBody(this.#database, recordId, "original_request"),
      response_body_json: loadRecordBody(this.#database, recordId, "response"),
    });
  }

  /** Returns lightweight rows for usage statistics; body columns are intentionally omitted. */
  usageStatisticsRows(from: string, to: string): readonly RepositoryRecord[] {
    return this.#database
      .prepare(
        `SELECT task_id, timestamp, target_id, target_name, target_url, billing_model,
                pricing_status, pricing_reason, billing_usage_json, cost_nano_cny
           FROM records
          WHERE datetime(timestamp) >= datetime(?) AND datetime(timestamp) < datetime(?)
          ORDER BY timestamp ASC`,
      )
      .all(from, to) as RepositoryRecord[];
  }
}

export interface RecordSearchDocument {
  readonly recordId: string;
  readonly taskId: string;
  readonly taskText: string;
  readonly requestText: string;
  readonly responseText: string;
  readonly errorText: string;
}

export function recordSearchDocument(
  values: Readonly<RepositoryRecord>,
  task: Readonly<RepositoryRecord> | undefined,
): RecordSearchDocument {
  const requestKeys = [
    "id",
    "task_id",
    "sequence",
    "event",
    "timestamp",
    "started_at",
    "duration_ms",
    "proxy_id",
    "proxy_name",
    "client_host",
    "client_port",
    "target_id",
    "target_name",
    "target_url",
    "method",
    "path",
    "endpoint",
    "request_headers_json",
    "request_body_json",
    "original_request_body_json",
    "model_route_json",
    "stripped_fields_json",
    "injected_fields_json",
    "added_upstream_headers_json",
    "created_at",
    "updated_at",
  ];
  return {
    recordId: stringValue(values["id"]),
    taskId: stringValue(values["task_id"]),
    taskText: searchText(...(task === undefined ? [values["task_id"]] : Object.values(task))),
    requestText: searchText(...requestKeys.map((key) => values[key])),
    responseText: searchText(
      values["status"],
      values["message_count"],
      values["token_count"],
      values["first_token_ms"],
      values["duration_ms"],
      values["response_headers_json"],
      values["response_body_json"],
    ),
    errorText: searchText(values["error"]),
  };
}

export function searchText(...values: readonly unknown[]): string {
  const parts: string[] = [];
  for (const value of values) {
    const text = stringValue(value);
    if (text === "") {
      continue;
    }
    parts.push(text);
    const localTimestamp = timestampSearchText(text);
    if (localTimestamp !== "" && localTimestamp !== text) {
      parts.push(localTimestamp);
    }
  }
  return parts.join(" ");
}

function timestampSearchText(value: string): string {
  if (!value.includes("T") && value.length < 10) {
    return "";
  }
  try {
    return formatLocalTimestamp(value);
  } catch {
    return "";
  }
}

function searchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/u)
    .filter((term) => term !== "");
}

function likePattern(term: string): string {
  return `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function ftsQuery(term: string): string {
  return `"${term.replaceAll('"', '""')}"*`;
}

export function decodeTaskRow(row: Readonly<RepositoryRecord>): RepositoryRecord {
  const decoded: RepositoryRecord = { ...row };
  decoded["pending_request_only"] = Boolean(decoded["pending_request_only"]);
  decoded["fingerprints"] = jsonValue(decoded["fingerprints_json"], {});
  decoded["boundary_fingerprints"] = jsonValue(decoded["boundary_fingerprints_json"], {});
  decoded["last_user_messages"] = jsonValue(decoded["last_user_messages_json"], []);
  Reflect.deleteProperty(decoded, "fingerprints_json");
  Reflect.deleteProperty(decoded, "boundary_fingerprints_json");
  Reflect.deleteProperty(decoded, "last_user_messages_json");
  return decoded;
}

export function decodeRecordRow(row: Readonly<RepositoryRecord>): RepositoryRecord {
  const decoded: RepositoryRecord = { ...row };
  for (const [column, field, fallback] of [
    ["request_headers_json", "request_headers", {}],
    ["response_headers_json", "response_headers", {}],
    ["request_body_json", "request_body", null],
    ["response_body_json", "response_body", null],
    ["model_route_json", "model_route", null],
    ["stripped_fields_json", "stripped_fields", []],
    ["injected_fields_json", "injected_fields", []],
    ["added_upstream_headers_json", "added_upstream_headers", []],
  ] as const) {
    decoded[field] = jsonValue(decoded[column], fallback);
    Reflect.deleteProperty(decoded, column);
  }
  const originalRequestBody = jsonValue(decoded["original_request_body_json"], null);
  if (originalRequestBody !== null) {
    decoded["original_request_body"] = originalRequestBody;
  }
  Reflect.deleteProperty(decoded, "original_request_body_json");
  decoded["pricing"] = {
    pricing_status: decoded["pricing_status"],
    pricing_reason: decoded["pricing_reason"],
    billing_model: decoded["billing_model"],
    pricing_snapshot: jsonValue(decoded["pricing_snapshot_json"], null),
    usage: jsonValue(decoded["billing_usage_json"], null),
    cost_nano_cny: decoded["cost_nano_cny"],
  };
  for (const key of [
    "pricing_status",
    "pricing_reason",
    "billing_model",
    "pricing_snapshot_json",
    "billing_usage_json",
    "cost_nano_cny",
  ]) {
    Reflect.deleteProperty(decoded, key);
  }
  return decoded;
}

function requiredValue(record: Readonly<RepositoryRecord>, key: string): unknown {
  if (!Object.hasOwn(record, key)) {
    throw new TypeError(`Missing required repository field: ${key}`);
  }
  return record[key];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
    ? String(value)
    : "";
}

function optionalString(value: unknown): string | null {
  const text = stringValue(value);
  return text === "" ? null : text;
}

function optionalInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const text = stringValue(value);
  if (text === "") {
    return null;
  }
  const parsed = Number(text);
  return Number.isInteger(parsed) ? parsed : null;
}

function optionalBigInt(value: unknown): bigint | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    const parsed = BigInt(stringValue(value));
    return parsed >= -9_223_372_036_854_775_808n && parsed <= 9_223_372_036_854_775_807n
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function pricingStatus(value: unknown): "pending" | "priced" | "unpriced" {
  return value === "pending" || value === "priced" || value === "unpriced" ? value : "unpriced";
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

interface MutablePricingBucket {
  amountProduct: bigint;
  tokens: bigint;
}

interface MutablePricingGroup {
  algorithmVersion: number | null;
  billingModel: string | null;
  breakdown: Record<
    "cache_read" | "cache_write" | "input_uncached" | "output",
    MutablePricingBucket
  >;
  costNanoCny: bigint;
  price: PricingPrice;
  requestCount: number;
}

interface MutableTaskPricingAggregate {
  activeRequestMs: number;
  firstStartMs: number | null;
  lastFinishedEndMs: number | null;
  breakdown: Record<
    "cache_read" | "cache_write" | "input_uncached" | "output",
    MutablePricingBucket
  >;
  costNanoCny: bigint;
  groups: Map<string, MutablePricingGroup>;
  pendingRequestCount: number;
  pricedRequestCount: number;
  target: string | null;
  unpricedReasons: Record<string, number>;
  unpricedRequestCount: number;
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
  row: Readonly<RepositoryRecord>,
): void {
  // Wall time a request spent inside the proxy, from send to finish. Only
  // finished requests carry a measured duration; gap time between requests
  // never lands in a record, so summing is exactly the requested total.
  if (stringValue(row["event"]) === "request_finished") {
    aggregate.activeRequestMs += optionalFloat(row["duration_ms"]) ?? 0;
    // Task span: the first request's start and the last request's end. A
    // request is "last" only once finished, so an in-flight request does
    // not extend the span until it ends.
    const startedMs = recordTimestampMs(row["started_at"]);
    if (startedMs !== null) {
      aggregate.firstStartMs =
        aggregate.firstStartMs === null ? startedMs : Math.min(aggregate.firstStartMs, startedMs);
    }
    const endedMs =
      startedMs !== null ? startedMs + (optionalFloat(row["duration_ms"]) ?? 0) : null;
    if (endedMs !== null) {
      aggregate.lastFinishedEndMs =
        aggregate.lastFinishedEndMs === null
          ? endedMs
          : Math.max(aggregate.lastFinishedEndMs, endedMs);
    }
  }
  const status = pricingStatus(row["pricing_status"]);
  if (status === "pending") {
    aggregate.pendingRequestCount += 1;
    return;
  }
  if (status !== "priced") {
    aggregate.unpricedRequestCount += 1;
    const reason = optionalString(row["pricing_reason"]) ?? "unknown";
    aggregate.unpricedReasons[reason] = (aggregate.unpricedReasons[reason] ?? 0) + 1;
    return;
  }
  const cost = optionalBigInt(row["cost_nano_cny"]);
  const usage = recordValue(jsonValue(row["billing_usage_json"], {}));
  const snapshot = recordValue(jsonValue(row["pricing_snapshot_json"], {}));
  const price = pricingPrice(snapshot);
  if (cost === null || price === undefined || !usageBuckets(usage)) {
    aggregate.unpricedRequestCount += 1;
    aggregate.unpricedReasons["invalid_pricing_record"] =
      (aggregate.unpricedReasons["invalid_pricing_record"] ?? 0) + 1;
    return;
  }
  const buckets = usageBuckets(usage);
  if (buckets === undefined) return;
  const calculated = calculateCost(buckets, price);
  aggregate.pricedRequestCount += 1;
  aggregate.costNanoCny += cost;
  const billingModel = optionalString(row["billing_model"]);
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

function usageBuckets(usage: Readonly<Record<string, unknown>>) {
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

function pricingBreakdownMutable(): Record<
  "cache_read" | "cache_write" | "input_uncached" | "output",
  MutablePricingBucket
> {
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

/**
 * Parse an ISO-8601 local timestamp (with or without milliseconds/offset) as
 * epoch milliseconds; null when unparseable. `new Date` handles both forms.
 */
function recordTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
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

function integerValue(value: unknown, fallback: number): number {
  return optionalInteger(value) ?? fallback;
}

function floatValue(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const text = stringValue(value);
  if (text === "") {
    return fallback;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalFloat(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(stringValue(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function jsonText(value: unknown, fallback: unknown): string {
  return JSON.stringify(value ?? fallback);
}

function optionalJsonText(value: unknown): string | null {
  return value === null || value === undefined ? null : jsonText(value, null);
}

function jsonValue(value: unknown, fallback: unknown): unknown {
  if (value === null || value === undefined || value === "") {
    return structuredClone(fallback);
  }
  try {
    return JSON.parse(stringValue(value)) as unknown;
  } catch {
    return structuredClone(fallback);
  }
}
