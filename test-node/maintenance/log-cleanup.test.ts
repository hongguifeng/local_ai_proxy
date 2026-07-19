import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  cleanupLogsKeepLatest,
  cleanupLogsOlderThan,
  cleanupSelectedLogGroups,
} from "../../src/maintenance/index.js";
import { TrafficRepository } from "../../src/persistence/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (root) => rm(root, { recursive: true })),
  );
});

describe("selected log group cleanup", () => {
  it("deletes selected tasks across roots and ignores blank or missing IDs", async () => {
    const firstRoot = await rootWithTasks("selected", "kept");
    const secondRoot = await rootWithTasks("other");

    expect(cleanupSelectedLogGroups([firstRoot, secondRoot], ["", "selected", "missing"])).toEqual({
      deleted: ["selected"],
      deleted_count: 1,
    });

    const repository = new TrafficRepository(firstRoot);
    expect(repository.getTask("selected")).toBeUndefined();
    expect(repository.getRecord("record-selected")).toBeUndefined();
    expect(repository.getTask("kept")).toBeDefined();
    repository.close();
  });
});

describe("older-than log cleanup", () => {
  it("deletes tasks whose latest activity is older than the cutoff", async () => {
    const root = await rootWithTimestampedTasks([
      ["old", "2026-07-01T00:00:00Z"],
      ["boundary", "2026-07-13T00:00:00Z"],
      ["new", "2026-07-17T00:00:00Z"],
      ["invalid", "not-a-time"],
    ]);

    expect(cleanupLogsOlderThan([root], 5, () => Date.parse("2026-07-18T00:00:00Z"))).toEqual({
      deleted: ["old"],
      deleted_count: 1,
    });
    const repository = new TrafficRepository(root);
    expect(repository.getTask("old")).toBeUndefined();
    expect(repository.getTask("boundary")).toBeDefined();
    expect(repository.getTask("new")).toBeDefined();
    expect(repository.getTask("invalid")).toBeDefined();
    repository.close();
  });
});

describe("keep-latest log cleanup", () => {
  it("keeps the requested number of newest tasks independently in each root", async () => {
    const firstRoot = await rootWithTimestampedTasks([
      ["first-old", "2026-07-16T00:00:00Z"],
      ["first-new", "2026-07-18T00:00:00Z"],
    ]);
    const secondRoot = await rootWithTimestampedTasks([
      ["second-old", "2026-07-15T00:00:00Z"],
      ["second-middle", "2026-07-17T00:00:00Z"],
      ["second-new", "2026-07-18T00:00:00Z"],
    ]);

    expect(cleanupLogsKeepLatest([firstRoot, secondRoot], 1)).toEqual({
      deleted: ["first-old", "second-middle", "second-old"],
      deleted_count: 3,
    });
    const first = new TrafficRepository(firstRoot);
    expect(first.listTasks().items.map((task) => task["id"])).toEqual(["first-new"]);
    first.close();
    const second = new TrafficRepository(secondRoot);
    expect(second.listTasks().items.map((task) => task["id"])).toEqual(["second-new"]);
    second.close();
  });
});

describe("cleanup relational consistency", () => {
  it("removes search documents and response/context links with the task", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-cleanup-links-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    repository.upsertTask({ id: "linked-task", kind: "responses", model: "searchable-model" });
    repository.upsertRecord({
      id: "linked-record",
      task_id: "linked-task",
      method: "POST",
      path: "/v1/responses",
      request_body: { input: "searchable-body" },
    });
    repository.upsertResponseLink("response-linked", "linked-task");
    repository.upsertContextLink("conversation:linked", "linked-task");
    expect(repository.listTasks("searchable-body").total).toBe(1);
    repository.close();

    cleanupSelectedLogGroups([root], ["linked-task"]);

    const inspected = new TrafficRepository(root);
    expect(inspected.listTasks("searchable-body").total).toBe(0);
    expect(inspected.taskIdForResponse("response-linked")).toBeUndefined();
    expect(inspected.taskIdForContext("conversation:linked")).toBeUndefined();
    expect(inspected.getRecord("linked-record")).toBeUndefined();
    inspected.close();
  });
});

async function rootWithTasks(...taskIds: string[]): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-cleanup-"));
  temporaryDirectories.push(root);
  const repository = new TrafficRepository(root);
  for (const taskId of taskIds) {
    repository.upsertTask({ id: taskId, kind: "responses" });
    repository.upsertRecord({
      id: `record-${taskId}`,
      task_id: taskId,
      method: "POST",
      path: "/v1/responses",
    });
  }
  repository.close();
  return root;
}

async function rootWithTimestampedTasks(
  tasks: readonly (readonly [string, string])[],
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-cleanup-time-"));
  temporaryDirectories.push(root);
  const repository = new TrafficRepository(root);
  for (const [id, timestamp] of tasks) {
    repository.upsertTask({
      id,
      kind: "responses",
      started_at: timestamp,
      last_seen_at: timestamp,
      last_response_at: timestamp,
    });
  }
  repository.close();
  return root;
}
