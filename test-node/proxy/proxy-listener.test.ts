import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
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
          targetPort: 4327,
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

    await requestText(address.port, "/v1/responses", { method: "POST", body: original });
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
  });

  it("reads an incoming chunked request body", async () => {
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
          id: "chunked-target",
          modelMappings: [],
          name: "Chunked target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: 4325,
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

    await requestText(address.port, "/v1/responses", { method: "POST", chunks });
    expect(pendingRecords[0]).toMatchObject({
      request: {
        headers: { "Transfer-Encoding": ["chunked"] },
        body: { text: chunks.join(""), size_bytes: Buffer.byteLength(chunks.join("")) },
      },
    });
    await listener.close();
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
    const events: string[] = [];
    const trafficLog: TrafficLogWriter = {
      write(record) {
        events.push(String(record["event"]));
        return Promise.resolve();
      },
      update(record) {
        events.push(String(record["event"]));
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
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();

    expect((await requestText(address.port, "/lifecycle")).status).toBe(502);
    expect(events).toEqual(["request_received", "request_pending_response", "request_finished"]);
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

  it("returns 502 when the upstream response times out", async () => {
    const upstream = http.createServer(() => {
      // Intentionally leave the response open until the proxy timeout destroys the socket.
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
          id: "timeout-target",
          modelMappings: [],
          name: "Timeout target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: upstreamPort,
          targetBasePath: "",
          timeoutMs: 50,
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
    const started = performance.now();

    expect(await requestText(address.port, "/timeout")).toEqual({
      status: 502,
      body: "Bad Gateway",
    });
    expect(performance.now() - started).toBeLessThan(1_000);
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
            timeoutMs: 500,
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

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
