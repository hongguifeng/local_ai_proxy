import type { FastifyInstance } from "fastify";
import { ApplicationError, StructuredLogger } from "../../shared/index.js";
import {
  adminResponseSchemas,
  GROUP_LOG_QUERY_SCHEMA,
  HISTORY_SUMMARY_RESPONSE_SCHEMA,
  HISTORY_SUMMARY_SCHEMA,
  LOG_CLEANUP_REQUEST_SCHEMA,
  LOG_CLEANUP_RESPONSE_SCHEMA,
  LOG_GROUP_COST_SERIES_SCHEMA,
  LOG_GROUP_LOGS_SCHEMA,
  LOG_GROUP_OUTPUT_TOKEN_SERIES_SCHEMA,
  LOG_GROUP_PAGE_SCHEMA,
  LOG_GROUP_PRICING_SCHEMA,
  LOG_GROUP_QUERY_SCHEMA,
  LOG_GROUP_TOKEN_SERIES_SCHEMA,
  LOG_RECORD_DETAIL_SCHEMA,
  LOG_RECORDS_SCHEMA,
  PATH_ID_PARAMS_SCHEMA,
  RECORD_IDS_QUERY_SCHEMA,
  TASK_BRIEF_RESPONSE_SCHEMA,
  TASK_BRIEF_SCHEMA,
  type AdminCleanupRequestBody,
  type AdminGroupLogQuery,
  type AdminLogGroupQuery,
  type AdminPathParams,
  type AdminRecordIdsQuery,
} from "../admin-schemas.js";
import { adminError } from "../admin-contracts.js";
import type { AdminErrorDto, AdminRequestLogger, LogAdminService } from "../admin-contracts.js";

