import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TrafficLogService, writeQueueForLogRoot } from "../../src/logging/index.js";
import { TrafficRepository } from "../../src/persistence/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("TrafficLogService redaction", () => {
  it.each([
    [true, "[redacted]", "[redacted]"],
    [false, "secret-api-key", "Bearer secret-api-key"],
  ])(
    "applies redaction only when enabled (%s)",
    async (redactLogs, expectedApiKey, expectedHeader) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-log-redaction-"));
      temporaryDirectories.push(root);
      const service = new TrafficLogService(root, { redactLogs });
      await service.write(trafficRecord("redaction-request"));
      service.close();

      const repository = new TrafficRepository(root);
      expect(repository.getRecord("redaction-request")).toMatchObject({
        request_headers: { Authorization: expectedHeader },
        request_body: { model: "gpt-5", api_key: expectedApiKey },
        response_body: { id: "resp-redaction", token: expectedApiKey },
      });
      repository.close();
    },
  );
});

describe("disabled TrafficLogService", () => {
  it("makes write, update, and close safe no-ops without a log root", async () => {
    const service = new TrafficLogService(null, { redactLogs: true });
    await expect(service.write({ id: "disabled-write" })).resolves.toBeUndefined();
    await expect(service.update({ id: "disabled-update" })).resolves.toBeUndefined();
    expect(() => service.close()).not.toThrow();
    expect(() => service.close()).not.toThrow();
  });
});

describe("TrafficLogService failure isolation", () => {
  it("does not reject the proxy path when persistence fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-log-failure-"));
    temporaryDirectories.push(root);
    const service = new TrafficLogService(root);
    service.close();

    await expect(service.write(trafficRecord("closed-database-request"))).resolves.toBeUndefined();
  });
});

describe("TrafficLogService record mapping", () => {
  it("maps target metadata and message/token summaries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-log-record-row-"));
    temporaryDirectories.push(root);
    const service = new TrafficLogService(root);
    await service.write({
      id: "mapped-request",
      timestamp: "2026-07-18T11:00:00.000+08:00",
      started_timestamp: "2026-07-18T10:59:59.500+08:00",
      event: "request_finished",
      duration_ms: 500,
      proxy: { id: "proxy-1", name: "Primary proxy" },
      client: { host: "127.0.0.1", port: 43123 },
      target: {
        id: "target-1",
        name: "Primary target",
        scheme: "https",
        host: "api.example.com",
        port: 443,
        path: "/base",
      },
      request: {
        method: "POST",
        path: "/v1/responses/?trace=1",
        headers: { "content-type": "application/json" },
        body: {
          size_bytes: 0,
          base64: "",
          text: JSON.stringify({
            model: "gpt-5",
            instructions: "system",
            input: [
              { role: "user", content: "hello" },
              { role: "assistant", content: "hi" },
            ],
          }),
        },
        model_route: { requested: "alias", upstream: "gpt-5" },
        stripped_fields: ["temperature"],
        injected_fields: ["stream"],
        added_upstream_headers: ["authorization"],
      },
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: {
          size_bytes: 0,
          base64: "",
          text: JSON.stringify({ id: "resp-mapped", usage: { total_tokens: 42 } }),
        },
      },
    });
    service.close();

    const repository = new TrafficRepository(root);
    expect(repository.getRecord("mapped-request")).toMatchObject({
      proxy_id: "proxy-1",
      proxy_name: "Primary proxy",
      client_host: "127.0.0.1",
      client_port: 43123,
      target_id: "target-1",
      target_name: "Primary target",
      target_url: "https://api.example.com:443/base",
      method: "POST",
      path: "/v1/responses/?trace=1",
      endpoint: "/v1/responses",
      message_count: 3,
      token_count: 42,
      model_route: { requested: "alias", upstream: "gpt-5" },
      stripped_fields: ["temperature"],
      injected_fields: ["stream"],
      added_upstream_headers: ["authorization"],
    });
    repository.close();
  });
});

describe("original and upstream request bodies", () => {
  it("stores a distinct original body while keeping request_body as the upstream version", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-log-request-bodies-"));
    temporaryDirectories.push(root);
    const service = new TrafficLogService(root, { redactLogs: true });
    const record = trafficRecord("body-request");
    Object.assign(record.request, {
      upstream_body: {
        size_bytes: 0,
        base64: "",
        text: JSON.stringify({ model: "gpt-5-upstream", api_key: "secret-api-key", stream: true }),
      },
    });
    await service.write(record);
    service.close();

    const repository = new TrafficRepository(root);
    expect(repository.getRecord("body-request")).toMatchObject({
      request_body: { model: "gpt-5-upstream", api_key: "[redacted]", stream: true },
      original_request_body: { model: "gpt-5", api_key: "[redacted]" },
    });
    repository.close();
  });

  it("omits the original body when the upstream body is identical", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-log-identical-body-"));
    temporaryDirectories.push(root);
    const service = new TrafficLogService(root);
    const record = trafficRecord("identical-body-request");
    Object.assign(record.request, { upstream_body: { ...record.request.body } });
    await service.write(record);
    service.close();

    const repository = new TrafficRepository(root);
    const saved = repository.getRecord("identical-body-request");
    expect(saved).not.toHaveProperty("original_request_body");
    repository.close();
  });
});

describe("per-log-root write queue", () => {
  it("shares a serial executor for services writing the same root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-log-queue-"));
    temporaryDirectories.push(root);
    const firstQueue = writeQueueForLogRoot(root);
    const secondQueue = writeQueueForLogRoot(path.join(root, "."));
    expect(secondQueue).toBe(firstQueue);

    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = firstQueue.enqueue(async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
    });
    const second = secondQueue.enqueue(() => {
      order.push("second");
    });
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });
});

function trafficRecord(id: string) {
  return {
    id,
    timestamp: "2026-07-18T11:00:00.000+08:00",
    started_timestamp: "2026-07-18T10:59:59.000+08:00",
    event: "request_finished",
    duration_ms: 1_000,
    request: {
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer secret-api-key" },
      body: {
        size_bytes: 0,
        base64: "",
        text: JSON.stringify({ model: "gpt-5", api_key: "secret-api-key" }),
      },
    },
    response: {
      status: 200,
      headers: {},
      body: {
        size_bytes: 0,
        base64: "",
        text: JSON.stringify({ id: "resp-redaction", token: "secret-api-key" }),
      },
    },
  };
}
