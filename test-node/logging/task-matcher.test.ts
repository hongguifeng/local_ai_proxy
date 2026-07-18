import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TaskMatcher, type TaskAssignment } from "../../src/logging/index.js";
import { TrafficRepository } from "../../src/persistence/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("TaskAssignment", () => {
  it("carries the complete result needed to persist a matched request", () => {
    const assignment = {
      task: { id: "task-1", kind: "responses" },
      sequence: 2,
      kind: "responses",
      requestPayload: { input: "hello" },
      responsePayload: { id: "resp-1" },
      responseIds: ["resp-1"],
      contextKeys: ["conversation:conv-1"],
    } satisfies TaskAssignment;

    expect(assignment).toMatchObject({
      task: { id: "task-1" },
      sequence: 2,
      responseIds: ["resp-1"],
      contextKeys: ["conversation:conv-1"],
    });
  });

  it("creates a pending task and promotes it when the request body arrives", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-task-matcher-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    const matcher = new TaskMatcher(repository, {
      createId: () => "task-pending",
      now: () => "2026-07-18T10:00:00.000+08:00",
    });
    const pendingRecord = trafficRecord("request-1", true, {});
    const pending = matcher.assign(pendingRecord);
    if (pending === undefined) {
      throw new Error("Pending record was not assigned.");
    }
    expect(pending).toMatchObject({
      task: {
        id: "task-pending",
        anchor: "pending-request-1",
        pending_request_only: true,
        request_count: 1,
      },
      sequence: 1,
      requestPayload: {},
      responsePayload: null,
    });
    repository.upsertTask(pending.task);
    repository.upsertRecord({
      id: "request-1",
      task_id: "task-pending",
      sequence: pending.sequence,
      method: "POST",
      path: "/v1/responses",
    });

    const finished = matcher.assign(trafficRecord("request-1", false, { model: "gpt-5" }));
    expect(finished?.task).toMatchObject({
      id: "task-pending",
      kind: "responses",
      endpoint: "/v1/responses",
      pending_request_only: false,
      match_confidence: 1,
    });
    expect(finished?.sequence).toBe(1);
    if (finished === undefined) {
      throw new Error("Finished record was not assigned.");
    }
    repository.upsertTask(finished.task);
    repository.upsertRecord({
      id: "request-1",
      task_id: "task-pending",
      sequence: finished.sequence,
      method: "POST",
      path: "/v1/responses",
    });

    const repeated = matcher.assign(trafficRecord("request-1", false, { model: "gpt-5" }));
    expect(repeated).toMatchObject({ task: { id: "task-pending" }, sequence: 1 });
    repository.close();
  });

  it("uses a Responses previous_response_id link for follow-up requests", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-task-response-link-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    let taskNumber = 0;
    const matcher = new TaskMatcher(repository, {
      createId: () => `task-${++taskNumber}`,
      now: () => "2026-07-18T10:00:00.000+08:00",
    });
    const first = matcher.assign(
      trafficRecord("request-1", false, { model: "gpt-5", input: "start" }),
    );
    if (first === undefined) {
      throw new Error("Initial Responses request was not assigned.");
    }
    expect(first.responseIds).toEqual(["resp-request-1"]);
    persistAssignment(repository, first, "request-1");

    const followup = matcher.assign(
      trafficRecord("request-2", false, {
        model: "gpt-5",
        previous_response_id: "resp-request-1",
        input: "continue",
      }),
    );
    expect(followup).toMatchObject({ task: { id: "task-1" }, sequence: 2 });
    expect(followup?.responseIds).toEqual(["resp-request-2"]);
    repository.close();
  });

  it("generates and matches conversation, thread, session, and prompt-cache context keys", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-task-context-link-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    let taskNumber = 0;
    const matcher = new TaskMatcher(repository, {
      createId: () => `context-task-${++taskNumber}`,
      now: () => "2026-07-18T10:00:00.000+08:00",
    });
    const firstRecord = {
      ...trafficRecord("context-request-1", false, {
        model: "gpt-5",
        conversation: { id: "conversation-1" },
        prompt_cache_key: "payload-cache",
        input: "start",
      }),
      prompt_cache_key: "record-cache",
      client_metadata: { thread_id: "thread-1", session_id: "session-1" },
    };
    const first = matcher.assign(firstRecord);
    if (first === undefined) {
      throw new Error("Context-linked request was not assigned.");
    }
    expect(first.contextKeys).toEqual([
      "conversation:conversation-1",
      "prompt_cache:payload-cache",
      "prompt_cache:record-cache",
      "client_thread:thread-1",
      "client_session:session-1",
    ]);
    persistAssignment(repository, first, "context-request-1");

    const followup = matcher.assign(
      trafficRecord("context-request-2", false, {
        model: "gpt-5",
        conversation_id: "conversation-1",
        input: "continue",
      }),
    );
    expect(followup).toMatchObject({ task: { id: "context-task-1" }, sequence: 2 });
    repository.close();
  });
});

function trafficRecord(id: string, bodyPending: boolean, payload: unknown) {
  return {
    id,
    timestamp: "2026-07-18T10:00:01.000+08:00",
    request: {
      method: "POST",
      path: "/v1/responses",
      body_pending: bodyPending,
      body: { size_bytes: 0, text: JSON.stringify(payload) },
    },
    response: {
      status: 200,
      body: { size_bytes: 0, text: JSON.stringify({ id: `resp-${id}` }) },
    },
  };
}

function persistAssignment(
  repository: TrafficRepository,
  assignment: TaskAssignment,
  requestId: string,
): void {
  const taskId = assignment.task["id"];
  if (typeof taskId !== "string") {
    throw new Error("Task assignment is missing a string task ID.");
  }
  repository.upsertTask(assignment.task);
  repository.upsertRecord({
    id: requestId,
    task_id: taskId,
    sequence: assignment.sequence,
    method: "POST",
    path: "/v1/responses",
    request_body: assignment.requestPayload,
    response_body: assignment.responsePayload,
  });
  for (const responseId of assignment.responseIds) {
    repository.upsertResponseLink(responseId, taskId);
  }
  for (const contextKey of assignment.contextKeys) {
    repository.upsertContextLink(contextKey, taskId);
  }
}
