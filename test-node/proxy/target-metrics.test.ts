import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";

import { fetchTargetMetrics, MAX_TARGET_METRICS_BYTES } from "../../src/proxy/index.js";

const servers: Server[] = [];

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

function urlFor(server: Server, path = ""): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;
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

describe("fetchTargetMetrics", () => {
  it("reads the metrics exposition from the base path when present", async () => {
    const server = await createRecordingServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("# TYPE up gauge\nup 1\n");
    });

    const result = await fetchTargetMetrics({
      targetUrl: urlFor(server, "/v1"),
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.text).toBe("# TYPE up gauge\nup 1\n");
    expect(result.truncated).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("falls back to the host root when the base-path metrics route is missing", async () => {
    const server = await createRecordingServer((request, response) => {
      if (request.url === "/v1/metrics") {
        response.writeHead(404);
        response.end("not found");
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("# TYPE vllm_cache_usage gauge\nvllm_cache_usage 0.5\n");
    });

    const result = await fetchTargetMetrics({
      targetUrl: urlFor(server, "/v1"),
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("vllm_cache_usage");
  });

  it("reports failure with the status when the metrics endpoint errors", async () => {
    const server = await createRecordingServer((_request, response) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("boom");
    });

    const result = await fetchTargetMetrics({
      targetUrl: urlFor(server, "/v1"),
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error).toContain("HTTP 500");
    expect(result.error).toContain("boom");
  });

  it("reports failure when the host does not serve metrics at all", async () => {
    const server = await createRecordingServer((_request, response) => {
      response.writeHead(404);
      response.end("nope");
    });

    const result = await fetchTargetMetrics({
      targetUrl: urlFor(server, "/v1"),
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("404");
  });

  it("caps the exposition text at the byte limit and flags truncation", async () => {
    const payload = "x".repeat(MAX_TARGET_METRICS_BYTES + 1024);
    const server = await createRecordingServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(payload);
    });

    const result = await fetchTargetMetrics({
      targetUrl: urlFor(server, "/v1"),
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.text?.length).toBeLessThanOrEqual(MAX_TARGET_METRICS_BYTES);
  });

  it("reports an error when the connection is refused", async () => {
    const result = await fetchTargetMetrics({
      targetUrl: "http://127.0.0.1:1/metrics",
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("throws a TypeError for an unparseable target url", async () => {
    await expect(fetchTargetMetrics({ targetUrl: "not-a-url" })).rejects.toThrow(TypeError);
  });
});
