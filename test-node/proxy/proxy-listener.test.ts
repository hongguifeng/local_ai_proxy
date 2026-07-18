import http from "node:http";

import { describe, expect, it } from "vitest";

import {
  ProxyListener,
  ProxyRequestPipeline,
  type TrafficLogWriter,
} from "../../src/proxy/index.js";

describe("ProxyListener", () => {
  it("serves requests with a native Node HTTP listener", async () => {
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      onRequest(request, response) {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(`${request.method} ${request.url}`);
      },
    });
    const address = await listener.start();

    expect(await requestText(address.port, "/native-listener")).toEqual({
      status: 200,
      body: "GET /native-listener",
    });
    await listener.close();
  });

  it("assigns each request an ID and start timestamps", async () => {
    let nextId = 0;
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      createId: () => `request-${++nextId}`,
      now: () => "2026-07-18T12:00:00.000+08:00",
      monotonicNow: () => 123.5,
      onRequest(_request, response, context) {
        response.end(JSON.stringify(context));
      },
    });
    const address = await listener.start();

    expect(JSON.parse((await requestText(address.port, "/context")).body)).toEqual({
      id: "request-1",
      startedAt: "2026-07-18T12:00:00.000+08:00",
      startedMonotonicMs: 123.5,
    });
    expect(JSON.parse((await requestText(address.port, "/context")).body)).toMatchObject({
      id: "request-2",
    });
    await listener.close();
  });

  it("logs request_received before reading a single-target request body", async () => {
    const records: Readonly<Record<string, unknown>>[] = [];
    const trafficLog: TrafficLogWriter = {
      write(record) {
        records.push(record);
        return Promise.resolve();
      },
      update() {
        return Promise.resolve();
      },
    };
    const pipeline = new ProxyRequestPipeline({
      pairId: "pair-1",
      pairName: "Single target proxy",
      targets: [
        {
          id: "target-1",
          name: "Single target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: 4321,
          targetBasePath: "/base",
          trafficLog,
        },
      ],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      createId: () => "early-request",
      now: () => "2026-07-18T12:30:00.000+08:00",
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();

    expect((await requestText(address.port, "/v1/responses?stream=1")).status).toBe(501);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "early-request",
      event: "request_received",
      duration_ms: 0,
      proxy: { id: "pair-1", name: "Single target proxy" },
      target: { id: "target-1", path: "/base/v1/responses?stream=1" },
      request: {
        method: "GET",
        path: "/v1/responses?stream=1",
        body_pending: true,
        body: { size_bytes: 0, text: "" },
      },
    });
    await listener.close();
  });
});

function requestText(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.on("error", reject);
  });
}
