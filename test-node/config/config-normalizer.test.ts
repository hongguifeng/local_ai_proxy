import { describe, expect, it } from "vitest";

import {
  ensureAtLeastOneTarget,
  normalizeDefaultTargetId,
  normalizeInjectRequestFields,
  normalizeLogRoot,
  normalizeModelMappings,
  normalizeModelPrices,
  normalizeProxyConfigFile,
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

describe("normalizeInjectRequestFields", () => {
  it("keeps string configuration unchanged", () => {
    expect(normalizeInjectRequestFields('{"stream":true}')).toBe('{"stream":true}');
    expect(normalizeInjectRequestFields("")).toBe("");
  });

  it("serializes object configuration as compact Unicode JSON", () => {
    expect(normalizeInjectRequestFields({ metadata: { source: "代理" }, stream: true })).toBe(
      '{"metadata":{"source":"代理"},"stream":true}',
    );
  });

  it("normalizes missing values to an empty string", () => {
    expect(normalizeInjectRequestFields(undefined)).toBe("");
    expect(normalizeInjectRequestFields(null)).toBe("");
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

describe("normalizeModelPrices", () => {
  it("defaults only a missing field and retains supplied rules for validation", () => {
    const rules = [
      {
        model_pattern: "gpt-*",
        input_per_million: "0",
        output_per_million: "30",
        cache_read_per_million: "0.5",
        cache_write_per_million: "6.25",
      },
    ];

    expect(normalizeModelPrices(undefined)).toEqual([]);
    expect(normalizeModelPrices(rules)).toBe(rules);
  });
});

describe("price configuration normalization", () => {
  it("adds an empty list to older targets and retains order across targets", () => {
    const first = createDefaultTarget("logs");
    const legacyTarget = { ...first };
    Reflect.deleteProperty(legacyTarget, "model_prices");
    const second = {
      ...createDefaultTarget("logs"),
      id: "target-2",
      model_prices: [
        {
          model_pattern: "gpt-5.6-sol",
          input_per_million: "5",
          output_per_million: "30",
          cache_read_per_million: "0.5",
          cache_write_per_million: "6.25",
        },
        {
          model_pattern: "gpt-5.6-*",
          input_per_million: "6",
          output_per_million: "31",
          cache_read_per_million: "0.6",
          cache_write_per_million: "6.5",
        },
      ],
    };

    const normalized = normalizeProxyConfigFile({
      pairs: [
        {
          id: "proxy-1",
          name: "Proxy",
          enabled: false,
          listen_host: "127.0.0.1",
          listen_port: 1234,
          access_log: false,
          targets: [legacyTarget, second],
          default_target_id: legacyTarget.id,
        },
      ],
    });

    expect(normalized.pairs[0]?.targets.map((target) => target.model_prices)).toEqual([
      [],
      second.model_prices,
    ]);
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
