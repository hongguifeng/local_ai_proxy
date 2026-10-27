import { describe, expect, it } from "vitest";

import {
  createDefaultProxyPair,
  createDefaultTarget,
  type ProxyPair,
  type TargetConfig,
} from "../../src/config/index.js";

import {
  INITIAL_GROUP_REVISION,
  INITIAL_ROUTING_REVISION,
  LoadBalancer,
  taskIdentity,
} from "../../src/proxy/index.js";

type GroupShape = ProxyPair["load_balancers"][number];

function target(id: string, url: string, overrides: Partial<TargetConfig> = {}): TargetConfig {
  return {
    ...createDefaultTarget("logs"),
    id,
    name: id,
    target_url: url,
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

function identity(sessionId: string, turn = "one") {
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

function pairWithBothSpellings(): ProxyPair {
  return pair(
    [target("node-a", "http://localhost:9393/v1"), target("node-b", "http://127.0.0.1:9393/v1")],
    [group("lb-1", ["node-a", "node-b"])],
  );
}

describe("load balancer lifecycle state", () => {
  it("LB04-03 keeps independent affinity for two targets of the same engine", () => {
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(pairWithBothSpellings());

    const canonical = balancer.nodeFor("node-a")?.canonicalKey;
    expect(canonical).toBe(balancer.nodeFor("node-b")?.canonicalKey);
    expect(balancer.targetsForCanonicalKey(canonical ?? "")).toEqual(["node-a", "node-b"]);

    const table = balancer.tableFor("lb-1");
    if (table === undefined) {
      throw new Error("Expected a group table.");
    }
    table.bind(identity("session-1", "one"), "node-a");
    table.bind(identity("session-2", "two"), "node-b");

    expect(table.lookup(identity("session-1", "one"))?.binding.targetId).toBe("node-a");
    expect(table.lookup(identity("session-2", "two"))?.binding.targetId).toBe("node-b");
    expect(table.size).toBe(2);
  });

  it("LB04-03 reuses the node object identity across a reload", () => {
    const balancer = new LoadBalancer("pair-1");
    const first = pairWithBothSpellings();
    balancer.reconfigure(first);
    const node = balancer.nodeFor("node-a");

    balancer.reconfigure(first);
    expect(balancer.nodeFor("node-a")).toBe(node);
    expect(balancer.groupIds()).toEqual(["lb-1"]);
    expect(balancer.tableFor("lb-1")).toBeDefined();
  });

  it("LB04-03 rewrites the canonical key when only the URL spelling changes", () => {
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(
      pair([target("node-a", "http://LOCALHOST:9393/v1/")], [group("lb-1", ["node-a"])]),
    );
    expect(balancer.nodeFor("node-a")?.canonicalKey).toBe("http://127.0.0.1:9393/v1");

    balancer.reconfigure(
      pair([target("node-a", "http://127.0.0.1:9393/v1")], [group("lb-1", ["node-a"])]),
    );
    expect(balancer.nodeFor("node-a")?.canonicalKey).toBe("http://127.0.0.1:9393/v1");
  });

  it("keeps bindings when the configuration did not change", () => {
    const balancer = new LoadBalancer("pair-1");
    const config = pairWithBothSpellings();
    balancer.reconfigure(config);
    const table = balancer.tableFor("lb-1");
    if (table === undefined) {
      throw new Error("Expected a group table.");
    }
    table.bind(identity("session-1", "one"), "node-a");

    balancer.reconfigure(config);
    expect(table.size).toBe(1);
    expect(table.lookup(identity("session-1", "one"))?.binding.targetId).toBe("node-a");
  });

  it("prunes bindings of a node that left the configuration", () => {
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(pairWithBothSpellings());
    const table = balancer.tableFor("lb-1");
    if (table === undefined) {
      throw new Error("Expected a group table.");
    }
    table.bind(identity("session-1", "one"), "node-a");
    table.bind(identity("session-2", "two"), "node-b");

    balancer.reconfigure(
      pair([target("node-a", "http://localhost:9393/v1")], [group("lb-1", ["node-a"])]),
    );
    expect(table.size).toBe(1);
    expect(table.lookup(identity("session-2", "two"))).toBeUndefined();
    expect(table.lookup(identity("session-1", "one"))?.binding.targetId).toBe("node-a");
  });

  it("prunes bindings of a node that was disabled but stays configured", () => {
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(pairWithBothSpellings());
    const table = balancer.tableFor("lb-1");
    if (table === undefined) {
      throw new Error("Expected a group table.");
    }
    table.bind(identity("session-1", "one"), "node-a");
    table.bind(identity("session-2", "two"), "node-b");

    balancer.reconfigure(
      pair(
        [
          target("node-a", "http://localhost:9393/v1"),
          target("node-b", "http://127.0.0.1:9393/v1", { enabled: false }),
        ],
        [group("lb-1", ["node-a", "node-b"])],
      ),
    );
    expect(table.size).toBe(1);
    expect(table.lookup(identity("session-2", "two"))).toBeUndefined();
    expect(balancer.nodeFor("node-b")?.enabled).toBe(false);
  });

  it("prunes only the group whose membership changed", () => {
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(
      pair(
        [
          target("node-a", "http://localhost:9393/v1"),
          target("node-b", "http://127.0.0.1:9393/v1"),
          target("node-c", "http://127.0.0.1:9395/v1"),
        ],
        [
          group("lb-1", ["node-a", "node-b"]),
          group("lb-2", ["node-a", "node-c"], { model_pattern: "Other-Model" }),
        ],
      ),
    );
    const first = balancer.tableFor("lb-1");
    const second = balancer.tableFor("lb-2");
    if (first === undefined || second === undefined) {
      throw new Error("Expected both group tables.");
    }
    first.bind(identity("session-1", "one"), "node-a");
    first.bind(identity("session-2", "two"), "node-b");
    second.bind(identity("session-3", "three"), "node-c");

    balancer.reconfigure(
      pair(
        [
          target("node-a", "http://localhost:9393/v1"),
          target("node-b", "http://127.0.0.1:9393/v1"),
          target("node-c", "http://127.0.0.1:9395/v1"),
        ],
        [group("lb-1", ["node-a"]), group("lb-2", ["node-a", "node-c"])],
      ),
    );
    expect(first.size).toBe(1);
    expect(second.size).toBe(1);
    expect(second.lookup(identity("session-3", "three"))?.binding.targetId).toBe("node-c");
  });

  it("drops the table of a removed group and keeps the rest", () => {
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(
      pair(
        [target("node-a", "http://localhost:9393/v1")],
        [group("lb-1", ["node-a"]), group("lb-2", ["node-a"], { model_pattern: "Other" })],
      ),
    );
    const first = balancer.tableFor("lb-1");
    const second = balancer.tableFor("lb-2");
    if (first === undefined || second === undefined) {
      throw new Error("Expected both group tables.");
    }
    first.bind(identity("session-1", "one"), "node-a");
    second.bind(identity("session-2", "two"), "node-a");

    balancer.reconfigure(
      pair([target("node-a", "http://localhost:9393/v1")], [group("lb-1", ["node-a"])]),
    );
    expect(balancer.tableFor("lb-2")).toBeUndefined();
    expect(balancer.tableFor("lb-1")).toBe(first);
    expect(first.size).toBe(1);
    expect(second.size).toBe(1);
  });

  it("keeps reservations across a reload and releases them exactly once", () => {
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(pairWithBothSpellings());
    balancer.reserve("node-a");
    balancer.reserve("node-a");
    balancer.reserve("node-b");
    expect(balancer.inFlight("node-a")).toBe(2);

    // A reload replaces the pipeline; reservations belong to the pair, not the pipeline.
    balancer.reconfigure(
      pair([target("node-a", "http://localhost:9393/v1")], [group("lb-1", ["node-a"])]),
    );
    expect(balancer.inFlight("node-a")).toBe(2);
    expect(balancer.inFlight("node-b")).toBe(1);
    expect(balancer.nodeFor("node-b")).toBeUndefined();

    balancer.release("node-a");
    balancer.release("node-b");
    expect(balancer.inFlight("node-a")).toBe(1);
    expect(balancer.inFlight("node-b")).toBe(0);

    balancer.release("node-a");
    balancer.release("node-a");
    expect(balancer.inFlight("node-a")).toBe(0);
  });

  it("clears everything on shutdown", () => {
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(pairWithBothSpellings());
    const table = balancer.tableFor("lb-1");
    if (table === undefined) {
      throw new Error("Expected a group table.");
    }
    table.bind(identity("session-1", "one"), "node-a");
    balancer.reserve("node-a");

    balancer.clear();
    expect(table.size).toBe(0);
    expect(balancer.groupIds()).toEqual([]);
    expect(balancer.tableFor("lb-1")).toBeUndefined();
    expect(balancer.inFlight("node-a")).toBe(0);
    // The node view stays: it describes the configured targets, and the pair object that
    // owns it is dropped by the runtime registry on stop.
    expect(balancer.nodes().map((node) => node.targetId)).toEqual(["node-a", "node-b"]);
    expect(balancer.snapshot()).toEqual({
      pairId: "pair-1",
      groupIds: [],
      nodes: [
        {
          targetId: "node-a",
          canonicalKey: "http://127.0.0.1:9393/v1",
          enabled: true,
          inFlight: 0,
        },
        {
          targetId: "node-b",
          canonicalKey: "http://127.0.0.1:9393/v1",
          enabled: true,
          inFlight: 0,
        },
      ],
      bindings: {},
    });
  });

  it("reports nodes, bindings and reservations together", () => {
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(pairWithBothSpellings());
    balancer.tableFor("lb-1")?.bind(identity("session-1", "one"), "node-a");
    balancer.reserve("node-b");

    expect(balancer.snapshot()).toEqual({
      pairId: "pair-1",
      groupIds: ["lb-1"],
      nodes: [
        {
          targetId: "node-a",
          canonicalKey: "http://127.0.0.1:9393/v1",
          enabled: true,
          inFlight: 0,
        },
        {
          targetId: "node-b",
          canonicalKey: "http://127.0.0.1:9393/v1",
          enabled: true,
          inFlight: 1,
        },
      ],
      bindings: { "lb-1": 1 },
    });
  });
});

function tableOf(balancer: LoadBalancer, groupId: string) {
  const table = balancer.tableFor(groupId);
  if (table === undefined) {
    throw new Error(`The group ${groupId} must have an affinity table.`);
  }
  return table;
}

function planned(
  balancer: LoadBalancer,
  groupShape: GroupShape,
  sessionId: string,
  turn: string,
  exclude?: ReadonlySet<string>,
) {
  const reservation = balancer.plan({
    group: groupShape,
    identity: identity(sessionId, turn),
    exclude,
  });
  if (reservation === undefined) {
    throw new Error("The load balancing group must have a usable node.");
  }
  return reservation;
}

describe("TRI-01 runtime identity and group versions", () => {
  it("TRI-01 each runtime has its own epoch and resolves only its own references", () => {
    const config = pairWithBothSpellings();
    const first = new LoadBalancer("pair-1");
    first.reconfigure(config);
    const second = new LoadBalancer("pair-1");
    second.reconfigure(config);

    expect(first.runtimeEpoch).not.toBe(second.runtimeEpoch);

    const binding = tableOf(first, "lb-1").bind(identity("session-1", "one"), "node-a");
    const firstRef = first.bindingRefFor("lb-1", binding);
    expect(firstRef.runtimeEpoch).toBe(first.runtimeEpoch);
    expect(first.bindingForRef(firstRef)).toBe(binding);

    // The next runtime numbers its first binding with the same integer.
    const newcomer = tableOf(second, "lb-1").bind(identity("session-2", "two"), "node-b");
    const secondRef = second.bindingRefFor("lb-1", newcomer);
    expect(newcomer.id).toBe(firstRef.bindingId);

    expect(second.bindingForRef(firstRef)).toBeUndefined();
    expect(first.bindingForRef(secondRef)).toBeUndefined();
    expect(second.bindingForRef(secondRef)).toBe(newcomer);
  });

  it("TRI-01 a rebuilt group table that reuses a binding number is not reachable", () => {
    const config = pairWithBothSpellings();
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(config);

    const binding = tableOf(balancer, "lb-1").bind(identity("session-1", "one"), "node-a");
    const ref = balancer.bindingRefFor("lb-1", binding);
    const revisionBefore = balancer.groupRevision("lb-1");

    // The group leaves the configuration and comes back with a brand new table.
    balancer.reconfigure(pair([target("node-a", "http://localhost:9393/v1")], []));
    expect(balancer.tableFor("lb-1")).toBeUndefined();
    expect(balancer.groupRevision("lb-1")).toBeUndefined();

    balancer.reconfigure(config);
    const newcomer = tableOf(balancer, "lb-1").bind(identity("session-2", "two"), "node-a");
    expect(newcomer.id).toBe(ref.bindingId);
    expect(newcomer.incarnation).not.toBe(ref.incarnation);
    expect(balancer.bindingForRef(ref)).toBeUndefined();
    expect(balancer.groupRevision("lb-1")).toBeGreaterThan(revisionBefore ?? 0);
  });

  it("TRI-01 clearing a runtime frees bindings without replaying their numbers", () => {
    const config = pairWithBothSpellings();
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(config);
    const binding = tableOf(balancer, "lb-1").bind(identity("session-1", "one"), "node-a");
    const ref = balancer.bindingRefFor("lb-1", binding);
    expect(balancer.groupRevision("lb-1")).toBe(INITIAL_GROUP_REVISION);

    balancer.clear();
    expect(balancer.groupIds()).toStrictEqual([]);
    // The group revision belongs to the runtime, so it is still owned and still 1.
    expect(balancer.groupRevision("lb-1")).toBe(INITIAL_GROUP_REVISION);

    balancer.reconfigure(config);
    const newcomer = tableOf(balancer, "lb-1").bind(identity("session-2", "two"), "node-a");
    expect(newcomer.id).toBe(ref.bindingId);
    expect(newcomer.incarnation).not.toBe(ref.incarnation);
    expect(balancer.bindingForRef(ref)).toBeUndefined();
    expect(balancer.groupRevision("lb-1")).toBe(INITIAL_GROUP_REVISION);
  });

  it("TRI-01 the failover path moves the routing revision of the same binding", () => {
    const config = pairWithBothSpellings();
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(config);
    const groupShape = config.load_balancers[0];
    if (groupShape === undefined) {
      throw new Error("The fixture pair must carry its group.");
    }

    const binding = tableOf(balancer, "lb-1").bind(identity("session-1", "one"), "node-b");
    const before = balancer.bindingRefFor("lb-1", binding);
    expect(before.routingRevision).toBe(INITIAL_ROUTING_REVISION);

    // The ordinary affinity path moves nothing.
    const affinity = planned(balancer, groupShape, "session-1", "one");
    expect(affinity.decision.targetId).toBe("node-b");
    expect(affinity.bindingRef).toStrictEqual(before);

    // What the pipeline does when a node refuses the connection: plan again with the bound
    // node excluded. The task moves, and the move is visible as a new revision.
    const switched = planned(balancer, groupShape, "session-1", "one", new Set(["node-b"]));
    expect(switched.decision.targetId).toBe("node-a");
    expect(switched.binding).toBe(binding);
    expect(switched.bindingRef.routingRevision).toBe(before.routingRevision + 1);
    expect(switched.bindingRef.incarnation).toBe(before.incarnation);
    expect(switched.bindingRef.runtimeEpoch).toBe(balancer.runtimeEpoch);
    expect(binding.routingRevision).toBe(before.routingRevision + 1);
    expect(binding.targetId).toBe("node-a");
    expect(balancer.bindingForRef(before)?.routingRevision).not.toBe(before.routingRevision);
  });

  it("TRI-01 groupRevision moves when something that routes moved", () => {
    const nodeA = target("node-a", "http://localhost:9393/v1");
    const nodeB = target("node-b", "http://127.0.0.1:9393/v1");
    const nodeIds = ["node-a", "node-b"];
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(pair([nodeA, nodeB], [group("lb-1", nodeIds)]));
    expect(balancer.groupRevision("lb-1")).toBe(INITIAL_GROUP_REVISION);

    // A different URL for a member.
    balancer.reconfigure(
      pair([target("node-a", "http://localhost:9394/v1"), nodeB], [group("lb-1", nodeIds)]),
    );
    expect(balancer.groupRevision("lb-1")).toBe(INITIAL_GROUP_REVISION + 1);

    // The model name forwarded to a member.
    balancer.reconfigure(
      pair(
        [nodeA, nodeB],
        [
          group("lb-1", nodeIds, {
            members: [
              { target_id: "node-a", model_id: "other-model" },
              { target_id: "node-b", model_id: "" },
            ],
          }),
        ],
      ),
    );
    expect(balancer.groupRevision("lb-1")).toBe(INITIAL_GROUP_REVISION + 2);

    // A request transform on a member.
    balancer.reconfigure(
      pair(
        [
          target("node-a", "http://localhost:9393/v1", { strip_request_fields: "instructions" }),
          nodeB,
        ],
        [group("lb-1", nodeIds)],
      ),
    );
    expect(balancer.groupRevision("lb-1")).toBe(INITIAL_GROUP_REVISION + 3);

    // Where a member writes its logs.
    balancer.reconfigure(
      pair(
        [nodeA, target("node-b", "http://127.0.0.1:9393/v1", { log_root: "other/logs" })],
        [group("lb-1", nodeIds)],
      ),
    );
    expect(balancer.groupRevision("lb-1")).toBe(INITIAL_GROUP_REVISION + 4);

    // A member leaves the group.
    balancer.reconfigure(pair([nodeA, nodeB], [group("lb-1", ["node-a"])]));
    expect(balancer.groupRevision("lb-1")).toBe(INITIAL_GROUP_REVISION + 5);

    // A member was disabled but stayed configured.
    balancer.reconfigure(
      pair(
        [target("node-a", "http://localhost:9393/v1", { enabled: false }), nodeB],
        [group("lb-1", nodeIds)],
      ),
    );
    expect(balancer.groupRevision("lb-1")).toBe(INITIAL_GROUP_REVISION + 6);
  });

  it("TRI-01 renaming a group or repeating the same configuration moves no revision", () => {
    const config = pairWithBothSpellings();
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(config);
    expect(balancer.groupRevision("lb-1")).toBe(INITIAL_GROUP_REVISION);

    balancer.reconfigure(config);
    expect(balancer.groupRevision("lb-1")).toBe(INITIAL_GROUP_REVISION);

    balancer.reconfigure(
      pair(config.targets, [group("lb-1", ["node-a", "node-b"], { name: "Qwen pool" })]),
    );
    expect(balancer.groupRevision("lb-1")).toBe(INITIAL_GROUP_REVISION);
    expect(balancer.groupFor("lb-1")?.name).toBe("Qwen pool");
  });
});
