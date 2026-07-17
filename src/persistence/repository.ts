import type Database from "better-sqlite3";

import { localNowIso } from "../shared/index.js";
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
  }

  close(): void {
    this.#database.close();
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
    const normalizedQuery = query.trim().toLowerCase();
    const where =
      normalizedQuery === ""
        ? { sql: "", parameters: [] }
        : {
            sql: `WHERE lower(
              COALESCE(id, '') || ' ' || COALESCE(kind, '') || ' ' || COALESCE(endpoint, '') || ' ' ||
              COALESCE(anchor, '') || ' ' || COALESCE(model, '') || ' ' || COALESCE(target, '') || ' ' ||
              COALESCE(fingerprints_json, '') || ' ' || COALESCE(boundary_fingerprints_json, '')
            ) LIKE ?`,
            parameters: [`%${normalizedQuery}%`],
          };
    const total = this.#database
      .prepare(`SELECT COUNT(*) AS count FROM tasks ${where.sql}`)
      .pluck()
      .get(...where.parameters) as number;
    const rows = this.#database
      .prepare(
        `
        SELECT * FROM tasks
        ${where.sql}
        ORDER BY COALESCE(last_response_at, last_seen_at, started_at) DESC
        LIMIT ? OFFSET ?
      `,
      )
      .all(...where.parameters, boundedLimit, boundedOffset) as RepositoryRecord[];
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
