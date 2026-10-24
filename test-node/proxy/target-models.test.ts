import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";

import {
  fetchTargetModels,
  MAX_TARGET_MODEL_ID_CHARS,
  MAX_TARGET_MODEL_IDS,
} from "../../src/proxy/index.js";

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

// Headers arrive as `string | string[] | undefined`, so a request line keeps
// the two auth headers readable in one comparable string.
function headerText(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(",");
  return "<missing>";
}

function jsonServer(payload: unknown): Promise<Server> {
  return createRecordingServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
}

function modelIds(count: number, prefix = "model"): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
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

describe("fetchTargetModels", () => {
  it("reads the model ids served under the base path", async () => {
    const server = await jsonServer({
      data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
    });

    const result = await fetchTargetModels({
      targetUrl: urlFor(server, "/v1"),
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    expect(result.truncated).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it("sends the api key in every auth style the model endpoint may expect", async () => {
    const seen: string[] = [];
    const server = await createRecordingServer((request, response) => {
      seen.push(
        [
          headerText(request.headers, "authorization"),
          headerText(request.headers, "x-api-key"),
        ].join("|"),
      );
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "gpt-5.6" }] }));
    });

    const result = await fetchTargetModels({
      targetUrl: urlFor(server, "/v1"),
      apiKey: "sk-test",
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(["gpt-5.6"]);
    expect(seen).toEqual(["Bearer sk-test|sk-test"]);
  });

  it("reports a plain failure instead of throwing when the upstream refuses the key", async () => {
    const server = await createRecordingServer((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid api key" } }));
    });

    const result = await fetchTargetModels({ targetUrl: urlFor(server, "/v1"), timeoutMs: 5_000 });
    expect(result.ok).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.error).toMatch(/401/u);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a plain failure when the upstream has no model list endpoint", async () => {
    const server = await createRecordingServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });

    const result = await fetchTargetModels({ targetUrl: urlFor(server, "/v1"), timeoutMs: 5_000 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no model list endpoint/u);
  });

  it("reports a plain failure when the list holds no ids", async () => {
    const server = await jsonServer({ data: [] });

    const result = await fetchTargetModels({ targetUrl: urlFor(server, "/v1"), timeoutMs: 5_000 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/did not contain any model ids/u);
  });

  it("keeps an unusable address as a TypeError so the route can answer 400", async () => {
    await expect(fetchTargetModels({ targetUrl: "ftp://example.test" })).rejects.toThrow(TypeError);
  });

  it("caps the list and marks the ids it had to drop", async () => {
    const server = await jsonServer({ models: modelIds(MAX_TARGET_MODEL_IDS + 5) });

    const result = await fetchTargetModels({ targetUrl: urlFor(server, "/v1"), timeoutMs: 5_000 });
    expect(result.ok).toBe(true);
    expect(result.models).toHaveLength(MAX_TARGET_MODEL_IDS);
    expect(result.truncated).toBe(true);
  });

  it("drops ids too long to be usable without marking the list truncated", async () => {
    const server = await jsonServer({
      data: [
        { id: "usable-model" },
        { id: "x".repeat(MAX_TARGET_MODEL_ID_CHARS + 1) },
        { id: "x".repeat(MAX_TARGET_MODEL_ID_CHARS) },
      ],
    });

    const result = await fetchTargetModels({ targetUrl: urlFor(server, "/v1"), timeoutMs: 5_000 });
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(["usable-model", "x".repeat(MAX_TARGET_MODEL_ID_CHARS)]);
    expect(result.truncated).toBeUndefined();
  });
});
