import { afterEach, describe, expect, it } from "vitest";

import { applicationHealth, createAdminServer } from "../../src/admin/index.js";
import { conflict, storageError, upstreamError } from "../../src/shared/index.js";

const servers: ReturnType<typeof createAdminServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe("admin error DTO", () => {
  it("uses the same JSON shape for missing routes", async () => {
    const server = createServer();
    const response = await server.inject({ method: "GET", url: "/missing" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "not_found", message: "Route not found." },
    });
  });

  it("preserves safe status, code, and message for public errors", async () => {
    const server = createServer();
    server.get("/bad-request", () => {
      throw Object.assign(new Error("Fixture is invalid."), {
        statusCode: 400,
        code: "invalid_fixture",
      });
    });
    const response = await server.inject({ method: "GET", url: "/bad-request" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: "invalid_fixture", message: "Fixture is invalid." },
    });
  });

  it("does not expose internal exception messages", async () => {
    const server = createServer();
    server.get("/failure", () => {
      throw new Error("database path and secret fixture");
    });
    const response = await server.inject({ method: "GET", url: "/failure" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "internal_error", message: "Internal server error." },
    });
    expect(response.body).not.toContain("secret fixture");
  });

  it("[AI-05] maps a classified error by its code and keeps the status when reworded", async () => {
    const server = createServer();
    server.get("/in-progress", () => {
      throw conflict("A summary is already being generated for this record.");
    });
    server.get("/reworded", () => {
      throw conflict("Different wording of the same in-progress state.");
    });

    const first = await server.inject({ method: "GET", url: "/in-progress" });
    const second = await server.inject({ method: "GET", url: "/reworded" });

    expect(first.statusCode).toBe(409);
    expect(first.json()).toEqual({
      error: {
        code: "conflict",
        message: "A summary is already being generated for this record.",
      },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: "conflict" } });
  });

  it("[AI-05] keeps an unexposed upstream failure generic to the client", async () => {
    const server = createServer();
    server.get("/upstream", () => {
      throw upstreamError("upstream said: sk-live-secret", {
        details: { upstream_status: 401 },
      });
    });

    const response = await server.inject({ method: "GET", url: "/upstream" });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: { code: "upstream_error", message: "Internal server error." },
    });
    expect(response.body).not.toContain("sk-live-secret");
  });

  it("[AI-05] answers a storage failure with 500 and no internal detail", async () => {
    const server = createServer();
    server.get("/storage", () => {
      throw storageError("The task brief could not be saved.", {
        cause: new Error("SQLITE_BUSY while writing C:\\private\\traffic.db"),
        details: { phase: "task_brief_save", task_id: "task-1" },
      });
    });

    const response = await server.inject({ method: "GET", url: "/storage" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "storage_error", message: "Internal server error." },
    });
    expect(response.body).not.toContain("traffic.db");
    expect(response.body).not.toContain("task-1");
  });
});

function createServer(): ReturnType<typeof createAdminServer> {
  const server = createAdminServer({ getHealth: () => applicationHealth("running") });
  servers.push(server);
  return server;
}
