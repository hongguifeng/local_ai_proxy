import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDefaultProxyPair,
  createDefaultTarget,
  type ModelPrice,
  type ProxyPair,
  type TargetConfig,
} from "../../src/config/index.js";
import { isRecord } from "../../src/shared/index.js";

import {
  EMPTY_LOAD_SAMPLES,
  LoadBalancer,
  MAX_BUCKET_SIZE,
  ProxyListener,
  ProxyRequestPipeline,
  type LoadSample,
  type ProxyPipelineTarget,
  type ProxyRequestHandler,
  type TrafficLogWriter,
} from "../../src/proxy/index.js";

/**
 * LB-11 pushes the whole feature through one assembled pipeline: two stub engines, real
 * sockets, and the traffic log. These cases are the end-to-end matrix the design asks for -
 * distribution, stickiness, response chains, model pass-through, one safe switch, refusals,
 * pricing, capacity limits and resource cleanup - written against the same seams the running
 * proxy uses.
 */

type GroupShape = ProxyPair["load_balancers"][number];

const PRICE_RULE: ModelPrice = {
  model_pattern: "qwen*",
  input_per_million: "1",
  output_per_million: "2",
  cache_read_per_million: "3",
  cache_write_per_million: "4",
};

function target(id: string, port: number, overrides: Partial<TargetConfig> = {}): TargetConfig {
  return {
    ...createDefaultTarget("logs"),
    id,
    name: `Node ${id}`,
    target_url: `http://127.0.0.1:${port}`,
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
    id: "pair-integration",
    enabled: true,
    targets: [...targets],
    default_target_id: targets[0]?.id ?? "",
    load_balancers: [...groups],
  };
}

function pipelineTarget(
  id: string,
  port: number,
  trafficLog: TrafficLogWriter,
  modelMappings: readonly { listen: string; upstream: string }[] = [],
  modelPrices: readonly ModelPrice[] = [],
): ProxyPipelineTarget {
  return {
    enabled: true,
    id,
    modelMappings: [...modelMappings],
    modelPrices: [...modelPrices],
    name: `Node ${id}`,
    targetScheme: "http",
    targetHost: "127.0.0.1",
    targetPort: port,
    targetBasePath: "",
    trafficLog,
  };
}

function collectWriter(records: Readonly<Record<string, unknown>>[]): TrafficLogWriter {
  return {
    write(record) {
      records.push(record);
      return Promise.resolve();
    },
    update(record) {
      records.push(record);
      return Promise.resolve();
    },
  };
}

function listen(server: http.Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  return new Promise((resolve, reject) => {
    server.once("listening", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("fixture upstream did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
    server.once("error", reject);
  });
}

function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Bind a port and give it back, so connecting to it is refused the way a dead engine is. */
async function refusedPort(): Promise<number> {
  const server = http.createServer((_request, response) => response.end("never reached"));
  const port = await listen(server);
  await close(server);
  return port;
}

interface EchoNode {
  readonly label: string;
  readonly server: http.Server;
  readonly port: number;
  readonly seen: string[];
}

/** An engine that answers with a fixed status, so an upstream error is visible. */
async function startStatusNode(
  label: string,
  status: number,
): Promise<{ server: http.Server; port: number; seen: string[] }> {
  const seen: string[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed: unknown = JSON.parse(body === "" ? "{}" : body);
      const model = isRecord(parsed) ? parsed["model"] : undefined;
      seen.push(typeof model === "string" ? model : "");
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: true, node: label, status }));
    });
  });
  const port = await listen(server);
  return { server, port, seen };
}

/** An engine that answers with the model name it was sent, so a mapping bypass is visible. */
async function startEchoNode(label: string): Promise<EchoNode> {
  const seen: string[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed: unknown = JSON.parse(body === "" ? "{}" : body);
      const model = isRecord(parsed) ? parsed["model"] : undefined;
      const text = typeof model === "string" ? model : "";
      seen.push(text);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: `resp-${label}-${seen.length}`,
          model: text,
          node: label,
          usage: { input_tokens: 1_000, output_tokens: 500 },
        }),
      );
    });
  });
  const port = await listen(server);
  return { label, server, port, seen };
}

/** An engine that sends headers and one chunk, then breaks the connection without finishing. */
async function startTruncatedNode(
  label: string,
): Promise<{ server: http.Server; port: number; hits: number }> {
  let hits = 0;
  const server = http.createServer((_request, response) => {
    hits += 1;
    response.writeHead(200, { "content-type": "application/x-my-sse" });
    response.write(`data: {"id":"resp-${label}","node":"${label}"}\n\n`);
    // Wait long enough that the client has certainly taken the response head.
    setTimeout(() => response.socket?.destroy(), 150);
  });
  const port = await listen(server);
  return {
    server,
    port,
    get hits() {
      return hits;
    },
  };
}

