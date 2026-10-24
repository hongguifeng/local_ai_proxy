import { performance } from "node:perf_hooks";

import type { LoadBalancer } from "./load-balancer.js";
import type { LoadMonitor, LoadNodeStatus } from "./load-monitor.js";
import type { LoadBalancerGroup, PublicProxyPair } from "../config/index.js";
import { modelPatternMatches } from "./routing.js";
import { parseTargetUrl } from "./target.js";

/**
 * Read-only view of load balancing for the admin UI, plus a model check that asks each
 * node in a group what models it actually serves. The status half never touches the
 * database or the network: everything it returns is already in memory.
 */

export const VERIFY_MODELS_TIMEOUT_MS = 8_000;
export const MAX_VERIFY_MODELS_BYTES = 262_144;

export interface LoadBalancerAdminSource {
  pairs(): readonly PublicProxyPair[];
  loadBalancer(pairId: string): LoadBalancer | undefined;
  loadMonitor(pairId: string): LoadMonitor | undefined;
}

export interface LoadBalancerMetricsSnapshot {
  readonly kvUsage: number | undefined;
  readonly running: number;
  readonly sampledAt: number;
  readonly source: string;
  readonly waiting: number;
}

export interface LoadBalancerStatusNode {
  /** How many tasks are currently bound to this node. */
  readonly bindings: number;
  readonly canonicalKey: string;
  readonly cooldownRemainingMs: number;
  readonly enabled: boolean;
  readonly failures: number;
  readonly inFlight: number;
  /** Enabled and out of cooldown; a sleeping engine is judged per request, not here. */
  readonly inRotation: boolean;
  readonly lastDispatchedAt: number | null;
  readonly metrics: LoadBalancerMetricsSnapshot | null;
  readonly stale: boolean;
  readonly targetId: string;
}

export interface LoadBalancerStatusGroup {
  readonly bindings: number;
  readonly enabled: boolean;
  readonly failoverEnabled: boolean;
  readonly id: string;
  readonly metricsEnabled: boolean;
  readonly modelPattern: string;
  readonly name: string;
  readonly nodeTargetIds: readonly string[];
  readonly nodes: readonly LoadBalancerStatusNode[];
  readonly strategy: string;
}

export interface LoadBalancerStatusPair {
  readonly enabled: boolean;
  readonly groups: readonly LoadBalancerStatusGroup[];
  readonly id: string;
  readonly name: string;
  readonly running: boolean;
}

export interface LoadBalancerStatusResponse {
  readonly now: number;
  readonly pairs: readonly LoadBalancerStatusPair[];
}

export interface LoadBalancerNodeModelCheck {
  readonly durationMs: number;
  readonly error: string | undefined;
  readonly matched: readonly string[];
  readonly models: readonly string[];
  readonly ok: boolean;
  /** The HTTP status, or null when no answer came back at all. */
  readonly status: number | null;
  readonly targetId: string;
}

export interface LoadBalancerVerifyModelsResponse {
  readonly groupId: string;
  readonly modelPattern: string;
  readonly nodes: readonly LoadBalancerNodeModelCheck[];
  readonly pairId: string;
}

/** The model ids an engine reports through `GET /models`. */
function modelIdsFromPayload(payload: unknown): string[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  const ids: string[] = [];
  for (const item of payload) {
    if (typeof item === "string") {
      ids.push(item);
      continue;
    }
    if (item !== null && typeof item === "object") {
      const id = (item as { id?: unknown }).id;
      if (typeof id === "string") {
        ids.push(id);
      }
    }
  }
  return ids;
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<string> {
  const stream = response.body;
  if (stream === null) {
    return await response.text();
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const decoder = new TextDecoder();
  let text = "";
  for (const chunk of chunks) {
    text += decoder.decode(chunk, { stream: true });
  }
  return text.slice(0, maxBytes);
}

/**
 * Asks one node for its model list. The base-path variant is tried first and the host
 * root is used as a fallback, the same way the metrics sampler reaches an engine.
 */
async function fetchModelList(
  targetUrl: string,
  apiKey: string,
  timeoutMs: number,
): Promise<{
  durationMs: number;
  error: string | undefined;
  models: string[];
  ok: boolean;
  status: number | null;
}> {
  const parsed = parseTargetUrl(targetUrl);
  const candidates = [
    `${parsed.basePath}/models`,
    ...(parsed.basePath === "" || parsed.basePath === "/" ? [] : ["/models"]),
  ];
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(apiKey === "" ? {} : { authorization: `Bearer ${apiKey}` }),
  };
  const startedAt = performance.now();
  let lastError: string | undefined;
  for (const candidate of candidates) {
    const url = new URL(`${parsed.scheme}://${parsed.host}:${parsed.port}${candidate}`);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetch(url, { headers, method: "GET", signal: controller.signal });
      if (response.status === 404 || response.status === 405) {
        await response.body?.cancel().catch(() => undefined);
        lastError = `HTTP ${response.status} for ${candidate}`;
        continue;
      }
      const text = await readLimitedBody(response, MAX_VERIFY_MODELS_BYTES);
      const durationMs = Math.max(0, performance.now() - startedAt);
      if (!response.ok) {
        return {
          durationMs,
          error: `HTTP ${response.status}${text === "" ? "" : `: ${text.slice(0, 256)}`}`,
          models: [],
          ok: false,
          status: response.status,
        };
      }
      let payload: unknown;
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        return {
          durationMs,
          error: "model list is not JSON",
          models: [],
          ok: false,
          status: response.status,
        };
      }
      const data =
        payload !== null && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as { data?: unknown }).data
          : payload;
      return {
        durationMs,
        error: undefined,
        models: modelIdsFromPayload(data),
        ok: true,
        status: response.status,
      };
    } catch (error) {
      return {
        durationMs: Math.max(0, performance.now() - startedAt),
        error: controller.signal.aborted
          ? `timeout after ${Math.round(timeoutMs)} ms`
          : error instanceof Error
            ? error.message
            : String(error),
        models: [],
        ok: false,
        status: null,
      };
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    durationMs: Math.max(0, performance.now() - startedAt),
    error: lastError ?? "model endpoint not found",
    models: [],
    ok: false,
    status: null,
  };
}

