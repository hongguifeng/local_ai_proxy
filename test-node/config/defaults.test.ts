import { describe, expect, it } from "vitest";

import {
  SUGGESTED_STRIP_REQUEST_FIELDS,
  createDefaultProxyPair,
  createDefaultTarget,
} from "../../src/config/defaults.js";

describe("configuration defaults", () => {
  it("creates the Python-compatible default target", () => {
    expect(createDefaultTarget("custom-logs")).toEqual({
      id: "target-1",
      name: "Target",
      enabled: true,
      target_url: "http://127.0.0.1:1235",
      target_api_key: "",
      target_headers: [],
      strip_request_fields: "",
      inject_request_fields: "",
      timeout: 600,
      log_root: "custom-logs",
      redact_logs: false,
      model_mappings: [],
    });
  });

  it("creates a disabled default pair with one default target", () => {
    const pair = createDefaultProxyPair();

    expect(pair.id).toBe("default");
    expect(pair.enabled).toBe(false);
    expect(pair.listen_host).toBe("127.0.0.1");
    expect(pair.listen_port).toBe(1234);
    expect(pair.targets).toHaveLength(1);
    expect(pair.default_target_id).toBe(pair.targets[0]?.id);
    expect(pair.targets[0]?.strip_request_fields).toBe("");
    expect(pair.targets[0]?.inject_request_fields).toBe("");
  });

  it("keeps suggested strip fields as UI guidance only", () => {
    expect(SUGGESTED_STRIP_REQUEST_FIELDS).toContain("temperature");
    expect(createDefaultTarget().strip_request_fields).toBe("");
  });
});
