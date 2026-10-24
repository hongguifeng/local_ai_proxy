import http from "node:http";

import { describe, expect, it } from "vitest";

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
  ProxyListener,
  ProxyRequestPipeline,
  type ProxyPipelineTarget,
  type ProxyRequestHandler,
  type TrafficLogWriter,
} from "../../src/proxy/index.js";

/**
 * LB-05 wires a load balancing group into the real request pipeline. These cases need real
 * upstream servers: the question is which engine receives the body and whether the
 * reservation is released on every way a request can end.
 */

type GroupShape = ProxyPair["load_balancers"][number];

interface EchoNode {
  readonly label: string;
  readonly server: http.Server;
  readonly port: number;
  /** The model names this engine actually received, in arrival order. */
  readonly seen: string[];
}

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
    model_pattern: "Qwen3.8-Flash-Next*",
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
    id: "pair-lb",
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
          id: `resp-${label}`,
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

/** An engine that sends headers and one chunk, then never finishes. */
async function startStallNode(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-my-sse" });
    response.write('data: {"id":"resp-stall"}\n\n');
  });
  const port = await listen(server);
  return { server, port };
}

function startListener(
  onRequest: ProxyRequestHandler,
): Promise<{ port: number; listener: ProxyListener }> {
  const listener = new ProxyListener({ host: "127.0.0.1", port: 0, onRequest });
  return listener.start().then((address) => ({ port: address.port, listener }));
}

function bodyFor(model: string, turn: string): string {
  return JSON.stringify({
    model,
    input: [{ role: "user", content: turn }],
    stream: true,
  });
}

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

function session(sessionId: string): Record<string, string> {
  return { "x-claude-code-session-id": sessionId };
}

function echoed(body: string): { node: string; model: string } {
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed)) {
    throw new Error("the fixture upstream did not answer with an object");
  }
  return {
    node: typeof parsed["node"] === "string" ? parsed["node"] : "",
    model: typeof parsed["model"] === "string" ? parsed["model"] : "",
  };
}

function routeOf(record: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  const request = record?.["request"];
  const modelRoute = isRecord(request) ? request["model_route"] : undefined;
  return isRecord(modelRoute) ? modelRoute : {};
}

function finishedRecords(records: readonly Readonly<Record<string, unknown>>[]) {
  return records.filter((record) => record["event"] === "request_finished");
}

