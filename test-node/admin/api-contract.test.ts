import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applicationHealth,
  createAdminServer,
  type AdminServerOptions,
  type PartialAdminServerOptions,
} from "../../src/admin/index.js";
import type { AdminLoadBalancerTasksResponse } from "../../src/admin/admin-schemas.js";
import { createNodeApplication, type NodeApplication } from "../../src/app/index.js";
import type { SummaryModelConfig } from "../../src/config/index.js";
import { UsageStatisticsService } from "../../src/maintenance/usage-statistics-service.js";
import {
  cleanupResult,
  emptyGroupPage,
  enabledPair,
  exportStream,
  modelPriceImportResult,
  recordBatch,
  taskBrief,
} from "./log-service-fixtures.js";
import { emptyBindingListResponse } from "./admin-service-fixtures.js";

// The full route table Fastify builds when every optional service is wired.
// Pinned so a renamed path, a dropped method, or a route that moves under a new
// condition fails here instead of answering 404 in front of the browser.
const ROUTE_TABLE = [
  "DELETE /api/load-balancer/task-moves/:operationId",
  "GET /",
  "GET /api/health",
  "GET /api/load-balancer/status",
  "GET /api/load-balancer/tasks",
  "GET /api/log-groups/:id/brief",
  "GET /api/log-groups/:id/logs",
  "GET /api/log-groups/:id/pricing",
  "GET /api/log-groups/:id/pricing/costs",
  "GET /api/log-groups/:id/pricing/output-tokens",
  "GET /api/log-groups/:id/pricing/tokens",
  "GET /api/logs",
  "GET /api/logs/:id",
  "GET /api/logs/:id/summary",
  "GET /api/logs/export",
  "GET /api/logs/records",
  "GET /api/pairs",
  "GET /api/settings/summary-model",
  "GET /api/usage-statistics/export",
  "GET /api/usage-statistics/options",
  "GET /api/usage-statistics/overview",
  "GET /api/usage-statistics/trend",
  "GET /static/app.css",
  "GET /static/app.js",
  "POST /api/load-balancer/task-moves",
  "POST /api/log-groups/:id/brief",
  "POST /api/logs/:id/summary",
  "POST /api/logs/cleanup",
  "POST /api/model-prices/import",
  "POST /api/pairs/:id/enabled",
  "POST /api/settings/summary-model/test",
  "POST /api/target-check",
  "POST /api/target-metrics",
  "POST /api/target-models",
  "PUT /api/pairs",
  "PUT /api/settings/summary-model",
] as const;

// A disabled pair with a target still carries a log root. AI-02 made the statistics service
// resolve its roots when a query runs, so these routes are registered whether or not a root
// exists; the empty-root case is pinned by the last describe block below.
const contractConfig = {
  pairs: [
    {
      id: "pair-1",
      name: "contract",
      enabled: false,
      listen_host: "127.0.0.1",
      listen_port: 0,
      upstream_url: "http://127.0.0.1:9/",
      model_mapping_mode: "disabled",
      default_model: "",
      default_upstream_model: "",
      preserve_route_model: false,
      allow_unnamed_model: false,
      unknown_model_policy: "reject",
      unknown_param_mode: "strip",
      unknown_param_paths: [],
      stream_keepalive_interval_seconds: 0,
      target_retry_limit: 0,
      target_retry_backoff_milliseconds: 0,
      failover_reuse_connection: false,
      target_connect_timeout_milliseconds: 0,
      target_first_byte_timeout_milliseconds: 0,
      target_idle_chunk_timeout_milliseconds: 0,
      target_headers: [],
      strip_request_fields: "",
      inject_request_fields: "",
      log_root: "logs",
      redact_logs: false,
      model_mappings: [],
      // A group the binding-list read can name while the pair stays stopped: the route must
      // then answer a legal empty page rather than an error.
      load_balancers: [
        {
          id: "lb-1",
          name: "contract-lb",
          enabled: true,
          model_pattern: "contract-model",
          members: [{ target_id: "target-1", model_id: "" }],
          strategy: "least_load",
          metrics_enabled: false,
          failover_enabled: true,
        },
      ],
    },
  ],
};

const windowStart = "2026-01-01T00:00:00.000Z";
const windowEnd = "2026-01-02T00:00:00.000Z";

/**
 * A complete move body for the pair this configuration holds. The pair is disabled, so the
 * runtime it would need does not exist: what this body proves is that the route reads every
 * field the closed schema declares and then names the cause it found.
 */
