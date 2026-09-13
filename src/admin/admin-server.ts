import Fastify, { LogController, type FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import type { Readable } from "node:stream";

import type { ApplicationState } from "../app/index.js";
import type { ProxyPair, PublicProxyPair, SummaryModelConfig } from "../config/index.js";
import type {
  LogCleanupResult,
  LogGroupLogs,
  LogGroupPage,
  LogRecordDetail,
} from "../maintenance/index.js";
import type { UsageStatisticsService } from "../maintenance/usage-statistics-service.js";
import { StructuredLogger } from "../shared/index.js";

export type HealthStatus = "degraded" | "ok" | "starting" | "stopping";

export interface HealthSnapshot {
  readonly applicationState: ApplicationState;
  readonly status: HealthStatus;
  readonly version: string;
}

export interface AdminServerOptions {
  readonly getHealth: () => HealthSnapshot;
  readonly logService?: LogAdminService;
  readonly logger?: AdminRequestLogger;
  readonly pairService?: PairAdminService;
  readonly staticAssets?: AdminStaticAssets | (() => Promise<AdminStaticAssets>);
  readonly targetCheckService?: TargetCheckAdminService;
  readonly summaryModelService?: SummaryModelAdminService;
  readonly usageStatisticsService?: UsageStatisticsService;
}
export interface SummaryModelAdminService {
  getConfig(): SummaryModelConfig | undefined;
  setConfig(config: SummaryModelConfig): Promise<SummaryModelConfig>;
  testConfig?(config: SummaryModelConfig): Promise<{ ok: boolean; detail?: string }>;
}

export interface LogAdminService {
  readonly cleanupKeepLatest?: (keepLatest: number) => LogCleanupResult;
  readonly cleanupOlderThan?: (olderThanDays: number) => LogCleanupResult;
  readonly cleanupSelectedGroups?: (groupIds: readonly string[]) => LogCleanupResult;
  readonly exportLogs?: () => Readable;
  readonly getGroupLogs?: (
    groupId: string,
    query: string,
    limit: number,
    offset: number,
  ) => LogGroupLogs | undefined;
  readonly getRecordDetail?: (recordId: string) => LogRecordDetail | undefined;
  readonly summarizeRecord?: (recordId: string) => Promise<unknown>;
  readonly getSummary?: (recordId: string) => unknown;
  readonly getGroupPricing?: (groupId: string) => unknown;
  listGroups(query: string, limit: number, offset: number): LogGroupPage;
}

export interface PairAdminService {
  listPairs(): readonly PublicProxyPair[];
  readonly replacePairs?: (pairs: readonly ProxyPair[]) => Promise<readonly PublicProxyPair[]>;
  readonly setPairEnabled?: (pairId: string, enabled: boolean) => Promise<PublicProxyPair>;
}

export type TargetCheckApiType = "chat" | "responses" | "anthropic";

export interface TargetCheckRequest {
  readonly targetUrl: string;
  readonly model: string;
  readonly apiType?: TargetCheckApiType;
  readonly apiKey?: string;
}

export interface TargetCheckResponse {
  readonly ok: boolean;
  readonly status?: number;
  readonly durationMs: number;
  readonly error?: string;
  readonly detail?: string;
}

export interface TargetCheckAdminService {
  checkTarget(request: TargetCheckRequest): Promise<TargetCheckResponse>;
}

export interface AdminRequestLogger {
  info(message: string, context?: Readonly<Record<string, unknown>>): void;
  warn(message: string, context?: Readonly<Record<string, unknown>>): void;
}

export interface AdminStaticAssets {
  readonly appCss: string;
  readonly appJs: string;
  readonly indexHtml: string;
}

export interface AdminErrorDto {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export const HEALTH_SNAPSHOT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["applicationState", "status", "version"],
  properties: {
    applicationState: { type: "string" },
    status: { type: "string", enum: ["degraded", "ok", "starting", "stopping"] },
    version: { type: "string" },
  },
} as const;

export const ADMIN_ERROR_DTO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
      },
    },
  },
} as const;

export const PAIRS_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pairs"],
  properties: {
    pairs: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
  },
} as const;

export const REPLACE_PAIRS_REQUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pairs"],
  properties: {
    pairs: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
  },
} as const;

export const SET_PAIR_ENABLED_REQUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["enabled"],
  properties: { enabled: { type: "boolean" } },
} as const;

