import Fastify, { LogController, type FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";

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
