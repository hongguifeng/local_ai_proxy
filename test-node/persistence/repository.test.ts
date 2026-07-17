import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TrafficRepository } from "../../src/persistence/repository.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("TrafficRepository.upsertTask", () => {
  it("inserts and updates a task without replacing its created_at", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-repository-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root, { now: () => "2026-07-18T01:02:03.000+00:00" });

    repository.upsertTask({
      id: "task-1",
      kind: "chat",
      endpoint: "/v1/chat/completions",
      started_at: "2026-07-18T00:00:00.000+00:00",
      last_seen_at: "2026-07-18T00:01:00.000+00:00",
      request_count: 1,
      pending_request_only: true,
      match_strategy_version: 4,
      fingerprints: { system: "abc" },
    });
    const updated = repository.upsertTask({
      id: "task-1",
      kind: "chat",
      started_at: "2026-07-18T00:00:00.000+00:00",
      last_seen_at: "2026-07-18T00:02:00.000+00:00",
      request_count: 2,
      pending_request_only: false,
      match_strategy_version: 4,
      created_at: "should-not-replace",
      updated_at: "2026-07-18T00:02:00.000+00:00",
    });

    expect(updated).toMatchObject({
      id: "task-1",
      kind: "chat",
      request_count: 2,
      pending_request_only: 0,
      created_at: "2026-07-18T01:02:03.000+00:00",
      updated_at: "2026-07-18T00:02:00.000+00:00",
    });
    repository.close();
  });
});
