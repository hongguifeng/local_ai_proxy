import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeConfigSnapshot } from "../src/config/schema.js";
import type { CaptureTapResult } from "../src/proxy/capture-tap.js";
import { ProxyServer } from "../src/proxy/proxy-server.js";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(async (operation) => operation()));
});

describe("ProxyServer response pipeline", () => {
  it("streams a 100 MiB response byte-for-byte with bounded capture", async () => {
    const size = 100 * 1024 * 1024;
    const chunk = Buffer.alloc(64 * 1024, 0x5a);
    const captured: CaptureTapResult[] = [];
    const capturedDone = Promise.withResolvers<CaptureTapResult>();
    const { proxy, port } = await setup(
      async (_request, response) => {
        response.writeHead(200, { "content-length": size, "content-type": "application/octet-stream" });
        for (let written = 0; written < size; written += chunk.length) {
          if (!response.write(chunk)) await once(response, "drain");
        }
        response.end();
      },
      {
        responseCaptureBytes: 4096,
        onResponseCaptured: (_context, result) => {
          captured.push(result);
          capturedDone.resolve(result);
        },
      },
    );
    cleanup.push(() => proxy.stop());
    const actual = await hashResponse(port, "/large");
    await capturedDone.promise;
    const expectedHash = createHash("sha256");
    for (let written = 0; written < size; written += chunk.length) expectedHash.update(chunk);
    expect(actual).toEqual({ status: 200, bytes: size, hash: expectedHash.digest("hex") });
    expect(captured).toMatchObject([{ observedBytes: size, capturedBytes: 4096, truncated: true }]);
  });

  it("supports chunked, connection-close, gzip, HEAD, 204, and 304 responses", async () => {
    const compressed = gzipSync("compressed payload");
    const { proxy, port } = await setup((request, response) => {
      if (request.url === "/chunked") {
        response.write("one");
        response.end("two");
      } else if (request.url === "/close") {
        response.shouldKeepAlive = false;
        response.end("closed");
      } else if (request.url === "/gzip") {
        response.writeHead(200, { "content-encoding": "gzip", "content-length": compressed.length });
        response.end(compressed);
      } else if (request.url === "/no-content") response.writeHead(204).end();
      else if (request.url === "/not-modified") response.writeHead(304).end();
      else response.end("head-body");
    });
    cleanup.push(() => proxy.stop());
    expect(await bodyResponse(port, "GET", "/chunked")).toMatchObject({ body: Buffer.from("onetwo") });
    expect(await bodyResponse(port, "GET", "/close")).toMatchObject({ body: Buffer.from("closed") });
    expect(await bodyResponse(port, "GET", "/gzip")).toMatchObject({ body: compressed });
    expect(await bodyResponse(port, "HEAD", "/head")).toMatchObject({ status: 200, body: Buffer.alloc(0) });
    expect(await bodyResponse(port, "GET", "/no-content")).toMatchObject({ status: 204, body: Buffer.alloc(0) });
    expect(await bodyResponse(port, "GET", "/not-modified")).toMatchObject({ status: 304, body: Buffer.alloc(0) });
  });

  it("delivers the first SSE event before the upstream response ends and summarizes chunks", async () => {
    let pushes = 0;
    const captured: CaptureTapResult[] = [];
    const { proxy, port } = await setup(
      (_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: first\n\n");
        setTimeout(() => response.end("data: second\n\n"), 150);
      },
      {
        createResponseObserver: () => ({
          push: () => {
            pushes += 1;
          },
          finish: () => ({ pushes }),
        }),
        onResponseCaptured: (_context, result) => captured.push(result),
      },
    );
    cleanup.push(() => proxy.stop());
    const timing = await sseTiming(port);
    expect(timing.firstChunkMs).toBeLessThan(100);
    expect(timing.totalMs).toBeGreaterThanOrEqual(130);
    expect(captured[0]?.summary).toEqual({ pushes });
  });

  it("propagates a slow downstream through stream backpressure", async () => {
    let backpressureSignals = 0;
    const chunk = Buffer.alloc(64 * 1024, 1);
    const { proxy, port } = await setup(async (_request, response) => {
      for (let index = 0; index < 32; index += 1) {
        if (!response.write(chunk)) {
          backpressureSignals += 1;
          await once(response, "drain");
        }
      }
      response.end();
    });
    cleanup.push(() => proxy.stop());
    await slowConsume(port);
    expect(backpressureSignals).toBeGreaterThan(0);
  });
});

async function setup(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void | Promise<void>,
  overrides: Partial<ConstructorParameters<typeof ProxyServer>[0]> = {},
): Promise<{ proxy: ProxyServer; port: number }> {
  const upstream = http.createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => response.destroy());
  });
  await new Promise<void>((resolvePromise) => upstream.listen(0, "127.0.0.1", resolvePromise));
  cleanup.push(() => closeServer(upstream));
  const upstreamPort = (upstream.address() as AddressInfo).port;
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
        targets: [{ id: "target-1", name: "Target", url: `http://127.0.0.1:${upstreamPort.toString()}` }],
      },
    ],
  }).proxies[0];
  if (!runtime) throw new Error("Expected runtime proxy");
  const proxy = new ProxyServer({
    host: "127.0.0.1",
    port: 0,
    proxy: runtime,
    maxRequestBodyBytes: 1024,
    responseCaptureBytes: 1024,
    ...overrides,
  });
  const address = await proxy.start();
  return { proxy, port: address.port };
}

async function hashResponse(port: number, path: string): Promise<{ status: number; bytes: number; hash: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    http
      .get({ host: "127.0.0.1", port, path }, (response) => {
        const hash = createHash("sha256");
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          hash.update(chunk);
        });
        response.on("end", () => {
          resolvePromise({ status: response.statusCode ?? 0, bytes, hash: hash.digest("hex") });
        });
      })
      .on("error", rejectPromise);
  });
}

async function bodyResponse(port: number, method: string, path: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = http.request({ host: "127.0.0.1", port, method, path }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolvePromise({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) });
      });
    });
    request.on("error", rejectPromise);
    request.end();
  });
}

async function sseTiming(port: number): Promise<{ firstChunkMs: number; totalMs: number }> {
  const started = performance.now();
  return new Promise((resolvePromise, rejectPromise) => {
    http
      .get({ host: "127.0.0.1", port, path: "/sse" }, (response) => {
        let firstChunkMs = 0;
        response.once("data", () => {
          firstChunkMs = performance.now() - started;
        });
        response.on("end", () => {
          resolvePromise({ firstChunkMs, totalMs: performance.now() - started });
        });
      })
      .on("error", rejectPromise);
  });
}

async function slowConsume(port: number): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    http
      .get({ host: "127.0.0.1", port, path: "/slow" }, (response) => {
        response.on("data", () => {
          response.pause();
          setTimeout(() => response.resume(), 1);
        });
        response.on("end", resolvePromise);
      })
      .on("error", rejectPromise);
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
