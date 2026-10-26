import type { FastifyInstance } from "fastify";
import {
  adminAcceptedResponseSchemas,
  adminResponseSchemas,
  LOAD_BALANCER_STATUS_RESPONSE_SCHEMA,
  LOAD_BALANCER_TASKS_QUERY_SCHEMA,
  LOAD_BALANCER_TASKS_RESPONSE_SCHEMA,
  LOAD_BALANCER_TASK_MOVE_OPERATION_PARAMS_SCHEMA,
  LOAD_BALANCER_TASK_MOVE_REQUEST_SCHEMA,
  LOAD_BALANCER_TASK_MOVE_RESPONSE_SCHEMA,
  type AdminLoadBalancerTasksQuery,
  type AdminTaskMoveRequest,
} from "../admin-schemas.js";
import { adminError } from "../admin-contracts.js";
import type {
  LoadBalancerAdminService,
  LoadBalancerCancelMoveRejectionCode,
  LoadBalancerTaskMoveRejectionCode,
} from "../admin-contracts.js";

/** The two 404 causes the binding list can hit, each with the sentence the console shows. */
const BINDING_LIST_NOT_FOUND_MESSAGES: Readonly<
  Record<"pair_not_found" | "group_not_found", string>
> = {
  group_not_found: "Load balancer group not found.",
  pair_not_found: "Proxy pair not found.",
};

/**
 * Every way a move can be refused, and the answer it becomes. The design fixes the code names
 * and the statuses: a version the caller no longer has is a conflict, a destination that cannot
 * take the task is a conflict, a server-side state that cannot be proven portable is refused as
 * unprocessable, a full migration store is unavailable rather than a bad parameter, and a pair,
 * group, runtime or binding that does not exist is not found - one code, with the reason the
 * service gave for each of the four causes so they stay readable apart.
 *
 * `message` is the sentence used when the service had none of its own to give. Where it did give
 * one - every balancer refusal, and every cause this service found before the call - that sentence
 * wins, because it names the revision, the target or the event the answer is about.
 */
const TASK_MOVE_REJECTIONS: Readonly<
  Record<
    LoadBalancerTaskMoveRejectionCode,
    { readonly status: number; readonly code: string; readonly message: string }
  >
> = {
  binding_not_found: {
    status: 404,
    code: "binding_not_found",
    message: "No binding in this runtime matches that address.",
  },
  group_not_found: {
    status: 404,
    code: "binding_not_found",
    message: BINDING_LIST_NOT_FOUND_MESSAGES.group_not_found,
  },
  pair_not_found: {
    status: 404,
    code: "binding_not_found",
    message: BINDING_LIST_NOT_FOUND_MESSAGES.pair_not_found,
  },
  runtime_epoch_mismatch: {
    status: 404,
    code: "binding_not_found",
    message: "The runtime epoch in the request is not the one this pair is running now.",
  },
  runtime_not_running: {
    status: 404,
    code: "binding_not_found",
    message: "This pair is not running, so no runtime holds a binding to move.",
  },
  stale_group_revision: {
    status: 409,
    code: "binding_stale",
    message: "The group moved on since this request was written.",
  },
  stale_routing_revision: {
    status: 409,
    code: "binding_stale",
    message: "The binding moved on since this request was written.",
  },
  source_target_mismatch: {
    status: 409,
    code: "binding_stale",
    message: "The binding is no longer on the node this request was written against.",
  },
  target_unknown: {
    status: 409,
    code: "target_not_eligible",
    message: "That destination is no longer a target of this pair.",
  },
  target_not_in_group: {
    status: 409,
    code: "target_not_eligible",
    message: "That destination is not a member of this group.",
  },
  target_disabled: {
    status: 409,
    code: "target_not_eligible",
    message: "That destination is disabled.",
  },
  target_cooldown: {
    status: 409,
    code: "target_not_eligible",
    message: "That destination is still cooling down.",
  },
  target_asleep: {
    status: 409,
    code: "target_not_eligible",
    message: "That destination reported it is asleep.",
  },
  same_physical_key: {
    status: 409,
    code: "target_not_eligible",
    message: "That destination is another spelling of the engine the binding is already on.",
  },
  model_mismatch: {
    status: 409,
    code: "target_not_eligible",
    message: "That destination forwards a different model name.",
  },
  response_state_dependency: {
    status: 422,
    code: "state_not_migratable",
    message: "This task is addressed through a response id that cannot be proven portable.",
  },
  state_unknown: {
    status: 422,
    code: "state_not_migratable",
    message: "This runtime cannot prove the destination can reach the state this task may use.",
  },
  idempotency_conflict: {
    status: 409,
    code: "idempotency_conflict",
    message: "That idempotency key was already used for a different move in this runtime.",
  },
  migration_backlog_full: {
    status: 503,
    code: "migration_backlog_full",
    message: "This runtime is holding as many migration records as it is allowed to.",
  },
};

