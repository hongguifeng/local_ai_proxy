import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TrafficRepository } from "../src/persistence/repository.js";
import { probeSqliteAbi } from "./native_abi_probe.js";

// Opening the repository would only prove the native binding implicitly: a wrong ABI surfaces
// here as an unhandled ERR_DLOPEN_FAILED. Report the ABI state first, with the rebuild command
// that fixes it, so a failure names the ABI it needs.
const abi = probeSqliteAbi();
assert.ok(abi.ok, abi.detail);

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
  process.stdout.write(
    `Packaged database smoke test passed on ${process.platform}: ${abi.detail}\n`,
  );
} finally {
  await rm(root, { force: true, recursive: true });
}
