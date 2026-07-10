import { randomUUID } from "node:crypto";

import {
  displayEndpoint,
  endpointKind,
  requestBoundaryFingerprints,
  requestFingerprints,
  requestIdentifiers,
  requestUserMessages,
  responseIdsFromBody,
  type EndpointKind,
  type RequestIdentifierContext,
} from "../proxy/records.js";
import type { SanitizedJsonValue } from "../proxy/redaction.js";

export const TASK_MATCH_STRATEGY_VERSION = 4;
export const TASK_MATCH_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const TASK_MATCH_RECENT_LIMIT = 50;

export interface TaskMatchState {
  id: string;
  kind: EndpointKind;
  endpoint: string;
  anchor: string;
  model: string | null;
  target: string | null;
  startedAt: string;
  lastSeenAt: string;
  lastResponseAt: string | null;
  requestCount: number;
  pending: boolean;
  matchConfidence: number;
  matchStrategyVersion: number;
  fingerprints: Readonly<Record<string, string>>;
  boundaryFingerprints: Readonly<Record<string, string>>;
  lastUserMessages: readonly SanitizedJsonValue[];
  createdAt: string;
  updatedAt: string;
}

export interface ExistingRecordAssignment {
  taskId: string;
  sequence: number;
}

export interface TaskMatchRepository {
  assignmentForRecord(recordId: string): ExistingRecordAssignment | null;
  getTaskState(taskId: string): TaskMatchState | null;
  taskIdForResponse(responseId: string): string | null;
  taskIdForContext(contextKey: string): string | null;
  recentTaskStates(
    query: Readonly<{ since: string; kind: EndpointKind; endpoint: string; model: string | null; limit: number }>,
  ): readonly TaskMatchState[];
  recordCount(taskId: string): number;
  nextSequence(taskId: string): number;
}

export interface TaskMatchInput {
  recordId: string;
  event: "request_received" | "request_finished" | "aborted" | "timed_out" | "failed";
  timestamp: string;
  path?: string;
  payload?: unknown;
  responsePayload?: unknown;
  target?: string | null;
  identifierContext?: RequestIdentifierContext;
}

export type TaskMatchReason =
  | "pending_created"
  | "pending_promoted"
  | "same_record"
  | "previous_response"
  | "context_key"
  | "heuristic_continuation"
  | "new_task"
  | "single_request";

export interface TaskAssignment {
  task: TaskMatchState;
  sequence: number;
  reason: TaskMatchReason;
  confidence: number;
  strategyVersion: number;
  responseIds: readonly string[];
  contextKeys: readonly string[];
}

type MatchCandidate = Readonly<{ task: TaskMatchState; reason: TaskMatchReason; confidence: number }>;

export class TaskMatcher {
  readonly #repository: TaskMatchRepository;
  readonly #idFactory: () => string;
  readonly #now: () => string;

  public constructor(
    repository: TaskMatchRepository,
    options: Readonly<{ idFactory?: () => string; now?: () => string }> = {},
  ) {
    this.#repository = repository;
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  public assign(input: TaskMatchInput): TaskAssignment {
    const endpoint = displayEndpoint(input.path);
    const kind = endpointKind(endpoint);
    const existingAssignment = this.#repository.assignmentForRecord(input.recordId);
    const existingTask = existingAssignment ? this.#repository.getTaskState(existingAssignment.taskId) : null;

    if (input.event === "request_received" && input.payload === undefined) {
      const task = existingTask?.pending ? existingTask : this.#newTask(input, kind, endpoint, true);
      return this.#assignment(
        task,
        existingAssignment?.sequence ?? this.#repository.nextSequence(task.id),
        "pending_created",
        1,
        [],
        [],
      );
    }

    const payload = input.payload;
    const identifiers = requestIdentifiers(payload, input.identifierContext ?? {});
    const responseIds = responseIdsFromBody(input.responsePayload);
    let candidate: MatchCandidate | null = null;
    if (existingTask && !existingTask.pending) candidate = { task: existingTask, reason: "same_record", confidence: 1 };
    else if (isModelKind(kind)) candidate = this.#matchExisting(input, kind, endpoint, payload, existingTask?.id);

    let task: TaskMatchState;
    let reason: TaskMatchReason;
    let confidence: number;
    if (candidate) {
      task = candidate.task;
      reason = candidate.reason;
      confidence = candidate.confidence;
    } else if (existingTask?.pending) {
      task = existingTask;
      reason = "pending_promoted";
      confidence = 1;
    } else {
      task = this.#newTask(input, kind, endpoint, false);
      reason = isModelKind(kind) ? "new_task" : "single_request";
      confidence = 1;
    }
    task = this.#updatedTask(task, input, kind, endpoint, payload, responseIds, confidence);
    const sequence =
      existingAssignment?.taskId === task.id ? existingAssignment.sequence : this.#repository.nextSequence(task.id);
    return this.#assignment(task, sequence, reason, confidence, responseIds, identifiers.contextKeys);
  }

