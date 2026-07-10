import {
  RecordDetailSchema,
  RecordListResponseSchema,
  TaskListResponseSchema,
  type RecordDetail,
  type RecordListResponse,
  type RecordSummary,
  type TaskListResponse,
  type TaskSummary,
} from "@llm-proxy/contracts";
import type Database from "better-sqlite3";

import type { ExistingRecordAssignment, TaskMatchState } from "../tasks/task-matcher.js";
import { sanitizeJsonValue } from "../proxy/redaction.js";

export interface TaskWrite {
  id: string;
  kind: TaskSummary["kind"];
  endpoint: string;
  anchor: string | null;
  model: string | null;
  target: string | null;
  startedAt: string;
  lastSeenAt: string;
  lastResponseAt: string | null;
  requestCount: number;
  pending: boolean;
  matchConfidence: number;
  matchStrategyVersion: number;
  fingerprints: Readonly<Record<string, string>>;
  boundaryFingerprints: Readonly<Record<string, string>>;
  lastUserMessages: readonly unknown[];
  createdAt: string;
  updatedAt: string;
}

export interface RecordSearchText {
  task: string;
  request: string;
  response: string;
  error: string;
}

export interface LinkWrite {
  value: string;
  taskId: string;
  createdAt: string;
}

export interface RecentTaskQuery {
  since: string;
  kind: TaskSummary["kind"];
  endpoint: string;
  model: string | null;
  limit: number;
}

export interface CleanupOptions {
  taskIds?: readonly string[];
  olderThanDays?: number;
  keepLatest?: number;
  batchSize?: number;
  now?: Date;
}

export interface CleanupResult {
  deleted: number;
  batches: number;
}

interface TaskRow {
  id: string;
  kind: TaskSummary["kind"];
  endpoint: string | null;
  model: string | null;
  target: string | null;
  started_at: string;
  last_seen_at: string;
  request_count: number;
  pending_request_only: number;
}

interface TaskStateRow extends TaskRow {
  anchor: string | null;
  last_response_at: string | null;
  match_confidence: number;
  match_strategy_version: number;
  fingerprints_json: string;
  boundary_fingerprints_json: string;
  last_user_messages_json: string;
  created_at: string;
  updated_at: string;
}

interface RecordRow {
  id: string;
  task_id: string;
  sequence: number;
  event: RecordSummary["event"];
  timestamp: string;
  duration_ms: number;
  method: string;
  path: string;
  status: number | null;
  error: string | null;
  error_code: string | null;
  error_stage: string | null;
  message_count: number | null;
  token_count: number | null;
  client_host: string | null;
  client_port: number | null;
  proxy_id: string | null;
  proxy_name: string | null;
  target_id: string | null;
  target_name: string | null;
  target_url: string | null;
  request_headers_json: string;
  response_headers_json: string;
  request_body_json: string | null;
  response_body_json: string | null;
}

export class StorageRepository {
  readonly #database: Database.Database;

  public constructor(database: Database.Database) {
    this.#database = database;
  }

  public upsertTask(task: TaskWrite): void {
    this.#database
      .prepare(
        `INSERT INTO tasks(
           id, kind, endpoint, anchor, model, target, started_at, last_seen_at, last_response_at,
           request_count, pending_request_only, match_confidence, match_strategy_version,
           fingerprints_json, boundary_fingerprints_json, last_user_messages_json, created_at, updated_at
         ) VALUES (
           @id, @kind, @endpoint, @anchor, @model, @target, @started_at, @last_seen_at, @last_response_at,
           @request_count, @pending_request_only, @match_confidence, @match_strategy_version,
           @fingerprints_json, @boundary_fingerprints_json, @last_user_messages_json, @created_at, @updated_at
         )
         ON CONFLICT(id) DO UPDATE SET
           kind=excluded.kind, endpoint=excluded.endpoint, anchor=excluded.anchor, model=excluded.model,
           target=excluded.target, started_at=excluded.started_at, last_seen_at=excluded.last_seen_at,
           last_response_at=excluded.last_response_at, request_count=excluded.request_count,
           pending_request_only=excluded.pending_request_only, match_confidence=excluded.match_confidence,
           match_strategy_version=excluded.match_strategy_version, fingerprints_json=excluded.fingerprints_json,
           boundary_fingerprints_json=excluded.boundary_fingerprints_json,
           last_user_messages_json=excluded.last_user_messages_json, updated_at=excluded.updated_at`,
      )
      .run({
        id: task.id,
        kind: task.kind,
        endpoint: task.endpoint,
        anchor: task.anchor,
        model: task.model,
        target: task.target,
        started_at: task.startedAt,
        last_seen_at: task.lastSeenAt,
        last_response_at: task.lastResponseAt,
        request_count: task.requestCount,
        pending_request_only: task.pending ? 1 : 0,
        match_confidence: task.matchConfidence,
        match_strategy_version: task.matchStrategyVersion,
        fingerprints_json: JSON.stringify(task.fingerprints),
        boundary_fingerprints_json: JSON.stringify(task.boundaryFingerprints),
        last_user_messages_json: JSON.stringify(task.lastUserMessages),
        created_at: task.createdAt,
        updated_at: task.updatedAt,
      });
  }

