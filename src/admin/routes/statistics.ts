import type { FastifyInstance } from "fastify";
import { recordText } from "../../persistence/repository.js";
import type { UsageStatisticsService } from "../../maintenance/usage-statistics-service.js";
import { csvCell } from "../admin-contracts.js";
import {
  adminResponseSchemas,
  STATISTICS_EXPORT_QUERY_SCHEMA,
  STATISTICS_OPTIONS_RESPONSE_SCHEMA,
  STATISTICS_OVERVIEW_RESPONSE_SCHEMA,
  STATISTICS_QUERY_SCHEMA,
  STATISTICS_TREND_RESPONSE_SCHEMA,
  STATISTICS_WINDOW_QUERY_SCHEMA,
  type AdminStatisticsExportQuery,
  type AdminStatisticsQuery,
  type AdminStatisticsWindowQuery,
} from "../admin-schemas.js";

/** The window every statistics route is given; an empty or reversed range is refused. */
function readWindow(query: { readonly from: string; readonly to: string }): {
  readonly from: string;
  readonly to: string;
} {
  if (query.from >= query.to) {
    throw Object.assign(new Error("Invalid time range"), {
      statusCode: 400,
      code: "bad_request",
    });
  }
  return { from: query.from, to: query.to };
}

export function registerStatisticsRoutes(
  server: FastifyInstance,
  usageStatisticsService: UsageStatisticsService,
): void {
  server.get<{ Querystring: AdminStatisticsQuery }>(
    "/api/usage-statistics/overview",
    {
      schema: {
        querystring: STATISTICS_QUERY_SCHEMA,
        response: adminResponseSchemas(STATISTICS_OVERVIEW_RESPONSE_SCHEMA),
      },
    },
    (request) => {
      const window = readWindow(request.query);
      return usageStatisticsService.overview(
        window.from,
        window.to,
        request.query.metric ?? "token",
      );
    },
  );
  server.get<{ Querystring: AdminStatisticsQuery }>(
    "/api/usage-statistics/trend",
    {
      schema: {
        querystring: STATISTICS_QUERY_SCHEMA,
        response: adminResponseSchemas(STATISTICS_TREND_RESPONSE_SCHEMA),
      },
    },
    (request) => {
      const window = readWindow(request.query);
      return usageStatisticsService.trend(
        window.from,
        window.to,
        request.query.targetId,
        request.query.model,
        request.query.granularity ?? "day",
        request.query.timezoneOffset ?? 0,
        request.query.breakdown ?? "total",
      );
    },
  );
  server.get<{ Querystring: AdminStatisticsWindowQuery }>(
    "/api/usage-statistics/options",
    {
      schema: {
        querystring: STATISTICS_WINDOW_QUERY_SCHEMA,
        response: adminResponseSchemas(STATISTICS_OPTIONS_RESPONSE_SCHEMA),
      },
    },
    (request) => {
      const window = readWindow(request.query);
      const rows = usageStatisticsService.repositoryRows(window.from, window.to);
      const targets = new Map<string, string>();
      const models = new Set<string>();
      const wantedTarget = request.query.targetId;
      for (const row of rows) {
        const id = recordText(row, "unknown", "target_id", "target_url");
        targets.set(id, recordText(row, id, "target_name", "target_url"));
        if (wantedTarget && wantedTarget !== id) continue;
        const model = recordText(row, "", "billing_model");
        if (model) models.add(model);
      }
      return {
        targets: [...targets].map(([id, name]) => ({ id, name })),
        models: [...models].sort(),
      };
    },
  );

  server.get<{ Querystring: AdminStatisticsExportQuery }>(
    "/api/usage-statistics/export",
    {
      // The answer is a text file, not a DTO, so there is no response schema to declare.
      schema: { querystring: STATISTICS_EXPORT_QUERY_SCHEMA },
    },
    (request, reply) => {
      const window = readWindow(request.query);
      const trend = usageStatisticsService.trend(
        window.from,
        window.to,
        request.query.targetId,
        request.query.model,
        request.query.granularity ?? "day",
        request.query.timezoneOffset ?? 0,
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
