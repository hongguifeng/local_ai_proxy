import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { applicationHealth, createAdminServer } from "../../src/admin/index.js";
import {
  createDefaultProxyPair,
  createDefaultTarget,
  type ProxyPair,
  type TargetConfig,
} from "../../src/config/index.js";
import {
  LoadBalancer,
  LoadMonitor,
  createLoadBalancerAdminService,
  taskIdentity,
  type LoadBalancerAdminSource,
  type LoadBalancerStatusResponse,
} from "../../src/proxy/index.js";

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
    node_target_ids: [...nodeTargetIds],
    strategy: "least_load",
    metrics_enabled: true,
    failover_enabled: true,
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

function source(
  pairs: readonly ProxyPair[],
  balancer: LoadBalancer | undefined,
  monitor: LoadMonitor | undefined,
): LoadBalancerAdminSource {
  return {
    loadBalancer: (pairId) => (pairId === "pair-a" ? balancer : undefined),
    loadMonitor: (pairId) => (pairId === "pair-a" ? monitor : undefined),
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
});
