import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ADMIN_ERROR_DTO_SCHEMA,
  PAIR_RESPONSE_SCHEMA,
  PAIRS_RESPONSE_SCHEMA,
  type AdminJsonSchema,
} from "../../src/admin/admin-schemas.js";
import {
  applicationHealth,
  createAdminServer,
  type PartialAdminServerOptions,
} from "../../src/admin/index.js";
import { createNodeApplication, type NodeApplication } from "../../src/app/index.js";
import type { PublicProxyPair, SummaryModelConfig } from "../../src/config/index.js";
import { UsageStatisticsService } from "../../src/maintenance/usage-statistics-service.js";
import { ApplicationError } from "../../src/shared/index.js";
import { TrafficRepository } from "../../src/persistence/repository.js";
import {
  cleanupResult,
  emptyGroupPage,
  enabledPair,
  exportStream,
  groupSummary,
  historySummary,
  listRecord,
  modelPriceImportResult,
  recordBatch,
  recordDetail,
  taskBrief,
} from "./log-service-fixtures.js";
import { emptyBindingListResponse } from "./admin-service-fixtures.js";

/**
 * [AI-08] Fastify prints a response through the schema attached to the route, and a closed
 * schema prints only the keys it declares. Every payload in `admin-schemas.ts` therefore
 * carries an explicit open/closed decision, and this file checks that decision against a
 * server that is actually running. The TypeScript types compile in both directions, so they
 * prove nothing here.
 *
 * Two halves: what the project decided stays open must survive a real request, including a
 * key no model in this repository names; what it decided stays closed must not appear.
 */

/** What the summary model is told to answer, plus a key the prompt never asked for. */
const summaryPayload = {
  title: "Build stages",
  overview: "Six stages, build was the longest.",
  segments: [{ range: "1-6", summary: "Install and build", key_points: [], evidence: [1, 6] }],
  decisions: ["keep the image"],
  issues: [],
  model_note: "kept verbatim",
};

const recordId = "openness-record";
const groupId = "openness-task";

/** The record the stub's log roots hold, so `/api/logs/nope` can answer 404. */
const heldRecordIds = new Set(["any"]);

/** A disabled pair still carries a log root, which is where the rows live. */
const opennessPair = {
  id: "pair-1",
  name: "openness",
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
};

let root: string | undefined;
let adminPort = 0;
let upstream: Server | undefined;
let runtimeRef: NodeApplication | undefined;

/**
 * A summary model that always answers the same payload. The real `LogQueryService` calls it,
 * so what this test reads back went through the same store the console reads.
 */
async function startSummaryModel(): Promise<string> {
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(summaryPayload) } }] }),
    );
  });
  upstream = server;
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return `http://127.0.0.1:${port}/v1`;
}

/**
 * One finished request whose client body, upstream answer and pricing all carry extra keys.
 * The headers are arbitrary names the client and the upstream chose, so they are the keys no
 * schema in this repository can name.
 */
function writeRows(logRoot: string): void {
  const repository = new TrafficRepository(logRoot);
  try {
    repository.upsertTask({ id: groupId, match_strategy_version: 4 });
    repository.upsertRecord({
      id: recordId,
      task_id: groupId,
      sequence: 1,
      event: "request_finished",
      method: "POST",
      path: "/v1/responses",
      endpoint: "/v1/responses",
      target_url: "http://fixture-target/v1",
      status: 200,
      duration_ms: 1200,
      first_token_ms: 200,
      decode_window_ms: 1000,
      request_token_count: 10,
      response_token_count: 5,
      request_headers: { "x-client-marker": "client header kept" },
      response_headers: { "x-upstream-marker": "upstream header kept" },
      request_body: { input: "hello", client_side_field: "request kept" },
      response_body: { output: "world", upstream_side_field: "response kept" },
      pricing: {
        pricing_status: "priced",
        cost_nano_cny: "41125000",
        billing_model: "fixture-model",
        usage: { source: "responses", model_reported_total: 15 },
        pricing_snapshot: { rule: "fixture-rule", matched_by: "pattern" },
      },
    });
  } finally {
    repository.close();
  }
}

