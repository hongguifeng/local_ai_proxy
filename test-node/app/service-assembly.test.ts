import { describe, expect, it } from "vitest";

import {
  applicationHealth,
  type AdminControlPlaneOptions,
  type AdminServerOptions,
  type LogAdminService,
  type PairAdminService,
  type PartialAdminServerOptions,
  type SummaryModelAdminService,
  type TargetCheckAdminService,
} from "../../src/admin/index.js";
import { assembleAdminServices, assertAdminServicesComplete } from "../../src/app/index.js";
import { LogQueryService } from "../../src/maintenance/index.js";
import { UsageStatisticsService } from "../../src/maintenance/usage-statistics-service.js";
import { ProxyManager, type ProxyConfigSaver } from "../../src/proxy/index.js";
import { completeAdminServices } from "../admin/admin-service-fixtures.js";
import { emptyGroupPage } from "../admin/log-service-fixtures.js";

/**
 * [AI-09] The service assembly of the production application.
 *
 * Two directions are proven here. A complete assembly is accepted, and it is the set the real
 * manager and query service produce; an incomplete one is refused at startup with a message that
 * names the member, so forgetting to wire a feature cannot end up as a `404` from a route that
 * was never registered. The compile-time half is written as `@ts-expect-error` checks:
 * `npm run typecheck` fails when one of them stops being an error, which is what keeps them honest.
 */

/**
 * The services that gate a route. `/api/health` is registered by `createAdminServer` itself and
 * `getHealth` is required by both shapes, so there is no wiring for the startup check to catch
 * there; these ten are the ones a missing service would take a route with.
 */
const ROUTE_GATING_MEMBERS: readonly (keyof AdminServerOptions)[] = [
  "logService",
  "pairService",
  "staticAssets",
  "targetCheckService",
  "targetMetricsService",
  "targetModelsService",
  "loadBalancerService",
  "summaryModelService",
  "modelCatalogService",
  "usageStatisticsService",
];

/** The 15 log views a stub may leave out; `listGroups` is the one every stub must answer. */
const OPTIONAL_LOG_VIEWS: readonly (keyof Required<LogAdminService>)[] = [
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
  "listRecordsByIds",
  "summarizeRecord",
  "generateTaskBrief",
];

/**
 * The complete set with one service left out. Each branch is written out because a loop cannot
 * take a keyed member away and keep the rest of the type: the hole has to be a value the partial
 * shape accepts, and `getHealth` stays in every branch because both shapes require it.
 */
function servicesWithout(member: keyof AdminServerOptions): PartialAdminServerOptions {
  const services = completeAdminServices();
  return {
    getHealth: services.getHealth,
    ...(member !== "logService" ? { logService: services.logService } : {}),
    ...(member !== "pairService" ? { pairService: services.pairService } : {}),
    ...(member !== "staticAssets" ? { staticAssets: services.staticAssets } : {}),
    ...(member !== "targetCheckService" ? { targetCheckService: services.targetCheckService } : {}),
    ...(member !== "targetMetricsService"
      ? { targetMetricsService: services.targetMetricsService }
      : {}),
    ...(member !== "targetModelsService"
      ? { targetModelsService: services.targetModelsService }
      : {}),
    ...(member !== "loadBalancerService"
      ? { loadBalancerService: services.loadBalancerService }
      : {}),
    ...(member !== "summaryModelService"
      ? { summaryModelService: services.summaryModelService }
      : {}),
    ...(member !== "modelCatalogService"
      ? { modelCatalogService: services.modelCatalogService }
      : {}),
    ...(member !== "usageStatisticsService"
      ? { usageStatisticsService: services.usageStatisticsService }
      : {}),
  };
}

/**
 * The log views with one view left out. `listGroups` is written unconditionally because every
 * log service has to answer it, which is what keeps the result a `LogAdminService` and lets the
 * test ask about the other fifteen.
 */
