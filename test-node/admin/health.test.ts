import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";

import {
  AdminControlPlane,
  applicationHealth,
  createAdminServer,
  type HealthSnapshot,
} from "../../src/admin/admin-server.js";

const servers: ReturnType<typeof createAdminServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe("admin health route", () => {
  it("returns an OK snapshot for a running application", async () => {
    const server = createAdminServer({
      getHealth: () => applicationHealth("running", "0.1.0-test"),
    });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      applicationState: "running",
      status: "ok",
      version: "0.1.0-test",
    });
  });

  it("returns 503 when a provider reports degraded health", async () => {
    const degraded: HealthSnapshot = {
      applicationState: "running",
      status: "degraded",
      version: "0.1.0-test",
    };
    const server = createAdminServer({ getHealth: () => degraded });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(degraded);
  });

  it("starts and stops a Fastify control plane on TCP", async () => {
    const controlPlane = new AdminControlPlane({
      host: "127.0.0.1",
      port: 0,
      getHealth: () => applicationHealth("running", "0.1.0-network"),
    });
    const address = await controlPlane.start();

    try {
      await expect(requestJson(address.port, "/api/health")).resolves.toEqual({
        statusCode: 200,
        body: {
          applicationState: "running",
          status: "ok",
          version: "0.1.0-network",
        },
      });
    } finally {
      await controlPlane.close();
    }
    await expect(requestJson(address.port, "/api/health")).rejects.toBeDefined();
  });
});

function requestJson(
  port: number,
  requestPath: string,
): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: requestPath }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        });
      });
    });
    request.once("error", reject);
  });
}
