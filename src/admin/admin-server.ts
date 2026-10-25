import Fastify, { LogController, type FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { ConfigValidationError } from "../config/index.js";
import { StructuredLogger } from "../shared/index.js";
import { HEALTH_SNAPSHOT_SCHEMA } from "./admin-schemas.js";
import { adminError, adminConfigError, errorProperty } from "./admin-contracts.js";
import type { AdminServerOptions, PartialAdminServerOptions } from "./admin-contracts.js";
import { registerStatisticsRoutes } from "./routes/statistics.js";
import { registerSummaryModelRoutes } from "./routes/settings.js";
import { registerTargetRoutes } from "./routes/targets.js";
import { registerLoadBalancerRoutes } from "./routes/load-balancer.js";
import { registerModelCatalogRoutes } from "./routes/model-catalog.js";
import { registerLogRoutes } from "./routes/logs.js";
import { registerPairRoutes } from "./routes/pairs.js";
import { registerStaticRoutes } from "./routes/static-files.js";

export interface AdminControlPlaneOptions extends AdminServerOptions {
  readonly host: string;
  readonly port: number;
}

export interface AdminControlPlaneAddress {
  readonly host: string;
  readonly port: number;
}

/**
 * The admin server the application runs. Its options extend the complete service set, so this
 * is the entry a production assembly cannot satisfy with a hole: `AdminServerOptions` is where
 * the completeness is stated, and `src/app/admin-services.ts` is where it is enforced at startup.
 */
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

/**
 * Builds the admin server. It is handed the explicit partial assembly
 * (`PartialAdminServerOptions`), so a stub that wires one route family compiles, and a complete
 * set is assignable to it as well. The production entry is `AdminControlPlane`, whose options
 * extend the complete `AdminServerOptions`: an assembly that leaves a service out does not
 * compile, and a hole that survives typing is refused at startup by the assembly check.
 *
 * A route is registered only when the service that answers it is present, so on a partial
 * server a route the stub left out answers `404 { code: "not_found", message: "Route not
 * found." }` — the answer of the not-found handler, distinct from the `log_record_not_found`
 * and `log_group_not_found` codes a wired route gives a record or group that does not exist.
 */
export function createAdminServer(options: PartialAdminServerOptions): FastifyInstance {
  const requestLogger = options.logger ?? new StructuredLogger({ service: "llm-proxy-admin" });
  const requestStarted = new WeakMap<object, number>();
  const server = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    logger: false,
    // Fastify's validator deletes keys a schema does not declare before the handler sees
    // them. That turns field drift into a missing key nobody notices, so it is switched off:
    // a closed payload now answers 400, while an open one keeps the keys it was given.
    ajv: { customOptions: { removeAdditional: false } },
  });
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
    const code =
      errorProperty(error, "code", "string") ?? (publicError ? "bad_request" : "internal_error");
    const message = publicError
      ? (errorProperty(error, "message", "string") ?? "Request failed.")
      : "Internal server error.";
    // A rejected configuration names the fields it rejected, and the console shows them. A
    // response schema attached to this status would delete that list, so errors carry no
    // schema; see docs/refactoring/admin-api-contract.md.
    const issues = error instanceof ConfigValidationError ? error.issues : undefined;
    return reply
      .code(statusCode)
      .send(
        issues === undefined ? adminError(code, message) : adminConfigError(code, message, issues),
      );
  });
  server.setNotFoundHandler((_request, reply) =>
    reply.code(404).send(adminError("not_found", "Route not found.")),
  );
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

  // The registrars in ./routes own the per-service conditions.

  if (options.usageStatisticsService !== undefined) {
    registerStatisticsRoutes(server, options.usageStatisticsService);
  }
  if (options.summaryModelService !== undefined) {
    registerSummaryModelRoutes(server, options.summaryModelService);
  }
  registerTargetRoutes(server, {
    targetCheckService: options.targetCheckService,
    targetMetricsService: options.targetMetricsService,
    targetModelsService: options.targetModelsService,
  });
  if (options.loadBalancerService !== undefined) {
    registerLoadBalancerRoutes(server, options.loadBalancerService);
  }
  if (options.modelCatalogService !== undefined) {
    registerModelCatalogRoutes(server, options.modelCatalogService);
  }
  if (options.logService !== undefined) {
    registerLogRoutes(server, options.logService, requestLogger);
  }
  if (options.pairService !== undefined) {
    registerPairRoutes(server, options.pairService);
  }
  if (options.staticAssets !== undefined) {
    registerStaticRoutes(server, options.staticAssets);
  }

  return server;
}
