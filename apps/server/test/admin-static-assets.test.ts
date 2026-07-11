import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAdminApp } from "../src/admin/app.js";
import { registerStaticAssets } from "../src/admin/static-assets.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("admin static assets", () => {
  it("serves index and assets with safe cache policies and blocks traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "llm-proxy-web-"));
    roots.push(root);
    await writeFile(join(root, "index.html"), "<!doctype html><title>LLM Proxy</title>");
    await writeFile(join(root, "app.1234abcd.js"), "console.log('ok')");
    const app = createAdminApp({
      health: () => ({
        status: "ok",
        storage: "ok",
        storageRestartAttempts: 0,
        proxies: { configured: 0, running: 0, failed: 0 },
      }),
      registerRoutes: async (scope) => registerStaticAssets(scope, root),
    });
    await app.ready();
    const index = await app.inject({ method: "GET", url: "/" });
    const asset = await app.inject({ method: "GET", url: "/app.1234abcd.js" });
    const traversal = await app.inject({ method: "GET", url: "/..%2F..%2Fpackage.json" });
    expect(index.statusCode).toBe(200);
    expect(index.headers["cache-control"]).toBe("no-cache");
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(traversal.statusCode).toBe(404);
    expect(index.headers["content-security-policy"]).toContain("default-src 'self'");
    await app.close();
  });
});
