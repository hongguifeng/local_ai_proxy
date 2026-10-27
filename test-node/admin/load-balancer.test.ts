import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { applicationHealth, createAdminServer } from "../../src/admin/index.js";
import { LOAD_BALANCER_STATUS_RESPONSE_SCHEMA } from "../../src/admin/admin-schemas.js";
import {
  createDefaultProxyPair,
  createDefaultTarget,
  type ProxyPair,
  type TargetConfig,
} from "../../src/config/index.js";
import {
  ADVISE_OBSERVATION_POLICY,
  LoadBalancer,
  LoadMonitor,
  createLoadBalancerAdminService,
  taskIdentity,
  type LoadBalancerAdminSource,
  type LoadBalancerStatusResponse,
} from "../../src/proxy/index.js";
import type { BindingHistoryAssociation } from "../../src/maintenance/index.js";

type GroupShape = ProxyPair["load_balancers"][number];

const servers: ReturnType<typeof createAdminServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a port");
      }
      resolve(address.port);
    });
  });
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

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

function pair(
  id: string,
  targets: readonly TargetConfig[],
  groups: readonly GroupShape[],
): ProxyPair {
  return {
    ...createDefaultProxyPair("logs"),
    id,
    enabled: true,
    targets: [...targets],
    default_target_id: targets[0]?.id ?? "",
    load_balancers: [...groups],
  };
}

/** Public pair shape, as the manager hands it to the admin service. */
function publicPair(pair: ProxyPair, running = true) {
  return { ...pair, actual_listen_port: running ? 43123 : null, running };
}

/** What `listPairs()` returns when no listener was ever started for a pair. */
function emptyPair(id: string): ProxyPair {
  return { ...createDefaultProxyPair("logs"), id, load_balancers: [] };
}

/**
 * What a status-only stub reports when it holds no log root at all. The status endpoint never
 * asks this question, so the answer is only there to keep the source complete.
 */
const NO_HISTORY: BindingHistoryAssociation = {
  ambiguous: false,
  confidence: "none",
  coverage: {
    candidateRowsRead: 0,
    candidateScanLimit: 100,
    exactKeysExamined: 0,
    exactKeysLinked: 0,
    exactKeysOmitted: 0,
    exactKeysRequested: 0,
    exactKeysWithoutLink: 0,
    exactLinkRowsRead: 0,
    failure: null,
    historyRowsRead: 0,
    historyTruncated: false,
    latestStoredRecordAt: null,
    linkedTasksRead: 0,
    logRoot: null,
    logWriteMayBePending: false,
    returnedTaskLimit: 50,
    state: "no_log_configured",
  },
  reasons: ["no_log_configured"],
  tasks: [],
};

function source(
  pairs: readonly ProxyPair[],
  balancer: LoadBalancer | undefined,
  monitor: LoadMonitor | undefined,
): LoadBalancerAdminSource {
  return {
    bindingHistory: { queryBindingHistory: () => NO_HISTORY },
    loadBalancer: (pairId) => (pairId === "pair-a" ? balancer : undefined),
    loadMonitor: (pairId) => (pairId === "pair-a" ? monitor : undefined),
    logRootForTarget: () => undefined,
    pairs: () => pairs.map((item) => publicPair(item, item.id === "pair-a")),
  };
}

const VLLM_EXPOSITION = `vllm:num_requests_running{engine="0"} 3.0
vllm:num_requests_waiting{engine="0"} 2.0
vllm:kv_cache_usage_perc{engine="0"} 0.35
`;

/** An engine that counts how often it was asked anything. */
async function startCountingServer(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number; requests: () => number }> {
  let hits = 0;
  const server = http.createServer((request, response) => {
    hits += 1;
    handler(request, response);
  });
  const port = await listen(server);
  return { server, port, requests: () => hits };
}

/** An engine that carries no load, so the first task lands on it and gets bound there. */
const IDLE_EXPOSITION = `vllm:num_requests_running{engine="0"} 0.0
vllm:num_requests_waiting{engine="0"} 0.0
vllm:kv_cache_usage_perc{engine="0"} 0.1
`;

function identityFor(sessionId: string) {
  return taskIdentity({
    payload: { model: "Qwen3.8-Flash-Next", input: [{ role: "user", content: "one" }] },
    headers: { "x-claude-code-session-id": [sessionId] },
    path: "/v1/responses",
  });
}

