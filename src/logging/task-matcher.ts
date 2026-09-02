import type { RepositoryRecord } from "../persistence/index.js";
import type { TrafficRepository } from "../persistence/index.js";
import {
  bodyJsonValue,
  endpointKind,
  requestBoundaryFingerprints,
  requestFingerprints,
  requestUserMessages,
  responseIdsFromBody,
  type EndpointKind,
} from "../proxy/index.js";
import {
  createRequestId,
  isRecord,
  localNowIso,
  safeIdentifierPart,
  stableJsonStringify,
} from "../shared/index.js";

export interface TaskAssignment {
  readonly task: Readonly<RepositoryRecord>;
  readonly sequence: number;
  readonly kind: EndpointKind;
  readonly requestPayload: unknown;
  readonly responsePayload: unknown;
  readonly responseIds: readonly string[];
  readonly contextKeys: readonly string[];
  readonly supersededTaskIds: readonly string[];
}

export interface TaskMatcherOptions {
  readonly createId?: () => string;
  readonly now?: () => string;
}

export const TASK_MATCH_STRATEGY_VERSION = 6;

const MODEL_TASK_KINDS = new Set<EndpointKind>(["responses", "chat", "messages", "completions"]);
const TASK_MATCH_WINDOW_MS = 24 * 60 * 60 * 1_000;

export class TaskMatcher {
  readonly #repository: TrafficRepository;
  readonly #createId: () => string;
  readonly #now: () => string;

  constructor(repository: TrafficRepository, options: TaskMatcherOptions = {}) {
    this.#repository = repository;
    this.#createId = options.createId ?? createRequestId;
    this.#now = options.now ?? localNowIso;
  }

