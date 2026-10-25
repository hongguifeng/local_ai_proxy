import type Database from "better-sqlite3";

import { repositoryPage, type RepositoryPage, type RepositoryRecord } from "./access-contracts.js";
import {
  floatValue,
  integerValue,
  jsonText,
  optionalString,
  storedJsonArray,
  storedJsonObject,
  textOr,
} from "./column-codec.js";
import type { SearchStore } from "./search-store.js";

/**
 * The task row: the identity the matcher groups requests under, and the way
 * groups are listed.
 *
 * This module changes when the task columns change (a new fingerprint, a matcher
 * strategy version, a column the console sorts groups by) or when the listing of
 * groups changes. It owns the `tasks` table and the two link tables that let a
 * request be recognised as a continuation; a search row it does not touch stays
 * unchanged. Deleting a group cascades to its records and links, so removal is
 * here and not in the record module.
 */

/** One task the repository is asked to insert or replace. */
export interface TaskWriteFields {
  readonly id: string;
  readonly kind?: string | undefined;
  readonly endpoint?: string | null | undefined;
  readonly anchor?: string | null | undefined;
  readonly model?: string | null | undefined;
  readonly target?: string | null | undefined;
  readonly started_at?: string | undefined;
  readonly last_seen_at?: string | undefined;
  readonly last_response_at?: string | null | undefined;
  readonly request_count?: number | undefined;
  readonly pending_request_only?: boolean | undefined;
  readonly match_confidence?: number | undefined;
  readonly match_strategy_version?: number | undefined;
  readonly fingerprints?: Readonly<Record<string, unknown>> | undefined;
  readonly boundary_fingerprints?: Readonly<Record<string, unknown>> | undefined;
  readonly last_user_messages?: readonly unknown[] | undefined;
  readonly created_at?: string | undefined;
  readonly updated_at?: string | undefined;
  /**
   * The confidence of the match that produced this task, under a name older
   * writers used. It is read only as a fallback for `match_confidence`.
   */
  readonly last_match_confidence?: number | undefined;
}

/**
 * A task write. The declared half is every column the `tasks` table has; the
 * unmodelled half carries columns a row read from an older database still holds,
 * so spreading a stored task into a write keeps working.
 */
export type TaskWrite = TaskWriteFields & Record<string, unknown>;

/** One task row as the repository returns it: JSON columns already decoded. */
export interface TaskRowFields {
  readonly id: string;
  readonly kind: string;
  readonly endpoint: string | null;
  readonly anchor: string | null;
  readonly model: string | null;
  readonly target: string | null;
  readonly started_at: string;
  readonly last_seen_at: string;
  readonly last_response_at: string | null;
  readonly request_count: number;
  readonly pending_request_only: boolean;
  readonly match_confidence: number;
  readonly match_strategy_version: number;
  readonly fingerprints: Readonly<Record<string, unknown>>;
  readonly boundary_fingerprints: Readonly<Record<string, unknown>>;
  readonly last_user_messages: readonly unknown[];
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * A task row. The declared half is the decoded `tasks` columns; the unmodelled
 * half is where a row imported or written by an older version keeps columns this
 * version does not model.
 */
export type TaskRow = TaskRowFields & Record<string, unknown>;

/** The columns the console lists a group by; no JSON columns are read. */
export interface TaskSummaryRowFields {
  readonly id: string;
  readonly model: string | null;
  readonly started_at: string;
  readonly last_seen_at: string;
  readonly last_response_at: string | null;
  readonly request_count: number;
  readonly target: string | null;
}

/** One entry of the group list, projected so no task JSON column is read. */
export type TaskSummaryRow = TaskSummaryRowFields & Record<string, unknown>;

/** The `target` a group shows: the task's own, or the newest record's upstream. */
const TASK_TARGET_SQL = `COALESCE(
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
          )`;

export class TaskStore {
  readonly #database: Database.Database;
  readonly #now: () => string;
  readonly #search: SearchStore;

  constructor(database: Database.Database, now: () => string, search: SearchStore) {
    this.#database = database;
    this.#now = now;
    this.#search = search;
  }

