import type Database from "better-sqlite3";

import { repositoryPage, type RepositoryPage, type RepositoryRecord } from "./access-contracts.js";
import {
  integerValue,
  jsonText,
  optionalJsonText,
  optionalString,
  optionalBigInt,
  pricingStatus,
  recordValue,
  storedJsonArray,
  storedJsonObject,
  storedJsonValue,
  textCell,
  textOr,
  type PricingState,
} from "./column-codec.js";
import { loadRecordBody, replaceRecordBody } from "./body-storage.js";
import type { SearchStore } from "./search-store.js";
import type { TaskStore } from "./task-store.js";

/**
 * The record row: one request the proxy saw, and the bodies that belong to it.
 *
 * This module changes when the record columns change (a new timing measurement,
 * a new header block) or when how bodies are stored and read changes. It owns the
 * `records` table plus the body tables through `body-storage`; the task and search
 * rows it joins are read, never written here.
 */

/**
 * One header value as the column stores it: the strings that arrived, or the
 * single string a row written before duplicated headers were kept still holds.
 */
export type HeaderValue = readonly string[] | string;

/** How a header block is stored: every header name maps to the value that arrived. */
export type HeaderMap = Readonly<Record<string, HeaderValue>>;

/** The pricing block a record write carries, as the pricing module produced it. */
export interface RecordWritePricing {
  readonly pricing_status?: PricingState | undefined;
  readonly pricing_reason?: string | null | undefined;
  readonly billing_model?: string | null | undefined;
  readonly pricing_snapshot?: Readonly<Record<string, unknown>> | null | undefined;
  readonly usage?: Readonly<Record<string, unknown>> | null | undefined;
  readonly cost_nano_cny?: string | null | undefined;
}

/** One record the repository is asked to insert or replace. */
export interface RecordWriteFields {
  readonly id: string;
  readonly task_id: string;
  readonly sequence?: number | undefined;
  readonly event?: string | undefined;
  readonly timestamp?: string | undefined;
  readonly started_at?: string | undefined;
  /** The same instant under the name the proxy calls it; a fallback for `started_at`. */
  readonly started_timestamp?: string | null | undefined;
  readonly duration_ms?: number | null | undefined;
  readonly first_token_ms?: number | null | undefined;
  readonly decode_window_ms?: number | null | undefined;
  readonly proxy_id?: string | null | undefined;
  readonly proxy_name?: string | null | undefined;
  readonly client_host?: string | null | undefined;
  readonly client_port?: number | null | undefined;
  readonly target_id?: string | null | undefined;
  readonly target_name?: string | null | undefined;
  readonly target_url?: string | null | undefined;
  readonly method?: string | undefined;
  readonly path?: string | undefined;
  readonly endpoint?: string | undefined;
  readonly status?: number | null | undefined;
  readonly error?: string | null | undefined;
  readonly message_count?: number | null | undefined;
  readonly token_count?: number | null | undefined;
  readonly request_token_count?: number | null | undefined;
  readonly response_token_count?: number | null | undefined;
  readonly pricing?: RecordWritePricing | undefined;
  readonly request_headers?: HeaderMap | undefined;
  readonly response_headers?: HeaderMap | undefined;
  /** What the client sent, kept as the arbitrary JSON it is. */
  readonly request_body?: unknown;
  /** The client body again, stored separately when the forwarded body differs. */
  readonly original_request_body?: unknown;
  /** What the upstream answered, kept as the arbitrary JSON it is. */
  readonly response_body?: unknown;
  readonly model_route?: unknown;
  readonly stripped_fields?: readonly unknown[] | undefined;
  readonly injected_fields?: readonly unknown[] | undefined;
  readonly added_upstream_headers?: readonly unknown[] | undefined;
  readonly created_at?: string | undefined;
  readonly updated_at?: string | undefined;
}

/**
 * A record write. The declared half is every column the `records` table has; the
 * unmodelled half carries columns a row that was imported or written by an older
 * version still holds, so such a row can still be replayed through a write.
 */
