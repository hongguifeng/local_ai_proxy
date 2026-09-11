import { describe, expect, it } from "vitest";

import {
  modelMappingSchema,
  modelPriceSchema,
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

describe("modelPriceSchema", () => {
  const validPrice = {
    model_pattern: " gpt-5.6-* ",
    input_per_million: "0",
    output_per_million: "30",
    cache_read_per_million: "0.5",
    cache_write_per_million: "6.25",
  };

  it("accepts exact decimal prices, including zero, six decimal places, and the upper limit", () => {
    expect(modelPriceSchema.parse(validPrice)).toEqual({
      ...validPrice,
      model_pattern: "gpt-5.6-*",
    });
    expect(
      modelPriceSchema.parse({
        ...validPrice,
        input_per_million: "1000000",
        output_per_million: "0.000001",
      }),
    ).toMatchObject({ input_per_million: "1000000", output_per_million: "0.000001" });
  });

  it("accepts an optional price multiplier using the same exact decimal validation", () => {
    expect(modelPriceSchema.parse({ ...validPrice, price_multiplier: "1.25" })).toMatchObject({
      price_multiplier: "1.25",
    });
    expect(() => modelPriceSchema.parse({ ...validPrice, price_multiplier: "1e3" })).toThrow();
  });

  it.each([
    ["empty", ""],
    ["negative", "-1"],
    ["scientific notation", "1e3"],
    ["too many decimal places", "0.0000001"],
    ["above maximum", "1000000.000001"],
    ["surrounding whitespace", " 5 "],
  ])("rejects %s price text", (_name, value) => {
    expect(() => modelPriceSchema.parse({ ...validPrice, input_per_million: value })).toThrow();
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
      log_root: "logs",
      redact_logs: true,
      model_mappings: [{ listen: "local", upstream: "remote" }],
      model_prices: [
        {
          model_pattern: "remote",
          input_per_million: "5",
          output_per_million: "30",
          cache_read_per_million: "0.5",
          cache_write_per_million: "6.25",
        },
      ],
    };

    expect(targetConfigSchema.parse(target)).toEqual(target);
  });

  it("rejects missing required persisted fields", () => {
    expect(() => targetConfigSchema.parse({ id: "target-1" })).toThrow();
  });

  it("defaults a missing model price list for older configuration", () => {
    const target = targetConfigSchema.parse({
      id: "target-1",
      name: "Target",
      enabled: true,
      target_url: "https://provider.example/v1",
      target_api_key: "",
      target_headers: [],
      strip_request_fields: "",
      inject_request_fields: "",
      log_root: "logs",
      redact_logs: false,
      model_mappings: [],
    });
    expect(target.model_prices).toEqual([]);
  });

  it("rejects duplicate price patterns within one target", () => {
    const valid = {
      id: "target-1",
      name: "Target",
      enabled: true,
      target_url: "https://provider.example/v1",
      target_api_key: "",
      target_headers: [],
      strip_request_fields: "",
      inject_request_fields: "",
      log_root: "logs",
      redact_logs: false,
      model_mappings: [],
      model_prices: [
        {
          model_pattern: "gpt-*",
          input_per_million: "1",
          output_per_million: "1",
          cache_read_per_million: "1",
          cache_write_per_million: "1",
        },
        {
          model_pattern: " gpt-* ",
          input_per_million: "2",
          output_per_million: "2",
          cache_read_per_million: "2",
          cache_write_per_million: "2",
        },
      ],
    };
    expect(() => targetConfigSchema.parse(valid)).toThrow(/duplicate model price pattern/u);
  });

  it.each([
    ["invalid target URL", { target_url: "ftp://provider.example" }],
    ["target URL credentials", { target_url: "https://user:pass@provider.example/v1" }],
    ["target URL query", { target_url: "https://provider.example/v1?secret=value" }],
    ["invalid header", { target_headers: ["missing-colon"] }],
    ["empty header name", { target_headers: [": value"] }],
    ["non-object injection", { inject_request_fields: "[]" }],
    ["invalid injection JSON", { inject_request_fields: "{invalid" }],
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
