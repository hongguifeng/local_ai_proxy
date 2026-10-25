import type { FastifyInstance } from "fastify";
import { LOAD_BALANCER_STATUS_RESPONSE_SCHEMA } from "../admin-schemas.js";
import type { LoadBalancerAdminService } from "../admin-contracts.js";

export function registerLoadBalancerRoutes(
  server: FastifyInstance,
  loadBalancerService: LoadBalancerAdminService,
): void {
  server.get(
    "/api/load-balancer/status",
    {
      schema: {
        response: { 200: LOAD_BALANCER_STATUS_RESPONSE_SCHEMA },
      },
    },
    () => loadBalancerService.getStatus(),
  );
}
