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

describe("TrafficRepository.listTasks", () => {
  it("queries, sorts, and paginates tasks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-list-tasks-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root, { now: () => "2026-07-18T00:00:00.000+00:00" });
    for (const [id, model, lastSeen] of [
      ["task-old", "fixture-gpt", "2026-07-18T01:00:00.000+00:00"],
      ["task-middle", "claude", "2026-07-18T02:00:00.000+00:00"],
      ["task-new", "fixture-gpt", "2026-07-18T03:00:00.000+00:00"],
    ]) {
      repository.upsertTask({
        id,
        model,
        started_at: lastSeen,
        last_seen_at: lastSeen,
        match_strategy_version: 4,
      });
    }

    expect(repository.listTasks("", 2, 0)).toMatchObject({
      items: [{ id: "task-new" }, { id: "task-middle" }],
      total: 3,
      limit: 2,
      offset: 0,
      nextOffset: 2,
      hasMore: true,
    });
    expect(repository.listTasks("", 2, 2)).toMatchObject({
      items: [{ id: "task-old" }],
      total: 3,
      nextOffset: 3,
      hasMore: false,
    });
    expect(repository.listTasks("FIXTURE-GPT").items.map(({ id }) => id)).toEqual([
      "task-new",
      "task-old",
    ]);
    repository.close();
  });
});

describe("TrafficRepository.upsertRecord", () => {
  it("inserts a complete traffic record", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-record-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root, { now: () => "2026-07-18T00:00:00.000+00:00" });
    repository.upsertTask({ id: "task-1", match_strategy_version: 4 });

    const record = repository.upsertRecord({
      id: "record-1",
      task_id: "task-1",
      sequence: 1,
      event: "request_finished",
      timestamp: "2026-07-18T01:00:00.000+00:00",
      duration_ms: 12.5,
      method: "POST",
      path: "/v1/responses",
      status: 200,
      request_headers: { "Content-Type": ["application/json"] },
      request_body: { model: "demo" },
      response_body: { id: "resp_1" },
      stripped_fields: ["temperature"],
    });

    expect(record).toMatchObject({
      id: "record-1",
      task_id: "task-1",
      sequence: 1,
      event: "request_finished",
      method: "POST",
      endpoint: "/v1/responses",
      status: 200,
      request_body: { model: "demo" },
      response_body: { id: "resp_1" },
      stripped_fields: ["temperature"],
    });
    expect(repository.getRecord("record-1")).toEqual(record);
    expect(repository.taskIdForRecord("record-1")).toBe("task-1");
    expect(repository.getRecord("missing")).toBeUndefined();
    expect(repository.taskIdForRecord("missing")).toBeUndefined();
    repository.close();
  });

  it("updates an existing pending record in place", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-pending-record-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root, { now: () => "2026-07-18T00:00:00.000+00:00" });
    repository.upsertTask({ id: "task-1", match_strategy_version: 4 });
    repository.upsertRecord({
      id: "record-1",
      task_id: "task-1",
      event: "request_received",
      method: "POST",
      path: "/v1/responses",
      created_at: "2026-07-18T00:00:00.000+00:00",
    });

    const updated = repository.upsertRecord({
      id: "record-1",
      task_id: "task-1",
      event: "request_finished",
      method: "POST",
      path: "/v1/responses",
      status: 200,
      response_body: { id: "resp_final" },
      created_at: "must-not-replace",
      updated_at: "2026-07-18T00:01:00.000+00:00",
    });

    expect(updated).toMatchObject({
      id: "record-1",
      event: "request_finished",
      status: 200,
      response_body: { id: "resp_final" },
      created_at: "2026-07-18T00:00:00.000+00:00",
      updated_at: "2026-07-18T00:01:00.000+00:00",
    });
    repository.close();
  });
});

describe("TrafficRepository record sequence helpers", () => {
  it("returns the next sequence and record count for a task", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-record-sequence-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    repository.upsertTask({ id: "task-1", match_strategy_version: 4 });

    expect(repository.nextRecordSequence("task-1")).toBe(1);
    expect(repository.recordCount("task-1")).toBe(0);
    for (const [id, sequence] of [
      ["record-1", 2],
      ["record-2", 5],
    ] as const) {
      repository.upsertRecord({
        id,
        task_id: "task-1",
        sequence,
        method: "POST",
        path: "/v1/responses",
      });
    }

    expect(repository.nextRecordSequence("task-1")).toBe(6);
    expect(repository.recordCount("task-1")).toBe(2);
    expect(repository.nextRecordSequence("missing")).toBe(1);
    expect(repository.recordCount("missing")).toBe(0);
    repository.close();
  });
});

describe("TrafficRepository.listTaskRecords", () => {
  it("queries and paginates records in descending sequence order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-list-records-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    repository.upsertTask({ id: "task-1", match_strategy_version: 4 });
    for (const [id, sequence, text] of [
      ["record-1", 1, "older"],
      ["record-2", 2, "needle middle"],
      ["record-3", 3, "newest needle"],
    ] as const) {
      repository.upsertRecord({
        id,
        task_id: "task-1",
        sequence,
        method: "POST",
        path: "/v1/responses",
        request_body: { text },
      });
    }

    expect(repository.listTaskRecords("task-1", "", 2)).toMatchObject({
      items: [{ id: "record-3" }, { id: "record-2" }],
      total: 3,
      limit: 2,
      offset: 0,
      nextOffset: 2,
      hasMore: true,
    });
    expect(repository.listTaskRecords("task-1", "needle").items.map(({ id }) => id)).toEqual([
      "record-3",
      "record-2",
    ]);
    expect(repository.listTaskRecords("missing").total).toBe(0);
    repository.close();
  });
});
