import type { FastifyInstance } from "fastify";
import {
  MODEL_PRICES_IMPORT_REQUEST_SCHEMA,
  MODEL_PRICES_IMPORT_RESPONSE_SCHEMA,
} from "../admin-schemas.js";
import { adminError } from "../admin-contracts.js";
import type { ModelCatalogAdminService } from "../admin-contracts.js";

export function registerModelCatalogRoutes(
  server: FastifyInstance,
  modelCatalogService: ModelCatalogAdminService,
): void {
  server.post<{
    Body: { priceRate?: string; targetApiKey?: string; targetUrl: string };
  }>(
    "/api/model-prices/import",
    {
      schema: {
        body: MODEL_PRICES_IMPORT_REQUEST_SCHEMA,
        response: { 200: MODEL_PRICES_IMPORT_RESPONSE_SCHEMA },
      },
    },
    async (request, reply) => {
      const priceRate = request.body.priceRate;
      const targetApiKey = request.body.targetApiKey;
      try {
        return await modelCatalogService.importModelPrices({
          targetUrl: request.body.targetUrl,
          ...(targetApiKey !== undefined && targetApiKey !== "" ? { targetApiKey } : {}),
          ...(priceRate !== undefined && priceRate !== "" ? { priceRate } : {}),
        });
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) {
          return reply.code(400).send(adminError("invalid_model_price_import", error.message));
        }
        return reply
          .code(502)
          .send(
            adminError(
              "model_catalog_fetch_failed",
              error instanceof Error ? error.message : String(error),
            ),
          );
      }
    },
  );
}