function statusGroup(
  group: LoadBalancerGroup,
  balancer: LoadBalancer | undefined,
  monitor: LoadMonitor | undefined,
  now: number,
): LoadBalancerStatusGroup {
  const statuses = new Map<string, LoadNodeStatus>(
    (monitor?.nodeStatuses() ?? []).map((status) => [status.targetId, status]),
  );
  const boundByTarget = balancer?.tableFor(group.id)?.snapshot().byTarget ?? {};
  return {
    bindings: balancer?.tableFor(group.id)?.size ?? 0,
    enabled: group.enabled,
    failoverEnabled: group.failover_enabled,
    id: group.id,
    metricsEnabled: group.metrics_enabled,
    modelPattern: group.model_pattern,
    name: group.name,
    nodeTargetIds: [...group.node_target_ids],
    nodes: group.node_target_ids.map((targetId) => {
      const node = balancer?.nodeFor(targetId);
      const status = statuses.get(targetId);
      const cooldownRemainingMs = balancer?.cooldownRemaining(targetId, now) ?? 0;
      return {
        bindings: boundByTarget[targetId] ?? 0,
        canonicalKey: node?.canonicalKey ?? "",
        cooldownRemainingMs,
        enabled: node?.enabled ?? false,
        failures: node?.failures ?? 0,
        inFlight: balancer?.inFlight(targetId) ?? 0,
        inRotation: (node?.enabled ?? false) && cooldownRemainingMs === 0,
        lastDispatchedAt: node?.lastDispatchedAt ?? null,
        metrics: status?.metrics ?? null,
        stale: status?.stale ?? true,
        targetId,
      };
    }),
    strategy: group.strategy,
  };
}

export interface LoadBalancerAdminOptions {
  /** How long one model list request may take; defaults to 8 seconds. */
  readonly verifyTimeoutMs?: number | undefined;
}

export interface LoadBalancerAdminService {
  getStatus(): LoadBalancerStatusResponse;
  verifyModels(
    pairId: string,
    groupId: string,
  ): Promise<LoadBalancerVerifyModelsResponse | undefined>;
}

export function createLoadBalancerAdminService(
  source: LoadBalancerAdminSource,
  options: LoadBalancerAdminOptions = {},
): LoadBalancerAdminService {
  const verifyTimeoutMs = options.verifyTimeoutMs ?? VERIFY_MODELS_TIMEOUT_MS;
  return {
    /** Pure memory reads: no database, no upstream request, no request content. */
    getStatus(): LoadBalancerStatusResponse {
      const now = Date.now();
      return {
        now,
        pairs: source.pairs().map((pair) => {
          const balancer = source.loadBalancer(pair.id);
          const monitor = source.loadMonitor(pair.id);
          return {
            enabled: pair.enabled,
            groups: pair.load_balancers.map((group) => statusGroup(group, balancer, monitor, now)),
            id: pair.id,
            name: pair.name,
            running: pair.running,
          };
        }),
      };
    },

    async verifyModels(
      pairId: string,
      groupId: string,
    ): Promise<LoadBalancerVerifyModelsResponse | undefined> {
      const pair = source.pairs().find((candidate) => candidate.id === pairId);
      const group = pair?.load_balancers.find((candidate) => candidate.id === groupId);
      if (pair === undefined || group === undefined) {
        return undefined;
      }
      const nodes = await Promise.all(
        group.node_target_ids.map(async (targetId) => {
          const configured = pair.targets.find((target) => target.id === targetId);
          if (configured === undefined) {
            return {
              durationMs: 0,
              error: "target is not configured in this pair",
              matched: [],
              models: [],
              ok: false,
              status: null,
              targetId,
            };
          }
          const fetched = await fetchModelList(
            configured.target_url,
            configured.target_api_key,
            verifyTimeoutMs,
          );
          return {
            durationMs: fetched.durationMs,
            error: fetched.error,
            matched: fetched.models.filter((model) =>
              modelPatternMatches(group.model_pattern, model),
            ),
            models: fetched.models,
            ok: fetched.ok,
            status: fetched.status ?? null,
            targetId,
          };
        }),
      );
      return { groupId, modelPattern: group.model_pattern, nodes, pairId };
    },
  };
}
