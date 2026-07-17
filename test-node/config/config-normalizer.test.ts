import { describe, expect, it } from "vitest";

import {
  ensureAtLeastOneTarget,
  normalizeDefaultTargetId,
  normalizeLogRoot,
  normalizeModelMappings,
  runtimeLogRoot,
} from "../../src/config/config-normalizer.js";
import { createDefaultTarget } from "../../src/config/defaults.js";

describe("ensureAtLeastOneTarget", () => {
  it("creates a default target when the normalized list is empty", () => {
    expect(ensureAtLeastOneTarget([], "custom-logs")).toEqual([createDefaultTarget("custom-logs")]);
  });

  it("returns a new array containing existing targets", () => {
    const target = createDefaultTarget();
    const source = [target];
    const result = ensureAtLeastOneTarget(source);

    expect(result).toEqual(source);
    expect(result).not.toBe(source);
  });
});

describe("log root normalization", () => {
  it("preserves an explicit empty string as disabled logging", () => {
    expect(normalizeLogRoot("", "logs")).toBe("");
    expect(runtimeLogRoot("")).toBeUndefined();
  });

  it("uses configured and fallback log roots otherwise", () => {
    expect(normalizeLogRoot("custom-logs", "logs")).toBe("custom-logs");
    expect(normalizeLogRoot(undefined, "logs")).toBe("logs");
    expect(normalizeLogRoot(undefined, undefined)).toBe("");
    expect(runtimeLogRoot("logs")).toBe("logs");
  });
});

describe("normalizeModelMappings", () => {
  it("normalizes mappings and preserves same-name forwarding", () => {
    expect(
      normalizeModelMappings([
        { listen: " local ", upstream: " remote " },
        { listen: "same" },
        { listen: "same-explicit", upstream: "same-explicit" },
      ]),
    ).toEqual([
      { listen: "local", upstream: "remote" },
      { listen: "same", upstream: "same" },
      { listen: "same-explicit", upstream: "same-explicit" },
    ]);
  });

  it("skips invalid entries and accepts primitive legacy values", () => {
    expect(
      normalizeModelMappings([
        null,
        "model",
        {},
        { listen: " " },
        { listen: 123, upstream: false },
      ]),
    ).toEqual([{ listen: "123", upstream: "123" }]);
    expect(normalizeModelMappings("not-an-array")).toEqual([]);
  });
});

describe("normalizeDefaultTargetId", () => {
  const first = createDefaultTarget();
  const second = { ...createDefaultTarget(), id: "target-2", name: "Second" };

  it("keeps an existing requested target ID", () => {
    expect(normalizeDefaultTargetId(" target-2 ", [first, second])).toBe("target-2");
  });

  it("falls back to the first target for missing or unknown IDs", () => {
    expect(normalizeDefaultTargetId("missing", [first, second])).toBe("target-1");
    expect(normalizeDefaultTargetId(undefined, [first, second])).toBe("target-1");
  });

  it("rejects an empty target list", () => {
    expect(() => normalizeDefaultTargetId("target-1", [])).toThrow(/empty target list/u);
  });
});
