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
});
