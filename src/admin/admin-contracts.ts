import type { Readable } from "node:stream";
import type { ApplicationState } from "../app/index.js";
import type {
  ConfigFieldError,
  ProxyPair,
  PublicProxyPair,
  SummaryModelConfig,
} from "../config/index.js";
import type {
  HistorySummary,
  LogCleanupResult,
  LogGroupLogs,
  LogGroupPage,
  LogPendingRecord,
  LogRecordDetail,
  TaskBrief,
} from "../maintenance/index.js";
import type { UsageStatisticsService } from "../maintenance/usage-statistics-service.js";
import type {
  TaskCostSeriesPoint,
  TaskOutputTokenSeriesPoint,
  TaskPricingAggregate,
  TaskTokenSeriesPoint,
} from "../persistence/index.js";
import type { ModelPriceImportRequest, ModelPriceImportResult } from "../pricing/index.js";
import type {
  LoadBalancerStatusResponse,
  TargetCheckApiType,
  TargetCheckRequest,
  TargetCheckResponse,
  TargetMetricsRequest,
  TargetMetricsResponse,
  TargetModelsRequest,
  TargetModelsResponse,
} from "../proxy/index.js";

export type HealthStatus = "degraded" | "ok" | "starting" | "stopping";

export interface HealthSnapshot {
  readonly applicationState: ApplicationState;
  readonly status: HealthStatus;
  readonly version: string;
}

export interface AdminServerOptions {
  readonly getHealth: () => HealthSnapshot;
  readonly logService?: LogAdminService;
  readonly logger?: AdminRequestLogger;
  readonly pairService?: PairAdminService;
  readonly staticAssets?: AdminStaticAssets | (() => Promise<AdminStaticAssets>);
  readonly targetCheckService?: TargetCheckAdminService;
  readonly targetMetricsService?: TargetMetricsAdminService;
  readonly targetModelsService?: TargetModelsAdminService;
  readonly loadBalancerService?: LoadBalancerAdminService;
  readonly summaryModelService?: SummaryModelAdminService;
  readonly modelCatalogService?: ModelCatalogAdminService;
  readonly usageStatisticsService?: UsageStatisticsService;
}
export interface SummaryModelAdminService {
  getConfig(): SummaryModelConfig | undefined;
  setConfig(config: SummaryModelConfig): Promise<SummaryModelConfig>;
  testConfig?(config: SummaryModelConfig): Promise<{ ok: boolean; detail?: string }>;
}

export interface ModelCatalogAdminService {
  importModelPrices(request: ModelPriceImportRequest): Promise<ModelPriceImportResult>;
}

/**
 * The log views the admin API answers from. Every signature is the shape
 * `LogQueryService` really answers with, so a renamed or forgotten field on that service
 * stops the assembly in `src/app/runtime.ts` and every stub from compiling instead of
 * reaching the browser as `undefined`. A method is absent only when the running
 * application does not wire it, which is what removes its route.
 */
export interface LogAdminService {
  readonly cleanupKeepLatest?: (keepLatest: number) => LogCleanupResult;
  readonly cleanupOlderThan?: (olderThanDays: number) => LogCleanupResult;
  readonly cleanupSelectedGroups?: (groupIds: readonly string[]) => LogCleanupResult;
  readonly exportLogs?: () => Readable;
  readonly getGroupLogs?: (
    groupId: string,
    query: string,
    limit: number,
    offset: number,
  ) => LogGroupLogs | undefined;
  readonly listRecordsByIds?: (ids: readonly string[]) => {
    readonly records: readonly LogPendingRecord[];
  };
  readonly getRecordDetail?: (recordId: string) => LogRecordDetail | undefined;
  readonly summarizeRecord?: (recordId: string) => Promise<HistorySummary | undefined>;
  readonly getSummary?: (recordId: string) => HistorySummary | undefined;
  readonly getGroupPricing?: (groupId: string) => TaskPricingAggregate | undefined;
  readonly getGroupTokenSeries?: (groupId: string) => readonly TaskTokenSeriesPoint[] | undefined;
  readonly getGroupCostSeries?: (groupId: string) => readonly TaskCostSeriesPoint[] | undefined;
  readonly getGroupOutputTokenSeries?: (
    groupId: string,
  ) => readonly TaskOutputTokenSeriesPoint[] | undefined;
  readonly getTaskBrief?: (groupId: string) => TaskBrief | undefined;
  readonly generateTaskBrief?: (groupId: string) => Promise<TaskBrief>;
  listGroups(query: string, limit: number, offset: number): LogGroupPage;
}

export interface PairAdminService {
  listPairs(): readonly PublicProxyPair[];
  readonly replacePairs?: (pairs: readonly ProxyPair[]) => Promise<readonly PublicProxyPair[]>;
  readonly setPairEnabled?: (pairId: string, enabled: boolean) => Promise<PublicProxyPair>;
}

/**
 * The request and answer shapes of the three target probes. They are declared once in
 * `src/proxy`, so the admin contract re-exports them instead of writing a second copy that
 * can drift away from the code that answers.
 */
export type { TargetCheckApiType, TargetCheckRequest, TargetCheckResponse };
export type { TargetMetricsRequest, TargetMetricsResponse };
export type { TargetModelsRequest, TargetModelsResponse };

export interface TargetCheckAdminService {
  checkTarget(request: TargetCheckRequest): Promise<TargetCheckResponse>;
}

export interface TargetMetricsAdminService {
  fetchTargetMetrics(request: TargetMetricsRequest): Promise<TargetMetricsResponse>;
}

export interface TargetModelsAdminService {
  fetchTargetModels(request: TargetModelsRequest): Promise<TargetModelsResponse>;
}

/** Read-only load balancing state, answered entirely from memory. */
export interface LoadBalancerAdminService {
  getStatus(): LoadBalancerStatusResponse;
}

export interface AdminRequestLogger {
  info(message: string, context?: Readonly<Record<string, unknown>>): void;
  warn(message: string, context?: Readonly<Record<string, unknown>>): void;
}

export interface AdminStaticAssets {
  readonly appCss: string;
  readonly appJs: string;
  readonly indexHtml: string;
}

export interface AdminErrorDto {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly issues?: readonly ConfigFieldError[];
  };
}

export function csvCell(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "string"
        ? value
        : typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : "";
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function adminError(
  code: string,
  message: string,
  issues?: readonly ConfigFieldError[],
): AdminErrorDto {
  return { error: { code, message, ...(issues === undefined ? {} : { issues }) } };
}

export function errorProperty<T extends "number" | "string">(
  error: unknown,
  property: string,
  expectedType: T,
): T extends "number" ? number | undefined : string | undefined {
  const value =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)[property]
      : undefined;
  return (typeof value === expectedType ? value : undefined) as T extends "number"
    ? number | undefined
    : string | undefined;
}

export function applicationHealth(
  applicationState: ApplicationState,
  version = "development",
  degraded = false,
): HealthSnapshot {
  const status: HealthStatus = degraded
    ? "degraded"
    : applicationState === "running"
      ? "ok"
      : applicationState === "created" || applicationState === "starting"
        ? "starting"
        : "stopping";
  return { applicationState, status, version };
}
