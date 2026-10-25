import { TrafficRepository } from "../persistence/index.js";
import {
  bodyJsonValue,
  displayEndpoint,
  endpointKind,
  redactEvent,
  requestMessageCount,
  responseTokenCount,
  responseTokenCounts,
  type TrafficRecordEvent,
  type TrafficTargetInfo,
} from "../proxy/index.js";
import { stableJsonStringify, StructuredLogger } from "../shared/index.js";
import { TaskMatcher } from "./task-matcher.js";
import type { TrafficRecordWrite } from "./traffic-record-write.js";
import { type SerialWriteQueue, writeQueueForLogRoot } from "./write-queue.js";

export interface TrafficLogServiceOptions {
  readonly redactLogs?: boolean;
  readonly logger?: Pick<StructuredLogger, "warn">;
}

export class TrafficLogService {
  readonly #repository: TrafficRepository | undefined;
  readonly #taskMatcher: TaskMatcher | undefined;
  readonly #redactLogs: boolean;
  readonly #logRoot: string | undefined;
  readonly #writeQueue: SerialWriteQueue | undefined;
  readonly #logger: Pick<StructuredLogger, "warn">;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(logRoot: string | null | undefined, options: TrafficLogServiceOptions = {}) {
    this.#redactLogs = options.redactLogs ?? false;
    this.#logRoot = logRoot ?? undefined;
    this.#logger = options.logger ?? new StructuredLogger({ service: "llm-proxy-traffic-log" });
    this.#repository =
      logRoot === null || logRoot === undefined ? undefined : new TrafficRepository(logRoot);
    // A newly constructed service has no inherited in-flight proxy requests.  Pending
    // rows therefore came from a prior process and must not remain "calculating" forever.
    this.#repository?.markPendingPricingInterrupted();
    this.#taskMatcher =
      this.#repository === undefined ? undefined : new TaskMatcher(this.#repository);
    this.#writeQueue =
      logRoot === null || logRoot === undefined ? undefined : writeQueueForLogRoot(logRoot);
  }

  async write(record: Readonly<TrafficRecordEvent>): Promise<void> {
    await this.#enqueue(record);
  }

  async update(record: Readonly<TrafficRecordEvent>): Promise<void> {
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

  async #enqueue(record: Readonly<TrafficRecordEvent>): Promise<void> {
    if (this.#writeQueue === undefined || this.#closed) {
      return;
    }
    try {
      await this.#writeQueue.enqueue(() => this.#save(record));
    } catch (error) {
      // The record and the root say which write failed and where; the error names stay
      // next to the cause so the failing layer is identifiable without the body itself.
      this.#logger.warn("Traffic log write failed", {
        phase: "traffic_log_write",
        event: record.event,
        record_id: record.id,
        task_id: record["task_id"],
        log_root: this.#logRoot,
        error_type: errorName(error),
        cause_type: errorName(error instanceof Error ? error.cause : undefined),
      });
    }
  }

  #save(record: Readonly<TrafficRecordEvent>): void {
    const repository = this.#repository;
    const taskMatcher = this.#taskMatcher;
    if (repository === undefined || taskMatcher === undefined) {
      return;
    }
    const recordToWrite = this.#redactLogs ? redactEvent(record) : record;
    const assignment = taskMatcher.assign(recordToWrite);
    if (assignment === undefined) {
      return;
    }
    const taskId = assignment.task.id;
    const request = recordToWrite.request;
    const target = recordToWrite.target;
    const resolvedTargetUrl = targetUrl(target);
    const endpoint = displayEndpoint(request.path);
    const kind = endpointKind(endpoint);
    const originalRequestBody = bodyJsonValue(request.body);
    const requestBody =
      request.upstream_body === undefined
        ? originalRequestBody
        : bodyJsonValue(request.upstream_body);
    const tokenCounts = responseTokenCounts(assignment.responsePayload, kind);
    const distinctOriginalBody =
      request.upstream_body !== undefined &&
      stableJsonStringify(originalRequestBody) !== stableJsonStringify(requestBody)
        ? originalRequestBody
        : undefined;
    repository.transaction(() => {
      repository.upsertTask({
        ...assignment.task,
        ...(resolvedTargetUrl === "" ? {} : { target: resolvedTargetUrl }),
      });
      const recordWrite: TrafficRecordWrite = {
        id: recordToWrite.id,
        task_id: taskId,
        sequence: assignment.sequence,
        event: recordToWrite.event,
        timestamp: recordToWrite.timestamp,
        started_at: recordToWrite.started_timestamp || recordToWrite.timestamp,
        duration_ms: recordToWrite.duration_ms,
        first_token_ms: recordToWrite.first_token_ms,
        decode_window_ms: recordToWrite.decode_window_ms,
        proxy_id: recordToWrite.proxy?.id,
        proxy_name: recordToWrite.proxy?.name,
        client_host: recordToWrite.client.host,
        client_port: recordToWrite.client.port,
        target_id: target.id,
        target_name: target.name,
        target_url: resolvedTargetUrl,
        method: request.method,
        path: request.path,
        endpoint,
        status: recordToWrite.response?.status,
        error: recordToWrite.error,
        message_count: requestMessageCount(kind, requestBody),
        token_count: responseTokenCount(assignment.responsePayload),
        request_token_count: tokenCounts.request,
        response_token_count: tokenCounts.response,
        pricing: recordToWrite.pricing,
        request_headers: request.headers,
        response_headers: recordToWrite.response?.headers ?? {},
        request_body: requestBody,
        original_request_body: distinctOriginalBody,
        response_body: assignment.responsePayload,
        model_route: request.model_route,
        stripped_fields: request.stripped_fields ?? [],
        injected_fields: request.injected_fields ?? [],
        added_upstream_headers: request.added_upstream_headers ?? [],
      };
      repository.upsertRecord(recordWrite);
      for (const responseId of assignment.responseIds) {
        repository.upsertResponseLink(responseId, taskId);
      }
      for (const contextKey of assignment.contextKeys) {
        repository.upsertContextLink(contextKey, taskId);
      }
      repository.deleteTasks(assignment.supersededTaskIds);
    });
  }
}

/** The upstream address as one string, or empty when the target block is incomplete. */
function targetUrl(target: Readonly<TrafficTargetInfo>): string {
  const port = String(target.port);
  if (target.scheme === "" || target.host === "" || port === "") {
    return "";
  }
  return `${target.scheme}://${target.host}:${port}${target.path}`;
}

/** The name of an error, or `UnknownError` when it is not an `Error`. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