  assign(record: Readonly<RepositoryRecord>): TaskAssignment | undefined {
    const request = record["request"];
    if (!isRecord(request)) {
      return undefined;
    }
    const requestId = stringValue(record["id"]);
    if (requestId === "") {
      return undefined;
    }
    const kind = endpointKind(requestPath(request));
    if (request["body_pending"] === true) {
      const task = this.#pendingTask(record, requestId, kind);
      return {
        task,
        sequence: this.#sequenceForRecord(requestId, stringValue(task["id"])),
        kind,
        requestPayload: {},
        responsePayload: null,
        responseIds: [],
        contextKeys: [],
        supersededTaskIds: [],
      };
    }

    const requestPayload = bodyPayload(request["body"]);
    const response = record["response"];
    const responsePayload = isRecord(response) ? bodyPayload(response["body"]) : null;
    const contextKeys = isRecord(requestPayload) ? this.#contextKeys(requestPayload, record) : [];
    const requestTask = this.#existingTask(requestId);
    const continuationTask =
      requestTask === undefined || requestTask["pending_request_only"] === true
        ? this.#continuationTask(record, kind, requestPayload, contextKeys)
        : undefined;
    const existing =
      requestTask?.["pending_request_only"] === true
        ? (continuationTask ?? requestTask)
        : (requestTask ?? continuationTask);
    const supersededTaskIds =
      requestTask?.["pending_request_only"] === true && continuationTask !== undefined
        ? [stringValue(requestTask["id"])]
        : [];
    const matchedTask =
      existing === undefined
        ? this.#newTask(record, kind)
        : existing["pending_request_only"] === true
          ? this.#promotePending(existing, record, kind)
          : existing;
    const task = this.#updatedTask(
      matchedTask,
      record,
      requestId,
      kind,
      requestPayload,
      responsePayload,
    );
    return {
      task,
      sequence: this.#sequenceForRecord(requestId, stringValue(task["id"])),
      kind,
      requestPayload,
      responsePayload,
      responseIds: responseIdsFromBody(responsePayload),
      contextKeys,
      supersededTaskIds,
    };
  }

  #continuationTask(
    record: Readonly<RepositoryRecord>,
    kind: EndpointKind,
    payload: unknown,
    contextKeys: readonly string[],
  ): RepositoryRecord | undefined {
    return (
      this.#taskForPreviousResponse(record, kind, payload) ??
      this.#taskForContextKeys(contextKeys, record, kind, payload) ??
      (MODEL_TASK_KINDS.has(kind) ? this.#bestHeuristicTask(record, kind, payload) : undefined)
    );
  }

  #existingTask(requestId: string): RepositoryRecord | undefined {
    const taskId = this.#repository.taskIdForRecord(requestId);
    return taskId === undefined ? undefined : this.#repository.getTask(taskId);
  }

  #taskForPreviousResponse(
    record: Readonly<RepositoryRecord>,
    kind: EndpointKind,
    payload: unknown,
  ): RepositoryRecord | undefined {
    if (kind !== "responses" || !isRecord(payload)) {
      return undefined;
    }
    const previousResponseId = payload["previous_response_id"];
    if (typeof previousResponseId !== "string" || previousResponseId === "") {
      return undefined;
    }
    const taskId = this.#repository.taskIdForResponse(previousResponseId);
    const task = taskId === undefined ? undefined : this.#repository.getTask(taskId);
    return task !== undefined && this.#staticBoundariesMatch(task, record, kind, payload, false)
      ? task
      : undefined;
  }

  #taskForContextKeys(
    contextKeys: readonly string[],
    record: Readonly<RepositoryRecord>,
    kind: EndpointKind,
    payload: unknown,
  ): RepositoryRecord | undefined {
    for (const contextKey of contextKeys) {
      const taskId = this.#repository.taskIdForContext(contextKey);
      if (taskId !== undefined) {
        const task = this.#repository.getTask(taskId);
        if (task !== undefined && this.#staticBoundariesMatch(task, record, kind, payload, false)) {
          return task;
        }
      }
    }
    return undefined;
  }

  #staticBoundariesMatch(
    task: Readonly<RepositoryRecord>,
    record: Readonly<RepositoryRecord>,
    kind: EndpointKind,
    payload: unknown,
    includeUserBoundary: boolean,
  ): boolean {
    if (task["kind"] !== kind) {
      return false;
    }
    const endpoint = task["endpoint"];
    if (typeof endpoint === "string" && endpoint !== "" && endpoint !== recordRequestPath(record)) {
      return false;
    }
    const requestedModel = isRecord(payload) ? (payload["model"] ?? null) : null;
    if ((task["model"] ?? null) !== requestedModel) {
      return false;
    }
    const taskFingerprints = isRecord(task["boundary_fingerprints"])
      ? { ...task["boundary_fingerprints"] }
      : {};
    const requestFingerprints = requestBoundaryFingerprints(kind, payload);
    if (!includeUserBoundary) {
      delete taskFingerprints["first_user"];
      delete requestFingerprints["first_user"];
    }
    return stableJsonStringify(taskFingerprints) === stableJsonStringify(requestFingerprints);
  }

  #bestHeuristicTask(
    record: Readonly<RepositoryRecord>,
    kind: EndpointKind,
    payload: unknown,
  ): RepositoryRecord | undefined {
    const recordTime = timestampMilliseconds(record["timestamp"]) ?? this.#nowMilliseconds();
    let bestTask: RepositoryRecord | undefined;
    let bestAge = Number.POSITIVE_INFINITY;
    for (const task of this.#repository.recentTasks()) {
      if (!this.#staticBoundariesMatch(task, record, kind, payload, true)) {
        continue;
      }
      const taskTime = timestampMilliseconds(task["last_seen_at"] ?? task["started_at"]);
      if (taskTime === undefined) {
        continue;
      }
      const age = Math.abs(recordTime - taskTime);
      if (
        (kind === "chat" || kind === "messages" || kind === "responses") &&
        !taskUserMessagesMatch(task, requestUserMessages(kind, payload))
      ) {
        continue;
      }
      if (
        (kind === "chat" || kind === "messages" || kind === "responses") &&
        !taskHasContinuationEvidence(task, kind, payload)
      ) {
        continue;
      }
      if (age <= TASK_MATCH_WINDOW_MS && age < bestAge) {
        bestAge = age;
        bestTask = task;
      }
    }
    return bestTask === undefined ? undefined : { ...bestTask, match_confidence: 0.95 };
  }

  #nowMilliseconds(): number {
    return timestampMilliseconds(this.#now()) ?? Date.now();
  }

  #contextKeys(
    payload: Readonly<Record<string, unknown>>,
    record: Readonly<RepositoryRecord>,
  ): string[] {
    const keys: string[] = [];
    const seen = new Set<string>();
    const addKey = (prefix: string, value: unknown): void => {
      if (typeof value !== "string" || value.trim() === "") {
        return;
      }
      const key = `${prefix}:${value.trim()}`;
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    };
    const conversation = payload["conversation"];
    const conversationId = firstString(
      conversation,
      nestedValue(conversation, "id"),
      payload["conversation_id"],
      payload["thread_id"],
      nestedValue(payload, "metadata", "conversation_id"),
      nestedValue(payload, "metadata", "thread_id"),
      nestedValue(payload, "metadata", "session_id"),
    );
    addKey("conversation", conversationId);
    addKey("prompt_cache", payload["prompt_cache_key"]);
    addKey("prompt_cache", record["prompt_cache_key"]);
    addKey("client_thread", nestedValue(record, "client_metadata", "thread_id"));
    addKey("client_session", nestedValue(record, "client_metadata", "session_id"));
    addKey(
      "claude_session",
      headerValue(nestedValue(record, "request", "headers"), "x-claude-code-session-id"),
    );
    return keys;
  }

  #sequenceForRecord(requestId: string, taskId: string): number {
    const existing = this.#repository.getRecord(requestId);
    if (existing?.["task_id"] === taskId) {
      const sequence = existing["sequence"];
      return typeof sequence === "number" && Number.isInteger(sequence) ? sequence : 1;
    }
    return this.#repository.nextRecordSequence(taskId);
  }

  #pendingTask(
    record: Readonly<RepositoryRecord>,
    requestId: string,
    kind: EndpointKind,
  ): RepositoryRecord {
    const existing = this.#existingTask(requestId);
    if (existing?.["pending_request_only"] === true) {
      return existing;
    }
    return {
      ...this.#newTask(record, kind),
      anchor: `pending-${safeIdentifierPart(requestId, "unknown", 32)}`,
      pending_request_only: true,
      request_count: 1,
    };
  }

  #promotePending(
    task: Readonly<RepositoryRecord>,
    record: Readonly<RepositoryRecord>,
    kind: EndpointKind,
  ): RepositoryRecord {
    return {
      ...task,
      pending_request_only: false,
      kind,
      endpoint: recordRequestPath(record),
      anchor: taskAnchor(record),
      match_confidence: 1,
    };
  }

  #newTask(record: Readonly<RepositoryRecord>, kind: EndpointKind): RepositoryRecord {
    const now = this.#now();
    const request = record["request"];
    const payload = isRecord(request) ? bodyPayload(request["body"]) : null;
    const model = isRecord(payload) ? payload["model"] : undefined;
    return {
      id: this.#createId(),
      kind,
      anchor: taskAnchor(record),
      started_at: record["started_timestamp"] ?? record["timestamp"] ?? now,
      last_seen_at: latestTimestamp(now, record["timestamp"]),
      endpoint: recordRequestPath(record),
      match_strategy_version: TASK_MATCH_STRATEGY_VERSION,
      ...(typeof model === "string" && model !== "" ? { model } : {}),
      fingerprints: requestFingerprints(kind, payload),
      boundary_fingerprints: requestBoundaryFingerprints(kind, payload),
      last_user_messages: requestUserMessages(kind, payload),
      request_count: 0,
      pending_request_only: false,
      match_confidence: 1,
      created_at: now,
      updated_at: now,
    };
  }

  #updatedTask(
    task: Readonly<RepositoryRecord>,
    record: Readonly<RepositoryRecord>,
    requestId: string,
    kind: EndpointKind,
    payload: unknown,
    responsePayload: unknown,
  ): RepositoryRecord {
    const taskId = stringValue(task["id"]);
    const now = this.#now();
    const observedAt = latestTimestamp(now, task["last_seen_at"], record["timestamp"]);
    const response = record["response"];
    const status = isRecord(response) ? response["status"] : undefined;
    const model = isRecord(payload) ? payload["model"] : undefined;
    const existingRecord = this.#repository.getRecord(requestId);
    const responseIds = responseIdsFromBody(responsePayload);
    const hasResponse = (status !== null && status !== undefined) || responseIds.length > 0;
    return {
      ...task,
      pending_request_only: false,
      kind,
      endpoint: recordRequestPath(record),
      last_seen_at: observedAt,
      ...(hasResponse
        ? { last_response_at: latestTimestamp(now, task["last_response_at"], record["timestamp"]) }
        : {}),
      ...(typeof model === "string" && model !== "" ? { model } : {}),
      fingerprints: requestFingerprints(kind, payload),
      boundary_fingerprints: requestBoundaryFingerprints(kind, payload),
      last_user_messages: requestUserMessages(kind, payload),
      request_count:
        this.#repository.recordCount(taskId) + (existingRecord?.["task_id"] === taskId ? 0 : 1),
      updated_at: now,
    };
  }
}

