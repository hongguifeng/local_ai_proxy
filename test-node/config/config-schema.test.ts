import { describe, expect, it } from "vitest";

import {
  modelMappingSchema,
  proxyConfigFileSchema,
  proxyPairSchema,
  targetConfigSchema,
} from "../../src/config/config-schema.js";

describe("modelMappingSchema", () => {
  it("trims and validates listen/upstream model names", () => {
    expect(modelMappingSchema.parse({ listen: " local ", upstream: " remote " })).toEqual({
      listen: "local",
      upstream: "remote",
    });
  });

  it("rejects empty model names", () => {
    expect(() => modelMappingSchema.parse({ listen: "", upstream: "remote" })).toThrow();
    expect(() => modelMappingSchema.parse({ listen: "local", upstream: " " })).toThrow();
  });
});

describe("targetConfigSchema", () => {
  it("accepts the persisted target shape", () => {
    const target = {
      id: "target-1",
      name: "Target",
      enabled: true,
      target_url: "https://provider.example/v1",
      target_api_key: "fixture-key",
      target_headers: ["X-Test: yes"],
      strip_request_fields: "temperature",
      inject_request_fields: '{"stream":true}',
      timeout: 600,
      log_root: "logs",
      redact_logs: true,
      model_mappings: [{ listen: "local", upstream: "remote" }],
    };

    expect(targetConfigSchema.parse(target)).toEqual(target);
  });

  it("rejects missing required persisted fields", () => {
    expect(() => targetConfigSchema.parse({ id: "target-1" })).toThrow();
  });

  it.each([
    ["invalid target URL", { target_url: "ftp://provider.example" }],
    ["target URL credentials", { target_url: "https://user:pass@provider.example/v1" }],
    ["target URL query", { target_url: "https://provider.example/v1?secret=value" }],
    ["invalid header", { target_headers: ["missing-colon"] }],
    ["empty header name", { target_headers: [": value"] }],
    ["non-object injection", { inject_request_fields: "[]" }],
    ["invalid injection JSON", { inject_request_fields: "{invalid" }],
    ["zero timeout", { timeout: 0 }],
    ["infinite timeout", { timeout: Number.POSITIVE_INFINITY }],
  ])("rejects %s", (_name, overrides) => {
    const valid = {
      id: "target-1",
      name: "Target",
      enabled: true,
      target_url: "https://provider.example/v1",
      target_api_key: "",
      target_headers: [],
      strip_request_fields: "",
      inject_request_fields: "",
      timeout: 600,
      log_root: "logs",
      redact_logs: false,
      model_mappings: [],
    };
    expect(() => targetConfigSchema.parse({ ...valid, ...overrides })).toThrow();
  });
});

describe("proxyPairSchema", () => {
  const target = targetConfigSchema.parse({
    id: "target-1",
    name: "Target",
    enabled: true,
    target_url: "http://127.0.0.1:1235",
    target_api_key: "",
    target_headers: [],
    strip_request_fields: "",
    inject_request_fields: "",
    timeout: 600,
    log_root: "logs",
    redact_logs: false,
    model_mappings: [],
  });

  it("accepts a complete persisted pair and config file", () => {
    const pair = {
      id: "proxy-1",
      name: "Proxy",
      enabled: false,
      listen_host: "127.0.0.1",
      listen_port: 1234,
      access_log: false,
      targets: [target],
      default_target_id: "target-1",
    };

    expect(proxyPairSchema.parse(pair)).toEqual(pair);
    expect(proxyConfigFileSchema.parse({ pairs: [pair] })).toEqual({ pairs: [pair] });
  });

  it("requires at least one target", () => {
    expect(() =>
      proxyPairSchema.parse({
        id: "proxy-1",
        name: "Proxy",
        enabled: false,
        listen_host: "127.0.0.1",
        listen_port: 1234,
        access_log: false,
        targets: [],
        default_target_id: "target-1",
      }),
    ).toThrow();
  });

  it.each([-1, 65_536, 1.5])("rejects invalid listen port %s", (listenPort) => {
    expect(() =>
      proxyPairSchema.parse({
        id: "proxy-1",
        name: "Proxy",
        enabled: false,
        listen_host: "127.0.0.1",
        listen_port: listenPort,
        access_log: false,
        targets: [target],
        default_target_id: "target-1",
      }),
    ).toThrow();
  });
});

describe("proxyConfigFileSchema duplicate IDs", () => {
  const target = targetConfigSchema.parse({
    id: "target-1",
    name: "Target",
    enabled: true,
    target_url: "http://127.0.0.1:1235",
    target_api_key: "",
    target_headers: [],
    strip_request_fields: "",
    inject_request_fields: "",
    timeout: 600,
    log_root: "logs",
    redact_logs: false,
    model_mappings: [],
  });
  const pair = {
    id: "proxy-1",
    name: "Proxy",
    enabled: false,
    listen_host: "127.0.0.1",
    listen_port: 1234,
    access_log: false,
    targets: [target],
    default_target_id: target.id,
  };

  it("rejects duplicate proxy pair IDs", () => {
    const result = proxyConfigFileSchema.safeParse({ pairs: [pair, { ...pair }] });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("duplicate proxy pair id");
  });

  it("rejects duplicate target IDs within a pair", () => {
    const result = proxyConfigFileSchema.safeParse({
      pairs: [{ ...pair, targets: [target, { ...target }] }],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("duplicate target id");
  });
});