export const TARGET_CHECK_REQUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["targetUrl", "model"],
  properties: {
    targetUrl: { type: "string", minLength: 1, maxLength: 8_192, pattern: "^https?://" },
    model: { type: "string", minLength: 1, maxLength: 512 },
    apiType: { type: "string", enum: ["chat", "responses", "anthropic"] },
    apiKey: { type: "string", maxLength: 65_536 },
  },
} as const;

export const TARGET_CHECK_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "durationMs"],
  properties: {
    ok: { type: "boolean" },
    status: { type: "integer", minimum: 100, maximum: 599 },
    durationMs: { type: "number", minimum: 0 },
    error: { type: "string", maxLength: 8_192 },
    detail: { type: "string", maxLength: 8_192 },
  },
} as const;

export const PAIR_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pair"],
  properties: { pair: { type: "object", additionalProperties: true } },
} as const;

export const LOG_GROUP_PAGE_SCHEMA = {
  type: "object",
  additionalProperties: true,
} as const;

export const LOG_GROUP_LOGS_SCHEMA = {
  type: "object",
  additionalProperties: true,
} as const;

export const LOG_RECORD_DETAIL_SCHEMA = {
  type: "object",
  additionalProperties: true,
} as const;

export interface AdminControlPlaneOptions extends AdminServerOptions {
  readonly host: string;
  readonly port: number;
}

export interface AdminControlPlaneAddress {
  readonly host: string;
  readonly port: number;
}

export class AdminControlPlane {
  readonly #host: string;
  readonly #port: number;
  readonly #server: FastifyInstance;

  constructor(options: AdminControlPlaneOptions) {
    this.#host = options.host;
    this.#port = options.port;
    this.#server = createAdminServer(options);
  }

  async start(): Promise<AdminControlPlaneAddress> {
    if (!this.#server.server.listening) {
      await this.#server.listen({ host: this.#host, port: this.#port });
    }
    const address = this.#server.server.address() as AddressInfo | null;
    if (address === null) {
      throw new Error("Admin control plane is not bound to a TCP address.");
    }
    return { host: address.address, port: address.port };
  }

  async close(): Promise<void> {
    await this.#server.close();
  }
}

