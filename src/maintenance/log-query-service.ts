import {
  TrafficRepository,
  type RepositoryRecord,
  type TaskPricingAggregate,
} from "../persistence/index.js";
import { formatLocalTimestamp } from "../shared/index.js";
import { createLogExportStream } from "./log-export.js";
import {
  cleanupLogsOlderThan,
  cleanupLogsKeepLatest,
  cleanupSelectedLogGroups,
  type LogCleanupResult,
} from "./log-cleanup.js";
import type { Readable } from "node:stream";
import type { SummaryModelConfig } from "../config/index.js";
import { joinTargetPath } from "../proxy/target.js";
import { UsageStatisticsService } from "./usage-statistics-service.js";

export interface LogGroupSummary {
  readonly cost?: LogTaskCost;
  readonly preview?: LogGroupLogs;
  readonly id: string;
  readonly last_activity_at: string;
  readonly model: string | null;
  readonly request_count: number;
  readonly started_at: string;
  readonly target: string | null;
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

export interface LogListItem {
  readonly cost?: LogRequestCost;
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

export interface LogRequestCost {
  readonly amount: string | null;
  readonly currency: "CNY";
  readonly reason: string | null;
  readonly status: "pending" | "priced" | "unpriced";
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

export interface LogRecordDetail {
  readonly id: string;
  readonly pending: boolean;
  readonly request: unknown;
  readonly request_meta: Readonly<Record<string, unknown>>;
  readonly response: unknown;
  readonly response_meta: Readonly<Record<string, unknown>>;
  readonly pricing?: unknown;
}

export class LogQueryService {
  readonly #logRoots: () => readonly string[];
  readonly #summarizing = new Set<string>();

  constructor(logRoots: readonly string[] | (() => readonly string[])) {
    this.#logRoots = typeof logRoots === "function" ? logRoots : () => logRoots;
  }

