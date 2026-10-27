import { describe, expect, it } from "vitest";

import {
  createDefaultProxyPair,
  createDefaultTarget,
  type ProxyPair,
  type TargetConfig,
} from "../../src/config/index.js";

import {
  METRIC_FRESH_WINDOW_MS,
  assessLoadSample,
  engineLoadViews,
  LoadBalancer,
  type EngineLoadView,
  type LoadSample,
} from "../../src/proxy/index.js";

/**
 * [TRI-03] The judgement input a future auto strategy reads. These tests pin the four facts
 * the request path must never confuse: a number the engine reported, a number it skipped, an
 * answer that went stale, and no answer at all. None of them is allowed to look like an idle
 * node, and none of them moves anything — this module only classifies what was measured.
 */

const NOW = 1_700_000_000_000;

function target(id: string, url: string, overrides: Partial<TargetConfig> = {}): TargetConfig {
  return {
    ...createDefaultTarget("logs"),
    id,
    name: id,
    target_url: url,
    ...overrides,
  };
}

type GroupShape = ProxyPair["load_balancers"][number];

function group(
  id: string,
  nodeTargetIds: readonly string[],
  overrides: Partial<GroupShape> = {},
): GroupShape {
  return {
    id,
    name: id,
    enabled: true,
    model_pattern: "Qwen3.8-Flash-Next",
    members: nodeTargetIds.map((targetId) => ({ target_id: targetId, model_id: "" })),
    strategy: "least_load",
    metrics_enabled: true,
    failover_enabled: true,
    rebalance_mode: "off",
    ...overrides,
  };
}

function pair(targets: readonly TargetConfig[], groups: readonly GroupShape[]): ProxyPair {
  return {
    ...createDefaultProxyPair("logs"),
    id: "pair-1",
    enabled: true,
    targets: [...targets],
    default_target_id: targets[0]?.id ?? "",
    load_balancers: [...groups],
  };
}

function sample(
  overrides: {
    running?: number;
    waiting?: number;
    kvUsage?: number;
    awake?: boolean;
    sampledAt?: number;
    sampleSequence?: number;
  } = {},
): LoadSample {
  return {
    sampleSequence: overrides.sampleSequence ?? 1,
    sampledAt: overrides.sampledAt ?? NOW,
    running: overrides.running,
    waiting: overrides.waiting,
    kvUsage: overrides.kvUsage,
    source: "vllm",
    ...(overrides.awake === undefined ? {} : { awake: overrides.awake }),
  };
}

/** One engine view, with the fixture's own guarantee that there was exactly one. */
function onlyView(views: readonly EngineLoadView[]): EngineLoadView {
  const view = views[0];
  if (view === undefined) {
    throw new Error("the fixture nodes did not collapse into one engine view");
  }
  return view;
}

describe("[TRI-03] classifying one engine answer", () => {
  it("treats a fresh answer with both numbers as usable evidence", () => {
    const assessed = assessLoadSample(sample({ running: 0, waiting: 0, kvUsage: 0.1 }), NOW);
    expect(assessed).toEqual({
      awake: undefined,
      completeness: "complete",
      freshness: "fresh",
      kvUsage: 0.1,
      running: 0,
      sampleSequence: 1,
      sampledAt: NOW,
      source: "vllm",
      usableForLoadJudgement: true,
      waiting: 0,
    });
  });

  it("never reads a KV-only answer as an idle node", () => {
    const assessed = assessLoadSample(sample({ kvUsage: 0.35 }), NOW);
    // This is the smallest probe the task asks to keep: the output for a missing field is
    // missing, not the zero an auto strategy would call idle.
    expect(assessed.running).toBeUndefined();
    expect(assessed.waiting).toBeUndefined();
    expect(assessed.completeness).toBe("no_load_numbers");
    expect(assessed.freshness).toBe("fresh");
    expect(assessed.usableForLoadJudgement).toBe(false);
    expect(assessed.kvUsage).toBe(0.35);
    expect(assessed.source).toBe("vllm");
    expect(assessed.sampleSequence).toBe(1);
  });

  it("calls a half answer partial rather than complete", () => {
    const assessed = assessLoadSample(sample({ running: 4 }), NOW);
    expect(assessed.completeness).toBe("partial");
    expect(assessed.running).toBe(4);
    expect(assessed.waiting).toBeUndefined();
    expect(assessed.usableForLoadJudgement).toBe(false);

    const otherHalf = assessLoadSample(sample({ waiting: 2 }), NOW);
    expect(otherHalf.completeness).toBe("partial");
    expect(otherHalf.running).toBeUndefined();
    expect(otherHalf.waiting).toBe(2);
    expect(otherHalf.usableForLoadJudgement).toBe(false);
  });

  it("stops trusting an answer once it is older than the window", () => {
    const fresh = sample({ running: 3, waiting: 1, sampledAt: NOW });
    expect(assessLoadSample(fresh, NOW).freshness).toBe("fresh");
    expect(assessLoadSample(fresh, NOW + METRIC_FRESH_WINDOW_MS).freshness).toBe("fresh");

    const stale = assessLoadSample(fresh, NOW + METRIC_FRESH_WINDOW_MS + 1);
    expect(stale.freshness).toBe("stale");
    expect(stale.completeness).toBe("complete");
    // Being stale does not change what the engine said; it only says it no longer applies.
    expect(stale.running).toBe(3);
    expect(stale.waiting).toBe(1);
    expect(stale.sampleSequence).toBe(1);
    expect(stale.usableForLoadJudgement).toBe(false);
  });

  it("reports no sample as nothing known, not as a zero", () => {
    const assessed = assessLoadSample(undefined, NOW);
    expect(assessed).toEqual({
      awake: undefined,
      completeness: "no_load_numbers",
      freshness: "never_sampled",
      kvUsage: undefined,
      running: undefined,
      sampleSequence: undefined,
      sampledAt: undefined,
      source: undefined,
      usableForLoadJudgement: false,
      waiting: undefined,
    });
  });

  it("refuses an engine that said it is asleep even when it reported zeros", () => {
    const asleep = assessLoadSample(sample({ running: 0, waiting: 0, awake: false }), NOW);
    expect(asleep.completeness).toBe("complete");
    expect(asleep.running).toBe(0);
    expect(asleep.usableForLoadJudgement).toBe(false);

    // An engine that did not report a sleep state is not treated as asleep.
    const awake = assessLoadSample(sample({ running: 0, waiting: 0 }), NOW);
    expect(awake.awake).toBeUndefined();
    expect(awake.usableForLoadJudgement).toBe(true);
  });

  it("lets a caller declare its own window without changing the numbers", () => {
    const answer = sample({ running: 1, waiting: 1, sampledAt: NOW });
    expect(assessLoadSample(answer, NOW + 6_000, 5_000).freshness).toBe("stale");
    expect(assessLoadSample(answer, NOW + 6_000, 10_000).freshness).toBe("fresh");
    // The current sampling constants describe how often the proxy asks and how long an
    // answer stays current; they are not thresholds a strategy may act on.
    expect(assessLoadSample(answer, NOW + 4_000).usableForLoadJudgement).toBe(true);
  });
});

