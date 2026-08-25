import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatLocalTimestamp } from "../../src/shared/time.js";
import { BODY_CHUNK_BYTES } from "../../src/persistence/body-storage.js";
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

describe("TrafficRepository.transaction", () => {
  it("rolls back task, record, and link writes as one unit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-repository-transaction-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);

    expect(() =>
      repository.transaction(() => {
        repository.upsertTask({ id: "transaction-task", match_strategy_version: 4 });
        repository.upsertRecord({
          id: "transaction-record",
          task_id: "transaction-task",
          sequence: 1,
          method: "POST",
          path: "/v1/responses",
        });
        repository.upsertResponseLink("transaction-response", "transaction-task");
        repository.upsertContextLink("conversation:transaction", "transaction-task");
        throw new Error("rollback fixture");
      }),
    ).toThrow("rollback fixture");
    expect(repository.getTask("transaction-task")).toBeUndefined();
    expect(repository.getRecord("transaction-record")).toBeUndefined();
    expect(repository.taskIdForResponse("transaction-response")).toBeUndefined();
    expect(repository.taskIdForContext("conversation:transaction")).toBeUndefined();
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

describe("TrafficRepository history summaries", () => {
  it("returns list metadata without hydrating task internals or record bodies", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-history-summary-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    repository.upsertTask({
      id: "summary-task",
      model: "summary-model",
      request_count: 1,
      fingerprints: { large: "task-internal" },
      last_user_messages: ["task-internal"],
    });
    repository.upsertRecord({
      id: "summary-record",
      task_id: "summary-task",
      sequence: 1,
      timestamp: "2026-07-18T01:00:00.000+00:00",
      method: "POST",
      path: "/v1/responses",
      request_body: { large: "request-body" },
      response_body: { large: "response-body" },
    });

    expect(repository.hasTask("summary-task")).toBe(true);
    expect(repository.hasTask("missing-task")).toBe(false);
    const taskSummary = repository.listTaskSummaries().items[0];
    expect(taskSummary).toMatchObject({
      id: "summary-task",
      model: "summary-model",
      request_count: 1,
      last_response_at: null,
      target: null,
    });
    expect(typeof taskSummary?.["started_at"]).toBe("string");
    expect(typeof taskSummary?.["last_seen_at"]).toBe("string");
    expect(repository.listTaskRecordSummaries("summary-task").items[0]).toEqual({
      id: "summary-record",
      sequence: 1,
      timestamp: "2026-07-18T01:00:00.000+00:00",
      method: "POST",
      path: "/v1/responses",
      endpoint: "/v1/responses",
      status: null,
      message_count: null,
      request_token_count: null,
      response_token_count: null,
      target_url: null,
    });
    repository.close();
  });

  it("never lists a group whose records do not all match the search terms", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-group-record-consistency-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    repository.upsertTask({ id: "task-match", model: "gpt-5", request_count: 1 });
    repository.upsertRecord({
      id: "record-match",
      task_id: "task-match",
      sequence: 1,
      method: "POST",
      path: "/v1/responses",
      request_body: { text: "alpha beta" },
    });
    repository.upsertTask({ id: "task-split", model: "gpt-5", request_count: 2 });
    repository.upsertRecord({
      id: "record-split-a",
      task_id: "task-split",
      sequence: 1,
      method: "POST",
      path: "/v1/responses",
      request_body: { text: "alpha" },
    });
    repository.upsertRecord({
      id: "record-split-b",
      task_id: "task-split",
      sequence: 2,
      method: "POST",
      path: "/v1/responses",
      request_body: { text: "beta" },
    });

    // One record of task-match contains both terms, one record of task-split
    // contains each: only the former group may be listed for the combined query.
    const groupPage = repository.listTaskSummaries("alpha beta");
    expect(groupPage.items.map(({ id }) => id)).toEqual(["task-match"]);
    expect(repository.listTaskRecordSummaries("task-match", "alpha beta").items).toHaveLength(1);

    expect(repository.listTaskSummaries("alpha").items.map(({ id }) => id)).toEqual([
      "task-split",
      "task-match",
    ]);
    expect(repository.listTaskRecordSummaries("task-split", "alpha").items).toHaveLength(1);
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

describe("legacy database compatibility", () => {
  it("reads the comprehensive database fixture", async () => {
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

    const migrated = connectLogDatabase(root);
    expect(
      migrated
        .prepare(
          `SELECT COUNT(*) FROM records
           WHERE request_body_json IS NOT NULL
              OR original_request_body_json IS NOT NULL
              OR response_body_json IS NOT NULL`,
        )
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      migrated.prepare("SELECT COUNT(*) FROM record_body_chunks").pluck().get(),
    ).toBeGreaterThan(0);
    expect(migrated.prepare("SELECT COUNT(*) FROM record_search_map").pluck().get()).toBe(6);
    migrated.close();
  });

  it("writes rows and links to an existing database fixture", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-node-python-db-"));
    temporaryDirectories.push(root);
    await copyFile(
      path.join(process.cwd(), "fixtures", "parity", "database", "comprehensive", "traffic.db"),
      path.join(root, "traffic.db"),
    );
    const repository = new TrafficRepository(root, { now: () => "2026-07-18T08:00:00.000+08:00" });
    repository.upsertTask({
      id: "task-node-roundtrip",
      kind: "chat",
      model: "node-fixture",
      match_strategy_version: 4,
      fingerprints: { system: "node-system" },
    });
    repository.upsertRecord({
      id: "record-node-roundtrip",
      task_id: "task-node-roundtrip",
      sequence: 1,
      method: "POST",
      path: "/v1/chat/completions",
      request_body: { model: "node-fixture", messages: [{ role: "user", content: "你好" }] },
      response_body: { id: "chatcmpl_node", usage: { total_tokens: 7 } },
    });
    repository.upsertResponseLink("chatcmpl_node", "task-node-roundtrip");
    repository.upsertContextLink("conversation:node-roundtrip", "task-node-roundtrip");
    repository.close();

    const reopened = new TrafficRepository(root);
    expect(reopened.getTask("task-node-roundtrip")).toMatchObject({
      id: "task-node-roundtrip",
      fingerprints: { system: "node-system" },
    });
    expect(reopened.getRecord("record-node-roundtrip")).toMatchObject({
      id: "record-node-roundtrip",
      request_body: { model: "node-fixture", messages: [{ role: "user", content: "你好" }] },
      response_body: { id: "chatcmpl_node", usage: { total_tokens: 7 } },
    });
    expect(reopened.taskIdForResponse("chatcmpl_node")).toBe("task-node-roundtrip");
    expect(reopened.taskIdForContext("conversation:node-roundtrip")).toBe("task-node-roundtrip");
    reopened.close();
  });

  it("creates a fresh database that can be reopened with all current fields", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-fresh-node-db-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root, { now: () => "2026-07-18T09:00:00.000+08:00" });
    repository.upsertTask({
      id: "task-fresh-node",
      kind: "responses",
      endpoint: "/v1/responses",
      model: "gpt-node",
      request_count: 1,
      pending_request_only: false,
      match_strategy_version: 4,
      boundary_fingerprints: { first_user: "fresh-boundary" },
      last_user_messages: [{ role: "user", content: "fresh database" }],
    });
    repository.upsertRecord({
      id: "record-fresh-node",
      task_id: "task-fresh-node",
      sequence: 1,
      method: "POST",
      path: "/v1/responses",
      status: 200,
      request_headers: { authorization: "[REDACTED]" },
      response_headers: { "content-type": "application/json" },
      request_body: { model: "gpt-node", input: "fresh database" },
      response_body: { id: "resp_fresh_node", output_text: "created by Node" },
      model_route: { requested: "gpt-node", effective: "gpt-node" },
      stripped_fields: ["temperature"],
      injected_fields: ["stream"],
      added_upstream_headers: ["x-node-test"],
    });
    repository.upsertResponseLink("resp_fresh_node", "task-fresh-node");
    repository.upsertContextLink("conversation:fresh-node", "task-fresh-node");
    repository.close();

    const reopened = new TrafficRepository(root);
    expect(reopened.getTask("task-fresh-node")).toMatchObject({
      id: "task-fresh-node",
      kind: "responses",
      match_strategy_version: 4,
      boundary_fingerprints: { first_user: "fresh-boundary" },
      last_user_messages: [{ role: "user", content: "fresh database" }],
    });
    expect(reopened.getRecord("record-fresh-node")).toMatchObject({
      id: "record-fresh-node",
      status: 200,
      request_headers: { authorization: "[REDACTED]" },
      response_body: { id: "resp_fresh_node", output_text: "created by Node" },
      model_route: { requested: "gpt-node", effective: "gpt-node" },
      stripped_fields: ["temperature"],
      injected_fields: ["stream"],
      added_upstream_headers: ["x-node-test"],
    });
    expect(reopened.taskIdForResponse("resp_fresh_node")).toBe("task-fresh-node");
    expect(reopened.taskIdForContext("conversation:fresh-node")).toBe("task-fresh-node");
    reopened.close();
  });
});

describe("multiple database connections", () => {
  it("serializes concurrent writes from separate processes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-concurrent-db-"));
    temporaryDirectories.push(root);
    const initializer = new TrafficRepository(root);
    initializer.close();

    const writers = ["alpha", "bravo", "charlie", "delta"];
    await Promise.all(writers.map((writer) => runConcurrentWriter(root, writer, 20)));

    const repository = new TrafficRepository(root);
    expect(repository.listTasks("concurrent-write", 100).total).toBe(80);
    for (const writer of writers) {
      expect(repository.getTask(`task-${writer}-19`)).toMatchObject({ model: writer });
      expect(repository.getRecord(`record-${writer}-19`)).toMatchObject({
        task_id: `task-${writer}-19`,
        request_body: { writer, index: 19 },
      });
    }
    repository.close();
  });
});

