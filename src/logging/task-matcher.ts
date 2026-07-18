import type { RepositoryRecord } from "../persistence/index.js";
import type { TrafficRepository } from "../persistence/index.js";
import {
  bodyJsonValue,
  endpointKind,
  type BytePayload,
  type EndpointKind,
} from "../proxy/index.js";
import { createRequestId, isRecord, localNowIso, safeIdentifierPart } from "../shared/index.js";

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
        sequence: this.#repository.nextRecordSequence(String(task["id"])),
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
    const existing = this.#existingTask(requestId);
    const task = existing?.["pending_request_only"]
      ? this.#promotePending(existing, record, kind)
      : this.#newTask(record, kind);
    return {
      task,
      sequence: this.#repository.nextRecordSequence(String(task["id"])),
      kind,
      requestPayload,
      responsePayload,
      responseIds: [],
      contextKeys: [],
    };
  }

  #existingTask(requestId: string): RepositoryRecord | undefined {
    const taskId = this.#repository.taskIdForRecord(requestId);
    return taskId === undefined ? undefined : this.#repository.getTask(taskId);
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
    return {
      id: this.#createId(),
      kind,
      anchor: taskAnchor(record),
      started_at: record["started_timestamp"] ?? record["timestamp"] ?? now,
      last_seen_at: record["timestamp"] ?? now,
      endpoint: recordRequestPath(record),
      match_strategy_version: 4,
      fingerprints: {},
      boundary_fingerprints: {},
      last_user_messages: [],
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