describe("GET /api/load-balancer/status", () => {
  it("LB09-03 reports groups, bindings, cooldowns, stale metrics and pairs with no balancer", async () => {
    const engine = await startCountingServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(IDLE_EXPOSITION);
    });
    const balancer = new LoadBalancer("pair-a");
    balancer.reconfigure(
      pair(
        "pair-a",
        [
          target("target-a", `http://127.0.0.1:${engine.port}`),
          target("target-b", "http://127.0.0.1:1"),
        ],
        [
          group("lb-live", ["target-a", "target-b"]),
          group("lb-off", ["target-a"], { enabled: false, strategy: "round_robin" }),
        ],
      ),
    );
    let now = 1_000;
    const monitor = new LoadMonitor(balancer, { now: () => now });
    await monitor.sampleNow();

    // One task bound to one node, and one node put into cooldown.
    const reservation = balancer.plan({
      group: group("lb-live", ["target-a", "target-b"]),
      identity: identityFor("session-status"),
    });
    expect(reservation?.decision.targetId).toBe("target-a");
    reservation?.release();
    balancer.markFailure("target-a", Date.now());
    now = 20_000;

    const configuredPair = pair(
      "pair-a",
      [],
      [
        group("lb-live", ["target-a", "target-b"]),
        group("lb-off", ["target-a"], { enabled: false, strategy: "round_robin" }),
      ],
    );
    const idlePair = emptyPair("pair-b");
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      loadBalancerService: createLoadBalancerAdminService(
        source([configuredPair, idlePair], balancer, monitor),
      ),
    });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/api/load-balancer/status" });
    expect(response.statusCode).toBe(200);
    const body: LoadBalancerStatusResponse = response.json();
    expect(body.pairs.map((item) => item.id)).toEqual(["pair-a", "pair-b"]);
    const livePair = body.pairs[0];
    expect(livePair?.running).toBe(true);
    expect(livePair?.groups.map((item) => item.id)).toEqual(["lb-live", "lb-off"]);
    const live = livePair?.groups[0];
    expect(live?.bindings).toBe(1);
    expect(live?.nodeTargetIds).toEqual(["target-a", "target-b"]);
    // A cooldown is visible even though the node stayed enabled.
    expect(live?.nodes[0]?.cooldownRemainingMs).toBeGreaterThan(0);
    expect(live?.nodes[0]?.failures).toBe(1);

    const idle = body.pairs[1];
    expect(idle?.groups).toEqual([]);
    expect(idle?.running).toBe(false);
    expect(body.now).toBeGreaterThan(0);
    await close(engine.server);
  });

  it("LB09-03 the live pair shows bindings, cooldown, fresh and stale metrics side by side", async () => {
    const engine = await startCountingServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(VLLM_EXPOSITION);
    });
    const balancer = new LoadBalancer("pair-a");
    const configured = pair(
      "pair-a",
      [
        target("target-a", `http://127.0.0.1:${engine.port}`),
        target("target-b", "http://127.0.0.1:1"),
      ],
      [
        group("lb-live", ["target-a", "target-b"]),
        group("lb-off", ["target-a"], { enabled: false, strategy: "round_robin" }),
      ],
    );
    balancer.reconfigure(configured);
    let now = 1_000;
    const monitor = new LoadMonitor(balancer, { now: () => now });
    await monitor.sampleNow();

    const reservation = balancer.plan({
      group: group("lb-live", ["target-a", "target-b"]),
      identity: identityFor("session-status"),
    });
    expect(reservation?.decision.targetId).toBe("target-a");
    balancer.markDispatched("target-a", Date.now());
    reservation?.release();
    balancer.markFailure("target-a", Date.now());
    now = 20_000;

    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      loadBalancerService: createLoadBalancerAdminService(source([configured], balancer, monitor)),
    });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/api/load-balancer/status" });
    expect(response.statusCode).toBe(200);
    const body: LoadBalancerStatusResponse = response.json();
    expect(body.pairs).toHaveLength(1);
    const livePair = body.pairs[0];
    expect(livePair?.running).toBe(true);
    expect(livePair?.groups.map((item) => item.id)).toEqual(["lb-live", "lb-off"]);

    const live = livePair?.groups[0];
    expect(live?.bindings).toBe(1);
    expect(live?.nodeTargetIds).toEqual(["target-a", "target-b"]);
    expect(live?.modelPattern).toBe("Qwen3.8-Flash-Next");
    expect(live?.strategy).toBe("least_load");
    expect(live?.metricsEnabled).toBe(true);
    expect(live?.failoverEnabled).toBe(true);
    expect(live?.enabled).toBe(true);

    const sampled = live?.nodes[0];
    expect(sampled?.stale).toBe(true);
    expect(sampled?.metrics?.running).toBe(3);
    expect(sampled?.metrics?.kvUsage).toBe(0.35);
    expect(sampled?.cooldownRemainingMs).toBeGreaterThan(0);
    expect(sampled?.inFlight).toBe(0);
    expect(sampled?.failures).toBe(1);
    expect(sampled?.inRotation).toBe(false);
    expect(sampled?.bindings).toBe(1);
    expect(sampled?.lastDispatchedAt).toBeGreaterThan(0);
    expect(sampled?.canonicalKey).toContain("127.0.0.1");

    const unmeasured = live?.nodes[1];
    expect(unmeasured?.metrics).toBeNull();
    expect(unmeasured?.stale).toBe(true);
    expect(unmeasured?.bindings).toBe(0);
    expect(unmeasured?.inRotation).toBe(true);
    expect(unmeasured?.canonicalKey).toBe("http://127.0.0.1:1");
    expect(unmeasured?.enabled).toBe(true);

    // A disabled group keeps its configuration and carries no live state.
    const off = livePair?.groups[1];
    expect(off?.enabled).toBe(false);
    expect(off?.strategy).toBe("round_robin");
    expect(off?.bindings).toBe(0);
    await close(engine.server);
  });

  it("LB09-04 reading the status touches no engine and leaks no credential or request text", async () => {
    const engine = await startCountingServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(VLLM_EXPOSITION);
    });
    const balancer = new LoadBalancer("pair-a");
    const configured = pair(
      "pair-a",
      [
        target("target-a", `http://127.0.0.1:${engine.port}`, {
          target_api_key: "sk-secret-value",
        }),
      ],
      [group("lb-live", ["target-a"])],
    );
    balancer.reconfigure(configured);
    const monitor = new LoadMonitor(balancer);
    await monitor.sampleNow();
    const reservation = balancer.plan({
      group: group("lb-live", ["target-a"]),
      identity: taskIdentity({
        payload: {
          model: "Qwen3.8-Flash-Next",
          input: [{ role: "user", content: "private prompt" }],
        },
        headers: { "x-claude-code-session-id": ["session-leak"] },
        path: "/v1/responses",
      }),
    });
    reservation?.release();

    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      loadBalancerService: createLoadBalancerAdminService(source([configured], balancer, monitor)),
    });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/api/load-balancer/status" });
    expect(response.statusCode).toBe(200);
    // The engine was asked once, by the sampler, never by the status endpoint.
    expect(engine.requests()).toBe(1);
    const payload = response.payload;
    expect(payload).not.toContain("sk-secret-value");
    expect(payload).not.toContain("private prompt");
    expect(payload).not.toContain("session-leak");
    await close(engine.server);
  });

  it("LB09-06 an admin server without the service answers 404, and the model check route is gone", async () => {
    const server = createAdminServer({ getHealth: () => applicationHealth("running") });
    servers.push(server);
    const status = await server.inject({ method: "GET", url: "/api/load-balancer/status" });
    expect(status.statusCode).toBe(404);
    expect(status.json()).toMatchObject({ error: { code: "not_found" } });
    // The model check was removed with LB-16: the route no longer exists at all.
    const verify = await server.inject({
      method: "POST",
      url: "/api/load-balancer/verify-models",
      payload: { groupId: "lb-live", pairId: "pair-a" },
    });
    expect(verify.statusCode).toBe(404);
  });

  it("TRI-01 the status payload counts bindings and never hands out a binding number", () => {
    const balancer = new LoadBalancer("pair-a");
    balancer.reconfigure(
      pair("pair-a", [target("target-a", "http://127.0.0.1:1")], [group("lb-live", ["target-a"])]),
    );
    const table = balancer.tableFor("lb-live");
    if (table === undefined) {
      throw new Error("An enabled group must have an affinity table.");
    }
    const binding = table.bind(identityFor("session-addressing"), "target-a");
    const configured = pair("pair-a", [], [group("lb-live", ["target-a"])]);

    const status = createLoadBalancerAdminService(
      source([configured], balancer, undefined),
    ).getStatus();

    expect(status.pairs[0]?.groups[0]?.bindings).toBe(1);
    expect(status.pairs[0]?.groups[0]?.nodes[0]?.bindings).toBe(1);
    // The status view is a count per node, never a handle to one binding: a binding number
    // is only unique inside one runtime, so addressing by it across a restart would land on
    // a different task. Publishing an addressable identity is TRI-05 work.
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("bindingId");
    expect(serialized).not.toContain("routingRevision");
    expect(serialized).not.toContain(balancer.runtimeEpoch);
    expect(balancer.bindingRefFor("lb-live", binding).runtimeEpoch).toBe(balancer.runtimeEpoch);
  });
});

