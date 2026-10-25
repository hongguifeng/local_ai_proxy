import type { FastifyInstance } from "fastify";
import {
  LOG_GROUP_COST_SERIES_SCHEMA,
  LOG_GROUP_LOGS_SCHEMA,
  LOG_GROUP_OUTPUT_TOKEN_SERIES_SCHEMA,
  LOG_GROUP_PAGE_SCHEMA,
  LOG_GROUP_TOKEN_SERIES_SCHEMA,
  LOG_RECORDS_SCHEMA,
  LOG_RECORD_DETAIL_SCHEMA,
} from "../admin-schemas.js";
import { adminError } from "../admin-contracts.js";
import type { LogAdminService } from "../admin-contracts.js";

export function registerLogRoutes(server: FastifyInstance, logService: LogAdminService): void {
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
  const getGroupCostSeries = logService.getGroupCostSeries?.bind(logService);
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
  const getGroupTokenSeries = logService.getGroupTokenSeries?.bind(logService);
  if (getGroupTokenSeries !== undefined) {
    server.get<{ Params: { id: string } }>(
      "/api/log-groups/:id/pricing/tokens",
      {
        schema: {
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string", minLength: 1 } },
          },
          response: { 200: LOG_GROUP_TOKEN_SERIES_SCHEMA },
        },
      },
      (request, reply) =>
        getGroupTokenSeries(request.params.id) ??
        reply.code(404).send(adminError("log_group_not_found", "Log group not found.")),
    );
  }
  if (getGroupCostSeries !== undefined) {
    server.get<{ Params: { id: string } }>(
      "/api/log-groups/:id/pricing/costs",
      {
        schema: {
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string", minLength: 1 } },
          },
          response: { 200: LOG_GROUP_COST_SERIES_SCHEMA },
        },
      },
      (request, reply) =>
        getGroupCostSeries(request.params.id) ??
        reply.code(404).send(adminError("log_group_not_found", "Log group not found.")),
    );
  }
  const getGroupOutputTokenSeries = logService.getGroupOutputTokenSeries?.bind(logService);
  if (getGroupOutputTokenSeries !== undefined) {
    server.get<{ Params: { id: string } }>(
      "/api/log-groups/:id/pricing/output-tokens",
      {
        schema: {
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string", minLength: 1 } },
          },
          response: { 200: LOG_GROUP_OUTPUT_TOKEN_SERIES_SCHEMA },
        },
      },
      (request, reply) =>
        getGroupOutputTokenSeries(request.params.id) ??
        reply.code(404).send(adminError("log_group_not_found", "Log group not found.")),
    );
  }
  const getTaskBrief = logService.getTaskBrief?.bind(logService);
  const generateTaskBrief = logService.generateTaskBrief?.bind(logService);
  if (generateTaskBrief !== undefined) {
    if (getTaskBrief !== undefined)
      server.get<{ Params: { id: string } }>(
        "/api/log-groups/:id/brief",
        (request) => getTaskBrief(request.params.id) ?? null,
      );
    server.post<{ Params: { id: string } }>("/api/log-groups/:id/brief", async (request, reply) => {
      try {
        return await generateTaskBrief(request.params.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Task brief failed.";
        if (message.includes("Log group not found.")) {
          return reply.code(404).send(adminError("log_group_not_found", "Log group not found."));
        }
        return reply
          .code(message.includes("already in progress") ? 409 : 502)
          .send(
            adminError(
              message.includes("already in progress")
                ? "task_brief_in_progress"
                : "task_brief_failed",
              message,
            ),
          );
      }
    });
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
  const listRecordsByIds = logService.listRecordsByIds?.bind(logService);
  if (listRecordsByIds !== undefined) {
    server.get<{ Querystring: { ids?: string } }>(
      "/api/logs/records",
      {
        schema: {
          querystring: {
            type: "object",
            required: ["ids"],
            properties: {
              ids: { type: "string", minLength: 1, maxLength: 16_384 },
            },
          },
          response: { 200: LOG_RECORDS_SCHEMA },
        },
      },
      (request, reply) => {
        // Comma-separated ids: a repeated query key parses as an array only
        // when it appears more than once, which would make a single-id
        // request fail validation.
        const ids = [
          ...new Set(
            (request.query.ids ?? "")
              .split(",")
              .map((value) => value.trim())
              .filter((value) => value !== ""),
          ),
        ].slice(0, 200);
        if (ids.length === 0) {
          return reply
            .code(400)
            .send(adminError("invalid_request", "At least one record id is required."));
        }
        return listRecordsByIds(ids) ?? { records: [] };
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
        return result ?? reply.code(404).send(adminError("record_not_found", "Record not found."));
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
