import type { RepositoryRecord, TaskRow, TrafficRepository } from "../persistence/index.js";
import {
  endpointKind,
  requestBoundaryFingerprints,
  requestFingerprints,
  requestUserMessages,
  responseIdsFromBody,
  type EndpointKind,
} from "../proxy/protocol/analysis.js";
import {
  addContextKey,
  boundaryWithoutUser,
  hasContinuationEvidence,
  mergeLegacyContextKeys,
  nestedValue,
  requestContextKeys,
  storedBoundaryFingerprints,
  userMessagesPrefixMatches,
} from "../proxy/protocol/task-identity.js";
import { bodyJsonValue } from "../proxy/protocol/payload.js";
import type { ResponseLogPayload } from "../proxy/response-log-capture.js";
import type { TrafficRecordEvent } from "../proxy/traffic-event.js";
import {
  createRequestId,
  isRecord,
  localNowIso,
  safeIdentifierPart,
  stableJsonStringify,
} from "../shared/index.js";
import type { TrafficTaskWrite } from "./traffic-record-write.js";

/**
 * The group the matcher continues: either a row it read out of the log or a row it has
 * just built. `#updatedTask` adds what a finished request observed, whichever it got.
 */
type MatchedTask = Readonly<TaskRow> | Readonly<TrafficTaskWrite>;

export interface TaskAssignment {
  readonly task: Readonly<TrafficTaskWrite>;
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

  assign(record: Readonly<TrafficRecordEvent>): TaskAssignment | undefined {
    const request = record.request;
    const requestId = record.id;
    if (requestId === "") {
      return undefined;
    }
    const kind = endpointKind(request.path);
    if (request.body_pending) {
      const task = this.#pendingTask(record, requestId, kind);
      return {
        task,
        sequence: this.#sequenceForRecord(requestId, task.id),
        kind,
        requestPayload: {},
        responsePayload: null,
        responseIds: [],
        contextKeys: [],
        supersededTaskIds: [],
      };
    }

    const requestPayload = bodyPayload(request.body);
    const responsePayload =
      record.response === undefined ? null : bodyPayload(record.response.body);
    const contextKeys = isRecord(requestPayload) ? this.#contextKeys(requestPayload, record) : [];
    const requestTask = this.#existingTask(requestId);
    const continuationTask =
      requestTask === undefined || requestTask.pending_request_only
        ? this.#continuationTask(record, kind, requestPayload, contextKeys)
        : undefined;
    const existing =
      requestTask?.pending_request_only === true
        ? (continuationTask ?? requestTask)
        : (requestTask ?? continuationTask);
    const supersededTaskIds =
      requestTask?.pending_request_only === true && continuationTask !== undefined
        ? [requestTask.id]
        : [];
    const matchedTask =
      existing === undefined
        ? this.#newTask(record, kind)
        : existing.pending_request_only
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
      sequence: this.#sequenceForRecord(requestId, task.id),
      kind,
      requestPayload,
      responsePayload,
      responseIds: responseIdsFromBody(responsePayload),
      contextKeys,
      supersededTaskIds,
    };
  }

  #continuationTask(
    record: Readonly<TrafficRecordEvent>,
    kind: EndpointKind,
    payload: unknown,
    contextKeys: readonly string[],
  ): TaskRow | undefined {
    return (
      this.#taskForPreviousResponse(record, kind, payload) ??
      this.#taskForContextKeys(contextKeys, record, kind, payload) ??
      (MODEL_TASK_KINDS.has(kind) ? this.#bestHeuristicTask(record, kind, payload) : undefined)
    );
  }

  #existingTask(requestId: string): TaskRow | undefined {
    const taskId = this.#repository.taskIdForRecord(requestId);
    return taskId === undefined ? undefined : this.#repository.getTask(taskId);
  }

  #taskForPreviousResponse(
    record: Readonly<TrafficRecordEvent>,
    kind: EndpointKind,
    payload: unknown,
  ): TaskRow | undefined {
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
    record: Readonly<TrafficRecordEvent>,
    kind: EndpointKind,
    payload: unknown,
  ): TaskRow | undefined {
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
    task: Readonly<TaskRow>,
    record: Readonly<TrafficRecordEvent>,
    kind: EndpointKind,
    payload: unknown,
    includeUserBoundary: boolean,
  ): boolean {
    if (task.kind !== kind) {
      return false;
    }
    const endpoint = task.endpoint;
    if (typeof endpoint === "string" && endpoint !== "" && endpoint !== record.request.path) {
      return false;
    }
    const requestedModel = isRecord(payload) ? (payload["model"] ?? null) : null;
    if ((task.model ?? null) !== requestedModel) {
      return false;
    }
    const storedBoundary = storedBoundaryFingerprints(task.boundary_fingerprints);
    const requestBoundary = requestBoundaryFingerprints(kind, payload);
    const boundariesEqual = (
      left: Readonly<Record<string, string>>,
      right: Readonly<Record<string, string>>,
    ): boolean => stableJsonStringify(left) === stableJsonStringify(right);
    return includeUserBoundary
      ? boundariesEqual(storedBoundary, requestBoundary)
      : boundariesEqual(boundaryWithoutUser(storedBoundary), boundaryWithoutUser(requestBoundary));
  }

  #bestHeuristicTask(
    record: Readonly<TrafficRecordEvent>,
    kind: EndpointKind,
    payload: unknown,
  ): TaskRow | undefined {
    const recordTime = timestampMilliseconds(record.timestamp) ?? this.#nowMilliseconds();
    let bestTask: TaskRow | undefined;
    let bestAge = Number.POSITIVE_INFINITY;
    for (const task of this.#repository.recentTasks()) {
      if (!this.#staticBoundariesMatch(task, record, kind, payload, true)) {
        continue;
      }
      const taskTime = timestampMilliseconds(task.last_seen_at);
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
    record: Readonly<TrafficRecordEvent>,
  ): string[] {
    return mergeLegacyContextKeys(
      requestContextKeys(payload, record.request.headers),
      legacyRecordContextKeys(record),
    );
  }

  #sequenceForRecord(requestId: string, taskId: string): number {
    const existing = this.#repository.getRecord(requestId);
    if (existing?.task_id === taskId) {
      const sequence = existing.sequence;
      return Number.isInteger(sequence) ? sequence : 1;
    }
    return this.#repository.nextRecordSequence(taskId);
  }

  #pendingTask(
    record: Readonly<TrafficRecordEvent>,
    requestId: string,
    kind: EndpointKind,
  ): TrafficTaskWrite {
    const existing = this.#existingTask(requestId);
    if (existing?.pending_request_only === true) {
      return { ...existing, id: existing.id };
    }
    return {
      ...this.#newTask(record, kind),
      anchor: `pending-${safeIdentifierPart(requestId, "unknown", 32)}`,
      pending_request_only: true,
      request_count: 1,
    };
  }

  #promotePending(
    task: Readonly<TaskRow>,
    record: Readonly<TrafficRecordEvent>,
    kind: EndpointKind,
  ): TrafficTaskWrite {
    return {
      ...task,
      id: task.id,
      pending_request_only: false,
      kind,
      endpoint: record.request.path,
      anchor: taskAnchor(record),
      match_confidence: 1,
    };
  }

  #newTask(record: Readonly<TrafficRecordEvent>, kind: EndpointKind): TrafficTaskWrite {
    const now = this.#now();
    const payload = bodyPayload(record.request.body);
    const model = isRecord(payload) ? payload["model"] : undefined;
    return {
      id: this.#createId(),
      kind,
      anchor: taskAnchor(record),
      started_at: record.started_timestamp || record.timestamp || now,
      last_seen_at: latestTimestamp(now, record.timestamp),
      endpoint: record.request.path,
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
    task: MatchedTask,
    record: Readonly<TrafficRecordEvent>,
    requestId: string,
    kind: EndpointKind,
    payload: unknown,
    responsePayload: unknown,
  ): TrafficTaskWrite {
    const taskId = task.id;
    const now = this.#now();
    const observedAt = latestTimestamp(now, task.last_seen_at, record.timestamp);
    const status = record.response?.status;
    const model = isRecord(payload) ? payload["model"] : undefined;
    const existingRecord = this.#repository.getRecord(requestId);
    const responseIds = responseIdsFromBody(responsePayload);
    const hasResponse = (status !== null && status !== undefined) || responseIds.length > 0;
    return {
      ...task,
      id: taskId,
      pending_request_only: false,
      kind,
      endpoint: record.request.path,
      last_seen_at: observedAt,
      ...(hasResponse
        ? { last_response_at: latestTimestamp(now, task.last_response_at, record.timestamp) }
        : {}),
      ...(typeof model === "string" && model !== "" ? { model } : {}),
      fingerprints: requestFingerprints(kind, payload),
      boundary_fingerprints: requestBoundaryFingerprints(kind, payload),
      last_user_messages: requestUserMessages(kind, payload),
      request_count:
        this.#repository.recordCount(taskId) + (existingRecord?.task_id === taskId ? 0 : 1),
      updated_at: now,
    };
  }
}

