import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";

import { checkTarget } from "../../src/proxy/index.js";

const servers: Server[] = [];

function listen(port?: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((_request, response) => {
      response.writeHead(500);
      response.end("nope");
    });
    server.once("error", reject);
    server.listen(port ?? 0, "127.0.0.1", () => {
      servers.push(server);
      resolve(server);
    });
  });
}

function urlFor(server: Server, path = ""): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;
}

function createRecordingServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const instance = createServer(handler);
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => {
      servers.push(instance);
      resolve(instance);
    });
  });
}

afterAll(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

describe("checkTarget", () => {
  it("reports success with status and duration for a responding endpoint", async () => {
    const server = await createRecordingServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        const parsed: unknown = JSON.parse(body);
        expect(request.url).toBe("/v1/chat/completions");
        expect(request.headers.authorization).toBe("Bearer test-key");
        expect(parsed).toEqual({
          model: "gpt-5.5",
          messages: [{ role: "user", content: "ping" }],
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
    });

    const result = await checkTarget({
      targetUrl: urlFor(server, "/v1"),
      model: "gpt-5.5",
      apiKey: "test-key",
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.error).toBeUndefined();
    expect(result.detail).toBe('{"ok":true}');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("sends an OpenAI Responses request when apiType is responses", async () => {
    const server = await createRecordingServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        const parsed: unknown = JSON.parse(body);
        expect(request.url).toBe("/responses");
        expect(request.headers.authorization).toBe("Bearer test-key");
        expect(parsed).toEqual({ model: "gpt-5.5", input: "ping" });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
    });

    const result = await checkTarget({
      targetUrl: urlFor(server),
      model: "gpt-5.5",
      apiType: "responses",
      apiKey: "test-key",
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it("sends an Anthropic Messages request when apiType is anthropic", async () => {
    const server = await createRecordingServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        const parsed: unknown = JSON.parse(body);
        expect(request.url).toBe("/messages");
        expect(request.headers["x-api-key"]).toBe("claude-key");
        expect(request.headers["anthropic-version"]).toBe("2023-06-01");
        expect(request.headers.authorization).toBeUndefined();
        expect(parsed).toEqual({
          model: "claude-opus-4-6",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
    });

    const result = await checkTarget({
      targetUrl: urlFor(server),
      model: "claude-opus-4-6",
      apiType: "anthropic",
      apiKey: "claude-key",
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it("reports a non-2xx response as ok with the upstream status", async () => {
    const server = await new Promise<Server>((resolve, reject) => {
      const instance = createServer((_request, response) => {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "invalid api key" } }));
      });
      instance.once("error", reject);
      instance.listen(0, "127.0.0.1", () => {
        servers.push(instance);
        resolve(instance);
      });
    });

    const result = await checkTarget({
      targetUrl: urlFor(server),
      model: "gpt-5.5",
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(401);
    expect(result.detail).toContain("invalid api key");
  });

  it("reports failure when the endpoint refuses connections", async () => {
    const server = await listen(0);
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const closedIndex = servers.indexOf(server);
    if (closedIndex >= 0) servers.splice(closedIndex, 1);

    const result = await checkTarget({
      targetUrl: `http://127.0.0.1:${port}`,
      model: "gpt-5.5",
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBeUndefined();
    expect(result.error).toBeTruthy();
  });

  it("reports a timeout as failure", async () => {
    const server = await new Promise<Server>((resolve, reject) => {
      const instance = createServer((_request, response) => {
        response.writeHead(200);
        setTimeout(() => response.end("late"), 2_000);
      });
      instance.once("error", reject);
      instance.listen(0, "127.0.0.1", () => {
        servers.push(instance);
        resolve(instance);
      });
    });

    const result = await checkTarget({
      targetUrl: urlFor(server),
      model: "gpt-5.5",
      timeoutMs: 200,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timeout");
  });

  it("throws TypeError for an invalid target url", async () => {
    await expect(checkTarget({ targetUrl: "not a url", model: "gpt-5.5" })).rejects.toThrow(
      TypeError,
    );
  });
});
