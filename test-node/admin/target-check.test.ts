import { afterEach, describe, expect, it } from "vitest";

import { applicationHealth, createAdminServer } from "../../src/admin/index.js";

const servers: ReturnType<typeof createAdminServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe("POST /api/target-check", () => {
  it("does not expose the route when no target check service is configured", async () => {
    const server = createAdminServer({ getHealth: () => applicationHealth("running") });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/target-check",
      payload: { targetUrl: "http://127.0.0.1:9", model: "gpt-5.5" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 400 for a malformed request body", async () => {
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      targetCheckService: {
        checkTarget: () => Promise.resolve({ ok: true, status: 200, durationMs: 1 }),
      },
    });
    servers.push(server);

    const missingModel = await server.inject({
      method: "POST",
      url: "/api/target-check",
      payload: { targetUrl: "http://127.0.0.1:9" },
    });
    expect(missingModel.statusCode).toBe(400);

    const invalidScheme = await server.inject({
      method: "POST",
      url: "/api/target-check",
      payload: { targetUrl: "ftp://example.test", model: "gpt-5.5" },
    });
    expect(invalidScheme.statusCode).toBe(400);

    const invalidApiType = await server.inject({
      method: "POST",
      url: "/api/target-check",
      payload: { targetUrl: "http://127.0.0.1:9", model: "gpt-5.5", apiType: "gemini" },
    });
    expect(invalidApiType.statusCode).toBe(400);
  });

  it("returns 400 when the service reports an invalid target url", async () => {
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      targetCheckService: {
        checkTarget: () => Promise.reject(new TypeError("Invalid URL")),
      },
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/target-check",
      payload: { targetUrl: "http://bad url", model: "gpt-5.5" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("invalid_target_url");
  });

  it("passes through a successful check result", async () => {
    const calls: unknown[] = [];
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      targetCheckService: {
        checkTarget: (request) => {
          calls.push(request);
          return Promise.resolve({ ok: true, status: 200, durationMs: 12 });
        },
      },
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/target-check",
      payload: {
        targetUrl: "http://127.0.0.1:9",
        model: "gpt-5.5",
        apiType: "responses",
        apiKey: "sk-test",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, status: 200, durationMs: 12 });
    expect(calls).toEqual([
      {
        targetUrl: "http://127.0.0.1:9",
        model: "gpt-5.5",
        apiType: "responses",
        apiKey: "sk-test",
      },
    ]);
  });

  it("passes through an error-status check result with the response detail", async () => {
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      targetCheckService: {
        checkTarget: () =>
          Promise.resolve({
            ok: true,
            status: 401,
            durationMs: 12,
            detail: '{"error":{"message":"invalid api key"}}',
          }),
      },
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/target-check",
      payload: { targetUrl: "http://127.0.0.1:9", model: "gpt-5.5" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      status: 401,
      durationMs: 12,
      detail: '{"error":{"message":"invalid api key"}}',
    });
  });

  it("passes through an unreachable-target failure as a 200 response", async () => {
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      targetCheckService: {
        checkTarget: () =>
          Promise.resolve({ ok: false, durationMs: 3, error: "connect ECONNREFUSED" }),
      },
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/target-check",
      payload: { targetUrl: "http://127.0.0.1:9", model: "gpt-5.5" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: false, durationMs: 3, error: "connect ECONNREFUSED" });
  });
});
