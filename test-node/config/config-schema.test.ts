import { describe, expect, it } from "vitest";

import { modelMappingSchema, targetConfigSchema } from "../../src/config/config-schema.js";

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
});