describe("[TRI-03] what the status endpoint says about an incomplete answer", () => {
  it("prints null for a number the engine skipped and keeps a real zero a zero", async () => {
    const idleEngine = await startCountingServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(IDLE_EXPOSITION);
    });
    const quietEngine = await startCountingServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end('vllm:kv_cache_usage_perc{engine="0"} 0.35\n');
    });
    const balancer = new LoadBalancer("pair-a");
    const configured = pair(
      "pair-a",
      [
        target("target-idle", `http://127.0.0.1:${idleEngine.port}`),
        target("target-quiet", `http://127.0.0.1:${quietEngine.port}`),
        target("target-none", "http://127.0.0.1:1"),
      ],
      [group("lb-live", ["target-idle", "target-quiet", "target-none"])],
    );
    balancer.reconfigure(configured);
    const monitor = new LoadMonitor(balancer, { now: () => 1_000 });
    await monitor.sampleNow();

    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      loadBalancerService: createLoadBalancerAdminService(source([configured], balancer, monitor)),
    });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/api/load-balancer/status" });
    expect(response.statusCode).toBe(200);
    const body: LoadBalancerStatusResponse = response.json();
    const nodes = body.pairs[0]?.groups[0]?.nodes ?? [];
    const byId = new Map(nodes.map((node) => [node.targetId, node]));

    const idle = byId.get("target-idle");
    expect(idle?.stale).toBe(false);
    expect(idle?.metrics?.running).toBe(0);
    expect(idle?.metrics?.waiting).toBe(0);

    // A node the engine never measured is shown as unknown, with the KV it did answer still
    // present, and it is not the same row as "no sample at all".
    const quiet = byId.get("target-quiet");
    expect(quiet?.metrics).not.toBeNull();
    expect(quiet?.stale).toBe(false);
    expect(quiet?.metrics?.running).toBeNull();
    expect(quiet?.metrics?.waiting).toBeNull();
    expect(quiet?.metrics?.kvUsage).toBe(0.35);
    expect(quiet?.metrics?.source).toBe("vllm");

    const unmeasured = byId.get("target-none");
    expect(unmeasured?.metrics).toBeNull();
    expect(unmeasured?.stale).toBe(true);

    // On the wire the unknown is an explicit null, so the browser cannot read it as a zero.
    expect(response.payload).toContain('"running":null');
    expect(response.payload).toContain('"waiting":null');

    await close(idleEngine.server);
    await close(quietEngine.server);
  });
});

