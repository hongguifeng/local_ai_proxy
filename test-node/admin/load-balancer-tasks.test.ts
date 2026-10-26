import http from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { applicationHealth, createAdminServer } from "../../src/admin/index.js";
import type { AdminLoadBalancerTasksResponse } from "../../src/admin/admin-schemas.js";
import {
  createDefaultProxyPair,
  createDefaultTarget,
  type ProxyPair,
  type PublicProxyPair,
  type TargetConfig,
} from "../../src/config/index.js";
import { BindingHistoryService } from "../../src/maintenance/index.js";
import { TrafficRepository } from "../../src/persistence/index.js";
import {
  LoadBalancer,
  LoadMonitor,
  createLoadBalancerAdminService,
  taskIdentity,
  type LoadBalancerAdminSource,
  type LoadBalancerBindingEntry,
  type LoadBalancerBindingListResponse,
} from "../../src/proxy/index.js";

/**
 * [TRI-05] the read-only binding list on a real route: the address a row carries, the states the
 * activity ledger can support, how an engine answer is reported when it is incomplete, what a
 * history reader says when it found nothing, when it could not read, and when it had to stop at a
 * cap. Every case runs through `createAdminServer`, so the schema the route carries is the one
 * Fastify compiles, and the history rows are read from a real SQLite file. The assembled
 * application is covered by `test-node/admin/api-contract.test.ts`.
 */

type GroupShape = ProxyPair["load_balancers"][number];

const servers: ReturnType<typeof createAdminServer>[] = [];
const engines: http.Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.close()));
  await Promise.all(
    engines.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      // Windows can hold the log file for a moment after a connection closes, so the same
      // retry the other admin fixtures use is what makes cleanup land.
      rm(directory, { force: true, recursive: true, maxRetries: 6, retryDelay: 300 }),
    ),
  );
});

/** The text none of these answers may ever repeat, whatever the history says. */
const PRIVATE_USER_TEXT = "the private prompt the console must never see";
const PRIVATE_BODY_TEXT = "the private request body the console must never see";
const SECRET_API_KEY = "sk-secret-value";

const DEFAULT_QUERY = "?pairId=pair-a&groupId=lb-live";

const TOP_LEVEL_KEYS = [
  "groupRevision",
  "groupId",
  "hasMore",
  "items",
  "limit",
  "migration",
  "nextOffset",
  "nodes",
  "now",
  "offset",
  "pairId",
  "runtimeEpoch",
  "targetFilter",
  "totalBindings",
] as const;

async function newLogRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-binding-list-"));
  temporaryDirectories.push(root);
  return root;
}

