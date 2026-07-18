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

export class LogQueryService {
  readonly #logRoots: () => readonly string[];

  constructor(logRoots: readonly string[] | (() => readonly string[])) {
    this.#logRoots = typeof logRoots === "function" ? logRoots : () => logRoots;
  }

  listGroups(query = "", limit = 100, offset = 0): LogGroupPage {
    const boundedLimit = Math.max(1, Math.min(integer(limit, 100), 500));
    const boundedOffset = Math.max(0, integer(offset, 0));
    const root = this.#logRoots()[0];
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

function emptyPage(limit: number, offset: number): LogGroupPage {
  return { groups: [], total: 0, limit, offset, next_offset: offset, has_more: false };
}
