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
      body: { size_bytes: 0, text: JSON.stringify({ id: "resp-1" }) },
    },
  };
}
