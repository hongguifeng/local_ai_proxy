import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDefaultProxyPair,
  createDefaultTarget,
  type ProxyPair,
  type TargetConfig,
} from "../../src/config/index.js";
import { TrafficLogService } from "../../src/logging/index.js";
import { LogQueryService } from "../../src/maintenance/index.js";
import { isRecord } from "../../src/shared/index.js";

import {
  EMPTY_LOAD_SAMPLES,
  LoadBalancer,
  ProxyListener,
  ProxyRequestPipeline,
  type ProxyPipelineTarget,
} from "../../src/proxy/index.js";

/**
 * LB-06 fixes when a load balanced request first becomes visible in the history. A row can
 * only exist after the body arrived and a node was chosen; while the body is still being
 * read there is deliberately nothing in any log database. Once the row exists, the batch
 * endpoint must show it without decoding bodies, and the detail loader must still reach the
 * stored body.
 */

type GroupShape = ProxyPair["load_balancers"][number];

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 }),
      ),
  );
});

function target(id: string, port: number, overrides: Partial<TargetConfig> = {}): TargetConfig {
  return {
    ...createDefaultTarget("logs"),
    id,
    name: `Node ${id}`,
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
  trafficLog: TrafficLogService,
): ProxyPipelineTarget {
  return {
    enabled: true,
    id,
    modelMappings: [],
    name: `Node ${id}`,
    targetScheme: "http",
    targetHost: "127.0.0.1",
    targetPort: port,
    targetBasePath: "",
    trafficLog,
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

/** An engine that answers after a delay, so the request stays pending long enough to read. */
function startSlowEcho(
  label: string,
  delayMs: number,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed: unknown = JSON.parse(body === "" ? "{}" : body);
      const model = isRecord(parsed) ? parsed["model"] : undefined;
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: `resp-${label}`,
            model: typeof model === "string" ? model : "",
            node: label,
          }),
        );
      }, delayMs);
    });
  });
  return listen(server).then((port) => ({ server, port }));
}

function post(
  port: number,
  requestPath: string,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method: "POST",
        headers: { "content-type": "application/json" },
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

describe("load balanced records in the history", () => {
  it("LB06-03 shows the pending row by id and still reads its stored body through the detail loader", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-lb-pending-row-"));
    temporaryDirectories.push(root);
    const trafficLog = new TrafficLogService(root);
    const queries = new LogQueryService([root]);
    const engine = await startSlowEcho("a", 300);

    const balancer = new LoadBalancer("pair-lb");
    balancer.reconfigure(pair([target("target-a", engine.port)], [group("lb-solo", ["target-a"])]));
    const pipeline = new ProxyRequestPipeline({
      pairId: "pair-lb",
      defaultTargetId: "target-a",
      loadBalancer: balancer,
      loadSamples: () => EMPTY_LOAD_SAMPLES,
      targets: [pipelineTarget("target-a", engine.port, trafficLog)],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      createId: () => "lb-pending-row",
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();

    const inflight = post(
      address.port,
      "/v1/responses",
      JSON.stringify({
        model: "Qwen3.8-Flash-Next",
        input: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    );

    // The row exists as soon as the pipeline chose a node, and the batch endpoint can
    // return it without decoding the stored body.
    await expect
      .poll(() => queries.listRecordsByIds(["lb-pending-row"]).records.length, { timeout: 5_000 })
      .toBe(1);
    const row = queries.listRecordsByIds(["lb-pending-row"]).records[0];
    if (row === undefined) {
      throw new Error("the batch read stopped returning the pending row");
    }
    expect(row).toMatchObject({
      id: "lb-pending-row",
      method: "POST",
      path: "/v1/responses",
      pending: true,
      target: `http://127.0.0.1:${engine.port}/v1/responses`,
    });
    expect(Object.keys(row)).not.toContain("request_body_json");
    expect(Object.keys(row)).not.toContain("response_body_json");

    // The body columns are empty once the text moved to chunks, yet the detail loader
    // still reaches the stored bytes, and the route chosen for the request is visible.
    const pendingDetail = queries.getRecordDetail("lb-pending-row");
    expect(pendingDetail).toMatchObject({ id: "lb-pending-row", pending: true });
    expect(pendingDetail?.request).toMatchObject({ model: "Qwen3.8-Flash-Next" });
    expect(pendingDetail?.request_meta).toMatchObject({
      model_route: { route_mode: "load_balance", target_id: "target-a" },
    });

    const answer = await inflight;
    expect(answer.status).toBe(200);

    const finishedDetail = queries.getRecordDetail("lb-pending-row");
    expect(finishedDetail).toMatchObject({ pending: false });
    expect(finishedDetail?.response).toMatchObject({ node: "a" });
    expect(finishedDetail?.request_meta).toMatchObject({
      model_route: {
        route_mode: "load_balance",
        load_balance: { group_id: "lb-solo", decision: "new_task" },
      },
    });

    // The record joined a task, so history grouping and affinity see the same request.
    const taskId = finishedDetail?.request_meta["task_id"];
    expect(typeof taskId === "string" && taskId !== "").toBe(true);
    const groupLogs = typeof taskId === "string" ? queries.getGroupLogs(taskId) : undefined;
    expect(groupLogs?.logs.map((log) => log.id)).toEqual(["lb-pending-row"]);

    expect(balancer.inFlight("target-a")).toBe(0);
    await listener.close();
    await close(engine.server);
    await trafficLog.close();
  });
});
