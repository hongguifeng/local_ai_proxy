import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeConfigSnapshot } from "../src/config/schema.js";
import { ProxyServer } from "../src/proxy/proxy-server.js";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(async (operation) => operation()));
});

describe("ProxyServer target agent pool", () => {
  it("reuses connections per origin, isolates target origins, and destroys agents", async () => {
    const primary = await upstream();
    const mapped = await upstream();
    const proxy = await startProxy(primary.port, mapped.port);
    cleanup.push(() => proxy.stop());
    const port = required(proxy.address).port;
    await request(port, "GET", "/one");
    await request(port, "GET", "/two");
    await request(port, "POST", "/route", '{"model":"mapped"}');
    await request(port, "POST", "/route", '{"model":"mapped"}');
    expect(primary.connections).toBe(1);
    expect(mapped.connections).toBe(1);
    expect(proxy.agentDiagnostics()).toMatchObject({ origins: 2, activeSockets: 0, queuedRequests: 0 });
    await proxy.stop();
    expect(proxy.agentDiagnostics()).toEqual({ origins: 0, activeSockets: 0, freeSockets: 0, queuedRequests: 0 });
  });

  it("bounds concurrent sockets and queues excess requests", async () => {
    let active = 0;
    let maxActive = 0;
    const fixture = await upstream(async (_request, response) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
      response.end("ok");
      active -= 1;
    });
    const proxy = await startProxy(fixture.port, fixture.port, { maxSockets: 2, maxFreeSockets: 1 });
    cleanup.push(() => proxy.stop());
    const port = required(proxy.address).port;
    await Promise.all(Array.from({ length: 10 }, () => request(port, "GET", "/bounded")));
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(fixture.connections).toBeLessThanOrEqual(2);
  });
});

async function startProxy(
  primaryPort: number,
  mappedPort: number,
  agentOptions: { maxSockets: number; maxFreeSockets: number } = { maxSockets: 8, maxFreeSockets: 2 },
): Promise<ProxyServer> {
  const runtime = createRuntimeConfigSnapshot({
    version: 1,
    proxies: [
      {
        id: "proxy-1",
        name: "Proxy",
        enabled: true,
        listenHost: "127.0.0.1",
        listenPort: 1234,
        defaultTargetId: "primary",
        targets: [
          { id: "primary", name: "Primary", url: `http://127.0.0.1:${primaryPort.toString()}` },
          {
            id: "mapped",
            name: "Mapped",
            url: `http://127.0.0.1:${mappedPort.toString()}`,
            modelMappings: [{ listen: "mapped", upstream: "mapped-upstream" }],
          },
        ],
      },
    ],
  }).proxies[0];
  if (!runtime) throw new Error("Expected runtime proxy");
  const proxy = new ProxyServer({
    host: "127.0.0.1",
    port: 0,
    proxy: runtime,
    maxRequestBodyBytes: 1024,
    requestCaptureBytes: 1024,
    responseCaptureBytes: 1024,
    totalRequestTimeoutMs: 5_000,
    agentOptions,
  });
  await proxy.start();
  return proxy;
}

async function upstream(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void | Promise<void> = (
    _request,
    response,
  ) => {
    response.end("ok");
  },
): Promise<{ port: number; connections: number }> {
  const result = { port: 0, connections: 0 };
  const server = http.createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => response.destroy());
  });
  server.on("connection", () => {
    result.connections += 1;
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  result.port = (server.address() as AddressInfo).port;
  cleanup.push(() => closeServer(server));
  return result;
}

function request(port: number, method: string, path: string, body?: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: body === undefined ? {} : { "content-type": "application/json" },
      },
      (response) => {
        response.resume();
        response.on("end", resolvePromise);
      },
    );
    outgoing.on("error", rejectPromise);
    outgoing.end(body);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.closeAllConnections();
    server.close((error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
}

function required<Value>(value: Value | null): Value {
  if (value === null) throw new Error("Expected proxy address");
  return value;
}
