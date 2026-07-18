import { TrafficRepository, type RepositoryRecord } from "../persistence/index.js";
import {
  bodyJsonValue,
  displayEndpoint,
  endpointKind,
  redactRecord,
  requestMessageCount,
  responseTokenCount,
} from "../proxy/index.js";
import { isRecord, stableJsonStringify, StructuredLogger } from "../shared/index.js";
import { TaskMatcher } from "./task-matcher.js";
import { type SerialWriteQueue, writeQueueForLogRoot } from "./write-queue.js";

export interface TrafficLogServiceOptions {
  readonly redactLogs?: boolean;
  readonly logger?: Pick<StructuredLogger, "warn">;
}

export class TrafficLogService {
  readonly #repository: TrafficRepository | undefined;
  readonly #taskMatcher: TaskMatcher | undefined;
  readonly #redactLogs: boolean;
  readonly #writeQueue: SerialWriteQueue | undefined;
  readonly #logger: Pick<StructuredLogger, "warn">;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(logRoot: string | null | undefined, options: TrafficLogServiceOptions = {}) {
    this.#redactLogs = options.redactLogs ?? false;
    this.#logger = options.logger ?? new StructuredLogger({ service: "llm-proxy-traffic-log" });
    this.#repository =
      logRoot === null || logRoot === undefined ? undefined : new TrafficRepository(logRoot);
    this.#taskMatcher =
      this.#repository === undefined ? undefined : new TaskMatcher(this.#repository);
    this.#writeQueue =
      logRoot === null || logRoot === undefined ? undefined : writeQueueForLogRoot(logRoot);
  }

  async write(record: Readonly<RepositoryRecord>): Promise<void> {
    await this.#enqueue(record);
  }

  async update(record: Readonly<RepositoryRecord>): Promise<void> {
    await this.#enqueue(record);
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    this.#closed = true;
    this.#closePromise = (async () => {
      await this.#writeQueue?.drain();
      this.#repository?.close();
    })();
    return this.#closePromise;
  }

  async #enqueue(record: Readonly<RepositoryRecord>): Promise<void> {
    if (this.#writeQueue === undefined || this.#closed) {
      return;
    }
    try {
      await this.#writeQueue.enqueue(() => this.#save(record));
    } catch (error) {
      this.#logger.warn("Traffic log write failed", {
        error_type: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  #save(record: Readonly<RepositoryRecord>): void {
    const repository = this.#repository;
    const taskMatcher = this.#taskMatcher;
    if (repository === undefined || taskMatcher === undefined) {
      return;
    }
    const recordToWrite = this.#redactLogs ? redactRecord(record) : record;
    const assignment = taskMatcher.assign(recordToWrite);
    if (assignment === undefined) {
      return;
    }
    const taskId = assignment.task["id"];
    if (typeof taskId !== "string") {
      throw new Error("Task assignment is missing a string task ID.");
    }
    const request = mapping(recordToWrite["request"]);
    const response = mapping(recordToWrite["response"]);
    const target = mapping(recordToWrite["target"]);
    const client = mapping(recordToWrite["client"]);
    const proxy = mapping(recordToWrite["proxy"]);
    const endpoint = displayEndpoint(stringValue(request["path"]));
    const kind = endpointKind(endpoint);
    const originalRequestBody = bodyValue(request["body"]);
    const hasUpstreamBody = isRecord(request["upstream_body"]);
    const requestBody = hasUpstreamBody ? bodyValue(request["upstream_body"]) : originalRequestBody;
    const distinctOriginalBody =
      hasUpstreamBody &&
      stableJsonStringify(originalRequestBody) !== stableJsonStringify(requestBody)
        ? originalRequestBody
        : undefined;
    repository.transaction(() => {
      repository.upsertTask(assignment.task);
      repository.upsertRecord({
        id: stringValue(recordToWrite["id"]),
        task_id: taskId,
        sequence: assignment.sequence,
        event: stringValue(recordToWrite["event"]) || "request_finished",
        timestamp: stringValue(recordToWrite["timestamp"]),
        started_at:
          stringValue(recordToWrite["started_timestamp"]) ||
          stringValue(recordToWrite["timestamp"]),
        duration_ms: recordToWrite["duration_ms"],
        proxy_id: proxy["id"],
        proxy_name: proxy["name"],
        client_host: client["host"],
        client_port: client["port"],
        target_id: target["id"],
        target_name: target["name"],
        target_url: targetUrl(target),
        method: stringValue(request["method"]),
        path: stringValue(request["path"]),
        endpoint,
        status: response["status"],
        error: recordToWrite["error"],
        message_count: requestMessageCount(kind, requestBody),
        token_count: responseTokenCount(assignment.responsePayload),
        request_headers: mapping(request["headers"]),
        response_headers: mapping(response["headers"]),
        request_body: requestBody,
        original_request_body: distinctOriginalBody,
        response_body: assignment.responsePayload,
        model_route: request["model_route"],
        stripped_fields: listValue(request["stripped_fields"]),
        injected_fields: listValue(request["injected_fields"]),
        added_upstream_headers: listValue(request["added_upstream_headers"]),
      });
      for (const responseId of assignment.responseIds) {
        repository.upsertResponseLink(responseId, taskId);
      }
      for (const contextKey of assignment.contextKeys) {
        repository.upsertContextLink(contextKey, taskId);
      }
    });
  }
}

function mapping(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function listValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? [...(value as unknown[])] : [];
}

function targetUrl(target: Readonly<Record<string, unknown>>): string {
  const scheme = stringValue(target["scheme"]);
  const host = stringValue(target["host"]);
  const port = stringValue(target["port"]);
  if (scheme === "" || host === "" || port === "") {
    return "";
  }
  return `${scheme}://${host}:${port}${stringValue(target["path"])}`;
}

function bodyValue(value: unknown): unknown {
  if (!isRecord(value)) {
    return null;
  }
  const sizeBytes = value["size_bytes"];
  const text = value["text"];
  return typeof sizeBytes === "number" && typeof text === "string"
    ? bodyJsonValue({ size_bytes: sizeBytes, text })
    : null;
}