function startListener(
  onRequest: ProxyRequestHandler,
): Promise<{ port: number; listener: ProxyListener }> {
  const listener = new ProxyListener({ host: "127.0.0.1", port: 0, onRequest });
  return listener.start().then((address) => ({ port: address.port, listener }));
}

function bodyFor(model: string, ...turns: string[]): string {
  return JSON.stringify({
    model,
    input: turns.map((turn) => ({ role: "user", content: turn })),
    stream: true,
  });
}

function session(sessionId: string): Record<string, string> {
  return { "x-claude-code-session-id": sessionId };
}

/** Windows hands out ephemeral ports eagerly; reusing connections keeps the count small. */
const clientAgent = new http.Agent({ keepAlive: true });

function post(
  port: number,
  requestPath: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method: "POST",
        agent: clientAgent,
        headers: { "content-type": "application/json", ...headers },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body: text });
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

/** Reads a response that may end early, the way a broken upstream connection does. */
function postTolerant(
  port: number,
  requestPath: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  body: string;
  truncated: boolean;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve) => {
    let text = "";
    let settled = false;
    const finish = (status: number, responseHeaders: http.IncomingHttpHeaders): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ status, body: text, truncated: false, headers: responseHeaders });
    };
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method: "POST",
        agent: clientAgent,
        headers: { "content-type": "application/json", ...headers },
      },
      (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => {
          finish(response.statusCode ?? 0, response.headers);
        });
        response.on("error", () => {
          settled = true;
          resolve({
            status: response.statusCode ?? 0,
            body: text,
            truncated: true,
            headers: response.headers,
          });
        });
      },
    );
    request.on("error", () => {
      settled = true;
      resolve({ status: 0, body: text, truncated: true, headers: {} });
    });
    request.end(body);
  });
}

/** Abandon a request once the first byte arrived, the way a client that went away does. */
function postAndAbandon(port: number, requestPath: string, body: string): Promise<void> {
  return new Promise((resolve) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (response) => {
        response.once("data", () => {
          response.destroy();
          request.destroy();
          resolve();
        });
      },
    );
    request.on("error", () => {
      resolve();
    });
    request.end(body);
  });
}

function echoed(body: string): { node: string; model: string; id: string } {
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed)) {
    throw new Error("the fixture upstream did not answer with an object");
  }
  const text = (key: string): string => {
    const value = parsed[key];
    return typeof value === "string" ? value : "";
  };
  return { node: text("node"), model: text("model"), id: text("id") };
}

function routeOf(record: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  const request = record?.["request"];
  const modelRoute = isRecord(request) ? request["model_route"] : undefined;
  return isRecord(modelRoute) ? modelRoute : {};
}

function loadBalanceOf(
  record: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const loadBalance = routeOf(record)["load_balance"];
  return isRecord(loadBalance) ? loadBalance : {};
}

function eventRecords(
  records: readonly Readonly<Record<string, unknown>>[],
  event: string,
): Readonly<Record<string, unknown>>[] {
  return records.filter((record) => record["event"] === event);
}

function finishedRecords(records: readonly Readonly<Record<string, unknown>>[]) {
  return eventRecords(records, "request_finished");
}

function decisionsOf(records: readonly Readonly<Record<string, unknown>>[]): string[] {
  return finishedRecords(records).map((record) => {
    const decision = loadBalanceOf(record)["decision"];
    return typeof decision === "string" ? decision : "";
  });
}

function pricingOf(record: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  const pricing = record?.["pricing"];
  return isRecord(pricing) ? pricing : {};
}

/** The node a finished record says it used. */
function targetIdOf(record: Readonly<Record<string, unknown>> | undefined): string {
  const target = routeOf(record)["target_id"];
  return typeof target === "string" ? target : "";
}

function engineSample(running: number, sampleSequence = 1): LoadSample {
  return {
    sampleSequence,
    sampledAt: Date.now(),
    running,
    waiting: 0,
    kvUsage: undefined,
    source: "vllm",
  };
}

/** One pipeline with a group over the given nodes, plus the records it writes. */
async function assembledPipeline(
  balancer: LoadBalancer,
  configured: ProxyPair,
  nodes: readonly {
    id: string;
    port: number;
    mappings?: readonly { listen: string; upstream: string }[];
    prices?: readonly ModelPrice[];
  }[],
  loadSamples: () => ReadonlyMap<string, LoadSample> = () => EMPTY_LOAD_SAMPLES,
): Promise<{
  port: number;
  listener: ProxyListener;
  records: Readonly<Record<string, unknown>>[];
}> {
  const records: Readonly<Record<string, unknown>>[] = [];
  const trafficLog = collectWriter(records);
  balancer.reconfigure(configured);
  const pipeline = new ProxyRequestPipeline({
    pairId: configured.id,
    defaultTargetId: configured.default_target_id,
    loadBalancer: balancer,
    loadSamples,
    targets: nodes.map((node) =>
      pipelineTarget(node.id, node.port, trafficLog, node.mappings ?? [], node.prices ?? []),
    ),
  });
  const { port, listener } = await startListener((request, response, context) =>
    pipeline.handle(request, response, context),
  );
  return { port, listener, records };
}

