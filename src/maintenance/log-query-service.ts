import { TrafficRepository, type RepositoryRecord } from "../persistence/index.js";
import { formatLocalTimestamp } from "../shared/index.js";

export interface LogGroupSummary {
  readonly id: string;
  readonly meta: string;
  readonly model: string | null;
  readonly request_count: number;
  readonly target: string | null;
  readonly title: string;
}

export interface LogGroupPage {
  readonly groups: readonly LogGroupSummary[];
  readonly has_more: boolean;
  readonly limit: number;
  readonly next_offset: number;
  readonly offset: number;
  readonly total: number;
}

export interface LogListItem {
  readonly endpoint: string;
  readonly id: string;
  readonly message_count: number | null;
  readonly method: string;
  readonly path: string;
  readonly sequence: string;
  readonly status: number | null;
  readonly target: string;
  readonly timestamp: string;
  readonly token_count: number | null;
}

export interface LogGroupLogs {
  readonly id: string;
  readonly logs: readonly LogListItem[];
}

export interface LogRecordDetail {
  readonly id: string;
  readonly pending: boolean;
  readonly request: unknown;
  readonly request_meta: Readonly<Record<string, unknown>>;
  readonly response: unknown;
  readonly response_meta: Readonly<Record<string, unknown>>;
}

export class LogQueryService {
  readonly #logRoots: () => readonly string[];

  constructor(logRoots: readonly string[] | (() => readonly string[])) {
    this.#logRoots = typeof logRoots === "function" ? logRoots : () => logRoots;
  }

  listGroups(query = "", limit = 100, offset = 0): LogGroupPage {
    const boundedLimit = Math.max(1, Math.min(integer(limit, 100), 500));
    const boundedOffset = Math.max(0, integer(offset, 0));
    const roots = [...new Set(this.#logRoots().filter((root) => root !== ""))];
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
      const page = repository.listTasks(query, boundedLimit, boundedOffset);
      return {
        groups: page.items.map(taskGroupSummary),
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

  getGroupLogs(groupId: string, query = ""): LogGroupLogs | undefined {
    for (const root of [...new Set(this.#logRoots().filter((value) => value !== ""))]) {
      const repository = new TrafficRepository(root);
      try {
        if (repository.getTask(groupId) === undefined) {
          continue;
        }
        const page = repository.listTaskRecords(groupId, query, 200, 0);
        return { id: groupId, logs: page.items.map(logListItem) };
      } finally {
        repository.close();
      }
    }
    return undefined;
  }

  getRecordDetail(recordId: string): LogRecordDetail | undefined {
    for (const root of [...new Set(this.#logRoots().filter((value) => value !== ""))]) {
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

  #listMergedGroups(
    roots: readonly string[],
    query: string,
    limit: number,
    offset: number,
  ): LogGroupPage {
    const tasks: RepositoryRecord[] = [];
    let total = 0;
    const fetchLimit = offset + limit;
    for (const root of roots) {
      const repository = new TrafficRepository(root);
      try {
        const page = repository.listTasks(query, fetchLimit, 0);
        total += page.total;
        tasks.push(...page.items);
      } finally {
        repository.close();
      }
    }
    tasks.sort((left, right) => taskSortTime(right) - taskSortTime(left));
    const groups = tasks.slice(offset, offset + limit).map(taskGroupSummary);
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

function recordDetail(record: Readonly<RepositoryRecord>): LogRecordDetail {
  const proxyName = string(record["proxy_name"]);
  return {
    id: string(record["id"]),
    pending: string(record["event"]) !== "request_finished",
    request: record["request_body"] ?? null,
    response: record["response_body"] ?? null,
    request_meta: compactMeta({
      id: record["id"],
      sequence: record["sequence"],
      timestamp: displayTimestamp(record["timestamp"]) || record["timestamp"],
      duration_ms: record["duration_ms"],
      method: record["method"],
      path: record["path"],
      endpoint: record["endpoint"],
      target: record["target_url"],
      proxy: proxyName === "" ? record["proxy_id"] : proxyName,
      client: clientAddress(record),
      message_count: record["message_count"],
      model_route: record["model_route"],
      stripped_fields: record["stripped_fields"],
      injected_fields: record["injected_fields"],
      added_upstream_headers: record["added_upstream_headers"],
      headers: record["request_headers"],
    }),
    response_meta: compactMeta({
      status: record["status"],
      duration_ms: record["duration_ms"],
      token_count: record["token_count"],
      error: record["error"],
      headers: record["response_headers"],
    }),
  };
}

function clientAddress(record: Readonly<RepositoryRecord>): string {
  const host = string(record["client_host"]);
  const port = record["client_port"];
  return host === "" ? "" : port === null || port === undefined ? host : `${host}:${string(port)}`;
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

function logListItem(record: Readonly<RepositoryRecord>): LogListItem {
  return {
    id: string(record["id"]),
    timestamp: displayTimestamp(record["timestamp"]) || string(record["timestamp"]),
    sequence: string(record["sequence"]),
    method: string(record["method"]),
    path: string(record["path"]),
    endpoint: string(record["endpoint"]),
    message_count: optionalInteger(record["message_count"]),
    status: optionalInteger(record["status"]),
    token_count: optionalInteger(record["token_count"]),
    target: string(record["target_url"]),
  };
}

function taskSortTime(task: Readonly<RepositoryRecord>): number {
  const value = task["last_response_at"] ?? task["last_seen_at"] ?? task["started_at"];
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function taskGroupSummary(task: Readonly<RepositoryRecord>): LogGroupSummary {
  const requestCount = integer(task["request_count"], 0);
  const model = optionalString(task["model"]);
  const target = optionalString(task["target"]);
  const meta = [
    ...(model === null ? [] : [basename(model)]),
    `${requestCount} requests`,
    ...(target === null ? [] : [target]),
  ].join(" | ");
  return {
    id: string(task["id"]),
    title: taskTitle(task),
    meta,
    model,
    target,
    request_count: requestCount,
  };
}

function taskTitle(task: Readonly<RepositoryRecord>): string {
  const start = displayTimestamp(task["started_at"]);
  const end = displayTimestamp(task["last_response_at"] ?? task["last_seen_at"]);
  if (start !== "" && end !== "") {
    return start.slice(0, 10) === end.slice(0, 10)
      ? `${start} - ${end.slice(11)}`
      : `${start} - ${end}`;
  }
  return start || end || string(task["id"]);
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