export function registerLogRoutes(
  server: FastifyInstance,
  logService: LogAdminService,
  logger: AdminRequestLogger = new StructuredLogger({ service: "llm-proxy-admin" }),
): void {
  const cleanupSelectedGroups = logService.cleanupSelectedGroups?.bind(logService);
  const cleanupOlderThan = logService.cleanupOlderThan?.bind(logService);
  const cleanupKeepLatest = logService.cleanupKeepLatest?.bind(logService);
  if (
    cleanupSelectedGroups !== undefined ||
    cleanupOlderThan !== undefined ||
    cleanupKeepLatest !== undefined
  ) {
    server.post<{ Body: AdminCleanupRequestBody }>(
      "/api/logs/cleanup",
      {
        schema: {
          body: LOG_CLEANUP_REQUEST_SCHEMA,
          response: adminResponseSchemas(LOG_CLEANUP_RESPONSE_SCHEMA),
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
    // A ZIP stream has no JSON body to declare a response schema for.
    server.get("/api/logs/export", (_request, reply) =>
      reply
        .header("content-disposition", 'attachment; filename="llm-proxy-logs.zip"')
        .type("application/zip")
        .send(exportLogs()),
    );
  }
  server.get<{ Querystring: AdminLogGroupQuery }>(
    "/api/logs",
    {
      schema: {
        querystring: LOG_GROUP_QUERY_SCHEMA,
        response: adminResponseSchemas(LOG_GROUP_PAGE_SCHEMA),
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
    server.get<{ Params: AdminPathParams }>(
      "/api/log-groups/:id/pricing",
      {
        schema: {
          params: PATH_ID_PARAMS_SCHEMA,
          response: adminResponseSchemas(LOG_GROUP_PRICING_SCHEMA),
        },
      },
      (request, reply) =>
        getGroupPricing(request.params.id) ??
        reply.code(404).send(adminError("log_group_not_found", "Log group not found.")),
    );
  }
  const getGroupTokenSeries = logService.getGroupTokenSeries?.bind(logService);
  if (getGroupTokenSeries !== undefined) {
    server.get<{ Params: AdminPathParams }>(
      "/api/log-groups/:id/pricing/tokens",
      {
        schema: {
          params: PATH_ID_PARAMS_SCHEMA,
          response: adminResponseSchemas(LOG_GROUP_TOKEN_SERIES_SCHEMA),
        },
      },
      (request, reply) =>
        getGroupTokenSeries(request.params.id) ??
        reply.code(404).send(adminError("log_group_not_found", "Log group not found.")),
    );
  }
  if (getGroupCostSeries !== undefined) {
    server.get<{ Params: AdminPathParams }>(
      "/api/log-groups/:id/pricing/costs",
      {
        schema: {
          params: PATH_ID_PARAMS_SCHEMA,
          response: adminResponseSchemas(LOG_GROUP_COST_SERIES_SCHEMA),
        },
      },
      (request, reply) =>
        getGroupCostSeries(request.params.id) ??
        reply.code(404).send(adminError("log_group_not_found", "Log group not found.")),
    );
  }
  const getGroupOutputTokenSeries = logService.getGroupOutputTokenSeries?.bind(logService);
  if (getGroupOutputTokenSeries !== undefined) {
    server.get<{ Params: AdminPathParams }>(
      "/api/log-groups/:id/pricing/output-tokens",
      {
        schema: {
          params: PATH_ID_PARAMS_SCHEMA,
          response: adminResponseSchemas(LOG_GROUP_OUTPUT_TOKEN_SERIES_SCHEMA),
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
      server.get<{ Params: AdminPathParams }>(
        "/api/log-groups/:id/brief",
        {
          schema: {
            params: PATH_ID_PARAMS_SCHEMA,
            response: adminResponseSchemas(TASK_BRIEF_RESPONSE_SCHEMA),
          },
        },
        (request) => absentAsNull(getTaskBrief(request.params.id)),
      );
    server.post<{ Params: AdminPathParams }>(
      "/api/log-groups/:id/brief",
      {
        schema: {
          params: PATH_ID_PARAMS_SCHEMA,
          response: adminResponseSchemas(TASK_BRIEF_SCHEMA),
        },
      },
      async (request, reply) => {
        try {
          return await generateTaskBrief(request.params.id);
        } catch (error) {
          if (!(error instanceof ApplicationError)) {
            // A classified error already carries what an operator needs; this is the case
            // where nothing was expected and the reason has to stay in the log.
            logger.warn("Task brief generation failed", {
              phase: "task_brief_generate",
              task_id: request.params.id,
              error_type: errorName(error),
              cause_type: errorName(causeOf(error)),
            });
          }
          const failure = operationFailure(error, {
            notFound: "log_group_not_found",
            inProgress: "task_brief_in_progress",
            failed: "task_brief_failed",
          });
          return reply.code(failure.status).send(failure.body);
        }
      },
    );
  }
  if (getGroupLogs !== undefined) {
    server.get<{ Params: AdminPathParams; Querystring: AdminGroupLogQuery }>(
      "/api/log-groups/:id/logs",
      {
        schema: {
          params: PATH_ID_PARAMS_SCHEMA,
          querystring: GROUP_LOG_QUERY_SCHEMA,
          response: adminResponseSchemas(LOG_GROUP_LOGS_SCHEMA),
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
    server.get<{ Querystring: AdminRecordIdsQuery }>(
      "/api/logs/records",
      {
        schema: {
          querystring: RECORD_IDS_QUERY_SCHEMA,
          response: adminResponseSchemas(LOG_RECORDS_SCHEMA),
        },
      },
      (request, reply) => {
        // Comma-separated ids: a repeated query key parses as an array only
        // when it appears more than once, which would make a single-id
        // request fail validation. The schema already requires `ids`, so an
        // empty list can only come from whitespace or empty separators.
        const ids = [
          ...new Set(
            request.query.ids
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
        return listRecordsByIds(ids);
      },
    );
  }
  const getRecordDetail = logService.getRecordDetail?.bind(logService);
  const summarizeRecord = logService.summarizeRecord?.bind(logService);
  const getSummary = logService.getSummary?.bind(logService);
  if (getRecordDetail !== undefined) {
    server.get<{ Params: AdminPathParams }>(
      "/api/logs/:id",
      {
        schema: {
          params: PATH_ID_PARAMS_SCHEMA,
          response: adminResponseSchemas(LOG_RECORD_DETAIL_SCHEMA),
        },
      },
      (request, reply) =>
        getRecordDetail(request.params.id) ??
        reply.code(404).send(adminError("log_record_not_found", "Log record not found.")),
    );
  }

  if (summarizeRecord !== undefined) {
    if (getSummary !== undefined)
      server.get<{ Params: AdminPathParams }>(
        "/api/logs/:id/summary",
        {
          schema: {
            params: PATH_ID_PARAMS_SCHEMA,
            response: adminResponseSchemas(HISTORY_SUMMARY_RESPONSE_SCHEMA),
          },
        },
        (request) => absentAsNull(getSummary(request.params.id)),
      );
    server.post<{ Params: AdminPathParams }>(
      "/api/logs/:id/summary",
      {
        schema: {
          params: PATH_ID_PARAMS_SCHEMA,
          response: adminResponseSchemas(HISTORY_SUMMARY_SCHEMA),
        },
      },
      async (request, reply) => {
        try {
          const result = await summarizeRecord(request.params.id);
          // The service answers undefined for a record no log root holds.
          if (result === undefined)
            return await reply.code(404).send(adminError("record_not_found", "Record not found."));
          return result;
        } catch (error) {
          if (!(error instanceof ApplicationError)) {
            logger.warn("Record summary generation failed", {
              phase: "record_summary_generate",
              record_id: request.params.id,
              error_type: errorName(error),
              cause_type: errorName(causeOf(error)),
            });
          }
          const failure = operationFailure(error, {
            notFound: "record_not_found",
            inProgress: "summary_in_progress",
            failed: "summary_failed",
          });
          return reply.code(failure.status).send(failure.body);
        }
      },
    );
  }
}

/**
 * The service-model to response boundary for a resource that may be absent: the service
 * answers `undefined`, and the console reads `null` as "nothing is stored here". Keeping it
 * in one place means an absent brief and an absent summary look the same to the browser.
 */
function absentAsNull<T>(resource: T | undefined): T | null {
  return resource ?? null;
}

/**
 * Map a classified operation error onto the status and admin code the console already
 * uses. The classification reads the error's `code`, never its message text, so rewording
 * an error cannot change an HTTP status.
 */
function operationFailure(
  error: unknown,
  codes: {
    readonly notFound: string;
    readonly inProgress: string;
    readonly failed: string;
  },
): { readonly status: number; readonly body: AdminErrorDto } {
  if (error instanceof ApplicationError) {
    switch (error.code) {
      case "not_found":
        return {
          status: 404,
          body: adminError(codes.notFound, publicMessage(error, "Not found.")),
        };
      case "conflict":
        return {
          status: 409,
          body: adminError(
            codes.inProgress,
            publicMessage(error, "Another generation is already running."),
          ),
        };
      case "upstream_error":
        return {
          status: error.statusCode,
          body: adminError(codes.failed, publicMessage(error, "The summary model request failed.")),
        };
      case "storage_error":
        return {
          status: error.statusCode,
          body: adminError("storage_failed", "The result could not be saved."),
        };
      default:
        break;
    }
  }
  return { status: 502, body: adminError(codes.failed, "The request failed.") };
}

/**
 * A message this project wrote can be shown as it stands; an unexpected error keeps its
 * details inside the process.
 */
function publicMessage(error: ApplicationError, fallback: string): string {
  return error.expose ? error.message : fallback;
}

/** The name of an error, or `UnknownError` when it is not an `Error`. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

/** The `cause` of an error when it carries one. */
function causeOf(error: unknown): unknown {
  return error instanceof Error ? error.cause : undefined;
}