/** The JSON a route answered, read without pretending a non-JSON body is empty. */
async function readJson(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

/** The inside of an error answer, so its key set can be checked. */
function errorBody(body: Record<string, unknown>): Record<string, unknown> {
  const error = body["error"];
  expect(error).toBeTypeOf("object");
  return error as Record<string, unknown>;
}

/** The value of a key in a parsed JSON object, checked to be an object. */
function field(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  expect(value).toBeTypeOf("object");
  return value as Record<string, unknown>;
}

/** The elements of a parsed JSON array, checked to be an array. */
function list(parent: Record<string, unknown>, key: string): unknown[] {
  const value = parent[key];
  expect(value).toBeTypeOf("object");
  return value as unknown[];
}

/** An element of a parsed JSON array, checked to be an object. */
function item(parent: unknown[], index: number): Record<string, unknown> {
  const value = parent[index];
  expect(value).toBeTypeOf("object");
  return value as Record<string, unknown>;
}

/** The keys a parsed JSON object answered with, in an order a comparison can rely on. */
function sortedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort();
}

/** The properties a JSON Schema declares, checked to be there. */
function properties(schema: AdminJsonSchema): Record<string, unknown> {
  const value = schema["properties"];
  expect(value).toBeTypeOf("object");
  return value as Record<string, unknown>;
}

/** One property a JSON Schema declares, checked to be there. */
function property(schema: AdminJsonSchema, key: string): AdminJsonSchema {
  const value = properties(schema)[key];
  expect(value).toBeTypeOf("object");
  return value as AdminJsonSchema;
}

/**
 * The element schema an array schema declares. `properties` walks an object's declared keys,
 * so an array's element is reached this way instead: the pair answer is an array of pairs.
 */
function itemsOf(schema: AdminJsonSchema): AdminJsonSchema {
  const value = schema["items"];
  expect(value).toBeTypeOf("object");
  return value as AdminJsonSchema;
}

