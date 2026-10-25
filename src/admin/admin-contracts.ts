import type { Readable } from "node:stream";
import type { ApplicationState } from "../app/index.js";
import type {
  ConfigFieldError,
  ProxyPair,
  PublicProxyPair,
  SummaryModelConfig,
} from "../config/index.js";
import type {
  LogCleanupResult,
  LogGroupLogs,
  LogGroupPage,
  LogPendingRecord,
  LogRecordDetail,
} from "../maintenance/index.js";
import type { ModelPriceImportRequest, ModelPriceImportResult } from "../pricing/index.js";
import type { UsageStatisticsService } from "../maintenance/usage-statistics-service.js";
import type { LoadBalancerStatusResponse } from "../proxy/index.js";

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
  readonly listRecordsByIds?: (
    ids: readonly string[],
  ) => { records: readonly LogPendingRecord[] } | undefined;
  readonly getRecordDetail?: (recordId: string) => LogRecordDetail | undefined;
  readonly summarizeRecord?: (recordId: string) => Promise<unknown>;
  readonly getSummary?: (recordId: string) => unknown;
  readonly getGroupPricing?: (groupId: string) => unknown;
  readonly getGroupTokenSeries?: (groupId: string) => unknown;
  readonly getGroupCostSeries?: (groupId: string) => unknown;
  readonly getGroupOutputTokenSeries?: (groupId: string) => unknown;
  readonly getTaskBrief?: (groupId: string) => unknown;
  readonly generateTaskBrief?: (groupId: string) => Promise<unknown>;
  listGroups(query: string, limit: number, offset: number): LogGroupPage;
}

export interface PairAdminService {
  listPairs(): readonly PublicProxyPair[];
  readonly replacePairs?: (pairs: readonly ProxyPair[]) => Promise<readonly PublicProxyPair[]>;
  readonly setPairEnabled?: (pairId: string, enabled: boolean) => Promise<PublicProxyPair>;
}

export type TargetCheckApiType = "chat" | "responses" | "anthropic";

export interface TargetCheckRequest {
  readonly targetUrl: string;
  readonly model: string;
  readonly apiType?: TargetCheckApiType;
  readonly apiKey?: string;
}

export interface TargetCheckResponse {
  readonly ok: boolean;
  readonly status?: number;
  readonly durationMs: number;
  readonly error?: string;
  readonly detail?: string;
}

export interface TargetCheckAdminService {
  checkTarget(request: TargetCheckRequest): Promise<TargetCheckResponse>;
}

export interface TargetMetricsRequest {
  readonly targetUrl: string;
  readonly apiKey?: string;
}

export interface TargetMetricsResponse {
  readonly ok: boolean;
  readonly status?: number;
  readonly durationMs: number;
  readonly text?: string;
  readonly truncated?: boolean;
  readonly error?: string;
}

export interface TargetMetricsAdminService {
  fetchTargetMetrics(request: TargetMetricsRequest): Promise<TargetMetricsResponse>;
}

export interface TargetModelsRequest {
  readonly targetUrl: string;
  readonly apiKey?: string;
}

export interface TargetModelsResponse {
  readonly ok: boolean;
  readonly models: readonly string[];
  readonly durationMs: number;
  readonly truncated?: boolean;
  readonly error?: string;
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
