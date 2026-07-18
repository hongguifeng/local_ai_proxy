import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatLocalTimestamp } from "../../src/shared/time.js";
import { connectLogDatabase } from "../../src/persistence/database.js";
import {
  TrafficRepository,
  decodeTaskRow,
  recordSearchDocument,
  searchText,
} from "../../src/persistence/repository.js";

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
    repository.upsertRecord({
      id: "record-search",
      task_id: "task-new",
      method: "POST",
      path: "/v1/responses",
      request_body: { text: "searchable request" },
    });
    expect(repository.listTasks("fixture searchable").items.map(({ id }) => id)).toEqual([
      "task-new",
    ]);
    expect(repository.listTasks("claude searchable").items).toEqual([]);
    repository.close();
  });
});

describe("literal LIKE search characters", () => {
  it("treats percent, underscore, and backslash as ordinary text", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-like-search-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    for (const [id, model] of [
      ["percent", "model-100%"],
      ["underscore", "model_under_score"],
      ["backslash", "model\\path"],
      ["plain", "model ordinary"],
    ] as const) {
      repository.upsertTask({ id, model, match_strategy_version: 4 });
    }

    expect(repository.listTasks("%").items.map(({ id }) => id)).toEqual(["percent"]);
    expect(repository.listTasks("_").items.map(({ id }) => id)).toEqual(["underscore"]);
    expect(repository.listTasks("\\").items.map(({ id }) => id)).toEqual(["backslash"]);
    repository.close();
  });
});

describe("timestamp search", () => {
  it("indexes ISO timestamps using their local display time", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-time-search-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    const timestamp = "2026-07-18T01:02:03.000+00:00";
    repository.upsertTask({
      id: "task-time",
      started_at: timestamp,
      last_seen_at: timestamp,
      match_strategy_version: 4,
    });
    repository.upsertRecord({
      id: "record-time",
      task_id: "task-time",
      timestamp,
      method: "POST",
      path: "/v1/responses",
    });
    const localTimestamp = formatLocalTimestamp(timestamp);

    expect(searchText(timestamp)).toContain(localTimestamp);
    expect(repository.listTasks(localTimestamp).items.map(({ id }) => id)).toEqual(["task-time"]);
    expect(
      repository.listTaskRecords("task-time", localTimestamp).items.map(({ id }) => id),
    ).toEqual(["record-time"]);
    repository.close();
  });
});

describe("Python database compatibility", () => {
  it("reads the comprehensive Python database fixture", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-python-db-"));
    temporaryDirectories.push(root);
    await copyFile(
      path.join(process.cwd(), "fixtures", "parity", "database", "comprehensive", "traffic.db"),
      path.join(root, "traffic.db"),
    );
    const repository = new TrafficRepository(root);

    expect(repository.getTask("task-responses-fixture")).toMatchObject({
      kind: "responses",
      model: "gpt-fixture",
      pending_request_only: false,
      fingerprints: { fixture: "responses-fingerprint" },
      last_user_messages: [{ role: "user", content: "fixture responses request" }],
    });
    expect(repository.getRecord("record-responses-1")).toMatchObject({
      task_id: "task-responses-fixture",
      sequence: 1,
      request_headers: { "X-Repeated": ["one", "two"] },
      response_body: { stream_summary: { content: "hello from fixture" } },
      stripped_fields: ["temperature"],
    });
    expect(repository.taskIdForResponse("resp_fixture_2")).toBe("task-responses-fixture");
    expect(repository.taskIdForContext("conversation:conversation-fixture")).toBe(
      "task-responses-fixture",
    );
    repository.close();
  });
});