describe("[AI-08] open payloads through the assembled application", () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "llm-proxy-openness-"));
    const targetUrl = await startSummaryModel();
    const summaryModel: SummaryModelConfig = {
      disable_reasoning: true,
      api_type: "openai_chat",
      target_url: targetUrl,
      api_key: "fixture-key",
      model: "fixture-summary-model",
      target_headers: [],
      timeout_ms: 5000,
    };
    await writeFile(
      path.join(root, "proxies.json"),
      JSON.stringify({ pairs: [opennessPair], summary_model: summaryModel }),
    );
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
    runtimeRef = runtime;
    writeRows(path.join(root, "logs"));
  });

  afterAll(async () => {
    await runtimeRef?.application.stop();
    await new Promise<void>((resolve) => {
      upstream?.close(() => resolve());
    });
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 });
    }
  });

  const ask = async (route: string, init?: RequestInit) =>
    await fetch(`http://127.0.0.1:${adminPort}${route}`, init);

  it("keeps a key the summary model wrote, through the store and back", async () => {
    const generated = await ask(`/api/logs/${recordId}/summary`, { method: "POST" });
    expect(generated.status).toBe(200);
    const generatedBody = await readJson(generated);
    // The prompt asked for five fields and the model wrote a sixth: it leaves the answer
    // exactly as it arrived.
    expect(generatedBody["model_note"]).toBe("kept verbatim");

    const stored = new TrafficRepository(path.join(root ?? "", "logs"));
    let storedJson: string | undefined;
    try {
      const row = stored.database
        .prepare("SELECT summary_json FROM history_summaries WHERE record_id = ?")
        .get(recordId) as { summary_json?: string } | undefined;
      storedJson = row?.summary_json;
    } finally {
      stored.close();
    }
    expect(storedJson).toBeDefined();
    expect(JSON.parse(storedJson ?? "")).toEqual(generatedBody);
    expect(storedJson).toContain('"model_note":"kept verbatim"');

    const readBack = await ask(`/api/logs/${recordId}/summary`);
    expect(readBack.status).toBe(200);
    const readBackText = await readBack.text();
    expect(readBackText).toContain('"model_note":"kept verbatim"');
    expect(JSON.parse(readBackText)).toEqual(generatedBody);
  });

  it("keeps the client and upstream halves of a record verbatim", async () => {
    const response = await ask(`/api/logs/${recordId}`);
    expect(response.status).toBe(200);
    const body = await readJson(response);
    // The top level is closed, so only the keys this project writes are printed; inside
    // them the client's JSON and the upstream answer pass through untouched.
    expect(Object.keys(body)).toEqual([
      "id",
      "pending",
      "request",
      "response",
      "pricing",
      "decode_window_ms",
      "request_meta",
      "response_meta",
    ]);
    expect(body["request"]).toEqual({ input: "hello", client_side_field: "request kept" });
    expect(body["response"]).toEqual({ output: "world", upstream_side_field: "response kept" });
    const pricing = body["pricing"] as Record<string, unknown>;
    expect(pricing["usage"]).toEqual({ source: "responses", model_reported_total: 15 });
    expect(pricing["pricing_snapshot"]).toEqual({ rule: "fixture-rule", matched_by: "pattern" });
  });

  it("keeps the header names the client and the upstream chose, and money as text", async () => {
    const response = await ask(`/api/logs/${recordId}`);
    expect(response.status).toBe(200);
    const body = await readJson(response);
    // Header names are chosen by whoever sends the request, so no schema in this repository
    // can name them. They are the proof that an open payload keeps what it was given.
    expect(field(field(body, "request_meta"), "headers")["x-client-marker"]).toBe(
      "client header kept",
    );
    expect(field(field(body, "response_meta"), "headers")["x-upstream-marker"]).toBe(
      "upstream header kept",
    );
    // A nano-CNY total does not fit a double without losing digits, so it stays text.
    expect(field(body, "pricing")["cost_nano_cny"]).toBe("41125000");
  });

  /**
   * Measured on this application, and asserted as what the product actually guarantees.
   *
   * The written pair carries 27 keys. `/api/pairs` returns those legacy keys alongside the
   * current modeled fields and runtime status. The open pair payload keeps the values because
   * `src/config` now stores unknown JSON fields in a typed preservation boundary and
   * materializes them again only for API/persisted configuration output.
   */
  it("[AI-25] carries all legacy flat pair keys while keeping runtime fields transient", async () => {
    const response = await ask("/api/pairs");
    expect(response.status).toBe(200);
    const body = await readJson(response);
    const pair = item(list(body, "pairs"), 0);

    // The whole key set, so nothing else can slip in and nothing listed can vanish.
    expect(Object.keys(pair)).toEqual([
      "id",
      "name",
      "enabled",
      "listen_host",
      "listen_port",
      "access_log",
      "targets",
      "default_target_id",
      "load_balancers",
      "upstream_url",
      "model_mapping_mode",
      "default_model",
      "default_upstream_model",
      "preserve_route_model",
      "allow_unnamed_model",
      "unknown_model_policy",
      "unknown_param_mode",
      "unknown_param_paths",
      "stream_keepalive_interval_seconds",
      "target_retry_limit",
      "target_retry_backoff_milliseconds",
      "failover_reuse_connection",
      "target_connect_timeout_milliseconds",
      "target_first_byte_timeout_milliseconds",
      "target_idle_chunk_timeout_milliseconds",
      "target_headers",
      "strip_request_fields",
      "inject_request_fields",
      "log_root",
      "redact_logs",
      "model_mappings",
      "running",
      "actual_listen_port",
    ]);

    // What the file declared survives with the values the file wrote.
    expect(pair["id"]).toBe("pair-1");
    expect(pair["name"]).toBe("openness");
    expect(pair["enabled"]).toBe(false);
    expect(pair["listen_host"]).toBe("127.0.0.1");

    // A legacy flat pair has no target list, so normalisation synthesizes the one target the
    // schema requires and makes it the default. `access_log` and `load_balancers` were never
    // written for this pair, so they answer the model's own defaults.
    expect(pair["access_log"]).toBe(false);
    expect(pair["load_balancers"]).toEqual([]);
    const targets = list(pair, "targets");
    expect(targets).toHaveLength(1);
    const target = item(targets, 0);
    expect(target["id"]).toBe("target-1");
    expect(pair["default_target_id"]).toBe("target-1");
    expect(list(target, "model_mappings")).toEqual([]);

    // (a) The pair's log root resurfaces inside that target, and as an absolute path: the
    // application's own log root is what normalisation hands the target it has to invent.
    const targetLogRoot = target["log_root"];
    expect(targetLogRoot).toBe(path.join(root ?? "", "logs"));
    expect(path.isAbsolute(String(targetLogRoot))).toBe(true);

    // Every legacy key is retained verbatim, including fields that are now represented by the
    // synthesized target as part of the current nested model.
    const legacyValues = opennessPair as Record<string, unknown>;
    for (const key of [
      "upstream_url",
      "model_mapping_mode",
      "default_model",
      "default_upstream_model",
      "preserve_route_model",
      "allow_unnamed_model",
      "unknown_model_policy",
      "unknown_param_mode",
      "unknown_param_paths",
      "stream_keepalive_interval_seconds",
      "target_retry_limit",
      "target_retry_backoff_milliseconds",
      "failover_reuse_connection",
      "target_connect_timeout_milliseconds",
      "target_first_byte_timeout_milliseconds",
      "target_idle_chunk_timeout_milliseconds",
      "target_headers",
      "strip_request_fields",
      "inject_request_fields",
      "log_root",
      "redact_logs",
      "model_mappings",
    ]) {
      expect(pair[key]).toEqual(legacyValues[key]);
    }
    // Runtime state is supplied by the registry and never comes from persisted configuration.
    expect(pair["running"]).toBe(false);
    expect(pair["actual_listen_port"]).toBeNull();
  });
});

