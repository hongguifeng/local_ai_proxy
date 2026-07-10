import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeConfigSnapshot } from "../src/config/schema.js";
import { ProxyServer, type ProxyRequestOutcome } from "../src/proxy/proxy-server.js";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(async (operation) => operation()));
});

describe("ProxyServer cancellation and timeouts", () => {
  it("returns a structured 504 when response headers time out", async () => {
    const outcomes: ProxyRequestOutcome[] = [];
    const { proxy, port } = await setup(
      (_request, response) => {
        setTimeout(() => response.end("late"), 250);
      },
      { responseHeadersMs: 100 },
      { onRequestOutcome: (_context, outcome) => outcomes.push(outcome) },
    );
    cleanup.push(() => proxy.stop());
    const result = await request(port, "/headers-timeout");
    expect(result.status).toBe(504);
    expect(JSON.parse(result.body)).toEqual({
      error: { code: "UPSTREAM_HEADERS_TIMEOUT", message: "Upstream timed out" },
      requestId: "request-fixed",
    });
    expect(outcomes).toEqual([{ kind: "timed_out", code: "UPSTREAM_HEADERS_TIMEOUT" }]);
  });

  it("destroys an started response on idle timeout and records one terminal outcome", async () => {
    const done = Promise.withResolvers<ProxyRequestOutcome>();
    const outcomes: ProxyRequestOutcome[] = [];
    const { proxy, port } = await setup(
      (_request, response) => {
        response.writeHead(200);
        response.write("first");
        setTimeout(() => response.end("late"), 1_300);
      },
      { idleMs: 1_000 },
      {
        onRequestOutcome: (_context, outcome) => {
          outcomes.push(outcome);
          done.resolve(outcome);
        },
      },
    );
    cleanup.push(() => proxy.stop());
    await expect(request(port, "/idle")).rejects.toThrow();
    await done.promise;
    expect(outcomes).toEqual([{ kind: "timed_out", code: "UPSTREAM_IDLE_TIMEOUT" }]);
  });

  it("enforces the total timeout even while response chunks remain active", async () => {
    const done = Promise.withResolvers<ProxyRequestOutcome>();
    const { proxy, port } = await setup(
      (_request, response) => {
        response.writeHead(200);
        const timer = setInterval(() => response.write("tick"), 25);
        response.once("close", () => {
          clearInterval(timer);
        });
      },
      { idleMs: 1_000 },
      {
        totalRequestTimeoutMs: 120,
        onRequestOutcome: (_context, outcome) => {
          done.resolve(outcome);
        },
      },
    );
    cleanup.push(() => proxy.stop());
    await expect(request(port, "/total")).rejects.toThrow();
    await expect(done.promise).resolves.toEqual({ kind: "timed_out", code: "REQUEST_TOTAL_TIMEOUT" });
  });

  it("cancels upstream when the downstream client disconnects", async () => {
    const upstreamClosed = Promise.withResolvers<undefined>();
    const outcome = Promise.withResolvers<ProxyRequestOutcome>();
    const { proxy, port } = await setup(
      (_request, response) => {
        response.writeHead(200);
        response.write("first");
        response.once("close", () => {
          upstreamClosed.resolve(undefined);
        });
      },
      {},
      {
        onRequestOutcome: (_context, value) => {
          outcome.resolve(value);
        },
      },
    );
    cleanup.push(() => proxy.stop());
    await disconnectAfterFirstChunk(port);
    await expect(outcome.promise).resolves.toEqual({ kind: "aborted", code: "DOWNSTREAM_CLOSED" });
    await upstreamClosed.promise;
  });
});

async function setup(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
  timeouts: Partial<{ connectMs: number; responseHeadersMs: number; idleMs: number }>,
  overrides: Partial<ConstructorParameters<typeof ProxyServer>[0]>,
): Promise<{ proxy: ProxyServer; port: number }> {
  const upstream = http.createServer(handler);
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
        targets: [
          {
            id: "target-1",
            name: "Target",
            url: `http://127.0.0.1:${upstreamPort.toString()}`,
            timeouts: { connectMs: 1_000, responseHeadersMs: 1_000, idleMs: 1_000, ...timeouts },
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
    responseCaptureBytes: 1024,
    totalRequestTimeoutMs: 5_000,
    createRequestId: () => "request-fixed",
    ...overrides,
  });
  const address = await proxy.start();
  return { proxy, port: address.port };
}

async function request(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    http
      .get({ host: "127.0.0.1", port, path }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("aborted", () => {
          rejectPromise(new Error("Response aborted"));
        });
        response.on("end", () => {
          resolvePromise({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
        });
      })
      .on("error", rejectPromise);
  });
}

async function disconnectAfterFirstChunk(port: number): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/disconnect" }, (response) => {
      response.once("data", () => {
        request.destroy();
        resolvePromise();
      });
    });
    request.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET") resolvePromise();
      else rejectPromise(error);
    });
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
