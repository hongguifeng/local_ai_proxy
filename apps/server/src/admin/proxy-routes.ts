import { ProxyEnabledRequestSchema } from "@llm-proxy/contracts";
import type { FastifyInstance } from "fastify";

import type { AdminProxyService } from "./proxy-service.js";

export function registerProxyRoutes(app: FastifyInstance, service: AdminProxyService): void {
  app.get("/api/v1/proxies", () => service.list());
  app.put("/api/v1/proxies", async (request) => service.replace(request.body));
  app.post<{ Params: { id: string } }>("/api/v1/proxies/:id/enabled", async (request) => {
    const body = ProxyEnabledRequestSchema.parse(request.body);
    return service.setEnabled(request.params.id, body.enabled);
  });
}