export type RecordWrite = RecordWriteFields & Record<string, unknown>;

/** The pricing block as a stored row reports it. */
export interface RecordPricing {
  readonly pricing_status: string | null;
  readonly pricing_reason: string | null;
  readonly billing_model: string | null;
  readonly pricing_snapshot: unknown;
  readonly usage: unknown;
  /** Money in nano-cent, as text so a large cost keeps every digit. */
  readonly cost_nano_cny: string | null;
}

/** One record row as the repository returns it: JSON decoded, bodies loaded. */
export interface RecordRowFields {
  readonly id: string;
  readonly task_id: string;
  readonly sequence: number;
  readonly event: string;
  readonly timestamp: string;
  readonly started_at: string;
  readonly duration_ms: number;
  readonly first_token_ms: number | null;
  readonly decode_window_ms: number | null;
  readonly proxy_id: string | null;
  readonly proxy_name: string | null;
  readonly client_host: string | null;
  readonly client_port: number | null;
  readonly target_id: string | null;
  readonly target_name: string | null;
  readonly target_url: string | null;
  readonly method: string;
  readonly path: string;
  readonly endpoint: string;
  readonly status: number | null;
  readonly error: string | null;
  readonly message_count: number | null;
  readonly token_count: number | null;
  readonly request_token_count: number | null;
  readonly response_token_count: number | null;
  readonly request_headers: HeaderMap;
  readonly response_headers: HeaderMap;
  readonly request_body: unknown;
  readonly response_body: unknown;
  readonly model_route: unknown;
  readonly stripped_fields: readonly unknown[];
  readonly injected_fields: readonly unknown[];
  readonly added_upstream_headers: readonly unknown[];
  readonly pricing: RecordPricing;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * A record row. The declared half is the decoded `records` columns; the unmodelled
 * half is where an imported or older row keeps a column this version does not
 * model, such as `prompt_cache_key`. `original_request_body` appears only when the
 * forwarded body differed from the client's.
 */
export type RecordRow = RecordRowFields & Record<string, unknown>;

/** The columns the console lists a request by; no body and no JSON column is read. */
export interface RecordSummaryRowFields {
  readonly id: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly method: string;
  readonly path: string;
  readonly endpoint: string;
  readonly status: number | null;
  readonly message_count: number | null;
  readonly request_token_count: number | null;
  readonly response_token_count: number | null;
  readonly target_url: string | null;
  readonly event: string;
  readonly first_token_ms: number | null;
  readonly decode_window_ms: number | null;
  readonly duration_ms: number;
  readonly pricing_status: PricingState;
  readonly pricing_reason: string | null;
  /** Money in nano-cent, as text so a large cost keeps every digit. */
  readonly cost_nano_cny: string | null;
  /** Whether a ready summary exists: SQLite answers 1 or 0. */
  readonly has_summary: number;
}

/** One entry of a request list, projected so no body is read for it. */
export type RecordSummaryRow = RecordSummaryRowFields & Record<string, unknown>;

/** A row the usage-statistics page aggregates. */
export interface UsageStatisticsRowFields {
  readonly task_id: string;
  readonly timestamp: string;
  readonly target_id: string | null;
  readonly target_name: string | null;
  readonly target_url: string | null;
  readonly billing_model: string | null;
  readonly pricing_status: PricingState;
  readonly pricing_reason: string | null;
  readonly billing_usage_json: string | null;
  /** Money in nano-cent, as text so a large cost keeps every digit. */
  readonly cost_nano_cny: string | null;
}

/**
 * A row for the statistics page. Bodies are deliberately absent, and the usage
 * document stays as the stored text: the page parses it itself and must never be
 * given a body.
 */
export type UsageStatisticsRow = UsageStatisticsRowFields & Record<string, unknown>;

/** The columns every record listing selects. */
const RECORD_SUMMARY_COLUMNS = `id, sequence, timestamp, method, path, endpoint, status,
          message_count, request_token_count, response_token_count, target_url,
          event, first_token_ms, decode_window_ms, duration_ms,
          pricing_status, pricing_reason, CAST(cost_nano_cny AS TEXT) AS cost_nano_cny,
          EXISTS (
            SELECT 1 FROM history_summaries
            WHERE history_summaries.record_id = records.id
              AND history_summaries.status = 'ready'
          ) AS has_summary`;

export class RecordStore {
  readonly #database: Database.Database;
  readonly #now: () => string;
  readonly #search: SearchStore;
  readonly #tasks: TaskStore;

