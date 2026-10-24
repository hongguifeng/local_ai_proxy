import { describe, expect, it } from "vitest";

import {
  createDefaultProxyPair,
  createDefaultTarget,
  type ProxyPair,
  type TargetConfig,
} from "../../src/config/index.js";

import { LoadBalancer, taskIdentity } from "../../src/proxy/index.js";

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
