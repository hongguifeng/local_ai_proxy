import type { FastifyInstance } from "fastify";
import {
  adminResponseSchemas,
  LOAD_BALANCER_STATUS_RESPONSE_SCHEMA,
  LOAD_BALANCER_TASKS_QUERY_SCHEMA,
  LOAD_BALANCER_TASKS_RESPONSE_SCHEMA,
  type AdminLoadBalancerTasksQuery,
} from "../admin-schemas.js";
import { adminError } from "../admin-contracts.js";
import type { LoadBalancerAdminService } from "../admin-contracts.js";

/** The two 404 causes the binding list can hit, each with the sentence the console shows. */
const BINDING_LIST_NOT_FOUND_MESSAGES: Readonly<
  Record<"pair_not_found" | "group_not_found", string>
> = {
  group_not_found: "Load balancer group not found.",
  pair_not_found: "Proxy pair not found.",
};

export function registerLoadBalancerRoutes(
  server: FastifyInstance,
  loadBalancerService: LoadBalancerAdminService,
): void {
  server.get(
    "/api/load-balancer/status",
    {
      schema: {
        response: adminResponseSchemas(LOAD_BALANCER_STATUS_RESPONSE_SCHEMA),
      },
    },
    () => loadBalancerService.getStatus(),
  );

  server.get<{ Querystring: AdminLoadBalancerTasksQuery }>(
    "/api/load-balancer/tasks",
    {
      schema: {
        querystring: LOAD_BALANCER_TASKS_QUERY_SCHEMA,
        response: adminResponseSchemas(LOAD_BALANCER_TASKS_RESPONSE_SCHEMA),
      },
    },
    (request, reply) => {
      const answer = loadBalancerService.getBindings({
        groupId: request.query.groupId,
        limit: request.query.limit ?? 50,
        offset: request.query.offset ?? 0,
        pairId: request.query.pairId,
        targetId: request.query.targetId,
      });
      if ("error" in answer) {
        return reply
          .code(404)
          .send(adminError(answer.error, BINDING_LIST_NOT_FOUND_MESSAGES[answer.error]));
      }
      return answer.response;
    },
  );
}
