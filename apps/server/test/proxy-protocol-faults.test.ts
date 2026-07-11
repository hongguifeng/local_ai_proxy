import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeConfigSnapshot } from "../src/config/schema.js";
import { ProxyServer, type ProxyRequestOutcome } from "../src/proxy/proxy-server.js";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(async (operation) => operation()));
});

describe("ProxyServer protocol fault integration", () => {
  it("contains DNS and TLS handshake failures as structured 502 responses", async () => {
    const plain = http.createServer((_request, response) => response.end("plain"));
    await listen(plain);
    cleanup.push(() => closeHttp(plain));
    for (const url of ["http://missing-host.invalid", `https://127.0.0.1:${portOf(plain).toString()}`]) {
      const proxy = await startProxy(url);
      cleanup.push(() => proxy.stop());
      const result = await request(portOfProxy(proxy), "/fault");
      expect(result.status).toBe(502);
      expect(JSON.parse(result.body)).toMatchObject({ error: { code: "UPSTREAM_UNAVAILABLE" } });
    }
  });

  it("contains malformed status lines and remains usable", async () => {
    const raw = await rawUpstream();
    const outcomes: ProxyRequestOutcome[] = [];
    const proxy = await startProxy(`http://127.0.0.1:${raw.port.toString()}`, {
      onRequestOutcome: (_context, outcome) => outcomes.push(outcome),
    });
    cleanup.push(() => proxy.stop());
    await expect(request(portOfProxy(proxy), "/malformed")).resolves.toMatchObject({ status: 502 });
    await expect(request(portOfProxy(proxy), "/ok")).resolves.toEqual({ status: 200, body: "ok" });
    expect(outcomes).toEqual([
      { kind: "failed", code: "UPSTREAM_UNAVAILABLE" },
      { kind: "finished", code: null },
    ]);
  });

  it("destroys incomplete and invalid chunked responses after headers with one terminal event", async () => {
    const raw = await rawUpstream();
    for (const path of ["/disconnect", "/invalid-chunk"]) {
      const outcomes: ProxyRequestOutcome[] = [];
      const outcomeDone = Promise.withResolvers<ProxyRequestOutcome>();
      const proxy = await startProxy(`http://127.0.0.1:${raw.port.toString()}`, {
        onRequestOutcome: (_context, outcome) => {
          outcomes.push(outcome);
          outcomeDone.resolve(outcome);
        },
      });
      cleanup.push(() => proxy.stop());
      await expect(request(portOfProxy(proxy), path)).rejects.toThrow();
      await outcomeDone.promise;
      expect(outcomes).toEqual([{ kind: "failed", code: "UPSTREAM_BODY_FAILED" }]);
    }
  });

  it("serves concurrent SSE and ordinary responses without cross-request state", async () => {
    const upstream = http.createServer((request, response) => {
      if (request.url?.startsWith("/sse")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${request.url}\n\n`);
        setImmediate(() => response.end("data: done\n\n"));
      } else response.end(request.url);
    });
    await listen(upstream);
    cleanup.push(() => closeHttp(upstream));
    const proxy = await startProxy(`http://127.0.0.1:${portOf(upstream).toString()}`);
    cleanup.push(() => proxy.stop());
    const paths = Array.from({ length: 40 }, (_, index) =>
      index % 2 === 0 ? `/sse-${index.toString()}` : `/json-${index.toString()}`,
    );
    const results = await Promise.all(paths.map(async (path) => request(portOfProxy(proxy), path)));
    for (const [index, result] of results.entries()) expect(result.body).toContain(paths[index]);
  });

  it("releases an active stream during shutdown", async () => {
    const streamClosed = Promise.withResolvers<undefined>();
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200);
      response.write("first");
      response.once("close", () => {
        streamClosed.resolve(undefined);
      });
    });
    await listen(upstream);
    cleanup.push(() => closeHttp(upstream));
    const proxy = await startProxy(`http://127.0.0.1:${portOf(upstream).toString()}`, { shutdownGraceMs: 10 });
    const firstChunk = Promise.withResolvers<undefined>();
    const client = http.get({ host: "127.0.0.1", port: portOfProxy(proxy), path: "/active" }, (response) => {
      response.once("data", () => {
        firstChunk.resolve(undefined);
      });
      response.on("error", () => undefined);
    });
    client.on("error", () => undefined);
    await firstChunk.promise;
    await proxy.stop();
    await streamClosed.promise;
    expect(proxy.agentDiagnostics()).toEqual({ origins: 0, activeSockets: 0, freeSockets: 0, queuedRequests: 0 });
  });
});

async function rawUpstream(): Promise<{ port: number }> {
  const server = net.createServer((socket) => {
    socket.once("data", (data) => {
      const requestLine = data.toString("ascii").split("\r\n", 1)[0] ?? "";
      if (requestLine.includes("/malformed")) socket.end("NOT-HTTP\r\n\r\nbroken");
      else if (requestLine.includes("/disconnect")) {
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc");
        socket.destroy();
      } else if (requestLine.includes("/invalid-chunk")) {
        socket.end("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZZ\r\nbroken\r\n0\r\n\r\n");
      } else socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  cleanup.push(
    () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => {
          if (error) rejectPromise(error);
          else resolvePromise();
        });
      }),
  );
  return { port: (server.address() as AddressInfo).port };
}

async function startProxy(
  targetUrl: string,
  overrides: Partial<ConstructorParameters<typeof ProxyServer>[0]> = {},
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
        defaultTargetId: "target-1",
        targets: [
          {
            id: "target-1",
            name: "Target",
            url: targetUrl,
            timeouts: { connectMs: 500, responseHeadersMs: 1_000, idleMs: 1_000 },
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
    totalRequestTimeoutMs: 2_000,
    ...overrides,
  });
  await proxy.start();
  return proxy;
}

function request(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    http
      .get({ host: "127.0.0.1", port, path }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("aborted", () => {
          rejectPromise(new Error("Response aborted"));
        });
        response.on("error", rejectPromise);
        response.on("end", () => {
          resolvePromise({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
        });
      })
      .on("error", rejectPromise);
  });
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
}

function closeHttp(server: http.Server): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.closeAllConnections();
    server.close((error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
}

function portOf(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}

function portOfProxy(proxy: ProxyServer): number {
  const address = proxy.address;
  if (!address) throw new Error("Expected proxy address");
  return address.port;
}
