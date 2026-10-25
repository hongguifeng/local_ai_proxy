import type { FastifyInstance } from "fastify";
import {
  adminResponseSchemas,
  TARGET_CHECK_REQUEST_SCHEMA,
  TARGET_CHECK_RESPONSE_SCHEMA,
  TARGET_METRICS_REQUEST_SCHEMA,
  TARGET_METRICS_RESPONSE_SCHEMA,
  TARGET_MODELS_REQUEST_SCHEMA,
  TARGET_MODELS_RESPONSE_SCHEMA,
  type AdminTargetCheckRequestInput,
  type AdminTargetProbeRequestInput,
} from "../admin-schemas.js";
import { adminError } from "../admin-contracts.js";
import type {
  TargetCheckAdminService,
  TargetCheckApiType,
  TargetCheckRequest,
  TargetMetricsAdminService,
  TargetMetricsRequest,
  TargetModelsAdminService,
  TargetModelsRequest,
} from "../admin-contracts.js";

/**
 * The three target probes. The request and answer types live in `src/proxy`, which produces
 * them; the wire structure in front of them is declared with the rest of the API in
 * `admin-schemas.ts`.
 */
export function registerTargetRoutes(
  server: FastifyInstance,
  deps: {
    readonly targetCheckService: TargetCheckAdminService | undefined;
    readonly targetMetricsService: TargetMetricsAdminService | undefined;
    readonly targetModelsService: TargetModelsAdminService | undefined;
  },
): void {
  if (deps.targetCheckService !== undefined) {
    const targetCheckService = deps.targetCheckService;
    server.post<{ Body: AdminTargetCheckRequestInput }>(
      "/api/target-check",
      {
        schema: {
          body: TARGET_CHECK_REQUEST_SCHEMA,
          response: adminResponseSchemas(TARGET_CHECK_RESPONSE_SCHEMA),
        },
      },
      async (request, reply) => {
        const apiKey = request.body.apiKey;
        const apiType: TargetCheckApiType | undefined = request.body.apiType;
        const checkRequest: TargetCheckRequest = {
          targetUrl: request.body.targetUrl,
          model: request.body.model,
          ...(apiType ? { apiType } : {}),
          ...(apiKey ? { apiKey } : {}),
        };
        try {
          return await targetCheckService.checkTarget(checkRequest);
        } catch (error) {
          if (error instanceof TypeError) {
            return reply.code(400).send(adminError("invalid_target_url", error.message));
          }
          throw error;
        }
      },
    );
  }

  if (deps.targetMetricsService !== undefined) {
    const targetMetricsService = deps.targetMetricsService;
    server.post<{ Body: AdminTargetProbeRequestInput }>(
      "/api/target-metrics",
      {
        schema: {
          body: TARGET_METRICS_REQUEST_SCHEMA,
          response: adminResponseSchemas(TARGET_METRICS_RESPONSE_SCHEMA),
        },
      },
      async (request, reply) => {
        const apiKey = request.body.apiKey;
        const metricsRequest: TargetMetricsRequest = {
          targetUrl: request.body.targetUrl,
          ...(apiKey ? { apiKey } : {}),
        };
        try {
          return await targetMetricsService.fetchTargetMetrics(metricsRequest);
        } catch (error) {
          if (error instanceof TypeError) {
            return reply.code(400).send(adminError("invalid_target_url", error.message));
          }
          throw error;
        }
      },
    );
  }

  if (deps.targetModelsService !== undefined) {
    const targetModelsService = deps.targetModelsService;
    server.post<{ Body: AdminTargetProbeRequestInput }>(
      "/api/target-models",
      {
        schema: {
          body: TARGET_MODELS_REQUEST_SCHEMA,
          response: adminResponseSchemas(TARGET_MODELS_RESPONSE_SCHEMA),
        },
      },
      async (request, reply) => {
        const apiKey = request.body.apiKey;
        const modelsRequest: TargetModelsRequest = {
          targetUrl: request.body.targetUrl,
          ...(apiKey ? { apiKey } : {}),
        };
        try {
          return await targetModelsService.fetchTargetModels(modelsRequest);
        } catch (error) {
          if (error instanceof TypeError) {
            return reply.code(400).send(adminError("invalid_target_url", error.message));
          }
          throw error;
        }
      },
    );
  }
}
