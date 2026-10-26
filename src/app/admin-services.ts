import {
  type AdminServerOptions,
  type HealthSnapshot,
  type PartialAdminServerOptions,
} from "../admin/admin-contracts.js";
import { summaryModelConfigSchema, type SummaryModelConfig } from "../config/index.js";
import type { LogQueryService } from "../maintenance/index.js";
import { BindingHistoryService } from "../maintenance/index.js";
import {
  checkTarget,
  createLoadBalancerAdminService,
  fetchTargetMetrics,
  fetchTargetModels,
  type ProxyManager,
} from "../proxy/index.js";
import { importModelPrices } from "../pricing/index.js";
import { ApplicationError } from "../shared/index.js";

/**
 * What the application assembly holds when it builds the admin surface, and who holds it after
 * that: the proxy manager owns the pairs, the load balancers and the summary-model config; one
 * log query service owns every log-backed view, usage statistics included; health is read from
 * the application lifecycle. The assembly is created once per start, is held by
 * `createNodeApplication` through the control plane, and is released when the control plane
 * closes and the manager is stopped — there is no second owner of any of the three.
 */
export interface AdminServiceAssembly {
  readonly manager: ProxyManager;
  readonly logQuery: LogQueryService;
  readonly getHealth: () => HealthSnapshot;
}

/**
 * The services the assembly owns. The listen address and the static assets are added by the
 * application, which is the part that knows the host, the port and whether this is a built
 * release or a development run; everything the route table answers from is here.
 */
export type AssembledAdminServices = Omit<AdminServerOptions, "staticAssets">;

/**
 * One query service owns every log-backed admin view, including usage statistics. It reads the
 * log roots when a query runs, so a committed configuration change is visible without rebuilding
 * any admin service. The summary views are wrapped here because generation needs the summary
 * model the manager holds at the moment of the call, which the query service is not given.
 */
export function assembleAdminServices(assembly: AdminServiceAssembly): AssembledAdminServices {
  const { getHealth, logQuery, manager } = assembly;
  return {
    getHealth,
    logService: {
      listGroups: logQuery.listGroups.bind(logQuery),
      getGroupLogs: logQuery.getGroupLogs.bind(logQuery),
      listRecordsByIds: logQuery.listRecordsByIds.bind(logQuery),
      getRecordDetail: logQuery.getRecordDetail.bind(logQuery),
      getGroupPricing: logQuery.getGroupPricing.bind(logQuery),
      getGroupTokenSeries: logQuery.getGroupTokenSeries.bind(logQuery),
      getGroupCostSeries: logQuery.getGroupCostSeries.bind(logQuery),
      getGroupOutputTokenSeries: logQuery.getGroupOutputTokenSeries.bind(logQuery),
      getSummary: logQuery.getSummary.bind(logQuery),
      getTaskBrief: logQuery.getTaskBrief.bind(logQuery),
      exportLogs: logQuery.exportLogs.bind(logQuery),
      cleanupSelectedGroups: logQuery.cleanupSelectedGroups.bind(logQuery),
      cleanupOlderThan: logQuery.cleanupOlderThan.bind(logQuery),
      cleanupKeepLatest: logQuery.cleanupKeepLatest.bind(logQuery),
      summarizeRecord: (id: string) => {
        const model = manager.config.summary_model;
        if (!model) return Promise.reject(missingSummaryModel());
        return logQuery.summarizeRecord(id, model);
      },
      generateTaskBrief: (groupId: string) => {
        const model = manager.config.summary_model;
        if (!model) return Promise.reject(missingSummaryModel());
        return logQuery.generateTaskBrief(groupId, model);
      },
    },
    usageStatisticsService: logQuery.usageStatisticsService(),
    pairService: manager,
    targetCheckService: { checkTarget },
    targetMetricsService: { fetchTargetMetrics },
    targetModelsService: { fetchTargetModels },
    loadBalancerService: createLoadBalancerAdminService({
      bindingHistory: new BindingHistoryService(),
      loadBalancer: (pairId) => manager.registry.loadBalancer(pairId),
      loadMonitor: (pairId) => manager.registry.loadMonitor(pairId),
      logRootForTarget: (pairId, targetId) => manager.logRootForTarget(pairId, targetId),
      pairs: () => manager.listPairs(),
    }),
    modelCatalogService: { importModelPrices },
    summaryModelService: {
      getConfig: () => manager.config.summary_model,
      setConfig: async (value: SummaryModelConfig) => {
        const parsed = summaryModelConfigSchema.parse(value);
        await manager.updateSummaryModel(parsed);
        return parsed;
      },
      testConfig: (value: SummaryModelConfig) => logQuery.testSummaryModel(value),
    },
  };
}

