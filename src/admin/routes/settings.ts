import type { FastifyInstance } from "fastify";
import type { SummaryModelConfig } from "../../config/index.js";
import type { SummaryModelAdminService } from "../admin-contracts.js";

export function registerSummaryModelRoutes(
  server: FastifyInstance,
  summaryModelService: SummaryModelAdminService,
): void {
  const summary = summaryModelService;
  server.get("/api/settings/summary-model", () => summary.getConfig() ?? null);
  server.put<{ Body: SummaryModelConfig }>("/api/settings/summary-model", async (request) =>
    summary.setConfig(request.body),
  );
  if (summary.testConfig)
    server.post<{ Body: SummaryModelConfig }>("/api/settings/summary-model/test", async (request) =>
      summary.testConfig?.(request.body),
    );
}
