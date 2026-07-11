import { describe, expect, it } from "vitest";

import { createAdminApp, DEFAULT_ADMIN_HOST } from "../src/admin/app.js";

describe("admin app factory", () => {
  it("returns health through inject with a stable request ID", async () => {
    const app = createAdminApp(
      {
        health: () => ({
          status: "degraded",
          storage: "degraded",
          storageRestartAttempts: 1,
          proxies: { configured: 2, running: 1, failed: 0 },
        }),
      },
      { generateRequestId: () => "admin-request-1" },
    );
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "degraded",
      storage: "degraded",
      storageRestartAttempts: 1,
      proxies: { configured: 2, running: 1, failed: 0 },
    });
    await app.close();
  });

  it("enforces body limits and returns a unified error envelope", async () => {
    const app = createAdminApp(
      {
        health: () => ({
          status: "ok",
          storage: "ok",
          storageRestartAttempts: 0,
          proxies: { configured: 0, running: 0, failed: 0 },
        }),
        registerRoutes: (scope) => {
          scope.post("/api/v1/echo", () => ({ ok: true }));
        },
      },
      { bodyLimit: 8, generateRequestId: () => "admin-request-2" },
    );
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/echo",
      headers: { "content-type": "application/json" },
      payload: { value: "larger than limit" },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({
      error: { code: "INVALID_REQUEST", message: "Request body is too large" },
      requestId: "admin-request-2",
    });
    await app.close();
  });

  it("creates and closes isolated app instances without global state", async () => {
    const dependencies = {
      health: () => ({
        status: "ok" as const,
        storage: "ok" as const,
        storageRestartAttempts: 0,
        proxies: { configured: 0, running: 0, failed: 0 },
      }),
    };
    const first = createAdminApp(dependencies);
    const second = createAdminApp(dependencies);
    await Promise.all([first.ready(), second.ready()]);
    await Promise.all([first.close(), second.close()]);
    expect(DEFAULT_ADMIN_HOST).toBe("127.0.0.1");
  });
});
