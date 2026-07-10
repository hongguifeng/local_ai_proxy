import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeConfigSnapshot } from "../src/config/schema.js";
import { ProxyServer, type ProxyRequestContext } from "../src/proxy/proxy-server.js";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(async (operation) => operation()));
});

describe("ProxyServer", () => {
  it("forwards GET, POST, and HEAD with the original path and query", async () => {
    const upstream = await fixtureUpstream();
    const contexts: ProxyRequestContext[] = [];
    const proxy = new ProxyServer({
      host: "127.0.0.1",
      port: 0,
      proxy: runtimeProxy(`http://127.0.0.1:${upstream.port.toString()}`),
      maxRequestBodyBytes: 1024,
      requestCaptureBytes: 1024,
      responseCaptureBytes: 1024,
      totalRequestTimeoutMs: 30_000,
      createRequestId: () => `request-${(contexts.length + 1).toString()}`,
      onRequest: (context) => contexts.push(context),
    });
    cleanup.push(() => proxy.stop());
    const address = await proxy.start();
    expect(await request(address.port, "GET", "/hello?value=1")).toMatchObject({
      status: 200,
      body: "GET /hello?value=1 ",
    });
    expect(await request(address.port, "POST", "/submit", "payload")).toMatchObject({
      status: 200,
      body: "POST /submit payload",
    });
    expect(await request(address.port, "HEAD", "/head")).toMatchObject({ status: 200, body: "" });
    expect(contexts).toMatchObject([
      { requestId: "request-1", method: "GET", path: "/hello?value=1" },
      { requestId: "request-2", method: "POST", path: "/submit" },
      { requestId: "request-3", method: "HEAD", path: "/head" },
    ]);
  });

  it("rejects CONNECT and upgrade without reaching upstream", async () => {
    const upstream = await fixtureUpstream();
    const proxy = new ProxyServer({
      host: "127.0.0.1",
      port: 0,
      proxy: runtimeProxy(`http://127.0.0.1:${upstream.port.toString()}`),
      maxRequestBodyBytes: 1024,
      requestCaptureBytes: 1024,
      responseCaptureBytes: 1024,
      totalRequestTimeoutMs: 30_000,
    });
    cleanup.push(() => proxy.stop());
    const address = await proxy.start();
    expect(await raw(address.port, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n")).toContain(
      "405 Method Not Allowed",
    );
    expect(
      await raw(address.port, "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"),
    ).toContain("426 Upgrade Required");
  });

  it("returns a bounded 502 when upstream connection fails", async () => {
    const proxy = new ProxyServer({
      host: "127.0.0.1",
      port: 0,
      proxy: runtimeProxy("http://127.0.0.1:1"),
      maxRequestBodyBytes: 1024,
      requestCaptureBytes: 1024,
      responseCaptureBytes: 1024,
      totalRequestTimeoutMs: 30_000,
    });
    cleanup.push(() => proxy.stop());
    const address = await proxy.start();
    const result = await request(address.port, "GET", "/");
    expect(result.status).toBe(502);
    expect(JSON.parse(result.body)).toMatchObject({
      error: { code: "UPSTREAM_UNAVAILABLE", message: "Upstream unavailable" },
    });
  });

  it("routes and transforms supported JSON then fixes framing headers", async () => {
    const primary = await jsonUpstream("primary");
    const mapped = await jsonUpstream("mapped");
    const proxy = new ProxyServer({
      host: "127.0.0.1",
      port: 0,
      proxy: runtimeProxy(`http://127.0.0.1:${primary.port.toString()}/base`, [
        {
          id: "target-2",
          name: "Mapped",
          enabled: true,
          url: `http://127.0.0.1:${mapped.port.toString()}/api`,
          modelMappings: [{ listen: "demo", upstream: "upstream-model" }],
          stripRequestFields: ["secret"],
          injectRequestFields: { added: true },
        },
      ]),
      maxRequestBodyBytes: 1024,
      requestCaptureBytes: 1024,
      responseCaptureBytes: 1024,
      totalRequestTimeoutMs: 30_000,
    });
    cleanup.push(() => proxy.stop());
    const address = await proxy.start();
    const result = await requestChunks(address.port, "/v1/responses?stream=true", [
      '{"model":"demo",',
      '"secret":"remove","input":"hello"}',
    ]);
    const echoed = JSON.parse(result.body) as {
      label: string;
      url: string;
      body: Record<string, unknown>;
      contentLength: string;
      transferEncoding: string | null;
    };
    expect(echoed).toMatchObject({
      label: "mapped",
      url: "/api/v1/responses?stream=true",
      body: { model: "upstream-model", input: "hello", added: true },
      transferEncoding: null,
    });
    expect(Number(echoed.contentLength)).toBeGreaterThan(0);
    expect(echoed.body).not.toHaveProperty("secret");
  });

  it("rejects declared and chunked JSON over the limit but streams non-JSON", async () => {
    const upstream = await fixtureUpstream();
    const proxy = new ProxyServer({
      host: "127.0.0.1",
      port: 0,
      proxy: runtimeProxy(`http://127.0.0.1:${upstream.port.toString()}`),
      maxRequestBodyBytes: 10,
      requestCaptureBytes: 10,
      responseCaptureBytes: 1024,
      totalRequestTimeoutMs: 30_000,
    });
    cleanup.push(() => proxy.stop());
    const address = await proxy.start();
    await expect(request(address.port, "POST", "/", "12345678901", "application/json")).resolves.toMatchObject({
      status: 413,
    });
    await expect(requestChunks(address.port, "/", ["123456", "78901"])).resolves.toMatchObject({ status: 413 });
    await expect(
      request(address.port, "POST", "/binary", "12345678901", "application/octet-stream"),
    ).resolves.toMatchObject({ status: 200, body: "POST /binary 12345678901" });
  });

  it("preserves invalid JSON and encoded bodies byte-for-byte on the default target", async () => {
    const upstream = await fixtureUpstream();
    const proxy = new ProxyServer({
      host: "127.0.0.1",
      port: 0,
      proxy: runtimeProxy(`http://127.0.0.1:${upstream.port.toString()}`),
      maxRequestBodyBytes: 1024,
      requestCaptureBytes: 1024,
      responseCaptureBytes: 1024,
      totalRequestTimeoutMs: 30_000,
    });
    cleanup.push(() => proxy.stop());
    const address = await proxy.start();
    expect(await request(address.port, "POST", "/invalid", "{bad", "application/json")).toMatchObject({
      body: "POST /invalid {bad",
    });
    expect(await request(address.port, "POST", "/encoded", "opaque", "application/json", "gzip")).toMatchObject({
      body: "POST /encoded opaque",
    });
  });

  it("survives a client disconnect while reading a buffered body", async () => {
    const upstream = await fixtureUpstream();
    const proxy = new ProxyServer({
      host: "127.0.0.1",
      port: 0,
      proxy: runtimeProxy(`http://127.0.0.1:${upstream.port.toString()}`),
      maxRequestBodyBytes: 1024,
      requestCaptureBytes: 1024,
      responseCaptureBytes: 1024,
      totalRequestTimeoutMs: 30_000,
    });
    cleanup.push(() => proxy.stop());
    const address = await proxy.start();
    await abortBody(address.port);
    await expect(request(address.port, "GET", "/after-abort")).resolves.toMatchObject({ status: 200 });
  });

  it("applies request header precedence and preserves filtered repeated response headers", async () => {
    const upstream = await jsonUpstream("headers");
    const proxy = new ProxyServer({
      host: "127.0.0.1",
      port: 0,
      proxy: runtimeProxy(`http://127.0.0.1:${upstream.port.toString()}`, [], {
        targetApiKey: "secret-key",
        headers: [
          { name: "X-Multi", value: "configured-one" },
          { name: "X-Multi", value: "configured-two" },
        ],
      }),
      maxRequestBodyBytes: 1024,
      requestCaptureBytes: 1024,
      responseCaptureBytes: 1024,
      totalRequestTimeoutMs: 30_000,
    });
    cleanup.push(() => proxy.stop());
    const address = await proxy.start();
    const result = await requestRaw(address.port, [
      "Host",
      "client.example",
      "Connection",
      "keep-alive, X-Remove",
      "X-Remove",
      "private",
      "X-Forwarded-For",
      "spoofed",
      "Authorization",
      "Bearer client",
      "X-Multi",
      "client-one",
      "X-Multi",
      "client-two",
    ]);
    const echoed = JSON.parse(result.body) as { rawHeaders: string[] };
    const incoming = rawHeaderMap(echoed.rawHeaders);
    expect(incoming.get("host")).toEqual([`127.0.0.1:${upstream.port.toString()}`]);
    expect(incoming.get("authorization")).toEqual(["Bearer secret-key"]);
    expect(incoming.get("x-multi")).toEqual(["configured-one", "configured-two"]);
    expect(incoming.get("x-forwarded-for")).toEqual(["127.0.0.1"]);
    expect(incoming.get("x-forwarded-host")).toEqual(["client.example"]);
    expect(incoming.has("x-remove")).toBe(false);
    const returned = rawHeaderMap(result.rawHeaders);
    expect(returned.get("set-cookie")).toEqual(["a=1", "b=2"]);
    expect(returned.has("x-response-private")).toBe(false);
  });
});

async function fixtureUpstream(): Promise<AddressInfo> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = `${request.method ?? ""} ${request.url ?? ""} ${Buffer.concat(chunks).toString("utf8")}`;
      response.writeHead(200, { "content-type": "text/plain", "content-length": Buffer.byteLength(body) });
      response.end(body);
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  cleanup.push(
    () =>
      new Promise<void>((resolvePromise, rejectPromise) =>
        server.close((error) => {
          if (error) rejectPromise(error);
          else resolvePromise();
        }),
      ),
  );
  return server.address() as AddressInfo;
}

