import type Database from "better-sqlite3";

import { formatLocalTimestamp } from "../shared/index.js";
import { integerValue, stringValue } from "./column-codec.js";
import { repositoryPage, type RepositoryPage, type RepositoryRecord } from "./access-contracts.js";
import type { RecordSummaryRow } from "./record-store.js";

/**
 * The search index: what text of a task and a record becomes searchable, and how
 * the FTS rows stay in step with the records they describe.
 *
 * This module changes when the searchable text changes (a new column joins the
 * index, a timestamp must also match in local time) or when the FTS layout
 * changes. It affects the `record_search_fts` and `record_search_map` tables and
 * nothing else; a task or record row that is written without calling `syncRecord`
 * simply stays invisible to search.
 *
 * The filters it hands back are SQL fragments plus the parameters for them. They
 * must stay uncorrelated: a correlated `EXISTS` makes SQLite full-scan the
 * contentless FTS table once per outer row — minutes on a real database — while
 * these forms evaluate the FTS query exactly once and then resolve ids by primary
 * key. Keep that property when editing them.
 */

/** A SQL fragment that restricts a listing to matching rows, with its parameters. */
export interface SearchFilter {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

export interface RecordSearchDocument {
  readonly recordId: string;
  readonly taskId: string;
  readonly taskText: string;
  readonly requestText: string;
  readonly responseText: string;
  readonly errorText: string;
}

/** The columns that make a record findable in the request text. */
const REQUEST_SEARCH_KEYS = [
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
] as const;

export function recordSearchDocument(
  values: Readonly<RepositoryRecord>,
  task: Readonly<RepositoryRecord> | undefined,
): RecordSearchDocument {
  return {
    recordId: stringValue(values["id"]),
    taskId: stringValue(values["task_id"]),
    taskText: searchText(...(task === undefined ? [values["task_id"]] : Object.values(task))),
    requestText: searchText(...REQUEST_SEARCH_KEYS.map((key) => values[key])),
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

/**
 * The searchable text of the given cells. Timestamps are added twice: as stored
 * (UTC, with a `T`) and as the console displays them, so a search for a local
 * time finds the row that was written at that moment.
 */
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

/** One FTS query that matches every term of the search text. */
function allTermsQuery(query: string): string {
  return searchTerms(query)
    .map((term) => ftsQuery(term))
    .join(" AND ");
}

export class SearchStore {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  /**
   * Keeps the FTS row of one record in step with the row itself. Runs inside the
   * caller's transaction so a record write and its search entry commit together.
   */
  syncRecord(values: Readonly<RepositoryRecord>, task: Readonly<RepositoryRecord> | undefined) {
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

  /** The FTS rowids that belong to the given tasks, before those tasks are deleted. */
  rowidsForTasks(taskIds: readonly string[]): readonly number[] {
    const placeholders = taskIds.map(() => "?").join(",");
    return this.#database
      .prepare(`SELECT search_rowid FROM record_search_map WHERE task_id IN (${placeholders})`)
      .pluck()
      .all(...taskIds) as number[];
  }

  /** Drops the FTS rows of the given rowids; the map rows go with the task itself. */
  deleteRows(rowids: readonly number[]): void {
    const deleteSearch = this.#database.prepare("DELETE FROM record_search_fts WHERE rowid = ?");
    for (const rowid of rowids) deleteSearch.run(rowid);
  }

  /**
   * Restricts a task listing to tasks whose own row text matches a term, or whose
   * records match it. Every term must match, so an empty search returns everything.
   */
  taskTextFilter(query: string): SearchFilter {
    const terms = searchTerms(query);
    if (terms.length === 0) {
      return { sql: "", parameters: [] };
    }
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
    return {
      sql: clauses.join(" AND "),
      parameters: terms.flatMap((term) => [likePattern(term), ftsQuery(term)]),
    };
  }

  /**
   * Restricts a task listing to tasks that hold at least one record matching every
   * term. Kept identical to `recordIdFilter` so a listed group always contains an
   * expandable record.
   */
  taskIdFilter(query: string): SearchFilter {
    const terms = searchTerms(query);
    if (terms.length === 0) {
      return { sql: "", parameters: [] };
    }
    return {
      sql: `tasks.id IN (
          SELECT record_search_map.task_id
          FROM record_search_fts
          JOIN record_search_map ON record_search_map.search_rowid = record_search_fts.rowid
          WHERE record_search_fts MATCH ?
        )`,
      parameters: [allTermsQuery(query)],
    };
  }

  /** Restricts a record listing to records whose own FTS row matches every term. */
  recordIdFilter(query: string): SearchFilter {
    const terms = searchTerms(query);
    if (terms.length === 0) {
      return { sql: "", parameters: [] };
    }
    return {
      sql: `records.id IN (
          SELECT record_search_map.record_id
          FROM record_search_fts
          JOIN record_search_map ON record_search_map.search_rowid = record_search_fts.rowid
          WHERE record_search_fts MATCH ?
        )`,
      parameters: [allTermsQuery(query)],
    };
  }

  /**
   * The first matching records of each of the given groups, for the search preview
   * the console shows under a group. Only ids are ranked first: one FTS evaluation
   * serves the whole visible group page, and no body is read.
   */
  previews(
    taskIds: readonly string[],
    query: string,
    limit = 20,
  ): Map<string, RepositoryPage<RecordSummaryRow>> {
    const pages = new Map<string, RepositoryPage<RecordSummaryRow>>();
    const terms = searchTerms(query);
    if (!taskIds.length || !terms.length) return pages;
    const boundedLimit = Math.max(1, Math.min(integerValue(limit, 20), 200));
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
          records.event, records.first_token_ms, records.decode_window_ms, records.duration_ms,
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
      .all(...taskIds, allTermsQuery(query), boundedLimit) as readonly (RecordSummaryRow & {
      total: number;
    })[];
    for (const taskId of taskIds) {
      const items = rows.filter((row) => row["task_id"] === taskId);
      const total = items[0]?.total ?? 0;
      pages.set(taskId, repositoryPage<RecordSummaryRow>(items, total, boundedLimit, 0));
    }
    return pages;
  }
}
