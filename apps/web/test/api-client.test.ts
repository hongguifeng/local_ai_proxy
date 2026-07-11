import { describe, expect, it } from "vitest";

import { ApiClient } from "../src/api-client.js";
import { LatestRequest } from "../src/request-state.js";

describe("Node admin API client", () => {
  it("uses only /api/v1 paths and maps multi-root task entries", async () => {
    const calls: string[] = [];
    const client = new ApiClient((path) => {
      calls.push(path);
      return Promise.resolve(
        response({
          total: 1,
          limit: 50,
          offset: 0,
          hasMore: false,
          tasks: [{ logRoot: "root-a", task: task() }],
          failures: [],
        }),
      );
    });
    const page = await client.tasks("hello");
    expect(page.tasks).toEqual([{ logRoot: "root-a", task: task() }]);
    expect(calls[0]).toContain("/api/v1/tasks?");
    expect(calls.join(" ")).not.toContain("/api/logs");
    expect(client.exportUrl("root-a")).toBe("/api/v1/tasks/export?logRoot=root-a");
  });

  it("sends explicit JSON mutation contracts", async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    const client = new ApiClient((path, init) => {
      calls.push({ path, ...(init ? { init } : {}) });
      return Promise.resolve(response({ proxies: [] }));
    });
    await client.setProxyEnabled("proxy one", true);
    expect(calls[0]).toMatchObject({
      path: "/api/v1/proxies/proxy%20one/enabled",
      init: { method: "POST", body: '{"enabled":true}' },
    });
  });

  it("aborts stale requests and ignores late results", async () => {
    const latest = new LatestRequest();
    const first = Promise.withResolvers<string>();
    const second = Promise.withResolvers<string>();
    let firstSignal: AbortSignal | undefined;
    const old = latest.run((signal) => {
      firstSignal = signal;
      return first.promise;
    });
    const current = latest.run(() => second.promise);
    expect(firstSignal?.aborted).toBe(true);
    second.resolve("new");
    first.resolve("old");
    await expect(current).resolves.toBe("new");
    await expect(old).resolves.toBeUndefined();
  });
});

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
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