describe("[TRI-10] what the real status route says about automatic rebalancing", () => {
  const sortedKeys = (value: object): string[] => Object.keys(value).sort();

  /**
   * Poll the real route until the advisor's live advice for one group is in its answer.
   * [TRI-10] It waits for the state, not for a non-empty list: the answer is newest-first, so
   * a refusal recorded after the advice became live can legitimately be the first item. Picking
   * by index would make the assertion depend on which record happened to land first.
   */
  async function waitForStatusAdvice(
    server: ReturnType<typeof createAdminServer>,
    groupId: string,
    timeoutMs = 5_000,
  ): Promise<{
    rebalance: LoadBalancerStatusResponse["pairs"][number]["groups"][number]["rebalance"];
    suggestion: LoadBalancerStatusResponse["pairs"][number]["groups"][number]["rebalance"]["suggestions"][number];
  }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const response = await server.inject({ method: "GET", url: "/api/load-balancer/status" });
      expect(response.statusCode).toBe(200);
      const body: LoadBalancerStatusResponse = response.json();
      const group = body.pairs[0]?.groups.find((item) => item.id === groupId);
      const rebalance = group?.rebalance;
      const suggestion = rebalance?.suggestions.find((item) => item.state === "suggested");
      if (rebalance !== undefined && suggestion !== undefined) {
        return { rebalance, suggestion };
      }
      if (Date.now() > deadline) {
        throw new Error(
          `No live advice through the route within ${timeoutMs} ms: ${response.payload.slice(0, 400)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it("answers the calibration verdict for every group through the assembled service", async () => {
    const engine = await startCountingServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(IDLE_EXPOSITION);
    });
    const balancer = new LoadBalancer("pair-a");
    const configured = pair(
      "pair-a",
      [target("target-a", `http://127.0.0.1:${engine.port}`)],
      [
        group("lb-off", ["target-a"]),
        group("lb-advise", ["target-a"], { rebalance_mode: "advise" }),
        group("lb-auto", ["target-a"], { rebalance_mode: "auto" }),
      ],
    );
    balancer.reconfigure(configured);
    // A monitor that was never started: nothing has been evaluated yet, which is exactly
    // the state the status answer must show - never a suggestion conjured from nothing.
    const monitor = new LoadMonitor(balancer, { now: () => 1_000 });

    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      loadBalancerService: createLoadBalancerAdminService(source([configured], balancer, monitor)),
    });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/api/load-balancer/status" });
    expect(response.statusCode).toBe(200);
    const body: LoadBalancerStatusResponse = response.json();
    const groups = body.pairs[0]?.groups ?? [];
    const byId = new Map(groups.map((group) => [group.id, group]));

    const off = byId.get("lb-off")?.rebalance;
    expect(off).toBeDefined();
    expect(sortedKeys(off ?? {})).toEqual(["calibrated", "disabledReason", "mode", "suggestions"]);
    expect(off?.mode).toBe("off");
    expect(off?.calibrated).toBe(false);
    expect(off?.disabledReason).toBeNull();
    expect(off?.suggestions).toEqual([]);

    const advise = byId.get("lb-advise")?.rebalance;
    expect(advise?.mode).toBe("advise");
    expect(advise?.calibrated).toBe(false);
    expect(advise?.disabledReason).toBeNull();
    expect(advise?.suggestions).toEqual([]);

    // The user asked for `auto`; until the TRI-11 calibration record exists the honest
    // answer is the named refusal, on the wire, through the real serializer.
    const auto = byId.get("lb-auto")?.rebalance;
    expect(auto?.mode).toBe("auto");
    expect(auto?.calibrated).toBe(false);
    expect(auto?.disabledReason).toBe("not_calibrated");
    expect(auto?.suggestions).toEqual([]);

    await close(engine.server);
  });

  it("shows advice born on the monitor's timer, with every suggestion key the schema declares", async () => {
    const busyEngine = await startCountingServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(VLLM_EXPOSITION);
    });
    const idleB = await startCountingServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(IDLE_EXPOSITION);
    });
    const idleC = await startCountingServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(IDLE_EXPOSITION);
    });
    const configured = pair(
      "pair-a",
      [
        target("target-a", `http://127.0.0.1:${busyEngine.port}`),
        target("target-b", `http://127.0.0.1:${idleB.port}`),
        target("target-c", `http://127.0.0.1:${idleC.port}`),
      ],
      [group("lb-adv", ["target-a", "target-b", "target-c"], { rebalance_mode: "advise" })],
    );
    const balancer = new LoadBalancer("pair-a");
    balancer.reconfigure(configured);

    // A binding on the busy engine with a real request boundary behind it. The same
    // identity is bound and re-planned, so the second request lands on that binding.
    const leakIdentity = taskIdentity({
      payload: {
        model: "Qwen3.8-Flash-Next",
        input: [{ role: "user", content: "private rebalance prompt" }],
      },
      headers: { "x-claude-code-session-id": ["session-rebalance-leak"] },
      path: "/v1/responses",
    });
    const table = balancer.tableFor("lb-adv");
    if (table === undefined) {
      throw new Error("An enabled group must have an affinity table.");
    }
    const binding = table.bind(leakIdentity, "target-a");
    const ref = balancer.bindingRefFor("lb-adv", binding);
    balancer.noteBindingRequestBytes(ref, 2_048);
    balancer.recordBindingUsage(ref, {
      status: "complete",
      endpoint: "responses",
      inputTokens: 1_840,
      cacheReadTokens: 900,
    });
    const firstGroup = configured.load_balancers[0];
    if (firstGroup === undefined) {
      throw new Error("The fixture pair lost its group.");
    }
    const reservation = balancer.plan({ group: firstGroup, identity: leakIdentity });
    expect(reservation?.decision.targetId).toBe("target-a");
    reservation?.release();

    const monitor = new LoadMonitor(balancer, { sampleIntervalMs: 25 });
    monitor.start();
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      loadBalancerService: createLoadBalancerAdminService(source([configured], balancer, monitor)),
    });
    servers.push(server);

    try {
      const { rebalance, suggestion } = await waitForStatusAdvice(server, "lb-adv");
      expect(rebalance.mode).toBe("advise");
      expect(rebalance.calibrated).toBe(false);
      expect(rebalance.disabledReason).toBeNull();
      expect(sortedKeys(suggestion)).toEqual([
        "bindingId",
        "costEstimated",
        "costSource",
        "createdAt",
        "destinationTargetId",
        "incarnation",
        "inputTokens",
        "requestBytes",
        "routingRevision",
        "sourceTargetId",
        "stableSamples",
        "state",
        "stateReason",
        "suggestionId",
      ]);
      expect(suggestion.state).toBe("suggested");
      expect(suggestion.stateReason).toBeNull();
      expect(suggestion.sourceTargetId).toBe("target-a");
      expect(suggestion.destinationTargetId).toBe("target-b");
      expect(suggestion.costSource).toBe("normalized_usage");
      expect(suggestion.costEstimated).toBe(false);
      expect(suggestion.inputTokens).toBe(1_840);
      expect(suggestion.stableSamples).toBeGreaterThanOrEqual(2);
      expect(suggestion.suggestionId).toMatch(/^[0-9a-f]{32}$/);

      // A suggestion is an address inside one runtime, and nothing more: it names ids and
      // targets, never the conversation that produced them. The route answers it, and the
      // wire carries none of the request's private parts.
      const leakCheck = await server.inject({
        method: "GET",
        url: "/api/load-balancer/status",
      });
      expect(leakCheck.payload).not.toContain("session-rebalance-leak");
      expect(leakCheck.payload).not.toContain("private rebalance prompt");
      const snapshot = balancer.bindingSnapshot("lb-adv");
      expect(snapshot?.entries[0]?.targetId).toBe("target-a");
      expect(snapshot?.entries[0]?.ref.routingRevision).toBe(0);
      expect(balancer.migrationOperations()).toEqual([]);
    } finally {
      monitor.stop();
      await close(busyEngine.server);
      await close(idleB.server);
      await close(idleC.server);
    }
  });

  it("answers the configured mode with no suggestions when the pair has no monitor", () => {
    const balancer = new LoadBalancer("pair-a");
    const configured = pair(
      "pair-a",
      [target("target-a", "http://127.0.0.1:1")],
      [group("lb-auto", ["target-a"], { rebalance_mode: "auto" })],
    );
    balancer.reconfigure(configured);
    const status = createLoadBalancerAdminService(
      source([configured], balancer, undefined),
    ).getStatus();

    // A stopped pair has no monitor to ask: the honest answer is the configured mode with
    // the calibration verdict on it and the named refusal for `auto` - nothing was evaluated.
    const rebalance = status.pairs[0]?.groups[0]?.rebalance;
    expect(rebalance).toBeDefined();
    expect(rebalance?.mode).toBe("auto");
    expect(rebalance?.calibrated).toBe(false);
    expect(rebalance?.disabledReason).toBe("not_calibrated");
    expect(rebalance?.suggestions).toEqual([]);
  });

  /**
   * [TRI-10] The declared response cap and the advisor's own storage ceiling must agree: a
   * list the serializer refuses would turn advice into an error answer. The cap is read out
   * of the JSON schema the route is registered with, so this cannot pass by copying a literal.
   */
  it("declares a suggestion list big enough for the advisor's production ceiling", () => {
    type SchemaNode = Readonly<Record<string, unknown>>;
    const step = (node: SchemaNode | undefined, key: string): SchemaNode | undefined => {
      if (node === undefined) {
        return undefined;
      }
      const properties = node["properties"] as SchemaNode | undefined;
      const direct = properties?.[key] as SchemaNode | undefined;
      if (direct !== undefined) {
        return direct;
      }
      const items = node["items"] as SchemaNode | undefined;
      return step(items, key);
    };
    const walk = (keys: readonly string[]): SchemaNode | undefined =>
      keys.reduce<SchemaNode | undefined>(
        (current, key) => step(current, key),
        LOAD_BALANCER_STATUS_RESPONSE_SCHEMA,
      );

    const suggestions = walk(["pairs", "groups", "rebalance", "suggestions"]);
    const declaredCap = suggestions?.["maxItems"];
    expect(declaredCap).toBeTypeOf("number");
    expect(declaredCap as number).toBeGreaterThanOrEqual(
      ADVISE_OBSERVATION_POLICY.maxSuggestionsPerGroup,
    );
  });
});