describe("load balancing end to end", () => {
  afterEach(() => {
    // Idle keep-alive sockets would otherwise pile up across cases.
    clientAgent.destroy();
  });

  it("LB11-01 spreads new tasks across both nodes under each strategy", async () => {
    const nodeA = await startEchoNode("a");
    const nodeB = await startEchoNode("b");
    const roundRobin = new LoadBalancer("pair-integration");
    const round = await assembledPipeline(
      roundRobin,
      pair(
        [target("target-a", nodeA.port), target("target-b", nodeB.port)],
        [group("lb-round", ["target-a", "target-b"], { strategy: "round_robin" })],
      ),
      [
        { id: "target-a", port: nodeA.port },
        { id: "target-b", port: nodeB.port },
      ],
    );

    for (let index = 0; index < 4; index += 1) {
      await post(
        round.port,
        "/v1/responses",
        bodyFor("Qwen3.8-Flash-Next", `turn ${index}`),
        session(`round-session-${index}`),
      );
    }
    // Four arrivals, no dispatch history to break ties: the pair takes turns.
    expect(nodeA.seen).toHaveLength(2);
    expect(nodeB.seen).toHaveLength(2);
    expect(decisionsOf(round.records)).toEqual(["new_task", "new_task", "new_task", "new_task"]);
    expect(roundRobin.inFlight("target-a")).toBe(0);
    expect(roundRobin.inFlight("target-b")).toBe(0);
    await round.listener.close();

    // The same four tasks under least_load: the busier engine is never picked.
    nodeA.seen.length = 0;
    nodeB.seen.length = 0;
    const leastLoad = new LoadBalancer("pair-integration");
    const busy = await assembledPipeline(
      leastLoad,
      pair(
        [target("target-a", nodeA.port), target("target-b", nodeB.port)],
        [group("lb-least", ["target-a", "target-b"])],
      ),
      [
        { id: "target-a", port: nodeA.port },
        { id: "target-b", port: nodeB.port },
      ],
      () =>
        new Map([
          ["target-a", engineSample(0)],
          ["target-b", engineSample(5)],
        ]),
    );
    for (let index = 0; index < 4; index += 1) {
      await post(
        busy.port,
        "/v1/responses",
        bodyFor("Qwen3.8-Flash-Next", `quiet ${index}`),
        session(`least-session-${index}`),
      );
    }
    expect(nodeA.seen).toHaveLength(4);
    expect(nodeB.seen).toHaveLength(0);
    expect(decisionsOf(busy.records).every((decision) => decision === "new_task")).toBe(true);
    await busy.listener.close();

    await close(nodeA.server);
    await close(nodeB.server);
  });

  it("LB11-02 keeps one task on one node through chat turns and a response chain", async () => {
    const nodeA = await startEchoNode("a");
    const nodeB = await startEchoNode("b");
    const balancer = new LoadBalancer("pair-integration");
    const chain = await assembledPipeline(
      balancer,
      pair(
        [target("target-a", nodeA.port), target("target-b", nodeB.port)],
        [group("lb-chain", ["target-a", "target-b"])],
      ),
      [
        { id: "target-a", port: nodeA.port },
        { id: "target-b", port: nodeB.port },
      ],
    );

    const first = echoed(
      (
        await post(
          chain.port,
          "/v1/responses",
          bodyFor("Qwen3.8-Flash-Next", "hello"),
          session("chain-session"),
        )
      ).body,
    );
    const home = first.node;
    const follower = home === "a" ? nodeB : nodeA;

    const second = echoed(
      (
        await post(
          chain.port,
          "/v1/responses",
          bodyFor("Qwen3.8-Flash-Next", "hello", "and then"),
          session("chain-session"),
        )
      ).body,
    );
    expect(second.node).toBe(home);

    // A longer turn list must still land on the same engine.
    const third = echoed(
      (
        await post(
          chain.port,
          "/v1/responses",
          bodyFor("Qwen3.8-Flash-Next", "hello", "and then", "one more thing"),
          session("chain-session"),
        )
      ).body,
    );
    expect(third.node).toBe(home);

    // Following a response by id, with no session header at all, must return to that engine.
    const chained = echoed(
      (
        await post(
          chain.port,
          "/v1/responses",
          JSON.stringify({
            model: "Qwen3.8-Flash-Next",
            previous_response_id: first.id,
            input: [{ role: "user", content: "continue" }],
            stream: true,
          }),
        )
      ).body,
    );
    expect(chained.node).toBe(home);
    expect(follower.seen).toEqual([]);
    expect(decisionsOf(chain.records)).toEqual(["new_task", "affinity", "affinity", "affinity"]);
    expect(chain.records.length).toBeGreaterThan(0);

    await chain.listener.close();
    await close(nodeA.server);
    await close(nodeB.server);
  });

  it("LB11-03 passes the requested model through even when both members map elsewhere", async () => {
    const nodeA = await startEchoNode("a");
    const nodeB = await startEchoNode("b");
    const balancer = new LoadBalancer("pair-integration");
    const mappings = [
      { listen: "Qwen3.8-Flash-Next", upstream: "Qwen3.8-Flash-Next-DFlash7" },
      { listen: "*", upstream: "different-name" },
    ];
    const through = await assembledPipeline(
      balancer,
      pair(
        [
          target("target-a", nodeA.port, { model_mappings: mappings }),
          target("target-b", nodeB.port, {
            model_mappings: [{ listen: "Qwen3.8-Flash-Next", upstream: "other-name" }],
          }),
        ],
        [group("lb-passthrough", ["target-a", "target-b"], { strategy: "round_robin" })],
      ),
      [
        { id: "target-a", port: nodeA.port, mappings },
        {
          id: "target-b",
          port: nodeB.port,
          mappings: [{ listen: "Qwen3.8-Flash-Next", upstream: "other-name" }],
        },
      ],
    );

    for (let index = 0; index < 4; index += 1) {
      await post(
        through.port,
        "/v1/responses",
        bodyFor("Qwen3.8-Flash-Next", `turn ${index}`),
        session(`pass-session-${index}`),
      );
    }
    // Both engines were used, and neither saw a rewritten name.
    expect(nodeA.seen.length + nodeB.seen.length).toBe(4);
    expect(nodeA.seen.every((model) => model === "Qwen3.8-Flash-Next")).toBe(true);
    expect(nodeB.seen.every((model) => model === "Qwen3.8-Flash-Next")).toBe(true);
    expect(nodeA.seen).not.toContain("Qwen3.8-Flash-Next-DFlash7");
    expect(nodeB.seen).not.toContain("other-name");
    expect(
      finishedRecords(through.records).every(
        (record) => routeOf(record)["upstream_model"] === "Qwen3.8-Flash-Next",
      ),
    ).toBe(true);
    // Outside the group the very same mapping still rewrites the model.
    const outside = echoed(
      (
        await post(
          through.port,
          "/v1/responses",
          bodyFor("some-other-model", "off group"),
          session("pass-session-outside"),
        )
      ).body,
    );
    expect(outside.model).toBe("different-name");
    expect(nodeA.seen).toContain("different-name");
    await through.listener.close();

    await close(nodeA.server);
    await close(nodeA.server);
    await close(nodeB.server);
  });

  it("LB19-10 keeps a task on its node when a save renames that node's model", async () => {
    const nodeA = await startEchoNode("a");
    const nodeB = await startEchoNode("b");
    const balancer = new LoadBalancer("pair-integration");
    const targets = [target("target-a", nodeA.port), target("target-b", nodeB.port)];
    const nodes = [
      { id: "target-a", port: nodeA.port },
      { id: "target-b", port: nodeB.port },
    ];
    const first = await assembledPipeline(
      balancer,
      pair(targets, [
        group("lb-19-rename", ["target-a", "target-b"], {
          members: [
            { target_id: "target-a", model_id: "Model-On-A" },
            { target_id: "target-b", model_id: "" },
          ],
        }),
      ]),
      nodes,
    );

    const opened = echoed(
      (
        await post(
          first.port,
          "/v1/responses",
          bodyFor("Qwen3.8-Flash-Next", "hello"),
          session("rename-session"),
        )
      ).body,
    );
    const home = opened.node;
    expect(opened.model).toBe(home === "a" ? "Model-On-A" : "Qwen3.8-Flash-Next");
    await first.listener.close();

    // A save that renames the model on node A must not move the task anywhere.
    const second = await assembledPipeline(
      balancer,
      pair(targets, [
        group("lb-19-rename", ["target-a", "target-b"], {
          members: [
            { target_id: "target-a", model_id: "Model-Renamed-On-A" },
            { target_id: "target-b", model_id: "" },
          ],
        }),
      ]),
      nodes,
    );

    const follow = echoed(
      (
        await post(
          second.port,
          "/v1/responses",
          bodyFor("Qwen3.8-Flash-Next", "hello", "and then"),
          session("rename-session"),
        )
      ).body,
    );

    expect(follow.node).toBe(home);
    expect(follow.model).toBe(home === "a" ? "Model-Renamed-On-A" : "Qwen3.8-Flash-Next");
    // The other node never carried this task, so its prefix cache stayed untouched.
    const follower = home === "a" ? nodeB : nodeA;
    expect(follower.seen).toEqual([]);

    await second.listener.close();
    await close(nodeA.server);
    await close(nodeB.server);
  });

  it("LB11-04 switches once when a node refuses, then keeps the task on the new node", async () => {
    const deadPort = await refusedPort();
    const survivor = await startEchoNode("survivor");
    const balancer = new LoadBalancer("pair-integration");
    const failed = await assembledPipeline(
      balancer,
      pair(
        [target("target-dead", deadPort), target("target-alive", survivor.port)],
        [group("lb-failover", ["target-dead", "target-alive"])],
      ),
      [
        { id: "target-dead", port: deadPort },
        { id: "target-alive", port: survivor.port },
      ],
    );

    const first = echoed(
      (
        await post(
          failed.port,
          "/v1/responses",
          bodyFor("Qwen3.8-Flash-Next", "first"),
          session("fail-session"),
        )
      ).body,
    );
    expect(first.node).toBe("survivor");
    expect(survivor.seen).toHaveLength(1);

    const firstRecord = finishedRecords(failed.records)[0];
    expect(routeOf(firstRecord)).toMatchObject({
      route_mode: "load_balance",
      target_id: "target-alive",
      load_balance: { decision: "failover", failover_from: "target-dead" },
    });
    expect(balancer.cooldownRemaining("target-dead")).toBeGreaterThan(0);

    // The next turn of the same task must not be pulled back onto the dead node.
    const second = echoed(
      (
        await post(
          failed.port,
          "/v1/responses",
          bodyFor("Qwen3.8-Flash-Next", "first", "second"),
          session("fail-session"),
        )
      ).body,
    );
    expect(second.node).toBe("survivor");
    expect(survivor.seen).toHaveLength(2);
    expect(loadBalanceOf(finishedRecords(failed.records)[1])).toMatchObject({
      decision: "affinity",
    });
    const affinity = balancer.tableFor("lb-failover");
    if (affinity === undefined) {
      throw new Error("An enabled group must have an affinity table.");
    }
    expect(affinity.snapshot().byTarget["target-alive"]).toBe(1);
    expect(affinity.snapshot().byTarget["target-dead"]).toBeUndefined();
    // TRI-01: one switch, one routing revision, on the binding that survived it.
    expect(affinity.bindingForId(1)?.routingRevision).toBe(1);
    expect(balancer.inFlight("target-alive")).toBe(0);
    expect(balancer.inFlight("target-dead")).toBe(0);

    await failed.listener.close();
    await close(survivor.server);
  });

  it("LB11-05 delivers one response when the connection breaks after the headers", async () => {
    const breaker = await startTruncatedNode("breaker");
    const healthy = await startEchoNode("healthy");
    const balancer = new LoadBalancer("pair-integration");
    const mid = await assembledPipeline(
      balancer,
      pair(
        [target("target-breaker", breaker.port), target("target-healthy", healthy.port)],
        [group("lb-mid", ["target-breaker", "target-healthy"])],
      ),
      [
        { id: "target-breaker", port: breaker.port },
        { id: "target-healthy", port: healthy.port },
      ],
    );

    const answer = await postTolerant(
      mid.port,
      "/v1/responses",
      bodyFor("Qwen3.8-Flash-Next", "stream me"),
      session("mid-session"),
    );
    expect(answer.status).toBe(200);
    expect(answer.truncated).toBe(true);
    expect(answer.headers["content-type"]).toBe("application/x-my-sse");
    // Exactly one frame from one engine: no second body was appended by a switch.
    expect(answer.body.match(/data: /g)).toHaveLength(1);
    expect(answer.body).toContain("breaker");
    expect(answer.body).not.toContain("healthy");
    expect(healthy.seen).toEqual([]);
    expect(loadBalanceOf(finishedRecords(mid.records)[0])).toMatchObject({
      decision: "new_task",
      failover_from: null,
    });
    // A stream the engine broke off counts against that engine, unlike a client that
    // walked away on its own (LB07-07). It still never switched to the healthy node.
    expect(balancer.cooldownRemaining("target-breaker")).toBeGreaterThan(0);
    await expect.poll(() => balancer.inFlight("target-breaker"), { timeout: 5_000 }).toBe(0);

    await mid.listener.close();
    await close(breaker.server);
    await close(healthy.server);
  });

  it("LB11-06 refuses a group with no healthy node and never hands it to the default target", async () => {
    const deadOne = await refusedPort();
    const deadTwo = await refusedPort();
    const outside = await startEchoNode("outside");
    const balancer = new LoadBalancer("pair-integration");
    const refused = await assembledPipeline(
      balancer,
      {
        ...pair(
          [
            target("target-dead-one", deadOne),
            target("target-dead-two", deadTwo),
            target("target-outside", outside.port),
          ],
          [group("lb-dead", ["target-dead-one", "target-dead-two"])],
        ),
        // The ordinary fallback lives outside the group, so a refusal has somewhere to go
        // if the router were ever allowed to slip past the group.
        default_target_id: "target-outside",
      },
      [
        { id: "target-dead-one", port: deadOne },
        { id: "target-dead-two", port: deadTwo },
        { id: "target-outside", port: outside.port },
      ],
    );

    // Both members refuse, so the group tries one, switches once, and returns 502. The
    // ordinary default target is never used as a third attempt.
    const first = await postTolerant(
      refused.port,
      "/v1/responses",
      bodyFor("Qwen3.8-Flash-Next", "anyone there"),
      session("dead-session"),
    );
    expect(first.status).toBe(502);
    expect(outside.seen).toEqual([]);
    expect(balancer.cooldownRemaining("target-dead-one")).toBeGreaterThan(0);
    expect(balancer.cooldownRemaining("target-dead-two")).toBeGreaterThan(0);

    // Now the group has no healthy node at all. The request is refused outright with a
    // retry hint instead of being quietly sent to the target outside the group.
    balancer.reconfigure(
      pair(
        [
          target("target-dead-one", deadOne, { enabled: false }),
          target("target-dead-two", deadTwo, { enabled: false }),
          target("target-outside", outside.port),
        ],
        [group("lb-dead", ["target-dead-one", "target-dead-two"])],
      ),
    );
    const answer = await postTolerant(
      refused.port,
      "/v1/responses",
      bodyFor("Qwen3.8-Flash-Next", "anyone there", "still here"),
      session("dead-session-two"),
    );
    expect(answer.status).toBe(503);
    expect(answer.headers["retry-after"]).toBe("1");
    expect(outside.seen).toEqual([]);
    const record = finishedRecords(refused.records).at(-1);
    expect(loadBalanceOf(record)).toMatchObject({
      decision: "no_healthy_node",
      group_id: "lb-dead",
    });
    expect(routeOf(record)["route_mode"]).toBe("load_balance");
    expect(balancer.inFlight("target-dead-one")).toBe(0);
    expect(balancer.inFlight("target-dead-two")).toBe(0);

    // A model the group does not claim still reaches the ordinary target, untouched.
    const unmatched = echoed(
      (
        await post(
          refused.port,
          "/v1/responses",
          bodyFor("unmatched-model", "not balanced"),
          session("dead-session-other"),
        )
      ).body,
    );
    expect(unmatched.node).toBe("outside");
    expect(outside.seen).toEqual(["unmatched-model"]);
    const ordinaryRoute = routeOf(finishedRecords(refused.records).at(-1));
    expect(ordinaryRoute["route_mode"]).toBeUndefined();
    expect(ordinaryRoute["load_balance"]).toBeUndefined();
    expect(ordinaryRoute["target_id"]).toBe("target-outside");

    await refused.listener.close();
    await close(outside.server);
  });

  it("LB11-09 prices both members the same and keeps that snapshot across a switch", async () => {
    const deadPort = await refusedPort();
    const pricedA = await startEchoNode("priced-a");
    const pricedB = await startEchoNode("priced-b");
    const balancer = new LoadBalancer("pair-integration");
    const priced = await assembledPipeline(
      balancer,
      pair(
        [
          target("target-a", pricedA.port, { model_prices: [{ ...PRICE_RULE }] }),
          target("target-b", pricedB.port, { model_prices: [{ ...PRICE_RULE }] }),
          target("target-dead", deadPort, { model_prices: [{ ...PRICE_RULE }] }),
        ],
        [
          group("lb-priced", ["target-a", "target-b", "target-dead"], {
            model_pattern: "qwen3.8-flash-next*",
          }),
        ],
      ),
      [
        { id: "target-a", port: pricedA.port, prices: [{ ...PRICE_RULE }] },
        { id: "target-b", port: pricedB.port, prices: [{ ...PRICE_RULE }] },
        { id: "target-dead", port: deadPort, prices: [{ ...PRICE_RULE }] },
      ],
    );

    // One task per node under round robin, so both price paths are exercised.
    const first = await post(
      priced.port,
      "/v1/responses",
      bodyFor("qwen3.8-flash-next", "one"),
      session("price-session-one"),
    );
    const second = await post(
      priced.port,
      "/v1/responses",
      bodyFor("qwen3.8-flash-next", "two"),
      session("price-session-two"),
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const [finishedOne, finishedTwo] = finishedRecords(priced.records);
    const costOne = pricingOf(finishedOne);
    const costTwo = pricingOf(finishedTwo);
    expect(costOne["pricing_status"]).toBe("priced");
    expect(costTwo["pricing_status"]).toBe("priced");
    expect(costOne["cost_nano_cny"]).toBe(costTwo["cost_nano_cny"]);
    const snapshotOne = isRecord(costOne["pricing_snapshot"]) ? costOne["pricing_snapshot"] : {};
    const snapshotTwo = isRecord(costTwo["pricing_snapshot"]) ? costTwo["pricing_snapshot"] : {};
    // Same rules on both members, so no price field may depend on which node answered.
    for (const key of [
      "model_pattern",
      "input_per_million",
      "output_per_million",
      "cache_read_per_million",
      "cache_write_per_million",
      "currency",
      "algorithm_version",
    ]) {
      expect(snapshotOne[key]).toEqual(snapshotTwo[key]);
    }
    // The node the snapshot was frozen on is the one thing that legitimately differs.
    expect(targetIdOf(finishedOne)).not.toBe(targetIdOf(finishedTwo));
    expect(snapshotOne["target_id"]).toBe(targetIdOf(finishedOne));
    expect(snapshotTwo["target_id"]).toBe(targetIdOf(finishedTwo));

    // A node that refuses is switched onto a survivor; pricing must not drift. Marking the
    // two live nodes busy first makes the refusal deterministic: the dead node is the only
    // one that looks idle, and the switch has two remaining candidates.
    balancer.reserve("target-a");
    balancer.reserve("target-b");
    const afterSwitch = await post(
      priced.port,
      "/v1/responses",
      bodyFor("qwen3.8-flash-next", "three"),
      session("price-session-dead"),
    );
    balancer.release("target-a");
    balancer.release("target-b");
    expect(afterSwitch.status).toBe(200);
    const switchedNode = echoed(afterSwitch.body).node;
    expect(switchedNode).not.toBe("dead");
    expect(["priced-a", "priced-b"]).toContain(switchedNode);
    const switchedRecord = finishedRecords(priced.records)[2];
    const switched = pricingOf(switchedRecord);
    const switchedSnapshot = isRecord(switched["pricing_snapshot"])
      ? switched["pricing_snapshot"]
      : {};
    expect(switched["pricing_status"]).toBe("priced");
    expect(switched["cost_nano_cny"]).toBe(costOne["cost_nano_cny"]);
    for (const key of [
      "model_pattern",
      "input_per_million",
      "output_per_million",
      "cache_read_per_million",
      "cache_write_per_million",
      "currency",
      "algorithm_version",
    ]) {
      expect(switchedSnapshot[key]).toEqual(snapshotOne[key]);
    }
    // The snapshot stays frozen on the node the task was planned for. Switching engines
    // must not move the price onto another node's rule set.
    expect(switchedSnapshot["target_id"]).toBe("target-dead");
    expect(switchedSnapshot["target_id"]).not.toBe(targetIdOf(switchedRecord));
    expect(loadBalanceOf(switchedRecord)).toMatchObject({
      decision: "failover",
      failover_from: "target-dead",
    });

    await priced.listener.close();
    await close(pricedA.server);
    await close(pricedB.server);
  });

  it("LB11-10 caps one prefix bucket and refuses to invent affinity without reachable evidence", async () => {
    const nodeA = await startEchoNode("a");
    const nodeB = await startEchoNode("b");
    const balancer = new LoadBalancer("pair-integration");
    const capped = await assembledPipeline(
      balancer,
      pair(
        [target("target-a", nodeA.port), target("target-b", nodeB.port)],
        [group("lb-cap", ["target-a", "target-b"], { strategy: "round_robin" })],
      ),
      [
        { id: "target-a", port: nodeA.port },
        { id: "target-b", port: nodeB.port },
      ],
    );
    const table = balancer.tableFor("lb-cap");
    if (table === undefined) {
      throw new Error("An enabled group must have an affinity table.");
    }

    // A body with no session, no response id and no cache key carries no evidence the
    // router may use, so it can never attach to somebody else's task.
    for (let index = 0; index < 3; index += 1) {
      await post(capped.port, "/v1/responses", bodyFor("Qwen3.8-Flash-Next", `evidence ${index}`));
    }
    expect(decisionsOf(capped.records).slice(-3)).toEqual(["new_task", "new_task", "new_task"]);
    expect(table.snapshot().bindings).toBe(3);

    // These tasks share everything except the first user turn, so they belong to one bucket
    // and must never be confused with one another.
    const total = MAX_BUCKET_SIZE + 8;
    let lastNode = "";
    for (let index = 0; index < total; index += 1) {
      const answer = await post(
        capped.port,
        "/v1/responses",
        bodyFor("Qwen3.8-Flash-Next", `cap turn ${index}`),
        session(`cap-session-${index}`),
      );
      if (index === total - 1) {
        lastNode = echoed(answer.body).node;
      }
    }
    const bucket = table.snapshot();
    expect(bucket.buckets).toBe(1);
    expect(bucket.bindings).toBeLessThanOrEqual(MAX_BUCKET_SIZE);
    expect(nodeA.seen.length + nodeB.seen.length).toBe(total + 3);
    expect(
      decisionsOf(capped.records)
        .slice(3, 3 + total)
        .every((decision) => decision === "new_task"),
    ).toBe(true);

    // Growing a recent conversation still finds its node, because the prefix extends.
    const grown = echoed(
      (
        await post(
          capped.port,
          "/v1/responses",
          bodyFor("Qwen3.8-Flash-Next", `cap turn ${total - 1}`, "and then"),
          session(`cap-session-${total - 1}`),
        )
      ).body,
    );
    expect(grown.node).toBe(lastNode);
    expect(decisionsOf(capped.records).at(-1)).toBe("affinity");

    // The task that was pushed out of the full bucket is a new task again.
    const pushedOut = await post(
      capped.port,
      "/v1/responses",
      bodyFor("Qwen3.8-Flash-Next", "cap turn 0"),
      session("cap-session-0"),
    );
    expect(pushedOut.status).toBe(200);
    expect(decisionsOf(capped.records).at(-1)).toBe("new_task");
    expect(table.snapshot().buckets).toBe(1);
    expect(table.snapshot().bindings).toBeLessThanOrEqual(MAX_BUCKET_SIZE);

    await capped.listener.close();
    await close(nodeA.server);
    await close(nodeB.server);
  });

  it("LB11-11 hands reservations back after an abort, an upstream error and a refusal", async () => {
    const nodeA = await startEchoNode("a");
    const nodeB = await startEchoNode("b");
    const balancer = new LoadBalancer("pair-integration");
    const leaked = await assembledPipeline(
      balancer,
      pair(
        [target("target-a", nodeA.port), target("target-b", nodeB.port)],
        [group("lb-leak", ["target-a", "target-b"])],
      ),
      [
        { id: "target-a", port: nodeA.port },
        { id: "target-b", port: nodeB.port },
      ],
    );

    await postAndAbandon(leaked.port, "/v1/responses", bodyFor("Qwen3.8-Flash-Next", "walk away"));
    await expect
      .poll(() => balancer.inFlight("target-a") + balancer.inFlight("target-b"), {
        timeout: 5_000,
      })
      .toBe(0);

    // An engine that answers with a 5xx is not a connection failure: the group must not
    // switch, must not cool that node, and must hand its reservation back.
    const angry = await startStatusNode("angry", 500);
    const calm = await startEchoNode("calm");
    const errors = new LoadBalancer("pair-integration");
    const errorRun = await assembledPipeline(
      errors,
      pair(
        [target("target-angry", angry.port), target("target-calm", calm.port)],
        [group("lb-error", ["target-angry", "target-calm"], { strategy: "round_robin" })],
      ),
      [
        { id: "target-angry", port: angry.port },
        { id: "target-calm", port: calm.port },
      ],
    );
    const angryAnswer = await post(
      errorRun.port,
      "/v1/responses",
      bodyFor("Qwen3.8-Flash-Next", "bad engine"),
      session("leak-angry"),
    );
    expect(angryAnswer.status).toBe(500);
    expect(calm.seen).toEqual([]);
    expect(errors.cooldownRemaining("target-angry")).toBe(0);
    expect(errors.inFlight("target-angry")).toBe(0);
    expect(errors.inFlight("target-calm")).toBe(0);
    await errorRun.listener.close();

    // With switching turned off, a refusal stays on the node that was chosen: one attempt,
    // no second node, and the reservation still comes back.
    const deadOne = await refusedPort();
    const deadTwo = await refusedPort();
    const stuck = new LoadBalancer("pair-integration");
    const noSwitch = await assembledPipeline(
      stuck,
      pair(
        [target("target-dead-one", deadOne), target("target-dead-two", deadTwo)],
        [group("lb-stuck", ["target-dead-one", "target-dead-two"], { failover_enabled: false })],
      ),
      [
        { id: "target-dead-one", port: deadOne },
        { id: "target-dead-two", port: deadTwo },
      ],
    );
    const deadOnly = await postTolerant(
      noSwitch.port,
      "/v1/responses",
      bodyFor("Qwen3.8-Flash-Next", "nowhere"),
      session("leak-dead"),
    );
    expect(deadOnly.status).toBe(502);
    const deadRecord = finishedRecords(noSwitch.records).at(-1);
    expect(loadBalanceOf(deadRecord)["decision"]).toBe("new_task");
    expect(loadBalanceOf(deadRecord)["failover_from"]).toBeNull();
    expect(stuck.inFlight("target-dead-one")).toBe(0);
    expect(stuck.inFlight("target-dead-two")).toBe(0);

    await leaked.listener.close();
    await noSwitch.listener.close();
    await close(nodeA.server);
    await close(nodeB.server);
    await close(angry.server);
    await close(calm.server);
  });
});
