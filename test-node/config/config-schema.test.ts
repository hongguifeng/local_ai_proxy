import { describe, expect, it } from "vitest";

import {
  collectLoadBalancerWarnings,
  loadBalancerGroupSchema,
  modelPatternsMayOverlap,
  modelMappingSchema,
  modelPriceSchema,
  proxyConfigFileSchema,
  proxyPairSchema,
  targetConfigSchema,
  type ProxyPair,
} from "../../src/config/config-schema.js";
import { normalizeProxyConfigFile } from "../../src/config/config-normalizer.js";

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
      load_balancers: [],
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

describe("loadBalancerGroupSchema", () => {
  const groupFixture = {
    id: "lb-1",
    name: "Dual card",
    enabled: true,
    model_pattern: "Qwen3.8-Flash-Next",
    members: [
      { target_id: "lb-target-a", model_id: "Qwen3.8-Flash-Next-A" },
      { target_id: "lb-target-b", model_id: "" },
    ],
    strategy: "least_load",
    metrics_enabled: true,
    failover_enabled: true,
  };

  it("LB01-07 keeps strategy, switches, node order and member models through a round trip", () => {
    const submitted = {
      ...groupFixture,
      strategy: "round_robin",
      metrics_enabled: false,
      failover_enabled: false,
      members: [
        { target_id: "lb-target-b", model_id: "Qwen3.8-Flash-Next-B" },
        { target_id: "lb-target-a", model_id: "" },
      ],
    };

    const once = loadBalancerGroupSchema.parse(submitted);
    expect(loadBalancerGroupSchema.parse(once)).toEqual(once);
    expect(once).toMatchObject({
      strategy: "round_robin",
      metrics_enabled: false,
      failover_enabled: false,
      members: [
        { target_id: "lb-target-b", model_id: "Qwen3.8-Flash-Next-B" },
        { target_id: "lb-target-a", model_id: "" },
      ],
    });
  });

  it("LB19-01 trims a member model id and defaults a missing one to no mapping", () => {
    const parsed = loadBalancerGroupSchema.parse({
      ...groupFixture,
      members: [
        { target_id: " lb-target-a ", model_id: "  Qwen3.8-Flash-Next-A  " },
        { target_id: "lb-target-b" },
      ],
    });

    expect(parsed.members).toEqual([
      { target_id: "lb-target-a", model_id: "Qwen3.8-Flash-Next-A" },
      { target_id: "lb-target-b", model_id: "" },
    ]);
  });

  it("applies v1 defaults for a minimal group", () => {
    expect(
      loadBalancerGroupSchema.parse({
        id: " lb-1 ",
        name: "Dual",
        model_pattern: " qwen* ",
        members: [{ target_id: "lb-target-a" }],
      }),
    ).toEqual({
      id: "lb-1",
      name: "Dual",
      enabled: true,
      model_pattern: "qwen*",
      members: [{ target_id: "lb-target-a", model_id: "" }],
      strategy: "least_load",
      metrics_enabled: true,
      failover_enabled: true,
    });
  });

  it("LB01-03 accepts a group with a single node", () => {
    expect(
      loadBalancerGroupSchema.parse({
        ...groupFixture,
        members: [{ target_id: "lb-target-a", model_id: "" }],
      }),
    ).toMatchObject({ members: [{ target_id: "lb-target-a", model_id: "" }] });
  });

  it("LB01-03 rejects an empty node list, a missing model pattern and a missing id", () => {
    expect(() => loadBalancerGroupSchema.parse({ ...groupFixture, members: [] })).toThrow(
      /at least one node target/u,
    );
    expect(() => loadBalancerGroupSchema.parse({ ...groupFixture, model_pattern: " " })).toThrow();
    expect(() => loadBalancerGroupSchema.parse({ ...groupFixture, id: "" })).toThrow();
    expect(() =>
      loadBalancerGroupSchema.parse({ ...groupFixture, members: [{ target_id: " " }] }),
    ).toThrow(/node target id is required/u);
  });

  it("LB01-02 reports a node target listed twice with its group path", () => {
    const result = loadBalancerGroupSchema.safeParse({
      ...groupFixture,
      members: [
        { target_id: "lb-target-a", model_id: "" },
        { target_id: "lb-target-a", model_id: "Other" },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      "duplicate load balancer node target in group lb-1",
    );
    expect(result.error?.issues[0]?.path).toEqual(["members", 1, "target_id"]);
  });

  it("rejects a strategy text the runtime cannot execute", () => {
    expect(() =>
      loadBalancerGroupSchema.parse({ ...groupFixture, strategy: "weighted" }),
    ).toThrow();
  });
});

describe("proxyConfigFileSchema load balancer validation", () => {
  const targetFixture = {
    id: "lb-target-a",
    name: "GPU 1",
    enabled: true,
    target_url: "http://127.0.0.1:9393/v1",
    target_api_key: "",
    target_headers: [],
    strip_request_fields: "",
    inject_request_fields: "",
    log_root: "logs",
    redact_logs: false,
    model_mappings: [],
    model_prices: [],
  };
  const groupFixture = {
    id: "lb-1",
    name: "Dual card",
    enabled: true,
    model_pattern: "Qwen3.8-Flash-Next",
    members: [
      { target_id: "lb-target-a", model_id: "" },
      { target_id: "lb-target-b", model_id: "" },
    ],
    strategy: "least_load",
    metrics_enabled: true,
    failover_enabled: true,
  };
  const priceRule = {
    model_pattern: "qwen*",
    input_per_million: "1",
    output_per_million: "2",
    cache_read_per_million: "3",
    cache_write_per_million: "4",
  };

  function targetWith(overrides: Record<string, unknown>): Record<string, unknown> {
    return { ...targetFixture, ...overrides };
  }

  function pairValue(
    options: {
      readonly targets?: readonly unknown[];
      readonly groups?: readonly unknown[];
      readonly pairId?: string;
    } = {},
  ): Record<string, unknown> {
    return {
      id: options.pairId ?? "proxy-1",
      name: "Proxy",
      enabled: false,
      listen_host: "127.0.0.1",
      listen_port: 1234,
      access_log: false,
      targets: options.targets ?? [targetFixture, targetWith({ id: "lb-target-b" })],
      default_target_id: "lb-target-a",
      load_balancers: options.groups ?? [],
    };
  }

  function file(
    options: {
      readonly targets?: readonly unknown[];
      readonly groups?: readonly unknown[];
      readonly pairId?: string;
      readonly pairs?: readonly unknown[];
    } = {},
  ): unknown {
    return { pairs: options.pairs ?? [pairValue(options)] };
  }

  function issues(value: unknown): { readonly message: string; readonly path: string }[] {
    const result = proxyConfigFileSchema.safeParse(value);
    if (result.success) {
      return [];
    }
    return result.error.issues.map((issue) => ({
      message: issue.message,
      path: issue.path.map((segment) => String(segment)).join("."),
    }));
  }

  function firstPair(value: unknown): ProxyPair {
    const parsed = proxyConfigFileSchema.parse(value);
    const pair = parsed.pairs[0];
    if (pair === undefined) {
      throw new Error("Expected one parsed pair.");
    }
    return pair;
  }

  it("LB01-01 loads an old configuration file and keeps every other field", () => {
    const normalized = normalizeProxyConfigFile(file());

    expect(normalized.pairs[0]?.load_balancers).toEqual([]);
    expect(normalized.pairs[0]?.id).toBe("proxy-1");
    expect(normalized.pairs[0]?.default_target_id).toBe("lb-target-a");
    expect(normalized.pairs[0]?.targets.map((target) => target.id)).toEqual([
      "lb-target-a",
      "lb-target-b",
    ]);
    expect(proxyConfigFileSchema.parse(proxyConfigFileSchema.parse(file()))).toEqual(
      proxyConfigFileSchema.parse(file()),
    );
  });

  it("LB01-02 rejects a duplicated group id with its exact path", () => {
    expect(issues(file({ groups: [groupFixture, { ...groupFixture }] }))).toContainEqual({
      message: "duplicate load balancer id in pair proxy-1: lb-1",
      path: "pairs.0.load_balancers.1.id",
    });
  });

  it("LB01-02 rejects a node target that is not in the pair", () => {
    const found = issues(
      file({
        groups: [
          {
            ...groupFixture,
            members: [
              { target_id: "lb-target-a", model_id: "" },
              { target_id: "ghost", model_id: "" },
            ],
          },
        ],
      }),
    );

    expect(found).toContainEqual({
      message: "load balancer node target not found in pair proxy-1: ghost",
      path: "pairs.0.load_balancers.0.members.1.target_id",
    });
  });

  it("LB01-02 rejects a node target taken from another pair", () => {
    const otherPair = {
      id: "proxy-2",
      name: "Other",
      enabled: false,
      listen_host: "127.0.0.1",
      listen_port: 1235,
      access_log: false,
      targets: [targetWith({ id: "lb-target-b" })],
      default_target_id: "lb-target-b",
      load_balancers: [{ ...groupFixture, members: [{ target_id: "lb-target-a", model_id: "" }] }],
    };

    expect(issues(file({ pairs: [pairValue(), otherPair] }))).toContainEqual({
      message: "load balancer node target not found in pair proxy-2: lb-target-a",
      path: "pairs.1.load_balancers.0.members.0.target_id",
    });
  });

  it("LB01-06 rejects two groups with the exact same model pattern", () => {
    expect(
      issues(
        file({
          groups: [
            groupFixture,
            { ...groupFixture, id: "lb-2", model_pattern: " Qwen3.8-Flash-Next " },
          ],
        }),
      ),
    ).toContainEqual({
      message: "duplicate load balancer model pattern in pair proxy-1: Qwen3.8-Flash-Next",
      path: "pairs.0.load_balancers.1.model_pattern",
    });
  });

  it("LB01-06 saves partially overlapping patterns and reports a warning", () => {
    const groups = [
      { ...groupFixture, model_pattern: "qwen*" },
      { ...groupFixture, id: "lb-2", model_pattern: "*flash*" },
    ];

    expect(issues(file({ groups }))).toEqual([]);
    expect(collectLoadBalancerWarnings(firstPair(file({ groups })))).toMatchObject([
      { group_id: "lb-1", code: "overlapping_pattern", related_group_ids: ["lb-2"] },
    ]);
  });

  it("LB01-03 accepts a disabled member and reports it as a warning", () => {
    const pair = firstPair(
      file({
        targets: [targetFixture, targetWith({ id: "lb-target-b", enabled: false })],
        groups: [groupFixture],
      }),
    );

    expect(pair.load_balancers).toHaveLength(1);
    expect(collectLoadBalancerWarnings(pair)).toContainEqual({
      group_id: "lb-1",
      group_index: 0,
      code: "disabled_member",
      related_group_ids: [],
      related_target_ids: ["lb-target-b"],
    });
  });

  it("LB01-03 warns when a group has only one node", () => {
    const pair = firstPair(
      file({
        groups: [{ ...groupFixture, members: [{ target_id: "lb-target-a", model_id: "" }] }],
      }),
    );

    expect(collectLoadBalancerWarnings(pair)).toEqual([
      {
        group_id: "lb-1",
        group_index: 0,
        code: "single_node",
        related_group_ids: [],
        related_target_ids: ["lb-target-a"],
      },
    ]);
  });

  it("LB01-04 rejects nodes that resolve to different log roots", () => {
    expect(
      issues(
        file({
          targets: [targetFixture, targetWith({ id: "lb-target-b", log_root: "logs/secondary" })],
          groups: [groupFixture],
        }),
      ),
    ).toContainEqual({
      message:
        'load balancer group lb-1 nodes must share one log root: lb-target-a uses "logs" but lb-target-b uses "logs/secondary"',
      path: "pairs.0.load_balancers.0.members.1.target_id",
    });
  });

  it("LB01-04 treats differently written but equal roots as one directory", () => {
    expect(
      issues(
        file({
          targets: [
            targetFixture,
            targetWith({ id: "lb-target-b", log_root: "./logs/" }),
            targetWith({ id: "lb-target-c", log_root: " logs\\sub\\.. " }),
          ],
          groups: [
            {
              ...groupFixture,
              members: [
                { target_id: "lb-target-a", model_id: "" },
                { target_id: "lb-target-b", model_id: "" },
                { target_id: "lb-target-c", model_id: "" },
              ],
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("LB01-04 accepts a group where every member switched logging off", () => {
    expect(
      issues(
        file({
          targets: [targetWith({ log_root: "" }), targetWith({ id: "lb-target-b", log_root: "" })],
          groups: [groupFixture],
        }),
      ),
    ).toEqual([]);
  });

  it("LB01-04 rejects mixing disabled logging with an enabled log root", () => {
    const found = issues(
      file({
        targets: [targetWith({ log_root: "" }), targetWith({ id: "lb-target-b" })],
        groups: [groupFixture],
      }),
    );

    expect(found[0]?.message).toContain("must share one log root");
    expect(found[0]?.path).toBe("pairs.0.load_balancers.0.members.1.target_id");
  });

  it("LB01-05 rejects price rules that differ in order, pattern or amount", () => {
    const reordered = issues(
      file({
        targets: [
          targetWith({ model_prices: [priceRule, { ...priceRule, model_pattern: "gpt*" }] }),
          targetWith({
            id: "lb-target-b",
            model_prices: [{ ...priceRule, model_pattern: "gpt*" }, priceRule],
          }),
        ],
        groups: [groupFixture],
      }),
    );

    expect(reordered[0]?.message).toContain(
      "load balancer group lb-1 nodes must share identical model prices: lb-target-a differs from lb-target-b",
    );
    expect(reordered[0]?.path).toBe("pairs.0.load_balancers.0.members.1.target_id");

    expect(
      issues(
        file({
          targets: [
            targetWith({ model_prices: [priceRule] }),
            targetWith({
              id: "lb-target-b",
              model_prices: [{ ...priceRule, input_per_million: "9" }],
            }),
          ],
          groups: [groupFixture],
        }),
      )[0]?.message,
    ).toContain("must share identical model prices");

    expect(
      issues(
        file({
          targets: [
            targetWith({ model_prices: [priceRule] }),
            targetWith({ id: "lb-target-b", model_prices: [] }),
          ],
          groups: [groupFixture],
        }),
      )[0]?.message,
    ).toContain("must share identical model prices");
  });

  it("LB01-05 accepts equal rule lists and an explicitly unpriced group", () => {
    expect(
      issues(
        file({
          targets: [
            targetWith({ model_prices: [priceRule] }),
            targetWith({
              id: "lb-target-b",
              model_prices: [{ ...priceRule, input_per_million: "1.0" }],
            }),
          ],
          groups: [groupFixture],
        }),
      ),
    ).toEqual([]);
    expect(
      issues(
        file({
          targets: [targetFixture, targetWith({ id: "lb-target-b" })],
          groups: [groupFixture],
        }),
      ),
    ).toEqual([]);
  });
});

describe("load balancer pattern overlap", () => {
  it.each([
    ["qwen*", "qwen3*", true],
    ["qwen*", "Qwen*", false],
    ["*flash*", "qwen3*", true],
    ["gpt-4*", "gpt-4o", true],
    ["gpt-4*", "o4", false],
    ["a*b", "a*c", false],
    ["*a*b*", "*b*a*", false],
    ["*a*a*", "*a*", true],
    ["*", "anything", true],
    ["exact-name", "exact-name", true],
    ["exact-name", "other-name", false],
  ])("modelPatternsMayOverlap(%s, %s) is %s", (left, right, expected) => {
    expect(modelPatternsMayOverlap(left, right)).toBe(expected);
  });
});