  #matchExisting(
    input: TaskMatchInput,
    kind: EndpointKind,
    endpoint: string,
    payload: unknown,
    excludedTaskId?: string,
  ): MatchCandidate | null {
    const identifiers = requestIdentifiers(payload, input.identifierContext ?? {});
    if (kind === "responses" && identifiers.previousResponseId) {
      const task = this.#linkedTask(this.#repository.taskIdForResponse(identifiers.previousResponseId));
      if (task && task.id !== excludedTaskId && boundariesMatch(task, kind, endpoint, payload, false))
        return { task, reason: "previous_response", confidence: 1 };
    }
    for (const contextKey of identifiers.contextKeys) {
      const task = this.#linkedTask(this.#repository.taskIdForContext(contextKey));
      if (task && task.id !== excludedTaskId && boundariesMatch(task, kind, endpoint, payload, false))
        return { task, reason: "context_key", confidence: 1 };
    }

    const timestamp = validTimestamp(input.timestamp, this.#now());
    const model = requestModel(payload);
    const since = new Date(Date.parse(timestamp) - TASK_MATCH_WINDOW_MS).toISOString();
    const currentUsers = requestUserMessages(kind, payload);
    let best: TaskMatchState | null = null;
    let bestAge = Number.POSITIVE_INFINITY;
    for (const task of this.#repository.recentTaskStates({
      since,
      kind,
      endpoint,
      model,
      limit: TASK_MATCH_RECENT_LIMIT,
    })) {
      if (task.id === excludedTaskId || task.pending || !boundariesMatch(task, kind, endpoint, payload, true)) continue;
      if (!sequenceStartsWith(currentUsers, task.lastUserMessages)) continue;
      if (!hasContinuationEvidence(task, kind, payload, currentUsers)) continue;
      const age = Math.abs(Date.parse(timestamp) - Date.parse(task.lastSeenAt));
      if (Number.isFinite(age) && age <= TASK_MATCH_WINDOW_MS && age < bestAge) {
        best = task;
        bestAge = age;
      }
    }
    return best ? { task: best, reason: "heuristic_continuation", confidence: 0.95 } : null;
  }

  #linkedTask(taskId: string | null): TaskMatchState | null {
    return taskId ? this.#repository.getTaskState(taskId) : null;
  }

  #newTask(input: TaskMatchInput, kind: EndpointKind, endpoint: string, pending: boolean): TaskMatchState {
    const now = this.#now();
    const timestamp = validTimestamp(input.timestamp, now);
    const fingerprints = pending ? {} : requestFingerprints(kind, input.payload);
    return {
      id: this.#idFactory(),
      kind,
      endpoint,
      anchor: pending
        ? `pending-${safePart(input.recordId)}`
        : taskAnchor(input.recordId, kind, input.payload, fingerprints),
      model: pending ? null : requestModel(input.payload),
      target: input.target ?? null,
      startedAt: timestamp,
      lastSeenAt: timestamp,
      lastResponseAt: null,
      requestCount: pending ? 1 : 0,
      pending,
      matchConfidence: 1,
      matchStrategyVersion: TASK_MATCH_STRATEGY_VERSION,
      fingerprints,
      boundaryFingerprints: pending ? {} : requestBoundaryFingerprints(kind, input.payload),
      lastUserMessages: pending ? [] : requestUserMessages(kind, input.payload),
      createdAt: now,
      updatedAt: now,
    };
  }

  #updatedTask(
    task: TaskMatchState,
    input: TaskMatchInput,
    kind: EndpointKind,
    endpoint: string,
    payload: unknown,
    responseIds: readonly string[],
    confidence: number,
  ): TaskMatchState {
    const existing = this.#repository.assignmentForRecord(input.recordId);
    const timestamp = validTimestamp(input.timestamp, this.#now());
    const fingerprints = requestFingerprints(kind, payload);
    return {
      ...task,
      kind,
      endpoint,
      anchor: task.pending ? taskAnchor(input.recordId, kind, payload, fingerprints) : task.anchor,
      model: requestModel(payload),
      target: input.target ?? task.target,
      lastSeenAt: timestamp,
      lastResponseAt: responseIds.length > 0 ? timestamp : task.lastResponseAt,
      requestCount: this.#repository.recordCount(task.id) + (existing ? 0 : 1),
      pending: false,
      matchConfidence: confidence,
      matchStrategyVersion: TASK_MATCH_STRATEGY_VERSION,
      fingerprints,
      boundaryFingerprints: requestBoundaryFingerprints(kind, payload),
      lastUserMessages: requestUserMessages(kind, payload),
      updatedAt: this.#now(),
    };
  }

  #assignment(
    task: TaskMatchState,
    sequence: number,
    reason: TaskMatchReason,
    confidence: number,
    responseIds: readonly string[],
    contextKeys: readonly string[],
  ): TaskAssignment {
    return {
      task,
      sequence,
      reason,
      confidence,
      strategyVersion: TASK_MATCH_STRATEGY_VERSION,
      responseIds,
      contextKeys,
    };
  }
}