async function startEngine(
  exposition: string,
): Promise<{ server: http.Server; port: number; hits: () => number }> {
  let counted = 0;
  const server = http.createServer((_request, response) => {
    counted += 1;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(exposition);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a port");
  }
  engines.push(server);
  return { server, port: address.port, hits: () => counted };
}

const VLLM_EXPOSITION = `vllm:num_requests_running{engine="0"} 3.0
vllm:num_requests_waiting{engine="0"} 2.0
vllm:kv_cache_usage_perc{engine="0"} 0.35
`;

/** An exposition that answers only the KV share, so the load numbers stay missing. */
const KV_ONLY_EXPOSITION = `vllm:kv_cache_usage_perc{engine="0"} 0.5
`;

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

function publicPair(value: ProxyPair, running = true): PublicProxyPair {
  return { ...value, actual_listen_port: running ? 43_123 : null, running };
}

/**
 * The assembly the service is built from. `logRootForTarget` answers only the node the test
 * writes history for, so a binding on any other node reports `no_log_configured` - a state the
 * read has to show rather than an empty history that could be mistaken for "nothing ran here".
 */
function source(
  pairs: readonly ProxyPair[],
  balancer: LoadBalancer | undefined,
  monitor: LoadMonitor | undefined,
  options: {
    readonly logRoot?: string | undefined;
    readonly history?: BindingHistoryService | undefined;
    readonly running?: boolean | undefined;
  } = {},
): LoadBalancerAdminSource {
  return {
    bindingHistory: options.history ?? new BindingHistoryService(),
    loadBalancer: (pairId) => (pairId === "pair-a" ? balancer : undefined),
    loadMonitor: (pairId) => (pairId === "pair-a" ? monitor : undefined),
    logRootForTarget: (pairId, targetId) =>
      options.logRoot !== undefined && pairId === "pair-a" && targetId === "target-a"
        ? options.logRoot
        : undefined,
    pairs: () =>
      pairs.map((item) => publicPair(item, (options.running ?? true) && item.id === "pair-a")),
  };
}

function adminServer(source: LoadBalancerAdminSource): ReturnType<typeof createAdminServer> {
  const server = createAdminServer({
    getHealth: () => applicationHealth("running"),
    loadBalancerService: createLoadBalancerAdminService(source),
  });
  servers.push(server);
  return server;
}

async function readTasks(
  server: ReturnType<typeof createAdminServer>,
  query: string,
): Promise<{ statusCode: number; body: AdminLoadBalancerTasksResponse; payload: string }> {
  const response = await server.inject({
    method: "GET",
    url: `/api/load-balancer/tasks${query}`,
  });
  return {
    statusCode: response.statusCode,
    body: response.json<AdminLoadBalancerTasksResponse>(),
    payload: response.payload,
  };
}

/**
 * One task's identity. Each session id produces its own exact keys and its own user-message
 * hash, so separate sessions cannot collide into one binding through the prefix bucket.
 */
function identity(sessionId: string) {
  return taskIdentity({
    payload: {
      model: "Qwen3.8-Flash-Next",
      input: [{ role: "user", content: `message-${sessionId}` }],
      conversation: { id: `conv-${sessionId}` },
      prompt_cache_key: `pc-${sessionId}`,
    },
    headers: { "x-claude-code-session-id": [sessionId] },
    path: "/v1/responses",
  });
}

/** Bind a task to a node without running it through the request path. */
function bind(balancer: LoadBalancer, groupId: string, sessionId: string, targetId: string) {
  const table = balancer.tableFor(groupId);
  if (table === undefined) {
    throw new Error(`The group ${groupId} must have an affinity table.`);
  }
  return table.bind(identity(sessionId), targetId);
}

function entryOf(
  balancer: LoadBalancer,
  groupId: string,
  bindingId: number,
): LoadBalancerBindingEntry {
  const entry = balancer
    .bindingSnapshot(groupId)
    ?.entries.find((item) => item.ref.bindingId === bindingId);
  if (entry === undefined) {
    throw new Error(`The projection must still list binding ${bindingId}.`);
  }
  return entry;
}

/** A task row whose stored boundary is the one this binding was built from. */
function taskRow(
  taskId: string,
  entry: LoadBalancerBindingEntry,
  overrides: {
    readonly target?: string | undefined;
    readonly lastSeenAt?: string | undefined;
    readonly pending?: boolean | undefined;
    readonly endpoint?: string | undefined;
    /** Null for a task no response has ever answered: a pending row has nothing to stamp. */
    readonly responseAt?: string | null | undefined;
    /** A boundary cell this binding never recorded, so its link no longer matches it. */
    readonly instructions?: string | undefined;
  } = {},
) {
  const lastSeenAt = overrides.lastSeenAt ?? "2026-07-18T09:00:00.000+08:00";
  return {
    id: taskId,
    kind: entry.evidence.kind,
    endpoint: overrides.endpoint ?? entry.evidence.endpoint,
    model: entry.evidence.model,
    anchor: `task-${taskId}`,
    started_at: "2026-07-18T08:00:00.000+08:00",
    last_seen_at: lastSeenAt,
    last_response_at: overrides.responseAt === undefined ? lastSeenAt : overrides.responseAt,
    request_count: 3,
    pending_request_only: overrides.pending ?? false,
    match_strategy_version: 6,
    ...(overrides.target === undefined ? {} : { target: overrides.target }),
    boundary_fingerprints: {
      ...entry.evidence.boundaryWithoutUser,
      ...(overrides.instructions === undefined ? {} : { instructions: overrides.instructions }),
      first_user: "sha-first-user",
    },
    fingerprints: { input: "sha-input" },
    last_user_messages: [PRIVATE_USER_TEXT],
    created_at: "2026-07-18T08:00:00.000+08:00",
    updated_at: lastSeenAt,
  };
}

/** The history file a binding list reads: tasks, the records that date them, and the links. */
function seedHistory(
  logRoot: string,
  rows: readonly {
    readonly task: ReturnType<typeof taskRow>;
    readonly linkKey?: string;
    readonly recordTarget?: string;
    /** Skip the finished record: a pending-only task has no completed request to date it. */
    readonly withoutRecord?: boolean | undefined;
  }[],
): void {
  const repository = new TrafficRepository(logRoot);
  try {
    for (const [index, row] of rows.entries()) {
      repository.upsertTask(row.task);
      if (row.linkKey !== undefined) {
        repository.upsertContextLink(row.linkKey, row.task.id);
      }
      if (row.withoutRecord === true) {
        continue;
      }
      repository.upsertRecord({
        id: `record-${index}`,
        task_id: row.task.id,
        sequence: index + 1,
        event: "request_finished",
        timestamp: "2026-07-18T09:30:00.000+08:00",
        method: "POST",
        path: "/v1/responses",
        endpoint: "/v1/responses",
        status: 200,
        ...(row.recordTarget === undefined ? {} : { target_url: row.recordTarget }),
        request_body: { text: PRIVATE_BODY_TEXT },
        response_body: { id: `resp-${index}`, output_text: "answer" },
      });
    }
  } finally {
    repository.close();
  }
}

/** A node's sample as the caller stamped it, so freshness is proved without a fake clock. */
function stampSample(
  balancer: LoadBalancer,
  targetId: string,
  sample: {
    readonly sampleSequence: number;
    readonly sampledAt: number;
    readonly running: number | undefined;
    readonly waiting: number | undefined;
    readonly kvUsage: number | undefined;
    readonly awake?: boolean | undefined;
  },
): void {
  balancer.setSample(targetId, {
    sampleSequence: sample.sampleSequence,
    sampledAt: sample.sampledAt,
    source: "vllm",
    running: sample.running,
    waiting: sample.waiting,
    kvUsage: sample.kvUsage,
    ...(sample.awake === undefined ? {} : { awake: sample.awake }),
  });
}

/** A field the serializer would otherwise never see: the service inventing a key. */
function smuggle<T>(value: T, key: string, payload: unknown): T {
  return { ...value, [key]: payload };
}

describe("GET /api/load-balancer/tasks", () => {
  it("LB-T01 answers a binding with its address, its node and a high-confidence history", async () => {
    const engine = await startEngine(VLLM_EXPOSITION);
    const logRoot = await newLogRoot();

    // The affinity clock is separate from the wall clock so the two bindings land in
    // different milliseconds, which is what makes the page order observable.
    let bindingClock = 1_000;
    const balancer = new LoadBalancer("pair-a", { now: () => bindingClock });
    const configured = pair(
      "pair-a",
      [
        target("target-a", `http://127.0.0.1:${engine.port}`, { target_api_key: SECRET_API_KEY }),
        target("target-b", "http://127.0.0.1:1"),
      ],
      [group("lb-live", ["target-a", "target-b"])],
    );
    balancer.reconfigure(configured);
    const monitor = new LoadMonitor(balancer);
    await monitor.sampleNow();

    const first = bind(balancer, "lb-live", "alpha", "target-a");
    bindingClock += 1_000;
    const second = bind(balancer, "lb-live", "beta", "target-b");
    const firstEntry = entryOf(balancer, "lb-live", first.id);
    seedHistory(logRoot, [
      {
        task: taskRow("task-alpha", firstEntry, { target: `http://127.0.0.1:${engine.port}` }),
        linkKey: firstEntry.exactKeys[0] ?? "",
        recordTarget: `http://127.0.0.1:${engine.port}`,
      },
    ]);

    const server = adminServer(source([configured], balancer, monitor, { logRoot }));
    const result = await readTasks(server, DEFAULT_QUERY);
    expect(result.statusCode).toBe(200);
    expect(Object.keys(result.body)).toEqual([...TOP_LEVEL_KEYS]);

    expect(result.body.pairId).toBe("pair-a");
    expect(result.body.groupId).toBe("lb-live");
    expect(result.body.targetFilter).toBeNull();
    expect(result.body.totalBindings).toBe(2);
    expect(result.body.limit).toBe(50);
    expect(result.body.offset).toBe(0);
    expect(result.body.hasMore).toBe(false);
    expect(result.body.nextOffset).toBe(0);
    // The address a row carries is only valid inside this runtime: none of it survives a restart.
    expect(result.body.runtimeEpoch).toBe(balancer.runtimeEpoch);
    expect(result.body.groupRevision).toBe(balancer.groupRevision("lb-live"));
    expect(result.body.migration).toBe("unavailable");

    expect(result.body.nodes.map((node) => node.targetId)).toEqual(["target-a", "target-b"]);
    const sampled = result.body.nodes[0];
    expect(sampled?.bindings).toBe(1);
    expect(sampled?.canonicalKey).toContain("127.0.0.1");
    expect(sampled?.metrics).toMatchObject({
      completeness: "complete",
      freshness: "fresh",
      kvUsage: 0.35,
      running: 3,
      sampleSequence: 1,
      waiting: 2,
    });
    const unmeasured = result.body.nodes[1];
    expect(unmeasured?.metrics.freshness).toBe("never_sampled");
    expect(unmeasured?.metrics.completeness).toBe("no_load_numbers");
    expect(unmeasured?.metrics.sampleSequence).toBeNull();
    expect(unmeasured?.metrics.usableForLoadJudgement).toBe(false);

    // Newest activity first, so a page is reproducible from one poll to the next.
    expect(result.body.items.map((item) => item.bindingId)).toEqual([second.id, first.id]);
    const linked = result.body.items[1];
    expect(linked?.targetId).toBe("target-a");
    expect(linked?.incarnation).toBe(first.incarnation);
    expect(linked?.routingRevision).toBe(0);
    expect(linked?.endpointKind).toBe("responses");
    expect(linked?.endpoint).toBe("/v1/responses");
    expect(linked?.model).toBe("Qwen3.8-Flash-Next");
    expect(linked?.inFlight).toBe(0);
    expect(linked?.activity).toBe("unknown");
    expect(linked?.context.source).toBe("none");
    expect(linked?.movable).toEqual({ ok: false, reasons: ["migration_unavailable"] });
    expect(linked?.associations.confidence).toBe("high");
    expect(linked?.associations.ambiguous).toBe(false);
    expect(linked?.associations.taskIds).toEqual(["task-alpha"]);
    expect(linked?.associations.reasons).toContain("exact_key_links");
    expect(linked?.associations.tasks[0]).toMatchObject({
      taskId: "task-alpha",
      level: "high",
      exactKeyMatches: 1,
      pendingRequestOnly: false,
      historyTargetNode: "same",
    });
    expect(linked?.associations.coverage).toMatchObject({
      state: "available",
      exactKeysRequested: firstEntry.exactKeys.length,
      exactKeysOmitted: 0,
      historyTruncated: false,
      failure: null,
    });

    // The other binding sits on a node with no log root at all. That is reported as a state,
    // not as an empty history someone could mistake for "nothing ever ran here".
    const unlogged = result.body.items[0];
    expect(unlogged?.associations.confidence).toBe("none");
    expect(unlogged?.associations.taskIds).toEqual([]);
    expect(unlogged?.associations.coverage.state).toBe("no_log_configured");
    expect(unlogged?.associations.reasons).toContain("no_log_configured");
  });

  it("LB-T02 names a missing pair and a missing group as two different 404s", async () => {
    const balancer = new LoadBalancer("pair-a");
    const configured = pair(
      "pair-a",
      [target("target-a", "http://127.0.0.1:1")],
      [group("lb-live", ["target-a"])],
    );
    balancer.reconfigure(configured);
    const server = adminServer(source([configured], balancer, undefined));

    const missingPair = await server.inject({
      method: "GET",
      url: "/api/load-balancer/tasks?pairId=pair-z&groupId=lb-live",
    });
    expect(missingPair.statusCode).toBe(404);
    expect(missingPair.json()).toEqual({
      error: { code: "pair_not_found", message: "Proxy pair not found." },
    });

    const missingGroup = await server.inject({
      method: "GET",
      url: "/api/load-balancer/tasks?pairId=pair-a&groupId=lb-ghost",
    });
    expect(missingGroup.statusCode).toBe(404);
    expect(missingGroup.json()).toEqual({
      error: { code: "group_not_found", message: "Load balancer group not found." },
    });
  });

  it("LB-T03 refuses every malformed query with the validation code the route carries", async () => {
    const balancer = new LoadBalancer("pair-a");
    const configured = pair(
      "pair-a",
      [target("target-a", "http://127.0.0.1:1")],
      [group("lb-live", ["target-a"])],
    );
    balancer.reconfigure(configured);
    const server = adminServer(source([configured], balancer, undefined));

    const rejected: readonly { readonly query: string; readonly why: string }[] = [
      { query: "", why: "no pair and no group" },
      { query: "?pairId=pair-a", why: "no group id" },
      { query: "?groupId=lb-live", why: "no pair id" },
      { query: "?pairId=&groupId=lb-live", why: "an empty pair id" },
      { query: "?pairId=pair-a&groupId=lb-live&limit=0", why: "a page below one row" },
      { query: "?pairId=pair-a&groupId=lb-live&limit=201", why: "a page above the cap" },
      { query: "?pairId=pair-a&groupId=lb-live&limit=1.5", why: "a fractional page" },
      { query: "?pairId=pair-a&groupId=lb-live&offset=-1", why: "a negative offset" },
      { query: "?pairId=pair-a&groupId=lb-live&extra=1", why: "a key the schema does not declare" },
      { query: "?pairId=pair-a&groupId=lb-live&targetId=", why: "an empty node filter" },
    ];

    const drift: string[] = [];
    for (const { query, why } of rejected) {
      const response = await server.inject({
        method: "GET",
        url: `/api/load-balancer/tasks${query}`,
      });
      const code = response.json<{ error?: { code?: string } }>().error?.code;
      if (response.statusCode !== 400 || code !== "FST_ERR_VALIDATION") {
        drift.push(`${why}: ${String(response.statusCode)} ${String(code)}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it("LB-T04 a pair that never started answers a legal empty page, not an error", async () => {
    const configured = pair(
      "pair-a",
      [target("target-a", "http://127.0.0.1:1")],
      [group("lb-live", ["target-a"])],
    );
    const server = adminServer(source([configured], undefined, undefined, { running: false }));

    const result = await readTasks(server, DEFAULT_QUERY);
    expect(result.statusCode).toBe(200);
    expect(result.body.runtimeEpoch).toBeNull();
    expect(result.body.groupRevision).toBeNull();
    expect(result.body.items).toEqual([]);
    expect(result.body.totalBindings).toBe(0);
    expect(result.body.migration).toBe("unavailable");

    // The node is still reported, as the configuration says it is, with an engine that was
    // never sampled rather than one that looks idle.
    expect(result.body.nodes.map((node) => node.targetId)).toEqual(["target-a"]);
    const node = result.body.nodes[0];
    expect(node?.enabled).toBe(true);
    expect(node?.inRotation).toBe(true);
    expect(node?.bindings).toBe(0);
    expect(node?.inFlight).toBe(0);
    expect(node?.canonicalKey).toBe("http://127.0.0.1:1");
    expect(node?.metrics.freshness).toBe("never_sampled");
    expect(node?.metrics.usableForLoadJudgement).toBe(false);
  });

  it("LB-T05 the three activity states, and a move that cannot be performed yet", async () => {
    const balancer = new LoadBalancer("pair-a");
    const configured = pair(
      "pair-a",
      [target("target-a", "http://127.0.0.1:1")],
      [group("lb-live", ["target-a"])],
    );
    balancer.reconfigure(configured);
    const groupShape = group("lb-live", ["target-a"]);

    // A binding the table knows and the request path has never seen.
    const untouched = bind(balancer, "lb-live", "never-routed", "target-a");
    // A binding whose response finished.
    const finished = balancer.plan({ group: groupShape, identity: identity("finished") });
    expect(finished?.decision.targetId).toBe("target-a");
    finished?.release();
    // A binding still carrying a reservation.
    const running = balancer.plan({ group: groupShape, identity: identity("running") });
    expect(running?.decision.targetId).toBe("target-a");
    expect(running?.binding).not.toBe(finished?.binding);

    const server = adminServer(source([configured], balancer, undefined));
    const result = await readTasks(server, DEFAULT_QUERY);
    expect(result.statusCode).toBe(200);
    const byId = new Map(result.body.items.map((item) => [item.bindingId, item]));

    const never = byId.get(untouched.id);
    expect(never?.activity).toBe("unknown");
    expect(never?.inFlight).toBe(0);
    expect(never?.lastRequestStartedAt).toBeNull();
    expect(never?.lastResponseEndedAt).toBeNull();
    expect(never?.requestCount).toBeGreaterThan(0);

    const done = byId.get(finished?.binding.id ?? -1);
    expect(done?.activity).toBe("idle");
    expect(done?.inFlight).toBe(0);
    expect(done?.lastRequestStartedAt).toBeTypeOf("number");
    expect(done?.lastResponseEndedAt).toBeTypeOf("number");
    expect(done?.recentRequestStarts).toHaveLength(1);

    const inFlightRow = byId.get(running?.binding.id ?? -1);
    expect(inFlightRow?.activity).toBe("in_flight");
    expect(inFlightRow?.inFlight).toBe(1);
    expect(inFlightRow?.movable).toEqual({
      ok: false,
      reasons: ["migration_unavailable", "in_flight"],
    });

    running?.release();
    expect(balancer.inFlight("target-a")).toBe(0);
  });

  it("LB-T06 reports an engine answer as the engine answered it", async () => {
    const kvEngine = await startEngine(KV_ONLY_EXPOSITION);
    const balancer = new LoadBalancer("pair-a");
    const configured = pair(
      "pair-a",
      [
        target("target-kv", `http://127.0.0.1:${kvEngine.port}`),
        target("target-half", "http://127.0.0.1:2"),
        target("target-stale", "http://127.0.0.1:3"),
        target("target-asleep", "http://127.0.0.1:4"),
        target("target-none", "http://127.0.0.1:5"),
      ],
      [
        group("lb-live", [
          "target-kv",
          "target-half",
          "target-stale",
          "target-asleep",
          "target-none",
        ]),
      ],
    );
    balancer.reconfigure(configured);
    const monitor = new LoadMonitor(balancer);
    await monitor.sampleNow();

    const now = Date.now();
    // One load number answered and the other skipped: the sample is current, and still only a
    // lower bound on what the engine is doing.
    stampSample(balancer, "target-half", {
      sampleSequence: 4,
      sampledAt: now,
      running: undefined,
      waiting: 5,
      kvUsage: undefined,
    });
    stampSample(balancer, "target-stale", {
      sampleSequence: 7,
      sampledAt: now - 60_000,
      running: 1,
      waiting: 1,
      kvUsage: undefined,
    });
    stampSample(balancer, "target-asleep", {
      sampleSequence: 9,
      sampledAt: now,
      running: 0,
      waiting: 0,
      kvUsage: 0.2,
      awake: false,
    });

    const server = adminServer(source([configured], balancer, monitor));
    const result = await readTasks(server, DEFAULT_QUERY);
    expect(result.statusCode).toBe(200);
    const byTarget = new Map(result.body.nodes.map((node) => [node.targetId, node]));

    // A half answer stays half: the number the engine skipped stays null, and the sum the
    // selector ranks on is the answered part alone.
    const half = byTarget.get("target-half");
    expect(half?.metrics).toMatchObject({
      awake: null,
      completeness: "partial",
      freshness: "fresh",
      kvUsage: null,
      running: null,
      sampleSequence: 4,
      source: "vllm",
      usableForLoadJudgement: false,
      waiting: 5,
    });
    expect(result.payload).toContain('"running":null');

    // Only the KV share answered: that is no load number at all, not an idle node.
    const kv = byTarget.get("target-kv");
    expect(kv?.metrics).toMatchObject({
      awake: null,
      completeness: "no_load_numbers",
      freshness: "fresh",
      kvUsage: 0.5,
      running: null,
      sampleSequence: 1,
      source: "vllm",
      usableForLoadJudgement: false,
      waiting: null,
    });

    const stale = byTarget.get("target-stale");
    expect(stale?.metrics.freshness).toBe("stale");
    expect(stale?.metrics.completeness).toBe("complete");
    expect(stale?.metrics.sampleSequence).toBe(7);
    expect(stale?.metrics.usableForLoadJudgement).toBe(false);

    // An engine that said it sleeps is not evidence whatever its numbers say.
    const asleep = byTarget.get("target-asleep");
    expect(asleep?.metrics.awake).toBe(false);
    expect(asleep?.metrics.freshness).toBe("fresh");
    expect(asleep?.metrics.usableForLoadJudgement).toBe(false);

    const none = byTarget.get("target-none");
    expect(none?.metrics.freshness).toBe("never_sampled");
    expect(none?.metrics.completeness).toBe("no_load_numbers");
    expect(none?.metrics.sampledAt).toBeNull();
  });

  it("LB-T07 a history read that failed is reported as a failure, not as no history", async () => {
    const logRoot = await newLogRoot();
    // A database that really is there, so the reader gets past the "does it exist" gate and
    // fails where an operator would expect it to fail.
    const seed = new TrafficRepository(logRoot);
    seed.upsertTask(plainTask("task-seed"));
    seed.close();

    const balancer = new LoadBalancer("pair-a");
    const configured = pair(
      "pair-a",
      [target("target-a", "http://127.0.0.1:1")],
      [group("lb-live", ["target-a"])],
    );
    balancer.reconfigure(configured);
    bind(balancer, "lb-live", "gamma", "target-a");

    const failing = new BindingHistoryService({
      openRepository: () => {
        throw Object.assign(new Error("unable to open database file"), {
          code: "SQLITE_CANTOPEN",
        });
      },
    });
    const server = adminServer(
      source([configured], balancer, undefined, { logRoot, history: failing }),
    );
    const result = await readTasks(server, DEFAULT_QUERY);

    expect(result.statusCode).toBe(200);
    const associations = result.body.items[0]?.associations;
    expect(associations?.confidence).toBe("none");
    expect(associations?.coverage.state).toBe("failed");
    expect(associations?.coverage.failure).toMatchObject({
      code: "SQLITE_CANTOPEN",
      errorName: "Error",
      phase: "open",
    });
    expect(associations?.coverage.historyRowsRead).toBe(0);
    expect(associations?.reasons).toContain("history_query_failed");
    // What a successful read would have listed as missing links is not invented from a failed one.
    expect(associations?.reasons).not.toContain("key_without_link");
    expect(associations?.taskIds).toEqual([]);
  });

  it("LB-T08 a missing traffic database is named, and reading it creates nothing", async () => {
    const logRoot = await newLogRoot();
    const balancer = new LoadBalancer("pair-a");
    const configured = pair(
      "pair-a",
      [target("target-a", "http://127.0.0.1:1")],
      [group("lb-live", ["target-a"])],
    );
    balancer.reconfigure(configured);
    bind(balancer, "lb-live", "delta", "target-a");

    const server = adminServer(source([configured], balancer, undefined, { logRoot }));
    const result = await readTasks(server, DEFAULT_QUERY);
    expect(result.statusCode).toBe(200);
    const associations = result.body.items[0]?.associations;
    expect(associations?.coverage.state).toBe("no_traffic_database");
    expect(associations?.coverage.failure).toBeNull();
    expect(associations?.confidence).toBe("none");
    expect(associations?.reasons).toContain("no_traffic_database");

    // The whole point of a read service: it looks at a log root, it never builds one.
    expect(existsSync(path.join(logRoot, "traffic.db"))).toBe(false);
    expect(existsSync(path.join(logRoot, "traffic.db-wal"))).toBe(false);
  });

  it("LB-T09 the caps a query respects are visible in the answer, not hidden in it", async () => {
    const logRoot = await newLogRoot();
    const balancer = new LoadBalancer("pair-a");
    const configured = pair(
      "pair-a",
      [target("target-a", "http://127.0.0.1:1")],
      [group("lb-live", ["target-a"])],
    );
    balancer.reconfigure(configured);
    const binding = bind(balancer, "lb-live", "epsilon", "target-a");
    const entry = entryOf(balancer, "lb-live", binding.id);
    expect(entry.exactKeys.length).toBeGreaterThan(1);

    // Three tasks whose static boundary agrees with this binding's, no exact link at all.
    seedHistory(logRoot, [
      { task: taskRow("task-e1", entry, { lastSeenAt: "2026-07-18T09:00:00.000+08:00" }) },
      { task: taskRow("task-e2", entry, { lastSeenAt: "2026-07-18T10:00:00.000+08:00" }) },
      { task: taskRow("task-e3", entry, { lastSeenAt: "2026-07-18T11:00:00.000+08:00" }) },
    ]);

    const capped = new BindingHistoryService({
      limits: { candidateScanRows: 2, maxExactKeys: 1, maxReturnedTasks: 1 },
    });
    const server = adminServer(
      source([configured], balancer, undefined, { logRoot, history: capped }),
    );
    const result = await readTasks(server, DEFAULT_QUERY);
    expect(result.statusCode).toBe(200);
    const associations = result.body.items[0]?.associations;
    expect(associations?.confidence).toBe("candidate");
    expect(associations?.ambiguous).toBe(true);
    // One key examined, the rest reported as left out rather than silently skipped.
    expect(associations?.coverage.exactKeysRequested).toBe(entry.exactKeys.length);
    expect(associations?.coverage.exactKeysExamined).toBe(1);
    expect(associations?.coverage.exactKeysOmitted).toBe(entry.exactKeys.length - 1);
    expect(associations?.coverage.candidateScanLimit).toBe(2);
    expect(associations?.coverage.candidateRowsRead).toBe(2);
    expect(associations?.coverage.returnedTaskLimit).toBe(1);
    expect(associations?.tasks).toHaveLength(1);
    expect(associations?.coverage.historyTruncated).toBe(true);
    expect(associations?.reasons).toEqual(
      expect.arrayContaining([
        "key_limit_exceeded",
        "boundary_candidates",
        "candidate_scan_truncated",
        "task_list_truncated",
      ]),
    );
    // A candidate is never one task, so nothing collapses into a representative.
    expect(associations?.tasks[0]?.level).toBe("candidate");
    expect(associations?.tasks[0]?.exactKeyMatches).toBe(0);
    expect(associations?.tasks[0]?.taskId).toBe("task-e3");
  });

  it("LB-T10 pages the list and narrows it to one node", async () => {
    const balancer = new LoadBalancer("pair-a");
    const configured = pair(
      "pair-a",
      [target("target-a", "http://127.0.0.1:1"), target("target-b", "http://127.0.0.1:2")],
      [group("lb-live", ["target-a", "target-b"])],
    );
    balancer.reconfigure(configured);
    bind(balancer, "lb-live", "one", "target-a");
    bind(balancer, "lb-live", "two", "target-a");
    bind(balancer, "lb-live", "three", "target-b");

    const server = adminServer(source([configured], balancer, undefined));

    const firstPage = await readTasks(server, `${DEFAULT_QUERY}&limit=2`);
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.body.totalBindings).toBe(3);
    expect(firstPage.body.limit).toBe(2);
    expect(firstPage.body.items).toHaveLength(2);
    expect(firstPage.body.hasMore).toBe(true);
    expect(firstPage.body.nextOffset).toBe(2);
    expect(firstPage.body.nodes.map((node) => node.bindings)).toEqual([2, 1]);

    const secondPage = await readTasks(server, `${DEFAULT_QUERY}&limit=2&offset=2`);
    expect(secondPage.body.items).toHaveLength(1);
    expect(secondPage.body.offset).toBe(2);
    expect(secondPage.body.hasMore).toBe(false);
    expect(secondPage.body.nextOffset).toBe(2);

    const pastTheEnd = await readTasks(server, `${DEFAULT_QUERY}&offset=9`);
    expect(pastTheEnd.statusCode).toBe(200);
    expect(pastTheEnd.body.items).toEqual([]);
    expect(pastTheEnd.body.hasMore).toBe(false);

    const filtered = await readTasks(server, `${DEFAULT_QUERY}&targetId=target-b`);
    expect(filtered.body.targetFilter).toBe("target-b");
    expect(filtered.body.totalBindings).toBe(1);
    expect(filtered.body.items.map((item) => item.targetId)).toEqual(["target-b"]);
  });

  it("LB-T11 reading the list touches no binding, no engine and leaks nothing", async () => {
    const engine = await startEngine(VLLM_EXPOSITION);
    const logRoot = await newLogRoot();

    const balancer = new LoadBalancer("pair-a");
    const configured = pair(
      "pair-a",
      [
        target("target-a", `http://127.0.0.1:${engine.port}`, {
          target_api_key: SECRET_API_KEY,
        }),
      ],
      [group("lb-live", ["target-a"])],
    );
    balancer.reconfigure(configured);
    const monitor = new LoadMonitor(balancer);
    await monitor.sampleNow();
    const beforeHits = engine.hits();

    const reservation = balancer.plan({
      group: group("lb-live", ["target-a"]),
      identity: identity("leak-check"),
    });
    const table = balancer.tableFor("lb-live");
    if (table === undefined) {
      throw new Error("An enabled group must have an affinity table.");
    }
    const entry = entryOf(balancer, "lb-live", reservation?.binding.id ?? -1);
    seedHistory(logRoot, [
      {
        task: taskRow("task-history", entry, { target: `http://127.0.0.1:${engine.port}` }),
        linkKey: entry.exactKeys[0] ?? "",
      },
    ]);

    const before = table.bindingEntries();
    const server = adminServer(source([configured], balancer, monitor, { logRoot }));
    const result = await readTasks(server, DEFAULT_QUERY);
    const after = table.bindingEntries();

    expect(result.statusCode).toBe(200);
    expect(result.body.items[0]?.associations.confidence).toBe("high");
    // The list is a read: the same copies come back, so no TTL was refreshed, no counter was
    // bumped, no target moved and nothing was evicted.
    expect(after).toStrictEqual(before);
    expect(balancer.tableFor("lb-live")?.size).toBe(before.length);
    // The engine was asked by the sampler, never by the list.
    expect(engine.hits()).toBe(beforeHits);

    // Nothing that identifies a conversation, a body or a credential reaches the wire.
    const payload = result.payload;
    for (const key of entry.exactKeys) {
      expect(payload).not.toContain(key);
    }
    for (const hash of Object.values(entry.evidence.boundaryWithoutUser)) {
      expect(payload).not.toContain(hash);
    }
    for (const hash of entry.evidence.userHashes) {
      expect(payload).not.toContain(hash);
    }
    expect(payload).not.toContain(SECRET_API_KEY);
    expect(payload).not.toContain(PRIVATE_USER_TEXT);
    expect(payload).not.toContain(PRIVATE_BODY_TEXT);
    expect(payload).not.toContain("leak-check");
    expect(payload).not.toContain("pc-leak-check");

    reservation?.release();
  });

  it("LB-T12 the closed response schema drops a field the service invented", async () => {
    const balancer = new LoadBalancer("pair-a");
    const configured = pair(
      "pair-a",
      [target("target-a", "http://127.0.0.1:1")],
      [group("lb-live", ["target-a"])],
    );
    balancer.reconfigure(configured);
    bind(balancer, "lb-live", "zeta", "target-a");
    const real = createLoadBalancerAdminService(source([configured], balancer, undefined));

    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      loadBalancerService: {
        getStatus: () => real.getStatus(),
        getBindings: (query) => {
          const answer = real.getBindings(query);
          if ("error" in answer) {
            return answer;
          }
          return {
            response: smuggle<LoadBalancerBindingListResponse>(
              answer.response,
              "smuggled_field",
              "gone",
            ),
          };
        },
        // [TRI-08] The migration methods are part of the service the route table answers from,
        // so this stub delegates to the real one: the smuggled field is the only difference.
        moveBinding: (query) => real.moveBinding(query),
        cancelMoveBinding: (operationId) => real.cancelMoveBinding(operationId),
      },
    });
    servers.push(server);

    const response = await server.inject({
      method: "GET",
      url: `/api/load-balancer/tasks${DEFAULT_QUERY}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.payload).not.toContain("smuggled_field");
    expect(Object.keys(response.json())).toEqual([...TOP_LEVEL_KEYS]);
  });

  it("LB-T13 one binding the history links to several tasks is one row with its whole scope", async () => {
    const logRoot = await newLogRoot();
    const balancer = new LoadBalancer("pair-a");
    const configured = pair(
      "pair-a",
      [target("target-a", "http://127.0.0.1:1")],
      [group("lb-live", ["target-a"])],
    );
    balancer.reconfigure(configured);

    // A reservation gives this binding a request start, which is what the log-coverage question
    // is asked against. It is released before the read, so the row is idle and movable.
    const reservation = balancer.plan({
      group: group("lb-live", ["target-a"]),
      identity: identity("shared"),
    });
    expect(reservation?.decision.targetId).toBe("target-a");
    reservation?.release();
    const entry = entryOf(balancer, "lb-live", reservation?.binding.id ?? -1);
    expect(entry.exactKeys).toHaveLength(3);

    // Three tasks, each named by a different exact key of this one binding: one finished on this
    // node, one whose only evidence is still a pending row, and one whose stored boundary no
    // longer matches what this binding recorded.
    seedHistory(logRoot, [
      {
        task: taskRow("task-finished", entry, {
          target: "http://127.0.0.1:1",
          lastSeenAt: "2026-07-18T09:00:00.000+08:00",
        }),
        linkKey: entry.exactKeys[0] ?? "",
      },
      {
        task: taskRow("task-pending", entry, {
          lastSeenAt: "2026-07-18T10:00:00.000+08:00",
          pending: true,
          responseAt: null,
        }),
        linkKey: entry.exactKeys[1] ?? "",
        withoutRecord: true,
      },
      {
        task: taskRow("task-drifted", entry, {
          target: "http://127.0.0.1:9/",
          lastSeenAt: "2026-07-18T11:00:00.000+08:00",
          instructions: "sha-instructions-this-binding-never-recorded",
        }),
        linkKey: entry.exactKeys[2] ?? "",
      },
    ]);

    const server = adminServer(source([configured], balancer, undefined, { logRoot }));
    const result = await readTasks(server, DEFAULT_QUERY);
    expect(result.statusCode).toBe(200);
    // Several tasks behind one binding is still one row and one move entry: never one row per
    // task, and never a representative task picked out of them.
    expect(result.body.totalBindings).toBe(1);
    expect(result.body.items).toHaveLength(1);
    const row = result.body.items[0];
    expect(row?.activity).toBe("idle");
    expect(row?.movable).toEqual({ ok: false, reasons: ["migration_unavailable"] });

    const associations = row?.associations;
    expect(associations?.confidence).toBe("high");
    // Several tasks is not one task, so the scope has to be shown whole.
    expect(associations?.ambiguous).toBe(true);
    expect(associations?.taskIds).toEqual(["task-pending", "task-finished", "task-drifted"]);
    expect(associations?.tasks.map((task) => task.level)).toEqual(["high", "high", "candidate"]);
    expect(associations?.tasks.map((task) => task.exactKeyMatches)).toEqual([1, 1, 1]);
    // Where the task last went, against the node this binding sits on now: the same node, no
    // stored address at all, and a different engine.
    expect(associations?.tasks.map((task) => task.historyTargetNode)).toEqual([
      "unknown",
      "same",
      "different",
    ]);

    // A pending row stays a pending row: it carries no response time and says so.
    const pending = associations?.tasks.find((task) => task.taskId === "task-pending");
    expect(pending?.pendingRequestOnly).toBe(true);
    expect(pending?.lastResponseAt).toBeNull();
    // A link whose stored boundary drifted is degraded to a candidate, not kept as high.
    const drifted = associations?.tasks.find((task) => task.taskId === "task-drifted");
    expect(drifted?.level).toBe("candidate");

    expect(associations?.reasons).toEqual(
      expect.arrayContaining([
        "exact_key_links",
        "several_linked_tasks",
        "link_boundary_mismatch",
        "log_write_may_be_pending",
      ]),
    );

    const coverage = associations?.coverage;
    expect(coverage?.state).toBe("available");
    expect(coverage?.failure).toBeNull();
    expect(coverage?.exactKeysRequested).toBe(3);
    expect(coverage?.exactKeysExamined).toBe(3);
    expect(coverage?.exactKeysOmitted).toBe(0);
    expect(coverage?.exactKeysLinked).toBe(3);
    expect(coverage?.exactKeysWithoutLink).toBe(0);
    expect(coverage?.linkedTasksRead).toBe(3);
    expect(coverage?.historyTruncated).toBe(false);
    // The newest stored record is older than the request this binding started, so the log may
    // still be catching up. That is reported as a fact about the read, not by hiding the task.
    expect(coverage?.latestStoredRecordAt).toBe("2026-07-18T09:30:00.000+08:00");
    expect(coverage?.logWriteMayBePending).toBe(true);
  });

  it("LB-T14 a node outside the group and a group that is off answer a legal empty page", async () => {
    const balancer = new LoadBalancer("pair-a");
    const configured = pair(
      "pair-a",
      [target("target-a", "http://127.0.0.1:1"), target("target-b", "http://127.0.0.1:2")],
      [
        group("lb-live", ["target-a", "target-b"]),
        group("lb-off", ["target-a"], { enabled: false }),
      ],
    );
    balancer.reconfigure(configured);
    bind(balancer, "lb-live", "eta", "target-a");

    const server = adminServer(source([configured], balancer, undefined));

    // A filter that names a node this group does not have is neither of the two 404 causes: the
    // page is simply empty. The group's own node state is still reported, and it is not narrowed
    // to the filtered subset, so a client cannot read "no bindings here" as "this node is idle".
    const ghost = await readTasks(server, `${DEFAULT_QUERY}&targetId=target-ghost`);
    expect(ghost.statusCode).toBe(200);
    expect(ghost.body.targetFilter).toBe("target-ghost");
    expect(ghost.body.totalBindings).toBe(0);
    expect(ghost.body.items).toEqual([]);
    expect(ghost.body.hasMore).toBe(false);
    expect(ghost.body.nextOffset).toBe(0);
    expect(ghost.body.nodes.map((node) => node.targetId)).toEqual(["target-a", "target-b"]);
    expect(ghost.body.nodes.map((node) => node.bindings)).toEqual([1, 0]);

    // A group the configuration switched off has no bindings to list, yet the read still answers
    // the versions it holds and the node its one member is.
    const off = await readTasks(server, "?pairId=pair-a&groupId=lb-off");
    expect(off.statusCode).toBe(200);
    expect(off.body.groupId).toBe("lb-off");
    expect(off.body.totalBindings).toBe(0);
    expect(off.body.items).toEqual([]);
    expect(off.body.runtimeEpoch).toBe(balancer.runtimeEpoch);
    expect(off.body.groupRevision).toBe(balancer.groupRevision("lb-off"));
    expect(off.body.nodes.map((node) => node.targetId)).toEqual(["target-a"]);
  });
});

/** The columns a seeded task needs when the case is about the reader, not the association. */
function plainTask(taskId: string) {
  return {
    id: taskId,
    kind: "responses",
    endpoint: "/v1/responses",
    model: "Qwen3.8-Flash-Next",
    anchor: `task-${taskId}`,
    started_at: "2026-07-18T08:00:00.000+08:00",
    last_seen_at: "2026-07-18T09:00:00.000+08:00",
    last_response_at: "2026-07-18T09:00:00.000+08:00",
    request_count: 1,
    pending_request_only: false,
    match_strategy_version: 6,
    boundary_fingerprints: { instructions: "sha-instructions", first_user: "sha-first-user" },
    fingerprints: { input: "sha-input" },
    last_user_messages: [PRIVATE_USER_TEXT],
    created_at: "2026-07-18T08:00:00.000+08:00",
    updated_at: "2026-07-18T09:00:00.000+08:00",
  };
}