function bodyPayload(value: unknown): unknown {
  if (!isRecord(value)) {
    return null;
  }
  const sizeBytes = value["size_bytes"];
  const text = value["text"];
  if (typeof sizeBytes !== "number" || typeof text !== "string") {
    return null;
  }
  return bodyJsonValue({
    size_bytes: sizeBytes,
    text,
    ...(typeof value["captured_bytes"] === "number"
      ? { captured_bytes: value["captured_bytes"] }
      : {}),
    ...(typeof value["sha256"] === "string" ? { sha256: value["sha256"] } : {}),
    ...(value["truncated"] === true ? { truncated: true } : {}),
    ...(typeof value["truncation_reason"] === "string"
      ? { truncation_reason: value["truncation_reason"] }
      : {}),
    ...(isRecord(value["stream_summary"]) ? { stream_summary: value["stream_summary"] } : {}),
  } satisfies Parameters<typeof bodyJsonValue>[0]);
}

function recordRequestPath(record: Readonly<RepositoryRecord>): string {
  const request = record["request"];
  return isRecord(request) ? requestPath(request) : "";
}

function requestPath(request: Readonly<Record<string, unknown>>): string {
  return typeof request["path"] === "string" ? request["path"] : "";
}

function taskAnchor(record: Readonly<RepositoryRecord>): string {
  return `req-${stringValue(record["id"]).slice(0, 12)}`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function nestedValue(value: unknown, ...path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

function headerValue(headers: unknown, requestedName: string): unknown {
  if (!isRecord(headers)) {
    return undefined;
  }
  const entry = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === requestedName.toLowerCase(),
  );
  const value = entry?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function timestampMilliseconds(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? undefined : milliseconds;
}

function latestTimestamp(fallback: string, ...values: readonly unknown[]): string {
  let latestText = fallback;
  let latestMs = Date.parse(fallback);
  for (const value of values) {
    if (typeof value !== "string" || value === "") {
      continue;
    }
    const milliseconds = Date.parse(value);
    if (Number.isNaN(milliseconds)) {
      if (Number.isNaN(latestMs)) {
        latestText = value;
      }
      continue;
    }
    if (Number.isNaN(latestMs) || milliseconds > latestMs) {
      latestText = value;
      latestMs = milliseconds;
    }
  }
  return latestText;
}

function taskUserMessagesMatch(
  task: Readonly<RepositoryRecord>,
  currentUserMessages: readonly unknown[],
): boolean {
  const previousUserMessages = task["last_user_messages"];
  if (
    !Array.isArray(previousUserMessages) ||
    previousUserMessages.length === 0 ||
    currentUserMessages.length === 0 ||
    previousUserMessages.length > currentUserMessages.length
  ) {
    return false;
  }
  return (
    stableJsonStringify(currentUserMessages.slice(0, previousUserMessages.length)) ===
    stableJsonStringify(previousUserMessages)
  );
}

function taskHasContinuationEvidence(
  task: Readonly<RepositoryRecord>,
  kind: EndpointKind,
  payload: unknown,
): boolean {
  const previousUserMessages = task["last_user_messages"];
  const currentUserMessages = requestUserMessages(kind, payload);
  if (
    Array.isArray(previousUserMessages) &&
    currentUserMessages.length > previousUserMessages.length
  ) {
    return true;
  }
  const previousFingerprints = task["fingerprints"];
  if (!isRecord(previousFingerprints)) {
    return false;
  }
  const currentFingerprints = requestFingerprints(kind, payload);
  return ["input", "messages"].some(
    (key) =>
      typeof previousFingerprints[key] === "string" &&
      typeof currentFingerprints[key] === "string" &&
      previousFingerprints[key] !== currentFingerprints[key],
  );
}
