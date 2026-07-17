import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TrafficRepository, decodeTaskRow } from "../../src/persistence/repository.js";

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
      pending_request_only: false,
      created_at: "2026-07-18T01:02:03.000+00:00",
      updated_at: "2026-07-18T00:02:00.000+00:00",
    });
    expect(repository.getTask("task-1")).toEqual(updated);
    expect(repository.getTask("missing")).toBeUndefined();
    repository.close();
  });
});

describe("decodeTaskRow", () => {
  it("decodes boolean and JSON task columns", () => {
    expect(
      decodeTaskRow({
        id: "task-1",
        pending_request_only: 1,
        fingerprints_json: '{"system":"abc"}',
        boundary_fingerprints_json: '{"first_user":"def"}',
        last_user_messages_json: '[{"role":"user"}]',
      }),
    ).toEqual({
      id: "task-1",
      pending_request_only: true,
      fingerprints: { system: "abc" },
      boundary_fingerprints: { first_user: "def" },
      last_user_messages: [{ role: "user" }],
    });
  });

  it("uses safe defaults for empty or invalid JSON columns", () => {
    expect(
      decodeTaskRow({
        pending_request_only: 0,
        fingerprints_json: "{invalid",
        boundary_fingerprints_json: "",
        last_user_messages_json: null,
      }),
    ).toEqual({
      pending_request_only: false,
      fingerprints: {},
      boundary_fingerprints: {},
      last_user_messages: [],
    });
  });
});

describe("TrafficRepository.recentTasks", () => {
  it("returns only non-pending tasks in most-recent order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-recent-tasks-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root, { now: () => "2026-07-18T00:00:00.000+00:00" });
    for (const task of [
      { id: "older", last_seen_at: "2026-07-18T01:00:00.000+00:00", pending: false },
      { id: "newer", last_seen_at: "2026-07-18T03:00:00.000+00:00", pending: false },
      { id: "pending", last_seen_at: "2026-07-18T04:00:00.000+00:00", pending: true },
    ]) {
      repository.upsertTask({
        id: task.id,
        started_at: task.last_seen_at,
        last_seen_at: task.last_seen_at,
        pending_request_only: task.pending,
        match_strategy_version: 4,
      });
    }

    expect(repository.recentTasks().map(({ id }) => id)).toEqual(["newer", "older"]);
    expect(repository.recentTasks(1).map(({ id }) => id)).toEqual(["newer"]);
    repository.close();
  });
});