function runConcurrentWriter(root: string, writerId: string, count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(process.cwd(), "scripts", "database_concurrent_writer.ts"),
        root,
        writerId,
        String(count),
      ],
      { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Concurrent database writer ${writerId} exited with ${code}: ${stderr}`));
      }
    });
  });
}

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
      request_body: { input: "stored in a compressed chunk" },
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
        .prepare("SELECT COUNT(*) FROM record_search_map WHERE task_id = ?")
        .pluck()
        .get("task-delete"),
    ).toBe(0);
    expect(inspection.prepare("SELECT COUNT(*) FROM response_links").pluck().get()).toBe(0);
    expect(inspection.prepare("SELECT COUNT(*) FROM context_links").pluck().get()).toBe(0);
    expect(inspection.prepare("SELECT COUNT(*) FROM record_body_chunks").pluck().get()).toBe(0);
    expect(inspection.prepare("SELECT COUNT(*) FROM body_chunks").pluck().get()).toBe(0);
    inspection.close();
  });
});

describe("chunked record body storage", () => {
  it("deduplicates, compresses, restores, and garbage-collects exact bodies", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-body-chunks-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    repository.upsertTask({ id: "task-chunks", match_strategy_version: 4 });
    const repeated = "repeated conversation context ".repeat(BODY_CHUNK_BYTES / 8);
    const requestBody = { model: "fixture-model", input: repeated };
    for (const [id, sequence] of [
      ["record-chunk-1", 1],
      ["record-chunk-2", 2],
    ] as const) {
      repository.upsertRecord({
        id,
        task_id: "task-chunks",
        sequence,
        method: "POST",
        path: "/v1/responses",
        request_body: requestBody,
      });
    }
    repository.close();

    const inspection = connectLogDatabase(root);
    expect(
      inspection
        .prepare(
          "SELECT request_body_json IS NULL AND response_body_json IS NULL FROM records LIMIT 1",
        )
        .pluck()
        .get(),
    ).toBe(1);
    const references = inspection
      .prepare("SELECT COUNT(*) FROM record_body_chunks")
      .pluck()
      .get() as number;
    const chunks = inspection.prepare("SELECT COUNT(*) FROM body_chunks").pluck().get() as number;
    const sizes = inspection
      .prepare("SELECT SUM(raw_size) AS raw, SUM(LENGTH(data)) AS compressed FROM body_chunks")
      .get() as { raw: number; compressed: number };
    expect(chunks).toBeLessThan(references);
    expect(sizes.compressed).toBeLessThan(sizes.raw);
    inspection.close();

    const reopened = new TrafficRepository(root);
    expect(reopened.getRecord("record-chunk-1")?.["request_body"]).toEqual(requestBody);
    expect(reopened.getRecord("record-chunk-2")?.["request_body"]).toEqual(requestBody);
    expect(reopened.deleteTasks(["task-chunks"])).toBe(1);
    reopened.close();

    const cleaned = connectLogDatabase(root);
    expect(cleaned.prepare("SELECT COUNT(*) FROM body_chunks").pluck().get()).toBe(0);
    cleaned.close();
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
      first_byte_ms: 4.25,
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
      duration_ms: 12.5,
      first_byte_ms: 4.25,
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
