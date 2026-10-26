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
  type LoadSample,
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

function bodyFor(model: string, ...turns: string[]): string {
  return JSON.stringify({
    model,
    input: turns.map((turn) => ({ role: "user", content: turn })),
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

  it("LB19-06 forwards each member's own model id and keeps follow-ups on it", async () => {
    const nodeA = await startEchoNode("a");
    const nodeB = await startEchoNode("b");
    const records: Readonly<Record<string, unknown>>[] = [];
    const trafficLog = collectWriter(records);
    const balancer = new LoadBalancer("pair-lb");
    balancer.reconfigure(
      pair(
        [target("target-a", nodeA.port), target("target-b", nodeB.port)],
        [
          {
            ...group("lb-19", ["target-a", "target-b"]),
            members: [
              { target_id: "target-a", model_id: "Model-On-A" },
              { target_id: "target-b", model_id: "" },
            ],
          },
        ],
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

    const answers = [];
    // Two different first turns: identical content would collapse into one task key.
    const turns = {
      "session-lb19-a": ["one", "two"],
      "session-lb19-b": ["alpha", "beta"],
    };
    for (const [sessionId, sessionTurns] of Object.entries(turns)) {
      for (const turn of sessionTurns) {
        answers.push(
          echoed(
            (
              await post(
                port,
                "/v1/responses",
                bodyFor("Qwen3.8-Flash-Next", turn),
                session(sessionId),
              )
            ).body,
          ),
        );
      }
    }

    // Each session stays on one node, and that node only ever hears its own name.
    expect(answers[0]?.node).toBe(answers[1]?.node);
    expect(answers[2]?.node).toBe(answers[3]?.node);
    expect(answers[0]?.node).not.toBe(answers[2]?.node);
    expect(nodeA.seen.every((model) => model === "Model-On-A")).toBe(true);
    expect(nodeB.seen.every((model) => model === "Qwen3.8-Flash-Next")).toBe(true);
    expect(nodeA.seen.length + nodeB.seen.length).toBe(4);
    expect(answers.map((answer) => answer.model)).toEqual(
      answers.map((answer) => (answer.node === "a" ? "Model-On-A" : "Qwen3.8-Flash-Next")),
    );

    const finished = finishedRecords(records);
    expect(finished).toHaveLength(4);
    finished.forEach((record) => {
      const route = routeOf(record);
      expect(route["requested_model"]).toBe("Qwen3.8-Flash-Next");
      expect(route["upstream_model"]).toBe(
        route["target_id"] === "target-a" ? "Model-On-A" : "Qwen3.8-Flash-Next",
      );
      expect(route["route_mode"]).toBe("load_balance");
    });
    await listener.close();
    await close(nodeA.server);
    await close(nodeB.server);
  });

  it("LB19-07 rewrites the model again for the node that takes over", async () => {
    const nodeB = await startEchoNode("b");
    const records: Readonly<Record<string, unknown>>[] = [];
    const trafficLog = collectWriter(records);
    const balancer = new LoadBalancer("pair-lb");
    balancer.reconfigure(
      pair(
        [target("target-a", 1), target("target-b", nodeB.port)],
        [
          {
            ...group("lb-19-fail", ["target-a", "target-b"]),
            members: [
              { target_id: "target-a", model_id: "Model-On-A" },
              { target_id: "target-b", model_id: "Model-On-B" },
            ],
          },
        ],
      ),
    );
    const pipeline = new ProxyRequestPipeline({
      pairId: "pair-lb",
      defaultTargetId: "target-a",
      loadBalancer: balancer,
      loadSamples: () => EMPTY_LOAD_SAMPLES,
      targets: [
        pipelineTarget("target-a", 1, trafficLog),
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
          session("session-lb19-fail"),
        )
      ).body,
    );

    // The takeover node answers under its own name, not the one the dead node wanted.
    expect(answer.node).toBe("b");
    expect(answer.model).toBe("Model-On-B");
    expect(nodeB.seen).toEqual(["Model-On-B"]);

    const finished = eventRecords(records, "request_finished")[0];
    expect(routeOf(finished)).toMatchObject({
      route_mode: "load_balance",
      target_id: "target-b",
      requested_model: "Qwen3.8-Flash-Next",
      upstream_model: "Model-On-B",
      load_balance: { decision: "failover", failover_from: "target-a" },
    });
    // What the log calls the upstream body is what the answering node received.
    const upstreamBody = requestOf(finished)["upstream_body"];
    if (!isRecord(upstreamBody)) {
      throw new Error("the failover record did not carry the body it sent");
    }
    expect(String(upstreamBody["text"])).toContain("Model-On-B");
    expect(String(upstreamBody["text"])).not.toContain("Model-On-A");

    await listener.close();
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

    // An upstream that refuses the connection also releases its reservation. Failover is
    // switched off here so the refusal itself stays visible to the client.
    const refusedTargets = pair(
      [target("target-a", nodeA.port), target("target-b", 1)],
      [group("lb-refused", ["target-a", "target-b"], { failover_enabled: false })],
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

/** An engine that answers with a chosen status, so a plain 4xx/5xx stays an upstream answer. */
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

/** An engine that sends headers and one chunk, waits, then breaks the connection mid-body. */
async function startResetNode(label: string): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-my-sse" });
    response.write(`data: {"id":"resp-${label}","node":"${label}"}\n\n`);
    // Wait long enough that the client has certainly taken the response head, so a
    // switch here would mix two bodies into one response.
    setTimeout(() => response.socket?.destroy(), 150);
  });
  const port = await listen(server);
  return { server, port };
}

/** Reads a response that may end early, the way a broken upstream connection does. */
function postTolerant(
  port: number,
  requestPath: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; truncated: boolean }> {
  return new Promise((resolve) => {
    let text = "";
    let settled = false;
    const finish = (status: number, truncated: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ status, body: text, truncated });
    };
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
      },
      (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => {
          finish(response.statusCode ?? 0, false);
        });
        response.on("error", () => {
          finish(response.statusCode ?? 0, true);
        });
      },
    );
    request.on("error", () => {
      finish(0, true);
    });
    request.end(body);
  });
}

