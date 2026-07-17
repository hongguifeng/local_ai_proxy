import { afterEach, describe, expect, it } from "vitest";

import {
  applicationHealth,
  createAdminServer,
  type HealthSnapshot,
} from "../../src/admin/admin-server.js";

const servers: ReturnType<typeof createAdminServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe("admin health route", () => {
  it("returns an OK snapshot for a running application", async () => {
    const server = createAdminServer({
      getHealth: () => applicationHealth("running", "0.1.0-test"),
    });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      applicationState: "running",
      status: "ok",
      version: "0.1.0-test",
    });
  });

  it("returns 503 when a provider reports degraded health", async () => {
    const degraded: HealthSnapshot = {
      applicationState: "running",
      status: "degraded",
      version: "0.1.0-test",
    };
    const server = createAdminServer({ getHealth: () => degraded });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(degraded);
  });
});