function logServiceWithout(view: keyof Required<LogAdminService>): LogAdminService {
  const views = completeAdminServices().logService;
  return {
    listGroups: views.listGroups,
    ...(view !== "cleanupKeepLatest" ? { cleanupKeepLatest: views.cleanupKeepLatest } : {}),
    ...(view !== "cleanupOlderThan" ? { cleanupOlderThan: views.cleanupOlderThan } : {}),
    ...(view !== "cleanupSelectedGroups"
      ? { cleanupSelectedGroups: views.cleanupSelectedGroups }
      : {}),
    ...(view !== "exportLogs" ? { exportLogs: views.exportLogs } : {}),
    ...(view !== "getGroupLogs" ? { getGroupLogs: views.getGroupLogs } : {}),
    ...(view !== "getGroupPricing" ? { getGroupPricing: views.getGroupPricing } : {}),
    ...(view !== "getGroupCostSeries" ? { getGroupCostSeries: views.getGroupCostSeries } : {}),
    ...(view !== "getGroupOutputTokenSeries"
      ? { getGroupOutputTokenSeries: views.getGroupOutputTokenSeries }
      : {}),
    ...(view !== "getGroupTokenSeries" ? { getGroupTokenSeries: views.getGroupTokenSeries } : {}),
    ...(view !== "getRecordDetail" ? { getRecordDetail: views.getRecordDetail } : {}),
    ...(view !== "getSummary" ? { getSummary: views.getSummary } : {}),
    ...(view !== "getTaskBrief" ? { getTaskBrief: views.getTaskBrief } : {}),
    ...(view !== "listRecordsByIds" ? { listRecordsByIds: views.listRecordsByIds } : {}),
    ...(view !== "summarizeRecord" ? { summarizeRecord: views.summarizeRecord } : {}),
    ...(view !== "generateTaskBrief" ? { generateTaskBrief: views.generateTaskBrief } : {}),
  };
}

/** The complete set with one named member taken away, for the compile-time checks. */
function withoutKey<T, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const { [key]: removed, ...rest } = value;
  // The removed member is the point of the helper, so its value is deliberately dropped.
  void removed;
  return rest;
}

