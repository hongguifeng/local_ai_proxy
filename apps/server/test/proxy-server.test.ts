import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

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
      upstream: new URL(`http://127.0.0.1:${upstream.port.toString()}`),
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
      upstream: new URL(`http://127.0.0.1:${upstream.port.toString()}`),
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
    const proxy = new ProxyServer({ host: "127.0.0.1", port: 0, upstream: new URL("http://127.0.0.1:1") });
    cleanup.push(() => proxy.stop());
    const address = await proxy.start();
    expect(await request(address.port, "GET", "/")).toEqual({ status: 502, body: '{"error":"upstream_unavailable"}' });
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

async function request(
  port: number,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const outgoing = http.request({ host: "127.0.0.1", port, method, path }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolvePromise({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
      });
    });
    outgoing.on("error", rejectPromise);
    outgoing.end(body);
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