  /** Inserts a task, or replaces the stored one while keeping its `created_at`. */
  write(task: Readonly<TaskWrite>): TaskRow {
    const now = this.#now();
    const values = {
      id: task.id,
      kind: task.kind === undefined || task.kind === "" ? "request" : task.kind,
      endpoint: optionalString(task.endpoint),
      anchor: optionalString(task.anchor),
      model: optionalString(task.model),
      target: optionalString(task.target),
      started_at: textOr(task.started_at ?? task.last_seen_at, now),
      last_seen_at: textOr(task.last_seen_at ?? task.started_at, now),
      last_response_at: optionalString(task.last_response_at),
      request_count: integerValue(task.request_count, 0),
      pending_request_only: task.pending_request_only ? 1 : 0,
      match_confidence: floatValue(task.match_confidence ?? task.last_match_confidence, 1),
      match_strategy_version: integerValue(task.match_strategy_version, 1),
      fingerprints_json: jsonText(task.fingerprints, {}),
      boundary_fingerprints_json: jsonText(task.boundary_fingerprints, {}),
      last_user_messages_json: jsonText(task.last_user_messages, []),
      created_at: textOr(task.created_at, now),
      updated_at: textOr(task.updated_at, now),
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
    const loaded = this.get(values.id);
    if (loaded === undefined) {
      throw new Error(`Task ${values.id} was not saved.`);
    }
    return loaded;
  }

  /** One task row, decoded; undefined when no task has that id. */
  get(taskId: string): TaskRow | undefined {
    const row = this.#database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    return row === undefined ? undefined : decodeTaskRow(row as RepositoryRecord);
  }

  has(taskId: string): boolean {
    return this.#database.prepare("SELECT 1 FROM tasks WHERE id = ?").get(taskId) !== undefined;
  }

  /**
   * The stored task row exactly as it sits in the table, with the JSON columns
   * still encoded. The search index hashes that form, so it must be given the
   * stored row and not the decoded one.
   */
  rawRow(taskId: string): RepositoryRecord | undefined {
    return this.#database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      RepositoryRecord | undefined;
  }

  /** Records the response id a request answered, so a later request can continue it. */
  linkResponse(responseId: string, taskId: string): void {
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

  /** The task that answered the given response id, or undefined when none did. */
  taskForResponse(responseId: string): string | undefined {
    const taskId = this.#database
      .prepare("SELECT task_id FROM response_links WHERE response_id = ?")
      .pluck()
      .get(responseId);
    return typeof taskId === "string" ? taskId : undefined;
  }

  /** Records a context key found in a request, so a later request can continue it. */
  linkContext(contextKey: string, taskId: string): void {
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

  /** The task that carries the given context key, or undefined when none does. */
  taskForContext(contextKey: string): string | undefined {
    const taskId = this.#database
      .prepare("SELECT task_id FROM context_links WHERE context_key = ?")
      .pluck()
      .get(contextKey);
    return typeof taskId === "string" ? taskId : undefined;
  }

  /** The tasks the matcher may continue, newest first, in-flight groups excluded. */
  recent(limit = 200): readonly TaskRow[] {
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
      .all(boundedLimit) as readonly RepositoryRecord[];
    return rows.map((row) => decodeTaskRow(row));
  }

  /** Every column of the matching tasks, newest first, one page at a time. */
  list(query = "", limit = 100, offset = 0): RepositoryPage<TaskRow> {
    const boundedLimit = Math.max(1, Math.min(integerValue(limit, 100), 500));
    const boundedOffset = Math.max(0, integerValue(offset, 0));
    const filter = this.#search.taskTextFilter(query);
    const whereSql = filter.sql === "" ? "" : `WHERE ${filter.sql}`;
    const total = this.#database
      .prepare(`SELECT COUNT(*) AS count FROM tasks ${whereSql}`)
      .pluck()
      .get(...filter.parameters) as number;
    const rows = this.#database
      .prepare(
        `
        SELECT tasks.*,
          ${TASK_TARGET_SQL} AS target
        FROM tasks
        ${whereSql}
        ORDER BY COALESCE(last_seen_at, last_response_at, started_at) DESC
        LIMIT ? OFFSET ?
      `,
      )
      .all(...filter.parameters, boundedLimit, boundedOffset) as readonly RepositoryRecord[];
    return repositoryPage(
      rows.map((row) => decodeTaskRow(row)),
      total,
      boundedLimit,
      boundedOffset,
    );
  }

  /** The group list the console shows: only the columns a group row needs. */
  listSummaries(query = "", limit = 100, offset = 0): RepositoryPage<TaskSummaryRow> {
    const boundedLimit = Math.max(1, Math.min(integerValue(limit, 100), 500));
    const boundedOffset = Math.max(0, integerValue(offset, 0));
    const filter = this.#search.taskIdFilter(query);
    const whereSql = filter.sql === "" ? "" : `WHERE ${filter.sql}`;
    const total = this.#database
      .prepare(`SELECT COUNT(*) AS count FROM tasks ${whereSql}`)
      .pluck()
      .get(...filter.parameters) as number;
    const items = this.#database
      .prepare(
        `
        SELECT id, model, started_at, last_seen_at, last_response_at, request_count,
          ${TASK_TARGET_SQL} AS target
        FROM tasks
        ${whereSql}
        ORDER BY COALESCE(last_seen_at, last_response_at, started_at) DESC
        LIMIT ? OFFSET ?
      `,
      )
      .all(...filter.parameters, boundedLimit, boundedOffset) as readonly TaskSummaryRow[];
    return repositoryPage(items, total, boundedLimit, boundedOffset);
  }

  /**
   * Deletes the given tasks, and with them their records, links and search rows.
   * Returns how many task rows went away. Use `removeInside` when the caller is
   * already inside a transaction; nesting a transaction there would open a
   * savepoint that the caller's rollback would have to unwind.
   */
  remove(taskIds: readonly string[]): number {
    return this.#database.transaction(() => this.removeInside(taskIds))();
  }

  /** The same statements, without opening a transaction of its own. */
  removeInside(taskIds: readonly string[]): number {
    const selected = taskIds.filter((taskId) => taskId.trim() !== "");
    if (selected.length === 0) {
      return 0;
    }
    const placeholders = selected.map(() => "?").join(",");
    this.#search.deleteRows(this.#search.rowidsForTasks(selected));
    return this.#database
      .prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`)
      .run(...selected).changes;
  }
}

/** Turns a stored task row into the task the rest of the application reads. */
export function decodeTaskRow(row: Readonly<RepositoryRecord>): TaskRow {
  const decoded: Record<string, unknown> = { ...row };
  decoded["pending_request_only"] = Boolean(decoded["pending_request_only"]);
  decoded["fingerprints"] = storedJsonObject(decoded["fingerprints_json"]);
  decoded["boundary_fingerprints"] = storedJsonObject(decoded["boundary_fingerprints_json"]);
  decoded["last_user_messages"] = storedJsonArray(decoded["last_user_messages_json"]);
  for (const column of [
    "fingerprints_json",
    "boundary_fingerprints_json",
    "last_user_messages_json",
  ]) {
    Reflect.deleteProperty(decoded, column);
  }
  return decoded as TaskRow;
}