/** The message the startup check threw, or an empty string when it accepted the assembly. */
function refusal(options: PartialAdminServerOptions): string {
  try {
    assertAdminServicesComplete(options);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

describe("[AI-09] admin service assembly", () => {
  it("assembles the complete set from the manager and query service it is given", async () => {
    const noWrite: ProxyConfigSaver = { save: () => Promise.resolve() };
    const services = assembleAdminServices({
      manager: new ProxyManager({ pairs: [] }, noWrite),
      logQuery: new LogQueryService([]),
      getHealth: () => applicationHealth("running"),
    });

    // The assembly is the complete set by construction, so it passes its own startup check once
    // the application adds the static assets it owns.
    expect(() =>
      assertAdminServicesComplete({
        ...services,
        staticAssets: { appCss: "a", appJs: "j", indexHtml: "<html>" },
      }),
    ).not.toThrow();

    expect(services.usageStatisticsService).toBeInstanceOf(UsageStatisticsService);
    expect(services.pairService.listPairs()).toEqual([]);
    expect(services.summaryModelService.getConfig()).toBeUndefined();
    expect(services.loadBalancerService.getStatus()).toMatchObject({ pairs: [] });
    expect(services.logService.listGroups("", 10, 0)).toMatchObject({ groups: [], total: 0 });
    // Generation needs the summary model the manager holds, and there is none here.
    await expect(services.logService.summarizeRecord("record-1")).rejects.toThrow(
      "Summary model is not configured.",
    );
    await expect(services.logService.generateTaskBrief("group-1")).rejects.toThrow(
      "Summary model is not configured.",
    );
  });

  it("accepts a complete assembly", () => {
    expect(() => assertAdminServicesComplete(completeAdminServices())).not.toThrow();
  });

  it("names every service a complete assembly is missing", () => {
    const silent: string[] = [];
    for (const member of ROUTE_GATING_MEMBERS) {
      const message = refusal(servicesWithout(member));
      if (message === "" || !message.includes(member)) {
        silent.push(`${member}: ${message === "" ? "accepted" : message}`);
      }
    }
    expect(silent).toEqual([]);
  });

  it("names every log view the assembly left out", () => {
    const silent: string[] = [];
    for (const view of OPTIONAL_LOG_VIEWS) {
      const incomplete: PartialAdminServerOptions = {
        ...completeAdminServices(),
        logService: logServiceWithout(view),
      };
      const expected = `logService.${view}`;
      const message = refusal(incomplete);
      if (message === "" || !message.includes(expected)) {
        silent.push(`${expected}: ${message === "" ? "accepted" : message}`);
      }
    }
    expect(silent).toEqual([]);
  });

  it("names the pair writes and the summary test the assembly left out", () => {
    const services = completeAdminServices();
    const cases: readonly {
      readonly services: PartialAdminServerOptions;
      readonly expected: string;
    }[] = [
      {
        expected: "pairService.replacePairs",
        services: { ...services, pairService: withoutKey(services.pairService, "replacePairs") },
      },
      {
        expected: "pairService.setPairEnabled",
        services: { ...services, pairService: withoutKey(services.pairService, "setPairEnabled") },
      },
      {
        expected: "summaryModelService.testConfig",
        services: {
          ...services,
          summaryModelService: withoutKey(services.summaryModelService, "testConfig"),
        },
      },
    ];

    const silent: string[] = [];
    for (const { expected, services: hole } of cases) {
      const message = refusal(hole);
      if (message === "" || !message.includes(expected)) {
        silent.push(`${expected}: ${message === "" ? "accepted" : message}`);
      }
    }
    expect(silent).toEqual([]);
  });

  it("refuses an unwired feature at compile time", () => {
    const services = completeAdminServices();
    // Every one of these is a hole the compiler refuses; `npm run typecheck` fails when one
    // stops being an error, so the checks cannot rot into passing for the wrong reason.
    // @ts-expect-error a health answer the route reads cannot be left out
    const withoutHealth: AdminServerOptions = withoutKey(services, "getHealth");
    expect(withoutHealth).toBeDefined();

    // @ts-expect-error the model price import route answers from this service alone
    const withoutModelCatalog: AdminServerOptions = withoutKey(services, "modelCatalogService");
    expect(withoutModelCatalog).toBeDefined();

    // @ts-expect-error the load balancer status route answers from this service alone
    const withoutLoadBalancer: AdminServerOptions = withoutKey(services, "loadBalancerService");
    expect(withoutLoadBalancer).toBeDefined();

    // @ts-expect-error listGroups is required by every log service, assembled ones included
    const withoutListing: AdminServerOptions["logService"] = withoutKey(
      services.logService,
      "listGroups",
    );
    expect(withoutListing).toBeDefined();

    // @ts-expect-error the statistics route answers from the service it is given
    const withoutStatistics: UsageStatisticsService = {};
    expect(withoutStatistics).toBeDefined();

    // @ts-expect-error the target check service has to answer the probe the route registers
    const withoutProbe: TargetCheckAdminService = {};
    expect(withoutProbe).toBeDefined();

    // @ts-expect-error a pair service without the list read cannot stand in for the assembled set
    const withoutPairList: AdminServerOptions["pairService"] = withoutKey(
      services.pairService,
      "listPairs",
    );
    expect(withoutPairList).toBeDefined();

    // @ts-expect-error the summary settings route reads getConfig and writes through setConfig
    const withoutSummaryReads: AdminServerOptions["summaryModelService"] = withoutKey(
      services.summaryModelService,
      "getConfig",
    );
    expect(withoutSummaryReads).toBeDefined();

    // @ts-expect-error the control plane is the production entry and takes the complete set
    const partialForProduction: AdminControlPlaneOptions = {
      host: "127.0.0.1",
      port: 0,
      getHealth: () => applicationHealth("running"),
    };
    expect(partialForProduction).toBeDefined();

    const page: AdminControlPlaneOptions = {
      ...services,
      host: "127.0.0.1",
      port: 0,
      // @ts-expect-error the static assets the page is served from are part of the complete set
      staticAssets: undefined,
    };
    expect(page).toBeDefined();

    const testOnlyAssembly: PartialAdminServerOptions = {
      getHealth: () => applicationHealth("running"),
      logService: { listGroups: () => emptyGroupPage() },
    };
    // @ts-expect-error the explicit partial assembly is not the set production is built from
    const productionFromTestAssembly: AdminServerOptions = testOnlyAssembly;
    expect(productionFromTestAssembly).toBeDefined();

    const stubPairService: PairAdminService = { listPairs: () => [] };
    const needsPairWrites: AdminServerOptions = {
      ...services,
      // @ts-expect-error replacePairs and setPairEnabled are part of the assembled set
      pairService: stubPairService,
    };
    expect(needsPairWrites).toBeDefined();

    const stubSummaryService: SummaryModelAdminService = {
      getConfig: () => undefined,
      setConfig: (config) => Promise.resolve(config),
    };
    const needsSummaryTest: AdminServerOptions = {
      ...services,
      // @ts-expect-error the connection test is part of the assembled set
      summaryModelService: stubSummaryService,
    };
    expect(needsSummaryTest).toBeDefined();
  });
});