function engineSample(overrides: { awake?: boolean; running?: number } = {}): LoadSample {
  return {
    sampledAt: Date.now(),
    running: overrides.running ?? 0,
    waiting: 0,
    kvUsage: undefined,
    source: "vllm",
    ...(overrides.awake === undefined ? {} : { awake: overrides.awake }),
  };
}

function responseStatusOf(record: Readonly<Record<string, unknown>> | undefined): unknown {
  const response = record?.["response"];
  return isRecord(response) ? response["status"] : undefined;
}

function errorOf(record: Readonly<Record<string, unknown>> | undefined): string {
  const error = record?.["error"];
  return typeof error === "string" ? error : "";
}

/** The only `load_balance` keys a record may carry; detail stays in memory. */
const LOAD_BALANCE_RECORD_KEYS: readonly string[] = [
  "decision",
  "failover_from",
  "group_id",
  "group_name",
  "kv_usage",
  "load",
  "logged_by",
  "matched_by",
  "metrics_source",
  "strategy",
];

describe("route records that explain the choice", () => {
  it("LB09-01 every decision stays short and readable in the history record", async () => {
    const healthy = await startEchoNode("healthy");
    const records: Readonly<Record<string, unknown>>[] = [];
    const trafficLog = collectWriter(records);
    const balancer = new LoadBalancer("pair-lb");
    balancer.reconfigure(
      pair(
        [target("target-healthy", healthy.port), target("target-refused", 1)],
        [group("lb-shapes", ["target-healthy", "target-refused"])],
      ),
    );
    const pipeline = new ProxyRequestPipeline({
      pairId: "pair-lb",
      defaultTargetId: "target-healthy",
      loadBalancer: balancer,
      loadSamples: () => EMPTY_LOAD_SAMPLES,
      targets: [
        pipelineTarget("target-healthy", healthy.port, trafficLog),
        pipelineTarget("target-refused", 1, trafficLog),
      ],
    });
    const { port, listener } = await startListener((request, response, context) =>
      pipeline.handle(request, response, context),
    );

    // A task with no history goes to the node carrying no load.
    const first = await post(
      port,
      "/v1/responses",
      bodyFor("Qwen3.8-Flash-Next", "shape-turn-one"),
      session("shape-session"),
    );
    expect(first.status).toBe(200);

    // The same task comes back to the node it was bound to.
    const second = await post(
      port,
      "/v1/responses",
      bodyFor("Qwen3.8-Flash-Next", "shape-turn-one", "shape-turn-two"),
      session("shape-session"),
    );
    expect(second.status).toBe(200);

    // With the idle node busy, a fresh task starts on the refused node and switches.
    balancer.reserve("target-healthy");
    const third = await post(
      port,
      "/v1/responses",
      bodyFor("Qwen3.8-Flash-Next", "shape-turn-three"),
      session("shape-session-two"),
    );
    expect(third.status).toBe(200);
    balancer.release("target-healthy");

    // Nothing usable left: the group answers 503 instead of bypassing itself.
    balancer.reconfigure(
      pair(
        [
          target("target-healthy", healthy.port, { enabled: false }),
          target("target-refused", 1, { enabled: false }),
        ],
        [group("lb-shapes", ["target-healthy", "target-refused"])],
      ),
    );
    const fourth = await post(
      port,
      "/v1/responses",
      bodyFor("Qwen3.8-Flash-Next", "shape-turn-four"),
      session("another-session"),
    );
    expect(fourth.status).toBe(503);

    const decisions = eventRecords(records, "request_finished").map((record) => {
      const route = routeOf(record);
      const loadBalance = isRecord(route["load_balance"]) ? route["load_balance"] : {};
      const decision = loadBalance["decision"];
      return typeof decision === "string" ? decision : "";
    });
    expect(decisions).toEqual(["new_task", "affinity", "failover", "no_healthy_node"]);

    for (const record of eventRecords(records, "request_finished")) {
      const route = routeOf(record);
      expect(route["route_mode"]).toBe("load_balance");
      const loadBalance = isRecord(route["load_balance"]) ? route["load_balance"] : {};
      expect(Object.keys(loadBalance).every((key) => LOAD_BALANCE_RECORD_KEYS.includes(key))).toBe(
        true,
      );
      // A record explains the choice without repeating anything the user typed.
      expect(JSON.stringify(loadBalance)).not.toContain("shape-turn");
    }

    const refusedRecord = eventRecords(records, "request_finished")[3];
    const refusedRoute = routeOf(refusedRecord);
    const refusedBalance = isRecord(refusedRoute["load_balance"])
      ? refusedRoute["load_balance"]
      : undefined;
    expect(isRecord(refusedBalance) ? refusedBalance["logged_by"] : undefined).toBe(
      "target-healthy",
    );
    expect(responseStatusOf(refusedRecord)).toBe(503);
    expect(pricingOf(refusedRecord)).toMatchObject({
      pricing_status: "unpriced",
      cost_nano_cny: null,
    });

    await listener.close();
    await close(healthy.server);
  });

  it("LB09-02 a disabled group or an unmatched model keeps ordinary routing and invents nothing", async () => {
    const node = await startEchoNode("plain");

    // The group matches the model but is turned off.
    const offRecords: Readonly<Record<string, unknown>>[] = [];
    const offLog = collectWriter(offRecords);
    const offBalancer = new LoadBalancer("pair-lb");
    offBalancer.reconfigure(
      pair([target("target-a", node.port)], [group("lb-off", ["target-a"], { enabled: false })]),
    );
    const offPipeline = new ProxyRequestPipeline({
      pairId: "pair-lb",
      defaultTargetId: "target-a",
      loadBalancer: offBalancer,
      loadSamples: () => EMPTY_LOAD_SAMPLES,
      targets: [pipelineTarget("target-a", node.port, offLog)],
    });
    const off = await startListener((request, response, context) =>
      offPipeline.handle(request, response, context),
    );
    const offAnswer = await post(
      off.port,
      "/v1/responses",
      bodyFor("Qwen3.8-Flash-Next", "one"),
      session("disabled-group-session"),
    );
    expect(offAnswer.status).toBe(200);
    expect(echoed(offAnswer.body).model).toBe("Qwen3.8-Flash-Next");

    // The group is on, but for a model this request never asked for.
    const otherRecords: Readonly<Record<string, unknown>>[] = [];
    const otherLog = collectWriter(otherRecords);
    const otherBalancer = new LoadBalancer("pair-lb");
    otherBalancer.reconfigure(
      pair(
        [target("target-a", node.port)],
        [group("lb-other", ["target-a"], { model_pattern: "Other-Model" })],
      ),
    );
    const otherPipeline = new ProxyRequestPipeline({
      pairId: "pair-lb",
      defaultTargetId: "target-a",
      loadBalancer: otherBalancer,
      loadSamples: () => EMPTY_LOAD_SAMPLES,
      targets: [pipelineTarget("target-a", node.port, otherLog)],
    });
    const other = await startListener((request, response, context) =>
      otherPipeline.handle(request, response, context),
    );
    const otherAnswer = await post(
      other.port,
      "/v1/responses",
      bodyFor("Qwen3.8-Flash-Next", "one"),
      session("unmatched-session"),
    );
    expect(otherAnswer.status).toBe(200);

    for (const collected of [offRecords, otherRecords]) {
      const route = routeOf(eventRecords(collected, "request_finished")[0]);
      expect(Object.keys(route).length).toBeGreaterThan(0);
      expect(Object.hasOwn(route, "load_balance")).toBe(false);
      expect(Object.hasOwn(route, "route_mode")).toBe(false);
      expect(Object.hasOwn(route, "fallback_disabled")).toBe(false);
      // Ordinary routing still explains where the request went.
      expect(route["target_id"]).toBe("target-a");
    }

    await off.listener.close();
    await other.listener.close();
    await close(node.server);
  });
});

