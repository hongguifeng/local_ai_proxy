import { describe, expect, it } from "vitest";

import { createAdminApp } from "../src/admin/app.js";
import { registerProxyRoutes } from "../src/admin/proxy-routes.js";
import { AdminProxyService } from "../src/admin/proxy-service.js";
import { createRuntimeConfigSnapshot } from "../src/config/schema.js";
import { AtomicRuntimeConfig } from "../src/runtime/atomic-config.js";
import { RuntimeManager } from "../src/runtime/runtime-manager.js";

describe("proxy management API", () => {
  it("lists public proxies without returning configured secrets", async () => {
    const { app } = fixture();
    const response = await app.inject({ method: "GET", url: "/api/v1/proxies" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      proxies: [
        {
          id: "proxy-1",
          targets: [{ id: "target-1", apiKey: { configured: true, masked: "...cret" } }],
          runtime: { state: "configured", actualListenPort: null },
        },
      ],
    });
    expect(response.body).not.toContain("original-secret");
    await app.close();
  });

  it("supports explicit keep, replace, and clear secret actions", async () => {
    const { app, coordinator, saved } = fixture();
    const update = proxyUpdate({ action: "keep" });
    await expect(
      app.inject({ method: "PUT", url: "/api/v1/proxies", payload: { proxies: [update] } }),
    ).resolves.toMatchObject({
      statusCode: 200,
    });
    expect(coordinator.snapshot.proxies[0]?.targets[0]?.targetApiKey).toBe("original-secret");

    const target = required(update.targets[0]);
    target.apiKey = { action: "replace", value: "replacement-secret" };
    const replaced = await app.inject({ method: "PUT", url: "/api/v1/proxies", payload: { proxies: [update] } });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.body).not.toContain("replacement-secret");
    expect(coordinator.snapshot.proxies[0]?.targets[0]?.targetApiKey).toBe("replacement-secret");

    target.apiKey = { action: "clear" };
    await app.inject({ method: "PUT", url: "/api/v1/proxies", payload: { proxies: [update] } });
    expect(coordinator.snapshot.proxies[0]?.targets[0]?.targetApiKey).toBe("");
    expect(saved).toHaveLength(2);
    await app.close();
  });

  it("enables a proxy and returns 404/400 through stable envelopes", async () => {
    const { app, coordinator } = fixture();
    const enabled = await app.inject({
      method: "POST",
      url: "/api/v1/proxies/proxy-1/enabled",
      payload: { enabled: false },
    });
    expect(enabled.statusCode).toBe(200);
    expect(coordinator.snapshot.proxies[0]?.enabled).toBe(false);
    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/proxies/missing/enabled",
      payload: { enabled: true },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "PROXY_NOT_FOUND" } });
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/proxies/proxy-1/enabled",
      payload: { enabled: "yes" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: { code: "INVALID_REQUEST", message: "Request validation failed" },
      details: [{ path: ["enabled"], message: "Invalid value" }],
    });
    expect(invalid.body).not.toContain('"yes"');
    await app.close();
  });
});

function fixture() {
  const initial = createRuntimeConfigSnapshot({
    version: 1,
    proxies: [
      {
        id: "proxy-1",
        name: "Proxy",
        enabled: true,
        listenHost: "127.0.0.1",
        listenPort: 1234,
        defaultTargetId: "target-1",
        targets: [{ id: "target-1", name: "Target", url: "http://127.0.0.1:9999", targetApiKey: "original-secret" }],
      },
    ],
  });
  const saved: unknown[] = [];
  const coordinator = new AtomicRuntimeConfig(
    initial,
    {
      save: (value) => {
        saved.push(value);
        return Promise.resolve();
      },
    },
    { prepare: () => Promise.resolve({ commit: () => undefined, rollback: () => Promise.resolve() }) },
  );
  const runtimes = new RuntimeManager(initial.proxies, () => ({
    start: () => Promise.reject(new Error("not used")),
    stop: () => Promise.resolve(),
  }));
  const service = new AdminProxyService(coordinator, runtimes);
  const app = createAdminApp({
    health: () => ({
      status: "ok",
      storage: "ok",
      storageRestartAttempts: 0,
      proxies: { configured: 1, running: 0, failed: 0 },
    }),
    registerRoutes: (scope) => {
      registerProxyRoutes(scope, service);
    },
  });
  return { app, coordinator, saved };
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Expected value");
  return value;
}

function proxyUpdate(apiKey: { action: "keep" } | { action: "clear" } | { action: "replace"; value: string }) {
  return {
    id: "proxy-1",
    name: "Proxy",
    enabled: true,
    listenHost: "127.0.0.1",
    listenPort: 1234,
    accessLog: false,
    defaultTargetId: "target-1",
    targets: [
      {
        id: "target-1",
        name: "Target",
        enabled: true,
        url: "http://127.0.0.1:9999",
        apiKey,
        headers: [],
        stripRequestFields: [],
        injectRequestFields: {},
        timeouts: { connectMs: 10_000, responseHeadersMs: 60_000, idleMs: 600_000 },
        logRoot: null,
        redactLogs: false,
        modelMappings: [],
      },
    ],
  };
}
