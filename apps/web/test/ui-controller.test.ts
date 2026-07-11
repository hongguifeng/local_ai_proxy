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
    expect(controller.state.notice).toBe("任务已清理");
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
    expect(controller.state.stale).toBe(true);
  });

  it("sends explicit secret updates once without retaining saved secret values", async () => {
    const bodies: unknown[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const client = new ApiClient(async (_path, init) => {
      if (init?.method === "PUT") {
        if (typeof init.body !== "string") throw new TypeError("Expected JSON request body");
        bodies.push(JSON.parse(init.body) as unknown);
        await pending;
      }
      return ok({ proxies: [proxy()] });
    });
    const controller = new AdminUiController(client, () => undefined);
    await controller.loadProxies();
    controller.setTargetSecret("proxy-1", "target-1", "replace", "new-secret");
    const first = controller.saveProxies();
    const duplicate = controller.saveProxies();
    release();
    await Promise.all([first, duplicate]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      proxies: [{ targets: [{ apiKey: { action: "replace", value: "new-secret" } }] }],
    });
    expect(JSON.stringify(controller.state)).not.toContain("new-secret");
    expect(controller.state.notice).toBe("配置已保存");
  });

  it("keeps existing data when refresh fails and reports it as stale", async () => {
    let fail = false;
    const client = new ApiClient(() =>
      fail ? Promise.reject(new Error("private detail")) : ok({ proxies: [proxy()] }),
    );
    const controller = new AdminUiController(client, () => undefined);
    await controller.loadProxies();
    fail = true;
    await controller.loadProxies();
    expect(controller.state.proxies).toHaveLength(1);
    expect(controller.state.stale).toBe(true);
    expect(controller.state.error).toBe("Request failed");
  });

  it("sends an explicit clear action without a secret value", async () => {
    let body: unknown;
    const client = new ApiClient((_path, init) => {
      if (init?.method === "PUT") {
        if (typeof init.body !== "string") throw new TypeError("Expected JSON request body");
        body = JSON.parse(init.body) as unknown;
      }
      return ok({ proxies: [proxy()] });
    });
    const controller = new AdminUiController(client, () => undefined);
    await controller.loadProxies();
    controller.setTargetSecret("proxy-1", "target-1", "clear");
    await controller.saveProxies();
    expect(body).toMatchObject({ proxies: [{ targets: [{ apiKey: { action: "clear" } }] }] });
    expect(JSON.stringify(body)).not.toContain("value");
  });

  it("edits and saves the complete proxy and target configuration", async () => {
    let body: unknown;
    const client = new ApiClient((_path, init) => {
      if (init?.method === "PUT") {
        if (typeof init.body !== "string") throw new TypeError("Expected JSON request body");
        body = JSON.parse(init.body) as unknown;
      }
      return ok({ proxies: [proxy()] });
    });
    const controller = new AdminUiController(client, () => undefined);
    await controller.loadProxies();
    controller.updateProxy("proxy-1", { listenHost: "0.0.0.0", listenPort: 9000, accessLog: false });
    controller.updateTarget("proxy-1", "target-1", {
      url: "https://api.example.com",
      headers: [{ name: "x-client", value: "llm-proxy" }],
      stripRequestFields: ["metadata"],
      injectRequestFields: { stream: true },
      timeouts: { connectMs: 2_000, responseHeadersMs: 3_000, idleMs: 4_000 },
      logRoot: "logs/target",
      redactLogs: false,
      modelMappings: [{ listen: "model-a", upstream: "model-b" }],
    });
    await controller.saveProxies();
    expect(body).toMatchObject({
      proxies: [
        {
          listenHost: "0.0.0.0",
          listenPort: 9000,
          accessLog: false,
          targets: [
            {
              url: "https://api.example.com",
              headers: [{ name: "x-client", value: "llm-proxy" }],
              stripRequestFields: ["metadata"],
              injectRequestFields: { stream: true },
              timeouts: { connectMs: 2_000, responseHeadersMs: 3_000, idleMs: 4_000 },
              logRoot: "logs/target",
              redactLogs: false,
              modelMappings: [{ listen: "model-a", upstream: "model-b" }],
            },
          ],
        },
      ],
    });
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

function proxy() {
  return {
    id: "proxy-1",
    name: "Proxy",
    enabled: true,
    listenHost: "127.0.0.1",
    listenPort: 8080,
    accessLog: true,
    defaultTargetId: "target-1",
    targets: [
      {
        id: "target-1",
        name: "Target",
        enabled: true,
        url: "https://example.com",
        apiKey: { configured: true, masked: "...cret" },
        headers: [],
        stripRequestFields: [],
        injectRequestFields: {},
        timeouts: { connectMs: 1_000, responseHeadersMs: 1_000, idleMs: 1_000 },
        logRoot: null,
        redactLogs: true,
        modelMappings: [],
      },
    ],
    runtime: { state: "running", actualListenPort: 8080 },
  };
}
