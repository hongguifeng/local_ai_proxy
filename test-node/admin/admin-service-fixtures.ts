import {
  applicationHealth,
  type AdminServerOptions,
  type HealthSnapshot,
  type LogAdminService,
  type PairAdminService,
  type SummaryModelAdminService,
} from "../../src/admin/index.js";
import type { SummaryModelConfig } from "../../src/config/index.js";
import { UsageStatisticsService } from "../../src/maintenance/usage-statistics-service.js";
import {
  cleanupResult,
  emptyGroupPage,
  enabledPair,
  exportStream,
  modelPriceImportResult,
  recordBatch,
  taskBrief,
} from "./log-service-fixtures.js";

/**
 * [AI-09] The service set the admin route table answers from, answered by stubs. It exists so a
 * test that needs the whole set — the control plane on TCP, the startup check, a route-table
 * comparison — builds the same 11 members instead of writing its own copy that can drift.
 *
 * Every log view, pair method and summary method is present because this is the set the
 * production assembly is required to provide; a stub that wants only some of them says so with
 * `PartialAdminServerOptions`.
 */

/** Every log view the route table answers from, including the three cleanup strategies. */
export function logViews(): Required<LogAdminService> {
  return {
    listGroups: () => emptyGroupPage(),
    getGroupLogs: () => undefined,
    listRecordsByIds: () => recordBatch(),
    getRecordDetail: () => undefined,
    getGroupPricing: () => undefined,
    getGroupTokenSeries: () => undefined,
    getGroupCostSeries: () => undefined,
    getGroupOutputTokenSeries: () => undefined,
    getSummary: () => undefined,
    getTaskBrief: () => undefined,
    summarizeRecord: () => Promise.resolve(undefined),
    generateTaskBrief: () => Promise.resolve(taskBrief()),
    exportLogs: () => exportStream(),
    cleanupSelectedGroups: () => cleanupResult(),
    cleanupOlderThan: () => cleanupResult(),
    cleanupKeepLatest: () => cleanupResult(),
  };
}

/** Every pair method the route table answers from, including both writes. */
function pairMethods(): Required<PairAdminService> {
  return {
    listPairs: () => [],
    replacePairs: () => Promise.resolve([]),
    setPairEnabled: () => Promise.resolve(enabledPair()),
  };
}

/** Every summary-model method the route table answers from, including the connection test. */
function summaryMethods(): Required<SummaryModelAdminService> {
  return {
    getConfig: () => undefined,
    setConfig: (config: SummaryModelConfig) => Promise.resolve(config),
    testConfig: () => Promise.resolve({ ok: true }),
  };
}

/**
 * The complete admin service set. The health answer is a parameter because the caller is the
 * one that knows which lifecycle state a test is pretending to be in; everything else is the
 * same whatever the test is about.
 */
export function completeAdminServices(
  getHealth: () => HealthSnapshot = () => applicationHealth("running"),
): AdminServerOptions {
  return {
    getHealth,
    logService: logViews(),
    pairService: pairMethods(),
    staticAssets: { appCss: "a", appJs: "j", indexHtml: "<html>" },
    targetCheckService: { checkTarget: () => Promise.resolve({ ok: true, durationMs: 1 }) },
    targetMetricsService: {
      fetchTargetMetrics: () => Promise.resolve({ ok: true, durationMs: 1 }),
    },
    targetModelsService: {
      fetchTargetModels: () => Promise.resolve({ ok: true, models: [], durationMs: 1 }),
    },
    loadBalancerService: { getStatus: () => ({ now: 0, pairs: [] }) },
    summaryModelService: summaryMethods(),
    modelCatalogService: { importModelPrices: () => Promise.resolve(modelPriceImportResult()) },
    usageStatisticsService: new UsageStatisticsService({ usageStatisticsRows: () => [] }),
  };
}