const contractMoveBody = {
  bindingId: 1,
  destinationTargetId: "target-1",
  expectedRoutingRevision: 0,
  expectedSourceTargetId: "target-1",
  groupId: "lb-1",
  groupRevision: 1,
  idempotencyKey: "contract-move-key",
  incarnation: 1,
  pairId: "pair-1",
  runtimeEpoch: "contract-epoch",
} as const;

// Kept at module scope because afterAll has to stop the same instance the probes
// ran against.
let runtimeRef: NodeApplication | undefined;

/**
 * Fastify prints the route tree with four columns per level and children extend
 * their parent's prefix. HEAD is added automatically for every GET, so it is
 * dropped to keep the table about what the code registers.
 */
function readRouteTable(dump: string): string[] {
  const routes: string[] = [];
  const stack: { depth: number; path: string }[] = [];
  for (const line of dump.split("\n")) {
    if (!line.includes("├") && !line.includes("└")) continue;
    const header = /^(\S+)\s+\(([^)]+)\)$/.exec(line.replace(/^[\s│├└─]+/, ""));
    const pathText = header?.[1];
    const methodList = header?.[2];
    if (pathText === undefined || methodList === undefined) continue;
    const depth = (/^[\s│]*/.exec(line)?.[0].length ?? 0) / 4;
    while (stack.length > 0 && (stack[stack.length - 1]?.depth ?? 0) >= depth) stack.pop();
    const parent = stack[stack.length - 1]?.path ?? "";
    const segment = pathText.startsWith("/") ? pathText : `/${pathText}`;
    const fullPath =
      parent === "" ? segment : parent.endsWith("/") ? parent + segment.slice(1) : parent + segment;
    for (const method of methodList
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "HEAD")) {
      routes.push(`${method} ${fullPath}`);
    }
    stack.push({ depth, path: fullPath });
  }
  return routes.sort();
}

interface ErrorEnvelope {
  error?: { code?: string };
}

function errorCodeIn(value: Record<string, unknown> | null): string | undefined {
  return (value as ErrorEnvelope | null)?.error?.code;
}

/** The routes that need a query string or a path parameter to be answered at all. */
function probeUrl(route: string): string {
  if (route.includes(":id")) {
    return route.replace(":id", "missing");
  }
  switch (route) {
    case "/api/logs":
      return "/api/logs?limit=5";
    case "/api/logs/records":
      return "/api/logs/records?ids=missing";
    case "/api/usage-statistics/export":
      return `/api/usage-statistics/export?from=${windowStart}&to=${windowEnd}`;
    case "/api/usage-statistics/overview":
      return `/api/usage-statistics/overview?from=${windowStart}&to=${windowEnd}`;
    case "/api/usage-statistics/trend":
      return `/api/usage-statistics/trend?from=${windowStart}&to=${windowEnd}&metric=token&granularity=day`;
    case "/api/usage-statistics/options":
      return `/api/usage-statistics/options?from=${windowStart}&to=${windowEnd}`;
    case "/api/load-balancer/tasks":
      // The route needs a pair and a group to be answered at all; this one names a pair the
      // configuration holds and a group it does not.
      return "/api/load-balancer/tasks?pairId=pair-1&groupId=missing";
    default:
      return route;
  }
}

