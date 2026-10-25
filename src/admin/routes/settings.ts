import type { FastifyInstance } from "fastify";
import {
  adminResponseSchemas,
  SUMMARY_MODEL_CONFIG_RESPONSE_SCHEMA,
  SUMMARY_MODEL_CONFIG_SCHEMA,
  SUMMARY_MODEL_TEST_RESPONSE_SCHEMA,
  type AdminSummaryModelConfigInput,
} from "../admin-schemas.js";
import type { SummaryModelAdminService } from "../admin-contracts.js";

/**
 * The summary settings. The wire structure is declared with the rest of the API, but the
 * field rules stay with `summaryModelConfigSchema` in `src/config`: a bad URL, an empty
 * model name or a header line without a colon is answered as `invalid_config` with the
 * offending paths, which is what the console points at. Those rules use `.refine()`, which
 * no JSON Schema can express, so the body schema here only checks the shape.
 */
export function registerSummaryModelRoutes(
  server: FastifyInstance,
  summaryModelService: SummaryModelAdminService,
): void {
  const summary = summaryModelService;
  server.get(
    "/api/settings/summary-model",
    { schema: { response: adminResponseSchemas(SUMMARY_MODEL_CONFIG_RESPONSE_SCHEMA) } },
    () => summary.getConfig() ?? null,
  );
  server.put<{ Body: AdminSummaryModelConfigInput }>(
    "/api/settings/summary-model",
    {
      schema: {
        body: SUMMARY_MODEL_CONFIG_SCHEMA,
        response: adminResponseSchemas(SUMMARY_MODEL_CONFIG_SCHEMA),
      },
    },
    async (request) => summary.setConfig(request.body),
  );
  if (summary.testConfig)
    server.post<{ Body: AdminSummaryModelConfigInput }>(
      "/api/settings/summary-model/test",
      {
        schema: {
          body: SUMMARY_MODEL_CONFIG_SCHEMA,
          response: adminResponseSchemas(SUMMARY_MODEL_TEST_RESPONSE_SCHEMA),
        },
      },
      async (request) => summary.testConfig?.(request.body),
    );
}