describe("[AI-08] declared decisions through a running admin server", () => {
  let server: ReturnType<typeof createAdminServer> | undefined;

  beforeAll(async () => {
    server = createAdminServer(adminStubs());
    await server.ready();
  });

  afterAll(async () => {
    await server?.close();
  });

  it("keeps an open payload's extra key and drops a closed one's", async () => {
    const summary = await server?.inject({ method: "GET", url: "/api/logs/any/summary" });
    expect(summary?.statusCode).toBe(200);
    expect(summary?.payload).toContain("kept verbatim");

    const detail = await server?.inject({ method: "GET", url: "/api/logs/any" });
    expect(detail?.statusCode).toBe(200);
    const detailBody = JSON.parse(detail?.payload ?? "") as Record<string, unknown>;
    expect(detailBody["smuggled_top_level"]).toBeUndefined();
    expect(field(detailBody, "pricing")["model_note"]).toBe("kept verbatim");

    const groupPage = await server?.inject({ method: "GET", url: "/api/logs?limit=5" });
    const group = item(
      list(JSON.parse(groupPage?.payload ?? "") as Record<string, unknown>, "groups"),
      0,
    );
    expect(group["smuggled_group_field"]).toBeUndefined();
    expect(group["id"]).toBe(groupId);

    const brief = await server?.inject({ method: "POST", url: `/api/log-groups/${groupId}/brief` });
    expect(brief?.statusCode).toBe(200);
    const briefBody = JSON.parse(brief?.payload ?? "") as Record<string, unknown>;
    expect(briefBody["smuggled_brief_field"]).toBeUndefined();
    expect(briefBody["text"]).toBe(taskBrief().text);

    const status = await server?.inject({ method: "GET", url: "/api/load-balancer/status" });
    const statusBody = JSON.parse(status?.payload ?? "") as Record<string, unknown>;
    const statusGroup = item(list(item(list(statusBody, "pairs"), 0), "groups"), 0);
    const node = item(list(statusGroup, "nodes"), 0);
    expect(node["smuggled_node_field"]).toBeUndefined();
    expect(node["targetId"]).toBe("target-1");
    // A nested declared object is closed in the same way as the object around it.
    expect(field(node, "metrics")["smuggled_metric_field"]).toBeUndefined();
    expect(field(node, "metrics")["running"]).toBe(2);

    // [TRI-05] the binding list carries eight nested declared objects on top of the page
    // itself, and each one is as closed as the page around it: an invented field disappears at
    // every depth, and the answer carries exactly the keys the schema declares - no more.
    const tasks = await server?.inject({
      method: "GET",
      url: "/api/load-balancer/tasks?pairId=pair-1&groupId=group-1",
    });
    expect(tasks?.statusCode).toBe(200);
    const tasksBody = JSON.parse(tasks?.payload ?? "") as Record<string, unknown>;
    expect(tasksBody["smuggled_list_field"]).toBeUndefined();
    expect(sortedKeys(tasksBody)).toEqual(
      [
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
      ].sort(),
    );

    const bindingRow = item(list(tasksBody, "items"), 0);
    expect(bindingRow["smuggled_binding_field"]).toBeUndefined();
    expect(bindingRow["bindingId"]).toBe(1);
    expect(bindingRow["activity"]).toBe("idle");
    expect(bindingRow["endpointKind"]).toBe("responses");
    expect(bindingRow["routingRevision"]).toBe(0);
    // The stub also invented a TTL, an expiry and an evidence flag; none of them is declared,
    // so none of them reaches the browser.
    for (const invented of [
      "evidenceComplete",
      "expiresAt",
      "expiresInSeconds",
      "ttlPolicy",
      "userMessageCount",
      "userMessagesBounded",
    ]) {
      expect(bindingRow[invented]).toBeUndefined();
    }
    expect(sortedKeys(bindingRow)).toEqual(
      [
        "activity",
        "associations",
        "bindingId",
        "context",
        "endpoint",
        "endpointKind",
        "incarnation",
        "inFlight",
        "lastBoundAt",
        "lastRequestStartedAt",
        "lastResponseEndedAt",
        "lastSeenAt",
        "model",
        "movable",
        "recentRequestStarts",
        "requestCount",
        "routingRevision",
        "targetId",
      ].sort(),
    );

    expect(field(bindingRow, "movable")["smuggled_movable_field"]).toBeUndefined();
    expect(field(bindingRow, "movable")["reasons"]).toEqual(["in_flight"]);
    expect(sortedKeys(field(bindingRow, "movable"))).toEqual(["ok", "reasons"]);
    // The cost signal keeps the ledger's own names; the stub's `summaryPresent` and
    // `taskCount` are not declared and so never appear.
    const context = field(bindingRow, "context");
    expect(context["smuggled_context_field"]).toBeUndefined();
    expect(context["observedAt"]).toBeNull();
    expect(context["requestBytes"]).toBeNull();
    expect(context["summaryPresent"]).toBeUndefined();
    expect(context["taskCount"]).toBeUndefined();
    expect(sortedKeys(context)).toEqual(
      ["cacheReadTokens", "inputTokens", "observedAt", "requestBytes", "source"].sort(),
    );

    const associations = field(bindingRow, "associations");
    expect(associations["smuggled_associations_field"]).toBeUndefined();
    expect(associations["confidence"]).toBe("high");
    expect(sortedKeys(associations)).toEqual(
      ["ambiguous", "confidence", "coverage", "reasons", "taskIds", "tasks"].sort(),
    );
    const coverage = field(associations, "coverage");
    expect(coverage["smuggled_coverage_field"]).toBeUndefined();
    expect(coverage["state"]).toBe("available");
    expect(coverage["failure"]).toBeNull();
    expect(sortedKeys(coverage)).toEqual(
      [
        "candidateRowsRead",
        "candidateScanLimit",
        "exactKeysExamined",
        "exactKeysLinked",
        "exactKeysOmitted",
        "exactKeysRequested",
        "exactKeysWithoutLink",
        "exactLinkRowsRead",
        "failure",
        "historyRowsRead",
        "historyTruncated",
        "latestStoredRecordAt",
        "linkedTasksRead",
        "logWriteMayBePending",
        "returnedTaskLimit",
        "state",
      ].sort(),
    );

    const historyTask = item(list(associations, "tasks"), 0);
    expect(historyTask["smuggled_task_field"]).toBeUndefined();
    expect(historyTask["taskId"]).toBe("task-1");
    expect(historyTask["level"]).toBe("high");
    expect(historyTask["endpoint"]).toBe("/v1/responses");
    expect(historyTask["kind"]).toBe("responses");
    expect(historyTask["requestCount"]).toBe(1);
    expect(sortedKeys(historyTask)).toEqual(
      [
        "endpoint",
        "exactKeyMatches",
        "historyTargetNode",
        "kind",
        "lastResponseAt",
        "lastSeenAt",
        "level",
        "model",
        "pendingRequestOnly",
        "requestCount",
        "taskId",
      ].sort(),
    );

    const taskNode = item(list(tasksBody, "nodes"), 0);
    expect(taskNode["smuggled_task_node_field"]).toBeUndefined();
    // A node's `stale` flag belongs to the status read; the list does not declare it.
    expect(taskNode["stale"]).toBeUndefined();
    expect(sortedKeys(taskNode)).toEqual(
      [
        "bindings",
        "canonicalKey",
        "cooldownRemainingMs",
        "enabled",
        "failures",
        "inFlight",
        "inRotation",
        "lastDispatchedAt",
        "metrics",
        "targetId",
      ].sort(),
    );
    const taskMetrics = field(taskNode, "metrics");
    expect(taskMetrics["smuggled_node_metric_field"]).toBeUndefined();
    expect(taskMetrics["completeness"]).toBe("complete");
    expect(taskMetrics["freshness"]).toBe("fresh");
    expect(sortedKeys(taskMetrics)).toEqual(
      [
        "awake",
        "completeness",
        "freshness",
        "kvUsage",
        "running",
        "sampleSequence",
        "sampledAt",
        "source",
        "usableForLoadJudgement",
        "waiting",
      ].sort(),
    );
    const health = await server?.inject({ method: "GET", url: "/api/health" });
    expect(Object.keys(JSON.parse(health?.payload ?? "") as Record<string, unknown>)).toEqual([
      "applicationState",
      "status",
      "version",
    ]);
  });

  it("accepts a pair body with a key no schema names and answers it back", async () => {
    const customPair = { ...enabledPair("pair-custom"), custom_field: "kept on the way in" };
    const put = await server?.inject({
      method: "PUT",
      url: "/api/pairs",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ pairs: [customPair] }),
    });
    expect(put?.statusCode).toBe(200);
    const putBody = JSON.parse(put?.payload ?? "") as Record<string, unknown>;
    expect(item(list(putBody, "pairs"), 0)["custom_field"]).toBe("kept on the way in");

    const enabled = await server?.inject({
      method: "POST",
      url: "/api/pairs/pair-custom/enabled",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ enabled: true, extra_switch: "dropped by the handler" }),
    });
    expect(enabled?.statusCode).toBe(200);
    const enabledBody = JSON.parse(enabled?.payload ?? "") as Record<string, unknown>;
    expect(field(enabledBody, "pair")["custom_field"]).toBe("kept on the way in");
  });

  it("refuses an undeclared query key and keeps every error answer the same shape", async () => {
    const unknownFilter = await server?.inject({
      method: "GET",
      url: "/api/logs?limit=5&surprise=1",
    });
    expect(unknownFilter?.statusCode).toBe(400);
    const failure = errorBody(JSON.parse(unknownFilter?.payload ?? "") as Record<string, unknown>);
    expect(Object.keys(failure)).toEqual(["code", "message"]);
    expect(failure["code"]).toBe("FST_ERR_VALIDATION");

    const emptyIds = await server?.inject({ method: "GET", url: "/api/logs/records?ids=," });
    expect(emptyIds?.statusCode).toBe(400);
    const idsFailure = errorBody(JSON.parse(emptyIds?.payload ?? "") as Record<string, unknown>);
    expect(idsFailure["code"]).toBe("invalid_request");

    const missingRecord = await server?.inject({ method: "GET", url: "/api/logs/nope" });
    expect(missingRecord?.statusCode).toBe(404);
    const recordFailure = errorBody(
      JSON.parse(missingRecord?.payload ?? "") as Record<string, unknown>,
    );
    expect(recordFailure["code"]).toBe("log_record_not_found");

    const conflict = await server?.inject({
      method: "POST",
      url: `/api/log-groups/${groupId}/brief`,
    });
    expect(conflict?.statusCode).toBe(409);
    const conflictFailure = errorBody(
      JSON.parse(conflict?.payload ?? "") as Record<string, unknown>,
    );
    expect(conflictFailure["code"]).toBe("task_brief_in_progress");

    const exploded = await server?.inject({ method: "GET", url: "/api/logs/exploding" });
    expect(exploded?.statusCode).toBe(500);
    const unexpected = errorBody(JSON.parse(exploded?.payload ?? "") as Record<string, unknown>);
    expect(Object.keys(unexpected)).toEqual(["code", "message"]);
    expect(unexpected["code"]).toBe("internal_error");
  });

  it("declares the error shape once, closed", () => {
    expect(Object.keys(properties(ADMIN_ERROR_DTO_SCHEMA))).toEqual(["error"]);
    expect(ADMIN_ERROR_DTO_SCHEMA["additionalProperties"]).toBe(false);
    const inner = property(ADMIN_ERROR_DTO_SCHEMA, "error");
    expect(Object.keys(properties(inner))).toEqual(["code", "message"]);
    expect(inner["additionalProperties"]).toBe(false);
    // The pair answers declare nothing inside, which is the other half of the same table.
    expect(itemsOf(property(PAIRS_RESPONSE_SCHEMA, "pairs"))["additionalProperties"]).toEqual({});
    expect(property(PAIR_RESPONSE_SCHEMA, "pair")["additionalProperties"]).toEqual({});
  });
});