describe("TrafficRepository.deleteTasks", () => {
  it("cascades task deletion to records and links", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-delete-task-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    repository.upsertTask({ id: "task-delete", match_strategy_version: 4 });
    repository.upsertRecord({
      id: "record-delete",
      task_id: "task-delete",
      method: "POST",
      path: "/v1/responses",
    });
    repository.upsertResponseLink("resp-delete", "task-delete");
    repository.upsertContextLink("context-delete", "task-delete");

    expect(repository.deleteTasks(["", "task-delete"])).toBe(1);
    expect(repository.getTask("task-delete")).toBeUndefined();
    expect(repository.getRecord("record-delete")).toBeUndefined();
    expect(repository.taskIdForResponse("resp-delete")).toBeUndefined();
    expect(repository.taskIdForContext("context-delete")).toBeUndefined();
    expect(repository.deleteTasks([])).toBe(0);
    repository.close();

    const inspection = connectLogDatabase(root);
    expect(
      inspection
        .prepare("SELECT COUNT(*) FROM record_search WHERE task_id = ?")
        .pluck()
        .get("task-delete"),
    ).toBe(0);
    expect(inspection.prepare("SELECT COUNT(*) FROM response_links").pluck().get()).toBe(0);
    expect(inspection.prepare("SELECT COUNT(*) FROM context_links").pluck().get()).toBe(0);
    inspection.close();
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
    expect(repository.listTaskRecords("task-1", "needle middle").items.map(({ id }) => id)).toEqual(
      ["record-2"],
    );
    expect(repository.listTaskRecords("task-1", "newest middle").items).toEqual([]);
    expect(repository.listTaskRecords("missing").total).toBe(0);
    repository.close();
  });
});

describe("record task sequence uniqueness", () => {
  it("rejects a second record at the same task sequence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-record-conflict-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    repository.upsertTask({ id: "task-1", match_strategy_version: 4 });
    repository.upsertRecord({
      id: "record-original",
      task_id: "task-1",
      sequence: 1,
      method: "POST",
      path: "/original",
    });

    expect(() =>
      repository.upsertRecord({
        id: "record-conflict",
        task_id: "task-1",
        sequence: 1,
        method: "POST",
        path: "/conflict",
      }),
    ).toThrow(/UNIQUE constraint failed: records\.task_id, records\.sequence/u);
    expect(repository.recordCount("task-1")).toBe(1);
    expect(repository.getRecord("record-original")?.["path"]).toBe("/original");
    expect(repository.getRecord("record-conflict")).toBeUndefined();
    repository.close();
  });
});

describe("response links", () => {
  it("upserts and resolves a response ID", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-response-link-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    repository.upsertTask({ id: "task-1", match_strategy_version: 4 });
    repository.upsertTask({ id: "task-2", match_strategy_version: 4 });

    repository.upsertResponseLink("resp_1", "task-1");
    expect(repository.taskIdForResponse("resp_1")).toBe("task-1");
    repository.upsertResponseLink("resp_1", "task-2");
    expect(repository.taskIdForResponse("resp_1")).toBe("task-2");
    repository.upsertResponseLink("   ", "task-1");
    expect(repository.taskIdForResponse("missing")).toBeUndefined();
    repository.close();
  });
});

describe("context links", () => {
  it("upserts and resolves a context key", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-context-link-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    repository.upsertTask({ id: "task-1", match_strategy_version: 4 });
    repository.upsertTask({ id: "task-2", match_strategy_version: 4 });

    repository.upsertContextLink("conversation:fixture", "task-1");
    expect(repository.taskIdForContext("conversation:fixture")).toBe("task-1");
    repository.upsertContextLink("conversation:fixture", "task-2");
    expect(repository.taskIdForContext("conversation:fixture")).toBe("task-2");
    repository.upsertContextLink("", "task-1");
    expect(repository.taskIdForContext("missing")).toBeUndefined();
    repository.close();
  });
});

describe("record search document generation", () => {
  it("separates task, request, response, and error search text", () => {
    expect(searchText("record", null, "", 42, false)).toBe("record 42 false");
    const document = recordSearchDocument(
      {
        id: "record-1",
        task_id: "task-1",
        method: "POST",
        path: "/v1/responses",
        request_body_json: '{"prompt":"searchable request"}',
        response_body_json: '{"output":"searchable response"}',
        status: 200,
        error: "fixture error",
      },
      { id: "task-1", model: "fixture-model" },
    );
    expect(document).toMatchObject({
      recordId: "record-1",
      taskId: "task-1",
      taskText: "task-1 fixture-model",
      errorText: "fixture error",
    });
    expect(document.requestText).toContain("searchable request");
    expect(document.responseText).toContain("searchable response");
  });
});
