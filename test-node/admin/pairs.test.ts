import { afterEach, describe, expect, it } from "vitest";

import { applicationHealth, createAdminServer } from "../../src/admin/index.js";
import { createDefaultProxyPair } from "../../src/config/index.js";

const servers: ReturnType<typeof createAdminServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe("GET /api/pairs", () => {
  it("returns configured pairs with live runtime fields", async () => {
    const pair = {
      ...createDefaultProxyPair(""),
      enabled: true,
      running: true,
      actual_listen_port: 43123,
    };
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      pairService: { listPairs: () => [pair] },
    });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/api/pairs" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ pairs: [pair] });
  });

  it("does not expose the route when no pair service is configured", async () => {
    const server = createAdminServer({ getHealth: () => applicationHealth("running") });
    servers.push(server);
    expect((await server.inject({ method: "GET", url: "/api/pairs" })).statusCode).toBe(404);
  });

  it("replaces the complete pair list and returns committed runtime state", async () => {
    const submitted = { ...createDefaultProxyPair(""), id: "submitted", name: "Submitted" };
    const committed = { ...submitted, running: false, actual_listen_port: null };
    const replacements: unknown[] = [];
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      pairService: {
        listPairs: () => [],
        replacePairs(pairs) {
          replacements.push(pairs);
          return Promise.resolve([committed]);
        },
      },
    });
    servers.push(server);

    const response = await server.inject({
      method: "PUT",
      url: "/api/pairs",
      payload: { pairs: [submitted] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ pairs: [committed] });
    expect(replacements).toEqual([[submitted]]);
  });
});