describe("[TRI-03] one physical engine per view", () => {
  function aliasBalancer(port: number): LoadBalancer {
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(
      pair(
        [
          target("target-loopback", `http://127.0.0.1:${port}`),
          target("target-name", `http://localhost:${port}`),
        ],
        [group("lb-tri-03", ["target-loopback", "target-name"])],
      ),
    );
    return balancer;
  }

  it("collapses target aliases into one engine with one answer", () => {
    const balancer = aliasBalancer(9_393);
    const shared = sample({ running: 3, waiting: 2, sampleSequence: 7 });
    balancer.setSample("target-loopback", shared);
    balancer.setSample("target-name", shared);

    const views = engineLoadViews(balancer.nodes(), NOW);
    expect(views).toHaveLength(1);
    const view = onlyView(views);
    expect(view.targetIds).toEqual(["target-loopback", "target-name"]);
    // One engine's numbers are read once: two spellings of the same address cannot add up to
    // twice the running requests or twice the capacity.
    expect(view.assessment.running).toBe(3);
    expect(view.assessment.waiting).toBe(2);
    expect(view.assessment.sampleSequence).toBe(7);
    expect(view.assessment.usableForLoadJudgement).toBe(true);
    expect(view.targets.map((entry) => entry.targetId)).toEqual(["target-loopback", "target-name"]);
  });

  it("keeps the engine's answer when one alias of it is disabled", () => {
    const balancer = aliasBalancer(9_393);
    balancer.reconfigure(
      pair(
        [
          target("target-loopback", "http://127.0.0.1:9393"),
          target("target-name", "http://localhost:9393", { enabled: false }),
        ],
        [group("lb-tri-03", ["target-loopback", "target-name"])],
      ),
    );
    balancer.setSample("target-loopback", sample({ running: 1, waiting: 0, sampleSequence: 4 }));

    const view = onlyView(engineLoadViews(balancer.nodes(), NOW));
    expect(view.targetIds).toEqual(["target-loopback", "target-name"]);
    expect(view.assessment.freshness).toBe("fresh");
    expect(view.assessment.sampleSequence).toBe(4);
    expect(view.targets.map((entry) => entry.inRotation)).toEqual([true, false]);
    expect(view.targets.map((entry) => entry.enabled)).toEqual([true, false]);
  });

  it("carries each target's own cooldown without mixing it into the engine's numbers", () => {
    const balancer = aliasBalancer(9_393);
    balancer.markCooldown("target-loopback", NOW + 5_000);
    balancer.setSample("target-loopback", sample({ running: 0, waiting: 0 }));
    balancer.setSample("target-name", sample({ running: 0, waiting: 0, sampleSequence: 2 }));

    const view = onlyView(engineLoadViews(balancer.nodes(), NOW));
    expect(view.assessment.sampleSequence).toBe(2);
    expect(view.targets).toEqual([
      {
        cooldownRemainingMs: 5_000,
        enabled: true,
        inRotation: false,
        targetId: "target-loopback",
      },
      {
        cooldownRemainingMs: 0,
        enabled: true,
        inRotation: true,
        targetId: "target-name",
      },
    ]);
  });

  it("counts two different engines separately and reports an unmeasured one as unknown", () => {
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(
      pair(
        [target("node-a", "http://127.0.0.1:9393"), target("node-b", "http://127.0.0.1:9394")],
        [group("lb-tri-03", ["node-a", "node-b"])],
      ),
    );
    balancer.setSample("node-a", sample({ running: 2, waiting: 1 }));

    const views = engineLoadViews(balancer.nodes(), NOW);
    expect(views.map((view) => view.canonicalKey)).toEqual([
      "http://127.0.0.1:9393",
      "http://127.0.0.1:9394",
    ]);
    expect(views[0]?.assessment.usableForLoadJudgement).toBe(true);
    expect(views[1]?.assessment.freshness).toBe("never_sampled");
    expect(views[1]?.assessment.usableForLoadJudgement).toBe(false);
    expect(views[1]?.assessment.running).toBeUndefined();
  });
});