  public upsertRecord(record: RecordDetail, search: RecordSearchText): void {
    this.#database.transaction(() => {
      this.#upsertRecordRow(record);
      this.#upsertSearch(record.id, record.taskId, search);
    })();
  }

  public transaction<Result>(operation: () => Result): Result {
    return this.#database.transaction(operation)();
  }

  public applyTrafficAssignment(
    task: TaskMatchState,
    record: RecordDetail,
    search: RecordSearchText,
    responseIds: readonly string[],
    contextKeys: readonly string[],
  ): void {
    this.upsertTask(task);
    this.#upsertRecordRow(record);
    this.#upsertSearch(record.id, record.taskId, search);
    const createdAt = record.timestamp;
    for (const value of responseIds)
      this.#upsertLink("response_links", "response_id", { value, taskId: task.id, createdAt });
    for (const value of contextKeys)
      this.#upsertLink("context_links", "context_key", { value, taskId: task.id, createdAt });
  }

  public upsertResponseLink(link: LinkWrite): void {
    this.#upsertLink("response_links", "response_id", link);
  }

  public upsertContextLink(link: LinkWrite): void {
    this.#upsertLink("context_links", "context_key", link);
  }

  public taskIdForResponse(responseId: string): string | null {
    return this.#lookupLink("response_links", "response_id", responseId);
  }

  public taskIdForContext(contextKey: string): string | null {
    return this.#lookupLink("context_links", "context_key", contextKey);
  }

  public assignmentForRecord(recordId: string): ExistingRecordAssignment | null {
    const row = this.#database.prepare("SELECT task_id, sequence FROM records WHERE id = ?").get(recordId) as
      { task_id: string; sequence: number } | undefined;
    return row ? { taskId: row.task_id, sequence: row.sequence } : null;
  }

  public getTaskState(taskId: string): TaskMatchState | null {
    const row = this.#database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskStateRow | undefined;
    return row ? taskState(row) : null;
  }

  public recordCount(taskId: string): number {
    return (
      this.#database.prepare("SELECT COUNT(*) AS count FROM records WHERE task_id = ?").get(taskId) as { count: number }
    ).count;
  }

  public nextSequence(taskId: string): number {
    const row = this.#database
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM records WHERE task_id = ?")
      .get(taskId) as { sequence: number };
    return row.sequence;
  }

  public recentTaskStates(query: RecentTaskQuery): readonly TaskMatchState[] {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200)
      throw new RangeError("Invalid limit");
    return (
      this.#database
        .prepare(
          `SELECT * FROM tasks
           WHERE last_seen_at >= @since AND kind = @kind AND endpoint = @endpoint
             AND ((@model IS NULL AND model IS NULL) OR model = @model)
           ORDER BY last_seen_at DESC LIMIT @limit`,
        )
        .all(query) as TaskStateRow[]
    ).map(taskState);
  }

  public listTasks(query: string, limit: number, offset: number): TaskListResponse {
    assertPagination(limit, offset);
    const trimmed = query.trim();
    const parameters = trimmed
      ? { query: ftsQuery(trimmed), like: `%${escapeLike(trimmed.toLowerCase())}%`, limit, offset }
      : { limit, offset };
    const where = trimmed
      ? `WHERE lower(COALESCE(t.endpoint, '') || ' ' || COALESCE(t.model, '') || ' ' || COALESCE(t.target, ''))
               LIKE @like ESCAPE '\\'
            OR EXISTS (SELECT 1 FROM record_search s WHERE s.task_id = t.id AND record_search MATCH @query)`
      : "";
    const total = (
      this.#database.prepare(`SELECT COUNT(*) AS count FROM tasks t ${where}`).get(parameters) as { count: number }
    ).count;
    const rows = this.#database
      .prepare(
        `SELECT id, kind, endpoint, model, target, started_at, last_seen_at, request_count, pending_request_only
         FROM tasks t ${where}
         ORDER BY COALESCE(last_response_at, last_seen_at, started_at) DESC, id
         LIMIT @limit OFFSET @offset`,
      )
      .all(parameters) as TaskRow[];
    return TaskListResponseSchema.parse({
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
      tasks: rows.map(taskSummary),
    });
  }

  public listRecords(taskId: string, limit: number, offset: number, query = ""): RecordListResponse {
    assertPagination(limit, offset);
    const trimmed = query.trim();
    const parameters = trimmed ? { taskId, query: ftsQuery(trimmed), limit, offset } : { taskId, limit, offset };
    const where = trimmed
      ? "WHERE r.task_id = @taskId AND EXISTS (SELECT 1 FROM record_search s WHERE s.record_id = r.id AND record_search MATCH @query)"
      : "WHERE r.task_id = @taskId";
    const total = (
      this.#database.prepare(`SELECT COUNT(*) AS count FROM records r ${where}`).get(parameters) as {
        count: number;
      }
    ).count;
    const rows = this.#database
      .prepare(
        `SELECT id, task_id, sequence, event, timestamp, duration_ms, method, path, status, error, error_code, error_stage,
                message_count, token_count
         FROM records r ${where} ORDER BY sequence LIMIT @limit OFFSET @offset`,
      )
      .all(parameters) as RecordRow[];
    return RecordListResponseSchema.parse({
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
      records: rows.map(recordSummary),
    });
  }

  public getRecord(recordId: string): RecordDetail | null {
    const row = this.#database.prepare("SELECT * FROM records WHERE id = ?").get(recordId) as RecordRow | undefined;
    if (!row) return null;
    const summary = recordSummary(row);
    return RecordDetailSchema.parse({
      ...summary,
      ...(row.error_stage ? { errorStage: row.error_stage } : {}),
      ...(row.error ? { errorMessage: row.error } : {}),
      client: { host: row.client_host ?? "", port: row.client_port ?? 0 },
      proxy: { id: row.proxy_id ?? "unknown", name: row.proxy_name ?? "Unknown" },
      target: {
        id: row.target_id ?? "unknown",
        name: row.target_name ?? "Unknown",
        url: row.target_url ?? "http://unknown.invalid",
      },
      request: {
        headers: parseJson(row.request_headers_json, {}),
        body: parseJson(row.request_body_json, emptyPayload()),
      },
      response:
        row.response_body_json === null && row.status === null
          ? null
          : {
              headers: parseJson(row.response_headers_json, {}),
              body: parseJson(row.response_body_json, emptyPayload()),
            },
    });
  }

  public recentTasks(query: RecentTaskQuery): readonly TaskSummary[] {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200)
      throw new RangeError("Invalid limit");
    const rows = this.#database
      .prepare(
        `SELECT id, kind, endpoint, model, target, started_at, last_seen_at, request_count, pending_request_only
         FROM tasks
         WHERE last_seen_at >= @since AND kind = @kind AND endpoint = @endpoint
           AND ((@model IS NULL AND model IS NULL) OR model = @model)
         ORDER BY last_seen_at DESC LIMIT @limit`,
      )
      .all(query) as TaskRow[];
    return rows.map(taskSummary);
  }

  public deleteTasks(taskIds: readonly string[]): number {
    if (taskIds.length === 0) return 0;
    if (taskIds.length > 10_000) throw new RangeError("Too many task IDs");
    const placeholders = taskIds.map(() => "?").join(",");
    return this.#database.transaction(() => {
      this.#database.prepare(`DELETE FROM record_search WHERE task_id IN (${placeholders})`).run(...taskIds);
      return this.#database.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...taskIds).changes;
    })();
  }

  public cleanup(options: CleanupOptions): CleanupResult {
    const batchSize = options.batchSize ?? 250;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000)
      throw new RangeError("Invalid cleanup batch size");
    if (options.taskIds && options.taskIds.length > 10_000) throw new RangeError("Too many task IDs");
    if (options.olderThanDays !== undefined && (!Number.isInteger(options.olderThanDays) || options.olderThanDays < 0))
      throw new RangeError("Invalid retention days");
    if (options.keepLatest !== undefined && (!Number.isInteger(options.keepLatest) || options.keepLatest < 0))
      throw new RangeError("Invalid keepLatest");

    const cutoff =
      options.olderThanDays === undefined
        ? null
        : new Date((options.now ?? new Date()).getTime() - options.olderThanDays * 86_400_000).toISOString();
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (options.taskIds) {
      if (options.taskIds.length === 0) return { deleted: 0, batches: 0 };
      clauses.push(`id IN (${options.taskIds.map(() => "?").join(",")})`);
      parameters.push(...options.taskIds);
    }
    if (cutoff) {
      clauses.push("last_seen_at < ?");
      parameters.push(cutoff);
    }
    if (options.keepLatest) {
      clauses.push(
        `id NOT IN (
          SELECT id FROM tasks ORDER BY COALESCE(last_response_at, last_seen_at, started_at) DESC, id LIMIT ?
        )`,
      );
      parameters.push(options.keepLatest);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const selectBatch = this.#database.prepare(
      `SELECT id FROM tasks ${where}
       ORDER BY COALESCE(last_response_at, last_seen_at, started_at), id LIMIT ?`,
    );
    let deleted = 0;
    let batches = 0;
    let ids = (selectBatch.all(...parameters, batchSize) as { id: string }[]).map((row) => row.id);
    while (ids.length > 0) {
      deleted += this.deleteTasks(ids);
      batches += 1;
      ids = (selectBatch.all(...parameters, batchSize) as { id: string }[]).map((row) => row.id);
    }
    return { deleted, batches };
  }

  public checkpoint(): unknown {
    return this.#database.pragma("wal_checkpoint(PASSIVE)");
  }

  public optimize(): void {
    this.#database.exec("PRAGMA optimize");
  }

  public integrityCheck(): { ok: boolean; messages: string[] } {
    const messages = (this.#database.pragma("integrity_check") as { integrity_check: string }[]).map(
      (row) => row.integrity_check,
    );
    return { ok: messages.length === 1 && messages[0] === "ok", messages };
  }

  #upsertRecordRow(record: RecordDetail): void {
    this.#database
      .prepare(
        `INSERT INTO records(
           id, task_id, sequence, event, timestamp, started_at, duration_ms,
           proxy_id, proxy_name, client_host, client_port, target_id, target_name, target_url,
           method, path, endpoint, status, error, error_code, error_stage, message_count, token_count,
           request_headers_json, response_headers_json, request_body_json, response_body_json,
           created_at, updated_at
         ) VALUES (
           @id, @task_id, @sequence, @event, @timestamp, @started_at, @duration_ms,
           @proxy_id, @proxy_name, @client_host, @client_port, @target_id, @target_name, @target_url,
           @method, @path, @endpoint, @status, @error, @error_code, @error_stage, @message_count, @token_count,
           @request_headers_json, @response_headers_json, @request_body_json, @response_body_json,
           @created_at, @updated_at
         )
         ON CONFLICT(id) DO UPDATE SET
           task_id=excluded.task_id, sequence=excluded.sequence, event=excluded.event,
           timestamp=excluded.timestamp, duration_ms=excluded.duration_ms, status=excluded.status,
           error=excluded.error, error_code=excluded.error_code, error_stage=excluded.error_stage,
           message_count=excluded.message_count, token_count=excluded.token_count,
           request_headers_json=excluded.request_headers_json, response_headers_json=excluded.response_headers_json,
           request_body_json=excluded.request_body_json, response_body_json=excluded.response_body_json,
           updated_at=excluded.updated_at`,
      )
      .run({
        id: record.id,
        task_id: record.taskId,
        sequence: record.sequence,
        event: record.event,
        timestamp: record.timestamp,
        started_at: record.timestamp,
        duration_ms: record.durationMs,
        proxy_id: record.proxy.id,
        proxy_name: record.proxy.name,
        client_host: record.client.host,
        client_port: record.client.port,
        target_id: record.target.id,
        target_name: record.target.name,
        target_url: record.target.url,
        method: record.method,
        path: record.path,
        endpoint: record.path.split("?", 1)[0] ?? record.path,
        status: record.status,
        error: record.errorMessage ?? null,
        error_code: record.errorCode,
        error_stage: record.errorStage ?? null,
        message_count: record.messageCount,
        token_count: record.tokenCount,
        request_headers_json: JSON.stringify(record.request.headers),
        response_headers_json: JSON.stringify(record.response?.headers ?? {}),
        request_body_json: JSON.stringify(record.request.body),
        response_body_json: record.response ? JSON.stringify(record.response.body) : null,
        created_at: record.timestamp,
        updated_at: record.timestamp,
      });
  }

  #upsertSearch(recordId: string, taskId: string, search: RecordSearchText): void {
    this.#database.prepare("DELETE FROM record_search WHERE record_id = ?").run(recordId);
    this.#database
      .prepare(
        `INSERT INTO record_search(record_id, task_id, task_text, request_text, response_text, error_text)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(recordId, taskId, search.task, search.request, search.response, search.error);
  }

  #upsertLink(table: "response_links" | "context_links", column: "response_id" | "context_key", link: LinkWrite): void {
    this.#database
      .prepare(
        `INSERT INTO ${table}(${column}, task_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT(${column}) DO UPDATE SET task_id=excluded.task_id, created_at=excluded.created_at`,
      )
      .run(link.value, link.taskId, link.createdAt);
  }

  #lookupLink(
    table: "response_links" | "context_links",
    column: "response_id" | "context_key",
    value: string,
  ): string | null {
    const row = this.#database.prepare(`SELECT task_id FROM ${table} WHERE ${column} = ?`).get(value) as
      { task_id: string } | undefined;
    return row?.task_id ?? null;
  }
}

function taskSummary(row: TaskRow): TaskSummary {
  return {
    id: row.id,
    kind: row.kind,
    endpoint: row.endpoint ?? "/",
    model: row.model,
    target: row.target,
    startedAt: row.started_at,
    lastSeenAt: row.last_seen_at,
    requestCount: row.request_count,
    pending: row.pending_request_only !== 0,
  };
}

function taskState(row: TaskStateRow): TaskMatchState {
  const users = sanitizeJsonValue(parseJson(row.last_user_messages_json, []), {
    maxDepth: 16,
    maxItems: 1_000,
    maxStringBytes: 64 * 1024,
  });
  return {
    ...taskSummary(row),
    endpoint: row.endpoint ?? "/",
    anchor: row.anchor ?? "",
    lastResponseAt: row.last_response_at,
    matchConfidence: row.match_confidence,
    matchStrategyVersion: row.match_strategy_version,
    fingerprints: stringRecord(parseJson(row.fingerprints_json, {})),
    boundaryFingerprints: stringRecord(parseJson(row.boundary_fingerprints_json, {})),
    lastUserMessages: Array.isArray(users) ? users : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function recordSummary(row: RecordRow): RecordSummary {
  return {
    id: row.id,
    taskId: row.task_id,
    sequence: row.sequence,
    event: row.event,
    timestamp: row.timestamp,
    durationMs: row.duration_ms,
    method: row.method,
    path: row.path,
    status: row.status,
    errorCode: row.error_code ?? row.error,
    messageCount: row.message_count,
    tokenCount: row.token_count,
  };
}

function emptyPayload(): Record<string, unknown> {
  return { kind: "empty", observedBytes: 0, capturedBytes: 0, truncated: false };
}

function parseJson(text: string | null, fallback: unknown): unknown {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fallback;
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function assertPagination(limit: number, offset: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new RangeError("Invalid limit");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000_000) throw new RangeError("Invalid offset");
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function ftsQuery(value: string): string {
  return value
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 20)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
}
