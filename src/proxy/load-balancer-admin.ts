import type { LoadBalancer } from "./load-balancer.js";
import type { LoadMonitor, LoadNodeStatus } from "./load-monitor.js";
import type { LoadBalancerGroup, PublicProxyPair } from "../config/index.js";
import { loadBalancerMemberTargetIds } from "../config/index.js";

/**
 * Read-only view of load balancing for the admin UI. Nothing here touches the database
 * or the network: every number it returns is already in memory.
 */

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

/** The model ids an engine reports through `GET /models`. */

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
    nodeTargetIds: loadBalancerMemberTargetIds(group),
    nodes: loadBalancerMemberTargetIds(group).map((targetId) => {
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

export interface LoadBalancerAdminService {
  getStatus(): LoadBalancerStatusResponse;
}

export function createLoadBalancerAdminService(
  source: LoadBalancerAdminSource,
): LoadBalancerAdminService {
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
  };
}
