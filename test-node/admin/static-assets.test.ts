import { afterEach, describe, expect, it } from "vitest";

import { applicationHealth, createAdminServer } from "../../src/admin/index.js";

const servers: ReturnType<typeof createAdminServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe("admin static assets", () => {
  it.each([
    ["/", "<!doctype html><title>fixture</title>", "text/html; charset=utf-8", "no-store"],
    ["/app.css", "body { color: red; }", "text/css; charset=utf-8", "no-cache"],
    [
      "/app.js",
      'document.body.dataset.ready = "yes";',
      "application/javascript; charset=utf-8",
      "no-cache",
    ],
  ])("serves %s with its content type and cache policy", async (url, body, contentType, cache) => {
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      staticAssets: {
        indexHtml: "<!doctype html><title>fixture</title>",
        appCss: "body { color: red; }",
        appJs: 'document.body.dataset.ready = "yes";',
      },
    });
    servers.push(server);

    const response = await server.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(body);
    expect(response.headers["content-type"]).toBe(contentType);
    expect(response.headers["cache-control"]).toBe(cache);
  });

  it("does not register placeholder UI routes without an asset bundle", async () => {
    const server = createAdminServer({ getHealth: () => applicationHealth("running") });
    servers.push(server);
    expect((await server.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
  });
});
