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
  readonly staticAssets?: AdminStaticAssets;
}

export interface AdminStaticAssets {
  readonly appCss: string;
  readonly appJs: string;
  readonly indexHtml: string;
}

export interface AdminErrorDto {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
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
  server.setErrorHandler((error, _request, reply) => {
    const statusCode = errorProperty(error, "statusCode", "number") ?? 500;
    const publicError = statusCode < 500;
    return reply
      .code(statusCode)
      .send(
        adminError(
          errorProperty(error, "code", "string") ??
            (publicError ? "bad_request" : "internal_error"),
          publicError
            ? (errorProperty(error, "message", "string") ?? "Request failed.")
            : "Internal server error.",
        ),
      );
  });
  server.setNotFoundHandler((_request, reply) =>
    reply.code(404).send(adminError("not_found", "Route not found.")),
  );
  server.get("/api/health", async (_request, reply) => {
    const health = options.getHealth();
    return reply.code(health.status === "degraded" ? 503 : 200).send(health);
  });
  if (options.staticAssets !== undefined) {
    server.get("/", async (_request, reply) =>
      reply
        .header("cache-control", "no-store")
        .type("text/html; charset=utf-8")
        .send(options.staticAssets?.indexHtml),
    );
    server.get("/app.css", async (_request, reply) =>
      reply
        .header("cache-control", "no-cache")
        .type("text/css; charset=utf-8")
        .send(options.staticAssets?.appCss),
    );
    server.get("/app.js", async (_request, reply) =>
      reply
        .header("cache-control", "no-cache")
        .type("application/javascript; charset=utf-8")
        .send(options.staticAssets?.appJs),
    );
  }
  return server;
}

export function adminError(code: string, message: string): AdminErrorDto {
  return { error: { code, message } };
}

function errorProperty<T extends "number" | "string">(
  error: unknown,
  property: string,
  expectedType: T,
): T extends "number" ? number | undefined : string | undefined {
  const value =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)[property]
      : undefined;
  return (typeof value === expectedType ? value : undefined) as T extends "number"
    ? number | undefined
    : string | undefined;
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
