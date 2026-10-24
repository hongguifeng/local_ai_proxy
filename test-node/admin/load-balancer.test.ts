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
  type LoadBalancerVerifyModelsResponse,
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

function jsonModelList(models: readonly string[]) {
  return (_request: http.IncomingMessage, response: http.ServerResponse): void => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id })) }));
  };
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

  it("LB09-06 an admin server without the service answers 404 on both routes", async () => {
    const server = createAdminServer({ getHealth: () => applicationHealth("running") });
    servers.push(server);
    const status = await server.inject({ method: "GET", url: "/api/load-balancer/status" });
    expect(status.statusCode).toBe(404);
    expect(status.json()).toMatchObject({ error: { code: "not_found" } });
    const verify = await server.inject({
      method: "POST",
      url: "/api/load-balancer/verify-models",
      payload: { groupId: "lb-live", pairId: "pair-a" },
    });
    expect(verify.statusCode).toBe(404);
  });
});

describe("POST /api/load-balancer/verify-models", () => {
  it("LB09-05 reports what each node serves, including a base-path fallback and a timeout", async () => {
    const matching = await startCountingServer(
      jsonModelList(["Qwen3.8-Flash-Next", "other-model"]),
    );
    const missing = await startCountingServer(jsonModelList(["Different-Model"]));
    const rooted = await startCountingServer((request, response) => {
      if (request.url === "/v1/models") {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("no route");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "Qwen3.8-Flash-Next" }] }));
    });
    const hanging = await startCountingServer(() => {
      // Never answers: the service timeout has to end this.
    });
    const html = await startCountingServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><body>not a model list</body></html>");
    });

    const configured = pair(
      "pair-a",
      [
        target("target-matching", `http://127.0.0.1:${matching.port}/v1`),
        target("target-missing", `http://127.0.0.1:${missing.port}`),
        target("target-rooted", `http://127.0.0.1:${rooted.port}/v1`),
        target("target-hanging", `http://127.0.0.1:${hanging.port}`),
        target("target-html", `http://127.0.0.1:${html.port}`),
      ],
      [
        group("lb-verify", [
          "target-matching",
          "target-missing",
          "target-rooted",
          "target-hanging",
          "target-html",
          "target-gone",
        ]),
      ],
    );
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      loadBalancerService: createLoadBalancerAdminService(
        source([configured], undefined, undefined),
        { verifyTimeoutMs: 120 },
      ),
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/load-balancer/verify-models",
      payload: { groupId: "lb-verify", pairId: "pair-a" },
    });
    expect(response.statusCode).toBe(200);
    const body: LoadBalancerVerifyModelsResponse = response.json();
    expect(body.pairId).toBe("pair-a");
    expect(body.groupId).toBe("lb-verify");
    expect(body.source).toBe("saved");
    expect(body.modelPattern).toBe("Qwen3.8-Flash-Next");
    expect(body.nodes.map((node) => node.targetId)).toEqual([
      "target-matching",
      "target-missing",
      "target-rooted",
      "target-hanging",
      "target-html",
      "target-gone",
    ]);

    const byId = new Map(body.nodes.map((node) => [node.targetId, node]));
    const match = byId.get("target-matching");
    expect(match?.ok).toBe(true);
    expect(match?.matched).toEqual(["Qwen3.8-Flash-Next"]);
    expect(match?.models).toEqual(["Qwen3.8-Flash-Next", "other-model"]);
    expect(match?.status).toBe(200);

    // A node that answers but does not serve the pattern is still reachable.
    const absent = byId.get("target-missing");
    expect(absent?.ok).toBe(true);
    expect(absent?.matched).toEqual([]);
    expect(absent?.models).toEqual(["Different-Model"]);

    // The base path is tried first, then the host root.
    const root = byId.get("target-rooted");
    expect(root?.ok).toBe(true);
    expect(root?.matched).toEqual(["Qwen3.8-Flash-Next"]);
    expect(rooted.requests()).toBe(2);

    const timedOut = byId.get("target-hanging");
    expect(timedOut?.ok).toBe(false);
    expect(timedOut?.status).toBeNull();
    expect(String(timedOut?.error)).toContain("timeout");
    expect(timedOut?.durationMs).toBeGreaterThanOrEqual(100);

    const notJson = byId.get("target-html");
    expect(notJson?.ok).toBe(false);
    expect(notJson?.error).toBe("model list is not JSON");
    expect(notJson?.status).toBe(200);

    // A target the pair no longer has is reported instead of silently skipped.
    const gone = byId.get("target-gone");
    expect(gone?.ok).toBe(false);
    expect(gone?.error).toBe("target is not configured in this pair");

    await Promise.all(
      [matching, missing, rooted, hanging, html].map(
        async (fixture) => await close(fixture.server),
      ),
    );
  });

  it("LB09-05 an unknown pair or group answers 404 with a code", async () => {
    const configured = pair(
      "pair-a",
      [target("target-a", "http://127.0.0.1:1")],
      [group("lb-live", ["target-a"])],
    );
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      loadBalancerService: createLoadBalancerAdminService(
        source([configured], undefined, undefined),
      ),
    });
    servers.push(server);

    const missingGroup = await server.inject({
      method: "POST",
      url: "/api/load-balancer/verify-models",
      payload: { groupId: "lb-nope", pairId: "pair-a" },
    });
    expect(missingGroup.statusCode).toBe(404);
    expect(missingGroup.json()).toMatchObject({
      error: { code: "load_balancer_group_not_found" },
    });

    const missingPair = await server.inject({
      method: "POST",
      url: "/api/load-balancer/verify-models",
      payload: { groupId: "lb-live", pairId: "pair-nope" },
    });
    expect(missingPair.statusCode).toBe(404);
  });

  it("LB09-05 a bad request body is rejected before any upstream call", async () => {
    const engine = await startCountingServer(jsonModelList(["Qwen3.8-Flash-Next"]));
    const configured = pair(
      "pair-a",
      [target("target-a", `http://127.0.0.1:${engine.port}`)],
      [group("lb-live", ["target-a"])],
    );
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      loadBalancerService: createLoadBalancerAdminService(
        source([configured], undefined, undefined),
      ),
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/load-balancer/verify-models",
      payload: { groupId: "" },
    });
    expect(response.statusCode).toBe(400);
    expect(engine.requests()).toBe(0);
    await close(engine.server);
  });

  it("LB14-01 verifies a group that was never saved", async () => {
    const served = await startCountingServer(jsonModelList(["Qwen3.8-Flash-Next", "other-model"]));
    const absent = await startCountingServer(jsonModelList(["Different-Model"]));
    const configured = pair(
      "pair-a",
      [
        target("target-a", `http://127.0.0.1:${served.port}/v1`),
        target("target-b", `http://127.0.0.1:${absent.port}/v1`),
      ],
      [],
    );
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      loadBalancerService: createLoadBalancerAdminService(
        source([configured], undefined, undefined),
      ),
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/load-balancer/verify-models",
      payload: {
        groupId: "lb-never-saved",
        pairId: "pair-a",
        modelPattern: "Qwen3.8-Flash-Next*",
        nodeTargetIds: ["target-a", "target-b", "target-gone"],
      },
    });
    expect(response.statusCode).toBe(200);
    const body: LoadBalancerVerifyModelsResponse = response.json();
    expect(body.source).toBe("draft");
    expect(body.groupId).toBe("lb-never-saved");
    expect(body.modelPattern).toBe("Qwen3.8-Flash-Next*");
    expect(body.nodes.map((node) => node.targetId)).toEqual([
      "target-a",
      "target-b",
      "target-gone",
    ]);

    const byId = new Map(body.nodes.map((node) => [node.targetId, node]));
    expect(byId.get("target-a")?.matched).toEqual(["Qwen3.8-Flash-Next"]);
    expect(byId.get("target-b")?.ok).toBe(true);
    expect(byId.get("target-b")?.matched).toEqual([]);
    expect(byId.get("target-gone")?.error).toBe("target is not configured in this pair");

    // The pair has no group at all, so this check cannot have read one.
    expect(configured.load_balancers).toEqual([]);
    expect(served.requests()).toBe(1);
    expect(absent.requests()).toBe(1);

    await Promise.all([close(served.server), close(absent.server)]);
  });

  it("LB14-02 a draft pattern is checked instead of the saved group's", async () => {
    const engine = await startCountingServer(jsonModelList(["Qwen3.8-Flash-Next", "other-model"]));
    const configured = pair(
      "pair-a",
      [target("target-a", `http://127.0.0.1:${engine.port}/v1`)],
      [group("lb-saved", ["target-a"], { model_pattern: "other*" })],
    );
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      loadBalancerService: createLoadBalancerAdminService(
        source([configured], undefined, undefined),
      ),
    });
    servers.push(server);

    const draft = await server.inject({
      method: "POST",
      url: "/api/load-balancer/verify-models",
      payload: {
        groupId: "lb-saved",
        pairId: "pair-a",
        modelPattern: "Qwen3.8-Flash-Next",
        nodeTargetIds: ["target-a"],
      },
    });
    expect(draft.statusCode).toBe(200);
    const draftBody: LoadBalancerVerifyModelsResponse = draft.json();
    expect(draftBody.source).toBe("draft");
    expect(draftBody.modelPattern).toBe("Qwen3.8-Flash-Next");
    expect(draftBody.nodes[0]?.matched).toEqual(["Qwen3.8-Flash-Next"]);

    const saved = await server.inject({
      method: "POST",
      url: "/api/load-balancer/verify-models",
      payload: { groupId: "lb-saved", pairId: "pair-a" },
    });
    const savedBody: LoadBalancerVerifyModelsResponse = saved.json();
    expect(savedBody.source).toBe("saved");
    expect(savedBody.modelPattern).toBe("other*");
    expect(savedBody.nodes[0]?.matched).toEqual(["other-model"]);

    expect(engine.requests()).toBe(2);
    await close(engine.server);
  });

  it("LB14-03 a draft with no member or no pattern is rejected before any upstream call", async () => {
    const engine = await startCountingServer(jsonModelList(["Qwen3.8-Flash-Next"]));
    const configured = pair("pair-a", [target("target-a", `http://127.0.0.1:${engine.port}`)], []);
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      loadBalancerService: createLoadBalancerAdminService(
        source([configured], undefined, undefined),
      ),
    });
    servers.push(server);

    const emptyMembers = await server.inject({
      method: "POST",
      url: "/api/load-balancer/verify-models",
      payload: {
        groupId: "lb-draft",
        pairId: "pair-a",
        modelPattern: "Qwen3.8-Flash-Next",
        nodeTargetIds: [],
      },
    });
    expect(emptyMembers.statusCode).toBe(400);
    expect(emptyMembers.json()).toMatchObject({ error: { code: "FST_ERR_VALIDATION" } });

    const tooManyMembers = await server.inject({
      method: "POST",
      url: "/api/load-balancer/verify-models",
      payload: {
        groupId: "lb-draft",
        pairId: "pair-a",
        modelPattern: "Qwen3.8-Flash-Next",
        nodeTargetIds: Array.from({ length: 65 }, (_unused, index) => `target-${index}`),
      },
    });
    expect(tooManyMembers.statusCode).toBe(400);

    expect(engine.requests()).toBe(0);
    await close(engine.server);
  });
});
