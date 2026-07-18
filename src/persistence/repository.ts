import type Database from "better-sqlite3";

import { formatLocalTimestamp, localNowIso } from "../shared/index.js";
import { connectLogDatabase } from "./database.js";

export type RepositoryRecord = Record<string, unknown>;

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

export class TrafficRepository {
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

  recentTasks(limit = 200): RepositoryRecord[] {
    const boundedLimit = Math.max(1, Math.min(integerValue(limit, 200), 1_000));
    const rows = this.#database
      .prepare(
        `
        SELECT *
        FROM tasks
        WHERE pending_request_only = 0
        ORDER BY COALESCE(last_response_at, last_seen_at, started_at) DESC
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
          OR EXISTS (
            SELECT 1 FROM record_search
            WHERE record_search.task_id = tasks.id
              AND lower(
                COALESCE(record_search.record_id, '') || ' ' || COALESCE(record_search.task_id, '') || ' ' ||
                COALESCE(record_search.task_text, '') || ' ' || COALESCE(record_search.request_text, '') || ' ' ||
                COALESCE(record_search.response_text, '') || ' ' || COALESCE(record_search.error_text, '')
              ) LIKE ? ESCAPE '\\'
          )
        )`,
    );
    const whereSql = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const parameters = terms.flatMap((term) => [likePattern(term), likePattern(term)]);
    const total = this.#database
      .prepare(`SELECT COUNT(*) AS count FROM tasks ${whereSql}`)
      .pluck()
      .get(...parameters) as number;
    const rows = this.#database
      .prepare(
        `
        SELECT * FROM tasks
        ${whereSql}
        ORDER BY COALESCE(last_response_at, last_seen_at, started_at) DESC
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

  upsertRecord(record: Readonly<RepositoryRecord>): RepositoryRecord {
    const now = this.#now();
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
    this.#database
      .prepare(
        `
      INSERT INTO records(
        id, task_id, sequence, event, timestamp, started_at, duration_ms,
        proxy_id, proxy_name, client_host, client_port, target_id, target_name, target_url,
        method, path, endpoint, status, error, message_count, token_count,
        request_headers_json, response_headers_json, request_body_json, original_request_body_json,
        response_body_json,
        model_route_json, stripped_fields_json, injected_fields_json, added_upstream_headers_json,
        created_at, updated_at
      ) VALUES (
        @id, @task_id, @sequence, @event, @timestamp, @started_at, @duration_ms,
        @proxy_id, @proxy_name, @client_host, @client_port, @target_id, @target_name, @target_url,
        @method, @path, @endpoint, @status, @error, @message_count, @token_count,
        @request_headers_json, @response_headers_json, @request_body_json,
        @original_request_body_json, @response_body_json,
        @model_route_json, @stripped_fields_json, @injected_fields_json, @added_upstream_headers_json,
        @created_at, @updated_at
      ) ON CONFLICT(id) DO UPDATE SET
        task_id=excluded.task_id, sequence=excluded.sequence, event=excluded.event,
        timestamp=excluded.timestamp, started_at=excluded.started_at, duration_ms=excluded.duration_ms,
        proxy_id=excluded.proxy_id, proxy_name=excluded.proxy_name,
        client_host=excluded.client_host, client_port=excluded.client_port,
        target_id=excluded.target_id, target_name=excluded.target_name, target_url=excluded.target_url,
        method=excluded.method, path=excluded.path, endpoint=excluded.endpoint,
        status=excluded.status, error=excluded.error,
        message_count=excluded.message_count, token_count=excluded.token_count,
        request_headers_json=excluded.request_headers_json,
        response_headers_json=excluded.response_headers_json,
        request_body_json=excluded.request_body_json,
        original_request_body_json=excluded.original_request_body_json,
        response_body_json=excluded.response_body_json,
        model_route_json=excluded.model_route_json, stripped_fields_json=excluded.stripped_fields_json,
        injected_fields_json=excluded.injected_fields_json,
        added_upstream_headers_json=excluded.added_upstream_headers_json,
        updated_at=excluded.updated_at
    `,
      )
      .run(values);
    this.#syncRecordSearch(values);
    const loaded = this.getRecord(values.id);
    if (loaded === undefined) {
      throw new Error(`Record ${values.id} was not saved.`);
    }
    return loaded;
  }

  getRecord(recordId: string): RepositoryRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM records WHERE id = ?").get(recordId);
    return row === undefined ? undefined : decodeRecordRow(row as RepositoryRecord);
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

  listTaskRecords(
    taskId: string,
    query = "",
    limit = 200,
    offset = 0,
  ): RepositoryPage<RepositoryRecord> {
    const boundedLimit = Math.max(1, Math.min(integerValue(limit, 200), 500));
    const boundedOffset = Math.max(0, integerValue(offset, 0));
    const terms = searchTerms(query);
    const clauses = terms.map(
      () => `lower(_search_text(
              id, task_id, sequence, event, timestamp, started_at, duration_ms,
              proxy_id, proxy_name, client_host, client_port, target_id, target_name, target_url,
              method, path, endpoint, status, error, message_count, token_count,
              request_headers_json, response_headers_json, request_body_json,
              original_request_body_json, response_body_json,
              model_route_json, stripped_fields_json, injected_fields_json, added_upstream_headers_json,
              created_at, updated_at
            )) LIKE ? ESCAPE '\\'`,
    );
    const querySql = clauses.length === 0 ? "" : `AND ${clauses.join(" AND ")}`;
    const parameters = [taskId, ...terms.map((term) => likePattern(term))];
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
    const items = rows.map((row) => decodeRecordRow(row));
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
      this.#database
        .prepare(`DELETE FROM record_search WHERE task_id IN (${placeholders})`)
        .run(...selected);
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
    this.#database.prepare("DELETE FROM record_search WHERE record_id = ?").run(document.recordId);
    this.#database
      .prepare(
        `
        INSERT INTO record_search(record_id, task_id, task_text, request_text, response_text, error_text)
        VALUES (@recordId, @taskId, @taskText, @requestText, @responseText, @errorText)
      `,
      )
      .run(document);
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
