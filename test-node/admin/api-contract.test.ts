import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applicationHealth,
  createAdminServer,
  type AdminServerOptions,
} from "../../src/admin/index.js";
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

// The full route table Fastify builds when every optional service is wired.
// Pinned so a renamed path, a dropped method, or a route that moves under a new
// condition fails here instead of answering 404 in front of the browser.
const ROUTE_TABLE = [
  "GET /",
  "GET /api/health",
  "GET /api/load-balancer/status",
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
    },
  ],
};

const windowStart = "2026-01-01T00:00:00.000Z";
const windowEnd = "2026-01-02T00:00:00.000Z";

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
      loadBalancerService: { getStatus: () => ({ now: 0, pairs: [] }) },
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
    expect(routes).toHaveLength(19);
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
    } as const;
    for (const [route, code] of Object.entries(cases)) {
      const response = await get(route);
      expect(response.status).toBe(404);
      const parsed = parseBody(await response.text());
      expect(errorCodeIn(parsed)).toBe(code);
    }
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
    expect(await script.text()).toContain("const state = {");

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
});