/**
 * Add a key the declared model does not name, keeping the value's own type. The point is the
 * serializer's behaviour: the types compile whether or not the key survives the answer.
 */
function smuggle<T>(value: T, key: string, payload: unknown): T {
  return { ...value, [key]: payload };
}

/**
 * [AI-09] This stub wires 14 of the 16 log views the production assembly must provide — it has
 * no `cleanupOlderThan` and no `cleanupSelectedGroups` — so it is annotated with the explicit
 * partial-assembly type rather than the complete `AdminServerOptions`. The routes it does have
 * are the ones the checks below probe; the two cleanup strategies it leaves out answer the
 * generic `not_found`, which is the shape a production assembly must never produce.
 */
function adminStubs(): PartialAdminServerOptions {
  /** The pairs this stub holds, so an enabled toggle answers the pair that was stored. */
  const storedPairs: PublicProxyPair[] = [];
  /**
   * A brief is generated once for a task; asking again finds one already in flight. The two
   * statuses the error checks read are the two states the real service keeps, so the stub
   * keeps that state instead of answering every call the same way. The successful answer is
   * the first request the file makes for the task and the refused one the second, which is
   * the order the two checks are written in.
   */
  const generatedBriefs = new Set<string>();
  return {
    getHealth: () => smuggle(applicationHealth("running"), "smuggled_health_field", "gone"),
    logService: {
      listGroups: () => ({
        ...emptyGroupPage(5, 0),
        groups: [smuggle(groupSummary(groupId), "smuggled_group_field", "gone")],
      }),
      getGroupLogs: () => undefined,
      listRecordsByIds: (ids: readonly string[]) =>
        recordBatch(ids.map((id) => listRecord(id, false))),
      getRecordDetail: (id: string) => {
        if (id === "exploding") throw new Error("boom");
        if (!heldRecordIds.has(id)) return undefined;
        const detail = recordDetail(id);
        return smuggle(
          {
            ...detail,
            pricing: { ...(detail.pricing ?? {}), model_note: "kept verbatim" },
          },
          "smuggled_top_level",
          "gone",
        );
      },
      getSummary: () => historySummary(),
      summarizeRecord: () => Promise.resolve(historySummary()),
      getGroupPricing: () => undefined,
      getGroupTokenSeries: () => undefined,
      getGroupCostSeries: () => undefined,
      getGroupOutputTokenSeries: () => undefined,
      getTaskBrief: () => undefined,
      generateTaskBrief: (groupId: string) => {
        if (generatedBriefs.has(groupId)) {
          return Promise.reject(
            new ApplicationError("A brief is already being generated.", {
              code: "conflict",
              expose: true,
              statusCode: 409,
            }),
          );
        }
        generatedBriefs.add(groupId);
        return Promise.resolve(taskBrief(groupId));
      },
      exportLogs: () => exportStream(),
      cleanupKeepLatest: (keep: number) =>
        cleanupResult(Array.from({ length: keep }, (_, index) => `row-${index}`)),
    },
    pairService: {
      listPairs: () => storedPairs,
      replacePairs: (pairs) => {
        storedPairs.length = 0;
        storedPairs.push(
          ...pairs.map((pair) => ({ ...pair, actual_listen_port: 18_080, running: true })),
        );
        return Promise.resolve(storedPairs);
      },
      setPairEnabled: (pairId: string) => {
        const stored = storedPairs.find((pair) => pair.id === pairId);
        return Promise.resolve(
          stored === undefined ? enabledPair(pairId) : { ...stored, enabled: true },
        );
      },
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
      getStatus: () =>
        smuggle(
          {
            now: 1,
            pairs: [
              {
                enabled: true,
                groups: [
                  {
                    bindings: 0,
                    enabled: true,
                    failoverEnabled: true,
                    id: "group-1",
                    metricsEnabled: false,
                    modelPattern: "gpt-*",
                    name: "group",
                    nodeTargetIds: ["target-1"],
                    nodes: [
                      {
                        bindings: 0,
                        canonicalKey: "canonical",
                        cooldownRemainingMs: 0,
                        enabled: true,
                        failures: 0,
                        inFlight: 0,
                        inRotation: true,
                        lastDispatchedAt: null,
                        metrics: smuggle(
                          {
                            kvUsage: 1,
                            running: 2,
                            sampledAt: 3,
                            source: "fixture",
                            waiting: 4,
                          },
                          "smuggled_metric_field",
                          "gone",
                        ),
                        stale: true,
                        targetId: "target-1",
                      },
                    ],
                    strategy: "least_loaded",
                  },
                ],
                id: "pair-1",
                name: "pair",
                running: true,
              },
            ],
          },
          "smuggled_pair_field",
          "gone",
        ),
      getBindings: () => ({
        response: smuggle(
          {
            ...emptyBindingListResponse(),
            items: [
              smuggle(
                {
                  activity: "idle",
                  associations: smuggle(
                    {
                      ambiguous: false,
                      confidence: "high",
                      coverage: smuggle(
                        {
                          candidateRowsRead: 1,
                          candidateScanLimit: 50,
                          exactKeysExamined: 1,
                          exactKeysLinked: 1,
                          exactKeysOmitted: 0,
                          exactKeysRequested: 1,
                          exactKeysWithoutLink: 0,
                          exactLinkRowsRead: 1,
                          failure: null,
                          historyRowsRead: 2,
                          historyTruncated: false,
                          latestStoredRecordAt: "2026-07-18T09:30:00.000+08:00",
                          linkedTasksRead: 1,
                          logWriteMayBePending: false,
                          returnedTaskLimit: 50,
                          state: "available",
                        },
                        "smuggled_coverage_field",
                        "gone",
                      ),
                      reasons: ["exact_key_links"],
                      tasks: [
                        smuggle(
                          {
                            boundaryEvidenceMatches: true,
                            endpoint: "/v1/responses",
                            exactKeyMatches: 1,
                            historyTargetNode: "same",
                            kind: "responses",
                            lastResponseAt: "2026-07-18T09:00:00.000+08:00",
                            lastSeenAt: "2026-07-18T09:00:00.000+08:00",
                            latestLogRecordAt: "2026-07-18T09:30:00.000+08:00",
                            level: "high",
                            model: "gpt-test",
                            pendingRequestOnly: false,
                            requestCount: 1,
                            taskId: "task-1",
                          },
                          "smuggled_task_field",
                          "gone",
                        ),
                      ],
                      taskIds: ["task-1"],
                    },
                    "smuggled_associations_field",
                    "gone",
                  ),
                  bindingId: 1,
                  context: smuggle(
                    {
                      cacheReadTokens: null,
                      inputTokens: null,
                      observedAt: null,
                      requestBytes: null,
                      source: "none",
                      summaryPresent: false,
                      taskCount: 0,
                      taskIds: [],
                    },
                    "smuggled_context_field",
                    "gone",
                  ),
                  endpoint: "/v1/responses",
                  endpointKind: "responses",
                  evidenceComplete: true,
                  expiresAt: null,
                  expiresInSeconds: null,
                  incarnation: 2,
                  inFlight: 0,
                  lastBoundAt: 1,
                  lastRequestStartedAt: 1,
                  lastResponseEndedAt: 1,
                  lastSeenAt: 1,
                  model: "gpt-test",
                  movable: smuggle(
                    { ok: false, reasons: ["in_flight"] },
                    "smuggled_movable_field",
                    "gone",
                  ),
                  recentRequestStarts: [],
                  requestCount: 1,
                  routingRevision: 0,
                  targetId: "target-1",
                  ttlPolicy: "turn_progress",
                  userMessageCount: 1,
                  userMessagesBounded: false,
                },
                "smuggled_binding_field",
                "gone",
              ),
            ],
            nodes: [
              smuggle(
                {
                  bindings: 1,
                  canonicalKey: "canonical",
                  cooldownRemainingMs: 0,
                  enabled: true,
                  failures: 0,
                  inFlight: 0,
                  inRotation: true,
                  lastDispatchedAt: null,
                  metrics: smuggle(
                    {
                      awake: null,
                      completeness: "complete",
                      freshness: "fresh",
                      kvUsage: 1,
                      running: 2,
                      sampleSequence: 1,
                      sampledAt: 3,
                      source: "fixture",
                      usableForLoadJudgement: true,
                      waiting: 4,
                    },
                    "smuggled_node_metric_field",
                    "gone",
                  ),
                  stale: false,
                  targetId: "target-1",
                },
                "smuggled_task_node_field",
                "gone",
              ),
            ],
            runtimeEpoch: "epoch",
            totalBindings: 1,
          },
          "smuggled_list_field",
          "gone",
        ),
      }),
    },
    summaryModelService: {
      getConfig: () => undefined,
      setConfig: (config: SummaryModelConfig) => Promise.resolve(config),
      testConfig: () => Promise.resolve({ ok: true }),
    },
    modelCatalogService: { importModelPrices: () => Promise.resolve(modelPriceImportResult()) },
    usageStatisticsService: new UsageStatisticsService({ usageStatisticsRows: () => [] }),
  };
}
