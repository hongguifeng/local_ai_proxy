import { describe, expect, it } from "vitest";

import { createAdminApp } from "../src/admin/app.js";
import { registerLogRoutes } from "../src/admin/log-routes.js";
import { AdminLogService, type AdminLogSource } from "../src/admin/log-service.js";

describe("task and log management API", () => {
  it("lists multi-root tasks with explicit partial failures and pagination bounds", async () => {
    const app = fixture([source("root-a"), failingSource("root-b")]);
    const response = await app.inject({ method: "GET", url: "/api/v1/tasks?limit=10&offset=0&query=hello" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      total: 1,
      tasks: [{ logRoot: "root-a", task: { id: "task-1" } }],
      failures: [{ logRoot: "root-b", code: "STORAGE_UNAVAILABLE" }],
    });
    expect((await app.inject({ method: "GET", url: "/api/v1/tasks?limit=999" })).statusCode).toBe(400);
    await app.close();
  });

  it("returns record pages/details and stable not-found errors", async () => {
    const app = fixture([source("root-a")]);
    const page = await app.inject({ method: "GET", url: "/api/v1/tasks/task-1/records?logRoot=root-a&query=hello" });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ total: 1, records: [{ id: "record-1" }] });
    const detail = await app.inject({ method: "GET", url: "/api/v1/records/record-1?logRoot=root-a" });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ id: "record-1" });
    const missing = await app.inject({ method: "GET", url: "/api/v1/records/missing?logRoot=root-a" });
    expect(missing.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/records/record-1" })).statusCode).toBe(400);
    await app.close();
  });

  it("cleans multiple roots with per-root failures and streams ZIP export", async () => {
    const app = fixture([source("root-a"), failingSource("root-b")]);
    const cleanup = await app.inject({
      method: "POST",
      url: "/api/v1/tasks/cleanup",
      payload: { logRoots: ["root-a", "root-b"], olderThanDays: 30, batchSize: 10 },
    });
    expect(cleanup.statusCode).toBe(200);
    expect(cleanup.json()).toMatchObject({
      results: [{ logRoot: "root-a", result: { deleted: 1, batches: 1 } }],
      failures: [{ logRoot: "root-b", code: "STORAGE_UNAVAILABLE" }],
    });
    const exported = await app.inject({ method: "GET", url: "/api/v1/tasks/export?logRoot=root-a" });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toBe("application/zip");
    expect(exported.rawPayload.subarray(0, 2).toString("ascii")).toBe("PK");
    await app.close();
  });
});

function fixture(sources: AdminLogSource[]) {
  const service = new AdminLogService(sources);
  return createAdminApp({
    health: () => ({
      status: "ok",
      storage: "ok",
      storageRestartAttempts: 0,
      proxies: { configured: 0, running: 0, failed: 0 },
    }),
    registerRoutes: (scope) => {
      registerLogRoutes(scope, service);
    },
  });
}

function source(logRoot: string): AdminLogSource {
  return {
    logRoot,
    listTasks: (_query, limit, offset) =>
      Promise.resolve({ total: 1, limit, offset, hasMore: false, tasks: offset === 0 ? [task()] : [] }),
    listRecords: (_taskId, limit, offset) =>
      Promise.resolve({ total: 1, limit, offset, hasMore: false, records: offset === 0 ? [recordSummary()] : [] }),
    getRecord: (recordId) => Promise.resolve(recordId === "record-1" ? recordDetail() : null),
    cleanup: () => Promise.resolve({ deleted: 1, batches: 1 }),
  };
}

function failingSource(logRoot: string): AdminLogSource {
  const failure = () => Promise.reject(new Error("unavailable"));
  return { logRoot, listTasks: failure, listRecords: failure, getRecord: failure, cleanup: failure };
}

function task() {
  return {
    id: "task-1",
    kind: "responses" as const,
    endpoint: "/v1/responses",
    model: "gpt-5",
    target: "target",
    startedAt: "2026-07-11T00:00:00.000Z",
    lastSeenAt: "2026-07-11T00:00:00.000Z",
    requestCount: 1,
    pending: false,
  };
}

function recordSummary() {
  return {
    id: "record-1",
    taskId: "task-1",
    sequence: 1,
    event: "request_finished" as const,
    timestamp: "2026-07-11T00:00:00.000Z",
    durationMs: 1,
    method: "POST",
    path: "/v1/responses",
    status: 200,
    errorCode: null,
    messageCount: 1,
    tokenCount: 1,
  };
}

function recordDetail() {
  const empty = { kind: "empty" as const, observedBytes: 0, capturedBytes: 0, truncated: false };
  return {
    ...recordSummary(),
    client: { host: "127.0.0.1", port: 1 },
    proxy: { id: "proxy-1", name: "Proxy" },
    target: { id: "target-1", name: "Target", url: "https://example.com" },
    request: { headers: {}, body: empty },
    response: { headers: {}, body: empty },
  };
}