/**
 * What the route table answers from, stated as services. A route is registered only when the
 * service and method behind it are present, so this list is the route table's requirement read
 * the other way round: every route in the 34 registrations pinned by
 * `test-node/admin/api-contract.test.ts` has an entry here, and an entry that goes missing would
 * take a route with it. `/api/health` is the exception: `createAdminServer` registers it itself,
 * and `getHealth` is required by both shapes, so there is no wiring for this check to catch.
 */
const REQUIRED_ADMIN_SERVICES: readonly {
  readonly member: keyof AdminServerOptions;
  readonly methods: readonly string[];
}[] = [
  {
    member: "logService",
    methods: [
      "cleanupKeepLatest",
      "cleanupOlderThan",
      "cleanupSelectedGroups",
      "exportLogs",
      "getGroupLogs",
      "getGroupPricing",
      "getGroupCostSeries",
      "getGroupOutputTokenSeries",
      "getGroupTokenSeries",
      "getRecordDetail",
      "getSummary",
      "getTaskBrief",
      "listGroups",
      "listRecordsByIds",
      "summarizeRecord",
      "generateTaskBrief",
    ],
  },
  { member: "pairService", methods: ["listPairs", "replacePairs", "setPairEnabled"] },
  { member: "staticAssets", methods: [] },
  { member: "targetCheckService", methods: ["checkTarget"] },
  { member: "targetMetricsService", methods: ["fetchTargetMetrics"] },
  { member: "targetModelsService", methods: ["fetchTargetModels"] },
  { member: "loadBalancerService", methods: ["getStatus", "getBindings"] },
  { member: "summaryModelService", methods: ["getConfig", "setConfig", "testConfig"] },
  { member: "modelCatalogService", methods: ["importModelPrices"] },
  { member: "usageStatisticsService", methods: ["overview", "trend", "repositoryRows"] },
];

/**
 * The startup check that makes an unwired feature fail loudly instead of quietly. It runs on
 * the options the application is about to hand the control plane, before any port is bound.
 *
 * `AdminServerOptions` already states this at compile time; this check is for the case the
 * type system cannot see — a service built through a cast or a plain object, or a method that
 * disappeared while the shape stayed assignable. It is deliberately about presence: the type
 * decided callability long ago, and a method that is simply not there is what would drop a
 * route. The message names every missing member, so the operator reads the hole rather than
 * guessing from a `404 { code: "not_found" }`.
 */
export function assertAdminServicesComplete(options: PartialAdminServerOptions): void {
  const missing: string[] = [];
  for (const { member, methods } of REQUIRED_ADMIN_SERVICES) {
    const service: object | undefined = options[member];
    if (service === undefined) {
      missing.push(member);
      continue;
    }
    for (const method of methods) {
      if (!Reflect.has(service, method)) {
        missing.push(`${member}.${method}`);
      }
    }
  }
  if (missing.length === 0) return;
  throw new ApplicationError(
    `Admin service assembly is incomplete: ${missing.join(", ")} ${
      missing.length === 1 ? "is" : "are"
    } not wired. Every service the admin route table answers from must be assembled.`,
    { code: "internal_error", statusCode: 500, details: { missing } },
  );
}

/**
 * Generation cannot run without a summary model. The sentence is written here and holds no
 * configuration value, so the console can show it as it stands.
 */
function missingSummaryModel(): ApplicationError {
  return new ApplicationError("Summary model is not configured.", {
    code: "upstream_error",
    expose: true,
    statusCode: 502,
  });
}
