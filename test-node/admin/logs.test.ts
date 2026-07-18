import { afterEach, describe, expect, it } from "vitest";

import { applicationHealth, createAdminServer } from "../../src/admin/index.js";

const servers: ReturnType<typeof createAdminServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe("GET /api/logs", () => {
  it("passes search and pagination query values to the log service", async () => {
    const calls: unknown[] = [];
    const page = {
      groups: [],
      total: 2,
      limit: 1,
      offset: 1,
      next_offset: 2,
      has_more: false,
    };
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      logService: {
        listGroups(query, limit, offset) {
          calls.push({ query, limit, offset });
          return page;
        },
      },
    });
    servers.push(server);

    const response = await server.inject({
      method: "GET",
      url: "/api/logs?q=gpt-5&limit=1&offset=1",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(page);
    expect(calls).toEqual([{ query: "gpt-5", limit: 1, offset: 1 }]);
  });

  it("returns task group logs and a JSON 404 for missing groups", async () => {
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      logService: {
        listGroups: () => ({
          groups: [],
          total: 0,
          limit: 100,
          offset: 0,
          next_offset: 0,
          has_more: false,
        }),
        getGroupLogs(groupId, query) {
          return groupId === "known"
            ? {
                id: groupId,
                logs: [
                  {
                    id: "record",
                    timestamp: "",
                    sequence: "1",
                    method: "POST",
                    path: "/",
                    endpoint: query,
                    message_count: null,
                    status: 200,
                    token_count: null,
                    target: "",
                  },
                ],
              }
            : undefined;
        },
      },
    });
    servers.push(server);

    const known = await server.inject({
      method: "GET",
      url: "/api/log-groups/known/logs?q=needle",
    });
    expect(known.statusCode).toBe(200);
    expect(known.json()).toMatchObject({ id: "known", logs: [{ endpoint: "needle" }] });
    const missing = await server.inject({ method: "GET", url: "/api/log-groups/missing/logs" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: { code: "log_group_not_found", message: "Log group not found." },
    });
  });

  it("returns record detail and a JSON 404 for missing records", async () => {
    const detail = {
      id: "known-record",
      pending: false,
      request: { input: "hello" },
      response: { output: "world" },
      request_meta: { method: "POST" },
      response_meta: { status: 200 },
    };
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      logService: {
        listGroups: () => ({
          groups: [],
          total: 0,
          limit: 100,
          offset: 0,
          next_offset: 0,
          has_more: false,
        }),
        getRecordDetail: (recordId) => (recordId === detail.id ? detail : undefined),
      },
    });
    servers.push(server);

    const known = await server.inject({ method: "GET", url: "/api/logs/known-record" });
    expect(known.statusCode).toBe(200);
    expect(known.json()).toEqual(detail);
    const missing = await server.inject({ method: "GET", url: "/api/logs/missing" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: { code: "log_record_not_found", message: "Log record not found." },
    });
  });
});
