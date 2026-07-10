import { describe, expect, it } from "vitest";

import { openStorageDatabase } from "../src/storage/migration.js";
import { StorageRepository, type TaskWrite } from "../src/storage/repository.js";

const now = "2026-07-11T00:00:00.000Z";
const emptyPayload = { kind: "empty" as const, observedBytes: 0, capturedBytes: 0, truncated: false };

function task(id = "task-1", overrides: Partial<TaskWrite> = {}): TaskWrite {
  return {
    id,
    kind: "responses",
    endpoint: "/v1/responses",
    anchor: "anchor",
    model: "gpt-5",
    target: "primary",
    startedAt: now,
    lastSeenAt: now,
    lastResponseAt: now,
    requestCount: 1,
    pending: false,
    matchConfidence: 1,
    matchStrategyVersion: 4,
    fingerprints: { input: "abc" },
    boundaryFingerprints: { first_user: "def" },
    lastUserMessages: ["hello"],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function record(id = "record-1", taskId = "task-1") {
  return {
    id,
    taskId,
    sequence: 1,
    event: "request_finished" as const,
    timestamp: now,
    durationMs: 12,
    method: "POST",
    path: "/v1/responses",
    status: 200,
    errorCode: null,
    messageCount: 1,
    tokenCount: 5,
    client: { host: "127.0.0.1", port: 12345 },
    proxy: { id: "proxy-1", name: "Proxy" },
    target: { id: "target-1", name: "Primary", url: "https://api.example.com/v1/responses" },
    request: { headers: { "content-type": ["application/json"] }, body: emptyPayload },
    response: { headers: { "content-type": ["application/json"] }, body: emptyPayload },
  };
}

describe("StorageRepository", () => {
  it("upserts and returns contract task/record DTOs with pagination", () => {
    usingDatabase((repository) => {
      repository.upsertTask(task());
      repository.upsertRecord(record(), { task: "gpt-5", request: "hello", response: "world", error: "" });
      expect(repository.listTasks("", 50, 0)).toMatchObject({ total: 1, hasMore: false, tasks: [{ id: "task-1" }] });
      expect(repository.listRecords("task-1", 50, 0)).toMatchObject({
        total: 1,
        records: [{ id: "record-1", tokenCount: 5 }],
      });
      expect(repository.getRecord("record-1")).toEqual(record());
      expect(repository.getRecord("missing")).toBeNull();
    });
  });

  it("updates record state and FTS atomically", () => {
    usingDatabase((repository, database) => {
      repository.upsertTask(task());
      repository.upsertRecord(record(), { task: "", request: "old text", response: "", error: "" });
      repository.upsertRecord(
        { ...record(), status: 201, tokenCount: 9 },
        { task: "", request: "new text", response: "", error: "" },
      );
      expect(repository.getRecord("record-1")).toMatchObject({ status: 201, tokenCount: 9 });
      expect(repository.listTasks("new", 50, 0).total).toBe(1);
      expect(repository.listTasks("old", 50, 0).total).toBe(0);

      database.exec("DROP TABLE record_search");
      expect(() => {
        repository.upsertRecord({ ...record(), status: 202 }, { task: "", request: "fail", response: "", error: "" });
      }).toThrow();
      expect(repository.getRecord("record-1")).toMatchObject({ status: 201 });
    });
  });

  it("supports links, recent task lookup, and literal search characters", () => {
    usingDatabase((repository) => {
      repository.upsertTask(task("task-1", { model: "100%_model" }));
      repository.upsertResponseLink({ value: "resp-1", taskId: "task-1", createdAt: now });
      repository.upsertContextLink({ value: "conversation:one", taskId: "task-1", createdAt: now });
      expect(repository.taskIdForResponse("resp-1")).toBe("task-1");
      expect(repository.taskIdForContext("conversation:one")).toBe("task-1");
      expect(repository.taskIdForResponse("missing")).toBeNull();
      expect(repository.listTasks("%_", 50, 0).total).toBe(1);
      expect(
        repository.recentTasks({
          since: "2026-07-10T00:00:00.000Z",
          kind: "responses",
          endpoint: "/v1/responses",
          model: "100%_model",
          limit: 10,
        }),
      ).toHaveLength(1);
    });
  });

  it("cascades task deletion and explicitly removes FTS rows", () => {
    usingDatabase((repository, database) => {
      repository.upsertTask(task());
      repository.upsertRecord(record(), { task: "", request: "searchable", response: "", error: "" });
      repository.upsertResponseLink({ value: "resp-1", taskId: "task-1", createdAt: now });
      expect(repository.deleteTasks(["task-1"])).toBe(1);
      expect(database.prepare("SELECT COUNT(*) count FROM records").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) count FROM response_links").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) count FROM record_search").get()).toEqual({ count: 0 });
    });
  });

  it("validates pagination and task deletion boundaries", () => {
    usingDatabase((repository) => {
      expect(() => repository.listTasks("", 0, 0)).toThrow(RangeError);
      expect(() => repository.listRecords("task", 50, -1)).toThrow(RangeError);
      expect(() =>
        repository.recentTasks({ since: now, kind: "chat", endpoint: "/", model: null, limit: 201 }),
      ).toThrow(RangeError);
      expect(repository.deleteTasks([])).toBe(0);
      expect(() => repository.deleteTasks(Array.from({ length: 10_001 }, (_, index) => String(index)))).toThrow(
        RangeError,
      );
    });
  });

  it("uses an index for a 100k-row recent task query", () => {
    usingDatabase((_repository, database) => {
      database.exec(`WITH RECURSIVE counter(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM counter WHERE value < 100000
      ) INSERT INTO tasks(
        id, kind, endpoint, model, started_at, last_seen_at, request_count,
        pending_request_only, match_strategy_version, created_at, updated_at
      ) SELECT printf('task-%06d', value), CASE WHEN value % 2 = 0 THEN 'chat' ELSE 'responses' END,
        '/v1/chat/completions', 'gpt-5', '${now}', '${now}', 1, 0, 4, '${now}', '${now}' FROM counter`);
      const plan = database
        .prepare("EXPLAIN QUERY PLAN SELECT id FROM tasks WHERE kind = ? ORDER BY last_seen_at DESC LIMIT 50")
        .all("chat")
        .map((row) => (row as { detail: string }).detail)
        .join(" ");
      expect(plan).toContain("idx_tasks_kind");
    });
  });
});

function usingDatabase(
  run: (repository: StorageRepository, database: ReturnType<typeof openStorageDatabase>) => void,
): void {
  const database = openStorageDatabase(":memory:");
  try {
    run(new StorageRepository(database), database);
  } finally {
    database.close();
  }
}
