import { describe, expect, it } from "vitest";

import { ApiClient } from "../src/api-client.js";
import { AdminUiController } from "../src/ui-controller.js";

describe("AdminUiController workflows", () => {
  it("loads proxies, searches tasks, opens records/detail, exports and cleans", async () => {
    const calls: string[] = [];
    const client = new ApiClient((path, init) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/api/v1/proxies") return ok({ proxies: [] });
      if (path.startsWith("/api/v1/tasks?"))
        return ok({
          total: 1,
          limit: 50,
          offset: 0,
          hasMore: false,
          tasks: [{ logRoot: "root-a", task: task() }],
          failures: [],
        });
      if (path.includes("/records?"))
        return ok({ total: 1, limit: 50, offset: 0, hasMore: false, records: [record()] });
      if (path.startsWith("/api/v1/records/")) return ok(detail());
      if (path === "/api/v1/tasks/cleanup") return ok({ results: [] });
      return ok({ proxies: [] });
    });
    const controller = new AdminUiController(client, () => undefined);
    await controller.loadProxies();
    await controller.searchTasks("hello");
    await controller.selectTask("root-a", "task-1");
    await controller.selectRecord("record-1");
    expect(controller.state.detail?.id).toBe("record-1");
    expect(controller.exportUrl()).toBe("/api/v1/tasks/export?logRoot=root-a");
    await controller.cleanupSelected();
    expect(calls).toContain("POST /api/v1/tasks/cleanup");
  });

  it("surfaces the unified public error message without exposing unknown details", async () => {
    const client = new ApiClient(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: "FAILED", message: "Safe message" } }), { status: 500 }),
      ),
    );
    const controller = new AdminUiController(client, () => undefined);
    await controller.loadProxies();
    expect(controller.state.error).toBe("Safe message");
  });
});

function ok(value: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }),
  );
}

function task() {
  return {
    id: "task-1",
    kind: "responses",
    endpoint: "/v1/responses",
    model: "gpt-5",
    target: "target",
    startedAt: "2026-07-11T00:00:00.000Z",
    lastSeenAt: "2026-07-11T00:00:00.000Z",
    requestCount: 1,
    pending: false,
  };
}

function record() {
  return {
    id: "record-1",
    taskId: "task-1",
    sequence: 1,
    event: "request_finished",
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

function detail() {
  const empty = { kind: "empty", observedBytes: 0, capturedBytes: 0, truncated: false };
  return {
    ...record(),
    client: { host: "127.0.0.1", port: 1 },
    proxy: { id: "proxy-1", name: "Proxy" },
    target: { id: "target-1", name: "Target", url: "https://example.com" },
    request: { headers: {}, body: empty },
    response: { headers: {}, body: empty },
  };
}
