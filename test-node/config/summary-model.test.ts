import { describe, expect, it } from "vitest";
import { summaryModelConfigSchema } from "../../src/config/index.js";

/** The smallest configuration that is not about the reasoning depth. */
const settings = {
  api_type: "openai_chat",
  target_url: "https://example.com/v1",
  api_key: "k",
  model: "m",
};

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

  it("leaves the reasoning depth absent when nothing is configured", () => {
    // "The provider decides" is stored as the absence of the key, not as an empty string:
    // an empty value would be sent upstream and answered as nothing useful.
    const value = summaryModelConfigSchema.parse(settings);
    expect(Object.hasOwn(value, "reasoning_effort")).toBe(false);
  });

  it("takes any single word as a depth, including one the console does not offer", () => {
    // The console's presets are a convenience, not a whitelist: `max` is a provider's own
    // word and reaches the provider unchanged.
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(
        summaryModelConfigSchema.parse({ ...settings, reasoning_effort: effort }).reasoning_effort,
      ).toBe(effort);
    }
  });

  it("trims a depth, then refuses an empty one and one with a space inside", () => {
    expect(
      summaryModelConfigSchema.parse({ ...settings, reasoning_effort: "  high  " })
        .reasoning_effort,
    ).toBe("high");
    for (const unusable of ["", "   ", "medium high", "high\tlow"]) {
      expect(() =>
        summaryModelConfigSchema.parse({ ...settings, reasoning_effort: unusable }),
      ).toThrow();
    }
  });

  it("does not read the old reasoning switch and does not carry it into a save", () => {
    // A configuration that still names the retired switch is accepted - the switch is not
    // consulted anywhere - and the value the parse produces has no such key, so the next
    // save drops it instead of writing a field nothing reads.
    const value = summaryModelConfigSchema.parse({ ...settings, disable_reasoning: true });
    expect(Object.hasOwn(value, "disable_reasoning")).toBe(false);
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
