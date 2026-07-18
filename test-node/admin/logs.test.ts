import { afterEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";

import { applicationHealth, createAdminServer } from "../../src/admin/index.js";

const servers: ReturnType<typeof createAdminServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe("GET /api/logs", () => {
  it("cleans selected log groups", async () => {
    const calls: unknown[] = [];
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
        cleanupSelectedGroups(groupIds) {
          calls.push(groupIds);
          return { deleted: groupIds, deleted_count: groupIds.length };
        },
      },
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/logs/cleanup",
      payload: { group_ids: ["task-1"] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ deleted: ["task-1"], deleted_count: 1 });
    expect(calls).toEqual([["task-1"]]);
  });

  it("cleans log groups older than a requested number of days", async () => {
    const calls: unknown[] = [];
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
        cleanupOlderThan(days) {
          calls.push(days);
          return { deleted: ["old"], deleted_count: 1 };
        },
      },
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/logs/cleanup",
      payload: { older_than_days: 7 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ deleted: ["old"], deleted_count: 1 });
    expect(calls).toEqual([7]);
  });

  it("streams the ZIP export with download headers", async () => {
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
        exportLogs: () => Readable.from([Buffer.from("zip-stream")]),
      },
    });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/api/logs/export" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/zip");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="llm-proxy-logs.zip"',
    );
    expect(response.rawPayload.toString()).toBe("zip-stream");
  });

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
                total: 1,
                limit: 200,
                has_more: false,
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