describe("connection failover and refused groups", () => {
  it("LB07-01 switches once when the chosen node refuses the connection", async () => {
    const healthy = await startEchoNode("healthy");
    const records: Readonly<Record<string, unknown>>[] = [];
    const trafficLog = collectWriter(records);
    const balancer = new LoadBalancer("pair-lb");
    // The refused node is listed first, so an even load sends the task there.
    balancer.reconfigure(
      pair(
        [target("target-refused", 1), target("target-healthy", healthy.port)],
        [group("lb-failover", ["target-refused", "target-healthy"])],
      ),
    );
    const pipeline = new ProxyRequestPipeline({
      pairId: "pair-lb",
      defaultTargetId: "target-refused",
      loadBalancer: balancer,
      loadSamples: () => EMPTY_LOAD_SAMPLES,
      targets: [
        pipelineTarget("target-refused", 1, trafficLog),
        pipelineTarget("target-healthy", healthy.port, trafficLog),
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
          session("switched-session"),
        )
      ).body,
    );
    expect(answer).toMatchObject({ node: "healthy", model: "Qwen3.8-Flash-Next" });
    // The client sees exactly one response head and one body.
    expect(healthy.seen).toEqual(["Qwen3.8-Flash-Next"]);

    const finished = eventRecords(records, "request_finished")[0];
    expect(responseStatusOf(finished)).toBe(200);
    expect(finished?.["error"]).toBeUndefined();
    expect(routeOf(finished)).toMatchObject({
      route_mode: "load_balance",
      target_id: "target-healthy",
      load_balance: {
        group_id: "lb-failover",
        decision: "failover",
        failover_from: "target-refused",
      },
    });
    expect(balancer.cooldownRemaining("target-refused", Date.now())).toBeGreaterThan(0);
    expect(balancer.cooldownRemaining("target-healthy", Date.now())).toBe(0);
    expect(balancer.inFlight("target-refused")).toBe(0);
    expect(balancer.inFlight("target-healthy")).toBe(0);

    // TRI-01: the switch moved the task, and the move is visible on the binding itself.
    // Looking the binding up by number does not touch its TTL or its counters.
    const failoverTable = balancer.tableFor("lb-failover");
    if (failoverTable === undefined) {
      throw new Error("An enabled group must have an affinity table.");
    }
    const movedBinding = failoverTable.bindingForId(1);
    if (movedBinding === undefined) {
      throw new Error("The task must still carry its binding.");
    }
    expect(movedBinding.targetId).toBe("target-healthy");
    expect(movedBinding.routingRevision).toBe(1);

    // LB07-05: the task now belongs to the node that answered, not the one that refused.
    const second = echoed(
      (
        await post(
          port,
          "/v1/responses",
          bodyFor("Qwen3.8-Flash-Next", "two"),
          session("switched-session"),
        )
      ).body,
    );
    expect(second.node).toBe("healthy");
    expect(routeOf(eventRecords(records, "request_finished")[1])).toMatchObject({
      load_balance: { decision: "affinity", failover_from: null },
    });
    // TRI-01: a follow-up that stays on the node the failover chose moves no revision.
    expect(movedBinding.routingRevision).toBe(1);

    await listener.close();
    await close(healthy.server);
  });

  it("LB07-02 does not chain retries when both nodes refuse", async () => {
    const records: Readonly<Record<string, unknown>>[] = [];
    const trafficLog = collectWriter(records);
    const balancer = new LoadBalancer("pair-lb");
    balancer.reconfigure(
      pair(
        [target("target-a", 1), target("target-b", 1)],
        [group("lb-dead", ["target-a", "target-b"])],
      ),
    );
    const pipeline = new ProxyRequestPipeline({
      pairId: "pair-lb",
      defaultTargetId: "target-a",
      loadBalancer: balancer,
      loadSamples: () => EMPTY_LOAD_SAMPLES,
      targets: [
        pipelineTarget("target-a", 1, trafficLog),
        pipelineTarget("target-b", 1, trafficLog),
      ],
    });
    const { port, listener } = await startListener((request, response, context) =>
      pipeline.handle(request, response, context),
    );

    const answer = await post(
      port,
      "/v1/responses",
      bodyFor("Qwen3.8-Flash-Next", "one"),
      session("dead-session"),
    );
    expect(answer.status).toBe(502);
    expect(answer.body).toContain("Bad Gateway");

    const finished = eventRecords(records, "request_finished")[0];
    expect(responseStatusOf(finished)).toBe(502);
    expect(errorOf(finished)).toContain("ECONNREFUSED");
    expect(routeOf(finished)).toMatchObject({
      route_mode: "load_balance",
      target_id: "target-b",
      load_balance: { decision: "failover", failover_from: "target-a" },
    });
    // One attempt per node, and both are cooled down.
    expect(eventRecords(records, "request_received")).toHaveLength(1);
    expect(balancer.cooldownRemaining("target-a", Date.now())).toBeGreaterThan(0);
    expect(balancer.cooldownRemaining("target-b", Date.now())).toBeGreaterThan(0);
    expect(balancer.inFlight("target-a")).toBe(0);
    expect(balancer.inFlight("target-b")).toBe(0);

    await listener.close();
  });

  it("LB07-03 leaves an upstream 4xx or 5xx alone: no switch, no cooldown", async () => {
    const angry = await startStatusNode("angry", 503);
    const calm = await startEchoNode("calm");
    const records: Readonly<Record<string, unknown>>[] = [];
    const trafficLog = collectWriter(records);
    const balancer = new LoadBalancer("pair-lb");
    balancer.reconfigure(
      pair(
        [target("target-angry", angry.port), target("target-calm", calm.port)],
        [group("lb-status", ["target-angry", "target-calm"])],
      ),
    );
    const pipeline = new ProxyRequestPipeline({
      pairId: "pair-lb",
      defaultTargetId: "target-angry",
      loadBalancer: balancer,
      loadSamples: () => EMPTY_LOAD_SAMPLES,
      targets: [
        pipelineTarget("target-angry", angry.port, trafficLog),
        pipelineTarget("target-calm", calm.port, trafficLog),
      ],
    });
    const { port, listener } = await startListener((request, response, context) =>
      pipeline.handle(request, response, context),
    );

    const answer = await post(
      port,
      "/v1/responses",
      bodyFor("Qwen3.8-Flash-Next", "one"),
      session("status-session"),
    );
    expect(answer.status).toBe(503);
    expect(echoed(answer.body).node).toBe("angry");
    expect(calm.seen).toEqual([]);
    expect(balancer.cooldownRemaining("target-angry", Date.now())).toBe(0);
    expect(routeOf(eventRecords(records, "request_finished")[0])).toMatchObject({
      route_mode: "load_balance",
      target_id: "target-angry",
      load_balance: { decision: "new_task", failover_from: null },
    });

    await listener.close();
    await close(angry.server);
    await close(calm.server);
  });

  it("LB07-04 never switches after the response head reached the client", async () => {
    const breaker = await startResetNode("breaker");
    const idle = await startEchoNode("idle");
    const records: Readonly<Record<string, unknown>>[] = [];
    const trafficLog = collectWriter(records);
    const balancer = new LoadBalancer("pair-lb");
    balancer.reconfigure(
      pair(
        [target("target-breaker", breaker.port), target("target-idle", idle.port)],
        [group("lb-midstream", ["target-breaker", "target-idle"])],
      ),
    );
    const pipeline = new ProxyRequestPipeline({
      pairId: "pair-lb",
      defaultTargetId: "target-breaker",
      loadBalancer: balancer,
      loadSamples: () => EMPTY_LOAD_SAMPLES,
      targets: [
        pipelineTarget("target-breaker", breaker.port, trafficLog),
        pipelineTarget("target-idle", idle.port, trafficLog),
      ],
    });
    const { port, listener } = await startListener((request, response, context) =>
      pipeline.handle(request, response, context),
    );

    const answer = await postTolerant(
      port,
      "/v1/responses",
      bodyFor("Qwen3.8-Flash-Next", "one"),
      session("mid-session"),
    );
    expect(answer.status).toBe(200);
    expect(answer.truncated).toBe(true);
    expect(answer.body).toContain("breaker");
    // Switching now would append a second body to a response already half delivered.
    expect(idle.seen).toEqual([]);
    expect(routeOf(eventRecords(records, "request_finished")[0])).toMatchObject({
      route_mode: "load_balance",
      target_id: "target-breaker",
      load_balance: { decision: "new_task", failover_from: null },
    });
    await expect.poll(() => balancer.inFlight("target-breaker"), { timeout: 5_000 }).toBe(0);

    await listener.close();
    await close(breaker.server);
    await close(idle.server);
  });

  it("LB07-06 answers 503 when the group has no usable node and never bypasses the group", async () => {
    const records: Readonly<Record<string, unknown>>[] = [];
    const trafficLog = collectWriter(records);
    const balancer = new LoadBalancer("pair-lb");

    // Every member disabled.
    balancer.reconfigure(
      pair(
        [target("target-a", 1, { enabled: false }), target("target-b", 1, { enabled: false })],
        [group("lb-off", ["target-a", "target-b"])],
      ),
    );
    const disabledPipeline = new ProxyRequestPipeline({
      pairId: "pair-lb",
      defaultTargetId: "target-a",
      loadBalancer: balancer,
      loadSamples: () => EMPTY_LOAD_SAMPLES,
      targets: [
        pipelineTarget("target-a", 1, trafficLog, [], []),
        pipelineTarget("target-b", 1, trafficLog),
      ],
    });
    const off = await startListener((request, response, context) =>
      disabledPipeline.handle(request, response, context),
    );
    const refused = await post(
      off.port,
      "/v1/responses",
      bodyFor("Qwen3.8-Flash-Next", "one"),
      session("off-session"),
    );
    expect(refused.status).toBe(503);
    expect(refused.body).toContain("lb-off");
    const refusal = eventRecords(records, "request_finished")[0];
    expect(responseStatusOf(refusal)).toBe(503);
    expect(errorOf(refusal)).toContain("lb-off");
    expect(routeOf(refusal)).toMatchObject({
      route_mode: "load_balance",
      load_balance: { group_id: "lb-off", decision: "no_healthy_node", logged_by: "target-a" },
    });
    expect(pricingOf(refusal)).toMatchObject({ pricing_status: "unpriced", cost_nano_cny: null });
    await off.listener.close();

    // Every engine asleep.
    const sleeping = new Map<string, LoadSample>([
      ["target-a", engineSample({ awake: false })],
      ["target-b", engineSample({ awake: false })],
    ]);
    balancer.reconfigure(
      pair(
        [target("target-a", 1), target("target-b", 1)],
        [group("lb-asleep", ["target-a", "target-b"])],
      ),
    );
    const asleepPipeline = new ProxyRequestPipeline({
      pairId: "pair-lb",
      defaultTargetId: "target-a",
      loadBalancer: balancer,
      loadSamples: () => sleeping,
      targets: [
        pipelineTarget("target-a", 1, trafficLog),
        pipelineTarget("target-b", 1, trafficLog),
      ],
    });
    const asleep = await startListener((request, response, context) =>
      asleepPipeline.handle(request, response, context),
    );
    const asleepAnswer = await post(
      asleep.port,
      "/v1/responses",
      bodyFor("Qwen3.8-Flash-Next", "two"),
      session("asleep-session"),
    );
    expect(asleepAnswer.status).toBe(503);
    expect(routeOf(eventRecords(records, "request_finished")[1])).toMatchObject({
      load_balance: { group_id: "lb-asleep", decision: "no_healthy_node" },
    });
    await asleep.listener.close();

    // A group that names no node cannot answer, and has no log host to describe it.
    balancer.reconfigure(pair([target("target-a", 1)], [group("lb-empty", [])]));
    const emptyPipeline = new ProxyRequestPipeline({
      pairId: "pair-lb",
      defaultTargetId: "target-a",
      loadBalancer: balancer,
      loadSamples: () => EMPTY_LOAD_SAMPLES,
      targets: [pipelineTarget("target-a", 1, trafficLog)],
    });
    const empty = await startListener((request, response, context) =>
      emptyPipeline.handle(request, response, context),
    );
    const emptyAnswer = await post(
      empty.port,
      "/v1/responses",
      bodyFor("Qwen3.8-Flash-Next", "three"),
      session("empty-session"),
    );
    expect(emptyAnswer.status).toBe(503);
    await empty.listener.close();
  });

  it("LB07-07 cools a failed node but never punishes one the client walked away from", async () => {
    const stalled = await startStallNode();
    const records: Readonly<Record<string, unknown>>[] = [];
    const trafficLog = collectWriter(records);
    const balancer = new LoadBalancer("pair-lb");
    balancer.reconfigure(
      pair(
        [target("target-stall", stalled.port), target("target-refused", 1)],
        [group("lb-abort", ["target-stall", "target-refused"], { failover_enabled: false })],
      ),
    );
    const pipeline = new ProxyRequestPipeline({
      pairId: "pair-lb",
      defaultTargetId: "target-stall",
      loadBalancer: balancer,
      loadSamples: () => EMPTY_LOAD_SAMPLES,
      targets: [
        pipelineTarget("target-stall", stalled.port, trafficLog),
        pipelineTarget("target-refused", 1, trafficLog),
      ],
    });
    const { port, listener } = await startListener((request, response, context) =>
      pipeline.handle(request, response, context),
    );

    await postAndAbandon(port, "/v1/responses", bodyFor("Qwen3.8-Flash-Next", "one"));
    await expect.poll(() => balancer.inFlight("target-stall"), { timeout: 5_000 }).toBe(0);
    expect(balancer.cooldownRemaining("target-stall", Date.now())).toBe(0);

    // A refused connection does cool its node.
    balancer.reserve("target-stall");
    const refused = await post(
      port,
      "/v1/responses",
      bodyFor("Qwen3.8-Flash-Next", "two"),
      session("refused-session"),
    );
    expect(refused.status).toBe(502);
    expect(balancer.cooldownRemaining("target-refused", Date.now())).toBeGreaterThan(0);
    expect(balancer.cooldownRemaining("target-stall", Date.now())).toBe(0);
    expect(balancer.inFlight("target-refused")).toBe(0);
    balancer.release("target-stall");

    await listener.close();
    await close(stalled.server);
  });
});