describe("load balancing inside the request pipeline", () => {
  it("LB05-01 routes through the group when it matches and through mappings when it is off", async () => {
    const nodeA = await startEchoNode("a");
    const nodeB = await startEchoNode("b");
    const targets = [
      target("target-a", nodeA.port, {
        model_mappings: [{ listen: "Qwen3.8-Flash-Next*", upstream: "mapped-on-a" }],
      }),
      target("target-b", nodeB.port),
    ];
    const records: Readonly<Record<string, unknown>>[] = [];
    const trafficLog = collectWriter(records);
    const balancer = new LoadBalancer("pair-lb");
    balancer.reconfigure(pair(targets, [group("lb-pipeline", ["target-a", "target-b"])]));

    const pipeline = new ProxyRequestPipeline({
      pairId: "pair-lb",
      defaultTargetId: "target-a",
      loadBalancer: balancer,
      loadSamples: () => EMPTY_LOAD_SAMPLES,
      targets: [
        pipelineTarget("target-a", nodeA.port, trafficLog, [
          { listen: "Qwen3.8-Flash-Next*", upstream: "mapped-on-a" },
        ]),
        pipelineTarget("target-b", nodeB.port, trafficLog),
      ],
    });
    const { port, listener } = await startListener((request, response, context) =>
      pipeline.handle(request, response, context),
    );

    const answer = echoed(
      (
        await post(
          port,
          "/v1/responses",
          bodyFor("Qwen3.8-Flash-Next", "one"),
          session("session-pipeline-1"),
        )
      ).body,
    );
    expect(answer.model).toBe("Qwen3.8-Flash-Next");
    const used = answer.node === "a" ? nodeA : nodeB;
    const idle = answer.node === "a" ? nodeB : nodeA;
    expect(used.seen).toEqual(["Qwen3.8-Flash-Next"]);
    expect(idle.seen).toEqual([]);
    expect(routeOf(finishedRecords(records)[0])).toMatchObject({
      route_mode: "load_balance",
      load_balance: {
        group_id: "lb-pipeline",
        decision: "new_task",
        strategy: "least_load",
        failover_from: null,
      },
    });
    await listener.close();

    // Without a balancer the very same request goes back through the member mapping.
    const plainRecords: Readonly<Record<string, unknown>>[] = [];
    const plainWriter = collectWriter(plainRecords);
    const plainPipeline = new ProxyRequestPipeline({
      pairId: "pair-lb",
      defaultTargetId: "target-a",
      targets: [
        pipelineTarget("target-a", nodeA.port, plainWriter, [
          { listen: "Qwen3.8-Flash-Next*", upstream: "mapped-on-a" },
        ]),
        pipelineTarget("target-b", nodeB.port, plainWriter),
      ],
    });
    const plain = await startListener((request, response, context) =>
      plainPipeline.handle(request, response, context),
    );
    const mapped = echoed(
      (
        await post(
          plain.port,
          "/v1/responses",
          bodyFor("Qwen3.8-Flash-Next", "one"),
          session("session-pipeline-1"),
        )
      ).body,
    );
    expect(mapped).toMatchObject({ node: "a", model: "mapped-on-a" });
    expect(routeOf(finishedRecords(plainRecords)[0])).toMatchObject({
      requested_model: "Qwen3.8-Flash-Next",
      upstream_model: "mapped-on-a",
    });
    expect(Object.keys(routeOf(finishedRecords(plainRecords)[0]))).not.toContain("route_mode");
    await plain.listener.close();
    await close(nodeA.server);
    await close(nodeB.server);
  });

  it("LB05-09 forwards the requested model even though both members rewrite it", async () => {
    const nodeA = await startEchoNode("a");
    const nodeB = await startEchoNode("b");
    const records: Readonly<Record<string, unknown>>[] = [];
    const trafficLog = collectWriter(records);
    const balancer = new LoadBalancer("pair-lb");
    balancer.reconfigure(
      pair(
        [
          target("target-a", nodeA.port, {
            model_mappings: [
              { listen: "Qwen3.8-Flash-Next*", upstream: "Qwen3.8-Flash-Next-DeepSeek" },
            ],
          }),
          target("target-b", nodeB.port, {
            model_mappings: [
              { listen: "Qwen3.8-Flash-Next*", upstream: "Qwen3.8-Flash-Next-DFlash7" },
            ],
          }),
        ],
        [group("lb-pipeline", ["target-a", "target-b"])],
      ),
    );

    const pipeline = new ProxyRequestPipeline({
      pairId: "pair-lb",
      defaultTargetId: "target-a",
      loadBalancer: balancer,
      loadSamples: () => EMPTY_LOAD_SAMPLES,
      targets: [
        pipelineTarget("target-a", nodeA.port, trafficLog, [
          { listen: "Qwen3.8-Flash-Next*", upstream: "Qwen3.8-Flash-Next-DeepSeek" },
        ]),
        pipelineTarget("target-b", nodeB.port, trafficLog, [
          { listen: "Qwen3.8-Flash-Next*", upstream: "Qwen3.8-Flash-Next-DFlash7" },
        ]),
      ],
    });
    const { port, listener } = await startListener((request, response, context) =>
      pipeline.handle(request, response, context),
    );

    const first = echoed(
      (
        await post(
          port,
          "/v1/responses",
          bodyFor("Qwen3.8-Flash-Next", "one"),
          session("session-pipeline-1"),
        )
      ).body,
    );
    const second = echoed(
      (
        await post(
          port,
          "/v1/responses",
          bodyFor("Qwen3.8-Flash-Next", "two"),
          session("session-pipeline-1"),
        )
      ).body,
    );
    expect(first.node).toBe(second.node);
    expect(first.model).toBe("Qwen3.8-Flash-Next");
    expect(second.model).toBe("Qwen3.8-Flash-Next");
    const used = first.node === "a" ? nodeA : nodeB;
    const idle = first.node === "a" ? nodeB : nodeA;
    expect(used.seen).toEqual(["Qwen3.8-Flash-Next", "Qwen3.8-Flash-Next"]);
    expect(idle.seen).toEqual([]);
    expect(finishedRecords(records)).toHaveLength(2);
    expect(routeOf(finishedRecords(records)[1])).toMatchObject({
      route_mode: "load_balance",
      load_balance: { decision: "affinity", matched_by: "exact_key" },
    });
    await listener.close();
    await close(nodeA.server);
    await close(nodeB.server);
  });

  it("LB05-08 releases the reservation on a finished response, an upstream failure and a client abort", async () => {
    const nodeA = await startEchoNode("a");
    const stall = await startStallNode();
    const records: Readonly<Record<string, unknown>>[] = [];
    const trafficLog = collectWriter(records);
    const balancer = new LoadBalancer("pair-lb");
    balancer.reconfigure(
      pair(
        [target("target-a", nodeA.port), target("target-b", stall.port)],
        [group("lb-pipeline", ["target-a", "target-b"])],
      ),
    );

    const pipeline = new ProxyRequestPipeline({
      pairId: "pair-lb",
      defaultTargetId: "target-a",
      loadBalancer: balancer,
      loadSamples: () => EMPTY_LOAD_SAMPLES,
      targets: [
        pipelineTarget("target-a", nodeA.port, trafficLog),
        pipelineTarget("target-b", stall.port, trafficLog),
      ],
    });
    const { port, listener } = await startListener((request, response, context) =>
      pipeline.handle(request, response, context),
    );

    await post(port, "/v1/responses", bodyFor("Qwen3.8-Flash-Next", "one"), session("session-a"));
    expect(balancer.inFlight("target-a")).toBe(0);
    expect(balancer.inFlight("target-b")).toBe(0);

    // The abandoned stream has to land on the stalling engine, so make the other busier.
    balancer.reserve("target-a");
    await postAndAbandon(port, "/v1/responses", bodyFor("Qwen3.8-Flash-Next", "two"));
    await expect.poll(() => balancer.inFlight("target-b"), { timeout: 5_000 }).toBe(0);
    balancer.release("target-a");
    expect(balancer.inFlight("target-a")).toBe(0);

    // An upstream that refuses the connection also releases its reservation.
    const refusedTargets = pair(
      [target("target-a", nodeA.port), target("target-b", 1)],
      [group("lb-refused", ["target-a", "target-b"])],
    );
    balancer.reconfigure(refusedTargets);
    const refusedPipeline = new ProxyRequestPipeline({
      pairId: "pair-lb",
      defaultTargetId: "target-a",
      loadBalancer: balancer,
      loadSamples: () => EMPTY_LOAD_SAMPLES,
      targets: [
        pipelineTarget("target-a", nodeA.port, trafficLog),
        pipelineTarget("target-b", 1, trafficLog),
      ],
    });
    const refused = await startListener((request, response, context) =>
      refusedPipeline.handle(request, response, context),
    );
    balancer.reserve("target-a");
    const answer = await post(
      refused.port,
      "/v1/responses",
      bodyFor("Qwen3.8-Flash-Next", "three"),
      session("session-c"),
    );
    expect(answer.status).toBe(502);
    await expect.poll(() => balancer.inFlight("target-b"), { timeout: 5_000 }).toBe(0);
    balancer.release("target-a");
    expect(balancer.inFlight("target-a")).toBe(0);
    await refused.listener.close();

    await listener.close();
    await close(nodeA.server);
    await close(stall.server);
  });
});