  constructor(
    database: Database.Database,
    now: () => string,
    search: SearchStore,
    tasks: TaskStore,
  ) {
    this.#database = database;
    this.#now = now;
    this.#search = search;
    this.#tasks = tasks;
  }

  /**
   * Inserts or replaces one record together with its bodies and its search row.
   * `insideTransaction` is the same work without a transaction of its own: the
   * business write calls it so task, record, links and search commit as one.
   */
  write(record: Readonly<RecordWrite>): RecordRow {
    // The task row is read before the transaction opens. A deferred transaction that reads
    // first takes a WAL read snapshot, and upgrading to a writer after another writer has
    // advanced the log then fails with SQLITE_BUSY_SNAPSHOT, which busy_timeout will not
    // retry. Reading here keeps the first statement of the transaction a write.
    const task = this.#tasks.rawRow(record.task_id);
    const commit = this.#database.transaction(() => this.writeInside(record, task));
    commit();
    return this.readWrittenRecord(record.id);
  }

  /** The statements of a record write, for a caller that is already inside a transaction. */
  writeInside(record: Readonly<RecordWrite>, task: Readonly<RepositoryRecord> | undefined): void {
    const values = recordColumnValues(record, this.#now());
    this.#database
      .prepare(
        `
      INSERT INTO records(
        id, task_id, sequence, event, timestamp, started_at, duration_ms, first_token_ms, decode_window_ms,
        proxy_id, proxy_name, client_host, client_port, target_id, target_name, target_url,
        method, path, endpoint, status, error, message_count, token_count,
        request_token_count, response_token_count,
        pricing_status, pricing_reason, billing_model, pricing_snapshot_json, billing_usage_json, cost_nano_cny,
        request_headers_json, response_headers_json, request_body_json, original_request_body_json,
        response_body_json,
        model_route_json, stripped_fields_json, injected_fields_json, added_upstream_headers_json,
        created_at, updated_at
      ) VALUES (
        @id, @task_id, @sequence, @event, @timestamp, @started_at, @duration_ms, @first_token_ms, @decode_window_ms,
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
        decode_window_ms=excluded.decode_window_ms,
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
    this.#search.syncRecord(values, task);
  }

  /** One record with its bodies loaded; undefined when no record has that id. */
  get(recordId: string): RecordRow | undefined {
    const row = this.#database
      .prepare(
        "SELECT records.*, CAST(cost_nano_cny AS TEXT) AS cost_nano_cny FROM records WHERE id = ?",
      )
      .get(recordId);
    return row === undefined ? undefined : this.decodeRow(row as RepositoryRecord);
  }

  /** Whether this log holds a record with that id. */
  has(recordId: string): boolean {
    return this.#database.prepare("SELECT 1 FROM records WHERE id = ?").get(recordId) !== undefined;
  }

  /** The task a record belongs to, or undefined when no record has that id. */
  taskIdFor(recordId: string): string | undefined {
    const taskId = this.#database
      .prepare("SELECT task_id FROM records WHERE id = ?")
      .pluck()
      .get(recordId);
    return typeof taskId === "string" ? taskId : undefined;
  }

  /** The sequence the next record of this task should take. */
  nextSequence(taskId: string): number {
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

  /**
   * Marks every record still priced as interrupted. Rows left "pending" by a
   * previous process can never be completed, so a runtime that opens the log
   * settles them instead of reporting them as still calculating forever.
   */
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

  /** The newest record of a task whose body is complete, i.e. the last finished request. */
  latestFinishedId(taskId: string): string | undefined {
    const finished = this.#database
      .prepare(
        "SELECT id FROM records WHERE task_id = ? AND event = 'request_finished' ORDER BY sequence DESC LIMIT 1",
      )
      .pluck()
      .get(taskId);
    if (typeof finished === "string") return finished;
    const latest = this.#database
      .prepare("SELECT id FROM records WHERE task_id = ? ORDER BY sequence DESC LIMIT 1")
      .pluck()
      .get(taskId);
    return typeof latest === "string" ? latest : undefined;
  }

  /**
   * Records of one task, with bodies loaded, newest first. This is the listing
   * that reads bodies; the summary listings above it never do.
   */
  listForTask(taskId: string, query = "", limit = 200, offset = 0): RepositoryPage<RecordRow> {
    const boundedLimit = Math.max(1, Math.min(integerValue(limit, 200), 500));
    const boundedOffset = Math.max(0, integerValue(offset, 0));
    const filter = this.#search.recordIdFilter(query);
    const querySql = filter.sql === "" ? "" : `AND ${filter.sql}`;
    const parameters = [taskId, ...filter.parameters];
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
      .all(...parameters, boundedLimit, boundedOffset) as readonly RepositoryRecord[];
    return repositoryPage(
      rows.map((row) => this.decodeRow(row)),
      total,
      boundedLimit,
      boundedOffset,
    );
  }

  /** The request list the console shows for a group: bodies are never read here. */
  listSummariesForTask(
    taskId: string,
    query = "",
    limit = 200,
    offset = 0,
  ): RepositoryPage<RecordSummaryRow> {
    const boundedLimit = Math.max(1, Math.min(integerValue(limit, 200), 500));
    const boundedOffset = Math.max(0, integerValue(offset, 0));
    const filter = this.#search.recordIdFilter(query);
    const querySql = filter.sql === "" ? "" : `AND ${filter.sql}`;
    const parameters = [taskId, ...filter.parameters];
    const total = this.#database
      .prepare(`SELECT COUNT(*) FROM records WHERE task_id = ? ${querySql}`)
      .pluck()
      .get(...parameters) as number;
    const items = this.#database
      .prepare(
        `
        SELECT ${RECORD_SUMMARY_COLUMNS}
        FROM records
        WHERE task_id = ? ${querySql}
        ORDER BY sequence DESC
        LIMIT ? OFFSET ?
      `,
      )
      .all(...parameters, boundedLimit, boundedOffset) as readonly RecordSummaryRow[];
    return repositoryPage(items, total, boundedLimit, boundedOffset);
  }

  /**
   * Returns body-free rows for the given record ids. The admin pending sweep
   * uses this instead of `get`: decoding a record loads its streamed body chunks
   * from disk and inflates them, which blocks the event loop for tens of
   * milliseconds per record while requests are in flight.
   */
  listByIds(ids: readonly string[], limit = 200): readonly RecordSummaryRow[] {
    const boundedIds = ids.slice(0, Math.max(1, integerValue(limit, 200)));
    if (boundedIds.length === 0) return [];
    const placeholders = boundedIds.map(() => "?").join(", ");
    return this.#database
      .prepare(
        `
        SELECT ${RECORD_SUMMARY_COLUMNS}
        FROM records
        WHERE id IN (${placeholders})
        ORDER BY sequence DESC
      `,
      )
      .all(...boundedIds) as readonly RecordSummaryRow[];
  }

  /** Lightweight rows for usage statistics; body columns are intentionally absent. */
  usageStatisticsRows(from: string, to: string): readonly UsageStatisticsRow[] {
    return this.#database
      .prepare(
        `SELECT task_id, timestamp, target_id, target_name, target_url, billing_model,
                pricing_status, pricing_reason, billing_usage_json,
                CAST(cost_nano_cny AS TEXT) AS cost_nano_cny
           FROM records
          WHERE datetime(timestamp) >= datetime(?) AND datetime(timestamp) < datetime(?)
          ORDER BY timestamp ASC`,
      )
      .all(from, to) as readonly UsageStatisticsRow[];
  }

  /** Turns a stored record row into the record the rest of the application reads. */
  decodeRow(row: Readonly<RepositoryRecord>): RecordRow {
    const recordId = String(row["id"]);
    return decodeRecordRow({
      ...row,
      request_body_json: loadRecordBody(this.#database, recordId, "request"),
      original_request_body_json: loadRecordBody(this.#database, recordId, "original_request"),
      response_body_json: loadRecordBody(this.#database, recordId, "response"),
    });
  }

  /** Re-reads a record that was just written, and fails loudly if it is not there. */
  readWrittenRecord(recordId: string): RecordRow {
    const loaded = this.get(recordId);
    if (loaded === undefined) {
      throw new Error(`Record ${recordId} was not saved.`);
    }
    return loaded;
  }
}

/** The encoded columns of a record write, ready for the insert and the search text. */
function recordColumnValues(record: Readonly<RecordWrite>, now: string): RecordColumnValues {
  const pricing = record.pricing;
  return {
    id: record.id,
    task_id: record.task_id,
    sequence: integerValue(record.sequence, 1),
    event: textOr(record.event, "request_finished"),
    timestamp: textOr(record.timestamp, now),
    started_at: textOr(record.started_at ?? record.started_timestamp ?? record.timestamp, now),
    duration_ms: floatValueOr(record.duration_ms, 0),
    first_token_ms: optionalFloatOrNull(record.first_token_ms),
    decode_window_ms: optionalFloatOrNull(record.decode_window_ms),
    proxy_id: optionalString(record.proxy_id),
    proxy_name: optionalString(record.proxy_name),
    client_host: optionalString(record.client_host),
    client_port: optionalIntegerOrNull(record.client_port),
    target_id: optionalString(record.target_id),
    target_name: optionalString(record.target_name),
    target_url: optionalString(record.target_url),
    method: record.method ?? "",
    path: record.path ?? "",
    endpoint: record.endpoint ?? record.path ?? "",
    status: optionalIntegerOrNull(record.status),
    error: optionalString(record.error),
    message_count: optionalIntegerOrNull(record.message_count),
    token_count: optionalIntegerOrNull(record.token_count),
    request_token_count: optionalIntegerOrNull(record.request_token_count),
    response_token_count: optionalIntegerOrNull(record.response_token_count),
    pricing_status: pricingStatus(pricing?.pricing_status ?? recordValue(pricing)),
    pricing_reason: optionalString(pricing?.pricing_reason),
    billing_model: optionalString(pricing?.billing_model),
    pricing_snapshot_json: optionalJsonText(pricing?.pricing_snapshot),
    billing_usage_json: optionalJsonText(pricing?.usage),
    cost_nano_cny: optionalBigInt(pricing?.cost_nano_cny),
    request_headers_json: jsonText(record.request_headers, {}),
    response_headers_json: jsonText(record.response_headers, {}),
    request_body_json: optionalJsonText(record.request_body),
    original_request_body_json: optionalJsonText(record.original_request_body),
    response_body_json: optionalJsonText(record.response_body),
    model_route_json: optionalJsonText(record.model_route),
    stripped_fields_json: jsonText(record.stripped_fields, []),
    injected_fields_json: jsonText(record.injected_fields, []),
    added_upstream_headers_json: jsonText(record.added_upstream_headers, []),
    created_at: textOr(record.created_at, now),
    updated_at: textOr(record.updated_at, now),
  };
}

/**
 * The encoded half of a record write: the values the statements bind, with every
 * body kept as its own JSON text so the body tables can store it. The unmodelled
 * half lets the search index read the same object as a plain row.
 */
export interface RecordColumnValuesFields {
  readonly id: string;
  readonly task_id: string;
  readonly sequence: number;
  readonly event: string;
  readonly timestamp: string;
  readonly started_at: string;
  readonly duration_ms: number;
  readonly first_token_ms: number | null;
  readonly decode_window_ms: number | null;
  readonly proxy_id: string | null;
  readonly proxy_name: string | null;
  readonly client_host: string | null;
  readonly client_port: number | null;
  readonly target_id: string | null;
  readonly target_name: string | null;
  readonly target_url: string | null;
  readonly method: string;
  readonly path: string;
  readonly endpoint: string;
  readonly status: number | null;
  readonly error: string | null;
  readonly message_count: number | null;
  readonly token_count: number | null;
  readonly request_token_count: number | null;
  readonly response_token_count: number | null;
  readonly pricing_status: PricingState;
  readonly pricing_reason: string | null;
  readonly billing_model: string | null;
  readonly pricing_snapshot_json: string | null;
  readonly billing_usage_json: string | null;
  readonly cost_nano_cny: bigint | null;
  readonly request_headers_json: string;
  readonly response_headers_json: string;
  readonly request_body_json: string | null;
  readonly original_request_body_json: string | null;
  readonly response_body_json: string | null;
  readonly model_route_json: string | null;
  readonly stripped_fields_json: string;
  readonly injected_fields_json: string;
  readonly added_upstream_headers_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export type RecordColumnValues = RecordColumnValuesFields & Record<string, unknown>;

function floatValueOr(value: number | null | undefined, fallback: number): number {
  return value === undefined || value === null || !Number.isFinite(value) ? fallback : value;
}

function optionalFloatOrNull(value: number | null | undefined): number | null {
  return value === undefined || value === null || !Number.isFinite(value) ? null : value;
}

function optionalIntegerOrNull(value: number | null | undefined): number | null {
  return value === undefined || value === null || !Number.isInteger(value) ? null : value;
}

/** Turns a record row that already carries its bodies into the record the console reads. */
export function decodeRecordRow(row: Readonly<RepositoryRecord>): RecordRow {
  const decoded: Record<string, unknown> = { ...row };
  decoded["request_headers"] = storedJsonObject(row["request_headers_json"]);
  decoded["response_headers"] = storedJsonObject(row["response_headers_json"]);
  decoded["request_body"] = storedJsonValue(row["request_body_json"]);
  decoded["response_body"] = storedJsonValue(row["response_body_json"]);
  decoded["model_route"] = storedJsonValue(row["model_route_json"]);
  decoded["stripped_fields"] = storedJsonArray(row["stripped_fields_json"]);
  decoded["injected_fields"] = storedJsonArray(row["injected_fields_json"]);
  decoded["added_upstream_headers"] = storedJsonArray(row["added_upstream_headers_json"]);
  const originalRequestBody = storedJsonValue(row["original_request_body_json"]);
  if (originalRequestBody !== null) {
    decoded["original_request_body"] = originalRequestBody;
  }
  decoded["pricing"] = {
    pricing_status: textCell(row["pricing_status"]),
    pricing_reason: textCell(row["pricing_reason"]),
    billing_model: textCell(row["billing_model"]),
    pricing_snapshot: storedJsonValue(row["pricing_snapshot_json"]),
    usage: storedJsonValue(row["billing_usage_json"]),
    cost_nano_cny: textCell(row["cost_nano_cny"]),
  };
  for (const column of [
    "request_headers_json",
    "response_headers_json",
    "request_body_json",
    "response_body_json",
    "model_route_json",
    "stripped_fields_json",
    "injected_fields_json",
    "added_upstream_headers_json",
    "original_request_body_json",
    "pricing_status",
    "pricing_reason",
    "billing_model",
    "pricing_snapshot_json",
    "billing_usage_json",
    "cost_nano_cny",
  ]) {
    Reflect.deleteProperty(decoded, column);
  }
  return decoded as RecordRow;
}
