import { afterEach, describe, expect, it } from "vitest";

import { applicationHealth, createAdminServer } from "../../src/admin/index.js";
import { createDefaultProxyPair } from "../../src/config/index.js";
import { ProxyListenConflictError, ProxyPairNotFoundError } from "../../src/proxy/index.js";

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
    const pairService = {
      replacements: [] as unknown[],
      listPairs: () => [],
      replacePairs(pairs: readonly (typeof submitted)[]) {
        this.replacements.push(pairs);
        return Promise.resolve([committed]);
      },
    };
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      pairService,
    });
    servers.push(server);

    const response = await server.inject({
      method: "PUT",
      url: "/api/pairs",
      payload: { pairs: [submitted] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ pairs: [committed] });
    expect(pairService.replacements).toEqual([[submitted]]);
  });

  it("enables or disables one pair by ID", async () => {
    const pair = {
      ...createDefaultProxyPair(""),
      enabled: true,
      running: true,
      actual_listen_port: 43210,
    };
    const changes: unknown[] = [];
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      pairService: {
        listPairs: () => [pair],
        setPairEnabled(pairId, enabled) {
          changes.push({ pairId, enabled });
          return Promise.resolve(pair);
        },
      },
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: `/api/pairs/${pair.id}/enabled`,
      payload: { enabled: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ pair });
    expect(changes).toEqual([{ pairId: pair.id, enabled: true }]);
  });

  it("returns 400 for invalid request DTOs", async () => {
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      pairService: {
        listPairs: () => [],
        replacePairs: () => Promise.resolve([]),
        setPairEnabled: () => Promise.reject(new Error("must not run")),
      },
    });
    servers.push(server);

    const replaceResponse = await server.inject({
      method: "PUT",
      url: "/api/pairs",
      payload: { pairs: "invalid" },
    });
    expect(replaceResponse.statusCode).toBe(400);
    expect(replaceResponse.json()).toMatchObject({ error: { code: "FST_ERR_VALIDATION" } });
    const enableResponse = await server.inject({
      method: "POST",
      url: "/api/pairs/missing/enabled",
      payload: {},
    });
    expect(enableResponse.statusCode).toBe(400);
  });

  it("returns 404 for an unknown pair and 409 for a listen conflict", async () => {
    const first = { ...createDefaultProxyPair(""), id: "first", enabled: true };
    const conflict = { ...createDefaultProxyPair(""), id: "conflict", enabled: true };
    let conflictMode = false;
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      pairService: {
        listPairs: () => [],
        replacePairs: () =>
          conflictMode
            ? Promise.reject(new ProxyListenConflictError(conflict, first))
            : Promise.resolve([]),
        setPairEnabled: (pairId) => Promise.reject(new ProxyPairNotFoundError(pairId)),
      },
    });
    servers.push(server);

    const missing = await server.inject({
      method: "POST",
      url: "/api/pairs/unknown/enabled",
      payload: { enabled: true },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: { code: "pair_not_found", message: "Proxy pair not found: unknown" },
    });

    conflictMode = true;
    const occupied = await server.inject({
      method: "PUT",
      url: "/api/pairs",
      payload: { pairs: [first, conflict] },
    });
    expect(occupied.statusCode).toBe(409);
    expect(occupied.json()).toMatchObject({ error: { code: "listen_conflict" } });
  });
});
