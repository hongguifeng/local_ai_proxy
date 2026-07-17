import { describe, expect, it } from "vitest";

import {
  ensureAtLeastOneTarget,
  normalizeDefaultTargetId,
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
