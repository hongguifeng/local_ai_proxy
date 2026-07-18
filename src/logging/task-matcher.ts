import type { RepositoryRecord } from "../persistence/index.js";
import type { TrafficRepository } from "../persistence/index.js";
import {
  bodyJsonValue,
  endpointKind,
  requestBoundaryFingerprints,
  requestFingerprints,
  requestUserMessages,
  responseIdsFromBody,
  type BytePayload,
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
}

export interface TaskMatcherOptions {
  readonly createId?: () => string;
  readonly now?: () => string;
}

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
      };
    }

    const requestPayload = bodyPayload(request["body"]);
    const response = record["response"];
    const responsePayload = isRecord(response) ? bodyPayload(response["body"]) : null;
    const contextKeys = isRecord(requestPayload) ? this.#contextKeys(requestPayload, record) : [];
    const existing =
      this.#existingTask(requestId) ??
      this.#taskForPreviousResponse(record, kind, requestPayload) ??
      this.#taskForContextKeys(contextKeys, record, kind, requestPayload) ??
      (MODEL_TASK_KINDS.has(kind)
        ? this.#bestHeuristicTask(record, kind, requestPayload)
        : undefined);
    const task =
      existing === undefined
        ? this.#newTask(record, kind)
        : existing["pending_request_only"] === true
          ? this.#promotePending(existing, record, kind)
          : existing;
    return {
      task,
      sequence: this.#sequenceForRecord(requestId, stringValue(task["id"])),
      kind,
      requestPayload,
      responsePayload,
      responseIds: responseIdsFromBody(responsePayload),
      contextKeys,
    };
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
      last_seen_at: record["timestamp"] ?? now,
      endpoint: recordRequestPath(record),
      match_strategy_version: 4,
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
  return bodyJsonValue({ size_bytes: sizeBytes, text } satisfies Pick<
    BytePayload,
    "size_bytes" | "text"
  >);
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

function timestampMilliseconds(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? undefined : milliseconds;
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
