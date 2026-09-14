import path from "node:path";

import {
  AdminControlPlane,
  applicationHealth,
  loadAdminStaticAssets,
  type AdminControlPlaneAddress,
} from "../admin/index.js";
import {
  ConfigRepository,
  summaryModelConfigSchema,
  type SummaryModelConfig,
} from "../config/index.js";
import { LogQueryService } from "../maintenance/index.js";
import { ProxyManager, checkTarget } from "../proxy/index.js";
import { joinTargetPath } from "../proxy/target.js";
import { Application } from "./application.js";

export interface NodeApplicationOptions {
  readonly applicationConfigFile: string;
  readonly configFile: string;
  readonly host: string;
  readonly logRoot: string;
  readonly port: number;
  readonly version?: string;
}

export interface NodeApplication {
  readonly application: Application;
  readonly address: () => AdminControlPlaneAddress | undefined;
}

export function createNodeApplication(options: NodeApplicationOptions): NodeApplication {
  const repository = new ConfigRepository(options.configFile, options.logRoot);
  let manager: ProxyManager | undefined;
  let admin: AdminControlPlane | undefined;
  let address: AdminControlPlaneAddress | undefined;
  const application = new Application({
    start: async () => {
      const config = await repository.load();
      manager = new ProxyManager(config, repository, {
        logRootBaseDirectory: path.dirname(options.applicationConfigFile),
      });
      const currentManager = manager;
      const startResult = await currentManager.startEnabled();
      if (startResult.failed.size > 0) {
        await currentManager.stopAll();
        throw new AggregateError(
          [...startResult.failed.values()],
          `Failed to start ${startResult.failed.size} enabled proxy pair(s).`,
        );
      }
      try {
        admin = new AdminControlPlane({
          host: options.host,
          port: options.port,
          getHealth: () =>
            applicationHealth(
              application.state,
              options.version ?? "development",
              currentManager.state === "degraded",
            ),
          pairService: currentManager,
          logService: (() => {
            const logs = new LogQueryService(() => currentManager.logRoots());
            return {
              listGroups: logs.listGroups.bind(logs),
              getGroupLogs: logs.getGroupLogs.bind(logs),
              getRecordDetail: logs.getRecordDetail.bind(logs),
              getGroupPricing: logs.getGroupPricing.bind(logs),
              getSummary: logs.getSummary.bind(logs),
              exportLogs: logs.exportLogs.bind(logs),
              cleanupSelectedGroups: logs.cleanupSelectedGroups.bind(logs),
              cleanupOlderThan: logs.cleanupOlderThan.bind(logs),
              cleanupKeepLatest: logs.cleanupKeepLatest.bind(logs),
              summarizeRecord: (id: string) => {
                const model = config.summary_model;
                if (!model) return Promise.reject(new Error("Summary model is not configured."));
                return logs.summarizeRecord(id, model);
              },
            };
          })(),
          ...(() => {
            const usageStatisticsService = new LogQueryService(() =>
              currentManager.logRoots(),
            ).usageStatisticsService();
            return usageStatisticsService === undefined ? {} : { usageStatisticsService };
          })(),
          targetCheckService: { checkTarget },
          summaryModelService: {
            getConfig: () => config.summary_model,
            setConfig: async (value: SummaryModelConfig) => {
              const parsed = summaryModelConfigSchema.parse(value);
              config.summary_model = parsed;
              await currentManager.replaceConfig(config);
              return parsed;
            },
            testConfig: async (value: SummaryModelConfig) => {
              const endpoint =
                value.api_type === "openai_responses"
                  ? "/responses"
                  : value.api_type === "anthropic_messages"
                    ? "/messages"
                    : "/chat/completions";
              const headers: Record<string, string> = {
                "content-type": "application/json",
                ...(value.api_type === "anthropic_messages"
                  ? { "x-api-key": value.api_key, "anthropic-version": "2023-06-01" }
                  : { authorization: `Bearer ${value.api_key}` }),
                ...Object.fromEntries(
                  value.target_headers.map((item) => {
                    const index = item.indexOf(":");
                    return [item.slice(0, index).trim(), item.slice(index + 1).trim()];
                  }),
                ),
              };
              const body =
                value.api_type === "openai_responses"
                  ? {
                      model: value.model,
                      input: "ping",
                      stream: false,
                      ...(value.disable_reasoning ? { reasoning_effort: "none" } : {}),
                    }
                  : value.api_type === "anthropic_messages"
                    ? {
                        model: value.model,
                        max_tokens: 1,
                        messages: [{ role: "user", content: "ping" }],
                        stream: false,
                        ...(value.disable_reasoning ? { reasoning_effort: "none" } : {}),
                      }
                    : {
                        model: value.model,
                        messages: [{ role: "user", content: "ping" }],
                        stream: false,
                        ...(value.disable_reasoning ? { reasoning_effort: "none" } : {}),
                      };
              try {
                const target = new URL(value.target_url);
                const basePath = target.pathname.replace(/\/$/u, "");
                target.pathname = basePath.endsWith(endpoint)
                  ? basePath
                  : joinTargetPath(basePath, endpoint);
                const r = await fetch(target, {
                  method: "POST",
                  headers,
                  body: JSON.stringify(body),
                  signal: AbortSignal.timeout(value.timeout_ms),
                });
                const responseText = (await r.text()).trim().slice(0, 500);
                return {
                  ok: r.status >= 200 && r.status < 300,
                  detail:
                    responseText === "" ? `HTTP ${r.status}` : `HTTP ${r.status}: ${responseText}`,
                };
              } catch (e) {
                return { ok: false, detail: e instanceof Error ? e.message : "request failed" };
              }
            },
          },
          staticAssets:
            options.version !== undefined ? await loadAdminStaticAssets() : loadAdminStaticAssets,
        });
        address = await admin.start();
      } catch (error) {
        await currentManager.stopAll();
        admin = undefined;
        throw error;
      }
    },
    stop: async () => {
      const failures: Error[] = [];
      if (admin !== undefined) {
        await admin.close().catch((error: unknown) => failures.push(asError(error)));
      }
      if (manager !== undefined) {
        await manager.stopAll().catch((error: unknown) => failures.push(asError(error)));
      }
      admin = undefined;
      manager = undefined;
      address = undefined;
      if (failures.length > 0) {
        throw new AggregateError(failures, "Application shutdown failed.");
      }
    },
  });

  return { application, address: () => address };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
