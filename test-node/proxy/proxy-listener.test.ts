import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ActiveRequestRegistry,
  openUpstreamResponse,
  ProxyListener,
  ProxyRequestPipeline,
  type TrafficLogWriter,
} from "../../src/proxy/index.js";

describe("ProxyListener", () => {
  it("tracks and aborts active request contexts", () => {
    const registry = new ActiveRequestRegistry();
    const signal = registry.begin({
      id: "active-request",
      startedAt: "2026-07-18T13:00:00.000+08:00",
      startedMonotonicMs: 1,
    });
    expect(registry.size).toBe(1);
    expect(registry.ids()).toEqual(["active-request"]);
    expect(registry.get("active-request")?.context.startedAt).toBe("2026-07-18T13:00:00.000+08:00");

    const reason = new Error("shutdown fixture");
    registry.abortAll(reason);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
    registry.end("active-request");
    expect(registry.size).toBe(0);
  });

  it("propagates registry shutdown aborts to the upstream request", async () => {
    const registry = new ActiveRequestRegistry();
    const signal = registry.begin({
      id: "abort-upstream",
      startedAt: "2026-07-18T13:00:00.000+08:00",
      startedMonotonicMs: 1,
    });
    registry.abortAll(new Error("shutdown"));
    const response = openUpstreamResponse({
      target: {
        targetScheme: "http",
        targetHost: "127.0.0.1",
        targetPort: 9,
      },
      method: "GET",
      path: "/abort",
      headers: [],
      body: new Uint8Array(),
      signal,
    });

    await expect(response).rejects.toMatchObject({ name: "AbortError" });
    registry.end("abort-upstream");
  });

  it("aborts the upstream connection when the downstream client disconnects", async () => {
    let markUpstreamStarted: (() => void) | undefined;
    const upstreamStarted = new Promise<void>((resolve) => {
      markUpstreamStarted = resolve;
    });
    let markUpstreamClosed: (() => void) | undefined;
    const upstreamClosed = new Promise<void>((resolve) => {
      markUpstreamClosed = resolve;
    });
    const upstream = http.createServer((_request, response) => {
      markUpstreamStarted?.();
      response.once("close", () => markUpstreamClosed?.());
    });
    const upstreamPort = await listenServer(upstream);
    let finishRecord: ((record: Readonly<Record<string, unknown>>) => void) | undefined;
    const finalRecord = new Promise<Readonly<Record<string, unknown>>>((resolve) => {
      finishRecord = resolve;
    });
    const trafficLog: TrafficLogWriter = {
      write(record) {
        if (record["event"] === "request_finished") {
          finishRecord?.(record);
        }
        return Promise.resolve();
      },
      update: () => Promise.resolve(),
    };
    const activeRequests = new ActiveRequestRegistry();
    const pipeline = new ProxyRequestPipeline({
      activeRequests,
      targets: [
        {
          enabled: true,
          id: "client-abort-target",
          modelMappings: [],
          name: "Client abort target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: upstreamPort,
          targetBasePath: "",
          trafficLog,
        },
      ],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();
    const client = http.get({ host: "127.0.0.1", port: address.port, path: "/abort-client" });
    client.once("error", () => undefined);

    await upstreamStarted;
    expect(activeRequests.size).toBe(1);
    client.destroy(new Error("client abort fixture"));
    await upstreamClosed;
    await expect(finalRecord).resolves.toMatchObject({
      event: "request_finished",
      response: { status: 502 },
    });
    expect(String((await finalRecord)["error"])).toContain("AbortError:");
    expect(activeRequests.size).toBe(0);
    await listener.close();
    await closeServer(upstream);
  });

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
          enabled: true,
          id: "target-1",
          modelMappings: [],
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

    expect((await requestText(address.port, "/v1/responses?stream=1")).status).toBe(502);
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

  it("selects the multi-target logger only after reading the model body", async () => {
    const firstRecords: Readonly<Record<string, unknown>>[] = [];
    const secondRecords: Readonly<Record<string, unknown>>[] = [];
    const logger = (records: Readonly<Record<string, unknown>>[]): TrafficLogWriter => ({
      write(record) {
        records.push(record);
        return Promise.resolve();
      },
      update() {
        return Promise.resolve();
      },
    });
    const pipeline = new ProxyRequestPipeline({
      defaultTargetId: "default",
      targets: [
        {
          enabled: true,
          id: "default",
          modelMappings: [],
          name: "Default target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: 4321,
          targetBasePath: "",
          trafficLog: logger(firstRecords),
        },
        {
          enabled: true,
          id: "routed",
          modelMappings: [{ listen: "model-alias", upstream: "gpt-upstream" }],
          name: "Routed target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: 4322,
          targetBasePath: "/routed",
          trafficLog: logger(secondRecords),
        },
      ],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();
    const body = JSON.stringify({ model: "model-alias", input: "hello" });

    expect(
      (await requestText(address.port, "/v1/responses", { method: "POST", body })).status,
    ).toBe(502);
    expect(firstRecords).toEqual([]);
    const receivedRecords = secondRecords.filter(
      (record) => record["event"] === "request_received",
    );
    expect(receivedRecords).toHaveLength(1);
    expect(receivedRecords[0]).toMatchObject({
      event: "request_received",
      target: { id: "routed", port: 4322, path: "/routed/v1/responses" },
      request: {
        body_pending: false,
        body: { size_bytes: Buffer.byteLength(body), text: body },
      },
    });
    await listener.close();
  });

  it("routes model requests between two live upstream targets", async () => {
    const defaultPaths: string[] = [];
    const routedPaths: string[] = [];
    const defaultUpstream = http.createServer((request, response) => {
      defaultPaths.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ upstream: "default" }));
    });
    const routedUpstream = http.createServer((request, response) => {
      routedPaths.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ upstream: "routed" }));
    });
    const [defaultPort, routedPort] = await Promise.all([
      listenServer(defaultUpstream),
      listenServer(routedUpstream),
    ]);
    const trafficLog: TrafficLogWriter = {
      write: () => Promise.resolve(),
      update: () => Promise.resolve(),
    };
    const pipeline = new ProxyRequestPipeline({
      defaultTargetId: "default-live",
      targets: [
        {
          enabled: true,
          id: "default-live",
          modelMappings: [],
          name: "Default live target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: defaultPort,
          targetBasePath: "/default-base",
          trafficLog,
        },
        {
          enabled: true,
          id: "routed-live",
          modelMappings: [{ listen: "model-alias", upstream: "model-upstream" }],
          name: "Routed live target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: routedPort,
          targetBasePath: "/routed-base",
          trafficLog,
        },
      ],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();

    try {
      await expect(
        requestText(address.port, "/v1/responses?trace=1", {
          method: "POST",
          body: JSON.stringify({ model: "model-alias", input: "route me" }),
        }),
      ).resolves.toEqual({ status: 200, body: JSON.stringify({ upstream: "routed" }) });
      await expect(
        requestText(address.port, "/v1/responses?trace=2", {
          method: "POST",
          body: JSON.stringify({ model: "unmapped-model", input: "use default" }),
        }),
      ).resolves.toEqual({ status: 200, body: JSON.stringify({ upstream: "default" }) });
      expect(routedPaths).toEqual(["/routed-base/v1/responses?trace=1"]);
      expect(defaultPaths).toEqual(["/default-base/v1/responses?trace=2"]);
    } finally {
      await listener.close();
      await Promise.all([closeServer(defaultUpstream), closeServer(routedUpstream)]);
    }
  });

  it("reads the complete Content-Length request body", async () => {
    const pendingRecords: Readonly<Record<string, unknown>>[] = [];
    const trafficLog: TrafficLogWriter = {
      write() {
        return Promise.resolve();
      },
      update(record) {
        pendingRecords.push(record);
        return Promise.resolve();
      },
    };
    const pipeline = new ProxyRequestPipeline({
      targets: [
        {
          enabled: true,
          id: "content-length-target",
          modelMappings: [],
          name: "Content length target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: 4324,
          targetBasePath: "",
          trafficLog,
        },
      ],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();
    const body = JSON.stringify({ model: "gpt-5", input: "你好 Content-Length" });

    await requestText(address.port, "/v1/responses", { method: "POST", body });
    expect(pendingRecords).toHaveLength(1);
    expect(pendingRecords[0]).toMatchObject({
      request: { body: { size_bytes: Buffer.byteLength(body), text: body } },
    });
    await listener.close();
  });

  it("routes, rewrites, strips, and injects the upstream request body", async () => {
    const pendingRecords: Readonly<Record<string, unknown>>[] = [];
    const upstreamBodies: string[] = [];
    const upstream = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        upstreamBodies.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
      });
    });
    const upstreamPort = await listenServer(upstream);
    const trafficLog: TrafficLogWriter = {
      write() {
        return Promise.resolve();
      },
      update(record) {
        pendingRecords.push(record);
        return Promise.resolve();
      },
    };
    const pipeline = new ProxyRequestPipeline({
      targets: [
        {
          enabled: true,
          id: "transform-target",
          modelMappings: [{ listen: "model-alias", upstream: "gpt-upstream" }],
          name: "Transform target",
          stripRequestFields: new Set(["temperature"]),
          injectRequestFields: { stream: true, top_p: 0.9 },
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: upstreamPort,
          targetBasePath: "",
          trafficLog,
        },
      ],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();
    const original = JSON.stringify({ model: "model-alias", input: "hello", temperature: 1 });

    await expect(
      requestText(address.port, "/v1/responses", { method: "POST", body: original }),
    ).resolves.toEqual({ status: 200, body: '{"ok":true}' });
    expect(upstreamBodies).toEqual([
      JSON.stringify({ model: "gpt-upstream", input: "hello", stream: true, top_p: 0.9 }),
    ]);
    expect(pendingRecords[0]).toMatchObject({
      target: { id: "transform-target" },
      request: {
        body: { text: original },
        upstream_body: {
          text: JSON.stringify({ model: "gpt-upstream", input: "hello", stream: true, top_p: 0.9 }),
        },
        model_route: {
          requested_model: "model-alias",
          upstream_model: "gpt-upstream",
          target_id: "transform-target",
        },
        stripped_fields: ["temperature"],
        injected_fields: ["stream", "top_p"],
      },
    });
    await listener.close();
    await closeServer(upstream);
  });

  it("reads an incoming chunked request body", async () => {
    const pendingRecords: Readonly<Record<string, unknown>>[] = [];
    const upstreamRequests: {
      readonly body: string;
      readonly contentLength: string | undefined;
      readonly transferEncoding: string | undefined;
    }[] = [];
    const upstream = http.createServer((request, response) => {
      const received: Buffer[] = [];
      request.on("data", (chunk: Buffer) => received.push(chunk));
      request.on("end", () => {
        upstreamRequests.push({
          body: Buffer.concat(received).toString("utf8"),
          contentLength: request.headers["content-length"],
          transferEncoding: request.headers["transfer-encoding"],
        });
        response.writeHead(200, { "content-type": "text/plain" });
        response.write("chunked-");
        setImmediate(() => response.end("response"));
      });
    });
    const upstreamPort = await listenServer(upstream);
    const trafficLog: TrafficLogWriter = {
      write() {
        return Promise.resolve();
      },
      update(record) {
        pendingRecords.push(record);
        return Promise.resolve();
      },
    };
    const pipeline = new ProxyRequestPipeline({
      targets: [
        {
          enabled: true,
          id: "chunked-target",
          modelMappings: [],
          name: "Chunked target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: upstreamPort,
          targetBasePath: "",
          trafficLog,
        },
      ],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();
    const chunks = ['{"model":"gpt-5",', '"input":"chunked"}'];

    await expect(
      requestText(address.port, "/v1/responses", { method: "POST", chunks }),
    ).resolves.toEqual({ status: 200, body: "chunked-response" });
    expect(upstreamRequests).toEqual([
      {
        body: chunks.join(""),
        contentLength: String(Buffer.byteLength(chunks.join(""))),
        transferEncoding: undefined,
      },
    ]);
    expect(pendingRecords[0]).toMatchObject({
      request: {
        headers: { "Transfer-Encoding": ["chunked"] },
        body: { text: chunks.join(""), size_bytes: Buffer.byteLength(chunks.join("")) },
      },
    });
    await listener.close();
    await closeServer(upstream);
  });

  it("handles empty request bodies and suppresses HEAD response bytes", async () => {
    const pendingRecords: Readonly<Record<string, unknown>>[] = [];
    const trafficLog: TrafficLogWriter = {
      write() {
        return Promise.resolve();
      },
      update(record) {
        pendingRecords.push(record);
        return Promise.resolve();
      },
    };
    const pipeline = new ProxyRequestPipeline({
      targets: [
        {
          enabled: true,
          id: "empty-target",
          modelMappings: [],
          name: "Empty body target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: 4326,
          targetBasePath: "",
          trafficLog,
        },
      ],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();

    const empty = await requestText(address.port, "/empty");
    const head = await requestText(address.port, "/head", { method: "HEAD" });
    expect(empty.status).toBe(502);
    expect(head).toEqual({ status: 502, body: "" });
    expect(pendingRecords).toHaveLength(2);
    expect(pendingRecords[0]).toMatchObject({ request: { body: { size_bytes: 0, text: "" } } });
    expect(pendingRecords[1]).toMatchObject({
      request: { method: "HEAD", body: { size_bytes: 0, text: "" } },
    });
    await listener.close();
  });

  it("returns 413 when the configured request body limit is exceeded", async () => {
    const trafficLog: TrafficLogWriter = {
      write: () => Promise.resolve(),
      update: () => Promise.resolve(),
    };
    const pipeline = new ProxyRequestPipeline({
      bodyCollector: { memoryThresholdBytes: 4, maxBytes: 8 },
      targets: [
        {
          enabled: true,
          id: "limited-target",
          modelMappings: [],
          name: "Limited target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: 4328,
          targetBasePath: "",
          trafficLog,
        },
      ],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();

    expect(
      await requestText(address.port, "/too-large", { method: "POST", body: "123456789" }),
    ).toEqual({ status: 413, body: "Request body too large." });
    await listener.close();
  });

  it("logs pending and final events around request processing", async () => {
    const records: Readonly<Record<string, unknown>>[] = [];
    const trafficLog: TrafficLogWriter = {
      write(record) {
        records.push(record);
        return Promise.resolve();
      },
      update(record) {
        records.push(record);
        return Promise.resolve();
      },
    };
    const activeRequests = new ActiveRequestRegistry();
    const pipeline = new ProxyRequestPipeline({
      activeRequests,
      targets: [
        {
          enabled: true,
          id: "lifecycle-target",
          modelMappings: [],
          name: "Lifecycle target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: 4323,
          targetBasePath: "",
          trafficLog,
        },
      ],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      monotonicNow: () => 0,
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();

    expect((await requestText(address.port, "/lifecycle")).status).toBe(502);
    expect(records.map((record) => record["event"])).toEqual([
      "request_received",
      "request_pending_response",
      "request_finished",
    ]);
    expect(records.at(-1)?.["duration_ms"]).toEqual(expect.any(Number));
    expect(Number(records.at(-1)?.["duration_ms"])).toBeGreaterThan(0);
    expect(activeRequests.size).toBe(0);
    await listener.close();
  });

  it("forwards requests to an HTTP target", async () => {
    const receivedBodies: string[] = [];
    const upstream = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        receivedBodies.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(201, { "content-type": "text/plain", "x-upstream": "http" });
        response.end(`${request.method} ${request.url}`);
      });
    });
    const upstreamPort = await listenServer(upstream);
    const trafficLog: TrafficLogWriter = {
      write: () => Promise.resolve(),
      update: () => Promise.resolve(),
    };
    const pipeline = new ProxyRequestPipeline({
      targets: [
        {
          enabled: true,
          id: "http-target",
          modelMappings: [],
          name: "HTTP target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: upstreamPort,
          targetBasePath: "/base",
          trafficLog,
        },
      ],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();
    const body = JSON.stringify({ input: "forward over HTTP" });

    expect(
      await requestText(address.port, "/v1/responses?trace=1", { method: "POST", body }),
    ).toEqual({ status: 201, body: "POST /base/v1/responses?trace=1" });
    expect(receivedBodies).toEqual([body]);
    await listener.close();
    await closeServer(upstream);
  });

  it("forwards more than ten concurrent requests without mixing responses", async () => {
    const requestCount = 16;
    let concurrent = 0;
    let maximumConcurrent = 0;
    let releaseAll: (() => void) | undefined;
    const allArrived = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const upstream = http.createServer((request, response) => {
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      if (concurrent === requestCount) {
        releaseAll?.();
      }
      void allArrived.then(() => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(request.url ?? "");
        concurrent -= 1;
      });
    });
    const upstreamPort = await listenServer(upstream);
    const trafficLog: TrafficLogWriter = {
      write: () => Promise.resolve(),
      update: () => Promise.resolve(),
    };
    const pipeline = new ProxyRequestPipeline({
      targets: [
        {
          enabled: true,
          id: "concurrent-target",
          modelMappings: [],
          name: "Concurrent target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: upstreamPort,
          targetBasePath: "",
          trafficLog,
        },
      ],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();

    const results = await Promise.all(
      Array.from({ length: requestCount }, (_, index) =>
        requestText(address.port, `/concurrent/${index}`),
      ),
    );
    expect(maximumConcurrent).toBe(requestCount);
    expect(results).toEqual(
      Array.from({ length: requestCount }, (_, index) => ({
        status: 200,
        body: `/concurrent/${index}`,
      })),
    );
    await listener.close();
    await closeServer(upstream);
  });

  it("forwards requests to an HTTPS target", async () => {
    const fixtureRoot = path.join(process.cwd(), "fixtures", "parity", "tls");
    const upstream = https.createServer(
      {
        key: readFileSync(path.join(fixtureRoot, "test-key.pem")),
        cert: readFileSync(path.join(fixtureRoot, "test-cert.pem")),
      },
      (request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(`secure ${request.url}`);
      },
    );
    const upstreamPort = await listenServer(upstream);
    const trafficLog: TrafficLogWriter = {
      write: () => Promise.resolve(),
      update: () => Promise.resolve(),
    };
    const pipeline = new ProxyRequestPipeline({
      targets: [
        {
          enabled: true,
          id: "https-target",
          modelMappings: [],
          name: "HTTPS target",
          rejectUnauthorized: false,
          targetScheme: "https",
          targetHost: "127.0.0.1",
          targetPort: upstreamPort,
          targetBasePath: "/secure",
          trafficLog,
        },
      ],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();

    expect(await requestText(address.port, "/v1/models")).toEqual({
      status: 200,
      body: "secure /secure/v1/models",
    });
    await listener.close();
    await closeServer(upstream);
  });

  it("filters client headers and applies target overrides and API key", async () => {
    const receivedHeaders: http.IncomingHttpHeaders[] = [];
    const upstream = http.createServer((request, response) => {
      receivedHeaders.push(request.headers);
      response.end("headers received");
    });
    const upstreamPort = await listenServer(upstream);
    const trafficLog: TrafficLogWriter = {
      write: () => Promise.resolve(),
      update: () => Promise.resolve(),
    };
    const pipeline = new ProxyRequestPipeline({
      targets: [
        {
          enabled: true,
          id: "header-target",
          modelMappings: [],
          name: "Header target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: upstreamPort,
          targetBasePath: "",
          targetApiKey: "target-secret",
          targetHeaders: [
            ["X-Client", "target-value"],
            ["X-Override", "configured"],
          ],
          trafficLog,
        },
      ],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();

    await requestText(address.port, "/headers", {
      headers: {
        Authorization: "Bearer client-secret",
        "Proxy-Authorization": "client-proxy-secret",
        "X-Client": "client-value",
      },
    });
    expect(receivedHeaders[0]).toMatchObject({
      authorization: "Bearer target-secret",
      host: `127.0.0.1:${upstreamPort}`,
      "x-client": "target-value",
      "x-override": "configured",
      "x-forwarded-for": "127.0.0.1",
    });
    expect(receivedHeaders[0]).not.toHaveProperty("proxy-authorization");
    await listener.close();
    await closeServer(upstream);
  });

  it("returns 502 for TLS validation and DNS failures", async () => {
    const fixtureRoot = path.join(process.cwd(), "fixtures", "parity", "tls");
    const tlsUpstream = https.createServer(
      {
        key: readFileSync(path.join(fixtureRoot, "test-key.pem")),
        cert: readFileSync(path.join(fixtureRoot, "test-cert.pem")),
      },
      (_request, response) => response.end("untrusted"),
    );
    const tlsPort = await listenServer(tlsUpstream);
    const trafficLog: TrafficLogWriter = {
      write: () => Promise.resolve(),
      update: () => Promise.resolve(),
    };
    for (const target of [
      {
        id: "tls-error",
        targetScheme: "https" as const,
        targetHost: "127.0.0.1",
        targetPort: tlsPort,
      },
      {
        id: "dns-error",
        targetScheme: "http" as const,
        targetHost: "missing-host.invalid",
        targetPort: 80,
      },
    ]) {
      const pipeline = new ProxyRequestPipeline({
        targets: [
          {
            enabled: true,
            id: target.id,
            modelMappings: [],
            name: target.id,
            targetScheme: target.targetScheme,
            targetHost: target.targetHost,
            targetPort: target.targetPort,
            targetBasePath: "",
            trafficLog,
          },
        ],
      });
      const listener = new ProxyListener({
        host: "127.0.0.1",
        port: 0,
        onRequest: (request, response, context) => pipeline.handle(request, response, context),
      });
      const address = await listener.start();
      expect((await requestText(address.port, `/${target.id}`)).status).toBe(502);
      await listener.close();
    }
    await closeServer(tlsUpstream);
  });

  it("preserves the upstream status code and reason phrase", async () => {
    const upstream = http.createServer((_request, response) => {
      response.writeHead(299, "Custom Upstream Status");
      response.end("custom status");
    });
    const upstreamPort = await listenServer(upstream);
    const trafficLog: TrafficLogWriter = {
      write: () => Promise.resolve(),
      update: () => Promise.resolve(),
    };
    const pipeline = new ProxyRequestPipeline({
      targets: [
        {
          enabled: true,
          id: "status-target",
          modelMappings: [],
          name: "Status target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: upstreamPort,
          targetBasePath: "",
          trafficLog,
        },
      ],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();

    expect(await requestStatus(address.port, "/status")).toEqual({
      status: 299,
      statusMessage: "Custom Upstream Status",
    });
    await listener.close();
    await closeServer(upstream);
  });

  it("filters upstream hop-by-hop and Content-Length response headers", async () => {
    const upstream = http.createServer((_request, response) => {
      const body = "filtered headers";
      response.writeHead(200, {
        Connection: "upstream-connection",
        "Keep-Alive": "upstream=1",
        "Proxy-Authenticate": "upstream-secret",
        "Content-Length": Buffer.byteLength(body),
        "X-Visible": "preserved",
      });
      response.end(body);
    });
    const upstreamPort = await listenServer(upstream);
    const trafficLog: TrafficLogWriter = {
      write: () => Promise.resolve(),
      update: () => Promise.resolve(),
    };
    const pipeline = new ProxyRequestPipeline({
      targets: [
        {
          enabled: true,
          id: "response-header-target",
          modelMappings: [],
          name: "Response header target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: upstreamPort,
          targetBasePath: "",
          trafficLog,
        },
      ],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();

    const headers = await requestHeaders(address.port, "/response-headers");
    expect(headers["x-visible"]).toBe("preserved");
    expect(headers["content-length"]).toBeUndefined();
    expect(headers["proxy-authenticate"]).toBeUndefined();
    expect(headers["keep-alive"]).not.toBe("upstream=1");
    expect(headers.connection).toBe("close");
    await listener.close();
    await closeServer(upstream);
  });

  it("preserves duplicate request headers and separate Set-Cookie responses", async () => {
    const upstreamDuplicateHeaders: string[][] = [];
    const upstream = http.createServer((request, response) => {
      const values: string[] = [];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        if (request.rawHeaders[index]?.toLowerCase() === "x-duplicate") {
          const value = request.rawHeaders[index + 1];
          if (value !== undefined) {
            values.push(value);
          }
        }
      }
      upstreamDuplicateHeaders.push(values);
      response.writeHead(200, [
        "Content-Type",
        "text/plain",
        "Set-Cookie",
        "first=1; Path=/",
        "Set-Cookie",
        "second=2; Path=/",
        "X-Duplicate",
        "one",
        "X-Duplicate",
        "two",
      ]);
      response.end("duplicates");
    });
    const upstreamPort = await listenServer(upstream);
    const trafficLog: TrafficLogWriter = {
      write: () => Promise.resolve(),
      update: () => Promise.resolve(),
    };
    const pipeline = new ProxyRequestPipeline({
      targets: [
        {
          enabled: true,
          id: "duplicate-header-target",
          modelMappings: [],
          name: "Duplicate header target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: upstreamPort,
          targetBasePath: "",
          trafficLog,
        },
      ],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();

    const downstream = await requestWithHeaders(address.port, "/duplicates", {
      "x-duplicate": ["first", "second"],
    });
    expect(upstreamDuplicateHeaders).toEqual([["first", "second"]]);
    expect(downstream.headers["set-cookie"]).toEqual(["first=1; Path=/", "second=2; Path=/"]);
    expect(rawHeaderValues(downstream.rawHeaders, "x-duplicate")).toEqual(["one", "two"]);
    await listener.close();
    await closeServer(upstream);
  });

  it("streams a slow two-part SSE response without waiting for completion", async () => {
    const finalRecords: Readonly<Record<string, unknown>>[] = [];
    let releaseSecond: (() => void) | undefined;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"type":"response.output_text.delta","delta":"first"}\n\n');
      void secondGate.then(() => {
        response.end(
          'data: {"type":"response.output_text.delta","delta":"second"}\n\ndata: [DONE]\n\n',
        );
      });
    });
    const upstreamPort = await listenServer(upstream);
    const trafficLog: TrafficLogWriter = {
      write(record) {
        if (record["event"] === "request_finished") {
          finalRecords.push(record);
        }
        return Promise.resolve();
      },
      update: () => Promise.resolve(),
    };
    const pipeline = new ProxyRequestPipeline({
      targets: [
        {
          enabled: true,
          id: "sse-target",
          modelMappings: [],
          name: "SSE target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: upstreamPort,
          targetBasePath: "",
          trafficLog,
        },
      ],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();
    let finishClient: ((body: string) => void) | undefined;
    const clientDone = new Promise<string>((resolve) => {
      finishClient = resolve;
    });
    const firstChunk = new Promise<string>((resolve, reject) => {
      const request = http.get(
        { host: "127.0.0.1", port: address.port, path: "/events" },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
          response.once("end", () => finishClient?.(Buffer.concat(chunks).toString("utf8")));
        },
      );
      request.once("error", reject);
    });

    await expect(firstChunk).resolves.toContain('"delta":"first"');
    releaseSecond?.();
    await expect(clientDone).resolves.toMatch(/"delta":"first"[\s\S]*"delta":"second"/u);
    expect(finalRecords[0]).toMatchObject({
      response: {
        body: {
          stream_summary: {
            content: "firstsecond",
            event_count: 2,
            done_seen: true,
          },
        },
      },
    });
    await listener.close();
    await closeServer(upstream);
  });

  it("streams ordinary response chunks in order", async () => {
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("first-");
      setImmediate(() => response.end("second"));
    });
    const upstreamPort = await listenServer(upstream);
    const trafficLog: TrafficLogWriter = {
      write: () => Promise.resolve(),
      update: () => Promise.resolve(),
    };
    const pipeline = new ProxyRequestPipeline({
      targets: [
        {
          enabled: true,
          id: "chunk-target",
          modelMappings: [],
          name: "Chunk target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: upstreamPort,
          targetBasePath: "",
          trafficLog,
        },
      ],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();

    expect(await requestText(address.port, "/chunks")).toEqual({
      status: 200,
      body: "first-second",
    });
    await listener.close();
    await closeServer(upstream);
  });

  it("continues forwarding after the response log body limit", async () => {
    const body = "complete-response";
    const spoolDirectory = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-pipeline-spool-"));
    let finishRecord: ((record: Readonly<Record<string, unknown>>) => void) | undefined;
    const finalRecord = new Promise<Readonly<Record<string, unknown>>>((resolve) => {
      finishRecord = resolve;
    });
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(body);
    });
    const upstreamPort = await listenServer(upstream);
    const trafficLog: TrafficLogWriter = {
      write(record) {
        if (record["event"] === "request_finished") {
          finishRecord?.(record);
        }
        return Promise.resolve();
      },
      update: () => Promise.resolve(),
    };
    const pipeline = new ProxyRequestPipeline({
      responseCapture: { memoryThresholdBytes: 4, maxBytes: 8, spoolDirectory },
      targets: [
        {
          enabled: true,
          id: "bounded-log-target",
          modelMappings: [],
          name: "Bounded log target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: upstreamPort,
          targetBasePath: "",
          trafficLog,
        },
      ],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();

    try {
      await expect(requestText(address.port, "/large-response")).resolves.toEqual({
        status: 200,
        body,
      });
      await expect(finalRecord).resolves.toMatchObject({
        response: {
          body: {
            text: body.slice(0, 8),
            size_bytes: Buffer.byteLength(body),
            captured_bytes: 8,
            sha256: createHash("sha256").update(body).digest("hex"),
            truncated: true,
            truncation_reason: "log_body_limit",
          },
        },
      });
      expect(await readdir(spoolDirectory)).toEqual([]);
    } finally {
      await listener.close();
      await closeServer(upstream);
      await rm(spoolDirectory, { force: true, recursive: true });
    }
  });

  it("preserves binary request and response bytes", async () => {
    const requestBody = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x41]);
    const responseBody = Buffer.from([0xfe, 0x00, 0x7f, 0x42, 0x81]);
    const upstreamBodies: Buffer[] = [];
    const upstream = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        upstreamBodies.push(Buffer.concat(chunks));
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(responseBody);
      });
    });
    const upstreamPort = await listenServer(upstream);
    let finishRecord: ((record: Readonly<Record<string, unknown>>) => void) | undefined;
    const finalRecord = new Promise<Readonly<Record<string, unknown>>>((resolve) => {
      finishRecord = resolve;
    });
    const trafficLog: TrafficLogWriter = {
      write(record) {
        if (record["event"] === "request_finished") {
          finishRecord?.(record);
        }
        return Promise.resolve();
      },
      update: () => Promise.resolve(),
    };
    const pipeline = new ProxyRequestPipeline({
      targets: [
        {
          enabled: true,
          id: "binary-target",
          modelMappings: [],
          name: "Binary target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: upstreamPort,
          targetBasePath: "",
          trafficLog,
        },
      ],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();

    await expect(requestBinary(address.port, "/binary", requestBody)).resolves.toEqual({
      status: 200,
      body: responseBody,
    });
    expect(upstreamBodies).toEqual([requestBody]);
    await expect(finalRecord).resolves.toMatchObject({
      request: {
        body: { size_bytes: requestBody.byteLength, base64: requestBody.toString("base64") },
      },
      response: {
        body: { size_bytes: responseBody.byteLength, base64: responseBody.toString("base64") },
      },
    });
    await listener.close();
    await closeServer(upstream);
  });

  it("does not send upstream response bytes for HEAD", async () => {
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("body must not reach the client");
    });
    const upstreamPort = await listenServer(upstream);
    const trafficLog: TrafficLogWriter = {
      write: () => Promise.resolve(),
      update: () => Promise.resolve(),
    };
    const pipeline = new ProxyRequestPipeline({
      targets: [
        {
          enabled: true,
          id: "head-target",
          modelMappings: [],
          name: "HEAD target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: upstreamPort,
          targetBasePath: "",
          trafficLog,
        },
      ],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();

    expect(await requestText(address.port, "/head-upstream", { method: "HEAD" })).toEqual({
      status: 200,
      body: "",
    });
    await listener.close();
    await closeServer(upstream);
  });

  it("closes the downstream stream and logs an error after headers were sent", async () => {
    const finalRecords: Readonly<Record<string, unknown>>[] = [];
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.flushHeaders();
      response.write("partial-response");
      setImmediate(() => response.socket?.destroy(new Error("upstream stream fixture")));
    });
    const upstreamPort = await listenServer(upstream);
    const trafficLog: TrafficLogWriter = {
      write(record) {
        if (record["event"] === "request_finished") {
          finalRecords.push(record);
        }
        return Promise.resolve();
      },
      update: () => Promise.resolve(),
    };
    const pipeline = new ProxyRequestPipeline({
      targets: [
        {
          enabled: true,
          id: "broken-stream-target",
          modelMappings: [],
          name: "Broken stream target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: upstreamPort,
          targetBasePath: "",
          trafficLog,
        },
      ],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();

    const downstream = await requestUntilClose(address.port, "/broken-stream");
    expect(downstream.status).toBe(200);
    expect(downstream.closedEarly).toBe(true);
    expect(finalRecords[0]).toMatchObject({
      event: "request_finished",
      response: { status: 200 },
    });
    expect(String(finalRecords[0]?.["error"])).toContain("Error:");
    await listener.close();
    await closeServer(upstream);
  });
});

function requestText(
  port: number,
  path: string,
  options: {
    readonly method?: string;
    readonly body?: string;
    readonly chunks?: readonly string[];
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: {
          ...options.headers,
          ...(options.body === undefined
            ? {}
            : { "content-length": Buffer.byteLength(options.body) }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    if ("chunks" in options && Array.isArray(options.chunks)) {
      for (const chunk of options.chunks) {
        request.write(chunk);
      }
      request.end();
    } else {
      request.end(options.body);
    }
  });
}

function listenServer(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Test upstream did not bind to TCP."));
      } else {
        resolve(address.port);
      }
    });
  });
}

function requestBinary(
  port: number,
  requestPath: string,
  body: Buffer,
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": body.byteLength,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) });
        });
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

function requestStatus(
  port: number,
  requestPath: string,
): Promise<{ status: number; statusMessage: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: requestPath }, (response) => {
      response.resume();
      response.once("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          statusMessage: response.statusMessage ?? "",
        });
      });
    });
    request.once("error", reject);
  });
}

