import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";

import type { RuntimeHealthSnapshot } from "../runtime/recovery.js";

export interface AdminAppDependencies {
  health(): RuntimeHealthSnapshot;
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

  app.setErrorHandler((error, request, reply) => {
    const statusCode = errorStatus(error);
    const code = publicErrorCode(error, statusCode);
    void reply.status(statusCode).send({
      error: { code, message: statusCode >= 500 ? "Request failed" : errorMessage(error) },
      requestId: request.id,
    });
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
  return error instanceof Error ? error.message : "Invalid request";
}

function publicErrorCode(error: unknown, statusCode: number): string {
  if (statusCode === 400 || statusCode === 413) return "INVALID_REQUEST";
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string")
    return error.code.slice(0, 80);
  return "ADMIN_REQUEST_FAILED";
}
