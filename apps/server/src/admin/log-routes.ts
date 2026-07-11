import type { FastifyInstance } from "fastify";

import type { AdminLogService } from "./log-service.js";

interface PageQuery {
  query?: string;
  limit?: string;
  offset?: string;
  logRoot?: string;
}

export function registerLogRoutes(app: FastifyInstance, service: AdminLogService): void {
  app.get<{ Querystring: PageQuery }>("/api/v1/tasks", async (request) => {
    const page = pagination(request.query);
    return service.listTasks(request.query.query ?? "", page.limit, page.offset);
  });
  app.get<{ Params: { id: string }; Querystring: PageQuery }>("/api/v1/tasks/:id/records", async (request) => {
    const page = pagination(request.query);
    return service.listRecords(
      requiredRoot(request.query),
      request.params.id,
      request.query.query ?? "",
      page.limit,
      page.offset,
    );
  });
  app.get<{ Params: { id: string }; Querystring: { logRoot?: string } }>(
    "/api/v1/records/:id",
    async (request, reply) => {
      const record = await service.getRecord(requiredRoot(request.query), request.params.id);
      if (!record)
        return reply
          .status(404)
          .send({ error: { code: "RECORD_NOT_FOUND", message: "Record does not exist" }, requestId: request.id });
      return record;
    },
  );
  app.post("/api/v1/tasks/cleanup", async (request) => service.cleanup(cleanupBody(request.body)));
  app.get<{ Querystring: { logRoot?: string; query?: string } }>("/api/v1/tasks/export", async (request, reply) => {
    const controller = new AbortController();
    request.raw.once("close", () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    const stream = service.export(requiredRoot(request.query), request.query.query ?? "", controller.signal);
    return reply
      .type("application/zip")
      .header("content-disposition", 'attachment; filename="llm-proxy-traffic.zip"')
      .send(stream);
  });
}

function pagination(query: PageQuery): { limit: number; offset: number } {
  return { limit: integer(query.limit, 50, 1, 200), offset: integer(query.offset, 0, 0, 10_000_000) };
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw invalidRequest("Invalid pagination");
  return parsed;
}

function requiredRoot(query: { logRoot?: string }): string {
  if (!query.logRoot || query.logRoot.length > 32_768) throw invalidRequest("logRoot is required");
  return query.logRoot;
}

function cleanupBody(value: unknown) {
  if (!value || typeof value !== "object" || !("logRoots" in value) || !Array.isArray(value.logRoots))
    throw invalidRequest("logRoots is required");
  const logRoots = value.logRoots.filter((root): root is string => typeof root === "string" && root.length <= 32_768);
  if (logRoots.length !== value.logRoots.length || logRoots.length === 0) throw invalidRequest("Invalid logRoots");
  const taskIds = readStringArray(value, "taskIds");
  const olderThanDays = readNumber(value, "olderThanDays");
  const keepLatest = readNumber(value, "keepLatest");
  const batchSize = readNumber(value, "batchSize");
  return {
    logRoots,
    ...(taskIds ? { taskIds } : {}),
    ...(olderThanDays === undefined ? {} : { olderThanDays }),
    ...(keepLatest === undefined ? {} : { keepLatest }),
    ...(batchSize === undefined ? {} : { batchSize }),
  };
}

function readStringArray(value: object, key: string): string[] | undefined {
  if (!(key in value)) return undefined;
  const item = (value as Record<string, unknown>)[key];
  if (!Array.isArray(item) || !item.every((entry) => typeof entry === "string")) throw invalidRequest(`Invalid ${key}`);
  return item;
}

function readNumber(value: object, key: string): number | undefined {
  if (!(key in value)) return undefined;
  const item = (value as Record<string, unknown>)[key];
  if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) throw invalidRequest(`Invalid ${key}`);
  return item;
}

function invalidRequest(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 });
}
