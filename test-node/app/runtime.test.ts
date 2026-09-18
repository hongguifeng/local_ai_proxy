import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createNodeApplication } from "../../src/app/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("createNodeApplication", () => {
  it("starts the admin UI and enabled proxies, then releases both ports", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-proxy-app-"));
    temporaryRoots.push(root);
    const configFile = path.join(root, "proxies.json");
    const configuredProxyPort = await availablePort();
    await writeFile(
      configFile,
      JSON.stringify({
        pairs: [
          {
            id: "enabled",
            name: "Enabled",
            enabled: true,
            listen_host: "127.0.0.1",
            listen_port: configuredProxyPort,
            access_log: false,
            default_target_id: "target",
            targets: [
              {
                id: "target",
                name: "Target",
                enabled: true,
                target_url: "http://127.0.0.1:9",
                target_api_key: "",
                target_headers: [],
                strip_request_fields: "",
                inject_request_fields: "",
                log_root: "logs",
                redact_logs: false,
                model_mappings: [],
              },
            ],
          },
        ],
      }),
    );
    const runtime = createNodeApplication({
      applicationConfigFile: path.join(root, "llm-proxy.json"),
      configFile,
      logRoot: path.join(root, "logs"),
      host: "127.0.0.1",
      port: 0,
    });

    await runtime.application.start();
    await expect(access(path.join(root, "logs", "traffic.db"))).resolves.toBeUndefined();
    const adminPort = runtime.address()?.port;
    expect(adminPort).toBeTypeOf("number");
    const response = await fetch(`http://127.0.0.1:${adminPort}/api/pairs`);
    const body = (await response.json()) as { pairs: { actual_listen_port: number }[] };
    const proxyPort = body.pairs[0]?.actual_listen_port;
    expect(proxyPort).toBeTypeOf("number");

    await runtime.application.stop();
    await expect(fetch(`http://127.0.0.1:${adminPort}/api/health`)).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${proxyPort}/v1/models`)).rejects.toThrow();
  });

  it("exposes the log listing, export, and cleanup admin routes on the assembled application", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-proxy-app-"));
    temporaryRoots.push(root);
    const configFile = path.join(root, "proxies.json");
    await writeFile(configFile, JSON.stringify({ pairs: [] }));
    const runtime = createNodeApplication({
      applicationConfigFile: path.join(root, "llm-proxy.json"),
      configFile,
      logRoot: path.join(root, "logs"),
      host: "127.0.0.1",
      port: 0,
    });
    await runtime.application.start();
    try {
      const adminPort = runtime.address()?.port;
      expect(adminPort).toBeTypeOf("number");

      // Guard against the assembled app silently dropping these routes (404
      // "Route not found."): the admin server only registers cleanup/export
      // when the wired log service actually provides those methods.
      const list = await fetch(`http://127.0.0.1:${adminPort}/api/logs`);
      expect(list.status).toBe(200);

      const pricing = await fetch(
        `http://127.0.0.1:${adminPort}/api/log-groups/missing-group/pricing`,
      );
      expect(pricing.status).toBe(404);
      const pricingBody = (await pricing.json()) as { error?: { code?: string } };
      expect(pricingBody.error?.code).toBe("log_group_not_found");

      const tokenSeries = await fetch(
        `http://127.0.0.1:${adminPort}/api/log-groups/missing-group/pricing/tokens`,
      );
      expect(tokenSeries.status).toBe(404);
      const tokenSeriesBody = (await tokenSeries.json()) as { error?: { code?: string } };
      expect(tokenSeriesBody.error?.code).toBe("log_group_not_found");

      const costSeries = await fetch(
        `http://127.0.0.1:${adminPort}/api/log-groups/missing-group/pricing/costs`,
      );
      expect(costSeries.status).toBe(404);
      const costSeriesBody = (await costSeries.json()) as { error?: { code?: string } };
      expect(costSeriesBody.error?.code).toBe("log_group_not_found");

      const outputTokenSeries = await fetch(
        `http://127.0.0.1:${adminPort}/api/log-groups/missing-group/pricing/output-tokens`,
      );
      expect(outputTokenSeries.status).toBe(404);
      const outputTokenSeriesBody = (await outputTokenSeries.json()) as {
        error?: { code?: string };
      };
      expect(outputTokenSeriesBody.error?.code).toBe("log_group_not_found");

      const exportResponse = await fetch(`http://127.0.0.1:${adminPort}/api/logs/export`);
      expect(exportResponse.status).toBe(200);
      expect(exportResponse.headers.get("content-type")).toBe("application/zip");
      const zipBytes = new Uint8Array(await exportResponse.arrayBuffer());
      expect([zipBytes[0], zipBytes[1]]).toEqual([0x50, 0x4b]);

      const cleanupPayloads = [
        { group_ids: ["missing-group"] },
        { keep_latest: 1 },
        { older_than_days: 30 },
      ];
      for (const payload of cleanupPayloads) {
        const response = await fetch(`http://127.0.0.1:${adminPort}/api/logs/cleanup`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as { deleted_count: number };
        expect(body.deleted_count).toBe(0);
      }
    } finally {
      await runtime.application.stop();
    }
  });

  it("fails cleanly when the admin port is already occupied", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const address = occupied.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address.");
    const root = await mkdtemp(path.join(tmpdir(), "llm-proxy-app-"));
    temporaryRoots.push(root);
    const runtime = createNodeApplication({
      applicationConfigFile: path.join(root, "llm-proxy.json"),
      configFile: path.join(root, "missing.json"),
      logRoot: path.join(root, "logs"),
      host: "127.0.0.1",
      port: address.port,
    });

    await expect(runtime.application.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(runtime.application.state).toBe("stopped");
    await new Promise<void>((resolve, reject) =>
      occupied.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("persists summary model settings when applying the configuration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-proxy-app-"));
    temporaryRoots.push(root);
    const configFile = path.join(root, "proxies.json");
    await writeFile(configFile, JSON.stringify({ pairs: [] }));
    const runtime = createNodeApplication({
      applicationConfigFile: path.join(root, "llm-proxy.json"),
      configFile,
      logRoot: path.join(root, "logs"),
      host: "127.0.0.1",
      port: 0,
    });
    await runtime.application.start();
    const adminPort = runtime.address()?.port;
    const summary = {
      disable_reasoning: true,
      api_type: "openai_chat",
      target_url: "http://127.0.0.1:1235",
      api_key: "secret",
      model: "summarizer",
      target_headers: [],
      timeout_ms: 180000,
    };
    await fetch(`http://127.0.0.1:${adminPort}/api/settings/summary-model`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(summary),
    });
    const persisted = JSON.parse(await readFile(configFile, "utf8")) as {
      summary_model?: Record<string, unknown>;
    };
    expect(persisted.summary_model).toMatchObject(summary);
    await runtime.application.stop();
  });
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address.");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