function bodyPayload(body: ResponseLogPayload): unknown {
  return bodyJsonValue(body);
}

/**
 * Keys that exist only in stored records. The live request path never produces
 * them, so the router must not treat them as available evidence; they remain here
 * as a history and import fallback.
 */
function legacyRecordContextKeys(record: Readonly<RepositoryRecord>): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  addContextKey(keys, seen, "prompt_cache", record["prompt_cache_key"]);
  addContextKey(keys, seen, "client_thread", nestedValue(record, "client_metadata", "thread_id"));
  addContextKey(keys, seen, "client_session", nestedValue(record, "client_metadata", "session_id"));
  return keys;
}

function taskAnchor(record: Readonly<TrafficRecordEvent>): string {
  return `req-${record.id.slice(0, 12)}`;
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
  task: Readonly<TaskRow>,
  currentUserMessages: readonly unknown[],
): boolean {
  const previousUserMessages = task.last_user_messages;
  return (
    Array.isArray(previousUserMessages) &&
    userMessagesPrefixMatches(previousUserMessages, currentUserMessages)
  );
}

function taskHasContinuationEvidence(
  task: Readonly<TaskRow>,
  kind: EndpointKind,
  payload: unknown,
): boolean {
  const previousUserMessages = task.last_user_messages;
  const storedFingerprints = task.fingerprints;
  return hasContinuationEvidence(
    kind,
    payload,
    Array.isArray(previousUserMessages) ? previousUserMessages : undefined,
    isRecord(storedFingerprints) ? storedFingerprints : undefined,
  );
}
