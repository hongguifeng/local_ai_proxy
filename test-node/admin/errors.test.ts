import { afterEach, describe, expect, it } from "vitest";

import { applicationHealth, createAdminServer } from "../../src/admin/index.js";

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
});

function createServer(): ReturnType<typeof createAdminServer> {
  const server = createAdminServer({ getHealth: () => applicationHealth("running") });
  servers.push(server);
  return server;
}
