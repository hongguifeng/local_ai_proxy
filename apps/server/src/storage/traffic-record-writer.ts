import type { RecordDetail } from "@llm-proxy/contracts";

import { TaskMatcher, type TaskAssignment } from "../tasks/task-matcher.js";
import type { RecordSearchText, StorageRepository } from "./repository.js";

export class TrafficRecordWriter {
  readonly #repository: StorageRepository;
  readonly #matcher: TaskMatcher;

  public constructor(repository: StorageRepository, matcher = new TaskMatcher(repository)) {
    this.#repository = repository;
    this.#matcher = matcher;
  }

  public write(record: RecordDetail): TaskAssignment {
    return this.#repository.transaction(() => {
      const assignment = this.#matcher.assign({
        recordId: record.id,
        event: record.event,
        timestamp: record.timestamp,
        path: record.path,
        ...(payloadValue(record.request.body) !== undefined ? { payload: payloadValue(record.request.body) } : {}),
        responsePayload: record.response ? payloadValue(record.response.body) : null,
        target: record.target.url,
      });
      const assignedRecord = { ...record, taskId: assignment.task.id, sequence: assignment.sequence };
      this.#repository.applyTrafficAssignment(
        assignment.task,
        assignedRecord,
        searchText(assignedRecord),
        assignment.responseIds,
        assignment.contextKeys,
      );
      return assignment;
    });
  }
}

function payloadValue(body: RecordDetail["request"]["body"]): unknown {
  return body.kind === "json" ? body.value : undefined;
}

function searchText(record: RecordDetail): RecordSearchText {
  return {
    task: boundedText([record.target.name, record.target.url, record.path].join(" ")),
    request: boundedText(JSON.stringify(record.request.body)),
    response: boundedText(record.response ? JSON.stringify(record.response.body) : ""),
    error: boundedText([record.errorCode, record.errorStage, record.errorMessage].filter(Boolean).join(" ")),
  };
}

function boundedText(value: string): string {
  return value.slice(0, 64 * 1024);
}