async function jsonUpstream(label: string): Promise<AddressInfo> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      response.setHeader("set-cookie", ["a=1", "b=2"]);
      response.setHeader("connection", "X-Response-Private");
      response.setHeader("x-response-private", "remove");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          label,
          url: request.url,
          body: rawBody ? (JSON.parse(rawBody) as unknown) : null,
          contentLength: request.headers["content-length"] ?? null,
          transferEncoding: request.headers["transfer-encoding"] ?? null,
          rawHeaders: request.rawHeaders,
        }),
      );
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  cleanup.push(() => closeServer(server));
  return server.address() as AddressInfo;
}

async function request(
  port: number,
  method: string,
  path: string,
  body?: string,
  contentType?: string,
  contentEncoding?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          ...(contentType ? { "content-type": contentType } : {}),
          ...(contentEncoding ? { "content-encoding": contentEncoding } : {}),
        },
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

async function requestChunks(
  port: number,
  path: string,
  chunks: readonly string[],
): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const outgoing = http.request(
      { host: "127.0.0.1", port, method: "POST", path, headers: { "content-type": "application/json" } },
      (response) => {
        const responseChunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => responseChunks.push(chunk));
        response.on("end", () => {
          resolvePromise({ status: response.statusCode ?? 0, body: Buffer.concat(responseChunks).toString() });
        });
      },
    );
    outgoing.on("error", rejectPromise);
    for (const chunk of chunks) outgoing.write(chunk);
    outgoing.end();
  });
}