function requestHeaders(port: number, requestPath: string): Promise<http.IncomingHttpHeaders> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: requestPath }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.headers));
    });
    request.once("error", reject);
  });
}

function requestWithHeaders(
  port: number,
  requestPath: string,
  headers: http.OutgoingHttpHeaders,
): Promise<{ headers: http.IncomingHttpHeaders; rawHeaders: string[] }> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: requestPath, headers },
      (response) => {
        response.resume();
        response.once("end", () =>
          resolve({ headers: response.headers, rawHeaders: response.rawHeaders }),
        );
      },
    );
    request.once("error", reject);
  });
}

function rawHeaderValues(rawHeaders: readonly string[], headerName: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === headerName.toLowerCase()) {
      const value = rawHeaders[index + 1];
      if (value !== undefined) {
        values.push(value);
      }
    }
  }
  return values;
}

function requestUntilClose(
  port: number,
  requestPath: string,
): Promise<{ status: number; body: string; closedEarly: boolean }> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: requestPath }, (response) => {
      const chunks: Buffer[] = [];
      let settled = false;
      const finish = (closedEarly: boolean): void => {
        if (!settled) {
          settled = true;
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            closedEarly,
          });
        }
      };
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => finish(false));
      response.once("aborted", () => finish(true));
      response.once("error", () => finish(true));
    });
    request.once("error", reject);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
