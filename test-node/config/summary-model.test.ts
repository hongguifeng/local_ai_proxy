import { describe, expect, it } from "vitest";
import { summaryModelConfigSchema } from "../../src/config/index.js";

describe("summary model config", () => {
  it("accepts supported protocols and defaults", () => {
    const value = summaryModelConfigSchema.parse({
      api_type: "openai_chat",
      target_url: "https://example.com/v1",
      api_key: "k",
      model: "m",
    });
    expect(value.timeout_ms).toBe(180000);
  });
  it("rejects invalid limits", () => {
    expect(() =>
      summaryModelConfigSchema.parse({
        api_type: "openai_chat",
        target_url: "https://example.com",
        api_key: "k",
        model: "m",
        timeout_ms: 1,
      }),
    ).toThrow();
  });
});
