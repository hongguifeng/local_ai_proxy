import Fastify, { LogController, type FastifyInstance } from "fastify";

import type { ApplicationState } from "../app/index.js";

export type HealthStatus = "degraded" | "ok" | "starting" | "stopping";

export interface HealthSnapshot {
  readonly applicationState: ApplicationState;
  readonly status: HealthStatus;
  readonly version: string;
}

export interface AdminServerOptions {
  readonly getHealth: () => HealthSnapshot;
}

export function createAdminServer(options: AdminServerOptions): FastifyInstance {
  const server = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    logger: false,
  });
  server.get("/api/health", async (_request, reply) => {
    const health = options.getHealth();
    return reply.code(health.status === "degraded" ? 503 : 200).send(health);
  });
  return server;
}

export function applicationHealth(
  applicationState: ApplicationState,
  version = "development",
): HealthSnapshot {
  const status: HealthStatus =
    applicationState === "running"
      ? "ok"
      : applicationState === "created" || applicationState === "starting"
        ? "starting"
        : "stopping";
  return { applicationState, status, version };
}
