import type { Readable } from "node:stream";
import type { ApplicationState } from "../app/index.js";
import type { ConfigFieldError } from "../config/index.js";
import type { ProxyPair, PublicProxyPair, SummaryModelConfig } from "../config/index.js";
import type { UsageStatisticsService } from "../maintenance/usage-statistics-service.js";
import type { ModelPriceImportRequest, ModelPriceImportResult } from "../pricing/index.js";
import type {
  AdminErrorDto,
  AdminHistorySummary,
  AdminLogCleanupResult,
  AdminLogGroupLogs,
  AdminLogGroupPage,
  AdminLogRecordDetail,
  AdminRecordBatch,
  AdminTaskBrief,
  AdminTaskPricing,
  AdminCostSeriesPoint,
  AdminTokenSeriesPoint,
  AdminOutputTokenSeriesPoint,
  HealthSnapshot as DeclaredHealthSnapshot,
  HealthStatus,
} from "./admin-schemas.js";
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

/**
 * Health is answered by the assembly, which owns the lifecycle states, so the declared
 * `applicationState` string is narrowed back to them here: the schema says what travels,
 * this says what the process may report. `HealthStatus` is the schema's own union.
 */
export type { AdminErrorDto, AdminJsonSchema, HealthStatus } from "./admin-schemas.js";

export type HealthSnapshot = Omit<DeclaredHealthSnapshot, "applicationState"> & {
  readonly applicationState: ApplicationState;
};

/**
 * The complete service set the production application has to assemble. Every member is
 * required, and a service whose methods gate a route is required in full, so a feature whose
 * service the assembly forgot is a compile error in `src/app/runtime.ts` — the assembly is
 * typed against this interface — and a hole that arrives through a cast or a plain object is
 * refused at startup by `assertAdminServicesComplete` in `src/app/admin-services.ts`.
 * Both happen before any port is bound, so a missing service can never reach the browser as
 * `404 { error: { code: "not_found" } }`, which is what an unregistered route looks like.
 *
 * Only `logger` stays optional: it is not a service any route answers from, and
 * `createAdminServer` supplies a structured one when the assembly does not.
 */
export interface AdminServerOptions {
  readonly getHealth: () => HealthSnapshot;
  readonly logService: Required<LogAdminService>;
  readonly logger?: AdminRequestLogger;
  readonly pairService: Required<PairAdminService>;
  readonly staticAssets: AdminStaticAssets | (() => Promise<AdminStaticAssets>);
  readonly targetCheckService: TargetCheckAdminService;
  readonly targetMetricsService: TargetMetricsAdminService;
  readonly targetModelsService: TargetModelsAdminService;
  readonly loadBalancerService: LoadBalancerAdminService;
  readonly summaryModelService: Required<SummaryModelAdminService>;
  readonly modelCatalogService: ModelCatalogAdminService;
  readonly usageStatisticsService: UsageStatisticsService;
}

/**
 * The explicit partial assembly: the subset of services a test wires when it exercises one
 * route family. A route whose service is absent is not registered, so that server answers the
 * generic `not_found` — which is exactly the shape a production assembly must never produce,
 * and the reason this is a named type instead of a hole in `AdminServerOptions`.
 *
 * A complete set is assignable here, so `createAdminServer` keeps one signature and both
 * consumers; production enters through `AdminControlPlaneOptions`, which extends the complete
 * interface and cannot be satisfied by this one.
 */
export interface PartialAdminServerOptions {
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
 * The log views the admin API answers from. Every return type is a DTO declared in
 * `admin-schemas.ts`, which is also where the response schema comes from, so the shape a
 * service must answer and the shape the browser receives are one declaration: a renamed or
 * forgotten field stops the assembly in `src/app/runtime.ts` and every stub from compiling
 * instead of reaching the browser as `undefined`. A method is optional here so a test can wire
 * one route family; the assembled application is typed against `Required<LogAdminService>`, so
 * every method the route table answers from is present in production and no route is dropped.
 */
export interface LogAdminService {
  readonly cleanupKeepLatest?: (keepLatest: number) => AdminLogCleanupResult;
  readonly cleanupOlderThan?: (olderThanDays: number) => AdminLogCleanupResult;
  readonly cleanupSelectedGroups?: (groupIds: readonly string[]) => AdminLogCleanupResult;
  readonly exportLogs?: () => Readable;
  readonly getGroupLogs?: (
    groupId: string,
    query: string,
    limit: number,
    offset: number,
  ) => AdminLogGroupLogs | undefined;
  readonly listRecordsByIds?: (ids: readonly string[]) => AdminRecordBatch;
  readonly getRecordDetail?: (recordId: string) => AdminLogRecordDetail | undefined;
  readonly summarizeRecord?: (recordId: string) => Promise<AdminHistorySummary | undefined>;
  readonly getSummary?: (recordId: string) => AdminHistorySummary | undefined;
  readonly getGroupPricing?: (groupId: string) => AdminTaskPricing | undefined;
  readonly getGroupTokenSeries?: (groupId: string) => readonly AdminTokenSeriesPoint[] | undefined;
  readonly getGroupCostSeries?: (groupId: string) => readonly AdminCostSeriesPoint[] | undefined;
  readonly getGroupOutputTokenSeries?: (
    groupId: string,
  ) => readonly AdminOutputTokenSeriesPoint[] | undefined;
  readonly getTaskBrief?: (groupId: string) => AdminTaskBrief | undefined;
  readonly generateTaskBrief?: (groupId: string) => Promise<AdminTaskBrief>;
  listGroups(query: string, limit: number, offset: number): AdminLogGroupPage;
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

/**
 * An error answer that also names the configuration fields that were rejected. The shared
 * `{ code, message }` shape is declared in `admin-schemas.ts`; the field paths ride along only
 * on an answer the error handler produced, because a response schema would delete them.
 */
export interface AdminConfigFieldIssuesDto extends AdminErrorDto {
  readonly error: AdminErrorDto["error"] & { readonly issues: readonly ConfigFieldError[] };
}

/**
 * The one error answer. `AdminErrorDto` is the DTO declared in `admin-schemas.ts`, and this is
 * the only place that builds one, so every error the admin API sends has the same shape. No
 * error answer carries a response schema, so a rename stops the build here instead of being
 * deleted by a serializer.
 */
export function adminError(code: string, message: string): AdminErrorDto {
  return { error: { code, message } };
}

/** The same shape, with the field paths the console points at. */
export function adminConfigError(
  code: string,
  message: string,
  issues: readonly ConfigFieldError[],
): AdminConfigFieldIssuesDto {
  return { error: { code, message, issues } };
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