function boundariesMatch(
  task: TaskMatchState,
  kind: EndpointKind,
  endpoint: string,
  payload: unknown,
  includeUser: boolean,
): boolean {
  if (task.kind !== kind || task.endpoint !== endpoint || task.model !== requestModel(payload)) return false;
  const current = { ...requestBoundaryFingerprints(kind, payload) };
  const previous = { ...task.boundaryFingerprints };
  if (!includeUser) {
    Reflect.deleteProperty(current, "first_user");
    Reflect.deleteProperty(previous, "first_user");
  }
  return JSON.stringify(sortedObject(current)) === JSON.stringify(sortedObject(previous));
}

function hasContinuationEvidence(
  task: TaskMatchState,
  kind: EndpointKind,
  payload: unknown,
  currentUsers: readonly SanitizedJsonValue[],
): boolean {
  if (currentUsers.length > task.lastUserMessages.length) return true;
  const current = requestFingerprints(kind, payload);
  return ["input", "messages"].some(
    (key) =>
      typeof task.fingerprints[key] === "string" &&
      typeof current[key] === "string" &&
      task.fingerprints[key] !== current[key],
  );
}

function sequenceStartsWith(sequence: readonly SanitizedJsonValue[], prefix: readonly SanitizedJsonValue[]): boolean {
  if (prefix.length === 0 || sequence.length < prefix.length) return false;
  return prefix.every((value, index) => JSON.stringify(sequence[index]) === JSON.stringify(value));
}

function taskAnchor(
  recordId: string,
  kind: EndpointKind,
  payload: unknown,
  fingerprints: Readonly<Record<string, string>>,
): string {
  const previous = requestIdentifiers(payload).previousResponseId;
  if (kind === "responses" && previous) return `prev-${safePart(previous)}`;
  const key = Object.keys(fingerprints).sort()[0];
  const fingerprint = key ? fingerprints[key] : undefined;
  return fingerprint ? `fp-${fingerprint}` : `req-${safePart(recordId)}`;
}

function requestModel(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !("model" in payload)) return null;
  return typeof payload.model === "string" && payload.model ? payload.model : null;
}

function isModelKind(kind: EndpointKind): boolean {
  return kind !== "other";
}

function validTimestamp(value: string, fallback: string): string {
  return Number.isFinite(Date.parse(value)) ? value : fallback;
}

function safePart(value: string): string {
  return (
    value
      .replaceAll(/[^A-Za-z0-9]/gu, "-")
      .replaceAll(/^-+|-+$/gu, "")
      .slice(0, 32) || "unknown"
  );
}

function sortedObject(value: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}
