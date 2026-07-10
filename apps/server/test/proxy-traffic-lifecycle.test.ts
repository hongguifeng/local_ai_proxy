import * as http from "node:http";
import type { AddressInfo } from "node:net";

import type { RecordDetail } from "@llm-proxy/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeConfigSnapshot } from "../src/config/schema.js";
import { ProxyServer } from "../src/proxy/proxy-server.js";
import { QueuedTrafficEventSink } from "../src/storage/traffic-event-sink.js";
import type { StorageWriteEvent } from "../src/storage/write-queue.js";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(async (operation) => operation()));
});

describe("ProxyServer traffic lifecycle", () => {
  it("persists accepted through finished with safe bounded payloads and summary counts", async () => {
    const records: RecordDetail[] = [];
    const sink = new QueuedTrafficEventSink({
      enqueue: (event: StorageWriteEvent) => {
        records.push(event.record);
        return { accepted: true, status: "queued" };
      },
    });
    const { proxy, port } = await setup(sink, {
      createResponseObserver: () => ({ push: () => undefined, finish: () => ({ messageCount: 2, tokenCount: 7 }) }),
    });
    cleanup.push(() => proxy.stop());
    const result = await request(port, JSON.stringify({ model: "gpt-5", password: "request-secret" }));
    expect(result).toEqual({ status: 200, body: '{"password":"response-secret"}' });
    expect(records.map((record) => record.event)).toEqual([
      "request_received",
      "request_received",
      "request_received",
      "request_received",
      "request_finished",
    ]);
    const final = records.at(-1);
    expect(final).toMatchObject({
      id: "request-fixed",
      status: 200,
      target: { id: "target-1" },
      messageCount: 2,
      tokenCount: 7,
      request: { headers: { authorization: ["[redacted]"] } },
    });
    expect(JSON.stringify(final)).not.toContain("request-secret");
    expect(JSON.stringify(final)).not.toContain("response-secret");
  });

  it("keeps proxying when traffic storage throws or reports degradation", async () => {
    for (const sink of [
      {
        emit: () => {
          throw new Error("storage failed");
        },
      },
      new QueuedTrafficEventSink({
        enqueue: () => ({ accepted: false, status: "degraded", code: "STORAGE_QUEUE_FULL" }),
      }),
    ]) {
      const { proxy, port } = await setup(sink);
      cleanup.push(() => proxy.stop());
      await expect(request(port, "{}")).resolves.toMatchObject({ status: 200 });
    }
  });
});

async function setup(
  trafficSink: NonNullable<ConstructorParameters<typeof ProxyServer>[0]["trafficSink"]>,
  overrides: Partial<ConstructorParameters<typeof ProxyServer>[0]> = {},
): Promise<{ proxy: ProxyServer; port: number }> {
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"password":"response-secret"}');
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
    requestCaptureBytes: 1024,
    responseCaptureBytes: 1024,
    totalRequestTimeoutMs: 5_000,
    createRequestId: () => "request-fixed",
    trafficSink,
    ...overrides,
  });
  const address = await proxy.start();
  return { proxy, port: address.port };
}

function request(port: number, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/v1/responses",
        headers: { "content-type": "application/json", authorization: "Bearer request-header-secret" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolvePromise({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
        });
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
