import { TrafficRepository, type RepositoryRecord } from "../persistence/index.js";
import { redactRecord } from "../proxy/index.js";
import { isRecord } from "../shared/index.js";
import { TaskMatcher } from "./task-matcher.js";

export interface TrafficLogServiceOptions {
  readonly redactLogs?: boolean;
}

export class TrafficLogService {
  readonly #repository: TrafficRepository | undefined;
  readonly #taskMatcher: TaskMatcher | undefined;
  readonly #redactLogs: boolean;

  constructor(logRoot: string | null | undefined, options: TrafficLogServiceOptions = {}) {
    this.#redactLogs = options.redactLogs ?? false;
    this.#repository =
      logRoot === null || logRoot === undefined ? undefined : new TrafficRepository(logRoot);
    this.#taskMatcher =
      this.#repository === undefined ? undefined : new TaskMatcher(this.#repository);
  }

  write(record: Readonly<RepositoryRecord>): void {
    this.#save(record);
  }

  update(record: Readonly<RepositoryRecord>): void {
    this.#save(record);
  }

  close(): void {
    this.#repository?.close();
  }

  #save(record: Readonly<RepositoryRecord>): void {
    if (this.#repository === undefined || this.#taskMatcher === undefined) {
      return;
    }
    const recordToWrite = this.#redactLogs ? redactRecord(record) : record;
    const assignment = this.#taskMatcher.assign(recordToWrite);
    if (assignment === undefined) {
      return;
    }
    const taskId = assignment.task["id"];
    if (typeof taskId !== "string") {
      throw new Error("Task assignment is missing a string task ID.");
    }
    const request = mapping(recordToWrite["request"]);
    const response = mapping(recordToWrite["response"]);
    this.#repository.upsertTask(assignment.task);
    this.#repository.upsertRecord({
      id: stringValue(recordToWrite["id"]),
      task_id: taskId,
      sequence: assignment.sequence,
      event: stringValue(recordToWrite["event"]) || "request_finished",
      timestamp: stringValue(recordToWrite["timestamp"]),
      started_at:
        stringValue(recordToWrite["started_timestamp"]) || stringValue(recordToWrite["timestamp"]),
      duration_ms: recordToWrite["duration_ms"],
      method: stringValue(request["method"]),
      path: stringValue(request["path"]),
      status: response["status"],
      error: recordToWrite["error"],
      request_headers: mapping(request["headers"]),
      response_headers: mapping(response["headers"]),
      request_body: assignment.requestPayload,
      response_body: assignment.responsePayload,
    });
    for (const responseId of assignment.responseIds) {
      this.#repository.upsertResponseLink(responseId, taskId);
    }
    for (const contextKey of assignment.contextKeys) {
      this.#repository.upsertContextLink(contextKey, taskId);
    }
  }
}

function mapping(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