/** `/api/logs/export` answers a zip archive, so a body is not always JSON. */
function parseBody(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

describe("admin route table", () => {
  it("registers every declared route when every service is wired", async () => {
    // The contract under test is reachability, so the stubs only have to answer often enough
    // for each route to be registered. They are written against the real contract types, so a
    // renamed or forgotten service field stops this file from compiling.
    const stubs: AdminServerOptions = {
      getHealth: () => applicationHealth("running"),
      logService: {
        listGroups: () => emptyGroupPage(),
        cleanupKeepLatest: () => cleanupResult(),
        cleanupOlderThan: () => cleanupResult(),
        cleanupSelectedGroups: () => cleanupResult(),
        exportLogs: () => exportStream(),
        getGroupLogs: () => undefined,
        listRecordsByIds: () => recordBatch(),
        getRecordDetail: () => undefined,
        summarizeRecord: () => Promise.resolve(undefined),
        getSummary: () => undefined,
        getGroupPricing: () => undefined,
        getGroupTokenSeries: () => undefined,
        getGroupCostSeries: () => undefined,
        getGroupOutputTokenSeries: () => undefined,
        getTaskBrief: () => undefined,
        generateTaskBrief: () => Promise.resolve(taskBrief()),
      },
      pairService: {
        listPairs: () => [],
        replacePairs: () => Promise.resolve([]),
        setPairEnabled: () => Promise.resolve(enabledPair()),
      },
      staticAssets: { appCss: "a", appJs: "j", indexHtml: "<html>" },
      targetCheckService: { checkTarget: () => Promise.resolve({ ok: true, durationMs: 1 }) },
      targetMetricsService: {
        fetchTargetMetrics: () => Promise.resolve({ ok: true, durationMs: 1 }),
      },
      targetModelsService: {
        fetchTargetModels: () => Promise.resolve({ ok: true, models: [], durationMs: 1 }),
      },
      loadBalancerService: {
        getStatus: () => ({ now: 0, pairs: [] }),
        getBindings: () => ({ response: emptyBindingListResponse() }),
        // [TRI-08] The two migration routes are registered because the assembly supplies their
        // methods, so the stub has to answer them too; an empty assembly names the causes.
        moveBinding: () => ({ rejection: { code: "pair_not_found", detail: undefined } }),
        cancelMoveBinding: () => ({
          rejection: { code: "operation_not_found", detail: undefined },
        }),
      },
      summaryModelService: {
        getConfig: () => undefined,
        setConfig: (config: SummaryModelConfig) => Promise.resolve(config),
        testConfig: () => Promise.resolve({ ok: true }),
      },
      modelCatalogService: {
        importModelPrices: () => Promise.resolve(modelPriceImportResult()),
      },
      usageStatisticsService: new UsageStatisticsService({
        usageStatisticsRows: () => [],
      }),
    };

    const server = createAdminServer(stubs);
    await server.ready();
    const table = readRouteTable(server.printRoutes({ commonPrefix: false }));
    await server.close();

    expect(table).toEqual([...ROUTE_TABLE]);
  });

  // [AI-09] A service the assembly leaves out takes its route with it, and the answer that
  // comes back is the not-found handler's own `{ code: "not_found", message: "Route not
  // found." }`. This is the shape the production assembly must never produce: its options
  // require every service listed here, so it cannot be given this value.
  it("[AI-09] registers only the routes whose services the assembly supplies", async () => {
    const partial: PartialAdminServerOptions = {
      getHealth: () => applicationHealth("running"),
      logService: { listGroups: () => emptyGroupPage() },
    };

    const server = createAdminServer(partial);
    await server.ready();
    const table = readRouteTable(server.printRoutes({ commonPrefix: false }));
    const missingRoute = await server.inject({
      method: "GET",
      url: "/api/logs/records?ids=missing",
    });
    await server.close();

    expect(table).toEqual(["GET /api/health", "GET /api/logs"]);
    expect(missingRoute.statusCode).toBe(404);
    expect(missingRoute.json()).toEqual({
      error: { code: "not_found", message: "Route not found." },
    });
  });
});

describe("assembled admin surface", () => {
  let root: string | undefined;
  let adminPort = 0;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "llm-proxy-contract-"));
    await writeFile(path.join(root, "proxies.json"), JSON.stringify(contractConfig));
    const runtime = createNodeApplication({
      applicationConfigFile: path.join(root, "llm-proxy.json"),
      configFile: path.join(root, "proxies.json"),
      logRoot: path.join(root, "logs"),
      host: "127.0.0.1",
      port: 0,
    });
    await runtime.application.start();
    const port = runtime.address()?.port;
    if (port === undefined) {
      await runtime.application.stop();
      throw new Error("the assembled application did not report an admin port");
    }
    adminPort = port;
    // Held open for the probes below; stopped in afterAll.
    runtimeRef = runtime;
  });

  afterAll(async () => {
    await runtimeRef?.application.stop();
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 });
    }
  });

  const get = async (route: string) => await fetch(`http://127.0.0.1:${adminPort}${route}`);

  it("answers every GET route from the wired application, not with an unregistered 404", async () => {
    const routes = ROUTE_TABLE.filter((entry) => entry.startsWith("GET"))
      .map((entry) => entry.slice(4))
      .filter((route) => route.startsWith("/api"))
      .map(probeUrl);

    const unwired: string[] = [];
    // An empty list would pass silently, so the count is pinned against the table.
    expect(routes).toHaveLength(20);
    for (const route of routes) {
      const response = await get(route);
      const text = await response.text();
      const parsed = parseBody(text);
      if (response.status === 404 && errorCodeIn(parsed) === "not_found") {
        unwired.push(route);
      }
    }
    // "not_found" is the shape Fastify's own handler produces; the log routes use
    // their own codes, so this distinguishes a missing route from a missing record.
    expect(unwired).toEqual([]);
  });

  it("keeps the top-level payload keys the browser reads", async () => {
    const expected = {
      "/api/health": ["applicationState", "status", "version"],
      "/api/logs?limit=5": ["groups", "total", "limit", "offset", "next_offset", "has_more"],
      "/api/logs/records?ids=missing": ["records"],
      "/api/pairs": ["pairs"],
      "/api/load-balancer/status": ["now", "pairs"],
      "/api/load-balancer/tasks?pairId=pair-1&groupId=lb-1": [
        "groupRevision",
        "groupId",
        "hasMore",
        "items",
        "limit",
        "migration",
        "migrationOperations",
        "nextOffset",
        "nodes",
        "now",
        "offset",
        "pairId",
        "runtimeEpoch",
        "targetFilter",
        "totalBindings",
      ],
      "/api/usage-statistics/overview": [
        "dataVersion",
        "totals",
        "byTarget",
        "byModel",
        "unpriced",
      ],
      "/api/usage-statistics/trend": ["dataVersion", "granularity", "points"],
      "/api/usage-statistics/options": ["targets", "models"],
    } as const;

    const drift: string[] = [];
    for (const [route, keys] of Object.entries(expected)) {
      const response = await get(probeUrl(route));
      const parsed = parseBody(await response.text());
      const answered = parsed === null ? [] : Object.keys(parsed);
      if (JSON.stringify(answered) !== JSON.stringify([...keys])) {
        drift.push(`${route}: ${answered.join(",")} instead of ${keys.join(",")}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it("keeps the answers that have no body of their own", async () => {
    for (const route of [
      "/api/settings/summary-model",
      "/api/logs/missing/summary",
      "/api/log-groups/missing/brief",
    ]) {
      const response = await get(route);
      expect(response.status).toBe(200);
      expect(JSON.parse(await response.text())).toBeNull();
    }
  });

  it("keeps the missing-record and missing-group codes distinct from a missing route", async () => {
    const cases = {
      "/api/logs/missing": "log_record_not_found",
      "/api/log-groups/missing/pricing": "log_group_not_found",
      "/api/log-groups/missing/logs": "log_group_not_found",
      // [TRI-05] The two causes a binding list can miss are named separately: a pair the
      // configuration does not hold, and a group that is not in the pair it does hold.
      "/api/load-balancer/tasks?pairId=missing&groupId=lb-1": "pair_not_found",
      "/api/load-balancer/tasks?pairId=pair-1&groupId=missing-group": "group_not_found",
    } as const;
    for (const [route, code] of Object.entries(cases)) {
      const response = await get(route);
      expect(response.status).toBe(404);
      const parsed = parseBody(await response.text());
      expect(errorCodeIn(parsed)).toBe(code);
    }
  });

  /**
   * [TRI-05] The binding list is a closed query: a missing pair or group id, a page size out
   * of range and a key the schema does not declare are all Fastify validation 400s. They carry
   * `FST_ERR_VALIDATION`, not the handler's `bad_request` fallback, because the error carries a
   * code. A pair that is configured but never started answers a legal empty page: the group
   * exists in the configuration, so there is nothing missing to report - only no runtime.
   */
  it("[TRI-05] rejects a bad binding-list query and answers a stopped pair", async () => {
    const rejectedRoutes = [
      "/api/load-balancer/tasks",
      "/api/load-balancer/tasks?pairId=pair-1",
      "/api/load-balancer/tasks?pairId=pair-1&groupId=lb-1&limit=0",
      "/api/load-balancer/tasks?pairId=pair-1&groupId=lb-1&limit=201",
      "/api/load-balancer/tasks?pairId=pair-1&groupId=lb-1&offset=-1",
      "/api/load-balancer/tasks?pairId=pair-1&groupId=lb-1&extra=1",
    ];
    for (const route of rejectedRoutes) {
      const response = await get(route);
      expect(response.status).toBe(400);
      expect(errorCodeIn(parseBody(await response.text()))).toBe("FST_ERR_VALIDATION");
    }

    const stopped = await get("/api/load-balancer/tasks?pairId=pair-1&groupId=lb-1");
    expect(stopped.status).toBe(200);
    const body = (await stopped.json()) as AdminLoadBalancerTasksResponse;
    expect(body.runtimeEpoch).toBeNull();
    expect(body.groupRevision).toBeNull();
    expect(body.items).toEqual([]);
    expect(body.totalBindings).toBe(0);
    expect(body.hasMore).toBe(false);
    expect(body.nextOffset).toBe(0);
    expect(body.targetFilter).toBeNull();
    expect(body.migration).toBe("unavailable");
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    expect(body.pairId).toBe("pair-1");
    expect(body.groupId).toBe("lb-1");

    // The node still shows what the configuration says about it, with an engine that was
    // never sampled rather than an idle one.
    expect(body.nodes).toHaveLength(1);
    const node = body.nodes[0];
    expect(node?.targetId).toBe("target-1");
    expect(node?.enabled).toBe(true);
    expect(node?.bindings).toBe(0);
    expect(node?.metrics).toMatchObject({
      awake: null,
      completeness: "no_load_numbers",
      freshness: "never_sampled",
      kvUsage: null,
      running: null,
      sampleSequence: null,
      sampledAt: null,
      usableForLoadJudgement: false,
      waiting: null,
    });
  });

  /**
   * [TRI-08] Both migration routes are registered on the assembled application, and each answers
   * with a code the route owns. A body the closed schema refuses carries Fastify's
   * `FST_ERR_VALIDATION`, not the handler's `bad_request` fallback; a pair that is configured but
   * never started names the cause the service found before it ever reached a balancer, which is
   * not the not-found handler's `not_found`; and a cancel that names an id no record carries is
   * named as its own 404. None of these can be produced by a route that was never wired.
   */
  it("[TRI-08] registers both migration routes and answers a pair that never started", async () => {
    const submitMove = async (body: unknown) =>
      await fetch(`http://127.0.0.1:${adminPort}/api/load-balancer/task-moves`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const rejectedBodies: readonly Record<string, unknown>[] = [
      {},
      { ...contractMoveBody, bindingId: -1 },
      { ...contractMoveBody, expectedRoutingRevision: 1.5 },
      { ...contractMoveBody, runtimeEpoch: "" },
      { ...contractMoveBody, idempotencyKey: "" },
      { ...contractMoveBody, surprise: "not declared" },
      { ...contractMoveBody, reason: "x".repeat(201) },
    ];
    for (const body of rejectedBodies) {
      const response = await submitMove(body);
      expect(response.status).toBe(400);
      expect(errorCodeIn(parseBody(await response.text()))).toBe("FST_ERR_VALIDATION");
    }

    const stopped = await submitMove(contractMoveBody);
    expect(stopped.status).toBe(404);
    expect(parseBody(await stopped.text())).toEqual({
      error: {
        code: "binding_not_found",
        message: "This pair is not running, so no runtime holds a binding to move.",
      },
    });

    // A cancel that names an id the store has never issued is refused by name, and the answer is
    // the same two-key body every other error on this surface uses - not a body of the move's own.
    const cancelled = await fetch(
      `http://127.0.0.1:${adminPort}/api/load-balancer/task-moves/missing-operation`,
      { method: "DELETE" },
    );
    expect(cancelled.status).toBe(404);
    expect(parseBody(await cancelled.text())).toEqual({
      error: {
        code: "operation_not_found",
        message: "No migration record in this runtime carries that id.",
      },
    });
  });

  it("serves the page and the static assets with their current cache headers", async () => {
    const page = await get("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain('id="languageSelect"');

    const styles = await get("/static/app.css");
    expect(styles.status).toBe(200);
    expect(styles.headers.get("content-type")).toContain("text/css");
    expect(styles.headers.get("cache-control")).toBe("no-cache");
    expect(await styles.text()).toContain("TABLE OF CONTENTS");

    const script = await get("/static/app.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect(script.headers.get("cache-control")).toBe("no-cache");
    // The served script is the bundled module graph; `startAdminUi` is its entry call.
    expect(await script.text()).toContain("function startAdminUi(");

    const archive = await get("/api/logs/export");
    expect(archive.status).toBe(200);
    expect(archive.headers.get("content-type")).toContain("application/zip");

    const statistics = await get(
      `/api/usage-statistics/export?from=${windowStart}&to=${windowEnd}`,
    );
    expect(statistics.status).toBe(200);
    expect(statistics.headers.get("content-type")).toContain("text/csv");
    expect(await statistics.text()).toContain("bucket,requests,tasks");
  });
});

describe("assembled statistics without any log root", () => {
  let root: string | undefined;
  let runtime: NodeApplication | undefined;
  let adminPort = 0;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "llm-proxy-contract-empty-"));
    await writeFile(path.join(root, "proxies.json"), JSON.stringify({ pairs: [] }));
    runtime = createNodeApplication({
      applicationConfigFile: path.join(root, "llm-proxy.json"),
      configFile: path.join(root, "proxies.json"),
      logRoot: path.join(root, "logs"),
      host: "127.0.0.1",
      port: 0,
    });
    await runtime.application.start();
    const port = runtime.address()?.port;
    if (port === undefined) {
      await runtime.application.stop();
      throw new Error("the empty-configuration application did not report an admin port");
    }
    adminPort = port;
  });

  afterAll(async () => {
    await runtime?.application.stop();
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 });
    }
  });

  // [AI-02] A configuration with no pair must still answer the statistics routes the
  // browser calls, with the same top-level keys an empty database produces.
  it("[AI-02] registers the statistics routes and answers empty payloads", async () => {
    const query = `from=${windowStart}&to=${windowEnd}`;
    const request = async (route: string, extra = "") =>
      await fetch(`http://127.0.0.1:${adminPort}${route}?${query}${extra}`);

    const overview = await request("/api/usage-statistics/overview");
    expect(overview.status).toBe(200);
    const overviewBody = (await overview.json()) as Record<string, unknown>;
    expect(Object.keys(overviewBody)).toEqual([
      "dataVersion",
      "totals",
      "byTarget",
      "byModel",
      "unpriced",
    ]);

    const trend = await request("/api/usage-statistics/trend", "&granularity=day");
    expect(trend.status).toBe(200);
    const trendBody = (await trend.json()) as Record<string, unknown>;
    expect(Object.keys(trendBody)).toEqual(["dataVersion", "granularity", "points"]);

    const options = await request("/api/usage-statistics/options");
    expect(options.status).toBe(200);
    expect(await options.json()).toEqual({ targets: [], models: [] });

    const exported = await request("/api/usage-statistics/export");
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toContain("text/csv");
    expect(await exported.text()).toContain("bucket,requests,tasks");
  });

  /**
   * [TRI-05] A configuration with no pair must still answer both load balancer routes. The
   * status read gives an empty list; the binding list names the pair it cannot find, which is
   * the route's own code and not the not-found handler's `not_found` - the difference between
   * "nothing is configured" and "nothing was wired".
   */
  it("[TRI-05] registers the load balancer routes and answers a stable empty configuration", async () => {
    const status = await fetch(`http://127.0.0.1:${adminPort}/api/load-balancer/status`);
    expect(status.status).toBe(200);
    const statusBody = parseBody(await status.text());
    expect(Object.keys(statusBody ?? {})).toEqual(["now", "pairs"]);
    expect(statusBody?.["pairs"]).toEqual([]);
    expect(statusBody?.["now"]).toBeTypeOf("number");

    const tasks = await fetch(
      `http://127.0.0.1:${adminPort}/api/load-balancer/tasks?pairId=pair-1&groupId=lb-1`,
    );
    expect(tasks.status).toBe(404);
    expect(parseBody(await tasks.text())).toEqual({
      error: { code: "pair_not_found", message: "Proxy pair not found." },
    });
  });

  /**
   * [TRI-08] With no pair configured at all, both migration routes are still registered and still
   * answer a named cause. The move names the pair it cannot find - the route's own code, with the
   * binding list's sentence for the same cause - and the cancel names the record it cannot find.
   * Neither answer is the not-found handler's `not_found`, which is what an unwired route looks
   * like and what this assembly cannot produce.
   */
  it("[TRI-08] registers both migration routes and names the cause with nothing configured", async () => {
    const move = await fetch(`http://127.0.0.1:${adminPort}/api/load-balancer/task-moves`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...contractMoveBody, runtimeEpoch: "epoch-after-restart" }),
    });
    expect(move.status).toBe(404);
    expect(parseBody(await move.text())).toEqual({
      error: { code: "binding_not_found", message: "Proxy pair not found." },
    });

    const cancelled = await fetch(
      `http://127.0.0.1:${adminPort}/api/load-balancer/task-moves/operation-from-the-old-runtime`,
      { method: "DELETE" },
    );
    expect(cancelled.status).toBe(404);
    expect(parseBody(await cancelled.text())).toEqual({
      error: {
        code: "operation_not_found",
        message: "No migration record in this runtime carries that id.",
      },
    });
  });
});
