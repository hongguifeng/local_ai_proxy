import { afterEach, describe, expect, it } from "vitest";

import { applicationHealth, createAdminServer } from "../../src/admin/index.js";

const servers: ReturnType<typeof createAdminServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe("POST /api/target-models", () => {
  it("does not expose the route when no target models service is configured", async () => {
    const server = createAdminServer({ getHealth: () => applicationHealth("running") });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/target-models",
      payload: { targetUrl: "http://127.0.0.1:9" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 400 for a malformed request body", async () => {
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      targetModelsService: {
        fetchTargetModels: () => Promise.resolve({ ok: true, models: [], durationMs: 1 }),
      },
    });
    servers.push(server);

    const missingUrl = await server.inject({
      method: "POST",
      url: "/api/target-models",
      payload: {},
    });
    expect(missingUrl.statusCode).toBe(400);

    const invalidScheme = await server.inject({
      method: "POST",
      url: "/api/target-models",
      payload: { targetUrl: "ftp://example.test" },
    });
    expect(invalidScheme.statusCode).toBe(400);

    const oversizedKey = await server.inject({
      method: "POST",
      url: "/api/target-models",
      payload: { targetUrl: "http://127.0.0.1:9", apiKey: "k".repeat(65_537) },
    });
    expect(oversizedKey.statusCode).toBe(400);
  });

  it("returns 400 when the service reports an invalid target url", async () => {
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      targetModelsService: {
        fetchTargetModels: () => Promise.reject(new TypeError("Invalid URL")),
      },
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/target-models",
      payload: { targetUrl: "http://bad url" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("invalid_target_url");
  });

  it("passes the address and key to the service and returns the model ids", async () => {
    const calls: unknown[] = [];
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      targetModelsService: {
        fetchTargetModels: (request) => {
          calls.push(request);
          return Promise.resolve({
            ok: true,
            models: ["deepseek-chat", "deepseek-reasoner"],
            durationMs: 12,
          });
        },
      },
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/target-models",
      payload: { targetUrl: "https://api.deepseek.com/v1", apiKey: "sk-test" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      models: ["deepseek-chat", "deepseek-reasoner"],
      durationMs: 12,
    });
    expect(calls).toEqual([{ targetUrl: "https://api.deepseek.com/v1", apiKey: "sk-test" }]);
  });

  it("passes through a truncated list", async () => {
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      targetModelsService: {
        fetchTargetModels: () =>
          Promise.resolve({ ok: true, models: ["a", "b"], durationMs: 9, truncated: true }),
      },
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/target-models",
      payload: { targetUrl: "http://127.0.0.1:9" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      models: ["a", "b"],
      durationMs: 9,
      truncated: true,
    });
  });

  it("passes through an unreachable address as a 200 failure", async () => {
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      targetModelsService: {
        fetchTargetModels: () =>
          Promise.resolve({ ok: false, models: [], durationMs: 3, error: "connect ECONNREFUSED" }),
      },
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/target-models",
      payload: { targetUrl: "http://127.0.0.1:9" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: false,
      models: [],
      durationMs: 3,
      error: "connect ECONNREFUSED",
    });
  });
});
