import type * as Core from "./static/modules/core.js";
import type { openTargetMetricsDialog } from "./static/modules/metrics.js";
import type { createLoadBalancing } from "./static/modules/load-balancing.js";
import type * as Dto from "./admin-schemas.js";
import type { PublicProxyPair, SummaryModelConfig } from "../config/index.js";
import type { TargetMetricsResponse } from "../proxy/target-metrics.js";
import type { TargetModelsResponse } from "../proxy/target-models.js";
import type { TargetCheckResponse } from "../proxy/target-check.js";
import type { LoadBalancerStatusResponse } from "../proxy/load-balancer-admin.js";
import type { ModelPriceImportResult } from "../pricing/index.js";

/** Editable copies belong to the console; wire DTOs remain readonly on the server. */
export type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

export interface ApiRoutes {
  "/api/pairs": { pairs: PublicProxyPair[] };
  [path: `/api/pairs/${string}/enabled`]: { pair: PublicProxyPair };
  "/api/logs/cleanup": Dto.AdminLogCleanupResult;
  [path: `/api/logs?${string}`]: Dto.AdminLogGroupPage;
  [path: `/api/logs/records?${string}`]: Dto.AdminRecordBatch;
  [path: `/api/log-groups/${string}/logs?${string}`]: Dto.AdminLogGroupLogs;
  [path: `/api/logs/${string}/summary`]: Dto.AdminHistorySummary | null;
  [path: `/api/log-groups/${string}/brief`]: Dto.AdminTaskBrief | null;
  [path: `/api/log-groups/${string}/pricing`]: Dto.AdminTaskPricing;
  [path: `/api/log-groups/${string}/pricing/tokens`]: Dto.AdminTokenSeriesPoint[];
  [path: `/api/log-groups/${string}/pricing/costs`]: Dto.AdminCostSeriesPoint[];
  [path: `/api/log-groups/${string}/pricing/output-tokens`]: Dto.AdminOutputTokenSeriesPoint[];
  "/api/settings/summary-model": SummaryModelConfig | null;
  "/api/settings/summary-model/test": Dto.AdminSummaryModelTestResult;
  "/api/target-metrics": TargetMetricsResponse;
  "/api/target-models": TargetModelsResponse;
  "/api/target-check": TargetCheckResponse;
  "/api/model-prices/import": ModelPriceImportResult;
  "/api/load-balancer/status": LoadBalancerStatusResponse;
  [path: `/api/load-balancer/tasks?${string}`]: Dto.AdminLoadBalancerTasksResponse;
  /**
   * [TRI-09] The migration write and its cancel. The path is answered by `POST` and by `DELETE`
   * on the parameterised path below; the method belongs to the caller, the shape to the route.
   */
  "/api/load-balancer/task-moves": Dto.AdminTaskMoveResponse;
  [path: `/api/load-balancer/task-moves/${string}`]: Dto.AdminTaskMoveResponse;
}
export type ApiPath = keyof ApiRoutes;
export type ApiResult<Path extends ApiPath> = Mutable<ApiRoutes[Path]>;
export type ApiClient = <Path extends ApiPath>(
  url: Path,
  options?: RequestInit,
) => Promise<ApiResult<Path>>;

export type LogItem = Mutable<Dto.AdminLogListItem>;
export type LogGroup = Mutable<Dto.AdminLogGroupSummary> & {
  logs: LogItem[];
  logsLoaded: boolean;
  logsHasMore: boolean;
  logsTotal: number;
  logsOffset: number;
  searchQuery: string;
};
export interface AsyncPanel<Data> {
  id: string;
  loading: boolean;
  error: boolean | string;
  data: Data | null;
}
export interface TaskSeries<Point> {
  id: string;
  points: readonly Point[] | null;
}
export interface ResponseMeta {
  status?: number | "pending" | "" | null;
  error?: unknown;
  first_token_ms?: number;
  duration_ms?: number;
  decode_window_ms?: number;
  request_token_count?: number;
  cached_token_count?: number;
  response_token_count?: number;
}
export interface SharedUiState {
  statisticsMetrics?: { trend?: string; target?: string; model?: string };
  statisticsOptions?: Dto.AdminStatisticsOptions;
  language: string;
  logGroups: LogGroup[];
  logs: LogItem[];
  selected: string | null;
  selectedLogGroups: Record<string, boolean>;
  raw: Record<string, unknown>;
  jsonPaneHtml: Record<string, string>;
  meta: Record<string, ResponseMeta | null>;
  metaOpen: Record<string, boolean>;
  wrap: Record<string, boolean>;
  formatStrings: Record<string, boolean>;
  tree: Record<string, boolean>;
  collapsedGroups: Record<string, boolean>;
  loadingLogGroups: Record<string, boolean>;
  loadingMoreLogGroups: Record<string, boolean>;
  logsLoading: boolean;
  logsQueued: { force?: boolean } | null;
  logSections: Map<string, string>;
  logTailHtml: string;
  pendingSweepCursor: number;
  selectedLogLoading: boolean;
  selectedLogRefreshLoading: boolean;
  requestPricing: RequestPricing | null;
  requestPricingOpen: boolean;
  activeTaskPricing: string | null;
  activeTaskGroup: Pick<
    LogGroup,
    "id" | "started_at" | "last_activity_at" | "model" | "request_count" | "decode_speed_tps"
  > | null;
  taskPricing: AsyncPanel<Dto.AdminTaskPricing> | null;
  taskTokenSeries: TaskSeries<Dto.AdminTokenSeriesPoint> | null;
  taskCostSeries: TaskSeries<Dto.AdminCostSeriesPoint> | null;
  taskOutputTokenSeries: TaskSeries<Dto.AdminOutputTokenSeriesPoint> | null;
  taskPricingAbort: AbortController | null;
  taskPricingRendered: string;
  taskBrief: AsyncPanel<Dto.AdminTaskBrief> | null;
  pricingGroupOpen: Record<string, Record<string, boolean>>;
  logsLoadedAt: number;
  logLimit: number;
  logOffset: number;
  logsHasMore: boolean;
  logsTotal: number;
  logQuery: string;
  lastLogQuery: string;
  splitterDragging: boolean;
  refreshTimer: ReturnType<typeof setTimeout> | null;
}

export type EditablePair = Mutable<PublicProxyPair> & {
  targets: (PublicProxyPair["targets"][number] & { expanded?: boolean })[];
};

export type UiServices = Pick<
  typeof Core,
  "$" | "qs" | "qsa" | "qsaOn" | "qsOn" | "asElement" | "closestFrom" | "closestOn" | "t" | "api"
>;
export type LoadBalancingServices = UiServices;
export type ProxyConfigServices = UiServices &
  Pick<typeof Core, "toast" | "registerLanguagePanel"> & {
    suggestedStripRequestFields: string;
    openTargetMetricsDialog: typeof openTargetMetricsDialog;
    loadBalancing: ReturnType<typeof createLoadBalancing>;
  };
export interface RequestPricing {
  pricing_snapshot?: Record<string, string>;
  usage?: Record<string, string | number>;
  pricing_reason?: string;
  billing_model?: string;
  pricing_status?: string;
  cost_nano_cny?: string;
}
