import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";

import type { RuntimeHealthSnapshot } from "../runtime/recovery.js";
import type { InternalMetricsSnapshot } from "../observability.js";

export interface AdminAppDependencies {
  health(): RuntimeHealthSnapshot;
  metrics?: () => InternalMetricsSnapshot;
  registerRoutes?: (app: FastifyInstance) => void | Promise<void>;
}

export interface AdminAppOptions {
  bodyLimit?: number;
  requestTimeoutMs?: number;
  generateRequestId?: () => string;
}

export function createAdminApp(dependencies: AdminAppDependencies, options: AdminAppOptions = {}): FastifyInstance {
  const bodyLimit = options.bodyLimit ?? 1024 * 1024;
  const requestTimeout = options.requestTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 1) throw new RangeError("Invalid admin body limit");
  if (!Number.isSafeInteger(requestTimeout) || requestTimeout < 1) throw new RangeError("Invalid admin timeout");
  const app = Fastify({
    bodyLimit,
    requestTimeout,
    genReqId: () => options.generateRequestId?.() ?? randomUUID(),
    logger: false,
  });

  app.get(
    "/api/v1/health",
    {
      schema: {
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["status", "storage", "storageRestartAttempts", "proxies"],
            properties: {
              live: { type: "boolean" },
              ready: { type: "boolean" },
              degraded: { type: "boolean" },
              status: { enum: ["ok", "degraded", "failed"] },
              storage: { enum: ["ok", "degraded", "failed"] },
              storageRestartAttempts: { type: "integer", minimum: 0 },
              proxies: {
                type: "object",
                additionalProperties: false,
                required: ["configured", "running", "failed"],
                properties: {
                  configured: { type: "integer", minimum: 0 },
                  running: { type: "integer", minimum: 0 },
                  failed: { type: "integer", minimum: 0 },
                },
              },
            },
          },
        },
      },
    },
    () => dependencies.health(),
  );
  if (dependencies.metrics) app.get("/api/v1/metrics", () => dependencies.metrics?.());

  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
    app.route({
      method,
      url: "/api/v1/health",
      handler: (request, reply) =>
        reply
          .status(405)
          .send({ error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" }, requestId: request.id }),
    });
  }

  app.addHook("preValidation", (request, _reply, done) => {
    const mutating = request.method === "POST" || request.method === "PUT" || request.method === "PATCH";
    if (mutating && request.routeOptions.url !== "/api/v1/health") {
      const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json") {
        done(
          Object.assign(new Error("Content-Type must be application/json"), {
            statusCode: 415,
            code: "UNSUPPORTED_MEDIA_TYPE",
          }),
        );
        return;
      }
    }
    done();
  });

  app.addHook("onSend", (request, reply, payload, done) => {
    const api = request.url.startsWith("/api/");
    if (api) void reply.header("cache-control", "no-store");
    void reply
      .header("x-content-type-options", "nosniff")
      .header("x-frame-options", "DENY")
      .header(
        "content-security-policy",
        api
          ? "default-src 'none'; frame-ancestors 'none'"
          : "default-src 'self'; connect-src 'self'; frame-ancestors 'none'",
      )
      .header("referrer-policy", "no-referrer");
    done(null, payload);
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode = errorStatus(error);
    const code = publicErrorCode(error, statusCode);
    const details = validationDetails(error);
    void reply.status(statusCode).send({
      error: { code, message: statusCode >= 500 ? "Request failed" : errorMessage(error) },
      ...(details ? { details } : {}),
      requestId: request.id,
    });
  });
  app.setNotFoundHandler((request, reply) => {
    void reply
      .status(404)
      .send({ error: { code: "NOT_FOUND", message: "Route does not exist" }, requestId: request.id });
  });
  if (dependencies.registerRoutes) void app.register(async (scope) => dependencies.registerRoutes?.(scope));
  return app;
}

export const DEFAULT_ADMIN_HOST = "127.0.0.1";

function errorStatus(error: unknown): number {
  if (error && typeof error === "object" && "name" in error && error.name === "ZodError") return 400;
  if (error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number")
    return error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500;
  return 500;
}

function errorMessage(error: unknown): string {
  if (isZodError(error)) return "Request validation failed";
  return error instanceof Error ? error.message : "Invalid request";
}

function publicErrorCode(error: unknown, statusCode: number): string {
  if (statusCode === 400 || statusCode === 413) return "INVALID_REQUEST";
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string")
    return error.code.slice(0, 80);
  return "ADMIN_REQUEST_FAILED";
}

function validationDetails(error: unknown): { path?: (string | number)[]; message: string }[] | undefined {
  if (!isZodError(error)) return undefined;
  return error.issues.slice(0, 100).map((issue) => ({
    path: issue.path.filter(
      (value): value is string | number => typeof value === "string" || typeof value === "number",
    ),
    message: "Invalid value",
  }));
}

function isZodError(error: unknown): error is {
  name: "ZodError";
  issues: readonly { path: readonly unknown[] }[];
} {
  return Boolean(
    error &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "ZodError" &&
    "issues" in error &&
    Array.isArray(error.issues),
  );
}
