import { afterEach, describe, expect, it } from "vitest";

import { applicationHealth, createAdminServer } from "../../src/admin/index.js";

const servers: ReturnType<typeof createAdminServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe("admin schemas and request logging", () => {
  it("validates request bodies, serializes responses, and excludes sensitive request data", async () => {
    const logs: { message: string; context: Readonly<Record<string, unknown>> | undefined }[] = [];
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      logger: {
        info: (message, context) => logs.push({ message, context }),
        warn: (message, context) => logs.push({ message, context }),
      },
    });
    servers.push(server);
    server.post(
      "/api/schema-fixture",
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            required: ["name"],
            properties: { name: { type: "string", minLength: 1 } },
          },
          response: {
            200: {
              type: "object",
              additionalProperties: false,
              required: ["ok"],
              properties: { ok: { type: "boolean" } },
            },
          },
        },
      },
      () => ({ ok: true, internal_secret: "must not serialize" }),
    );

    const invalid = await server.inject({
      method: "POST",
      url: "/api/schema-fixture?api_key=query-secret",
      headers: { authorization: "Bearer header-secret" },
      payload: { api_key: "body-secret" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "FST_ERR_VALIDATION" } });

    const valid = await server.inject({
      method: "POST",
      url: "/api/schema-fixture",
      payload: { name: "fixture" },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual({ ok: true });
    expect(JSON.stringify(logs)).not.toMatch(
      /query-secret|header-secret|body-secret|must not serialize/u,
    );
    const completion = logs.find(({ message }) => message === "Admin request completed");
    expect(completion?.context).toMatchObject({
      method: "POST",
      path: "/api/schema-fixture",
    });
  });
});
