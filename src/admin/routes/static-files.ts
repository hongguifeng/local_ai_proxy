import type { FastifyInstance } from "fastify";
import type { AdminStaticAssets } from "../admin-contracts.js";

export function registerStaticRoutes(
  server: FastifyInstance,
  staticAssets: AdminStaticAssets | (() => Promise<AdminStaticAssets>),
): void {
  const resolveStaticAssets = async (): Promise<AdminStaticAssets | undefined> => {
    const assets = staticAssets;
    return typeof assets === "function" ? assets() : assets;
  };
  server.get("/", async (_request, reply) =>
    reply
      .header("cache-control", "no-store")
      .type("text/html; charset=utf-8")
      .send((await resolveStaticAssets())?.indexHtml),
  );
  server.get("/static/app.css", async (_request, reply) =>
    reply
      .header("cache-control", "no-cache")
      .type("text/css; charset=utf-8")
      .send((await resolveStaticAssets())?.appCss),
  );
  server.get("/static/app.js", async (_request, reply) =>
    reply
      .header("cache-control", "no-cache")
      .type("application/javascript; charset=utf-8")
      .send((await resolveStaticAssets())?.appJs),
  );
}
