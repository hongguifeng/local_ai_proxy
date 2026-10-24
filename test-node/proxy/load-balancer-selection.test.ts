import { describe, expect, it } from "vitest";

import {
  createDefaultProxyPair,
  createDefaultTarget,
  type ProxyPair,
  type TargetConfig,
} from "../../src/config/index.js";

import {
  METRIC_FRESH_WINDOW_MS,
  LoadBalancer,
  taskIdentity,
  type LoadBalancerReservation,
  type LoadSample,
  type TaskIdentity,
} from "../../src/proxy/index.js";

/**
 * LB-05 picks a node for a new task and keeps a task on the node it already chose. The
 * order is fixed by the design: KV pressure tier first, then load, then the dispatch time
 * that makes idle nodes alternate, then KV share, then the order the user configured.
 */

type GroupShape = ProxyPair["load_balancers"][number];

const NOW = 1_700_000_000_000;

function target(id: string, port: number, overrides: Partial<TargetConfig> = {}): TargetConfig {
  return {
    ...createDefaultTarget("logs"),
    id,
    name: id,
    target_url: `http://127.0.0.1:${port}/v1`,
    ...overrides,
  };
}

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
    node_target_ids: [...nodeTargetIds],
    strategy: "least_load",
    metrics_enabled: true,
    failover_enabled: true,
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

function identity(sessionId: string, turn = "one"): TaskIdentity {
  return taskIdentity({
    payload: {
      model: "Qwen3.8-Flash-Next",
      instructions: "rules",
      input: [{ role: "user", content: turn }],
    },
    headers: { "x-claude-code-session-id": [sessionId] },
    path: "/v1/responses",
  });
}

function sample(
  overrides: {
    running?: number;
    waiting?: number;
    kvUsage?: number;
    awake?: boolean;
    sampledAt?: number;
  } = {},
): LoadSample {
  return {
    sampledAt: overrides.sampledAt ?? NOW,
    running: overrides.running ?? 0,
    waiting: overrides.waiting ?? 0,
    kvUsage: overrides.kvUsage,
    source: "vllm",
    ...(overrides.awake === undefined ? {} : { awake: overrides.awake }),
  };
}

function twoNodes(): TargetConfig[] {
  return [target("node-a", 9393), target("node-b", 9394)];
}

function startedBalancer(config?: ProxyPair): LoadBalancer {
  const balancer = new LoadBalancer("pair-1");
  balancer.reconfigure(config ?? pair(twoNodes(), [group("lb-1", ["node-a", "node-b"])]));
  return balancer;
}

function planned(
  balancer: LoadBalancer,
  identityValue: TaskIdentity,
  samples?: Map<string, LoadSample>,
): LoadBalancerReservation {
  const match = balancer.matchGroup("Qwen3.8-Flash-Next");
  if (match === undefined) {
    throw new Error("the fixture group stopped matching the requested model");
  }
  const reservation = balancer.plan({
    group: match.group,
    identity: identityValue,
    samples,
    now: NOW,
  });
  if (reservation === undefined) {
    throw new Error("the load balancing group had no usable node");
  }
  return reservation;
}