export function createAdminServer(options: AdminServerOptions): FastifyInstance {
  const requestLogger = options.logger ?? new StructuredLogger({ service: "llm-proxy-admin" });
  const requestStarted = new WeakMap<object, number>();
  const server = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    logger: false,
  });
  if (options.usageStatisticsService !== undefined) {
    server.get("/api/usage-statistics/overview", (request) => {
      const query = request.query as { from?: string; to?: string; metric?: "token" | "cost" };
      if (query.from === undefined || query.to === undefined || query.from >= query.to) {
        throw Object.assign(new Error("Invalid time range"), {
          statusCode: 400,
          code: "bad_request",
        });
      }
      return options.usageStatisticsService!.overview(
        query.from,
        query.to,
        query.metric ?? "token",
      );
    });
    server.get("/api/usage-statistics/trend", (request) => {
      const query = request.query as {
        from?: string;
        to?: string;
        targetId?: string;
        model?: string;
        granularity?: string;
      };
      if (query.from === undefined || query.to === undefined || query.from >= query.to)
        throw Object.assign(new Error("Invalid time range"), {
          statusCode: 400,
          code: "bad_request",
        });
      return options.usageStatisticsService!.trend(
        query.from,
        query.to,
        query.targetId,
        query.model,
        query.granularity ?? "day",
      );
    });
    server.get("/api/usage-statistics/options", (request) => {
      const query = request.query as { from?: string; to?: string };
      if (query.from === undefined || query.to === undefined || query.from >= query.to)
        throw Object.assign(new Error("Invalid time range"), {
          statusCode: 400,
          code: "bad_request",
        });
      const rows = options.usageStatisticsService!.repositoryRows(query.from, query.to);
      const targets = new Map<string, string>();
      const models = new Set<string>();
      for (const row of rows) {
        const id = String(row["target_id"] ?? row["target_url"] ?? "unknown");
        targets.set(id, String(row["target_name"] ?? row["target_url"] ?? id));
        const model = String(row["billing_model"] ?? "");
        if (model) models.add(model);
      }
      return {
        targets: [...targets].map(([id, name]) => ({ id, name })),
        models: [...models].sort(),
      };
    });
  }
  if (options.usageStatisticsService !== undefined) {
    server.get("/api/usage-statistics/export", (request, reply) => {
      const q = request.query as {
        from?: string;
        to?: string;
        targetId?: string;
        model?: string;
        granularity?: string;
      };
      if (!q.from || !q.to || q.from >= q.to)
        throw Object.assign(new Error("Invalid time range"), {
          statusCode: 400,
          code: "bad_request",
        });
      const trend = options.usageStatisticsService!.trend(
        q.from,
        q.to,
        q.targetId,
        q.model,
        q.granularity ?? "day",
      );
      const lines = [
        "bucket,requests,tasks,input,output,cache_read,cache_write,cost",
        ...trend.points.map((p) =>
          [
            p["bucket"],
            p["requests"],
            p["tasks"],
            p["input"],
            p["output"],
            p["cache_read"],
            p["cache_write"],
            p["cost"],
          ].join(","),
        ),
      ];
      return reply.type("text/csv; charset=utf-8").send("\uFEFF" + lines.join("\n") + "\n");
    });
  }
  server.addHook("onRequest", (request, _reply, done) => {
    requestStarted.set(request, performance.now());
    done();
  });
  server.addHook("onResponse", (request, reply, done) => {
    requestLogger.info("Admin request completed", {
      method: request.method,
      path: request.url.split("?", 1)[0] ?? request.url,
      status_code: reply.statusCode,
      duration_ms: Math.max(0, performance.now() - (requestStarted.get(request) ?? 0)),
    });
    done();
  });
  server.addHook("onError", (_request, reply, error, done) => {
    requestLogger.warn("Admin request failed", {
      status_code: errorProperty(error, "statusCode", "number") ?? reply.statusCode,
      error_type: error.name,
    });
    done();
  });
  server.setErrorHandler((error, _request, reply) => {
    const statusCode = errorProperty(error, "statusCode", "number") ?? 500;
    const publicError = statusCode < 500;
    return reply
      .code(statusCode)
      .send(
        adminError(
          errorProperty(error, "code", "string") ??
            (publicError ? "bad_request" : "internal_error"),
          publicError
            ? (errorProperty(error, "message", "string") ?? "Request failed.")
            : "Internal server error.",
        ),
      );
  });
  server.setNotFoundHandler((_request, reply) =>
    reply.code(404).send(adminError("not_found", "Route not found.")),
  );
  if (options.summaryModelService !== undefined) {
    const summary = options.summaryModelService;
    server.get("/api/settings/summary-model", () => summary.getConfig() ?? null);
    server.put<{ Body: SummaryModelConfig }>("/api/settings/summary-model", async (request) =>
      summary.setConfig(request.body),
    );
    if (summary.testConfig)
      server.post<{ Body: SummaryModelConfig }>(
        "/api/settings/summary-model/test",
        async (request) => summary.testConfig?.(request.body),
      );
  }
  server.get(
    "/api/health",
    {
      schema: {
        response: {
          200: HEALTH_SNAPSHOT_SCHEMA,
          503: HEALTH_SNAPSHOT_SCHEMA,
        },
      },
    },
    async (_request, reply) => {
      const health = options.getHealth();
      return reply.code(health.status === "degraded" ? 503 : 200).send(health);
    },
  );
  if (options.targetCheckService !== undefined) {
    const targetCheckService = options.targetCheckService;
    server.post<{
      Body: { apiType?: TargetCheckApiType; apiKey?: string; model: string; targetUrl: string };
    }>(
      "/api/target-check",
      {
        schema: {
          body: TARGET_CHECK_REQUEST_SCHEMA,
          response: { 200: TARGET_CHECK_RESPONSE_SCHEMA },
        },
      },
      async (request, reply) => {
        const apiKey = request.body.apiKey;
        const apiType = request.body.apiType;
        const checkRequest: TargetCheckRequest = {
          targetUrl: request.body.targetUrl,
          model: request.body.model,
          ...(apiType ? { apiType } : {}),
          ...(apiKey ? { apiKey } : {}),
        };
        try {
          return await targetCheckService.checkTarget(checkRequest);
        } catch (error) {
          if (error instanceof TypeError) {
            return reply.code(400).send(adminError("invalid_target_url", error.message));
          }
          throw error;
        }
      },
    );
  }
  if (options.logService !== undefined) {
    const logService = options.logService;
    const cleanupSelectedGroups = logService.cleanupSelectedGroups?.bind(logService);
    const cleanupOlderThan = logService.cleanupOlderThan?.bind(logService);
    const cleanupKeepLatest = logService.cleanupKeepLatest?.bind(logService);
    if (
      cleanupSelectedGroups !== undefined ||
      cleanupOlderThan !== undefined ||
      cleanupKeepLatest !== undefined
    ) {
      server.post<{
        Body: { group_ids?: string[]; keep_latest?: number; older_than_days?: number };
      }>(
        "/api/logs/cleanup",
        {
          schema: {
            body: {
              type: "object",
              additionalProperties: false,
              minProperties: 1,
              properties: {
                group_ids: {
                  type: "array",
                  minItems: 1,
                  uniqueItems: true,
                  items: { type: "string", minLength: 1 },
                },
                older_than_days: { type: "integer", minimum: 0 },
                keep_latest: { type: "integer", minimum: 0 },
              },
            },
          },
        },
        (request, reply) => {
          if (request.body.group_ids !== undefined && cleanupSelectedGroups !== undefined) {
            return cleanupSelectedGroups(request.body.group_ids);
          }
          if (request.body.older_than_days !== undefined && cleanupOlderThan !== undefined) {
            return cleanupOlderThan(request.body.older_than_days);
          }
          if (request.body.keep_latest !== undefined && cleanupKeepLatest !== undefined) {
            return cleanupKeepLatest(request.body.keep_latest);
          }
          return reply
            .code(400)
            .send(adminError("unsupported_cleanup_strategy", "Cleanup strategy is not available."));
        },
      );
    }
    const exportLogs = logService.exportLogs?.bind(logService);
    if (exportLogs !== undefined) {
      server.get("/api/logs/export", (_request, reply) =>
        reply
          .header("content-disposition", 'attachment; filename="llm-proxy-logs.zip"')
          .type("application/zip")
          .send(exportLogs()),
      );
    }
    server.get<{ Querystring: { limit?: number; offset?: number; q?: string } }>(
      "/api/logs",
      {
        schema: {
          querystring: {
            type: "object",
            additionalProperties: false,
            properties: {
              q: { type: "string", default: "" },
              limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
              offset: { type: "integer", minimum: 0, default: 0 },
            },
          },
          response: { 200: LOG_GROUP_PAGE_SCHEMA },
        },
      },
      (request) =>
        logService.listGroups(
          request.query.q ?? "",
          request.query.limit ?? 100,
          request.query.offset ?? 0,
        ),
    );
    const getGroupLogs = logService.getGroupLogs?.bind(logService);
    const getGroupPricing = logService.getGroupPricing?.bind(logService);
    if (getGroupPricing !== undefined) {
      server.get<{ Params: { id: string } }>(
        "/api/log-groups/:id/pricing",
        {
          schema: {
            params: {
              type: "object",
              required: ["id"],
              properties: { id: { type: "string", minLength: 1 } },
            },
            response: { 200: LOG_GROUP_LOGS_SCHEMA },
          },
        },
        (request, reply) =>
          getGroupPricing(request.params.id) ??
          reply.code(404).send(adminError("log_group_not_found", "Log group not found.")),
      );
    }
    if (getGroupLogs !== undefined) {
      server.get<{
        Params: { id: string };
        Querystring: { limit?: number; offset?: number; q?: string };
      }>(
        "/api/log-groups/:id/logs",
        {
          schema: {
            params: {
              type: "object",
              required: ["id"],
              properties: { id: { type: "string", minLength: 1 } },
            },
            querystring: {
              type: "object",
              additionalProperties: false,
              properties: {
                q: { type: "string", default: "" },
                limit: { type: "integer", minimum: 1, maximum: 500, default: 200 },
                offset: { type: "integer", minimum: 0, default: 0 },
              },
            },
            response: { 200: LOG_GROUP_LOGS_SCHEMA },
          },
        },
        (request, reply) => {
          const group = getGroupLogs(
            request.params.id,
            request.query.q ?? "",
            request.query.limit ?? 200,
            request.query.offset ?? 0,
          );
          return (
            group ?? reply.code(404).send(adminError("log_group_not_found", "Log group not found."))
          );
        },
      );
    }
    const getRecordDetail = logService.getRecordDetail?.bind(logService);
    const summarizeRecord = logService.summarizeRecord?.bind(logService);
    const getSummary = logService.getSummary?.bind(logService);
    if (getRecordDetail !== undefined) {
      server.get<{ Params: { id: string } }>(
        "/api/logs/:id",
        {
          schema: {
            params: {
              type: "object",
              required: ["id"],
              properties: { id: { type: "string", minLength: 1 } },
            },
            response: { 200: LOG_RECORD_DETAIL_SCHEMA },
          },
        },
        (request, reply) =>
          getRecordDetail(request.params.id) ??
          reply.code(404).send(adminError("log_record_not_found", "Log record not found.")),
      );
    }
    if (summarizeRecord !== undefined) {
      if (getSummary !== undefined)
        server.get<{ Params: { id: string } }>(
          "/api/logs/:id/summary",
          (request) => getSummary(request.params.id) ?? null,
        );
      server.post<{ Params: { id: string } }>("/api/logs/:id/summary", async (request, reply) => {
        try {
          const result = await summarizeRecord(request.params.id);
          return (
            result ?? reply.code(404).send(adminError("record_not_found", "Record not found."))
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Summary failed.";
          return reply
            .code(message.includes("already in progress") ? 409 : 502)
            .send(
              adminError(
                message.includes("already in progress") ? "summary_in_progress" : "summary_failed",
                message,
              ),
            );
        }
      });
    }
  }
  if (options.pairService !== undefined) {
    const pairService = options.pairService;
    server.get("/api/pairs", { schema: { response: { 200: PAIRS_RESPONSE_SCHEMA } } }, () => ({
      pairs: pairService.listPairs(),
    }));
    const replacePairs = pairService.replacePairs?.bind(pairService);
    if (replacePairs !== undefined) {
      server.put<{ Body: { pairs: ProxyPair[] } }>(
        "/api/pairs",
        {
          schema: {
            body: REPLACE_PAIRS_REQUEST_SCHEMA,
            response: { 200: PAIRS_RESPONSE_SCHEMA },
          },
        },
        async (request) => ({ pairs: await replacePairs(request.body.pairs) }),
      );
    }
    const setPairEnabled = pairService.setPairEnabled?.bind(pairService);
    if (setPairEnabled !== undefined) {
      server.post<{ Body: { enabled: boolean }; Params: { id: string } }>(
        "/api/pairs/:id/enabled",
        {
          schema: {
            params: {
              type: "object",
              additionalProperties: false,
              required: ["id"],
              properties: { id: { type: "string", minLength: 1 } },
            },
            body: SET_PAIR_ENABLED_REQUEST_SCHEMA,
            response: { 200: PAIR_RESPONSE_SCHEMA },
          },
        },
        async (request) => ({
          pair: await setPairEnabled(request.params.id, request.body.enabled),
        }),
      );
    }
  }
  if (options.staticAssets !== undefined) {
    const resolveStaticAssets = async (): Promise<AdminStaticAssets | undefined> => {
      const assets = options.staticAssets;
      return typeof assets === "function" ? assets() : assets;
    };
    server.get("/", async (_request, reply) =>
      reply
        .header("cache-control", "no-store")
        .type("text/html; charset=utf-8")
        .send((await resolveStaticAssets())?.indexHtml),
    );
    server.get("/static/app.css", async (_request, reply) =>
      reply
        .header("cache-control", "no-cache")
        .type("text/css; charset=utf-8")
        .send((await resolveStaticAssets())?.appCss),
    );
    server.get("/static/app.js", async (_request, reply) =>
      reply
        .header("cache-control", "no-cache")
        .type("application/javascript; charset=utf-8")
        .send((await resolveStaticAssets())?.appJs),
    );
  }
  return server;
}

export function adminError(code: string, message: string): AdminErrorDto {
  return { error: { code, message } };
}

function errorProperty<T extends "number" | "string">(
  error: unknown,
  property: string,
  expectedType: T,
): T extends "number" ? number | undefined : string | undefined {
  const value =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)[property]
      : undefined;
  return (typeof value === expectedType ? value : undefined) as T extends "number"
    ? number | undefined
    : string | undefined;
}

export function applicationHealth(
  applicationState: ApplicationState,
  version = "development",
  degraded = false,
): HealthSnapshot {
  const status: HealthStatus = degraded
    ? "degraded"
    : applicationState === "running"
      ? "ok"
      : applicationState === "created" || applicationState === "starting"
        ? "starting"
        : "stopping";
  return { applicationState, status, version };
}