/** Sends half the body and hands back the rest, so the body read window is observable. */
function postInTwoParts(
  port: number,
  requestPath: string,
  body: string,
  headers: Record<string, string>,
): {
  readonly firstPartSent: Promise<void>;
  readonly done: Promise<{ status: number; body: string }>;
  sendRest(): void;
} {
  let resolveDone: ((value: { status: number; body: string }) => void) | undefined;
  let rejectDone: ((reason: unknown) => void) | undefined;
  const done = new Promise<{ status: number; body: string }>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  let markSent: (() => void) | undefined;
  const firstPartSent = new Promise<void>((resolve) => {
    markSent = resolve;
  });
  const half = Math.floor(body.length / 2);
  const request = http.request(
    {
      host: "127.0.0.1",
      port,
      path: requestPath,
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
    },
    (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
      });
      response.on("end", () => {
        resolveDone?.({ status: response.statusCode ?? 0, body: text });
      });
      response.on("error", (reason: unknown) => {
        rejectDone?.(reason);
      });
    },
  );
  request.on("error", (reason: unknown) => {
    rejectDone?.(reason);
  });
  request.write(body.slice(0, half), () => markSent?.());
  return {
    firstPartSent,
    done,
    sendRest: (): void => {
      request.end(body.slice(half));
    },
  };
}

function eventRecords(
  records: readonly Readonly<Record<string, unknown>>[],
  event: string,
): Readonly<Record<string, unknown>>[] {
  return records.filter((record) => record["event"] === event);
}

function requestKeys(record: Readonly<Record<string, unknown>> | undefined): string[] {
  const request = record?.["request"];
  return isRecord(request) ? Object.keys(request) : [];
}

function requestOf(record: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  const request = record?.["request"];
  return isRecord(request) ? request : {};
}

function pricingOf(record: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  const pricing = record?.["pricing"];
  return isRecord(pricing) ? pricing : {};
}

const PRICE_RULE = {
  model_pattern: "qwen*",
  input_per_million: "1",
  output_per_million: "2",
  cache_read_per_million: "3",
  cache_write_per_million: "4",
};

