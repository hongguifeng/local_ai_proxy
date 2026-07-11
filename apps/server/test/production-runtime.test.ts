import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProductionRuntime } from "../src/production-runtime.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map(async (cleanup) => cleanup()));
});

describe("production runtime composition", () => {
  it("serves admin, proxies traffic, persists records and applies live config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "llm-proxy-production-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const upstream = http.createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ path: request.url, ok: true }));
    });
    await listen(upstream, 0);
    cleanups.push(() => close(upstream));
    const upstreamPort = addressPort(upstream);
    const adminPort = await freePort();
    const proxyPort = await freePort();
    const configFile = join(directory, "proxies.json");
    const logRoot = join(directory, "traffic");
    await writeFile(
      configFile,
      `${JSON.stringify({
        version: 1,
        proxies: [
          {
            id: "proxy-1",
            name: "Proxy 1",
            enabled: true,
            listenHost: "127.0.0.1",
            listenPort: proxyPort,
            accessLog: false,
            defaultTargetId: "target-1",
            targets: [
              {
                id: "target-1",
                name: "Target 1",
                url: `http://127.0.0.1:${upstreamPort.toString()}`,
                logRoot,
              },
            ],
          },
        ],
      })}\n`,
    );
    const runtime = createProductionRuntime({
      host: "127.0.0.1",
      port: adminPort,
      configFile,
      logRoot,
      noBrowser: true,
      allowRemoteAdmin: false,
      adminToken: undefined,
    });
    cleanups.push(() => runtime.stop());
    await runtime.start(new AbortController().signal);

    const proxied = await fetch(`http://127.0.0.1:${proxyPort.toString()}/v1/models?test=1`);
    expect(await proxied.json()).toEqual({ path: "/v1/models?test=1", ok: true });
    await expect(
      fetch(`http://127.0.0.1:${adminPort.toString()}/api/v1/health`).then(async (value) => value.json()),
    ).resolves.toMatchObject({
      status: "ok",
      storage: "ok",
      proxies: { configured: 1, running: 1, failed: 0 },
    });
    await expect(
      fetch(`http://127.0.0.1:${adminPort.toString()}/api/v1/metrics`).then(async (value) => value.json()),
    ).resolves.toMatchObject({
      requests: { completed: 1 },
    });

    await eventually(async () => {
      const page = (await fetch(`http://127.0.0.1:${adminPort.toString()}/api/v1/tasks`).then(async (value) =>
        value.json(),
      )) as { total?: number };
      expect(page.total).toBe(1);
    });

    const listed = (await fetch(`http://127.0.0.1:${adminPort.toString()}/api/v1/proxies`).then(async (value) =>
      value.json(),
    )) as { proxies: unknown[] };
    const disabled = JSON.parse(JSON.stringify(listed)) as {
      proxies: { enabled: boolean; runtime?: unknown; targets: { apiKey: unknown }[] }[];
    };
    const firstProxy = disabled.proxies[0];
    if (!firstProxy) throw new Error("Expected configured proxy");
    firstProxy.enabled = false;
    delete firstProxy.runtime;
    for (const target of firstProxy.targets) target.apiKey = { action: "keep" };
    const replacement = await fetch(`http://127.0.0.1:${adminPort.toString()}/api/v1/proxies`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(disabled),
    });
    expect(replacement.status).toBe(200);
    expect(await fetch(`http://127.0.0.1:${proxyPort.toString()}/`).catch(() => null)).toBeNull();
    expect(await readFile(configFile, "utf8")).toContain('"enabled": false');
  });
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await listen(server, 0);
  const port = addressPort(server);
  await close(server);
  return port;
}

async function listen(server: net.Server, port: number): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
}

async function close(server: net.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
}

function addressPort(server: net.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return address.port;
}

async function eventually(assertion: () => Promise<void>): Promise<void> {
  let error: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (caught) {
      error = caught;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
    }
  }
  throw error;
}
