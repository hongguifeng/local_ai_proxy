import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TrafficRepository } from "../src/persistence/repository.js";

const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-packaged-db-smoke-"));
try {
  const repository = new TrafficRepository(root);
  try {
    repository.upsertTask({
      id: "packaged-smoke-task",
      kind: "responses",
      model: "packaged-smoke-model",
      match_strategy_version: 4,
    });
    repository.upsertRecord({
      id: "packaged-smoke-record",
      task_id: "packaged-smoke-task",
      sequence: 1,
      method: "POST",
      path: "/v1/responses",
      request_body: { input: "native sqlite fts smoke token" },
    });
    assert.equal(repository.getTask("packaged-smoke-task")?.["model"], "packaged-smoke-model");
    assert.equal(repository.getRecord("packaged-smoke-record")?.["task_id"], "packaged-smoke-task");
    assert.deepEqual(
      repository.listTasks("fts smoke token").items.map(({ id }) => id),
      ["packaged-smoke-task"],
    );
  } finally {
    repository.close();
  }
  process.stdout.write(`Packaged database smoke test passed on ${process.platform}.\n`);
} finally {
  await rm(root, { force: true, recursive: true });
}