describe("record timing and pricing around load balancing", () => {
  it("LB06-01 keeps the early record when a single-target pair balances one node", async () => {
    // Nothing listens on this port, so the upstream attempt fails; the first record must
    // still have been written before the body was read.
    const records: Readonly<Record<string, unknown>>[] = [];
    const trafficLog = collectWriter(records);
    const balancer = new LoadBalancer("pair-lb");
    balancer.reconfigure(pair([target("target-a", 4321)], [group("lb-solo", ["target-a"])]));
    const pipeline = new ProxyRequestPipeline({
      pairId: "pair-lb",
      defaultTargetId: "target-a",
      loadBalancer: balancer,
      loadSamples: () => EMPTY_LOAD_SAMPLES,
      targets: [pipelineTarget("target-a", 4321, trafficLog)],
    });
    const { port, listener } = await startListener((request, response, context) =>
      pipeline.handle(request, response, context),
    );

    const answer = await post(
      port,
      "/v1/responses",
      bodyFor("Qwen3.8-Flash-Next", "one"),
      session("solo-session"),
    );
    expect(answer.status).toBe(502);
    expect(records.map((record) => record["event"])).toEqual([
      "request_received",
      "request_pending_response",
      "request_finished",
    ]);
    // The early record exists before the body is known, so it carries an empty placeholder
    // and no route: neither the model nor the final node had been decided yet.
    const early = requestOf(eventRecords(records, "request_received")[0]);
    expect(early["body_pending"]).toBe(true);
    const placeholder = isRecord(early["body"]) ? early["body"] : {};
    expect(placeholder["size_bytes"]).toBe(0);
    expect(early["model_route"]).toBeUndefined();
    expect(routeOf(records[0])).toEqual({});
    expect(new Set(records.map((record) => record["id"]))).toEqual(new Set([records[0]?.["id"]]));
    expect(
      new Set(
        records.map((record) => {
          const target = record["target"];
          return isRecord(target) ? target["id"] : undefined;
        }),
      ),
    ).toEqual(new Set(["target-a"]));
    expect(routeOf(eventRecords(records, "request_finished")[0])).toMatchObject({
      route_mode: "load_balance",
      load_balance: { group_id: "lb-solo", decision: "new_task" },
    });
    expect(balancer.inFlight("target-a")).toBe(0);
    await listener.close();
  });

  it("LB06-02 writes the first record only after the body arrived and the node was chosen", async () => {
    const nodeA = await startEchoNode("a");
    const nodeB = await startEchoNode("b");
    const records: Readonly<Record<string, unknown>>[] = [];
    const trafficLog = collectWriter(records);
    const balancer = new LoadBalancer("pair-lb");
    balancer.reconfigure(
      pair(
        [target("target-a", nodeA.port), target("target-b", nodeB.port)],
        [group("lb-pipeline", ["target-a", "target-b"])],
      ),
    );
    const pipeline = new ProxyRequestPipeline({
      pairId: "pair-lb",
      defaultTargetId: "target-a",
      loadBalancer: balancer,
      loadSamples: () => EMPTY_LOAD_SAMPLES,
      targets: [
        pipelineTarget("target-a", nodeA.port, trafficLog),
        pipelineTarget("target-b", nodeB.port, trafficLog),
      ],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      createId: () => "lb-timing",
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();

    const parts = postInTwoParts(
      address.port,
      "/v1/responses",
      bodyFor("Qwen3.8-Flash-Next", "one"),
      session("slow-session"),
    );
    await parts.firstPartSent;
    await new Promise((resolve) => setTimeout(resolve, 60));
    // While the body is still arriving there is no record at all: the final target is
    // not known yet, so no log database may receive a placeholder row.
    expect(records).toEqual([]);

    parts.sendRest();
    await expect.poll(() => records.length).toBeGreaterThanOrEqual(2);
    expect(records.slice(0, 2).map((record) => record["event"])).toEqual([
      "request_received",
      "request_pending_response",
    ]);
    expect(new Set(records.map((record) => record["id"]))).toEqual(new Set(["lb-timing"]));
    expect(
      new Set(
        records.map((record) => {
          const chosen = record["target"];
          return isRecord(chosen) ? chosen["id"] : undefined;
        }),
      ),
    ).toEqual(new Set(["target-a"]));
    expect(requestKeys(records[0])).toContain("body");
    expect(requestOf(records[0])["body_pending"]).toBe(false);
    expect(routeOf(records[0])).toMatchObject({ route_mode: "load_balance" });

    const answer = echoed((await parts.done).body);
    expect(answer.node).toBe("a");
    expect(records).toHaveLength(3);
    expect(balancer.inFlight("target-a")).toBe(0);
    await listener.close();
    await close(nodeA.server);
    await close(nodeB.server);
  });

  it("LB06-04 freezes pricing on the chosen node and reuses that snapshot when finishing", async () => {
    const nodeA = await startEchoNode("a");
    const nodeB = await startEchoNode("b");
    const records: Readonly<Record<string, unknown>>[] = [];
    const trafficLog = collectWriter(records);
    const balancer = new LoadBalancer("pair-lb");
    balancer.reconfigure(
      pair(
        [
          target("target-a", nodeA.port),
          target("target-b", nodeB.port, { model_prices: [{ ...PRICE_RULE }] }),
        ],
        [group("lb-pricing", ["target-a", "target-b"], { model_pattern: "qwen3.8-flash-next*" })],
      ),
    );
    const pipeline = new ProxyRequestPipeline({
      pairId: "pair-lb",
      defaultTargetId: "target-a",
      loadBalancer: balancer,
      loadSamples: () => EMPTY_LOAD_SAMPLES,
      targets: [
        pipelineTarget("target-a", nodeA.port, trafficLog),
        pipelineTarget("target-b", nodeB.port, trafficLog, [], [{ ...PRICE_RULE }]),
      ],
    });
    const { port, listener } = await startListener((request, response, context) =>
      pipeline.handle(request, response, context),
    );

    // Make the priced node the less loaded one so the group has a reason to move.
    balancer.reserve("target-a");
    const answer = echoed(
      (
        await post(
          port,
          "/v1/responses",
          bodyFor("qwen3.8-flash-next", "one"),
          session("pricing-session"),
        )
      ).body,
    );
    expect(answer.node).toBe("b");
    balancer.release("target-a");

    const pending = pricingOf(eventRecords(records, "request_pending_response")[0]);
    expect(pending).toMatchObject({
      pricing_status: "pending",
      pricing_reason: null,
      billing_model: "qwen3.8-flash-next",
      cost_nano_cny: null,
    });
    const snapshot = isRecord(pending["pricing_snapshot"]) ? pending["pricing_snapshot"] : {};
    expect(snapshot).toMatchObject({
      model_pattern: "qwen*",
      input_per_million: "1",
      output_per_million: "2",
      currency: "CNY",
      algorithm_version: 2,
      target_id: "target-b",
      target_name: "Node target-b",
    });

    const finished = pricingOf(eventRecords(records, "request_finished")[0]);
    expect(finished).toMatchObject({
      pricing_status: "priced",
      pricing_reason: null,
      cost_nano_cny: "2000000",
    });
    expect(finished["pricing_snapshot"]).toEqual(snapshot);
    await listener.close();
    await close(nodeA.server);
    await close(nodeB.server);
  });

  it("LB06-05 keeps a group without price rules explicitly unpriced", async () => {
    const nodeA = await startEchoNode("a");
    const nodeB = await startEchoNode("b");
    const records: Readonly<Record<string, unknown>>[] = [];
    const trafficLog = collectWriter(records);
    const balancer = new LoadBalancer("pair-lb");
    balancer.reconfigure(
      pair(
        [target("target-a", nodeA.port), target("target-b", nodeB.port)],
        [group("lb-unpriced", ["target-a", "target-b"], { model_pattern: "qwen3.8-flash-next*" })],
      ),
    );
    const pipeline = new ProxyRequestPipeline({
      pairId: "pair-lb",
      defaultTargetId: "target-a",
      loadBalancer: balancer,
      loadSamples: () => EMPTY_LOAD_SAMPLES,
      targets: [
        pipelineTarget("target-a", nodeA.port, trafficLog),
        pipelineTarget("target-b", nodeB.port, trafficLog),
      ],
    });
    const { port, listener } = await startListener((request, response, context) =>
      pipeline.handle(request, response, context),
    );

    await post(
      port,
      "/v1/responses",
      bodyFor("qwen3.8-flash-next", "one"),
      session("unpriced-session"),
    );
    expect(pricingOf(eventRecords(records, "request_pending_response")[0])).toMatchObject({
      pricing_status: "pending",
      pricing_reason: "no_matching_price",
      billing_model: "qwen3.8-flash-next",
    });
    expect(pricingOf(eventRecords(records, "request_finished")[0])).toMatchObject({
      pricing_status: "unpriced",
      pricing_reason: "no_matching_price",
      cost_nano_cny: null,
    });
    await listener.close();
    await close(nodeA.server);
    await close(nodeB.server);
  });
});
