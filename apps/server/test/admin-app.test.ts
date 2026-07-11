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

  it("returns 404, 405, content-type and malformed JSON errors with security headers", async () => {
    const app = createAdminApp({
      health: () => ({
        status: "ok",
        storage: "ok",
        storageRestartAttempts: 0,
        proxies: { configured: 0, running: 0, failed: 0 },
      }),
      registerRoutes: (scope) => {
        scope.post("/api/v1/input", () => ({ ok: true }));
      },
    });
    await app.ready();
    const notFound = await app.inject({ method: "GET", url: "/api/v1/missing" });
    const method = await app.inject({ method: "POST", url: "/api/v1/health" });
    const contentType = await app.inject({
      method: "POST",
      url: "/api/v1/input",
      headers: { "content-type": "text/plain" },
      payload: "x",
    });
    const malformed = await app.inject({
      method: "POST",
      url: "/api/v1/input",
      headers: { "content-type": "application/json" },
      payload: "{",
    });
    expect(notFound.statusCode).toBe(404);
    expect(method.statusCode).toBe(405);
    expect(contentType.statusCode).toBe(415);
    expect(malformed.statusCode).toBe(400);
    for (const response of [notFound, method, contentType, malformed]) {
      expect(response.headers).toMatchObject({
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
      });
    }
    await app.close();
  });

  it("does not expose unknown error causes, stacks, paths, or secret headers", async () => {
    const secret = "never-return-this-api-key";
    const app = createAdminApp({
      health: () => ({
        status: "ok",
        storage: "ok",
        storageRestartAttempts: 0,
        proxies: { configured: 0, running: 0, failed: 0 },
      }),
      registerRoutes: (scope) => {
        scope.get("/api/v1/fail", () => {
          throw new Error(`failure at C:\\Users\\secret\\database.db Authorization: Bearer ${secret}`);
        });
      },
    });
    await app.ready();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/fail",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "ADMIN_REQUEST_FAILED", message: "Request failed" } });
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain("database.db");
    expect(response.body).not.toContain("stack");
    await app.close();
  });
});
