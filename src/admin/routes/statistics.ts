import type { FastifyInstance } from "fastify";
import { recordText } from "../../persistence/repository.js";
import type {
  StatisticsMetric,
  UsageStatisticsBreakdown,
} from "../../maintenance/usage-statistics-service.js";
import type { UsageStatisticsService } from "../../maintenance/usage-statistics-service.js";
import { csvCell } from "../admin-contracts.js";

export function registerStatisticsRoutes(
  server: FastifyInstance,
  usageStatisticsService: UsageStatisticsService,
): void {
  const statsQuery = {
    type: "object",
    required: ["from", "to"],
    additionalProperties: false,
    properties: {
      from: { type: "string", format: "date-time" },
      to: { type: "string", format: "date-time" },
      metric: { type: "string", enum: ["token", "cost"] },
      targetId: { type: "string", minLength: 1, maxLength: 200 },
      model: { type: "string", minLength: 1, maxLength: 200 },
      granularity: { type: "string", enum: ["day", "week", "month", "auto"] },
      timezoneOffset: { type: "integer", minimum: -840, maximum: 840 },
      breakdown: { type: "string", enum: ["total", "model", "target"] },
    },
  } as const;
  server.get(
    "/api/usage-statistics/overview",
    { schema: { querystring: statsQuery } },
    (request) => {
      const query = request.query as {
        from?: string;
        to?: string;
        metric?: StatisticsMetric;
      };
      if (query.from === undefined || query.to === undefined || query.from >= query.to) {
        throw Object.assign(new Error("Invalid time range"), {
          statusCode: 400,
          code: "bad_request",
        });
      }
      return usageStatisticsService.overview(query.from, query.to, query.metric ?? "token");
    },
  );
  server.get("/api/usage-statistics/trend", { schema: { querystring: statsQuery } }, (request) => {
    const query = request.query as {
      from?: string;
      to?: string;
      targetId?: string;
      model?: string;
      granularity?: string;
      timezoneOffset?: number;
      breakdown?: UsageStatisticsBreakdown;
    };
    if (query.from === undefined || query.to === undefined || query.from >= query.to)
      throw Object.assign(new Error("Invalid time range"), {
        statusCode: 400,
        code: "bad_request",
      });
    return usageStatisticsService.trend(
      query.from,
      query.to,
      query.targetId,
      query.model,
      query.granularity ?? "day",
      query.timezoneOffset ?? 0,
      query.breakdown ?? "total",
    );
  });
  server.get(
    "/api/usage-statistics/options",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["from", "to"],
          additionalProperties: false,
          properties: {
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
            targetId: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    (request) => {
      const query = request.query as { from?: string; to?: string; targetId?: string };
      if (query.from === undefined || query.to === undefined || query.from >= query.to)
        throw Object.assign(new Error("Invalid time range"), {
          statusCode: 400,
          code: "bad_request",
        });
      const rows = usageStatisticsService.repositoryRows(query.from, query.to);
      const targets = new Map<string, string>();
      const models = new Set<string>();
      for (const row of rows) {
        const id = recordText(row, "unknown", "target_id", "target_url");
        targets.set(id, recordText(row, id, "target_name", "target_url"));
        if (query.targetId && query.targetId !== id) continue;
        const model = recordText(row, "", "billing_model");
        if (model) models.add(model);
      }
      return {
        targets: [...targets].map(([id, name]) => ({ id, name })),
        models: [...models].sort(),
      };
    },
  );

  server.get(
    "/api/usage-statistics/export",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["from", "to"],
          additionalProperties: false,
          properties: {
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
            targetId: { type: "string", minLength: 1, maxLength: 200 },
            model: { type: "string", minLength: 1, maxLength: 200 },
            granularity: { type: "string", enum: ["day", "week", "month", "auto"] },
            timezoneOffset: { type: "integer", minimum: -840, maximum: 840 },
          },
        },
      },
    },
    (request, reply) => {
      const q = request.query as {
        from?: string;
        to?: string;
        targetId?: string;
        model?: string;
        granularity?: string;
        timezoneOffset?: number;
      };
      if (!q.from || !q.to || q.from >= q.to)
        throw Object.assign(new Error("Invalid time range"), {
          statusCode: 400,
          code: "bad_request",
        });
      const trend = usageStatisticsService.trend(
        q.from,
        q.to,
        q.targetId,
        q.model,
        q.granularity ?? "day",
        q.timezoneOffset ?? 0,
      );
      const lines = [
        "bucket,requests,tasks,input,output,cache_read,cache_write,cost,unpriced",
        ...trend.points.map((point) =>
          [
            csvCell(point.bucket),
            point.requests,
            point.tasks,
            point.input,
            point.output,
            point.cache_read,
            point.cache_write,
            point.cost,
            point.unpriced,
          ].join(","),
        ),
      ];
      return reply.type("text/csv; charset=utf-8").send("\uFEFF" + lines.join("\n") + "\n");
    },
  );
}