  usageStatisticsService(): UsageStatisticsService | undefined {
    const roots = [...new Set(this.#logRoots().filter((item) => item !== ""))];
    if (roots.length === 0) return undefined;
    return new UsageStatisticsService({
      usageStatisticsRows: (from, to) =>
        roots.flatMap((root) => {
          const repository = new TrafficRepository(root);
          try {
            return repository.usageStatisticsRows(from, to);
          } finally {
            repository.close();
          }
        }),
    });
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
      const page = repository.listTaskSummaries(query, boundedLimit, boundedOffset);
      const pricing = repository.taskPricingForTasks(page.items.map((item) => string(item["id"])));
      return {
        groups: groupsWithPreviews(repository, page.items, query, pricing),
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
    for (const root of [...new Set(this.#logRoots().filter((value) => value !== ""))]) {
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

  async summarizeRecord(recordId: string, config: SummaryModelConfig): Promise<unknown> {
    if (this.#summarizing.has(recordId)) throw new Error("summary already in progress");
    this.#summarizing.add(recordId);
    try {
      const detail = this.getRecordDetail(recordId);
      if (!detail) return undefined;
      const input = JSON.stringify(prepareSummaryRequest(detail.request));
      const endpoint =
        config.api_type === "openai_responses"
          ? "/responses"
          : config.api_type === "anthropic_messages"
            ? "/messages"
            : "/chat/completions";
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...(config.api_type === "anthropic_messages"
          ? { "x-api-key": config.api_key, "anthropic-version": "2023-06-01" }
          : { authorization: `Bearer ${config.api_key}` }),
      };
      const instruction =
        "请将输入按连续编号区间归纳为阶段摘要，不要逐条复述。严格输出 JSON：{title,overview,segments:[{range,summary,key_points,evidence}],decisions,issues}。每个 segment 的 range 使用如 1-6、7-12 的连续区间，evidence 填引用的消息编号。";
      const body =
        config.api_type === "openai_responses"
          ? {
              model: config.model,
              input: `${instruction}\n\n${input}`,
              stream: false,
              ...(config.disable_reasoning ? { reasoning_effort: "none" } : {}),
            }
          : config.api_type === "anthropic_messages"
            ? {
                model: config.model,
                max_tokens: 2000,
                system: instruction,
                messages: [{ role: "user", content: input }],
                stream: false,
                ...(config.disable_reasoning ? { reasoning_effort: "none" } : {}),
              }
            : {
                model: config.model,
                temperature: 0,
                messages: [
                  {
                    role: "system",
                    content: instruction,
                  },
                  { role: "user", content: input },
                ],
                stream: false,
                ...(config.disable_reasoning ? { reasoning_effort: "none" } : {}),
              };
      const target = new URL(config.target_url);
      const basePath = target.pathname.replace(/\/$/u, "");
      target.pathname = basePath.endsWith(endpoint) ? basePath : joinTargetPath(basePath, endpoint);
      const response = await fetch(target, {
        method: "POST",
        headers: {
          ...headers,
          ...Object.fromEntries(
            config.target_headers.map((h) => {
              const i = h.indexOf(":");
              return [h.slice(0, i).trim(), h.slice(i + 1).trim()];
            }),
          ),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeout_ms),
      });
      if (!response.ok) throw new Error(`summary model returned HTTP ${response.status}`);
      const rawResponse = await response.text();
      if (rawResponse.length > 2_000_000) throw new Error("summary model response is too large");
      const payload: Record<string, unknown> = JSON.parse(rawResponse) as Record<string, unknown>;
      const choices = Array.isArray(payload["choices"]) ? payload["choices"] : [];
      const firstChoice = isRecord(choices[0]) ? choices[0] : undefined;
      const message =
        firstChoice && isRecord(firstChoice["message"]) ? firstChoice["message"] : undefined;
      const content =
        (message && typeof message["content"] === "string" ? message["content"] : undefined) ??
        (typeof payload["output_text"] === "string" ? payload["output_text"] : undefined) ??
        extractResponsesOutput(payload["output"]) ??
        (Array.isArray(payload["content"]) &&
        isRecord(payload["content"][0]) &&
        typeof payload["content"][0]["text"] === "string"
          ? payload["content"][0]["text"]
          : undefined);
      if (!content) throw new Error("summary model returned an empty response");
      let result: unknown;
      try {
        result = JSON.parse(content);
      } catch {
        const match = /```json\s*([\s\S]*?)```/u.exec(content);
        const jsonText = match?.[1];
        if (jsonText === undefined) throw new Error("summary model returned invalid JSON");
        result = JSON.parse(jsonText);
      }
      if (
        !result ||
        typeof result !== "object" ||
        !Array.isArray((result as { segments?: unknown }).segments)
      )
        throw new Error("summary model returned invalid JSON shape");
      this.saveSummary(recordId, result, config.model);
      return result;
    } finally {
      this.#summarizing.delete(recordId);
    }
  }

  getSummary(recordId: string): unknown {
    for (const root of this.#logRoots()) {
      const db = new TrafficRepository(root);
      try {
        const row = db.database
          .prepare(
            "SELECT summary_json FROM history_summaries WHERE record_id = ? AND status = 'ready'",
          )
          .get(recordId) as { summary_json?: string } | undefined;
        if (row?.summary_json) return JSON.parse(row.summary_json);
      } catch {
        /* unavailable */
      } finally {
        db.close();
      }
    }
    return undefined;
  }

  private saveSummary(recordId: string, result: unknown, model: string): void {
    for (const root of this.#logRoots()) {
      const db = new TrafficRepository(root);
      try {
        db.database
          .prepare(
            "INSERT INTO history_summaries(record_id,status,summary_json,model,prompt_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET status='ready',summary_json=excluded.summary_json,model=excluded.model,updated_at=excluded.updated_at",
          )
          .run(
            recordId,
            "ready",
            JSON.stringify(result),
            model,
            "v1",
            new Date().toISOString(),
            new Date().toISOString(),
          );
        return;
      } catch {
        /* try next root */
      } finally {
        db.close();
      }
    }
  }

  getGroupPricing(groupId: string): TaskPricingAggregate | undefined {
    for (const root of [...new Set(this.#logRoots().filter((value) => value !== ""))]) {
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

  exportLogs(): Readable {
    return createLogExportStream(this.#logRoots());
  }

  cleanupSelectedGroups(groupIds: readonly string[]): LogCleanupResult {
    return cleanupSelectedLogGroups(this.#logRoots(), groupIds);
  }

  cleanupOlderThan(olderThanDays: number): LogCleanupResult {
    return cleanupLogsOlderThan(this.#logRoots(), olderThanDays);
  }

  cleanupKeepLatest(keepLatest: number): LogCleanupResult {
    return cleanupLogsKeepLatest(this.#logRoots(), keepLatest);
  }

  #listMergedGroups(
    roots: readonly string[],
    query: string,
    limit: number,
    offset: number,
  ): LogGroupPage {
    const tasks: RepositoryRecord[] = [];
    const taskRoots = new Map<string, string>();
    let total = 0;
    const fetchLimit = offset + limit;
    for (const root of roots) {
      const repository = new TrafficRepository(root);
      try {
        const page = repository.listTaskSummaries(query, fetchLimit, 0);
        total += page.total;
        tasks.push(...page.items);
        for (const task of page.items) taskRoots.set(string(task["id"]), root);
      } finally {
        repository.close();
      }
    }
    tasks.sort((left, right) => taskSortTime(right) - taskSortTime(left));
    const visibleTasks = tasks.slice(offset, offset + limit);
    const summaries = new Map<string, LogGroupSummary>();
    for (const root of roots) {
      const rootTasks = visibleTasks.filter((task) => taskRoots.get(string(task["id"])) === root);
      if (!rootTasks.length) continue;
      const repository = new TrafficRepository(root);
      try {
        const pricing = repository.taskPricingForTasks(rootTasks.map((task) => string(task["id"])));
        if (!query.trim()) {
          for (const task of rootTasks) {
            const group = taskGroupSummary(task, pricing.get(string(task["id"])));
            summaries.set(group.id, group);
          }
          continue;
        }
        for (const group of groupsWithPreviews(repository, rootTasks, query, pricing)) {
          summaries.set(group.id, group);
        }
      } finally {
        repository.close();
      }
    }
    const groups = visibleTasks.map(
      (task) => summaries.get(string(task["id"])) ?? taskGroupSummary(task),
    );
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

function groupsWithPreviews(
  repository: TrafficRepository,
  tasks: readonly RepositoryRecord[],
  query: string,
  pricing = new Map<string, TaskPricingAggregate>(),
): LogGroupSummary[] {
  const previews = repository.listTaskSearchPreviews(
    tasks.map((task) => string(task["id"])),
    query,
  );
  return tasks.map((task) => {
    const group = taskGroupSummary(task, pricing.get(string(task["id"])));
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

function recordDetail(record: Readonly<RepositoryRecord>): LogRecordDetail {
  const proxyName = string(record["proxy_name"]);
  const pending = string(record["event"]) !== "request_finished";
  return {
    id: string(record["id"]),
    pending,
    request: record["request_body"] ?? null,
    response: record["response_body"] ?? null,
    pricing: record["pricing"] ?? null,
    request_meta: compactMeta({
      id: record["id"],
      task_id: record["task_id"],
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
      first_token_ms: pending ? undefined : record["first_token_ms"],
      duration_ms: pending ? undefined : record["duration_ms"],
      request_token_count: record["request_token_count"],
      response_token_count: record["response_token_count"],
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
    cost: requestCost(record),
    has_summary: Number(record["has_summary"]) === 1,
    id: string(record["id"]),
    timestamp: displayTimestamp(record["timestamp"]) || string(record["timestamp"]),
    sequence: string(record["sequence"]),
    method: string(record["method"]),
    path: string(record["path"]),
    endpoint: string(record["endpoint"]),
    message_count: optionalInteger(record["message_count"]),
    status: optionalInteger(record["status"]),
    request_token_count: optionalInteger(record["request_token_count"]),
    response_token_count: optionalInteger(record["response_token_count"]),
    target: string(record["target_url"]),
  };
}

function requestCost(record: Readonly<RepositoryRecord>): LogRequestCost {
  const status = record["pricing_status"];
  const pricingStatus =
    status === "pending" || status === "priced" || status === "unpriced" ? status : "unpriced";
  const nano = record["cost_nano_cny"];
  return {
    currency: "CNY",
    status: pricingStatus,
    reason: typeof record["pricing_reason"] === "string" ? record["pricing_reason"] : null,
    amount: pricingStatus === "priced" && typeof nano === "string" ? nanoToCny(nano) : null,
  };
}

function taskSortTime(task: Readonly<RepositoryRecord>): number {
  const value = task["last_seen_at"] ?? task["last_response_at"] ?? task["started_at"];
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function taskGroupSummary(
  task: Readonly<RepositoryRecord>,
  pricing?: TaskPricingAggregate,
): LogGroupSummary {
  const requestCount = integer(task["request_count"], 0);
  const rawModel = optionalString(task["model"]);
  const model = rawModel === null ? null : basename(rawModel);
  const target = optionalString(task["target"]);
  return {
    cost: taskCost(pricing),
    id: string(task["id"]),
    last_activity_at: displayTimestamp(task["last_seen_at"] ?? task["last_response_at"]),
    model,
    request_count: requestCount,
    started_at: displayTimestamp(task["started_at"]),
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

function extractResponsesOutput(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const item of value) {
    if (!isRecord(item) || !Array.isArray(item["content"])) continue;
    for (const content of item["content"]) {
      if (!isRecord(content)) continue;
      const text = content["text"];
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.length ? parts.join("") : undefined;
}

function prepareSummaryRequest(request: unknown): unknown {
  if (!isRecord(request)) return request;
  const result: Record<string, unknown> = {};
  for (const key of ["model", "messages", "input", "instructions"]) {
    if (request[key] !== undefined)
      result[key] =
        key === "input"
          ? summarizeField("messages", request[key])
          : summarizeField(key, request[key]);
  }
  if (result["messages"] === undefined && result["input"] === undefined) {
    return summarizeValue(request, 0, 4000);
  }
  return result;
}

function summarizeField(key: string, value: unknown): unknown {
  if (key !== "messages" || !Array.isArray(value)) return summarizeValue(value, 0, 6000);
  return value.map((message) => {
    if (!isRecord(message)) return summarizeValue(message, 0, 500);
    const role = typeof message["role"] === "string" ? message["role"] : "unknown";
    const item: Record<string, unknown> = { role };
    // Responses API represents tool interactions as input items rather than
    // chat messages. Keep their identity and linkage intact; only truncate
    // potentially huge arguments/results.
    if (typeof message["type"] === "string") item["type"] = message["type"];
    for (const key of ["id", "call_id", "tool_call_id", "name"] as const) {
      if (message[key] !== undefined) item[key] = message[key];
    }
    for (const key of ["arguments", "output"] as const) {
      if (message[key] !== undefined) item[key] = truncateToolPayload(message[key]);
    }
    if (typeof message["name"] === "string") item["name"] = message["name"];
    if (role === "tool") {
      item["content"] = truncateToolPayload(message["content"]);
    } else if (message["content"] !== undefined) {
      item["content"] = summarizeValue(message["content"], 0, 4000);
    }
    if (Array.isArray(message["tool_calls"])) {
      item["tool_calls"] = message["tool_calls"].map((call) => {
        if (!isRecord(call)) return { type: "tool_call" };
        const fn = isRecord(call["function"]) ? call["function"] : {};
        return {
          id: call["id"],
          type: call["type"] ?? "function",
          function: {
            name: fn["name"] ?? "工具",
            arguments: truncateToolPayload(fn["arguments"]),
          },
        };
      });
    }
    return item;
  });
}

function truncateToolPayload(value: unknown): unknown {
  if (typeof value === "string") return truncateText(value, 2000);
  return summarizeValue(value, 0, 2000);
}

function summarizeValue(value: unknown, depth: number, limit: number): unknown {
  if (typeof value === "string") return truncateText(value, limit);
  if (typeof value !== "object" || value === null) return value;
  if (depth >= 3) return "[内容已省略]";
  if (Array.isArray(value))
    return value.slice(0, 30).map((item) => summarizeValue(item, depth + 1, limit));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (["image", "image_url", "audio", "file", "data", "bytes"].includes(key)) continue;
    result[key] = summarizeValue(item, depth + 1, limit);
  }
  return result;
}

function truncateText(value: unknown, limit: number): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.length <= limit ? value : `${value.slice(0, limit)}…`;
  const serialized = JSON.stringify(value);
  const text = typeof serialized === "string" ? serialized : "";
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