/** Every way a cancel can be refused, and the answer it becomes. */
const CANCEL_REJECTIONS: Readonly<
  Record<
    LoadBalancerCancelMoveRejectionCode,
    { readonly status: number; readonly code: string; readonly message: string }
  >
> = {
  operation_not_found: {
    status: 404,
    code: "operation_not_found",
    message: "No migration record in this runtime carries that id.",
  },
  operation_already_applied: {
    status: 409,
    code: "operation_already_applied",
    message: "The route already moved; a cancel cannot undo it. Submit a move back instead.",
  },
  operation_expired: {
    status: 409,
    code: "operation_expired",
    message: "That intent was called off before its request boundary.",
  },
  operation_not_cancellable: {
    status: 409,
    code: "operation_not_cancellable",
    message: "That operation cannot be cancelled.",
  },
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

  /**
   * [TRI-08] Register one binding to move. `applied` and `already_there` answer 200 because the
   * route is settled - the first changed it, the second needed no change - and `pending_boundary`
   * answers 202 because nothing has been written yet: the intent waits for the next request
   * boundary. A same-key retry of a submit that already answered is returned the first answer,
   * which is what makes a network retry unable to move the route twice.
   */
  server.post<{ Body: AdminTaskMoveRequest }>(
    "/api/load-balancer/task-moves",
    {
      schema: {
        body: LOAD_BALANCER_TASK_MOVE_REQUEST_SCHEMA,
        response: adminAcceptedResponseSchemas(LOAD_BALANCER_TASK_MOVE_RESPONSE_SCHEMA),
      },
    },
    (request, reply) => {
      // `reason` is declared optional on the wire and required-with-explicit-undefined in the
      // service contract, so the key is written out here rather than left to the body's shape.
      const answer = loadBalancerService.moveBinding({
        ...request.body,
        reason: request.body.reason,
      });
      if ("rejection" in answer) {
        const rejection = answer.rejection;
        const outcome = TASK_MOVE_REJECTIONS[rejection.code];
        return reply
          .code(outcome.status)
          .send(adminError(outcome.code, rejection.detail ?? outcome.message));
      }
      const response = answer.response;
      // The state carried by the answer is what fixes the status: `pending_boundary` means
      // nothing was written and the intent waits for a request boundary, so the answer is 202.
      // `applied` and `already_there` settle the route and answer 200, and a same-key retry is
      // answered the state the record reached - never a second write.
      if (response.state === "pending_boundary") {
        return reply.code(202).send(response);
      }
      return response;
    },
  );

  /**
   * [TRI-08] Call off an intent that has not been applied. An applied move cannot be rewritten as
   * cancelled - the route did change - so that answer points the user at a move in the other
   * direction instead of pretending the write never happened, and an intent a reload, a failover
   * or a lifecycle event already called off is named as expired with the event that did it.
   */
  server.delete<{ Params: { operationId: string } }>(
    "/api/load-balancer/task-moves/:operationId",
    {
      schema: {
        params: LOAD_BALANCER_TASK_MOVE_OPERATION_PARAMS_SCHEMA,
        response: adminResponseSchemas(LOAD_BALANCER_TASK_MOVE_RESPONSE_SCHEMA),
      },
    },
    (request, reply) => {
      const answer = loadBalancerService.cancelMoveBinding(request.params.operationId);
      if ("rejection" in answer) {
        const rejection = answer.rejection;
        const outcome = CANCEL_REJECTIONS[rejection.code];
        return reply
          .code(outcome.status)
          .send(adminError(outcome.code, rejection.detail ?? outcome.message));
      }
      return answer.response;
    },
  );
}
