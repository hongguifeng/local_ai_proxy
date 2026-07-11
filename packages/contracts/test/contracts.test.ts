import { describe, expect, it } from "vitest";

import {
  ConfigV1Schema,
  ErrorEnvelopeSchema,
  ProxyListResponseSchema,
  RecordDetailSchema,
  StorageWorkerRequestSchema,
  StorageWorkerResponseSchema,
  TaskListResponseSchema,
} from "../src/index.js";

const validTarget = {
  id: "target-1",
  name: "Primary",
  url: "https://api.example.com/v1",
  targetApiKey: "secret-value",
};

const validProxy = {
  id: "proxy-1",
  name: "Local proxy",
  listenHost: "127.0.0.1",
  listenPort: 1234,
  targets: [validTarget],
  defaultTargetId: "target-1",
};

const emptyPayload = {
  kind: "empty" as const,
  observedBytes: 0,
  capturedBytes: 0,
  truncated: false,
};

const validRecord = {
  id: "record-1",
  taskId: "task-1",
  sequence: 1,
  event: "request_finished" as const,
  timestamp: "2026-07-10T12:00:00.000Z",
  durationMs: 12.5,
  method: "POST",
  path: "/v1/responses",
  status: 200,
  errorCode: null,
  messageCount: 1,
  tokenCount: 4,
  client: { host: "127.0.0.1", port: 50_000 },
  proxy: { id: "proxy-1", name: "Local proxy" },
  target: { id: "target-1", name: "Primary", url: "https://api.example.com/v1/responses" },
  request: { headers: { "content-type": ["application/json"] }, body: emptyPayload },
  response: { headers: {}, body: emptyPayload },
};

describe("configuration contracts", () => {
  it("applies v1 defaults and round-trips through JSON", () => {
    const parsed = ConfigV1Schema.parse({ version: 1, proxies: [validProxy] });
    const roundTripped = ConfigV1Schema.parse(JSON.parse(JSON.stringify(parsed)));

    expect(roundTripped.capture.requestBytes).toBe(8 * 1024 * 1024);
    expect(roundTripped.retention.days).toBe(30);
    expect(roundTripped.proxies[0]?.targets[0]?.timeouts.idleMs).toBe(600_000);
  });

  it("rejects unknown fields, duplicate IDs, listeners, and missing default targets", () => {
    expect(ConfigV1Schema.safeParse({ version: 1, proxies: [], unknown: true }).success).toBe(false);
    expect(
      ConfigV1Schema.safeParse({
        version: 1,
        proxies: [validProxy, { ...validProxy, name: "Duplicate" }],
      }).success,
    ).toBe(false);
    expect(
      ConfigV1Schema.safeParse({
        version: 1,
        proxies: [{ ...validProxy, defaultTargetId: "missing" }],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate target IDs and model mappings", () => {
    const duplicateTarget = { ...validTarget, name: "Duplicate" };
    expect(
      ConfigV1Schema.safeParse({
        version: 1,
        proxies: [{ ...validProxy, targets: [validTarget, duplicateTarget] }],
      }).success,
    ).toBe(false);
    expect(
      ConfigV1Schema.safeParse({
        version: 1,
        proxies: [
          {
            ...validProxy,
            targets: [
              {
                ...validTarget,
                modelMappings: [
                  { listen: "demo", upstream: "one" },
                  { listen: "demo", upstream: "two" },
                ],
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("admin contracts", () => {
  it("accepts public proxy state without exposing a secret field", () => {
    const publicProxy = {
      ...validProxy,
      enabled: false,
      accessLog: false,
      targets: [
        {
          id: validTarget.id,
          name: validTarget.name,
          url: validTarget.url,
          enabled: true,
          apiKey: { configured: true, masked: "sk-...1234" },
          headers: [],
          stripRequestFields: [],
          injectRequestFields: {},
          timeouts: { connectMs: 10_000, responseHeadersMs: 60_000, idleMs: 600_000 },
          logRoot: null,
          redactLogs: false,
          modelMappings: [],
        },
      ],
      runtime: { state: "configured", actualListenPort: null },
    };
    const parsed = ProxyListResponseSchema.parse({ proxies: [publicProxy] });
    expect(parsed.proxies[0]?.targets[0]?.apiKey.configured).toBe(true);
    expect(
      ProxyListResponseSchema.safeParse({
        proxies: [{ ...publicProxy, targets: [{ ...publicProxy.targets[0], targetApiKey: "leaked" }] }],
      }).success,
    ).toBe(false);
  });

  it("validates stable error, task list, and record detail envelopes", () => {
    expect(
      ErrorEnvelopeSchema.parse({
        error: { code: "INVALID_CONFIG", message: "Configuration is invalid" },
        requestId: "request-1",
      }).error.code,
    ).toBe("INVALID_CONFIG");
    expect(TaskListResponseSchema.parse({ total: 0, hasMore: false, tasks: [] }).limit).toBe(50);
    expect(RecordDetailSchema.parse(validRecord).id).toBe("record-1");
  });
});

describe("storage worker contracts", () => {
  it("parses each message through a discriminated runtime schema", () => {
    expect(StorageWorkerRequestSchema.parse({ requestId: "rpc-1", kind: "migrate" }).kind).toBe("migrate");
    expect(
      StorageWorkerRequestSchema.parse({ requestId: "rpc-2", kind: "writeTraffic", record: validRecord }).kind,
    ).toBe("writeTraffic");
    expect(StorageWorkerResponseSchema.parse({ requestId: "rpc-2", ok: true }).ok).toBe(true);
  });

  it("rejects unknown message kinds and malformed responses", () => {
    expect(StorageWorkerRequestSchema.safeParse({ requestId: "rpc-1", kind: "executeSql" }).success).toBe(false);
    expect(StorageWorkerResponseSchema.safeParse({ requestId: "rpc-1", ok: false }).success).toBe(false);
  });
});