async function requestRaw(
  port: number,
  headers: string[],
): Promise<{ status: number; body: string; rawHeaders: string[] }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const outgoing = http.request({ host: "127.0.0.1", port, method: "GET", path: "/headers", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolvePromise({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString(),
          rawHeaders: response.rawHeaders,
        });
      });
    });
    outgoing.on("error", rejectPromise);
    outgoing.end();
  });
}

async function raw(port: number, requestText: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.end(requestText);
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    socket.on("end", () => {
      resolvePromise(Buffer.concat(chunks).toString("ascii"));
    });
    socket.on("error", rejectPromise);
  });
}

async function abortBody(port: number): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        "POST /abort HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{",
      );
      socket.destroy();
      resolvePromise();
    });
    socket.on("error", rejectPromise);
  });
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
}

function runtimeProxy(
  url: string,
  additionalTargets: readonly Record<string, unknown>[] = [],
  defaultOverrides: Readonly<Record<string, unknown>> = {},
) {
  return (
    createRuntimeConfigSnapshot({
      version: 1,
      proxies: [
        {
          id: "proxy-1",
          name: "Proxy",
          enabled: true,
          listenHost: "127.0.0.1",
          listenPort: 1234,
          accessLog: false,
          defaultTargetId: "target-1",
          targets: [{ id: "target-1", name: "Target", enabled: true, url, ...defaultOverrides }, ...additionalTargets],
        },
      ],
    }).proxies[0] ?? fail("Expected runtime proxy")
  );
}

function rawHeaderMap(rawHeaders: readonly string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]?.toLowerCase() ?? fail("Missing header name");
    const value = rawHeaders[index + 1] ?? fail("Missing header value");
    const values = result.get(name) ?? [];
    values.push(value);
    result.set(name, values);
  }
  return result;
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
}

function fail(message: string): never {
  throw new Error(message);
}
