import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { cleanupSelectedLogGroups } from "../../src/maintenance/index.js";
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