describe("load balancing selection", () => {
  it("LB05-01 lets the first enabled matching group take the request", () => {
    const earlier = group("lb-first", ["node-a"], { model_pattern: "Qwen3.8-Flash-Next*" });
    const config = pair(twoNodes(), [earlier, group("lb-1", ["node-a", "node-b"])]);
    const balancer = startedBalancer(config);

    expect(balancer.matchGroup("Qwen3.8-Flash-Next")?.group.id).toBe("lb-first");
    expect(balancer.matchGroup("Qwen3.8-Flash-Next-Turbo")?.group.id).toBe("lb-first");

    const disabledFirst: ProxyPair = {
      ...config,
      load_balancers: config.load_balancers.map((entry, index) =>
        index === 0 ? { ...entry, enabled: false } : entry,
      ),
    };
    balancer.reconfigure(disabledFirst);
    expect(balancer.matchGroup("Qwen3.8-Flash-Next")?.group.id).toBe("lb-1");

    expect(balancer.matchGroup("SomeOther-Model")).toBeUndefined();
    expect(balancer.matchGroup("")).toBeUndefined();
  });

  it("LB05-02 alternates between two idle nodes through lastDispatchedAt", () => {
    const balancer = startedBalancer();
    const picked: string[] = [];

    ["one", "two", "three", "four"].forEach((turn, index) => {
      const reservation = planned(balancer, identity(`session-${turn}`, turn));
      expect(reservation.decision.decision).toBe("new_task");
      picked.push(reservation.decision.targetId);
      reservation.markDispatched(NOW + index);
      reservation.release();
    });

    expect(picked).toEqual(["node-a", "node-b", "node-a", "node-b"]);
  });

  it("LB05-03 keeps an affinity hit even when the bound node is the busier one", () => {
    const balancer = startedBalancer();
    const first = planned(balancer, identity("session-1", "one"));
    expect(first.decision.targetId).toBe("node-a");
    first.markDispatched(NOW);
    first.release();

    const samples = new Map<string, LoadSample>([
      ["node-a", sample({ running: 5, waiting: 2 })],
      ["node-b", sample({ running: 0, waiting: 0 })],
    ]);
    const second = planned(balancer, identity("session-1", "two"), samples);
    expect(second.decision).toMatchObject({
      targetId: "node-a",
      decision: "affinity",
      matchedBy: "exact_key",
      load: 0,
      metricsSource: "vllm",
    });
    second.release();

    // A cooling node keeps its task: moving the conversation would cost a cold prefill,
    // which is the more expensive mistake of the two.
    balancer.markCooldown("node-a", NOW + 10_000);
    const third = planned(balancer, identity("session-1", "three"), samples);
    expect(third.decision.targetId).toBe("node-a");
    third.release();

    // A task whose bound node disappeared from the group is rebound, not dropped.
    balancer.reconfigure(pair(twoNodes(), [group("lb-1", ["node-b"])]));
    const moved = planned(balancer, identity("session-1", "four"));
    expect(moved.decision).toMatchObject({ targetId: "node-b", decision: "new_task" });
    moved.release();
  });

  it("LB05-04 treats load as the larger of inFlight and running plus waiting", () => {
    const balancer = startedBalancer();
    balancer.reserve("node-b");
    balancer.reserve("node-b");

    const samples = new Map<string, LoadSample>([["node-a", sample({ running: 3, waiting: 1 })]]);
    expect(planned(balancer, identity("session-1", "one"), samples).decision).toMatchObject({
      targetId: "node-b",
      load: 2,
    });

    // Local reservations dominate a metric that has not caught up yet.
    ["node-a", "node-a", "node-a", "node-a", "node-a"].forEach(() => {
      balancer.reserve("node-a");
    });
    expect(planned(balancer, identity("session-2", "two"), samples).decision.targetId).toBe(
      "node-b",
    );

    // A nearly full KV cache moves a node into the second tier even when it is idle.
    const full = new Map<string, LoadSample>([
      ["node-a", sample({ running: 4, kvUsage: 0.2 })],
      ["node-b", sample({ running: 0, kvUsage: 0.95 })],
    ]);
    const tiered = startedBalancer();
    const tieredPlan = planned(tiered, identity("session-3", "three"), full);
    expect(tieredPlan.decision).toMatchObject({
      targetId: "node-a",
      kvUsage: 0.2,
    });
    tieredPlan.release();

    // A sample older than the freshness window stops counting as load at all.
    const stale = new Map<string, LoadSample>([
      [
        "node-a",
        sample({ running: 9, kvUsage: 0.95, sampledAt: NOW - METRIC_FRESH_WINDOW_MS - 1 }),
      ],
    ]);
    const stalePlan = planned(tiered, identity("session-4", "four"), stale);
    expect(stalePlan.decision).toMatchObject({
      targetId: "node-a",
      load: 0,
      kvUsage: undefined,
      metricsSource: undefined,
    });
    stalePlan.release();
  });

  it("LB05-05 lets round robin ignore metrics while still honouring cooldown", () => {
    const balancer = startedBalancer(
      pair(twoNodes(), [group("lb-1", ["node-a", "node-b"], { strategy: "round_robin" })]),
    );
    const samples = new Map<string, LoadSample>([
      ["node-a", sample({ running: 20, waiting: 4, kvUsage: 0.99 })],
      ["node-b", sample({ running: 0 })],
    ]);

    const first = planned(balancer, identity("session-1", "one"), samples);
    expect(first.decision).toMatchObject({ targetId: "node-a", strategy: "round_robin" });
    first.markDispatched(NOW);
    first.release();

    const second = planned(balancer, identity("session-2", "two"), samples);
    expect(second.decision.targetId).toBe("node-b");
    second.markDispatched(NOW + 1);
    second.release();

    balancer.markCooldown("node-b", NOW + 5_000);
    expect(balancer.cooldownRemaining("node-b", NOW)).toBe(5_000);
    const third = planned(balancer, identity("session-3", "three"), samples);
    expect(third.decision.targetId).toBe("node-a");
    third.release();
  });

  it("LB05-06 falls back to inFlight when no metrics exist yet", () => {
    const balancer = startedBalancer();
    balancer.reserve("node-a");
    expect(planned(balancer, identity("session-1", "one")).decision).toMatchObject({
      targetId: "node-b",
      load: 0,
      kvUsage: undefined,
      metricsSource: undefined,
    });

    balancer.reserve("node-b");
    const tied = planned(balancer, identity("session-2", "two"));
    expect(tied.decision).toMatchObject({ targetId: "node-a", load: 1 });
    tied.release();
    balancer.release("node-a");
    balancer.release("node-b");
  });

  it("LB05-07 excludes disabled and cooling nodes and reports when nothing is usable", () => {
    const nodes = twoNodes();
    const balancer = startedBalancer();
    balancer.reconfigure(
      pair(
        nodes.map((entry) => (entry.id === "node-b" ? { ...entry, enabled: false } : entry)),
        [group("lb-1", ["node-a", "node-b"])],
      ),
    );
    expect(planned(balancer, identity("session-1", "one")).decision.targetId).toBe("node-a");

    balancer.reconfigure(pair(nodes, [group("lb-1", ["node-a", "node-b"])]));
    balancer.markCooldown("node-a", NOW + 1_000);
    expect(planned(balancer, identity("session-2", "two")).decision.targetId).toBe("node-b");

    // When every node is cooling the group still serves: a short outage must not turn
    // into a permanent refusal.
    balancer.markCooldown("node-a", NOW + 30_000);
    balancer.markCooldown("node-b", NOW + 30_000);
    expect(
      balancer.plan({
        group: group("lb-1", ["node-a", "node-b"]),
        identity: identity("session-3", "three"),
        now: NOW,
      }),
    ).toBeDefined();

    // An engine that reported it is asleep is not a candidate for a new task.
    const sleeping = new Map<string, LoadSample>([
      ["node-a", sample({ awake: false })],
      ["node-b", sample({ awake: false })],
    ]);
    expect(
      balancer.plan({
        group: group("lb-1", ["node-a", "node-b"]),
        identity: identity("session-4", "four"),
        samples: sleeping,
        now: NOW,
      }),
    ).toBeUndefined();

    balancer.reconfigure(
      pair(
        nodes.map((entry) => ({ ...entry, enabled: false })),
        [group("lb-1", ["node-a", "node-b"])],
      ),
    );
    expect(
      balancer.plan({
        group: group("lb-1", ["node-a", "node-b"]),
        identity: identity("session-5", "five"),
        now: NOW,
      }),
    ).toBeUndefined();
  });

  it("LB05-10 releases a reservation only once, however many paths try to release it", () => {
    const balancer = startedBalancer();
    const reservation = planned(balancer, identity("session-1", "one"));
    expect(balancer.inFlight("node-a")).toBe(1);

    reservation.release();
    reservation.release();
    expect(balancer.inFlight("node-a")).toBe(0);
  });
});
