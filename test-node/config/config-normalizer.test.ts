import { describe, expect, it } from "vitest";

import { ensureAtLeastOneTarget } from "../../src/config/config-normalizer.js";
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
