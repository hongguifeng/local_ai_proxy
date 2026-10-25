import { describe, expect, it } from "vitest";

import {
  ensureAtLeastOneTarget,
  materializeProxyConfigFile,
  normalizeDefaultTargetId,
  normalizeInjectRequestFields,
  normalizeLoadBalancerGroups,
  normalizeLogRoot,
  normalizeModelMappings,
  normalizeModelPrices,
  normalizeProxyConfigFile,
  runtimeLogRoot,
} from "../../src/config/config-normalizer.js";
import { loadBalancerGroupSchema, proxyConfigFileSchema } from "../../src/config/config-schema.js";
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

describe("legacy configuration field preservation", () => {
  it("[AI-25] keeps unknown pair and target JSON fields while filtering UI state", () => {
    const source = {
      pairs: [
        {
          id: "legacy-pair",
          name: "Legacy",
          enabled: false,
          listen_host: "127.0.0.1",
          listen_port: 1234,
          targets: [
            {
              ...createDefaultTarget("logs"),
              legacy_target_option: { mode: "compat" },
              expanded: true,
            },
          ],
          default_target_id: "target-1",
          legacy_pair_option: ["keep", 1],
          running: true,
          actual_listen_port: 4321,
        },
      ],
    };

    const materialized = materializeProxyConfigFile(normalizeProxyConfigFile(source));
    const materializedPair = materialized.pairs[0];
    if (materializedPair === undefined) throw new Error("Preserved pair was not returned.");
    const materializedTarget = materializedPair.targets[0];
    if (materializedTarget === undefined) throw new Error("Preserved target was not returned.");
    const pairValues = materializedPair as Record<string, unknown>;
    const targetValues = materializedTarget as Record<string, unknown>;
    expect(materializedPair).toMatchObject({
      legacy_pair_option: ["keep", 1],
      targets: [{ legacy_target_option: { mode: "compat" } }],
    });
    expect(pairValues["running"]).toBeUndefined();
    expect(pairValues["actual_listen_port"]).toBeUndefined();
    expect(targetValues["expanded"]).toBeUndefined();
  });

  it("[AI-25] preserves a JSON unknown __proto__ field as an own field", () => {
    const sourcePair = {
      id: "proto-pair",
      name: "Proto pair",
      enabled: false,
      listen_host: "127.0.0.1",
      listen_port: 1234,
      targets: [createDefaultTarget("logs")],
      default_target_id: "target-1",
    };
    Object.defineProperty(sourcePair, "__proto__", {
      enumerable: true,
      value: { retained: true },
    });

    const materializedPair = materializeProxyConfigFile(
      normalizeProxyConfigFile({ pairs: [sourcePair] }),
    ).pairs[0] as Record<string, unknown>;

    expect(Object.prototype.hasOwnProperty.call(materializedPair, "__proto__")).toBe(true);
    expect(materializedPair["__proto__"]).toEqual({ retained: true });
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

describe("normalizeLoadBalancerGroups", () => {
  const groupFixture = {
    id: " lb-1 ",
    name: "Dual card",
    enabled: false,
    model_pattern: " qwen* ",
    // Written the way a group was saved before member model ids existed.
    node_target_ids: [" target-b ", "target-a"],
    strategy: "round_robin",
    metrics_enabled: false,
    failover_enabled: false,
  };

  it("LB01-01 defaults a missing group list", () => {
    expect(normalizeLoadBalancerGroups(undefined)).toEqual([]);
  });

  it("LB19-02 reads member model ids, trims them and folds an id list into members", () => {
    expect(
      normalizeLoadBalancerGroups([
        {
          model_pattern: "qwen*",
          members: [
            { target_id: " target-a ", model_id: "  Qwen3.8-A  " },
            { target_id: "target-a", model_id: "Ignored" },
            { target_id: "target-b", model_id: "   " },
          ],
        },
      ])[0]?.members,
    ).toEqual([
      { target_id: "target-a", model_id: "Qwen3.8-A" },
      { target_id: "target-b", model_id: "" },
    ]);
  });

  it("LB19-02 keeps an old id-only group as a group of unmapped members", () => {
    const groups = normalizeLoadBalancerGroups([
      {
        id: "lb-old",
        name: "Old",
        model_pattern: "qwen*",
        node_target_ids: ["target-a", "target-a", "target-b"],
      },
    ]);

    expect(groups[0]?.members).toEqual([
      { target_id: "target-a", model_id: "" },
      { target_id: "target-b", model_id: "" },
    ]);
    expect(loadBalancerGroupSchema.parse(groups[0]).members).toEqual(groups[0]?.members);
  });

  it("fills generated ids, keeps supplied values and trims text", () => {
    expect(normalizeLoadBalancerGroups([groupFixture, {}])).toEqual([
      {
        id: "lb-1",
        name: "Dual card",
        enabled: false,
        model_pattern: "qwen*",
        members: [
          { target_id: "target-b", model_id: "" },
          { target_id: "target-a", model_id: "" },
        ],
        strategy: "round_robin",
        metrics_enabled: false,
        failover_enabled: false,
      },
      {
        id: "lb-2",
        name: "lb-2",
        enabled: true,
        model_pattern: "",
        members: [],
        strategy: "least_load",
        metrics_enabled: true,
        failover_enabled: true,
      },
    ]);
  });

  it("LB01-02 keeps an unknown node target so the schema can report it", () => {
    const issues = proxyConfigFileSchema.safeParse({
      pairs: [
        {
          id: "proxy-1",
          name: "Proxy",
          enabled: false,
          listen_host: "127.0.0.1",
          listen_port: 1234,
          access_log: false,
          targets: [createDefaultTarget("logs")],
          default_target_id: "target-1",
          load_balancers: normalizeLoadBalancerGroups([
            { model_pattern: "qwen*", members: [{ target_id: "ghost", model_id: "GhostModel" }] },
          ]),
        },
      ],
    });

    const firstIssue = issues.error?.issues[0];

    expect(issues.success).toBe(false);
    expect(firstIssue?.message).toContain(
      "load balancer node target not found in pair proxy-1: ghost",
    );
    expect(firstIssue?.path).toEqual(["pairs", 0, "load_balancers", 0, "members", 0, "target_id"]);
  });

  it("LB01-07 keeps an unknown strategy text instead of guessing a strategy", () => {
    const groups = normalizeLoadBalancerGroups([{ model_pattern: "qwen*", strategy: "weighted" }]);

    expect(groups[0]?.strategy).toBe("weighted");
    expect(() => loadBalancerGroupSchema.parse(groups[0])).toThrow();
  });

  it("keeps a malformed entry for schema validation instead of dropping it", () => {
    expect(normalizeLoadBalancerGroups(["not-a-group"])).toEqual(["not-a-group"]);
  });

  it("accepts a single node target written as plain text", () => {
    const groups = normalizeLoadBalancerGroups([
      { model_pattern: "qwen*", node_target_ids: "target-1" },
    ]);

    expect(groups[0]).toMatchObject({ members: [{ target_id: "target-1", model_id: "" }] });
    expect(
      proxyConfigFileSchema.safeParse({
        pairs: [
          {
            id: "proxy-1",
            name: "Proxy",
            enabled: false,
            listen_host: "127.0.0.1",
            listen_port: 1234,
            access_log: false,
            targets: [createDefaultTarget("logs")],
            default_target_id: "target-1",
            load_balancers: normalizeLoadBalancerGroups([
              { id: "lb-1", name: "Dual", model_pattern: "qwen*", node_target_ids: "" },
            ]),
          },
        ],
      }).error?.issues[0]?.message,
    ).toContain("node target id is required");
  });

  it("LB01-01 keeps a group list through the whole configuration file", () => {
    const first = createDefaultTarget("logs");
    const second = { ...createDefaultTarget("logs"), id: "target-2", name: "Second" };
    const normalized = normalizeProxyConfigFile({
      pairs: [
        {
          id: "proxy-1",
          name: "Proxy",
          enabled: false,
          listen_host: "127.0.0.1",
          listen_port: 1234,
          access_log: false,
          targets: [first, second],
          default_target_id: first.id,
          load_balancers: [{ ...groupFixture, node_target_ids: [" target-2 ", "target-1"] }],
        },
      ],
    });

    expect(normalized.pairs[0]?.load_balancers).toEqual([
      {
        id: "lb-1",
        name: "Dual card",
        enabled: false,
        model_pattern: "qwen*",
        members: [
          { target_id: "target-2", model_id: "" },
          { target_id: "target-1", model_id: "" },
        ],
        strategy: "round_robin",
        metrics_enabled: false,
        failover_enabled: false,
      },
    ]);
  });
});
